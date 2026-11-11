// 문장 단위 청커: LLM 토큰 스트림을 구두점(. ! ?) 기준으로 잘라
// TTS로 즉시 넘길 수 있도록 합니다. 미완성 문장은 타임아웃으로 강제 플러시하여
// 첫 발화 지연을 1초 내외로 유지합니다.
const SENT_END = /[.!?。…]["'”’」』）)\]]*\s*$/;
const DECIMAL_TAIL = /\d\.\s*$/;

export class SentenceChunker {
  /**
   * @param {object} opts
   * @param {number} opts.flushTimeoutMs  미완성 문장 강제 플러시 시간
   * @param {number} opts.maxChunkChars   최대 청크 길이(이 이상이면 강제 분리)
   * @param {(sentence: string) => void} opts.onChunk 완성된 문장 콜백
   */
  constructor({ flushTimeoutMs = 1200, maxChunkChars = 160, onChunk }) {
    this.flushTimeoutMs = flushTimeoutMs;
    this.maxChunkChars = maxChunkChars;
    this.onChunk = onChunk;
    this.buffer = '';
    this.timer = null;
    this.ended = false;
  }

  push(text) {
    if (!text || this.ended) return;
    this.buffer += text;
    this._restartTimer();

    if (this.buffer.length >= this.maxChunkChars) {
      this.flush();
      return;
    }
    // 소수점("3.14")은 문장 끝으로 보지 않음
    if (!DECIMAL_TAIL.test(this.buffer) && SENT_END.test(this.buffer)) {
      this.flush();
    }
  }

  flush() {
    if (!this.buffer.trim()) {
      this.buffer = '';
      this._clearTimer();
      return;
    }
    const sentence = this.buffer.trim();
    this.buffer = '';
    this._clearTimer();
    if (this.onChunk) this.onChunk(sentence);
  }

  end() {
    this.ended = true;
    this.flush();
  }

  _restartTimer() {
    this._clearTimer();
    this.timer = setTimeout(() => this.flush(), this.flushTimeoutMs);
  }

  _clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}