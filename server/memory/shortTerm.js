// 단기/순간 기억: 최근 대화 턴 및 256K 토큰 윈도우 슬라이딩 버퍼를 관리합니다.
export class ShortTermMemory {
  constructor({ maxTurns = 500, maxTokens = 262144, turns = [], toolContext = [], onChange = () => {} } = {}) {
    this.maxTurns = maxTurns;
    this.maxTokens = maxTokens;
    this.turns = turns;
    this.toolContext = toolContext;
    this.onChange = onChange;
    this.disposed = false;
    this._prune();
  }

  /**
   * 보수적 토큰 추정 (한국어/영어/코드 혼용: 2글자당 약 1토큰)
   */
  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 2);
  }

  _prune() {
    // 1. 최대 턴 수 초과 시 오래된 턴 정리
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }

    // 2. 256K 토큰 예산 관리 (시스템 프롬프트/도구 마진 16K를 제외한 대화 이력 버퍼)
    const tokenBudget = Math.max(1000, this.maxTokens - 16384);
    let totalTokens = 0;
    let cutIndex = 0;

    for (let i = this.turns.length - 1; i >= 0; i--) {
      const est = this._estimateTokens(this.turns[i].content);
      if (totalTokens + est > tokenBudget) {
        cutIndex = i + 1;
        break;
      }
      totalTokens += est;
    }

    if (cutIndex > 0) {
      this.turns.splice(0, cutIndex);
    }
  }

  add(role, content) {
    if (this.disposed) return;
    this.turns.push({ role, content, ts: Date.now() });
    this._prune();
    this.onChange(this);
  }

  rememberTool(name, args, result) {
    if (this.disposed || !name) return;
    const lines = [`[도구 실행 기록] ${name}`];
    if (args && typeof args === 'object') {
      const summary = JSON.stringify(args).slice(0, 1200);
      if (summary) lines.push(`입력: ${summary}`);
    }
    if (result !== undefined) {
      let text = '';
      try {
        text = typeof result === 'string' ? result : JSON.stringify(result);
      } catch {}
      if (text) lines.push(`결과: ${text.slice(0, 2000)}`);
    }
    this.toolContext.push({ content: lines.join('\n'), ts: Date.now() });
    if (this.toolContext.length > 12) this.toolContext.shift();
    this.onChange(this);
  }

  getToolContext() {
    return this.toolContext.map((entry) => entry.content).filter(Boolean);
  }

  dispose() {
    this.disposed = true;
    this.turns = [];
    this.toolContext = [];
    this.onChange = () => {};
  }

  addUser(content) {
    this.add('user', content);
  }

  addAssistant(content) {
    this.add('assistant', content);
  }

  getHistory(limit = this.maxTurns) {
    return this.turns.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  clear() {
    this.turns = [];
  }
}
