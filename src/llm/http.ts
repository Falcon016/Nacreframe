import { ProviderError } from './types.js';

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | undefined;
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST JSON with retry/backoff on 408/429/5xx and transient network errors (before any bytes are consumed). */
export async function postJsonStream(opts: PostOptions): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepDefault;
  const max = opts.maxRetries ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      const res = await f(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      const retryAfter = Number(res.headers.get('retry-after'));
      const err = new ProviderError(
        `HTTP ${res.status}: ${extractMessage(text) || res.statusText}`,
        res.status,
        retryable,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
      if (!retryable || attempt >= max) throw err;
      await sleep(err.retryAfterMs ?? backoff(attempt));
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (e instanceof ProviderError) {
        if (!e.retryable || attempt >= max) throw e;
      } else if (attempt >= max) {
        throw new ProviderError(`Network error: ${(e as Error).message}`, undefined, true);
      } else {
        await sleep(backoff(attempt));
      }
    }
    attempt++;
  }
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'string') return j.error;
    return j.error?.message ?? j.message ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}
