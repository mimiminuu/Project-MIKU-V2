import { LLMProvider } from './index.js';
import { iterLines, fetchStream } from './streamUtils.js';

export class OpenAILLMProvider extends LLMProvider {
  constructor() {
    super();
    this.apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }
  async init() {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY가 비어 있습니다. .env를 확인하세요.');
    console.log(`[openai] 모델 설정: ${this.model}`);
  }
  async *streamChat({ messages, tools, signal } = {}) {
    const mapped = messages.map((m) => {
      if (!m.images?.length) return { role: m.role, content: m.content };
      const parts = [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];
      for (const img of m.images) {
        const base64 = typeof img === 'string' ? img : img.base64;
        const mime = typeof img === 'object' ? (img.mimeType || 'image/jpeg') : 'image/jpeg';
        const url = base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
      return { role: m.role, content: parts };
    });
    const payload = { model: this.model, messages: mapped, stream: true, stream_options: { include_usage: true } };
    // Tool actions are handled by Project-MIKU's existing text-tag parser.
    const res = await fetchStream(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
    }, { signal, headerTimeoutMs: 120000, label: 'OpenAI' });
    if (!res.ok) throw new Error(`OpenAI API 오류 (${res.status}): ${(await res.text().catch(() => '')).slice(0, 600)}`);
    for await (const lines of iterLines(res.body, { signal, idleTimeoutMs: 120000, label: 'OpenAI' })) {
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data: ')) continue;
        if (t === 'data: [DONE]') return;
        try {
          const obj = JSON.parse(t.slice(6));
          if (obj.usage) yield { usage: obj.usage };
          const delta = obj.choices?.[0]?.delta;
          if (delta?.content) yield { token: delta.content };
        } catch { /* ignore malformed SSE fragments */ }
      }
    }
  }
}
export async function loadRealProvider() {
  const p = new OpenAILLMProvider();
  await p.init();
  return p;
}
