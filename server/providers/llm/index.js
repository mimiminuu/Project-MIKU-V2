// LLM(대화) 공급자 인터페이스.
// 실제 클라우드 API(GPT-4o-mini, Claude Haiku, Gemini Flash 등)는
// 이 인터페이스를 구현하는 파일을 추가하고 .env의 LLM_PROVIDER로 선택합니다.
export class LLMProvider {
  async init() {
    throw new Error('not implemented');
  }

  /**
   * 스트리밍 채팅 응답.
   * @param {{messages: Array<{role: string, content: string}>}} ctx
   * @yields {{ token: string }} 토큰 단위 또는 문자열 단위
   */
  async *streamChat(ctx) {
    throw new Error('not implemented');
  }
}