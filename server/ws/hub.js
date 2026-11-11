// WebSocket 허브: 클라이언트-서버 메시지 라우팅 (다중 계정·세션 지원).
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Pipeline } from '../core/pipeline.js';
import { config, STORE_DIR, MATERIALS_DIR } from '../config.js';
import {
  ensureSessionRecord,
  isSessionDeleted,
  normalizeSessionId,
  normalizeAccountId,
  deleteSession,
} from '../core/sessions.js';
import { localLlmManager } from '../core/localLlmManager.js';
import { getAccountIntelligence } from '../memory/userIntelligence.js';
import { getGlobalAvatarModelId } from '../avatarModels.js';
import { logger, getClientIp } from '../core/logger.js';

// --- 서버 STT(Whisper) 스트리밍 설정 ---
// 클라이언트 전송 형식: Int16LE PCM, mono, 16kHz (client/js/audio/micManager.js 와 계약 일치)
const STT_SAMPLE_RATE = 16000;
const STT_SPEECH_THRESHOLD = 0.008; // 발화 시작 판정 RMS
const STT_SILENCE_FLUSH_MS = 800;   // 이 침묵이 지속되면 발화 종료로 판정
const STT_MIN_UTTERANCE_MS = 400;   // 이보다 짧은 구간은 노이즈로 폐기
const STT_MAX_UTTERANCE_MS = 20000; // 무한 버퍼링 방지용 강제 플러시

// 시연 계정 세션은 마지막 연결이 끊긴 뒤 일정 시간이 지나면 그 세션만 지운다.
const DEMO_SESSION_TTL_MS = 120000;
const demoPurgeTimers = new Map();

export function createHub({ server, deps }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const activeSessions = new Set();
  const recordPurgeKey = (accountId, sessionId) => `${accountId}\u0000${sessionId}`;

  // Bonsai 상태 변경(5분 절전 해제 등) 시 연결된 모든 클라이언트에 브로드캐스트
  localLlmManager.onStateChange = (state) => {
    for (const session of activeSessions) {
      session.send(JSON.stringify({
        type: 'llm_state',
        activeModel: session.pipeline.currentModel,
        bonsaiRunning: state.isLoaded,
        bonsaiLoading: state.isLoading,
        expiresAt: state.expiresAt,
        bonsaiSleepEnabled: state.sleepEnabled ?? localLlmManager.sleepEnabled,
        reason: state.reason,
      }));
    }
  };

  wss.on('connection', async (ws, req) => {
    const clientIp = getClientIp(req);
    const userAgent = req.headers?.['user-agent'] || '-';
    const connectTime = Date.now();

    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));
    const accountId = normalizeAccountId(url.searchParams.get('account'));
    const isDemoSession = url.searchParams.get('demo') === '1' && accountId !== 'anonymous';
    const connectionId = `${accountId}:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;

    // 다른 탭에서 이미 지운 세션으로 자동 재접속하면 새로 만들지 않고 정리 신호를 보낸다.
    if (isSessionDeleted(accountId, sessionId)) {
      try {
        ws.send(JSON.stringify({ type: 'session_deleted', sessionId, account: accountId }));
      } catch {}
      try { ws.close(4410, 'session deleted'); } catch {}
      return;
    }

    logger.ws(`WebSocket 클라이언트 연결 (계정: ${accountId}, 세션: ${sessionId})`, {
      ip: clientIp,
      sessionId,
      accountId,
      userAgent,
    });

    const record = await ensureSessionRecord({
      dbPath: config.memory.dbPath,
      materialsDir: MATERIALS_DIR,
      accountId,
      sessionId,
      demo: isDemoSession,
      maxTurns: config.memory.shortTermTurns,
      maxTokens: config.memory.maxContextTokens,
    });

    if (isDemoSession) {
      const pendingPurge = demoPurgeTimers.get(recordPurgeKey(accountId, sessionId));
      if (pendingPurge) {
        clearTimeout(pendingPurge);
        demoPurgeTimers.delete(recordPurgeKey(accountId, sessionId));
      }
    }

    const send = (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    };

    const pipeline = new Pipeline({
      providers: deps.providers,
      memory: record.memory,
      send,
      sessionId,
      accountId,
      model: 'gemini',
      ttsProvider: 'supertonic',
      avatarModel: getGlobalAvatarModelId(),
      userName: isDemoSession ? '' : getAccountIntelligence(accountId).getUserName(),
      demoMode: isDemoSession,
      intelligence: isDemoSession ? null : getAccountIntelligence(accountId),
    });

    const sessionObj = {
      ws,
      pipeline,
      send,
      connectionId,
      sessionId,
      accountId,
      record,
      notifyDeleted: () => {
        send(JSON.stringify({ type: 'session_deleted', sessionId, account: accountId }));
        try { ws.close(4410, 'session deleted'); } catch {}
      },
    };
    record.connections.add(sessionObj);
    activeSessions.add(sessionObj);

    // 연결 즉시 현재 모델 및 TTS 상태 동기화
    send(JSON.stringify({
      type: 'llm_state',
      activeModel: pipeline.currentModel,
      thinkEnabled: pipeline.think,
      bonsaiRunning: localLlmManager.isLoaded,
      bonsaiLoading: localLlmManager.isLoading,
      expiresAt: localLlmManager.expiresAt,
      bonsaiSleepEnabled: localLlmManager.sleepEnabled,
    }));
    send(JSON.stringify({
      type: 'tts_state',
      ttsProvider: 'supertonic',
      gptSovitsRunning: false,
      gptSovitsLoading: false,
      holderCount: 0,
    }));

    // --- 서버 STT: 연결별 발화 버퍼 (Int16 → Float32 누적, 에너지 기반 발화 종료 감지) ---
    const stt = { buffer: new Float32Array(0), speechSeen: false, silenceMs: 0, busy: false };

    function appendSttChunk(bytes) {
      if (!record.memory.isActive()) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const float = new Float32Array(Math.floor(bytes.byteLength / 2));
      for (let i = 0; i < float.length; i++) float[i] = view.getInt16(i * 2, true) / 32768;
      if (!float.length) return;

      let sumSq = 0;
      for (let i = 0; i < float.length; i++) sumSq += float[i] * float[i];
      const rms = Math.sqrt(sumSq / float.length);
      const durationMs = (float.length / STT_SAMPLE_RATE) * 1000;

      if (rms >= STT_SPEECH_THRESHOLD) {
        stt.speechSeen = true;
        stt.silenceMs = 0;
      } else if (stt.speechSeen) {
        stt.silenceMs += durationMs;
      } else {
        return; // 발화 시작 전 무음 구간은 버퍼링하지 않음
      }

      const merged = new Float32Array(stt.buffer.length + float.length);
      merged.set(stt.buffer);
      merged.set(float, stt.buffer.length);
      stt.buffer = merged;

      if (stt.silenceMs >= STT_SILENCE_FLUSH_MS || (stt.buffer.length / STT_SAMPLE_RATE) * 1000 >= STT_MAX_UTTERANCE_MS) {
        void flushStt();
      }
    }

    async function flushStt() {
      if (stt.busy || !record.memory.isActive()) return;
      const audio = stt.buffer;
      const durationMs = (audio.length / STT_SAMPLE_RATE) * 1000;
      stt.buffer = new Float32Array(0);
      stt.speechSeen = false;
      stt.silenceMs = 0;

      const sttProvider = deps.providers.stt;
      if (durationMs < STT_MIN_UTTERANCE_MS || typeof sttProvider?.transcribe !== 'function') return;

      stt.busy = true;
      try {
        const text = await sttProvider.transcribe(audio, { sampleRate: STT_SAMPLE_RATE, language: 'korean' });
        if (text && record.memory.isActive()) {
          send(JSON.stringify({ type: 'user_text', text, source: 'stt' }));
          await runExclusive(() => pipeline.handleUserText(text));
        }
      } catch (err) {
        console.error('서버 STT 인식 실패:', err.message);
        send(JSON.stringify({ type: 'notice', text: '음성 인식에 실패했습니다. 다시 말해 주세요.' }));
      } finally {
        stt.busy = false;
        if (stt.speechSeen && stt.silenceMs >= STT_SILENCE_FLUSH_MS) void flushStt();
      }
    }

    // 같은 세션의 여러 연결(탭)이 각자 큐를 갖지 않도록 세션 레코드의 큐를 공유한다.
    function runExclusive(task) {
      const next = record.turnQueue.then(task, task);
      record.turnQueue = next.catch(() => {});
      return next;
    }

    // --- 메시지 라우팅 ---
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        appendSttChunk(data); // 마이크 PCM (서버 STT)
        return;
      }
      if (!record.memory.isActive()) {
        send(JSON.stringify({ type: 'session_deleted', sessionId, account: accountId }));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
        if (typeof msg === 'string') {
          try { msg = JSON.parse(msg); } catch {}
        }
      } catch {
        return;
      }
      switch (msg.type) {
        case 'set_user_profile':
          if (msg.name) pipeline.setUserName(String(msg.name));
          break;
        case 'demo_greet':
          await runExclusive(() => pipeline.handleGreeting());
          break;
        case 'user_text':
          if (msg.userName) pipeline.setUserName(String(msg.userName));
          logger.ws(`사용자 메시지 [${accountId}/${sessionId}]: "${String(msg.text || '').slice(0, 100)}"`, {
            ip: clientIp,
            sessionId,
            accountId,
          });
          try {
            await runExclusive(() => pipeline.handleUserText(
              String(msg.text || ''),
              Array.isArray(msg.attachments) ? msg.attachments : [],
              msg.userName ? String(msg.userName) : ''
            ));
          } catch (err) {
            logger.error(`[hub] user_text 처리 오류 (계정: ${accountId}, 세션: ${sessionId}): ${err.message}`, { ip: clientIp, sessionId, error: err });
          }
          break;
        case 'cancel':
          pipeline.cancel();
          break;
        case 'cancel_tts':
          pipeline.cancelTTS();
          break;
        case 'stt_reset':
          stt.buffer = new Float32Array(0);
          stt.speechSeen = false;
          stt.silenceMs = 0;
          break;
        case 'set_avatar':
          pipeline.setAvatarModel(String(msg.modelId || 'haru'));
          break;
        case 'set_goal':
          await runExclusive(() => pipeline.setGoal(String(msg.text || '')));
          break;
        case 'recall':
          await pipeline.recallDemo(String(msg.query || ''));
          break;
        case 'rag_search':
          await pipeline.ragDemo(String(msg.query || ''));
          break;
        case 'test_emotion':
          await pipeline.testEmotion(String(msg.tag || ''));
          break;
        case 'test_tts':
          await pipeline.testTTS(String(msg.text || ''));
          break;
        case 'test_stream':
          await pipeline.testStream(String(msg.text || ''));
          break;
        case 'set_model': {
          const target = msg.model || 'nemotron';
          pipeline.setModel(target);
          if (target === 'bonsai' && localLlmManager.isLoaded) {
            localLlmManager.touch();
          }
          send(JSON.stringify({
            type: 'llm_state',
            activeModel: pipeline.currentModel,
            thinkEnabled: pipeline.think,
            bonsaiRunning: localLlmManager.isLoaded,
            bonsaiLoading: localLlmManager.isLoading,
            expiresAt: localLlmManager.expiresAt,
            bonsaiSleepEnabled: localLlmManager.sleepEnabled,
          }));
          break;
        }
        case 'start_local_llm': {
          try {
            send(JSON.stringify({
              type: 'llm_state',
              activeModel: pipeline.currentModel,
              bonsaiRunning: false,
              bonsaiLoading: true,
              bonsaiSleepEnabled: localLlmManager.sleepEnabled,
            }));
            await localLlmManager.startBonsai();
            pipeline.setModel('bonsai');
            send(JSON.stringify({
              type: 'llm_state',
              activeModel: 'bonsai',
              bonsaiRunning: true,
              bonsaiLoading: false,
              expiresAt: localLlmManager.expiresAt,
              bonsaiSleepEnabled: localLlmManager.sleepEnabled,
            }));
          } catch (err) {
            send(JSON.stringify({
              type: 'notice',
              text: `로컬 LLM (Bonsai) 실행 실패: ${err.message}`,
            }));
            send(JSON.stringify({
              type: 'llm_state',
              activeModel: pipeline.currentModel,
              bonsaiRunning: false,
              bonsaiLoading: false,
              bonsaiSleepEnabled: localLlmManager.sleepEnabled,
            }));
          }
          break;
        }
        case 'set_bonsai_sleep': {
          if (msg.manual) {
            localLlmManager.setSleepEnabled(Boolean(msg.enabled));
          }
          break;
        }
        case 'set_think':
        case 'set_bonsai_think': {
          const enabled = Boolean(msg.enabled);
          pipeline.setThink(enabled);
          send(JSON.stringify({
            type: 'llm_state',
            activeModel: pipeline.currentModel,
            thinkEnabled: pipeline.think,
            bonsaiRunning: localLlmManager.isLoaded,
            bonsaiLoading: localLlmManager.isLoading,
            expiresAt: localLlmManager.expiresAt,
            bonsaiSleepEnabled: localLlmManager.sleepEnabled,
          }));
          break;
        }
        case 'get_llm_state': {
          send(JSON.stringify({
            type: 'llm_state',
            activeModel: pipeline.currentModel,
            thinkEnabled: pipeline.think,
            bonsaiRunning: localLlmManager.isLoaded,
            bonsaiLoading: localLlmManager.isLoading,
            expiresAt: localLlmManager.expiresAt,
            bonsaiSleepEnabled: localLlmManager.sleepEnabled,
          }));
          break;
        }
        case 'set_tts_provider':
        case 'get_tts_state': {
          // Supertonic 단일 엔진: 다른 엔진 선택 요청은 무시하고 실제 상태를 돌려준다.
          pipeline.setTTSProvider('supertonic');
          send(JSON.stringify({
            type: 'tts_state',
            ttsProvider: 'supertonic',
            gptSovitsRunning: false,
            gptSovitsLoading: false,
            holderCount: 0,
          }));
          break;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
          break;
        default:
          break;
      }
    });

    ws.on('close', (code) => {
      const durationSec = Math.round((Date.now() - connectTime) / 1000);
      logger.ws(`WebSocket 클라이언트 연결 종료 (계정: ${accountId}, 세션: ${sessionId}, 유지시간: ${durationSec}초, code: ${code})`, {
        ip: clientIp,
        sessionId,
        accountId,
        durationSec,
        code,
      });
      record.connections.delete(sessionObj);
      activeSessions.delete(sessionObj);
      pipeline.cancel();
      stt.buffer = new Float32Array(0);
      if (!isDemoSession || record.deleted) return;
      // 이 세션의 마지막 연결일 때만 삭제 예약한다. 다른 탭이 붙어 있으면 유지한다.
      if (record.connections.size > 0) return;
      const key = recordPurgeKey(accountId, sessionId);
      const prevTimer = demoPurgeTimers.get(key);
      if (prevTimer) clearTimeout(prevTimer);
      const timer = setTimeout(() => {
        demoPurgeTimers.delete(key);
        if (record.deleted || record.connections.size > 0) return;
        void deleteSession({
          dbPath: config.memory.dbPath,
          materialsDir: MATERIALS_DIR,
          accountId,
          sessionId,
          demo: true,
        }).then(() => {
          logger.ws(`시연 세션 데이터 삭제 (계정: ${accountId}, 세션: ${sessionId})`, { sessionId, accountId });
        }).catch((err) => {
          logger.error(`시연 세션 데이터 삭제 실패 (세션: ${sessionId}): ${err.message}`, { sessionId, error: err });
        });
      }, DEMO_SESSION_TTL_MS);
      timer.unref?.();
      demoPurgeTimers.set(key, timer);
    });

    ws.on('error', (err) => {
      logger.error(`WebSocket 에러 (계정: ${accountId}, 세션: ${sessionId}): ${err.message}`, {
        ip: clientIp,
        sessionId,
        error: err,
      });
    });

    let resetEpoch = 0;
    try {
      const settingsPath = path.join(STORE_DIR, 'global_settings.json');
      if (fs.existsSync(settingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        resetEpoch = Number(parsed.resetEpoch) || 0;
      }
    } catch {}

    ws.send(JSON.stringify({ type: 'welcome', message: `AI 컴페니언 연결 완료 (Session: ${sessionId})`, resetEpoch }));
  });

  return {
    wss,
    isSessionOnline: (sid) => [...activeSessions].some((s) => s.sessionId === sid),
    deleteSessionForAccount: async (accountId, sessionId) => deleteSession({
      dbPath: config.memory.dbPath,
      materialsDir: MATERIALS_DIR,
      accountId,
      sessionId,
    }),
  };
}
