import { LLMProvider } from './index.js';

export class GeminiLLMProvider extends LLMProvider {
  constructor() {
    super();
    this.apiKey = process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '';
    this.model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }
  async init() {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY가 없습니다. .env 파일에 발급받은 Gemini API 키를 입력하세요.');
    console.log(`[gemini] 모델: ${this.model}`);
  }
  async *streamChat({ messages = [], signal } = {}) {
    const contents = [];
    const systemParts = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (m.role === 'system' || m.role === 'developer') {
        systemParts.push({ text: String(m.content || '') });
        continue;
      }
      const parts = [];
      if (m.content) parts.push({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      for (const img of m.images || []) {
        const raw = typeof img === 'string' ? img : img.base64;
        const mimeType = (typeof img === 'object' && img.mimeType) || 'image/jpeg';
        if (raw) parts.push({ inlineData: { mimeType, data: raw.replace(/^data:[^,]+,/, '') } });
      }
      if (parts.length) contents.push({ role, parts });
    }
    if (!contents.length) throw new Error('Gemini에 전달할 대화가 없습니다.');
    const body = { contents, generationConfig: { temperature: 0.7 } };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini API 오류 (${res.status}): ${detail.slice(0, 500)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (data.error) throw new Error(`Gemini 오류: ${data.error.message || '알 수 없는 오류'}`);
          for (const part of data.candidates?.[0]?.content?.parts || []) {
            if (part.text && !part.thought) yield { token: part.text };
          }
          if (data.usageMetadata) yield { usage: { prompt_tokens: data.usageMetadata.promptTokenCount || 0, completion_tokens: data.usageMetadata.candidatesTokenCount || 0 } };
        }
      }
    } finally { reader.releaseLock(); }
  }
}
export async function loadRealProvider() {
  const provider = new GeminiLLMProvider();
  await provider.init();
  return provider;
}
