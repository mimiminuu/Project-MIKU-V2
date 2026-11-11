// 기능별 독립 테스트 페이지 로직.
// LLM/STT/TTS API 키가 없어도 각 기능을 따로 검증할 수 있게 합니다.
import { Live2DStage } from './avatar/live2dStage.js';
import { EMOTION_TAGS, ACTION_TAGS } from './avatar/emotions.js';
import { WSClient } from './agent/wsClient.js';
import { TTSAudioPlayer } from './audio/playback.js';
import { MicManager } from './audio/micManager.js';
import { onLipVolume, getVoiceBus, getContext, ensureResumed } from './audio/audioBus.js';

const $ = (sel) => document.querySelector(sel);
const logEl = $('#ws-log');
const maxLogLines = 500;

const state = {
  ws: null,
  stage: null,
  player: null,
  mic: null,
  pendingTtsMeta: null,
  counters: {},
  audioBytes: 0,
  modelName: null,
  avatarModels: [],
  defaultModelId: 'haru',
};

const TEST_SESSION = 'testpage';

// ---------- 로그/결과 UI ----------
function logLine(text, cls = 'in') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  while (logEl.children.length > maxLogLines) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function setText(sel, text) {
  $(sel).textContent = text;
}

// ---------- WebSocket ----------
function connectWS() {
  const ws = new WSClient({
    url: `ws://${location.host}/ws`,
    onOpen: () => {
      $('#ws-state').textContent = '연결됨';
      $('#ws-state').classList.add('on');
      $('#ws-conn-info').textContent = '연결 성공 ✅ (welcome 대기)';
      logLine('WS 연결됨', 'sys');
    },
    onClose: () => {
      $('#ws-state').textContent = '연결 안 됨';
      $('#ws-state').classList.remove('on');
      $('#ws-conn-info').textContent = '연결 끊김';
      logLine('WS 끊김', 'err');
    },
    onMessage: (msg, isBinary) => {
      if (isBinary) {
        state.audioBytes += msg.byteLength;
        state.counters['audio(bytes)'] = state.audioBytes;
        renderCounter();
        logLine(`▲ 오디오 +${msg.byteLength}B (합계 ${state.audioBytes}B)`, 'bin');
        if (state.pendingTtsMeta) state.player.enqueue(state.pendingTtsMeta, msg);
        return;
      }
      handleMsg(msg);
    },
  });
  state.ws = ws;
  ws.connect();
}

function handleMsg(msg) {
  state.counters[msg.type] = (state.counters[msg.type] || 0) + 1;
  renderCounter();
  logLine(`▼ ${formatMsg(msg)}`, 'in');

  switch (msg.type) {
    case 'welcome':
      $('#ws-conn-info').textContent = `연결 성공 ✅ ${msg.message}`;
      break;
    case 'emotion':
      if (state.stage) state.stage.setEmotion(msg.tag);
      $('#emotion-info').textContent = `감정 수신: [${msg.tag}] → 아바타 반영`;
      break;
    case 'status':
      setText('#ws-conn-info', `상태: ${msg.state}`);
      break;
    case 'assistant_text_partial':
      appendTo('#stream-out', msg.text);
      appendTo('#pipe-out', msg.text);
      break;
    case 'assistant_text_end':
      appendTo('#stream-out', '\n── 완료 ✅');
      appendTo('#pipe-out', '\n── 완료 ✅');
      break;
    case 'tts_meta':
      state.pendingTtsMeta = msg;
      break;
    case 'tts_end':
      setText('#tts-info', `수신 바이트: ${state.audioBytes}B, 문장 종료 ✅`);
      break;
    case 'memory_update':
      setText('#goal-res', `저장됨 🧠 ${msg.memory?.content ?? ''}`);
      loadGoal();
      break;
    case 'recall_result':
      renderRecall(msg);
      break;
    case 'rag_result':
      renderRag(msg);
      break;
    case 'notice':
      logLine(`❗ ${msg.text}`, 'sys');
      break;
    default:
      break;
  }
}

function jsonShort(obj) {
  const s = JSON.stringify(obj);
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

// 이벤트를 사람이 읽기 좋은 문장으로 변환 (모르는 타입은 JSON 축약 표시)
function formatMsg(msg) {
  switch (msg.type) {
    case 'welcome':
      return '연결 완료 · ' + msg.message;
    case 'pong':
      return `응답 완료 (왕복 ${Math.max(0, Date.now() - msg.t)}ms)`;
    case 'status':
      return `상태: ${msg.state}`;
    case 'emotion':
      return `감정 반영: [${msg.tag}]`;
    case 'assistant_text_partial':
      return `텍스트 스트리밍: "${msg.text}"`;
    case 'assistant_text_end':
      return '문장 출력 완료';
    case 'tts_meta':
      return `TTS 발화 시작: "${(msg.text || '').slice(0, 30)}"`;
    case 'tts_end':
      return `TTS 재생 종료 (음성 ${state.audioBytes}B)`;
    case 'memory_update':
      return `장기 기억 저장됨: ${msg.memory?.content ?? ''}`;
    case 'recall_result':
      return `기억 검색: ${msg.hits?.length ?? 0}건`;
    case 'rag_result':
      return `자료 검색: ${msg.hits?.length ?? 0}건`;
    case 'notice':
      return `[공지] ${msg.text}`;
    default:
      return msg.type + ' ' + jsonShort(msg);
  }
}

function appendTo(sel, text) {
  $(sel).textContent += text;
}

function renderCounter() {
  const sorted = Object.entries(state.counters).sort((a, b) => a[0].localeCompare(b[0]));
  $('#counter').textContent = sorted.map(([k, v]) => `${k}: ${v}`).join('  ');
}

// ---------- 아바타 ----------
async function loadAvatar() {
  try {
    state.stage = new Live2DStage($('#test-canvas'));
    onLipVolume((vol) => state.stage.setLipVolume(vol));
    state.stage.onZoomChange = () => refreshTestZoom();
    await state.stage.init({ availableModels: state.avatarModels });
    window._stage = state.stage; // 콘솔에서 직접 상태를 들여다보기 위한 노출
    state.modelName = state.stage.modelId
      ? `${state.stage.modelId}${state.stage.modelId === 'haru' ? ' (기본)' : ''}`
      : (state.stage.modelUrl.includes('haru') ? 'Haru (기본)' : 'Senko (대체)');
    $('#model-label').textContent = `모델: ${state.modelName}`;
    $('#avatar-info').textContent = `로드 성공 ✅ ${state.modelName}`;
    logLine(`아바타 로드: ${state.modelUrl}`, 'sys');
    const sel = $('#t-model-select');
    if (sel && state.stage.modelId) sel.value = state.stage.modelId;
    refreshTestZoom();
    showModelInfo();
  } catch (err) {
    $('#model-label').textContent = '모델 로드 실패';
    $('#avatar-info').textContent = `로드 실패 ❌ ${err.message}`;
  }
}

// ---------- 아바타 확장 테스트 (⑭~⑱) ----------
async function loadModelOptions() {
  const sel = $('#t-model-select');
  try {
    const res = await fetch('/api/avatar-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.avatarModels = data.models || [];
    state.defaultModelId = data.defaultModelId || 'haru';
  } catch (err) {
    setText('#model-switch-info', `목록 조회 실패 ❌ ${err.message}`);
    state.avatarModels = [];
  }
  if (!sel) return;
  sel.innerHTML = '';
  for (const m of state.avatarModels) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name || m.id} (${m.id})`;
    sel.appendChild(opt);
  }
}

function refreshTestZoom() {
  const z = state.stage?.getZoom?.() ?? 1;
  const slider = $('#t-zoom');
  if (slider) slider.value = String(Math.round(z * 100));
  setText('#t-zoom-label', `${Math.round(z * 100)}%`);
}

function showModelInfo() {
  const info = state.stage?.getModelInfo?.();
  setText('#pos-info', info
    ? `모델: ${info.id} / 오프셋(${info.offsetX}, ${info.offsetY}) / 줌 ${Math.round(info.zoom * 100)}% / bounds ${info.bounds ? `${info.bounds.w}×${info.bounds.h}` : 'n/a'}`
    : '아바타를 먼저 로드하세요 (②).');
}

async function postAvatarModel(sessionId, modelId) {
  const res = await fetch('/api/avatar-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, modelId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getAvatarModel(sessionId) {
  const res = await fetch(`/api/avatar-model?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).modelId;
}

function bindAvatarTests() {
  $('#btn-model-list') && ($('#btn-model-list').onclick = async () => {
    await loadModelOptions();
    setText('#model-switch-info', state.avatarModels.length
      ? `목록 ✅ ${state.avatarModels.length}개: ${state.avatarModels.map((m) => m.id).join(', ')} (기본: ${state.defaultModelId})`
      : '목록 비어 있음 ❌');
  });

  $('#btn-model-switch') && ($('#btn-model-switch').onclick = async () => {
    if (!state.stage) return setText('#model-switch-info', '아바타를 먼저 로드하세요 (②).');
    const id = $('#t-model-select')?.value;
    if (!id) return setText('#model-switch-info', '모델을 선택하세요.');
    const t0 = performance.now();
    setText('#model-switch-info', `전환 중... (${id})`);
    try {
      const r = await state.stage.switchModel(id, { availableModels: state.avatarModels });
      const ms = Math.round(performance.now() - t0);
      state.modelName = r.id || id;
      $('#model-label').textContent = `모델: ${state.modelName}`;
      setText('#model-switch-info', `전환 성공 ✅ ${state.modelName} (${ms}ms)`);
      logLine(`모델 전환: ${state.modelName} (${ms}ms)`, 'sys');
      refreshTestZoom();
      showModelInfo();
    } catch (err) {
      setText('#model-switch-info', `전환 실패 ❌ ${err.message}`);
    }
  });

  // 위치/크기
  const nudge = (dx, dy) => () => {
    if (!state.stage) return setText('#pos-info', '아바타를 먼저 로드하세요 (②).');
    state.stage.nudge(dx, dy);
    showModelInfo();
  };
  $('#btn-pos-up') && ($('#btn-pos-up').onclick = nudge(0, -40));
  $('#btn-pos-down') && ($('#btn-pos-down').onclick = nudge(0, 40));
  $('#btn-pos-left') && ($('#btn-pos-left').onclick = nudge(-40, 0));
  $('#btn-pos-right') && ($('#btn-pos-right').onclick = nudge(40, 0));
  $('#btn-pos-reset') && ($('#btn-pos-reset').onclick = () => {
    if (!state.stage) return setText('#pos-info', '아바타를 먼저 로드하세요 (②).');
    state.stage.resetPosition();
    refreshTestZoom();
    showModelInfo();
    setText('#pos-info', $('#pos-info').textContent + ' — 초기화 ✅');
  });
  const zSlider = $('#t-zoom');
  zSlider && (zSlider.oninput = () => {
    if (!state.stage) return;
    state.stage.setZoom(Number(zSlider.value) / 100);
    setText('#t-zoom-label', `${zSlider.value}%`);
  });
  document.querySelectorAll('[data-zoom]').forEach((btn) => {
    btn.onclick = () => {
      if (!state.stage) return setText('#pos-info', '아바타를 먼저 로드하세요 (②).');
      state.stage.setZoom(Number(btn.dataset.zoom) / 100);
      refreshTestZoom();
      showModelInfo();
    };
  });
  $('#btn-model-info') && ($('#btn-model-info').onclick = showModelInfo);

  // 인터랙션
  const center = () => state.stage?.centerPoint?.() || { x: 190, y: 210 };
  const needStage = () => {
    if (!state.stage) { setText('#interact-info', '아바타를 먼저 로드하세요 (②).'); return false; }
    return true;
  };
  $('#btn-pet') && ($('#btn-pet').onclick = () => {
    if (!needStage()) return;
    const p = center();
    const n = state.stage.petAt(p.x, p.y, 3);
    const i = state.stage.getActionInfo();
    setText('#interact-info', `쓰다듬기 ✅ 누적 ${n} 스트로크 (강도 ${i.petIntensity}, 3회마다 모션)`);
  });
  $('#btn-hold') && ($('#btn-hold').onclick = () => {
    if (!needStage()) return;
    const p = center();
    state.stage.holdAt(p.x, p.y);
    reportAction('#interact-info', '홀딩 ✅');
  });
  $('#btn-celebrate') && ($('#btn-celebrate').onclick = () => {
    if (!needStage()) return;
    const p = center();
    state.stage.celebrateAt(p.x, p.y);
    reportAction('#interact-info', '축하 ✅');
  });

  // 아바타 API
  $('#btn-api-models') && ($('#btn-api-models').onclick = async () => {
    try {
      const res = await fetch('/api/avatar-models');
      const data = await res.json();
      const ok = res.ok && Array.isArray(data.models) && data.models.length > 0;
      setText('#api-info', `${ok ? 'PASS' : 'FAIL'} ① 목록: ${(data.models || []).map((m) => m.id).join(', ')} (기본: ${data.defaultModelId})`);
    } catch (err) { setText('#api-info', `FAIL ① ${err.message}`); }
  });
  $('#btn-api-get') && ($('#btn-api-get').onclick = async () => {
    try {
      const id = await getAvatarModel(TEST_SESSION);
      setText('#api-info', `PASS ② 내 세션(${TEST_SESSION}): ${id}`);
    } catch (err) { setText('#api-info', `FAIL ② ${err.message}`); }
  });
  $('#btn-api-set-yinlang') && ($('#btn-api-set-yinlang').onclick = async () => {
    try {
      const before = await getAvatarModel(TEST_SESSION);
      const saved = await postAvatarModel(TEST_SESSION, 'yinlang');
      const got = await getAvatarModel(TEST_SESSION);
      await postAvatarModel(TEST_SESSION, before); // 사용자 모델을 건드리지 않고 되돌린다
      const ok = saved.modelId === 'yinlang' && got === 'yinlang';
      setText('#api-info', `${ok ? 'PASS' : 'FAIL'} ③ 저장=${saved.modelId} / 재조회=${got} / 원복=${before}`);
    } catch (err) { setText('#api-info', `FAIL ③ ${err.message}`); }
  });
  $('#btn-api-set-bad') && ($('#btn-api-set-bad').onclick = async () => {
    try {
      const before = await getAvatarModel(TEST_SESSION);
      const saved = await postAvatarModel(TEST_SESSION, 'no-such-model');
      const ok = saved.modelId === state.defaultModelId;
      await postAvatarModel(TEST_SESSION, before);
      setText('#api-info', `${ok ? 'PASS' : 'FAIL'} ④ 무효ID → ${saved.modelId} (기본값 ${state.defaultModelId} 기대) / 원복=${before}`);
    } catch (err) { setText('#api-info', `FAIL ④ ${err.message}`); }
  });
  $('#btn-api-isolation') && ($('#btn-api-isolation').onclick = async () => {
    try {
      // 서버는 세션과 무관하게 전역 하나의 모델을 쓴다 → 다른 세션에서도 같은 값이 보여야 한다.
      const before = await getAvatarModel(TEST_SESSION);
      await postAvatarModel(`${TEST_SESSION}-A`, 'yinlang');
      const viaB = await getAvatarModel(`${TEST_SESSION}-B`);
      const merged = viaB === 'yinlang';
      await postAvatarModel(TEST_SESSION, before); // 테스트가 고른 모델을 되돌린다
      const restored = await getAvatarModel(TEST_SESSION);
      const ok = merged && restored === before;
      setText('#api-info', `${ok ? 'PASS' : 'FAIL'} ⑤ 전역 통합: A 저장→B 조회=${viaB} (기대 yinlang) / 원복=${restored} (기대 ${before})`);
    } catch (err) { setText('#api-info', `FAIL ⑤ ${err.message}`); }
  });

  // 모션/표정 랩
  $('#btn-motion-groups') && ($('#btn-motion-groups').onclick = () => {
    if (!state.stage) return setText('#motion-info', '아바타를 먼저 로드하세요 (②).');
    const g = state.stage.motionGroups();
    setText('#motion-info', `모션 그룹: ${Object.entries(g).map(([k, v]) => `${k}×${v}`).join(', ') || '(없음)'}`);
  });
  $('#btn-motion-play') && ($('#btn-motion-play').onclick = async () => {
    if (!state.stage) return setText('#motion-info', '아바타를 먼저 로드하세요 (②).');
    const group = $('#motion-group').value.trim();
    const idxRaw = $('#motion-index').value.trim();
    const idx = idxRaw === '' ? undefined : Number(idxRaw);
    if (!group) return setText('#motion-info', '그룹명을 입력하세요.');
    const t0 = performance.now();
    const ok = await state.stage.motionTest(group, idx);
    setText('#motion-info', `${ok ? '재생 ✅' : '실패 ❌'} ${group}[${idxRaw === '' ? 'auto' : idxRaw}] (${Math.round(performance.now() - t0)}ms)`);
  });
  const applyExpr = async (raw) => {
    if (!state.stage) return setText('#motion-info', '아바타를 먼저 로드하세요 (②).');
    const id = /^\d+$/.test(raw) ? Number(raw) : raw;
    const ok = await state.stage.expressionTest(id);
    setText('#motion-info', `${ok ? '적용 ✅' : '실패 ❌'} 표정: ${raw}`);
  };
  $('#btn-expr-apply') && ($('#btn-expr-apply').onclick = () => {
    const raw = $('#expr-id').value.trim();
    if (raw) applyExpr(raw);
  });
  document.querySelectorAll('[data-expr]').forEach((btn) => {
    btn.onclick = () => applyExpr(btn.dataset.expr);
  });

  // 상황별 모션: 버튼 id 접미사가 그대로 상황 태그 이름이다.
  // 모션 파일은 비동기로 로드되므로 직후 조회에서는 잡히지 않는다 → 잠시 뒤 다시 쓴다.
  const reportAction = (sel, prefix) => {
    if (!state.stage) { setText(sel, '아바타를 먼저 로드하세요 (②).'); return; }
    const write = () => {
      const i = state.stage.getActionInfo();
      setText(sel, `${prefix}  감정=${i.emotion}  반응=${i.reaction?.name ?? '없음'}  모션=${i.motion ? `${i.motion.group}[${i.motion.index}]` : '없음(파라미터 반응)'}`);
    };
    write();
    setTimeout(write, 400);
  };

  document.querySelectorAll('[id^="btn-s-"]').forEach((el) => {
    const name = el.id.replace('btn-s-', '');
    el.onclick = () => {
      if (!state.stage) { setText('#situation-info', '아바타를 먼저 로드하세요 (②).'); return; }
      const ok = state.stage.playSituation(name);
      if (!ok) { setText('#situation-info', `${name} ❌ 등록된 상황 모션이 없습니다.`); return; }
      reportAction('#situation-info', `${name} ▶ 재생 중…`);
    };
  });

  // 감정 / 행동 태그 (전체 태그를 코드 목록에서 만들어 서버 허용치와 어긋나지 않게 한다)
  const renderTagButtons = () => {
    const fill = (sel, tags) => {
      const box = $(sel);
      if (!box) return;
      box.innerHTML = '';
      for (const tag of tags) {
        const b = document.createElement('button');
        b.textContent = `[${tag}]`;
        b.dataset.tag = tag;
        b.onclick = () => sendTag(tag, false);
        box.appendChild(b);
      }
    };
    fill('#emotion-btns', EMOTION_TAGS);
    fill('#action-btns', ACTION_TAGS);
  };
  renderTagButtons();

  const sendTag = (raw, localOnly) => {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag) return;
    const wsOpen = state.ws?.ws?.readyState === 1;
    if (!localOnly && wsOpen) {
      state.ws.send({ type: 'test_emotion', tag });
      setText('#emotion-info', `서버 경유 전송 → [${tag}] (응답이 돌아오면 아바타에 반영됩니다)`);
      return;
    }
    if (!state.stage) {
      setText('#emotion-info', `[${tag}] 적용 실패 — WS 미연결이고 아바타도 없습니다. ① WS 연결 또는 ② 아바타 로드 후 다시 시도하세요.`);
      return;
    }
    state.stage.setEmotion(tag);
    reportAction('#emotion-info', `로컬 직접 적용 → [${tag}]`);
  };

  $('#btn-tag-send') && ($('#btn-tag-send').onclick = () => sendTag($('#tag-input').value, false));
  $('#btn-tag-local') && ($('#btn-tag-local').onclick = () => sendTag($('#tag-input').value, true));
  $('#tag-input') && ($('#tag-input').onkeydown = (e) => { if (e.key === 'Enter') sendTag(e.target.value, false); });

  // 현재 동작 상태 패널
  let stateTimer = null;
  const renderActionState = () => {
    const el = $('#action-state');
    if (!el) return;
    if (!state.stage) { el.textContent = '아바타 미로드 (②에서 로드하세요)'; return; }
    const i = state.stage.getActionInfo();
    const layers = Object.entries(i.layers)
      .map(([k, ids]) => `  ${k.padEnd(8)} ${ids.join(', ')}`).join('\n') || '  (없음)';
    el.textContent = [
      `모델 ${i.model} · 감정 ${i.emotion} · 반응 ${i.reaction ? `${i.reaction.name} (남은 ${i.reaction.msLeft}ms)` : '없음'}`,
      `모션 ${i.motion ? `${i.motion.group}[${i.motion.index}] prio${i.motion.priority}` : '없음'} · 발화 ${i.speaking ? 'O' : 'X'} · 음량 ${i.lipVolume} · 입 ${i.mouth}`,
      `쓰다듬기 ${i.petIntensity} · 시선추적 ${i.trackIntensity} · 복귀 중 ${i.fading.length ? i.fading.join(', ') : '없음'}`,
      '레이어 (action > blink > pet > emotion > idle 순으로 우선):',
      layers,
    ].join('\n');
  };
  $('#btn-state-refresh') && ($('#btn-state-refresh').onclick = renderActionState);
  $('#btn-state-toggle') && ($('#btn-state-toggle').onclick = () => {
    if (stateTimer) {
      clearInterval(stateTimer);
      stateTimer = null;
      setText('#btn-state-toggle', '🔍 동작 상태 자동 갱신');
      return;
    }
    stateTimer = setInterval(renderActionState, 250);
    setText('#btn-state-toggle', '⏸ 자동 갱신 중지');
    renderActionState();
  });
}

// ---------- 버튼 바인딩 ----------
function bind() {
  $('#btn-ws-connect').onclick = connectWS;
  $('#btn-ws-ping').onclick = () => state.ws?.send({ type: 'ping' });
  $('#btn-ws-close').onclick = () => state.ws?.close();

  $('#btn-avatar-load').onclick = loadAvatar;

  $('#btn-tap').onclick = () => state.stage?.tap();

  $('#btn-beep').onclick = beepTest;
  $('#btn-speak-toggle').onclick = () => {
    if (!state.stage) return setText('#lipsync-info', '아바타를 먼저 로드하세요 (②).');
    const next = !state.stage.isSpeaking;
    state.stage.setSpeaking(next);
    $('#btn-speak-toggle').textContent = next ? '🗣️ 발화 끄기 (말하는 중)' : '🗣️ 발화(말하기) 토글';
    setText('#lipsync-info', next ? '발화 중 상태 ON ▶ 입이 자연스럽게 개폐됩니다. 이 상태에서 모션을 눌러보세요!' : '발화 중 상태 OFF');
  };

  $('#btn-stream').onclick = () => {
    $('#stream-out').textContent = '';
    state.ws?.send({ type: 'test_stream' });
  };

  $('#btn-tts').onclick = () => {
    ensureResumed();
    state.audioBytes = 0;
    state.counters['audio(bytes)'] = 0;
    const text = $('#tts-text').value.trim() || 'TTS 테스트 문장입니다.';
    state.ws?.send({ type: 'test_tts', text });
  };

  $('#btn-mic').onclick = () => {
    ensureResumed();
    state.mic.toggle();
  };

  $('#btn-goal').onclick = () => {
    const text = $('#goal-text').value.trim();
    if (text) state.ws?.send({ type: 'set_goal', text });
  };

  $('#btn-recall').onclick = () => {
    const q = $('#recall-text').value.trim();
    if (q) state.ws?.send({ type: 'recall', query: q });
  };

  $('#btn-upload').onclick = async () => {
    const file = $('#rag-file').files[0];
    if (!file) return logLine('업로드할 파일을 선택하세요.', 'err');
    logLine(`업로드 시작: ${file.name}`, 'sys');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/materials', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('#rag-res').textContent = `업로드 완료 ✅ 청크 ${data.chunks} / 임베딩 ${data.embedded}`;
      logLine(`업로드 완료: ${JSON.stringify(data)}`, 'sys');
    } catch (err) {
      $('#rag-res').textContent = `업로드 실패 ❌ ${err.message}`;
      logLine(`업로드 실패: ${err.message}`, 'err');
    }
    $('#rag-file').value = '';
  };

  $('#btn-rag').onclick = () => {
    const q = $('#rag-query').value.trim();
    if (!q) return;
    $('#rag-res').textContent = '검색 중...';
    state.ws?.send({ type: 'rag_search', query: q });
  };

  $('#btn-pipe').onclick = () => {
    ensureResumed();
    const text = $('#pipe-text').value.trim();
    if (!text) return;
    $('#pipe-out').textContent = '';
    state.ws?.send({ type: 'user_text', text });
  };

  bindAvatarTests();
}

// ---------- 기능 동작 ----------
function beepTest() {
  const ctx = getContext();
  ensureResumed();
  state.mic?.setSpeaking(true); // 음성 간섭 방지 확인용
  state.stage?.setSpeaking(true); // 비프음 재생 중 입 개폐 활성화
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.6);
  osc.frequency.linearRampToValueAtTime(660, ctx.currentTime + 1.2);
  osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 1.8);
  gain.gain.setValueAtTime(0.5, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.0);
  osc.connect(gain);
  gain.connect(getVoiceBus());
  osc.start();
  osc.onended = () => {
    state.mic?.setSpeaking(false);
    state.stage?.setSpeaking(false);
    setText('#lipsync-info', '비프음 종료. 입이 움직였으면 립싱크 정상 ✅');
  };
  osc.stop(ctx.currentTime + 2.05);
  setText('#lipsync-info', '재생 중 (마이크 일시 차단 중)...');
}

function renderRecall(msg) {
  $('#recall-res').textContent = !msg.hits.length
    ? '검색 결과 없음'
    : msg.hits.map((h) => `${h.recallScore.toFixed(3)} · ${h.content}`).join('\n');
}

function renderRag(msg) {
  if (!msg.hits.length) {
    $('#rag-res').innerHTML = '결과 없음 (Chroma 서버 실행 필요: <code>npm run chroma</code>)';
    return;
  }
  $('#rag-res').innerHTML = msg.hits
    .map((h) => `<div>[${(h.score ?? 0).toFixed(2)}] ${(h.metadata?.source ?? '?')}<br/>${escapeHtml(h.document)}</div>`)
    .join('');
}

async function loadGoal() {
  try {
    const res = await fetch('/api/goal');
    const data = await res.json();
    setText('#goal-res', data.goal ? `현재 목표: 🎯 ${data.goal.content}` : '현재 목표 없음');
  } catch {
    setText('#goal-res', '목표 로드 실패');
  }
}

function escapeHtml(str) {
  return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- 부트 ----------
function boot() {
  bind();

  state.player = new TTSAudioPlayer({
    onPlayStateChange: (speaking) => {
      state.mic?.setSpeaking(speaking);
      state.stage?.setSpeaking(speaking);
    },
  });

  state.mic = new MicManager({
    onTranscript: (text) => {
      setText('#mic-out', `인식됨: ${text}`);
      logLine(`🎤 STT: ${text}`, 'sys');
    },
    onListeningChange: (on) => {
      $('#btn-mic').textContent = on ? '🎤 끄기(들음중)' : '🎤 켜기';
      $('#btn-mic').classList.toggle('listening', on);
      $('#mic-out').textContent = on ? '듣는 중... 말해보세요' : '음성 인식 결과가 여기에 표시됩니다.';
    },
  });
  if (!state.mic.supported) {
    $('#btn-mic').disabled = true;
    $('#btn-mic').textContent = '🎤 미지원';
  }

  document.addEventListener('pointerdown', ensureResumed, { once: true });
  loadGoal();
  loadModelOptions();

  // 자동으로 아바타/WS 로드 시도 (즉시 테스트 가능하도록)
  connectWS();
  loadAvatar();
}

boot();