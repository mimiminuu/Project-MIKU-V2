// 세션 관리: 계정·세션별 저장 경로, 대화 기억의 수명, 삭제(기억/자료/검색벡터)를 한곳에서 처리합니다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LongTermMemory } from '../memory/longTerm.js';
import { ShortTermMemory } from '../memory/shortTerm.js';
import { connect as connectChroma } from '../rag/chromaClient.js';

// 세션 ID는 경로에 직접 사용되므로 화이트리스트 외 값은 전부 'default'로 대체합니다.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function normalizeSessionId(raw) {
  const sid = String(raw ?? '').trim();
  return SESSION_ID_RE.test(sid) ? sid : 'default';
}

export function normalizeAccountId(raw) {
  const account = String(raw ?? '').trim().slice(0, 64);
  return ACCOUNT_RE.test(account) ? account.toLowerCase() : 'anonymous';
}

// 계정 ID는 파일명으로 쓰지 않고 해시로 바꿔 대소문자·경로 문제를 피한다.
export function accountKey(rawAccountId) {
  return createHash('sha256').update(normalizeAccountId(rawAccountId)).digest('hex').slice(0, 16);
}

export function materialDir(materialsRoot, accountId, rawSessionId) {
  return path.join(materialsRoot, accountKey(accountId), normalizeSessionId(rawSessionId));
}

export function sessionDbFile(dbPath, accountId, rawSessionId) {
  const sid = normalizeSessionId(rawSessionId);
  return path.join(path.dirname(dbPath), `${path.basename(dbPath, '.db')}_${accountKey(accountId)}_${sid}.db`);
}

function conversationFile(dbPath, accountId, rawSessionId) {
  const sid = normalizeSessionId(rawSessionId);
  return path.join(path.dirname(dbPath), 'conversations', `${accountKey(accountId)}_${sid}.json`);
}

const records = new Map(); // `${accountKey}\u0000${sessionId}` -> record
const tombstones = new Map(); // 삭제된 세션 키 -> 삭제 시각

const recordKey = (accountId, sessionId) => `${accountKey(accountId)}\u0000${normalizeSessionId(sessionId)}`;

export function isSessionDeleted(accountId, sessionId) {
  return tombstones.has(recordKey(accountId, sessionId));
}

function loadConversation(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
      toolContext: Array.isArray(parsed.toolContext) ? parsed.toolContext : [],
    };
  } catch {
    return { turns: [], toolContext: [] };
  }
}

export function getSessionRecord({ dbPath, materialsDir: materialsRoot, accountId, sessionId, demo = false, maxTurns = 500, maxTokens = 262144 }) {
  const account = normalizeAccountId(accountId);
  const sid = normalizeSessionId(sessionId);
  const key = recordKey(account, sid);
  const found = records.get(key);
  if (found && !found.deleted) return found;

  const file = conversationFile(dbPath, account, sid);
  const saved = loadConversation(file);
  const record = {
    key,
    accountId: account,
    sessionId: sid,
    demo: Boolean(demo),
    deleted: false,
    active: true,
    connections: new Set(),
    pendingOperations: new Set(),
    // 같은 세션에 여러 연결이 붙어도 턴이 겹치지 않게 세션 단위로 직렬화한다.
    turnQueue: Promise.resolve(),
    conversationFile: file,
    dbFile: sessionDbFile(dbPath, account, sid),
    materialsDir: materialDir(materialsRoot, account, sid),
  };

  record.saveConversation = () => {
    if (record.deleted) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        turns: record.shortTerm?.turns || [],
        toolContext: record.shortTerm?.toolContext || [],
      }), 'utf8');
      fs.renameSync(tmp, file);
    } catch {}
  };

  record.shortTerm = new ShortTermMemory({
    maxTurns,
    maxTokens,
    turns: saved.turns,
    toolContext: saved.toolContext,
    onChange: record.saveConversation,
  });
  record.longTerm = new LongTermMemory({ dbPath: record.dbFile });
  record.ready = record.longTerm.init().catch((err) => {
    console.warn(`[sessions] 장기 기억 로드 실패 (${account}/${sid}):`, err.message);
  });
  record.memory = {
    shortTerm: record.shortTerm,
    longTerm: record.longTerm,
    isActive: () => record.active && !record.deleted,
  };

  records.set(key, record);
  return record;
}

export async function getSessionMemory(dbPath, rawSessionId, rawAccountId = 'anonymous') {
  const record = await ensureSessionRecord({
    dbPath,
    materialsDir: path.join(path.dirname(dbPath), 'materials'),
    accountId: rawAccountId,
    sessionId: rawSessionId,
  });
  return record.longTerm;
}

export async function ensureSessionRecord(options) {
  if (isSessionDeleted(options.accountId, options.sessionId)) {
    const err = new Error('삭제된 세션입니다. 새 대화를 시작해 주세요.');
    err.status = 410;
    err.name = 'AbortError';
    throw err;
  }
  const record = getSessionRecord(options);
  await record.ready;
  return record;
}

export function clearSessionCache() {
  for (const record of records.values()) {
    record.active = false;
    record.longTerm.dispose?.();
  }
  records.clear();
}

// 세션 하나의 대화 기억, 장기 기억 DB, 업로드 자료, 검색용 벡터를 모두 지웁니다.
export async function deleteSession({ dbPath, materialsDir: materialsRoot, accountId, sessionId, demo = false }) {
  const account = normalizeAccountId(accountId);
  const sid = normalizeSessionId(sessionId);
  const key = recordKey(account, sid);
  const record = records.get(key);

  if (record) {
    record.deleted = true;
    record.active = false;
    for (const connection of record.connections) {
      try { connection.notifyDeleted?.(); } catch {}
    }
    const pending = [];
    for (const operation of record.pendingOperations) {
      try { operation.abort?.(); } catch {}
      if (operation.promise) pending.push(operation.promise);
    }
    // 진행 중인 업로드가 끝난 뒤에 파일/벡터를 지워야 삭제 후 재생성이 없다.
    await Promise.allSettled(pending);
    record.longTerm.dispose?.();
    record.shortTerm.dispose?.();
    records.delete(key);
  }

  const removedFiles = [];
  const dbFile = sessionDbFile(dbPath, account, sid);
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbFile}${suffix}`;
    if (removeFile(target)) removedFiles.push(target);
  }
  if (removeFile(conversationFile(dbPath, account, sid))) {
    removedFiles.push(conversationFile(dbPath, account, sid));
  }
  const dir = materialDir(materialsRoot, account, sid);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removedFiles.push(dir);
    }
  } catch {}

  let chromaDeleted = false;
  try {
    const { collection, available } = await connectChroma();
    if (available) {
      await collection.delete({
        where: {
          $and: [
            { sessionId: sid },
            { accountKey: accountKey(account) },
          ],
        },
      });
      chromaDeleted = true;
    }
  } catch (err) {
    console.warn(`[sessions] 검색 벡터 삭제 건너뜀 (${account}/${sid}):`, err.message);
  }

  tombstones.set(key, Date.now());
  return { removedFiles, chromaDeleted, demo: Boolean(demo) };
}

// 예전 함수명 유지: 개별 세션 삭제만 수행한다.
export async function purgeSession(rawSessionId, dbPath, materialsRoot = '', accountId = 'anonymous') {
  return deleteSession({
    dbPath,
    materialsDir: materialsRoot || path.join(path.dirname(dbPath), 'materials'),
    accountId,
    sessionId: rawSessionId,
  });
}

function removeFile(target) {
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
  } catch {}
  return false;
}
