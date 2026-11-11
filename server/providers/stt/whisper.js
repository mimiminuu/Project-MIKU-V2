import { STTProvider } from './index.js';

const DEFAULT_MODEL = 'Xenova/whisper-small';

export class Provider extends STTProvider {
  constructor({ model = DEFAULT_MODEL } = {}) {
    super();
    this.model = model;
    this.pipe = null;
  }

  async init() {
    const { pipeline } = await import('@xenova/transformers');
    this.pipe = await pipeline('automatic-speech-recognition', this.model);
    console.log(`[stt] Whisper 로드 완료 – 모델: ${this.model}`);
  }

  async transcribe(audioBuffer, { sampleRate = 16000, language = 'korean' } = {}) {
    if (!this.pipe) throw new Error('STT 파이프라인이 초기화되지 않았습니다.');

    const result = await this.pipe(audioBuffer, {
      sampling_rate: sampleRate,
      language,
      task: 'transcribe',
    });

    return result.text?.trim() ?? '';
  }
}
