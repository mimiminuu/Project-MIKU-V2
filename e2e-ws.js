// E2E(WebSocket) 테스트: 실행 중인 서버에 접속해 전체 파이프라인을 검증합니다.
// 사전 실행: node server/index.js
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://localhost:25565/ws';
const ws = new WebSocket(URL);

const events = [];
let timeoutId = setTimeout(() => {
  console.error('⏰ E2E 테스트 시간 초과');
  ws.close();
  process.exit(1);
}, 20000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'user_text', text: '안녕! 오늘 미분 공부할 건데, 공식 문제 같이 풀 수 있어?' }));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    events.push({ type: 'audio', bytes: data.length });
    return;
  }
  const msg = JSON.parse(data.toString());
  events.push(msg);
  if (msg.type === 'status' && msg.state === 'idle') {
    clearTimeout(timeoutId);
    ws.close();
    report();
  }
});

function report() {
  const types = events.map((e) => e.type);
  const checks = [];
  checks.push(['연결 welcome', types.includes('welcome')]);
  checks.push(['상태 thinking', types.includes('status') && events.some((e) => e.type === 'status' && e.state === 'thinking')]);
  checks.push(['상태 speaking', types.includes('status') && events.some((e) => e.type === 'status' && e.state === 'speaking')]);
  checks.push(['감정 태그', types.includes('emotion')]);
  const display = events.filter((e) => e.type === 'assistant_text_partial').map((e) => e.text).join('');
  checks.push(['텍스트 스트리밍', display.length > 0]);
  checks.push(['태그 미노출', !display.includes('[')]);
  checks.push(['TTS 메타', types.includes('tts_meta')]);
  checks.push(['TTS 오디오 바이너리', events.some((e) => e.type === 'audio')]);
  checks.push(['종료 assistant_text_end', types.includes('assistant_text_end')]);

  console.log('===== E2E 결과 =====');
  let fail = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${name}`);
    if (!pass) fail++;
  }
  console.log(fail ? `\n실패: ${fail}` : '\n전체 통과 🎉');
  process.exit(fail ? 1 : 0);
}

ws.on('error', (err) => {
  console.error('WS 오류:', err.message);
  process.exit(1);
});