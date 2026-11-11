// 임베딩 공급자 인터페이스. RAG 검색을 위한 벡터 생성을 담당합니다.
export class EmbeddingProvider {
  async init() {
    throw new Error('not implemented');
  }

  /**
   * 여러 문장을 배치 임베딩합니다.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    throw new Error('not implemented');
  }

  async embedQuery(text) {
    const out = await this.embed([text]);
    return out[0];
  }
}