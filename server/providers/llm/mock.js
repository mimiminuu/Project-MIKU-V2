// Mock LLM: API 키 없이 파이프라인을 검증하기 위한 대체 구현.
// 응답 시작에 감정 태그([smile] 등)를 붙여 실제 LLM처럼 동작합니다.
import { LLMProvider } from './index.js';

const TAGS = ['[smile]', '[think]', '[cheer]', '[sad]', '[wink]', '[neutral]', '[love]'];

function pickTag(userText) {
  if (/어렵|모르|헷갈|실패|못하|틀렸/.test(userText)) return '[cheer]';
  if (/공|문제|풀이|원리|증명|유도|힌트/.test(userText)) return '[think]';
  if (/안녕|반가|좋아|오래|그랬/.test(userText)) return '[smile]';
  if (/화|짜증|슬프|피곤/.test(userText)) return '[sad]';
  if (/와!|대단|끝|완료|성공/.test(userText)) return '[cheer]';
  return TAGS[Math.floor(Math.random() * 2)]; // smile / think
}

function buildReply(userText) {
  const q = /[?？]$/.test(userText.trim());
  if (/안녕|반가/.test(userText)) {
    return '안녕! 와줘서 고마워. 오늘도 같이 공부해 보자! 지금 어떤 과목을 하고 싶어?';
  }
  if (/공식|공|문제/.test(userText)) {
    return '여기서 이 공식을 적용해 보면 어떨까? 먼저 주어진 값을 식에 대입해 보고, 그다음에 단위를 확인해 봐. 맞아, 거의 다 왔어! 그래도 막히면 언제든 힌트 달라고 해.';
  }
  if (/어렵|모르|헷갈/.test(userText)) {
    return '괜찮아, 처음엔 다들 헷갈려. 천천히 하나씩 나눠서 생각해 보자. 우리가 지난번에 정리해 둔 개념에서 연결해 볼까? 분명히 잡을 수 있어, 힘내!';
  }
  if (/끝|완료|성공|다 했/.test(userText)) {
    return '오, 진짜 잘했어! 오늘 한 부분을 다시 한번 정리해 두면 다음에 복습할 때 훨씬 편해질 거야. 정말 대단해!';
  }
  if (q) {
    return '좋은 질문이야! 정답을 바로 말하기 전에, 이 문제에서 핵심이 되는 개념이 뭘지 먼저 생각해 볼래? 힌트를 주면 훨씬 기억에 오래 남을 거야!';
  }
  return '응, 들었어! 그 관점으로 한번 접근해 보자. 이해가 안 되는 부분이 생기면 그때 바로 알려줘, 같이 풀어볼게.';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockLLMProvider extends LLMProvider {
  async init() {}

  async *streamChat({ messages }) {
    const last = messages.filter((m) => m.role === 'user').at(-1);
    const text = last ? last.content : '';
    const tag = pickTag(text);
    const reply = buildReply(text);

    // 감정 태그를 가장 먼저 출력
    for (const ch of tag) {
      await sleep(15 + Math.random() * 25);
      yield { token: ch };
    }
    await sleep(180);

    // 워드 단위로 분할하여 토큰 스트리밍
    const words = reply.split(/(\s+)/);
    for (const w of words) {
      await sleep(30 + Math.random() * 70);
      yield { token: w };
    }
  }
}