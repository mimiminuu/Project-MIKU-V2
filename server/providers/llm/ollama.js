import { LLMProvider } from './index.js';
import { fetchStream, iterLines } from './streamUtils.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

export class OllamaLLMProvider extends LLMProvider {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    model = 'qwen3:14b',
    think = process.env.OLLAMA_THINK !== 'false',
    idleTimeoutMs = 180000,
  } = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace('://localhost:', '://127.0.0.1:');
    this.model = model;
    this.think = think;
    this.idleTimeoutMs = idleTimeoutMs;
    this._initialized = false;
  }

  setThink(think) {
    this.think = Boolean(think);
  }

  async init() {
    if (this._initialized) return;
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`올라마 서버 연결 실패 (${res.status}): ${this.baseUrl}`);
    const data = await res.json();
    const names = data.models?.map((m) => m.name) ?? [];
    if (!names.some((n) => n.startsWith(this.model))) {
      console.warn(`[ollama] 모델 "${this.model}" 이(가) 설치되어 있지 않습니다. 사용 가능: ${names.join(', ')}`);
    }
    this._initialized = true;
    console.log(`[ollama] 연결 성공 – 모델: ${this.model} (${this.baseUrl})`);
  }

  async *streamChat({ messages, tools, signal }) {
    const formattedMessages = (messages || []).map((m) => {
      if (m.images && Array.isArray(m.images) && m.images.length > 0) {
        const rawB64List = m.images.map((img) => (typeof img === 'string' ? img : img.base64)).filter(Boolean);
        return {
          ...m,
          images: rawB64List,
        };
      }
      return m;
    });

    const useNativeTools = Boolean(process.env.OLLAMA_USE_NATIVE_TOOLS === 'true');
    const makePayload = (withTools) => {
      const p = {
        model: this.model,
        messages: formattedMessages,
        stream: true,
        think: this.think,
        keep_alive: '10m',
        options: {
          num_ctx: parseInt(process.env.OLLAMA_NUM_CTX || '12288', 10),
          num_predict: parseInt(process.env.OLLAMA_NUM_PREDICT || '4096', 10),
        },
      };
      // Bonsai 모델은 프롬프트 기반의 [TOOL:...] 태그를 직접 생성하므로,
      // Ollama 네이티브 tools 인자를 전달하면 불필요한 2,500토큰 이상의 도구 스키마가 프롬프트에 자동 주입되어
      // 27B 모델의 프리필(TTFT) 지연시간이 10초 이상 급증합니다.
      if (withTools && useNativeTools && tools?.length) {
        p.tools = tools;
      }
      return p;
    };

    const requestInit = (withTools) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload(withTools)),
    });
    const fetchOpts = { signal, headerTimeoutMs: this.idleTimeoutMs, label: 'Ollama' };

    let res = await fetchStream(`${this.baseUrl}/api/chat`, requestInit(Boolean(tools?.length)), fetchOpts);

    // 모델이나 Ollama 버전이 tools 인자를 지원하지 않아 실패한 경우 tools 제외 후 폴백 재시도
    if (!res.ok && tools?.length) {
      try { await res.body?.cancel(); } catch {}
      res = await fetchStream(`${this.baseUrl}/api/chat`, requestInit(false), fetchOpts);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`올라마 API 오류 (${res.status}): ${body}`);
    }

    const idle = { signal, idleTimeoutMs: this.idleTimeoutMs, label: 'Ollama' };
    for await (const lines of iterLines(res.body, idle)) {
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.thinking && this.think) {
            yield { thinking: obj.message.thinking, token: '' };
          }
          if (obj.message?.tool_calls?.length) {
            yield { tool_calls: obj.message.tool_calls };
          }
          if (obj.message?.content) {
            yield { token: obj.message.content };
          }
          if (obj.eval_count !== undefined || obj.prompt_eval_count !== undefined) {
            yield {
              usage: {
                prompt_tokens: obj.prompt_eval_count || 0,
                completion_tokens: obj.eval_count || 0,
                total_tokens: (obj.prompt_eval_count || 0) + (obj.eval_count || 0),
              },
              total_duration_ms: obj.total_duration ? Math.round(obj.total_duration / 1e6) : undefined,
            };
          }
        } catch {
          // JSON 파싱 실패 줄 무시
        }
      }
    }
  }
}

export async function loadRealProvider() {
  const model = process.env.OLLAMA_MODEL || 'qwen3:14b';
  const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  const provider = new OllamaLLMProvider({ baseUrl, model });
  await provider.init();
  return provider;
}
