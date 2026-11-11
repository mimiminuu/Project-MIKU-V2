// 통합/유닛 테스트: API 키 없이 mock으로 전체 파이프라인을 검증합니다.
// 테스트는 항상 mock 프로바이더를 사용하도록 환경을 강제합니다.
// ES 모듈에서 static import 전에 env를 설정하려면 dynamic import가 필요합니다.
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.STT_PROVIDER = 'mock';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  getRuntime,
  ShortTermMemory,
  LongTermMemory,
  Pipeline,
  cleanTextForTTS,
  SentenceChunker,
  chunkText,
  renderMarkdown,
} = await (async () => {
  const providers = await import('../server/providers/index.js');
  const shortTerm = await import('../server/memory/shortTerm.js');
  const longTerm = await import('../server/memory/longTerm.js');
  const pipeline = await import('../server/core/pipeline.js');
  const chunker = await import('../server/core/sentenceChunker.js');
  const rag = await import('../server/rag/ingest.js');
  const md = await import('../client/js/markdown.js');
  return { ...providers, ...shortTerm, ...longTerm, ...pipeline, ...chunker, ...rag, ...md };
})();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-miku-test-'));

const results = [];
const record = (name, pass, extra = '') =>
  results.push(`${pass ? '✅' : '❌'} ${name}${extra ? ` - ${extra}` : ''}`);

async function testChunker() {
  const sentences = [];
  const chunker = new SentenceChunker({ flushTimeoutMs: 800, onChunk: (s) => sentences.push(s) });

  chunker.push('여기서 이 ');
  chunker.push('공식을 적용해 보면 ');
  chunker.push('어떨까?'); // '?' 로 플러시
  assert.equal(sentences.length, 1, '구두점 완성 시 즉시 플러시');
  assert.equal(sentences[0], '여기서 이 공식을 적용해 보면 어떨까?');

  chunker.push('소수점 ');
  chunker.push('3.14');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sentences.length, 1, '소수점은 문장 끝으로 보지 않음');

  const before = sentences.length;
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(sentences.length, before + 1, '타임아웃 시 미완성 문장 플러시');

  chunker.push('매우 '); // 길이 초과 강제 분리
  chunker.push('긴 '.repeat(200));
  assert.ok(sentences.length > before + 1, 'maxChunkChars 초과 시 강제 분리');
  record('SentenceChunker', true);
}

async function testLongTermMemory() {
  const db = new LongTermMemory({ dbPath: path.join(tmpDir, 'memory.json') });
  await db.init();

  await db.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분', importance: 4 });
  await db.add({ type: 'fact', content: '수열의 합 공식', importance: 2 });

  const now = new LongTermMemory({ dbPath: path.join(tmpDir, 'memory2.json') });
  await now.init();
  const old = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 지수법칙', importance: 4 });
  old.lastAccessAt = Date.now() - 30 * 86400000; // 30일 전 접근
  now._save();

  const near = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분', importance: 4 });
  near.lastAccessAt = Date.now(); // 방금 접근
  now._save();

  // 경쟁 항목: 같은 주제지만 마스터 전 상태
  const competitor = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분 기본', importance: 4 });
  competitor.mastered = false;
  competitor.lastAccessAt = Date.now();
  now._save();

  const recalled = now.recall('로그함수 미분 잘 모르겠어');
  const nearRank = recalled.findIndex((r) => r.id === near.id);
  const oldRank = recalled.findIndex((r) => r.id === old.id);
  assert.ok(nearRank !== -1, '최근 접근 항목 검색');
  assert.ok(oldRank === -1 || nearRank < oldRank, '망각 감쇠로 오래된 항목 가중치 하락');

  await now.setMastered(near.id, true);
  const afterMaster = now.recall('로그함수 미분 잘 모르겠어');
  const masteredRank = afterMaster.findIndex((r) => r.id === near.id);
  const compRank = afterMaster.findIndex((r) => r.id === competitor.id);
  assert.ok(masteredRank === -1 || (compRank !== -1 && compRank < masteredRank), '마스터된 항목은 가중치가 크게 감소');

  const goal = await db.setGoal('오늘은 미분의 연쇄법칙 마스터하기');
  assert.equal(db.getGoal().content, '오늘은 미분의 연쇄법칙 마스터하기');
  assert.ok(fs.existsSync(path.join(tmpDir, 'memory.json')), '영구 저장');
  record('LongTermMemory (망각 알고리즘)', true);
}

async function testShortTerm() {
  // 턴수 및 토큰 예산 슬라이딩 윈도우 검증
  const mem = new ShortTermMemory({ maxTurns: 4, maxTokens: 16400 });
  mem.addUser('1번 메시지');
  mem.addAssistant('2번 응답');
  mem.addUser('3번 메시지');
  mem.addAssistant('4번 응답');
  assert.equal(mem.getHistory().length, 4, '4턴 정상 보존');

  mem.addUser('5번 메시지');
  assert.equal(mem.getHistory().length, 4, '최대 턴수 초과 시 오래된 턴 슬라이딩');
  assert.equal(mem.getHistory()[0].content, '2번 응답', '가장 오래된 1번 턴 제거됨');
  record('ShortTermMemory (슬라이딩 윈도우 및 토큰 예산)', true);
}

async function testPipeline() {
  const providers = await getRuntime();
  const shortTerm = new ShortTermMemory({ maxTurns: 8 });
  const longTerm = new LongTermMemory({ dbPath: path.join(tmpDir, 'pipe-memory.json') });
  await longTerm.init();

  const events = [];
  const send = (payload) => events.push(typeof payload === 'string' ? JSON.parse(payload) : payload);

  const pipeline = new Pipeline({ providers, memory: { shortTerm, longTerm }, send });

  assert.equal(pipeline.currentModel, 'nemotron', '기본 모델은 nemotron');
  assert.ok(pipeline.getLlmProvider(), 'nemotron 프로바이더 조회 가능');
  pipeline.setThink(false);
  assert.equal(pipeline.think, false, '추론 비활성화 성공');
  pipeline.setThink(true);
  assert.equal(pipeline.think, true, '추론 활성화 성공');

  const t0 = Date.now();
  await pipeline.handleUserText('안녕, 오늘 공식 문제 같이 풀자!');

  const statuses = events.filter((e) => e.type === 'status').map((e) => e.state);
  assert.ok(statuses.includes('thinking') && statuses.includes('speaking'), '상태 전이 발생');

  const emotions = events.filter((e) => e.type === 'emotion').map((e) => e.tag);
  assert.ok(emotions.length >= 1, '감정 태그 파싱');
  const tags = ['smile', 'think', 'cheer', 'sad', 'wink', 'neutral', 'love'];
  assert.ok(tags.includes(emotions[0]), `유효한 감정 태그 (${emotions[0]})`);

  const display = events
    .filter((e) => e.type === 'assistant_text_partial')
    .map((e) => e.text)
    .join('');
  assert.ok(display.includes('이'), '표시 텍스트 스트리밍');
  assert.ok(!display.includes('['), '감정 태그가 표시에서 제거됨');

  const ttsMetas = events.filter((e) => e.type === 'tts_meta');
  assert.ok(ttsMetas.length >= 1, 'TTS 메타 전송');
  const binaryCount = events.filter((e) => e instanceof ArrayBuffer).length;
  assert.ok(binaryCount >= 1, 'TTS 오디오 바이너리 전송');

  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 8000, `소요 시간 적정 (${elapsed}ms)`);

  assert.equal(shortTerm.turns.length, 2, '단기 기억에 user/assistant 기록');
  record('Pipeline (mock LLM/TTS 통합)', true, `첫 응답 완료 ${elapsed}ms`);
}

async function testRagChunk() {
  const chunks = chunkText('첫 번째 문단입니다.\n\n두 번째 문단입니다. 내용이 충분히 길어야 합니다.'.repeat(8));
  assert.ok(chunks.length >= 1, '청크 분할 생성');
  assert.ok(chunks.every((c) => c.length <= 700), '청크 크기 제한');
  record('RAG 청크 분할', true, `${chunks.length}개 청크`);
}

async function testMarkdownAndThinkingAndTTS() {
  // 1) TTS 마크다운 정제 검증
  const rawMd = '### 1. 핵심\n- **연쇄법칙**은 `f(g(x))`를 *미분*할 때 써요! [참고](https://example.com) ```js\nconsole.log(1);\n```';
  const cleaned = cleanTextForTTS(rawMd);
  assert.ok(!/[*`#~]/.test(cleaned), 'TTS 텍스트에 마크다운 기호가 남지 않음');
  assert.ok(!cleaned.includes('https://'), 'TTS 텍스트에서 URL 제거됨');
  assert.ok(!cleaned.includes('console.log'), 'TTS 텍스트에서 코드 블록 제거됨');
  assert.ok(cleaned.includes('연쇄법칙은 f(g(x))를 미분할 때 써요!'), '본문 텍스트 보존');

  // 2) 프론트엔드 마크다운 변환 검증 (달러 수식 + 한글 조사 결합 + 표 + 수식 예시 카드 + 코드 카드 포함)
  const html = renderMarkdown(
    '## 제목\n\n**굵게** 그리고 *기울임*\n- 항목 1\n- 항목 2\n\n' +
    'x + 2 = 5 : 여기서 $ x $의 값을 찾는 것이 목표입니다.\n' +
    'x^2 = 16 : 이 방정식은 $ x $의 제곱이 16이라는 것을 나타냅니다.\n' +
    'y = 2x + 1 : 이 식은 $ x 와 y $ 사이의 관계를 나타냅니다.\n\n' +
    '| 개념 | 설명 |\n| --- | --- |\n| 미분 | 순간변화율 |\n\n' +
    '```js\nconsole.log(1);\n```'
  );
  assert.ok(html.includes('<h2>제목</h2>'), '헤더 변환');
  assert.ok(html.includes('<strong>굵게</strong>'), '굵은 글씨 변환');
  assert.ok(html.includes('<em>기울임</em>'), '기울임 변환');
  assert.ok(html.includes('<ul>') && html.includes('<li>항목 1</li>'), '목록 변환');
  assert.ok(!html.includes('$'), '$ 기호가 화면에 남지 않고 수식 태그로 변환됨');
  assert.ok(html.includes('<span class="math-inline">x</span>의'), '$ x $의 변환 및 내부 공백 제거');
  assert.ok(html.includes('<span class="math-inline">x 와 y</span>'), '$ x 와 y $ 변환');
  assert.ok(html.includes('class="math-badge">x<sup>2</sup> = 16</span>'), '수식 : 설명 구조가 배지 카드로 변환됨');
  assert.ok(html.includes('<table class="md-table">'), '마크다운 표 변환');
  assert.ok(html.includes('class="code-card"') && html.includes('class="btn-copy-code"'), 'ChatGPT 스타일 코드 카드 변환');

  const mathTts = cleanTextForTTS('x + 2 = 5 : 여기서 $ x $의 값을 찾는 것이 목표입니다. 이 식은 $ x 와 y $ 사이의 관계를 나타냅니다.');
  assert.ok(!mathTts.includes('$'), 'TTS에서도 $ 기호 완전 제거');
  assert.ok(mathTts.includes('여기서 x의 값을'), 'TTS에서 $ x $의 → x의 자연스럽게 연결');

  // 3) <think> + [emotion] + [TOOL:...] + 마크다운 스트리밍 파이프라인 검증
  const spokenSentences = [];
  const customProviders = {
    llm: {
      async *streamChat() {
        const tokens = [
          '<think>', '사용자에게 ', '밝게 인사하고 ', '개념을 설명하자.', '</think>\n',
          '[smile] ', '**안녕!** ', '연쇄법칙을 알아보자.\n',
          '[sh', 'y] 50대 직장인 입장이야.\n',
          '[focus', '] 집중해서 보자.\n',
          '[TOOL:open', '_explanation]', '{"title":"연쇄법칙","content":"## 연쇄법칙\\n\\n중요해."}',
          ' 알겠지?'
        ];
        for (const t of tokens) {
          yield { token: t };
        }
      },
    },
    tts: {
      async *speak(text) {
        spokenSentences.push(text);
        yield { buffer: new ArrayBuffer(8), sampleRate: 24000, channels: 1, durationMs: 10, format: 'pcm' };
      },
    },
  };

  const events = [];
  const pipeline = new Pipeline({
    providers: customProviders,
    memory: {
      shortTerm: new ShortTermMemory({ maxTurns: 4 }),
      longTerm: { recall: async () => [], getGoal: () => null, all: () => [], add: () => {} },
    },
    send: (p) => events.push(typeof p === 'string' ? JSON.parse(p) : p),
  });

  await pipeline.handleUserText('연쇄법칙 알려줘');

  const thinkEvents = events.filter((e) => e.type === 'assistant_think').map((e) => e.text).join('');
  assert.ok(thinkEvents.includes('밝게 인사하고'), '<think> 내용이 assistant_think 이벤트로 전달됨');

  const emotionEvent = events.find((e) => e.type === 'emotion');
  assert.equal(emotionEvent?.tag, 'smile', '</think> 뒤의 [smile] 감정 태그 정상 파싱');

  const partialText = events.filter((e) => e.type === 'assistant_text_partial').map((e) => e.text).join('');
  assert.ok(!partialText.includes('[TOOL:'), '스트리밍 중 미완성 [TOOL:...]이 채팅 텍스트로 새지 않음');
  assert.ok(!partialText.includes('<think>'), '<think>가 일반 채팅 텍스트로 새지 않음');
  assert.ok(!partialText.includes('[sh'), '스트리밍 중 분할된 감정 태그([sh...)가 노출되지 않음');
  assert.ok(!partialText.includes('[focus'), '스트리밍 중 감정 태그([focus)가 노출되지 않음');
  assert.ok(partialText.includes('50대 직장인'), '감정 태그 뒤 텍스트가 인덱스 오차 없이 온전히 보존됨');
  assert.ok(partialText.includes('집중해서 보자'), '후속 문장 보존');
  assert.ok(partialText.includes('**안녕!**'), '채팅 텍스트에는 마크다운 원문 유지 (클라이언트 렌더링용)');

  const toolEvent = events.find((e) => e.type === 'tool_call');
  assert.equal(toolEvent?.name, 'open_explanation', '도구 호출 정상 파싱');

  const allSpoken = spokenSentences.join(' ');
  assert.ok(!allSpoken.includes('*'), 'TTS 발화 문장에서 ** 기호 제거됨');
  assert.ok(!allSpoken.includes('TOOL'), 'TTS 발화 문장에서 도구 호출 제거됨');
  assert.ok(allSpoken.includes('안녕!'), 'TTS 발화 본문 정상 전달');

  record('Thinking / 마크다운 / TTS 정제 통합 검증', true);
}

async function testLogger() {
  const { normalizeIp, getClientIp, logger } = await import('../server/core/logger.js');

  // 1. IP 정규화 검증
  assert.equal(normalizeIp('192.168.1.10'), '192.168.1.10', '기본 IPv4 정규화');
  assert.equal(normalizeIp('192.168.1.10:3000'), '192.168.1.10', 'IPv4 포트 분리');
  assert.equal(normalizeIp('::ffff:192.168.0.5'), '192.168.0.5', 'IPv6 매핑 IPv4 변환');
  assert.equal(normalizeIp('::1'), '127.0.0.1', 'IPv6 루프백 변환');
  assert.equal(normalizeIp('localhost'), '127.0.0.1', 'localhost 변환');
  assert.equal(normalizeIp('1.2.3.4\r\nFAKE_LOG'), 'unknown', 'CRLF 로그 주입 IP 차단');
  assert.equal(normalizeIp('<script>alert(1)</script>'), 'unknown', '악성 스크립트 IP 차단');
  assert.equal(normalizeIp(null), 'unknown', 'null IP 처리');

  // 2. getClientIp 검증 (다양한 프록시 및 헤더 환경)
  const reqWithXff = {
    headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
  };
  assert.equal(getClientIp(reqWithXff), '203.0.113.195', 'X-Forwarded-For 첫 번째 클라이언트 IP 추출');

  const reqWithCf = {
    headers: { 'cf-connecting-ip': '::ffff:198.51.100.4' },
  };
  assert.equal(getClientIp(reqWithCf), '198.51.100.4', 'CF-Connecting-IP 추출 및 정규화');

  const reqWithRealIp = {
    headers: { 'x-real-ip': '10.0.0.1' },
  };
  assert.equal(getClientIp(reqWithRealIp), '10.0.0.1', 'X-Real-IP 추출');

  const reqSocket = {
    socket: { remoteAddress: '::1' },
  };
  assert.equal(getClientIp(reqSocket), '127.0.0.1', 'Socket remoteAddress 추출');

  // 3. 로거 이벤트 및 링 버퍼 필터링 검증
  logger.clearMemory();
  logger.http('GET /api/test 200 5ms', { ip: '192.168.1.50', status: 200 });
  logger.ws('WebSocket 클라이언트 연결', { ip: '10.10.10.10', sessionId: 'test-session' });
  logger.error('테스트 에러 발생', { ip: '192.168.1.50' });

  const allLogs = logger.getRecentLogs({ limit: 10 });
  assert.equal(allLogs.length, 3, '최근 로그 3건 저장');

  const httpLogs = logger.getRecentLogs({ level: 'HTTP' });
  assert.equal(httpLogs.length, 1, 'HTTP 레벨 필터링');
  assert.equal(httpLogs[0].ip, '192.168.1.50', '로그 IP 보존');

  const ipLogs = logger.getRecentLogs({ ip: '10.10.10.10' });
  assert.equal(ipLogs.length, 1, 'IP 기준 필터링');
  assert.equal(ipLogs[0].level, 'WS', 'WS 레벨 확인');

  // 4. 서버 종료 시 시간.log 생성 검증
  const { formatShutdownFileName } = await import('../server/core/logger.js');
  const fileName = formatShutdownFileName();
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/.test(fileName), '종료 시간 파일명 형식 일치');

  const savedFile = logger.saveShutdownLog('test');
  assert.ok(savedFile && fs.existsSync(savedFile), '종료 시 로그 파일 정상 생성');
  const fileContent = fs.readFileSync(savedFile, 'utf8');
  assert.ok(fileContent.includes('192.168.1.50'), '로그 파일에 요청 IP 기록 보존');
  assert.ok(fileContent.includes('서버 종료'), '종료 태그 기록 확인');
  try { fs.unlinkSync(savedFile); } catch {}

  record('Logger IP 식별 및 종료 시 시간.log 파일 저장', true);
}

(async () => {
  await testChunker();
  await testLongTermMemory();
  await testShortTerm();
  await testPipeline();
  await testRagChunk();
  await testMarkdownAndThinkingAndTTS();
  await testLogger();

  console.log('\n===== 테스트 결과 =====');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('❌'));
  console.log(failed.length ? `\n실패: ${failed.length}` : '\n전체 통과 🎉');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('테스트 에러:', err);
  process.exit(1);
});