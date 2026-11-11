// Chroma(벡터 DB) 클라이언트 래퍼.
// Chroma 서버는 별도 실행이 필요합니다:
//   pip install chromadb && chroma run --host 127.0.0.1 --port 8000
// 서버가 꺼져 있으면 available=false로 동작하며, 검색은 빈 결과를 반환합니다.
import { ChromaClient } from 'chromadb';
import { config } from '../config.js';

let client = null;
let collection = null;
let lastWarnAt = 0;
const WARN_COOLDOWN_MS = 30_000;

export async function connect() {
  if (collection) return { client, collection, available: true };
  try {
    client = new ChromaClient({ path: config.chroma.url });
    collection = await client.getOrCreateCollection({
      name: config.chroma.collection,
      metadata: { 'hnsw:space': 'cosine' },
    });
    return { client, collection, available: true };
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt > WARN_COOLDOWN_MS) {
      lastWarnAt = now;
      console.warn(`[rag] Chroma 연결 불가 (${config.chroma.url}) - ${err.message}`);
    }
    client = null;
    collection = null;
    return { client: null, collection: null, available: false };
  }
}

export async function isAvailable() {
  return (await connect()).available;
}
