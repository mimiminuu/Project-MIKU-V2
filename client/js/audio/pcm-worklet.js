// 마이크 PCM 캡처 워크렛: 입력 오디오를 메인 스레드로 전달 (서버 STT용).
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length) {
      // postMessage는 버퍼를 복사하므로 뷰 재사용 문제가 없음
      this.port.postMessage(new Float32Array(input));
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
