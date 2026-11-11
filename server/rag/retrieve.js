// RAG 검색: 질문을 임베딩해 Chroma에서 관련 학습 자료 청크를 찾습니다.
import { connect } from './chromaClient.js';
import { getEmbeddingRuntime } from '../providers/index.js';
import { accountKey } from '../core/sessions.js';

export async function search(query, { topK = 4, sessionId = null, accountId = 'anonymous' } = {}) {
  const { collection, available } = await connect();
  if (!available) return [];

  const runtime = await getEmbeddingRuntime();
  const embedding = runtime?.embedding;
  if (!embedding) return [];
  const vec = await embedding.embedQuery(query);

  const queryParams = {
    queryEmbeddings: [vec],
    nResults: topK,
    include: ['documents', 'distances', 'metadatas'],
  };

  if (sessionId) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    // Chroma는 한 객체에 여러 키를 직접 넣는 where를 거부한다. 조건은 $and로 묶는다.
    queryParams.where = {
      $and: [
        { sessionId: safeSessionId },
        { accountKey: accountKey(accountId) },
      ],
    };
  }

  let res;
  try {
    res = await collection.query(queryParams);
  } catch (err) {
    console.warn('[rag] 쿼리 실패:', err.message);
    return [];
  }

  const docs = res.documents?.[0] || [];
  const dists = res.distances?.[0] || [];
  const metas = res.metadatas?.[0] || [];
  return docs.map((document, i) => ({
    document,
    distance: dists[i],
    metadata: metas[i] || {},
    score: 1 - (dists[i] ?? 1),
  }));
}