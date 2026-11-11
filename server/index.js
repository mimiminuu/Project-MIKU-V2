// 서버 엔트리: Express 정적 서빙 + WebSocket 허브 + 자료 업로드 API
import express from 'express';
import http from 'node:http';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config, CLIENT_DIR, MATERIALS_DIR } from './config.js';
import { getRuntime, getEmbeddingRuntime } from './providers/index.js';
import {
  getSessionMemory,
  ensureSessionRecord,
  normalizeSessionId,
  normalizeAccountId,
  isSessionDeleted,
  materialDir,
} from './core/sessions.js';
import * as demoLog from './core/demoTranscript.js';
import { createHub } from './ws/hub.js';
import { ingestFile } from './rag/ingest.js';
import { connect as connectChroma } from './rag/chromaClient.js';
import { AVATAR_MODELS, DEFAULT_AVATAR_MODEL_ID, getGlobalAvatarModelId, setGlobalAvatarModelId } from './avatarModels.js';
import { getAccountIntelligence, clearAccountIntelligence } from './memory/userIntelligence.js';
import { accountManager } from './core/accountManager.js';
import { logger } from './core/logger.js';

process.on('uncaughtException', (err) => {
  logger.error(`[FATAL] Uncaught Exception: ${err.message}`, { error: err });
});
process.on('unhandledRejection', (reason) => {
  logger.error(`[FATAL] Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`, { error: reason });
});

async function main() {
  const providers = await getRuntime();
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });

  // Chroma는 별도 프로세스다. 꺼진 채로 시연하면 업로드는 저장되지만 검색이 조용히 비므로 시작 시 알린다.
  const { available: ragAvailable } = await connectChroma();
  if (!ragAvailable) {
    console.warn('[rag] Chroma가 꺼져 있습니다. 자료 검색을 쓰려면 "server start.bat" 또는 "npm run chroma"로 먼저 실행하세요.');
  }

  // 임베딩 모델을 백그라운드에서 미리 로딩 (첫 RAG 검색 시 수 초 지연 제거)
  getEmbeddingRuntime().embedding?.init?.().catch((err) => {
    console.warn('[embedding] 백그라운드 사전 로딩 실패 (사용 시 재시도):', err.message);
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(logger.middleware({ logStatic: config.logging?.logStatic ?? false }));
  app.use(express.json({ limit: '8mb' }));

  const server = http.createServer(app);
  // 리슨 실패(포트 중복 등)를 로그만 남기고 살려두면 TTS 워커가 GPU를 잡은 채 남는다.
  server.on('error', (err) => {
    logger.error(`서버 소켓 오류: ${err.code || ''} ${err.message}`, { error: err });
    // 리슨 전에 로드된 TTS 워커가 남아 GPU를 잡지 않도록 정리 후 종료한다.
    try { providers.tts?.destroy?.(); } catch {}
    process.exit(1);
  });
  const deps = { providers };
  const hub = createHub({ server, deps });

  // 개인 데이터 요청은 로그인 계정(account)과 세션(sessionId)을 함께 받는다.
  const accountOf = (req) => normalizeAccountId(req.query?.account ?? req.body?.account);
  const sessionOf = (req) => normalizeSessionId(req.query?.sessionId ?? req.body?.sessionId ?? req.params?.id);
  const deletedGuard = (req, res) => {
    if (isSessionDeleted(accountOf(req), sessionOf(req))) {
      res.status(410).json({ error: '삭제된 세션입니다. 새 대화를 시작해 주세요.' });
      return true;
    }
    return false;
  };

  // 정적 클라이언트
  app.use(express.static(CLIENT_DIR));

  // 어드민 대시보드 페이지 라우팅
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'admin.html'));
  });

  // 인증 API (시연 계정 및 어드민 로그인)
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = accountManager.verifyAccount(username, password);
    if (!user) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }
    res.json({ success: true, user });
  });

  // 어드민: 계정 목록 조회
  app.get('/api/admin/accounts', (req, res) => {
    res.json({ success: true, accounts: accountManager.getAccounts() });
  });

  // 어드민: 계정 추가
  app.post('/api/admin/accounts', (req, res) => {
    try {
      const { id, password, name, role } = req.body || {};
      const created = accountManager.addAccount({ id, password, name, role });
      res.json({ success: true, account: created, accounts: accountManager.getAccounts() });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // 어드민: 계정 삭제
  app.delete('/api/admin/accounts/:id', (req, res) => {
    try {
      const { id } = req.params;
      accountManager.deleteAccount(id);
      res.json({ success: true, accounts: accountManager.getAccounts() });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // 어드민: 시연 참가자별 대화 기록 목록 (계정 / 참가자 / 세션 구분)
  app.get('/api/admin/demo-sessions', (req, res) => {
    const sessions = demoLog.listSessions().map((row) => ({
      ...row,
      online: Boolean(hub.isSessionOnline?.(row.sessionId)),
    }));
    res.json({ success: true, sessions });
  });

  // 어드민: 특정 참가자의 대화 전문 (after 이후 턴만 증분 반환)
  app.get('/api/admin/demo-sessions/:sid', (req, res) => {
    const after = Number(req.query.after) || 0;
    const data = demoLog.readSession(req.params.sid, after);
    if (!data) return res.status(404).json({ success: false, message: '기록이 없습니다.' });
    res.json({ success: true, ...data, online: Boolean(hub.isSessionOnline?.(req.params.sid)) });
  });

  // 어드민: 참가자 한 명 기록 삭제
  app.delete('/api/admin/demo-sessions/:sid', (req, res) => {
    res.json({ success: true, deleted: demoLog.deleteSession(req.params.sid) });
  });

  // 어드민: 시연 대화 기록 전체 삭제
  app.delete('/api/admin/demo-sessions', (req, res) => {
    res.json({ success: true, deleted: demoLog.deleteAll() });
  });

  // 학습 자료 업로드 + 인제스트 (세션별 독립 저장, 대용량 교과서 PDF 지원을 위해 500MB로 확장)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  });

  app.post('/api/materials', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: '파일 크기가 너무 큽니다. (최대 500MB까지 업로드 가능)' });
        }
        return res.status(400).json({ error: `파일 업로드 실패: ${err.message}` });
      }
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다. (multipart 필드명: file)' });
    if (deletedGuard(req, res)) return;
    let operation = null;
    let record = null;
    try {
      const sessionId = sessionOf(req);
      const accountId = accountOf(req);
      record = await ensureSessionRecord({
        dbPath: config.memory.dbPath,
        materialsDir: MATERIALS_DIR,
        accountId,
        sessionId,
      });
      let originalName = req.file.originalname;
      try {
        const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
        if (decoded && !decoded.includes('\ufffd')) {
          originalName = decoded;
        }
      } catch {}
      const controller = new AbortController();
      operation = { abort: () => controller.abort(), promise: null };
      record.pendingOperations.add(operation);
      operation.promise = ingestFile({
        originalName,
        buffer: req.file.buffer,
        sessionId,
        accountId,
        signal: controller.signal,
      });
      const result = await operation.promise;
      res.json(result);
    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(410).json({ error: '세션이 삭제되어 업로드가 취소되었습니다.' });
      }
      console.error('[materials:upload] 인제스트 실패:', err);
      res.status(500).json({ error: err.message || '파일 처리 실패' });
    } finally {
      if (record && operation) record.pendingOperations.delete(operation);
    }
  });

  app.get('/api/materials', (req, res) => {
    if (deletedGuard(req, res)) return;
    const sessionDir = materialDir(MATERIALS_DIR, accountOf(req), sessionOf(req));
    const files = fs.existsSync(sessionDir)
      ? fs.readdirSync(sessionDir)
          .filter((f) => {
            try {
              return fs.statSync(path.join(sessionDir, f)).isFile();
            } catch {
              return false;
            }
          })
          .map((f) => ({ name: f, size: fs.statSync(path.join(sessionDir, f)).size }))
      : [];
    res.json({ files });
  });

  // 첨부파일 (이미지 등) 직접 다운로드 / 브라우저 조회
  app.get('/api/materials/file/:filename', (req, res) => {
    if (deletedGuard(req, res)) return;
    const sessionDir = materialDir(MATERIALS_DIR, accountOf(req), sessionOf(req));
    const safeBase = path.basename(req.params.filename);
    const directPath = path.join(sessionDir, safeBase);
    if (fs.existsSync(directPath)) {
      return res.sendFile(directPath);
    }
    const files = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
    const matched = files.find((f) => f === safeBase || f.endsWith(`-${safeBase}`));
    if (matched) {
      return res.sendFile(path.join(sessionDir, matched));
    }
    res.status(404).send('File not found');
  });

  // 세션 삭제: 그 계정·세션의 대화 기억, 장기 기억, 업로드 자료, 검색 벡터만 지운다.
  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const sid = normalizeSessionId(req.params.id);
      const accountId = accountOf(req);
      const result = await hub.deleteSessionForAccount(accountId, sid);
      res.json({ success: true, ...result, sessionId: sid, account: accountId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 등록된 세션들을 한 번에 정리할 때도 이 계정이 명시한 세션 ID만 지운다.
  // (예전처럼 서버 전체 memory*.db와 모든 자료를 지우는 동작은 하지 않는다)
  app.delete('/api/sessions', async (req, res) => {
    try {
      const accountId = accountOf(req);
      const rawIds = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
      const sessionIds = [...new Set(rawIds.map((id) => normalizeSessionId(id)))];
      if (!sessionIds.length) {
        return res.status(400).json({ error: 'sessionIds 목록이 필요합니다.' });
      }
      const results = [];
      for (const sid of sessionIds) {
        results.push({ sessionId: sid, ...(await hub.deleteSessionForAccount(accountId, sid)) });
      }
      if (req.body?.resetAccount === true) {
        clearAccountIntelligence(accountId);
      }
      res.json({ success: true, account: accountId, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/goal', async (req, res) => {
    if (deletedGuard(req, res)) return;
    const lt = await getSessionMemory(config.memory.dbPath, sessionOf(req), accountOf(req));
    res.json({ goal: lt.getGoal() });
  });

  app.post('/api/goal', async (req, res) => {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: 'text 필드가 필요합니다.' });
    if (deletedGuard(req, res)) return;
    const lt = await getSessionMemory(config.memory.dbPath, sessionOf(req), accountOf(req));
    const goal = await lt.setGoal(text);
    res.json({ goal });
  });

  app.get('/api/memories', async (req, res) => {
    if (deletedGuard(req, res)) return;
    const lt = await getSessionMemory(config.memory.dbPath, sessionOf(req), accountOf(req));
    res.json({ memories: lt.all() });
  });

  // 클라이언트용 런타임 설정 (예: 서버 STT 사용 여부 판단)
  app.get('/api/config', (_req, res) => {
    res.json({ providers: config.providers });
  });

  // ---- 아바타 모델 ----
  // 모델 목록 (선택 UI용, 기본 모델 포함)
  app.get('/api/avatar-models', (_req, res) => {
    res.json({ models: AVATAR_MODELS, defaultModelId: DEFAULT_AVATAR_MODEL_ID });
  });

  // 전역 선택 모델 조회 (세션 통합)
  app.get('/api/avatar-model', async (_req, res) => {
    res.json({ modelId: getGlobalAvatarModelId() });
  });

  // 전역 선택 모델 저장 (모든 세션 공통 적용)
  app.post('/api/avatar-model', async (req, res) => {
    if (!req.body.modelId) return res.status(400).json({ error: 'modelId 필드가 필요합니다.' });
    const modelId = setGlobalAvatarModelId(req.body.modelId);
    res.json({ modelId });
  });

  // 개인 인텔리전스: 계정별로만 저장하고, 시연 계정은 계정 전역에 남기지 않는다.
  app.post('/api/user-intelligence/mood', (req, res) => {
    const { mood, memo, timestamp, isDemo } = req.body || {};
    if (mood && !isDemo) {
      getAccountIntelligence(accountOf(req)).addMood({ mood, memo, timestamp: timestamp || Date.now() });
    }
    res.json({ ok: true });
  });

  app.get('/api/user-intelligence', (req, res) => {
    res.json(getAccountIntelligence(accountOf(req)).data);
  });

  // LLM 호출 도우미 (주 LLM 실패 시 로컬 bonsai 프로바이더로 자동 장애 극복)
  async function callLlmWithFallback(promptText) {
    const candidateProviders = [
      ...new Set([
        providers.llm,
        providers.llmProviders?.nemotron,
        providers.llmProviders?.bonsai,
      ].filter(Boolean)),
    ];

    let lastErr = null;
    for (const p of candidateProviders) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        try { controller.abort(new Error('LLM 응답 시간 초과 (3분)')); } catch {}
      }, 180000);
      timer.unref?.();
      try {
        let fullText = '';
        for await (const chunk of p.streamChat({
          messages: [{ role: 'user', content: promptText }],
          signal: controller.signal,
        })) {
          if (chunk.token) fullText += chunk.token;
        }
        if (fullText.trim()) return fullText;
      } catch (err) {
        lastErr = err;
        console.warn('[tools API] LLM 호출 실패, 폴백 시도:', err.message);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('사용 가능한 LLM 프로바이더가 없습니다.');
  }

  // 공부 도구: LLM 기반 맞춤 퀴즈 생성
  app.post('/api/tools/generate-quiz', async (req, res) => {
    try {
      if (deletedGuard(req, res)) return;
      const { topic, history, count = 3 } = req.body || {};
      const record = await ensureSessionRecord({
        dbPath: config.memory.dbPath,
        materialsDir: MATERIALS_DIR,
        accountId: accountOf(req),
        sessionId: sessionOf(req),
      });
      const goal = record.longTerm.getGoal();

      let contextStr = '';
      if (Array.isArray(history) && history.length > 0) {
        const recent = history.slice(-12);
        contextStr = recent.map((m) => `${m.role === 'user' ? '학생' : '미쿠'}: ${m.text}`).join('\n');
      }

      const prompt = [
        '당신은 학생들을 위한 전문 교육 퀴즈 출제자입니다.',
        topic ? `출제 요청 주제: "${topic}"` : '출제 요청: 현재 대화 및 학습 내용 바탕',
        goal ? `학생의 현재 학습 목표: "${goal.content || goal}"` : '',
        contextStr ? `[최근 대화 내역]:\n${contextStr}` : '',
        `위 내용을 바탕으로 학생이 이해도를 점검할 수 있는 고품질의 4지선다형 퀴즈 ${count}문제를 생성하세요.`,
        '반드시 아래 JSON 형식으로만 응답하세요. 다른 부가 설명이나 서두/결미 문구는 일절 포함하지 마세요:',
        '[',
        '  {',
        '    "q": "1. 문제 지문",',
        '    "options": ["선택지 1", "선택지 2", "선택지 3", "선택지 4"],',
        '    "ans": 0,',
        '    "exp": "정답에 대한 명확하고 친절한 해설"',
        '  }',
        ']',
      ].filter(Boolean).join('\n\n');

      let reply = '';
      try {
        reply = await callLlmWithFallback(prompt);
      } catch (llmErr) {
        console.warn('[generate-quiz] LLM 프로바이더 모두 불가, 기본 맞춤형 문제 생성:', llmErr.message);
        // LLM 외부 장애 시 폴백 퀴즈 세트
        const fallbackTopic = topic || '일반 상식과 기초 학업';
        const fallbackQuestions = [
          {
            q: `1. [${fallbackTopic}] 다음 중 가장 핵심적인 기초 개념으로 옳은 것은?`,
            options: ['기초 원리를 이해하고 단계별로 적용한다.', '공식을 무조건 암기하고 넘어간다.', '증명 과정을 완전히 무시한다.', '복잡한 계산기만 사용한다.'],
            ans: 0,
            exp: `${fallbackTopic} 학습에서는 기본 개념과 원리를 차근차근 익혀 실전 문제에 적용하는 것이 가장 중요합니다.`
          },
          {
            q: `2. [${fallbackTopic}] 문제를 풀 때 올바른 학습 습관은?`,
            options: ['틀린 문제의 오답 원인을 분석하고 다시 푼다.', '틀린 문제는 그냥 넘어간다.', '해설지를 바로 베껴 적는다.', '모르는 문제는 풀지 않는다.'],
            ans: 0,
            exp: '오답 노트를 작성하고 취약 개념을 다시 복습하는 것이 성적 향상의 지름길입니다.'
          }
        ];
        record.shortTerm.rememberTool('generate_quiz', { topic: fallbackTopic, count }, { questions: fallbackQuestions });
        return res.json({ success: true, topic: fallbackTopic, questions: fallbackQuestions });
      }

      const clean = reply.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('퀴즈 JSON 형식을 파싱할 수 없습니다.');

      const questions = JSON.parse(match[0]);
      record.shortTerm.rememberTool('generate_quiz', { topic: topic || '대화 기반 맞춤 퀴즈', count }, { questions });
      res.json({ success: true, topic: topic || '대화 기반 맞춤 퀴즈', questions });
    } catch (err) {
      console.error('[generate-quiz] 오류:', err.message);
      res.status(500).json({ error: err.message || '퀴즈 생성 실패' });
    }
  });

  // 공부 도구: LLM 기반 암기 카드(플래시카드) 생성
  app.post('/api/tools/generate-cards', async (req, res) => {
    try {
      if (deletedGuard(req, res)) return;
      const { topic, history, count = 4 } = req.body || {};
      const record = await ensureSessionRecord({
        dbPath: config.memory.dbPath,
        materialsDir: MATERIALS_DIR,
        accountId: accountOf(req),
        sessionId: sessionOf(req),
      });
      const goal = record.longTerm.getGoal();

      let contextStr = '';
      if (Array.isArray(history) && history.length > 0) {
        const recent = history.slice(-12);
        contextStr = recent.map((m) => `${m.role === 'user' ? '학생' : '미쿠'}: ${m.text}`).join('\n');
      }

      const prompt = [
        '당신은 학생들을 위한 핵심 플래시 암기 카드 제작자입니다.',
        topic ? `카드 주제: "${topic}"` : '카드 주제: 현재 대화 및 학습 내용 핵심 요약',
        goal ? `학생의 현재 학습 목표: "${goal.content || goal}"` : '',
        contextStr ? `[최근 대화 내역]:\n${contextStr}` : '',
        `위 내용을 바탕으로 꼭 기억해야 할 핵심 개념/공식/단어 카드 ${count}장을 제작하세요.`,
        '반드시 아래 JSON 형식으로만 응답하세요. 다른 부가 설명이나 서두/결미 문구는 일절 포함하지 마세요:',
        '[',
        '  {',
        '    "q": "앞면: 핵심 용어, 개념명 또는 짧은 질문",',
        '    "a": "뒷면: 명확한 핵심 정의, 공식, 또는 암기 포인트"',
        '  }',
        ']',
      ].filter(Boolean).join('\n\n');

      let reply = '';
      try {
        reply = await callLlmWithFallback(prompt);
      } catch (llmErr) {
        console.warn('[generate-cards] LLM 불가, 기본 핵심 카드 세트:', llmErr.message);
        const fallbackTopic = topic || '핵심 요약 카드';
        const fallbackCards = [
          { q: `${fallbackTopic}: 핵심 정의`, a: '해당 단원의 가장 중심이 되는 기본 공식 및 정의' },
          { q: `${fallbackTopic}: 대표 유형 풀이법`, a: '조건 확인 -> 관계식 수립 -> 계산 및 검산' }
        ];
        record.shortTerm.rememberTool('create_flashcards', { topic: fallbackTopic, count }, { cards: fallbackCards });
        return res.json({ success: true, topic: fallbackTopic, cards: fallbackCards });
      }

      const clean = reply.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('암기 카드 JSON 형식을 파싱할 수 없습니다.');

      const cards = JSON.parse(match[0]);
      record.shortTerm.rememberTool('create_flashcards', { topic: topic || '대화 기반 암기 카드', count }, { cards });
      res.json({ success: true, topic: topic || '대화 기반 암기 카드', cards });
    } catch (err) {
      console.error('[generate-cards] 오류:', err.message);
      res.status(500).json({ error: err.message || '암기 카드 생성 실패' });
    }
  });

  server.listen(config.port, () => {
    logger.info(`AI 컴페니언 서버 시작 완료: http://localhost:${config.port}`);
  });

  const handleShutdown = (signal) => {
    logger.saveShutdownLog(signal);
    // Python TTS 워커가 남으면 GPU/VRAM을 계속 점유하므로 자식 프로세스를 먼저 정리한다.
    try { providers.tts?.destroy?.(); } catch {}
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('서버 시작 실패:', err);
  process.exit(1);
});