import { LLMProvider } from './index.js';
import { fetchStream, iterLines } from './streamUtils.js';

const DEFAULT_BASE_URL = 'https://llm.personnya.dev/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

export class NemotronLLMProvider extends LLMProvider {
  constructor({
    apiKey = process.env.NEMOTRON_API_KEY || '',
    baseUrl = process.env.NEMOTRON_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.NEMOTRON_MODEL || DEFAULT_MODEL,
    think = process.env.NEMOTRON_THINK === 'true',
    idleTimeoutMs = 180000,
  } = {}) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.think = Boolean(think);
    this.idleTimeoutMs = idleTimeoutMs;
    this._initialized = false;
  }

  setThink(think) {
    this.think = Boolean(think);
  }

  async init() {
    if (this._initialized) return;
    if (!this.apiKey) {
      throw new Error('[nemotron] NEMOTRON_API_KEY가 설정되지 않았습니다.');
    }

    // 모델 목록 조회로 연결 및 API 키 유효성 확인
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Nemotron API 연결 실패 (${res.status}): ${this.baseUrl}`);
    }

    const data = await res.json().catch(() => ({}));
    const modelIds = data.data?.map((m) => m.id) ?? [];
    if (modelIds.length && !modelIds.includes(this.model)) {
      console.warn(`[nemotron] 모델 "${this.model}"이 사용 가능한 목록에 없습니다. (목록: ${modelIds.join(', ')})`);
    }

    this._initialized = true;
    console.log(`[nemotron] 연결 성공 – 모델: ${this.model} (${this.baseUrl})`);
  }

  async *streamChat({ messages, tools, signal }) {
    const formattedMessages = messages.map((m) => {
      const role = m.role;

      // Super VL 모델은 멀티모달(비전) 지원
      if (m.images && Array.isArray(m.images) && m.images.length > 0) {
        const contentParts = [
          { type: 'text', text: typeof m.content === 'string' ? m.content : '' },
        ];
        for (const img of m.images) {
          const b64 = typeof img === 'string' ? img : img.base64;
          const mime = (typeof img === 'object' && img.mimeType) || 'image/jpeg';
          const url = b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`;
          contentParts.push({
            type: 'image_url',
            image_url: { url },
          });
        }
        return { role, content: contentParts };
      }

      return role === m.role ? m : { ...m, role };
    });

    const payload = {
      model: this.model,
      messages: formattedMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      reasoning: { enabled: Boolean(this.think) },
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    const res = await fetchStream(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    }, { signal, headerTimeoutMs: this.idleTimeoutMs, label: 'Nemotron' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      try {
        const json = JSON.parse(errText);
        if (json?.error?.message) {
          throw new Error(`Nemotron API 오류 (${res.status}): ${json.error.message}`);
        }
      } catch (parseErr) {
        if (parseErr.message.includes('Nemotron')) throw parseErr;
      }
      throw new Error(`Nemotron API 오류 (${res.status}): ${errText}`);
    }

    const idle = { signal, idleTimeoutMs: this.idleTimeoutMs, label: 'Nemotron' };
    for await (const lines of iterLines(res.body, idle)) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;

        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            if (json.usage) {
              yield {
                usage: {
                  prompt_tokens: json.usage.prompt_tokens || 0,
                  completion_tokens: json.usage.completion_tokens || 0,
                  total_tokens: json.usage.total_tokens || 0,
                },
              };
            }
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;

            const thinking = delta.reasoning || delta.reasoning_content;
            if (thinking && this.think) {
              yield { thinking, token: '' };
            }
            if (delta.tool_calls) {
              yield { tool_call_delta: delta.tool_calls };
            }
            if (delta.content) {
              yield { token: delta.content };
            }
          } catch {
            // 파싱 오류 무시
          }
        }
      }
    }
  }
}

export async function loadRealProvider() {
  const apiKey = process.env.NEMOTRON_API_KEY;
  const baseUrl = process.env.NEMOTRON_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.NEMOTRON_MODEL || DEFAULT_MODEL;
  const think = process.env.NEMOTRON_THINK === 'true';

  const provider = new NemotronLLMProvider({ apiKey, baseUrl, model, think });
  await provider.init();
  return provider;
}
