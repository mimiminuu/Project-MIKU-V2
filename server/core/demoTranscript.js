// 시연 계정 대화 기록: 참가자(세션)별로 대화를 한 줄씩 남겨 관리자 콘솔에서 확인합니다.
// AI 장기기억(세션 종료 시 삭제)과 달리, 이 기록은 운영 확인용으로 별도 보관됩니다.
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../config.js';

const LOG_DIR = path.join(STORE_DIR, 'demo_logs');
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function filePath(sessionId) {
  const sid = SID_RE.test(String(sessionId || '')) ? String(sessionId) : 'invalid';
  return path.join(LOG_DIR, `${sid}.jsonl`);
}

function readAll(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// 이름 등록 시점에 참가자 정보를 남긴다 (아직 대화를 안 해도 목록에 보이도록)
export function recordSessionMeta({ sessionId, account, participant }) {
  if (!sessionId) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = filePath(sessionId);
    const entries = readAll(file);
    const meta = entries.find((e) => e.type === 'meta');
    if (meta) {
      if (participant && meta.participant !== participant) {
        fs.writeFileSync(file, entries.map((e) => JSON.stringify(e.type === 'meta' ? { ...e, participant } : e)).join('\n') + '\n', 'utf8');
      }
      return;
    }
    const first = { type: 'meta', sessionId, account: account || '', participant: participant || '', startedAt: Date.now() };
    if (entries.length > 0) {
      fs.writeFileSync(file, JSON.stringify(first) + '\n' + entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } else {
      writeLine(file, first);
    }
  } catch {}
}

export function recordTurn({ sessionId, account, participant, role, text }) {
  if (!sessionId || !text) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = filePath(sessionId);
    if (!fs.existsSync(file)) recordSessionMeta({ sessionId, account, participant });
    writeLine(file, {
      type: 'turn',
      ts: Date.now(),
      role: role === 'user' ? 'user' : 'assistant',
      account: account || '',
      participant: participant || '',
      text: String(text).slice(0, 4000),
    });
  } catch {}
}

// 참가자(세션) 목록: 계정 / 참가자 이름 / 세션 / 시작·마지막 시각 / 턴 수
export function listSessions() {
  try {
    if (!fs.existsSync(LOG_DIR)) return [];
    const rows = [];
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.replace(/\.jsonl$/, '');
      const entries = readAll(path.join(LOG_DIR, name));
      if (entries.length === 0) continue;
      const meta = entries.find((e) => e.type === 'meta') || {};
      const turns = entries.filter((e) => e.type === 'turn');
      const last = turns[turns.length - 1];
      rows.push({
        sessionId,
        account: meta.account || last?.account || '',
        participant: meta.participant || last?.participant || '',
        startedAt: meta.startedAt || turns[0]?.ts || null,
        lastAt: last?.ts || meta.startedAt || null,
        turns: turns.length,
        lastRole: last?.role || '',
        lastText: (last?.text || '').slice(0, 80),
      });
    }
    // 대화가 오간 참가자를 먼저, 아직 말이 없는 연결은 뒤로
    rows.sort((a, b) => {
      if ((a.turns > 0) !== (b.turns > 0)) return a.turns > 0 ? -1 : 1;
      return (b.lastAt || 0) - (a.lastAt || 0);
    });
    return rows;
  } catch {
    return [];
  }
}

// 대화 전문 (after 이후의 턴만 반환)
export function readSession(sessionId, after = 0) {
  const entries = readAll(filePath(sessionId));
  if (entries.length === 0) return null;
  const meta = entries.find((e) => e.type === 'meta') || {};
  const messages = entries
    .filter((e) => e.type === 'turn' && (!after || e.ts > after))
    .map((e) => ({ ts: e.ts, role: e.role, text: e.text }));
  return {
    sessionId,
    account: meta.account || '',
    participant: meta.participant || '',
    startedAt: meta.startedAt || entries[0]?.ts || null,
    messages,
  };
}

export function deleteSession(sessionId) {
  try {
    fs.unlinkSync(filePath(sessionId));
    return true;
  } catch {
    return false;
  }
}

export function deleteAll() {
  try {
    if (!fs.existsSync(LOG_DIR)) return 0;
    let count = 0;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        fs.unlinkSync(path.join(LOG_DIR, name));
        count++;
      } catch {}
    }
    return count;
  } catch {
    return 0;
  }
}
