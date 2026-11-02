export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a Server-Sent-Events byte stream into events. Tolerates CRLF, multi-line data and comments. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /\r\n\r\n|\n\n|\r\r/.exec(buf);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseBlock(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  return event ? { event, data: data.join('\n') } : { data: data.join('\n') };
}
