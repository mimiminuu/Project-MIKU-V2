// Provider 팩토리: .env 설정에 따라 실제 구현체를 로드합니다.
// 실제 프로바이더 연결 실패 시 mock으로 자동 폴백하여 서버가 항상 기동되도록 합니다.
import { config } from '../config.js';
import { MockLLMProvider } from './llm/mock.js';
import { MockSTTProvider } from './stt/mock.js';
import { TransformersEmbeddingProvider } from './embedding/transformers.js';

export async function createProviders() {
  const { llm, tts, stt, embedding } = config.providers;

  const providers = {
    llm: null,
    tts: null,
    stt: null,
    embedding: null,
  };

  // --- LLM ---
  if (llm === 'mock') {
    providers.llm = new MockLLMProvider();
  } else {
    try {
      const { loadRealProvider } = await import(`./llm/${llm}.js`);
      if (!loadRealProvider) throw new Error(`알 수 없는 LLM provider: ${llm}`);
      providers.llm = await loadRealProvider();
    } catch (err) {
      if (llm === 'openai' || llm === 'gemini') throw err;
      console.warn(`[providers] LLM(${llm}) 연결 실패, mock으로 폴백:`, err.message);
      providers.llm = new MockLLMProvider();
    }
  }

  // --- 하이브리드 LLM 프로바이더 맵 (gpt: Oxion, bonsai: 온디맨드 로컬, nemotron: Personnya) ---
  providers.llmProviders = {
    gpt: providers.llm,
    bonsai: null,
    nemotron: null,
  };

  // Nemotron 프로바이더 로드
  if (llm === 'nemotron') {
    providers.llmProviders.nemotron = providers.llm;
  } else if (llm === 'mock') {
    providers.llmProviders.nemotron = new MockLLMProvider();
  } else {
    try {
      const { loadRealProvider } = await import('./llm/nemotron.js');
      providers.llmProviders.nemotron = await loadRealProvider();
    } catch (err) {
      console.warn('[providers] Nemotron 프로바이더 로드 실패:', err.message);
      providers.llmProviders.nemotron = providers.llm;
    }
  }

  // Bonsai (Ollama) 프로바이더 로드
  if (llm === 'mock') {
    providers.llmProviders.bonsai = new MockLLMProvider();
  } else {
    try {
      const { OllamaLLMProvider } = await import('./llm/ollama.js');
      providers.llmProviders.bonsai = new OllamaLLMProvider({
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
        model: process.env.OLLAMA_MODEL || 'bonsai-2:27b',
      });
    } catch (err) {
      console.warn('[providers] 로컬 Ollama 프로바이더 로드 실패:', err.message);
      providers.llmProviders.bonsai = providers.llm;
    }
  }

  // TTS 기능은 제거됨. 기존 인터페이스 호출은 안전하게 무시합니다.
  providers.ttsProviders = {};
  providers.tts = null;

  // --- STT ---
  if (stt === 'mock') {
    providers.stt = new MockSTTProvider();
  } else {
    try {
      const mod = await import(`./stt/${stt}.js`);
      const Ctor = mod.Provider || mod.default;
      if (typeof Ctor !== 'function') throw new Error(`STT provider 기본 내보내기 없음: ${stt}`);
      providers.stt = new Ctor();
    } catch (err) {
      console.warn(`[providers] STT(${stt}) 로드 실패, mock으로 폴백:`, err.message);
      providers.stt = new MockSTTProvider();
    }
  }

  // --- Embedding ---
  if (embedding === 'transformers') providers.embedding = new TransformersEmbeddingProvider();

  // 임베딩은 첫 사용 시(lazy) 초기화하여 서버 시작을 빠르게 유지
  // 각 프로바이더 init 실패 시 mock으로 대체하여 서버가 항상 기동되도록 함
  await Promise.all(
    Object.entries(providers)
      .filter(([k, p]) => k !== 'embedding' && k !== 'llmProviders' && k !== 'ttsProviders' && p && typeof p.init === 'function')
      .map(async ([key, p]) => {
        try {
          await p.init?.();
        } catch (err) {
          console.warn(`[providers] ${key} init 실패, mock으로 폴백:`, err.message);
          if (key === 'llm') {
            providers.llm = new MockLLMProvider();
            providers.llmProviders.gpt = providers.llm;

          } else if (key === 'stt') {
            providers.stt = new MockSTTProvider();
          }
        }
      })
  );

  // ttsProviders 내 추가 프로바이더들 초기화
  if (providers.ttsProviders) {
    await Promise.all(
      Object.entries(providers.ttsProviders).map(async ([k, p]) => {
        if (p && p !== providers.tts && typeof p.init === 'function') {
          try {
            await p.init();
          } catch (err) {
            console.warn(`[providers] TTS 프로바이더(${k}) init 경고:`, err.message);
          }
        }
      })
    );
  }

  // 기본 LLM 프로바이더 참조 동기화
  if (llm === 'nemotron') {
    providers.llmProviders.nemotron = providers.llm;
  } else {
    providers.llmProviders.gpt = providers.llm;
  }

  return providers;
}

let runtime = null;
export async function getRuntime() {
  if (!runtime) runtime = await createProviders();
  return runtime;
}

export async function getEmbeddingRuntime() {
  if (!runtime) runtime = await createProviders();
  return runtime;
}
