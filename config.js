import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const CLIENT_DIR = path.join(ROOT, 'client');
export const STORE_DIR = path.join(ROOT, 'server', 'store');
export const MATERIALS_DIR = path.join(STORE_DIR, 'materials');
export const MODEL_DIR = path.join(CLIENT_DIR, 'assets', 'models', 'live2d');
export const LOGS_DIR = path.join(STORE_DIR, 'logs');

export const config = {
  port: Number(process.env.PORT) || 25565,
  chroma: {
    url: process.env.CHROMA_URL || 'http://127.0.0.1:8000',
    collection: process.env.CHROMA_COLLECTION || 'study_materials',
  },
  memory: {
    dbPath: process.env.MEMORY_DB || path.join(STORE_DIR, 'memory.db'),
    shortTermTurns: Number(process.env.SHORT_TERM_TURNS) || 500,
    maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS) || 262144, // 256K 토큰 윈도우
    forgetHalfLifeDays: 7,
  },
  chunker: {
    flushTimeoutMs: 2200,
    maxChunkChars: 160,
  },
  providers: {
    llm: (() => {
      const key = process.env.AI_API_KEY || '';
      if (key.startsWith('sk-')) return 'openai';
      if (key.startsWith('AIza')) return 'gemini';
      return process.env.LLM_PROVIDER || 'gemini';
    })(),
    stt: process.env.STT_PROVIDER || 'mock',
    tts: process.env.TTS_PROVIDER || 'mock',
    embedding: process.env.EMBEDDING_PROVIDER || 'transformers',
  },
  logging: {
    dir: process.env.LOG_DIR || LOGS_DIR,
    level: process.env.LOG_LEVEL || 'info',
    logStatic: process.env.LOG_STATIC === 'true',
  },
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
};
