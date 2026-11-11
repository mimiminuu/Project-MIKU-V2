import { LLMProvider } from './index.js';
import { fetchStream, iterLines } from './streamUtils.js';

const DEFAULT_BASE_URL = 'https://oxionai.com/v1';

export class OxionLLMProvider extends LLMProvider {
  constructor({
    apiKey = process.env.OXION_API_KEY || '',
    baseUrl = process.env.OXION_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.OXION_MODEL || 'gpt-5.6-luna',
    idleTimeoutMs = 180000,
  } = {}) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.think = true;
    this.idleTimeoutMs = idleTimeoutMs;
    this._initialized = false;
  }

  setThink(think) {
    this.think = Boolean(think);
  }

  async init() {
    if (this._initialized) return;
    if (!this.apiKey) {
      throw new Error('[oxion] OXION_API_KEY가 설정되지 않았습니다.');
    }

    // 모델 목록 조회로 연결 및 API 키 유효성 확인
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Oxion API 연결 실패 (${res.status}): ${this.baseUrl}`);
    }

    const data = await res.json().catch(() => ({}));
    const modelIds = data.data?.map((m) => m.id) ?? [];
    if (modelIds.length && !modelIds.includes(this.model)) {
      console.warn(`[oxion] 모델 "${this.model}"이 사용 가능한 목록에 없습니다. (목록: ${modelIds.join(', ')})`);
    }

    this._initialized = true;
    console.log(`[oxion] 연결 성공 – 모델: ${this.model} (${this.baseUrl})`);
  }

  async *streamChat({ messages, tools, signal }) {
    // OpenAI 최신 모델(GPT-5/o계열)은 developer role을 사용해야 페르소나 및 모델명 언급 금지 지침이 우선 적용됨
    const formattedMessages = messages.map((m) => {
      let role = m.role;
      if (role === 'system') role = 'developer';

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
    }, { signal, headerTimeoutMs: this.idleTimeoutMs, label: 'Oxion' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      try {
        const json = JSON.parse(errText);
        if (json?.error?.code === 'service_upgrading' || res.status === 503) {
          throw new Error('Oxion AI 서버가 현재 정기 점검/업그레이드 중입니다. 몇 분 내로 정상화될 예정이니 잠시 후 다시 시도해 주세요.');
        }
        if (json?.error?.message) {
          throw new Error(`Oxion API 오류 (${res.status}): ${json.error.message}`);
        }
      } catch (parseErr) {
        if (parseErr.message.includes('Oxion')) throw parseErr;
      }
      throw new Error(`Oxion API 오류 (${res.status}): ${errText}`);
    }

    const idle = { signal, idleTimeoutMs: this.idleTimeoutMs, label: 'Oxion' };
    for await (const lines of iterLines(res.body, idle)) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return; // 정상 종료 시 즉시 제너레이터 반환하여 대기 차단

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

            const thinking = delta.reasoning_content || delta.reasoning;
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
  const apiKey = process.env.OXION_API_KEY;
  const baseUrl = process.env.OXION_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.OXION_MODEL || 'gpt-5.6-luna';

  const provider = new OxionLLMProvider({ apiKey, baseUrl, model });
  await provider.init();
  return provider;
}
