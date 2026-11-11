// 로컬 실행 임베딩: @xenova/transformers (all-MiniLM-L6-v2).
// 외부 API 키 없이 로컬에서 동작하므로 RAG를 지금 바로 구현/검증할 수 있습니다.
import { pipeline } from '@xenova/transformers';
import { EmbeddingProvider } from './index.js';

export class TransformersEmbeddingProvider extends EmbeddingProvider {
  constructor() {
    super();
    this.model = 'Xenova/all-MiniLM-L6-v2';
    this.embedder = null;
    this._initPromise = null;
  }

  init() {
    if (this.embedder) return Promise.resolve();
    if (!this._initPromise) {
      // 동시 첫 요청은 같은 모델 로드를 기다리고, 실패한 로드는 재시도할 수 있습니다.
      this._initPromise = Promise.resolve()
        .then(() => pipeline('feature-extraction', this.model))
        .then((embedder) => { this.embedder = embedder; })
        .finally(() => { this._initPromise = null; });
    }
    return this._initPromise;
  }

  async embed(texts) {
    if (!texts || !texts.length) return [];
    await this.init();
    const batchSize = 32;
    const results = [];
    let dimension = null;
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      const out = await this.embedder(slice, { pooling: 'mean', normalize: true });
      // transformers v2의 mean pooling 결과는 Tensor[batch, dimension] 하나입니다.
      if (out?.dims?.length !== 2 || out.dims[0] !== slice.length ||
          !Number.isInteger(out.dims[1]) || out.dims[1] <= 0 || typeof out.tolist !== 'function') {
        throw new Error('임베딩 Tensor의 배치 개수 또는 차원이 올바르지 않습니다.');
      }
      dimension ??= out.dims[1];
      const rows = out.tolist();
      if (out.dims[1] !== dimension || rows.length !== slice.length) {
        throw new Error('임베딩 배치 사이의 개수 또는 차원이 일치하지 않습니다.');
      }
      for (const row of rows) {
        const vector = Array.from(row);
        if (vector.length !== dimension || !vector.every(Number.isFinite)) {
          throw new Error('임베딩 벡터의 차원 또는 값이 올바르지 않습니다.');
        }
        results.push(vector);
      }
    }
    return results;
  }
}