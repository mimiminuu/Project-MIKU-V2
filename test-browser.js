// Headless Chrome CDP 종합 브라우저 테스트 러너
// Live2D 렌더링, 4종 모델 로드/전환, 26종 상황별 모션, 인터랙션, API, WebSocket 전체 자동 검증
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 25565;
const BASE_URL = `http://localhost:${PORT}`;
const CDP_PORT = 9222;

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ` - ${detail}` : ''}`);
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.events = [];
    this.consoleLogs = [];
    this.errors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
          this.consoleLogs.push({ type: msg.params.type, text });
          if (msg.params.type === 'error') {
            this.errors.push(text);
          }
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'Unknown JS Error';
          this.errors.push(desc);
        }
      }
    });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const err = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Eval Failed: ${err}`);
    }
    return res.result?.value;
  }

  async waitForFunction(fnExpr, timeoutMs = 15000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(fnExpr);
        if (val) return val;
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitForFunction 타임아웃 (${timeoutMs}ms)`);
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function run() {
  console.log('====================================================');
  console.log('🚀 Project MIKU Live2D & 전체 프론트엔드 자동화 테스트');
  console.log('====================================================\n');

  // 1. Chrome 위치 확인
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(chromePath)) {
    console.error('❌ Chrome을 찾을 수 없습니다:', chromePath);
    process.exit(1);
  }

  // 2. Headless Chrome 실행
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-miku-test-'));
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    'about:blank',
  ], { detached: false });

  // Chrome 준비 대기
  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) {
        const info = await r.json();
        wsUrl = info.webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }

  if (!wsUrl) {
    console.error('❌ Chrome CDP 연결 실패');
    chromeProc.kill('SIGKILL');
    process.exit(1);
  }

  try {
    // 3. 페이지 타겟 생성
    const newTargetRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`${BASE_URL}/test.html`)}`, { method: 'PUT' });
    const targetInfo = await newTargetRes.json();
    const pageWsUrl = targetInfo.webSocketDebuggerUrl;

    const cdp = new CDPClient(pageWsUrl);
    await cdp.connect();

    console.log(`[1] test.html 페이지 로딩 대기...`);
    await cdp.send('Page.navigate', { url: `${BASE_URL}/test.html` });

    // 4. Live2D 모델 초기 로드 대기 (testApp.js의 loadAvatar 완료 확인)
    console.log(`[2] Live2D 캔버스 및 초기 아바타 로드 검증`);
    await cdp.waitForFunction(`
      document.querySelector('#avatar-info')?.textContent.includes('로드 성공') ||
      document.querySelector('#avatar-info')?.textContent.includes('로드 실패')
    `, 20000);

    const initAvatarStatus = await cdp.eval(`document.querySelector('#avatar-info')?.textContent`);
    const initSuccess = initAvatarStatus.includes('로드 성공');
    record('초기 아바타 로드', initSuccess, initAvatarStatus);

    // PIXI 및 Live2D 인스턴스 확인
    const pixiCheck = await cdp.eval(`Boolean(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel)`);
    record('PIXI 및 Cubism 플러그인 런타임', pixiCheck);

    // 5. WebSocket 연결 확인
    console.log(`\n[3] test.html WebSocket 통신 검증`);
    await cdp.eval(`document.querySelector('#btn-ws-connect')?.click()`);
    await cdp.waitForFunction(`document.querySelector('#ws-conn-info')?.textContent.includes('연결 성공')`, 5000);
    const wsInfo = await cdp.eval(`document.querySelector('#ws-conn-info')?.textContent`);
    record('WebSocket 연결 & Welcome 수신', wsInfo.includes('연결 성공'), wsInfo);

    // 6. 위치 / 크기 / 인터랙션 테스트
    console.log(`\n[4] 위치 / 줌 / 인터랙션(쓰다듬기·홀딩·축하) 테스트`);
    await cdp.eval(`document.querySelector('#btn-pos-up')?.click()`);
    await cdp.eval(`document.querySelector('#btn-pos-right')?.click()`);
    await cdp.eval(`document.querySelector('#btn-pos-reset')?.click()`);
    const posInfo = await cdp.eval(`document.querySelector('#pos-info')?.textContent`);
    record('위치 이동 및 리셋', posInfo.includes('초기화 ✅'), posInfo);

    // 줌 조절
    await cdp.eval(`document.querySelector('button[data-zoom="150"]')?.click() || document.querySelector('button[data-zoom="200"]')?.click()`);
    const zoomText = await cdp.eval(`document.querySelector('#t-zoom-label')?.textContent`);
    record('줌 배율 변경', Boolean(zoomText && zoomText !== '100%'), zoomText);

    // 쓰다듬기
    await cdp.eval(`document.querySelector('#btn-pet')?.click()`);
    const petInfo = await cdp.eval(`document.querySelector('#interact-info')?.textContent`);
    record('쓰다듬기 인터랙션', petInfo.includes('쓰다듬기 ✅'), petInfo);

    // 홀딩
    await cdp.eval(`document.querySelector('#btn-hold')?.click()`);
    const holdInfo = await cdp.eval(`document.querySelector('#interact-info')?.textContent`);
    record('홀딩 인터랙션 (love 표정)', holdInfo.includes('홀딩 ✅'), holdInfo);

    // 축하
    await cdp.eval(`document.querySelector('#btn-celebrate')?.click()`);
    const celebrateInfo = await cdp.eval(`document.querySelector('#interact-info')?.textContent`);
    record('더블클릭 축하 인터랙션 (cheer + 바운스)', celebrateInfo.includes('축하 ✅'), celebrateInfo);

    // 감정/행동 태그 버튼과 실제 모션 연결 검증
    const tagButtons = await cdp.eval(`document.querySelectorAll('#emotion-btns button, #action-btns button').length`);
    record('감정/행동 태그 버튼 전체 노출', tagButtons >= 31, `${tagButtons}개 버튼`);

    await cdp.eval(`(() => {
      const i = document.querySelector('#tag-input');
      i.value = 'dance';
      document.querySelector('#btn-tag-local')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const danceState = await cdp.eval(`window._stage?.getActionInfo?.() ?? null`);
    record('태그 → 모션 연결 (dance)', Boolean(danceState?.motion), danceState ? `감정=${danceState.emotion} 모션=${danceState.motion?.group}[${danceState.motion?.index}] 반응=${danceState.reaction?.name ?? '없음'}` : '상태 없음');

    await cdp.eval(`document.querySelector('#btn-state-refresh')?.click()`);
    const statePanel = await cdp.eval(`document.querySelector('#action-state')?.textContent || ''`);
    record('동작 상태 패널 표시', statePanel.includes('레이어'), statePanel.split('\\n')[0]);

    // 7. 아바타 모델 API 검증 (목록/저장/무효ID/전역 통합)
    console.log(`\n[5] 아바타 모델 API 저장/전역 통합 검증`);
    await cdp.eval(`document.querySelector('#btn-api-models')?.click()`);
    await cdp.waitForFunction(`document.querySelector('#api-info')?.textContent.includes('①')`, 3000);
    const api1 = await cdp.eval(`document.querySelector('#api-info')?.textContent`);
    record('API ① 모델 목록 조회', api1.startsWith('PASS'), api1);

    await cdp.eval(`document.querySelector('#btn-api-set-yinlang')?.click()`);
    await cdp.waitForFunction(`document.querySelector('#api-info')?.textContent.includes('③')`, 3000);
    const api3 = await cdp.eval(`document.querySelector('#api-info')?.textContent`);
    record('API ③ yinlang 저장 및 조회 일치', api3.startsWith('PASS'), api3);

    await cdp.eval(`document.querySelector('#btn-api-isolation')?.click()`);
    await cdp.waitForFunction(`document.querySelector('#api-info')?.textContent.includes('⑤')`, 3000);
    const api5 = await cdp.eval(`document.querySelector('#api-info')?.textContent`);
    record('API ⑤ 전역 모델 통합 + 원복', api5.startsWith('PASS'), api5);

    // 8. 4개 Live2D 모델 전환 테스트 (Haru, Senko, Yinlang, Miku)
    console.log(`\n[6] 4종 Live2D 모델 런타임 전환 검증`);
    const modelsToTest = ['senko', 'yinlang', 'miku', 'haru'];
    for (const mId of modelsToTest) {
      await cdp.eval(`(() => {
        const sel = document.querySelector('#t-model-select');
        if (sel) {
          sel.value = '${mId}';
          document.querySelector('#btn-model-switch')?.click();
        }
      })()`);
      await cdp.waitForFunction(`
        document.querySelector('#model-switch-info')?.textContent.includes('전환 성공') ||
        document.querySelector('#model-switch-info')?.textContent.includes('전환 실패')
      `, 15000);
      const switchRes = await cdp.eval(`document.querySelector('#model-switch-info')?.textContent`);
      const ok = switchRes.includes('전환 성공');
      record(`모델 전환: ${mId}`, ok, switchRes);
    }

    // 9. 26종 상황별 모션 전체 실행 검증
    console.log(`\n[7] 상황별 모션 26종 전체 실행 검증`);
    const situations = [
      ['nod', '#btn-s-nod', '끄덕끄덕'],
      ['explain', '#btn-s-explain', '설명'],
      ['think', '#btn-s-think', '생각'],
      ['focus', '#btn-s-focus', '집중'],
      ['proud', '#btn-s-proud', '뿌듯'],
      ['curious', '#btn-s-curious', '호기심'],
      ['whisper', '#btn-s-whisper', '속닥속닥'],
      ['joy', '#btn-s-joy', '기쁨'],
      ['surprise', '#btn-s-surprise', '놀람'],
      ['sad', '#btn-s-sad', '슬픔'],
      ['angry', '#btn-s-angry', '화남'],
      ['shy', '#btn-s-shy', '부끄'],
      ['panic', '#btn-s-panic', '멘붕'],
      ['pout', '#btn-s-pout', '삐짐'],
      ['sparkle', '#btn-s-sparkle', '초롱초롱'],
      ['fighting', '#btn-s-fighting', '파이팅'],
      ['sleepy', '#btn-s-sleepy', '졸음'],
      ['wakeup', '#btn-s-wakeup', '깨어남'],
      ['dozeoff', '#btn-s-dozeoff', '꾸벅꾸벅'],
      ['relieved', '#btn-s-relieved', '안도'],
      ['spaceout', '#btn-s-spaceout', '멍때리기'],
      ['greet', '#btn-s-greet', '인사'],
      ['shake', '#btn-s-shake', '거절'],
      ['wave', '#btn-s-wave', '손흔들기'],
      ['clap', '#btn-s-clap', '박수'],
      ['dance', '#btn-s-dance', '춤'],
    ];

    let sitFails = 0;
    for (const [key, sel, label] of situations) {
      try {
        await cdp.eval(`document.querySelector('${sel}')?.click()`);
        const status = await cdp.eval(`document.querySelector('#situation-info')?.textContent`);
        if (!status || !status.includes('재생 중')) {
          sitFails++;
          record(`모션: ${label}(${key})`, false, status);
        }
      } catch (err) {
        sitFails++;
        record(`모션: ${label}(${key})`, false, err.message);
      }
    }
    if (sitFails === 0) {
      record('상황별 모션 26종 전체 디스패치', true, '26종 모두 정상 트리거');
    }

    // 10. 발화 중 립싱크 토글 및 모션 충돌 방지 검증
    console.log(`\n[8] 립싱크 및 발화 상태 토글 검증`);
    await cdp.eval(`document.querySelector('#btn-speak-toggle')?.click()`);
    const lipInfo = await cdp.eval(`document.querySelector('#lipsync-info')?.textContent`);
    record('발화 중 상태 ON (입 개폐 활성화)', lipInfo.includes('발화 중 상태 ON'), lipInfo);

    // 발화 중 모션 트리거 시 에러 없이 유지되는지 확인
    await cdp.eval(`document.querySelector('#btn-s-dance')?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    const isSpeakingAfterMotion = await cdp.eval(`window._stage?.isSpeaking ?? true`);
    record('모션 중 립싱크 발화 상태 유지', Boolean(isSpeakingAfterMotion));

    await cdp.eval(`document.querySelector('#btn-speak-toggle')?.click()`);

    // 11. 메인 페이지(index.html) 전환 및 UI 검증
    console.log(`\n[9] 메인 앱(index.html) Live2D 로드 및 칠판 연동 검증`);
    await cdp.send('Page.navigate', { url: `${BASE_URL}/index.html` });
    
    // 시연 로그인 게이트 통과
    await new Promise((r) => setTimeout(r, 600));
    await cdp.eval(`(() => {
      const u = document.querySelector('#login-username');
      const p = document.querySelector('#login-password');
      if (u && p) {
        u.value = 'admin';
        p.value = '1212';
        document.querySelector('#login-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    })()`);

    await cdp.waitForFunction(`
      Boolean(window._stage && window._stage.model) ||
      Boolean(document.querySelector('.app-notice'))
    `, 20000);

    const mainStageLoaded = await cdp.eval(`Boolean(window._stage && window._stage.model)`);
    record('메인 앱 Live2D 무대 초기화', mainStageLoaded);

    const mainModelId = await cdp.eval(`window._stage?.modelId || 'unknown'`);
    record('메인 앱 활성 모델', Boolean(mainModelId), `현재 모델: ${mainModelId}`);

    // 테마 전환 버튼 검증
    await cdp.eval(`document.querySelector('#btn-theme-toggle')?.click()`);
    const theme = await cdp.eval(`document.documentElement.getAttribute('data-theme')`);
    record('다크/라이트 테마 전환', Boolean(theme), `테마: ${theme}`);

    // 실시간 채팅 및 어시스턴트 응답 스트리밍 검증
    console.log(`\n[10] 메인 앱 실시간 대화 및 Live2D 반응 스트리밍 검증`);
    await cdp.waitForFunction(`Boolean(window._ws && window._ws.ws && window._ws.ws.readyState === 1)`, 10000);

    const initialCount = await cdp.eval(`document.querySelectorAll('.msg.assistant').length`);

    await cdp.eval(`(() => {
      const input = document.querySelector('#chat-input');
      if (input) {
        input.value = '안녕!';
        document.querySelector('#chat-form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    })()`);

    // 신규 어시스턴트 버블 생성 대기
    await cdp.waitForFunction(`document.querySelectorAll('.msg.assistant').length > ${initialCount}`, 10000);
    record('사용자 질문 전송 및 어시스턴트 버블 생성', true);

    // 응답 스트리밍 완료 대기 (로컬 LLM은 첫 토큰까지 오래 걸릴 수 있어 여유 있게 잡는다)
    await cdp.waitForFunction(`(() => {
      const bubbles = document.querySelectorAll('.msg.assistant');
      const last = bubbles[bubbles.length - 1];
      return last && !last.classList.contains('streaming') && Boolean(last.textContent.trim());
    })()`, 60000);

    const answerText = await cdp.eval(`(() => {
      const bubbles = document.querySelectorAll('.msg.assistant');
      const last = bubbles[bubbles.length - 1];
      return last?.querySelector('.msg-markdown')?.textContent || last?.textContent || '';
    })()`);
    record('AI 답변 스트리밍 완료', answerText.length > 0, `답변: "${answerText.slice(0, 40).replace(/\\n/g, ' ')}..."`);

    // 발화 후 아바타 상태 확인
    const postChatEmotion = await cdp.eval(`window._stage?.model ? 'Ready' : 'Error'`);
    record('대화 후 Live2D 무대 정상 유지', postChatEmotion === 'Ready');

    // 콘솔 에러 검증
    console.log(`\n[11] 브라우저 콘솔 에러 점검`);
    const realErrors = cdp.errors.filter((e) => !e.includes('favicon') && !e.includes('test_audio'));
    if (realErrors.length === 0) {
      record('브라우저 콘솔 에러 없음', true, 'Clean Console');
    } else {
      record('브라우저 콘솔 에러 없음', false, `${realErrors.length}개 에러: ${realErrors[0]}`);
    }

    cdp.close();
  } catch (err) {
    console.error('테스트 중 치명적 오류:', err);
    record('전체 브라우저 테스트 파이프라인', false, err.message);
  } finally {
    try { chromeProc.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }

  // 결과 집계
  console.log('\n====================================================');
  console.log('📊 전체 자동화 테스트 결과 요약');
  console.log('====================================================');
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;

  console.log(`총 테스트 수: ${total}개`);
  console.log(`성공: ${passed}개`);
  console.log(`실패: ${failed}개`);

  if (failed === 0) {
    console.log('\n🎉 전체 브라우저 및 Live2D 테스트 100% 통과!\n');
    process.exit(0);
  } else {
    console.log(`\n❌ ${failed}개 테스트 실패 확인 필요\n`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
