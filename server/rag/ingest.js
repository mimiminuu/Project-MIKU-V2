// 학습 자료 수집(RAG): PDF/텍스트를 파싱하고 청크로 분할하여 임베딩 후 Chroma에 적재합니다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MATERIALS_DIR } from '../config.js';
import { connect } from './chromaClient.js';
import { getEmbeddingRuntime } from '../providers/index.js';
import { materialDir, accountKey } from '../core/sessions.js';

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('세션 삭제로 업로드가 취소되었습니다.');
    err.name = 'AbortError';
    throw err;
  }
}

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 120;

// pdf-parse 1.1.1은 index.js에 테스트 파일 의존이 있어 lib 경로로 import
async function loadPdfParser() {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  return mod.default || mod;
}

export function chunkText(text) {
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  const source = paragraphs.join('\n');
  const chunks = [];
  for (let start = 0; start < source.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_SIZE, source.length);
    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    // 마지막 본문을 이미 포함했다면 overlap만 있는 청크를 만들지 않습니다.
    if (end === source.length) break;
  }
  return chunks;
}

export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'
]);

const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.py', '.js', '.ts',
  '.html', '.css', '.c', '.cpp', '.java', '.xml', '.yaml', '.yml', '.sql', '.sh'
]);

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = await loadPdfParser();
      const data = await pdfParse(fs.readFileSync(filePath));
      if (data && typeof data.text === 'string' && data.text.trim()) {
        return data.text;
      }
    } catch (err) {
      console.warn(`[rag:extractText] pdf-parse 실패 (${filePath}):`, err.message);
    }

    // 텍스트 스트림 직접 정규식 추출 폴백
    try {
      const raw = fs.readFileSync(filePath).toString('latin1');
      const textMatches = [];
      const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
      let m;
      while ((m = streamRegex.exec(raw)) !== null) {
        const tjMatches = m[1].match(/\(([^)]+)\)\s*Tj/g) || [];
        for (const tj of tjMatches) {
          const inner = tj.replace(/^\(|\)\s*Tj$/g, '');
          if (inner.trim()) textMatches.push(inner);
        }
      }
      if (textMatches.length) return textMatches.join(' ');
    } catch {}

    return '';
  }

  // 기타 형식은 텍스트로 시도
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export async function ingestFile({ originalName, buffer, sessionId = 'default', accountId = 'anonymous', signal }) {
  throwIfAborted(signal);
  const safeSessionId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const sessionDir = materialDir(MATERIALS_DIR, accountId, safeSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // 경로 조작 방지: 파일명만 추출하고, 안전한 파일명 생성
  const base = path.basename(String(originalName || '')).replace(/^\.+/, '').trim() || 'upload.txt';
  const safe = `${Date.now()}-${base.replace(/[^a-zA-Z0-9._가-힣-]/g, '_')}`;
  const filePath = path.join(sessionDir, safe);
  fs.writeFileSync(filePath, buffer);

  const ext = path.extname(base).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return {
      filePath,
      filename: base,
      chunks: 0,
      embedded: 0,
      isImage: true,
      note: '이미지 파일입니다. Vision 모델이 시각 정보를 직접 분석합니다.',
    };
  }

  let text = '';
  try {
    text = await extractText(filePath);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[rag:ingest] 텍스트 파싱 오류 (${base}):`, err.message);
  }
  throwIfAborted(signal);

  const chunks = chunkText(text);
  if (!chunks.length) {
    return {
      filePath,
      filename: base,
      chunks: 0,
      embedded: 0,
      note: '텍스트가 없거나 스캔 이미지 위주 문서입니다. 파일 원본은 안전하게 저장되었습니다.',
    };
  }

  try {
    const { collection, available } = await connect();
    if (!available) {
      return { filePath, filename: base, chunks: chunks.length, embedded: 0, note: 'Chroma 서버 미연결 - 파일 원본 저장 완료' };
    }

    const { embedding } = await getEmbeddingRuntime();
    if (!embedding) {
      return { filePath, filename: base, chunks: chunks.length, embedded: 0, note: '임베딩 프로바이더 없음 - 파일 원본 저장 완료' };
    }

    // 대용량 청크는 최대 60개까지 인덱싱하여 업로드 지연 방지 (전체 내용은 read_file로 직접 읽음)
    const MAX_EMBED = 60;
    const embedSlice = chunks.slice(0, MAX_EMBED);
    const vectors = await embedding.embed(embedSlice);
    throwIfAborted(signal);
    if (vectors.length !== embedSlice.length) {
      throw new Error(`임베딩 개수 불일치 (${vectors.length}/${embedSlice.length})`);
    }

    const ids = embedSlice.map(() => randomUUID());
    const BATCH_SIZE = 50;
    for (let i = 0; i < embedSlice.length; i += BATCH_SIZE) {
      throwIfAborted(signal);
      const chunkSlice = embedSlice.slice(i, i + BATCH_SIZE);
      const vectorSlice = vectors.slice(i, i + BATCH_SIZE);
      const idSlice = ids.slice(i, i + BATCH_SIZE);
      await collection.upsert({
        ids: idSlice,
        embeddings: vectorSlice,
        documents: chunkSlice,
        metadatas: chunkSlice.map((_, idx) => ({
          sessionId: safeSessionId,
          accountKey: accountKey(accountId),
          source: base,
          filePath: safe,
          chunkIndex: i + idx,
        })),
      });
    }

    return { filePath, filename: base, chunks: chunks.length, embedded: embedSlice.length };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[rag:ingest] 임베딩 적재 건너뜀 (${base}):`, err.message);
    return { filePath, filename: base, chunks: chunks.length, embedded: 0, note: `임베딩 건너뜀 (${err.message}) - 파일 원본 저장 완료` };
  }
}
