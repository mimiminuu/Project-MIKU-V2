// 장기 기억: 사용자가 자주 헷갈려하는 개념, 취약 단원, 오늘의 공부 목표 등을 영구 저장.
// 망각 메커니즘: 최근 접근이 오래될수록 검색 가중치가 지수 감쇠하며,
// 완전히 마스터한 항목은 가중치가 크게 낮아집니다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HALF_LIFE_DAYS = 7; // 재접근 반감기

function ngrams(text, n = 2) {
  const chars = text.replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n));
  return out;
}

function overlap(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = new Set([...a].filter((x) => b.has(x)));
  return inter.size / (a.size + b.size - inter.size || 1);
}

export class LongTermMemory {
  constructor({ dbPath, forgetHalfLifeDays = HALF_LIFE_DAYS } = {}) {
    this.dbPath = dbPath;
    this.halfLifeDays = forgetHalfLifeDays;
    this.items = [];
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    this.items = [];
  }

  async init() {
    if (fs.existsSync(this.dbPath)) {
      try {
        this.items = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } catch {
        this.items = [];
      }
    } else {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.items = [];
      this._save();
    }
  }

  async add({ type = 'fact', content, tags = [], importance = 3, mastered = false, meta = {} } = {}) {
    const item = {
      id: randomUUID(),
      type,
      content,
      tags,
      importance,
      mastered,
      meta,
      accessCount: 0,
      lastAccessAt: Date.now(),
      createdAt: Date.now(),
    };
    this.items.push(item);
    this._save();
    return item;
  }

  async setGoal(text) {
    const goal = await this.add({ type: 'goal', content: text, tags: ['목표'], importance: 5, meta: { kind: 'today_goal' } });
    return goal;
  }

  getGoal() {
    return this.items.filter((i) => i.type === 'goal').sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  // 세션별 아바타 모델 선택 (각 세션이 독립적으로 기억, 전역 공유 아님)
  async setAvatarModel(modelId) {
    const item = await this.add({
      type: 'avatar_model',
      content: String(modelId || ''),
      tags: ['아바타'],
      importance: 5,
      meta: { kind: 'avatar_model' },
    });
    return item;
  }

  getAvatarModel() {
    return (
      this.items
        .filter((i) => i.type === 'avatar_model')
        .sort((a, b) => b.createdAt - a.createdAt)[0] || null
    );
  }

  async touch(id) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.accessCount += 1;
      item.lastAccessAt = Date.now();
      this._save();
    }
  }

  async setMastered(id, mastered = true) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.mastered = mastered;
      item.lastAccessAt = Date.now();
      this._save();
    }
  }

  all() {
    return [...this.items].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  /**
   * 질문과 관련된 기억을 망각 가중치를 적용해 상위 k개 반환.
   * @param {string} query
   * @param {number} topK
   */
  recall(query, { topK = 5, minScore = 0.02 } = {}) {
    const qGram = ngrams(query);
    if (qGram.size === 0) return [];
    const scored = this.items.map((item) => {
      const textGram = ngrams(`${item.content} ${item.tags.join(' ')}`);
      const relevance = overlap(qGram, textGram);
      const ageDays = (Date.now() - item.lastAccessAt) / 86400000;
      const recency = 1 / (1 + ageDays / this.halfLifeDays);
      const masteryPenalty = item.mastered ? 0.25 : 1;
      const interest = item.accessCount === 0 ? 1 : 1 + 0.1 * Math.log1p(item.accessCount);
      const score = (relevance * 1.5 + item.importance / 5) * recency * masteryPenalty * interest;
      return { item, score };
    });
    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ item, score }) => ({ ...item, recallScore: score }));
  }

  _save() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }
}