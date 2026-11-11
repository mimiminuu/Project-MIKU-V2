// 마이크 관리: 음성 입력(STT) + 음성 간섭 방지 게이트.
// - auto 모드(기본): 브라우저 Web Speech API로 인식 (크롬/엣지)
// - server 모드: 마이크 PCM(16kHz Int16)을 WS로 전송해 서버 Whisper로 인식
import { getContext, getMicGain, ensureResumed } from './audioBus.js';

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

// 서버 STT 전송 형식 (server/ws/hub.js 와 계약 일치)
const SERVER_STT_SAMPLE_RATE = 16000;

export class MicManager {
  constructor({ onTranscript, onListeningChange, mode = 'auto', onServerChunk, onServerReset } = {}) {
    this.onTranscript = onTranscript || (() => {});
    this.onListeningChange = onListeningChange || (() => {});
    this.mode = mode; // 'auto' | 'server'
    this.onServerChunk = onServerChunk || null;
    this.onServerReset = onServerReset || null;
    this.recognition = null;
    this.stream = null;
    this.listening = false;
    this.blocked = false;
    this.shouldListen = false;
    this.restartTimer = null;
    this.capture = null;
    this.workletReady = null;
  }

  get usesServerStt() {
    return this.mode === 'server' && typeof this.onServerChunk === 'function';
  }

  get supported() {
    return this.usesServerStt || Boolean(SpeechRecognition);
  }

  async start() {
    ensureResumed();
    if (!this.supported) {
      alert('이 브라우저는 음성 인식을 지원하지 않습니다.\n텍스트 입력을 사용해 주세요.');
      return;
    }
    // 권한 + 서버 STT 모드의 실시간 오디오 캡처를 위해 마이크 확보
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('마이크 접근 실패:', err);
      this.stream = null;
    }

    this.listening = true;
    this.shouldListen = true;
    this.onListeningChange(true);
    if (this.usesServerStt && this.stream) {
      await this._startCapture();
    } else if (SpeechRecognition) {
      if (this.stream) {
        const src = getContext().createMediaStreamSource(this.stream);
        src.connect(getMicGain()); // 모니터링 없이 게인 라우팅만 구성
      }
      this._startRecognition();
    }
  }

  stop() {
    this.shouldListen = false;
    this.listening = false;
    this._stopRecognition();
    this._stopCapture();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.onListeningChange(false);
  }

  toggle() {
    if (this.listening) this.stop();
    else this.start();
  }

  // --- 음성 간섭 방지: TTS 재생 중 임시 인식 중지 ---
  setSpeaking(speaking) {
    this.setSpeechBlocked(speaking);
  }

  setSpeechBlocked(blocked) {
    this.blocked = blocked;
    if (blocked) {
      this.listening = false;
      this._stopRecognition();
      // TTS 소리가 서버 버퍼에 섞이지 않도록 버퍼도 비움
      if (this.usesServerStt) this.onServerReset?.();
      this.onListeningChange(false);
    } else if (this.shouldListen) {
      this.listening = true;
      if (!this.usesServerStt) this._startRecognition();
      this.onListeningChange(true);
    }
  }

  // --- 서버 STT 모드: 마이크 PCM 캡처 → 16kHz Int16 변환 → WS 전송 ---
  async _startCapture() {
    const ctx = getContext();
    const src = ctx.createMediaStreamSource(this.stream);
    src.connect(getMicGain()); // 게인 라우팅 유지 (모니터링 없음)

    let node = null;
    if (ctx.audioWorklet) {
      try {
        // 모듈은 오디오 컨텍스트당 1회 로드
        if (!this.workletReady) {
          this.workletReady = ctx.audioWorklet.addModule('/js/audio/pcm-worklet.js');
        }
        await this.workletReady;
        node = new AudioWorkletNode(ctx, 'pcm-capture');
        node.port.onmessage = (e) => this._sendPcm(e.data);
      } catch (err) {
        console.warn('AudioWorklet 초기화 실패, ScriptProcessor로 대체:', err);
        node = null;
      }
    }
    if (!node) {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this._sendPcm(e.inputBuffer.getChannelData(0));
    }

    // 처리기 풀링을 위해 무음 게인을 거쳐 destination까지 연결
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    this.capture = { src, node, mute };
  }

  _stopCapture() {
    if (!this.capture) return;
    try {
      this.capture.src.disconnect();
      this.capture.node.disconnect();
      this.capture.mute.disconnect();
      if (this.capture.node.port) this.capture.node.port.onmessage = null;
      this.capture.node.onaudioprocess = null;
    } catch {
      /* noop */
    }
    this.capture = null;
  }

  _sendPcm(samples) {
    if (!this.listening || this.blocked || !this.capture) return;
    const int16 = this._downsampleToInt16(samples, getContext().sampleRate, SERVER_STT_SAMPLE_RATE);
    if (int16.length) this.onServerChunk(int16.buffer);
  }

  // AudioContext 샘플레이트(44.1/48kHz) → 16kHz 선형 보간 + Int16 변환
  _downsampleToInt16(samples, fromRate, toRate) {
    const clamp = (v) => Math.max(-1, Math.min(1, v)) * 32767;
    if (fromRate === toRate) {
      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = clamp(samples[i]);
      return out;
    }
    const ratio = fromRate / toRate;
    const out = new Int16Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const s0 = samples[idx] ?? 0;
      const s1 = samples[idx + 1] ?? s0;
      out[i] = clamp(s0 + (s1 - s0) * (pos - idx));
    }
    return out;
  }

  _startRecognition() {
    if (this.blocked || this.recognition) return;
    const rec = new SpeechRecognition();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const final = e.results[i].isFinal;
        const text = e.results[i][0].transcript.trim();
        if (final && text) this.onTranscript(text);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop();
      }
    };
    rec.onend = () => {
      this.recognition = null;
      // 연속 청취 유지 (말하기 중간의 자동 종료 대응)
      if (this.shouldListen && !this.blocked) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this._startRecognition(), 300);
      } else {
        this.listening = false;
        this.onListeningChange(false);
      }
    };
    try {
      rec.start();
      this.recognition = rec;
    } catch {
      this.recognition = null;
    }
  }

  _stopRecognition() {
    clearTimeout(this.restartTimer);
    if (this.recognition) {
      this.recognition.onend = null; // 재시작 사이클 방지
      try {
        this.recognition.abort();
      } catch {
        /* noop */
      }
      this.recognition = null;
    }
  }
}