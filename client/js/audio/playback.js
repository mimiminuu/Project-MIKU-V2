// TTS 오디오 재생 큐.
// 문장 단위 오디오를 순차 재생하고, 재생 구간 동안 마이크 입력을 차단(음성 간섭 방지)합니다.
import { getContext, getVoiceBus, setMicBlocked } from './audioBus.js';

export class TTSAudioPlayer {
  constructor({ onPlayStateChange, onPlaybackEnd } = {}) {
    this.context = getContext();
    this.queue = [];
    this.playing = false;
    this.currentSource = null;
    this.finishCurrent = null;
    this.generation = 0;
    this.onPlayStateChange = onPlayStateChange || (() => {});
    this.onPlaybackEnd = onPlaybackEnd || (() => {});
  }

  isPlaying() {
    return this.playing || this.queue.length > 0;
  }

  // 서버에서 tts_meta + 바이너리 오디오를 수신할 때 호출
  enqueue(meta, arrayBuffer) {
    this.queue.push({ meta, buffer: arrayBuffer });
    if (!this.playing) void this._drain();
  }

  async _drain() {
    const generation = this.generation;
    this.playing = true;
    this.setSpeaking(true);
    try {
      while (generation === this.generation && this.queue.length) {
        const item = this.queue.shift();
        const audioBuffer = await this._decode(item.buffer);
        if (generation !== this.generation) return;
        if (!audioBuffer) continue;
        await this._playBuffer(audioBuffer);
      }
    } finally {
      // 취소된 drain은 새 재생의 마이크 게이트/상태를 변경할 수 없다.
      if (generation === this.generation) {
        this.playing = false;
        this.setSpeaking(false);
        this.onPlaybackEnd();
      }
    }
  }

  async _decode(arrayBuffer) {
    try {
      return await this.context.decodeAudioData(this._toArrayBuffer(arrayBuffer));
    } catch (err) {
      console.warn('오디오 디코딩 실패:', err);
      return null;
    }
  }

  _toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      const ab = new ArrayBuffer(input.byteLength);
      new Uint8Array(ab).set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      return ab;
    }
    return input;
  }

  _playBuffer(audioBuffer) {
    return new Promise((resolve) => {
      const src = this.context.createBufferSource();
      this.currentSource = src;
      src.buffer = audioBuffer;
      src.connect(getVoiceBus());
      const finish = () => {
        src.onended = null;
        try { src.disconnect(); } catch {}
        if (this.currentSource === src) this.currentSource = null;
        if (this.finishCurrent === finish) this.finishCurrent = null;
        resolve();
      };
      this.finishCurrent = finish;
      src.onended = finish;
      try {
        src.start();
      } catch (err) {
        console.warn('오디오 재생 시작 실패:', err);
        finish();
      }
    });
  }

  setSpeaking(on) {
    setMicBlocked(on); // 재생 중 마이크 차단
    this.onPlayStateChange(on);
  }

  stop() {
    // 세대를 올려 진행 중이던 디코딩/재생 루프가 끝난 뒤 상태를 되돌리지 못하게 한다.
    this.generation += 1;
    this.queue = [];
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {}
      this.currentSource = null;
    }
    // 디코딩 대기 중이던 _playBuffer Promise를 즉시 종료시킨다.
    if (this.finishCurrent) {
      const finish = this.finishCurrent;
      this.finishCurrent = null;
      try { finish(); } catch {}
    }
    this.playing = false;
    this.setSpeaking(false);
    this.onPlaybackEnd();
  }
}