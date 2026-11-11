// STT(음성 인식) 공급자 인터페이스.
// 실시간 스트리밍 인식(Whisper API / Deepgram Nova-2 등)은 이 인터페이스로 구현합니다.
// dev(mock) 모드에서는 인식이 브라우저 Web Speech API로 대체되어
// 서버가 아닌 클라이언트에서 `user_text`를 직접 전송합니다.
export class STTProvider {
  async init() {
    throw new Error('not implemented');
  }

  // 추후 실시간 스트리밍 인식 구현 시 사용할 자리.
  // async *recognizeStream(audioChunks, opts) {}
}