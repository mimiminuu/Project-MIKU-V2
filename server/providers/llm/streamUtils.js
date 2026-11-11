// LLM 스트리밍 공통 처리: 응답 헤더 대기 상한, 줄 단위 읽기, 무응답(idle) 상한, 취소 전파.
export class LlmIdleTimeoutError extends Error {
  constructor(idleTimeoutMs, label = 'LLM') {
    super(`${label} 응답이 ${Math.round(idleTimeoutMs / 1000)}초 동안 없어서 중단했습니다.`);
    this.name = 'LlmIdleTimeoutError';
    this.code = 'LLM_IDLE_TIMEOUT';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export function createAbortError(message = '요청이 취소되었습니다.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * 응답 헤더를 기다리는 시간만 제한한다. 헤더가 오면 타이머를 지우므로
 * 스트리밍 본문은 iterLines의 idleTimeoutMs 기준으로만 감시된다.
 */
export async function fetchStream(url, options, { signal, headerTimeoutMs = 180000, label = 'LLM' } = {}) {
  if (signal?.aborted) throw createAbortError();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new LlmIdleTimeoutError(headerTimeoutMs, label));
  }, headerTimeoutMs);
  timer.unref?.();

  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.reason instanceof LlmIdleTimeoutError) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 본문을 줄 단위로 yield한다. 각 read()가 idleTimeoutMs를 넘기면 LlmIdleTimeoutError를 던지고
 * reader를 취소해 연결을 정리한다. 외부 signal이 끊기면 진행 중인 read도 즉시 깨어난다.
 */
export async function* iterLines(body, { signal, idleTimeoutMs = 180000, label = 'LLM' } = {}) {
  if (!body) throw new Error(`${label} 응답 본문이 없습니다.`);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const cancelReader = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };

  if (signal?.aborted) {
    cancelReader();
    throw createAbortError();
  }
  signal?.addEventListener?.('abort', cancelReader, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw createAbortError();

      let timer = null;
      const read = reader.read();
      read.catch(() => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new LlmIdleTimeoutError(idleTimeoutMs, label));
        }, idleTimeoutMs);
        timer.unref?.();
      });

      let result;
      try {
        result = await Promise.race([read, timeout]);
      } finally {
        clearTimeout(timer);
      }

      if (signal?.aborted) throw createAbortError();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.length) yield lines;
    }
    if (buffer.trim()) yield [buffer];
  } finally {
    signal?.removeEventListener?.('abort', cancelReader);
    cancelReader();
  }
}
