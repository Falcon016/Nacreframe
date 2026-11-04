/** Keep the head and tail of long text, marking the elided middle. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 40);
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${dropped} characters truncated] …\n${text.slice(text.length - tail)}`;
}

/** Keep only the last `maxChars` characters (good for command output). */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[… ${text.length - maxChars} earlier characters truncated …]\n${text.slice(text.length - maxChars)}`;
}

export function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Conservative token estimate (3.5 chars per token errs high for prose and is close for code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A token count as people write it: `131072`, `131,072`, `128k` (×1024, as context sizes are usually given),
 * `1m`. Undefined when it is not one.
 */
export function parseTokenCount(text: string): number | undefined {
  const m = /^(\d+(?:[.,_]\d+)*)\s*([km])?$/i.exec(text.trim());
  if (!m) return undefined;
  const unit = m[2]?.toLowerCase();
  const num = unit ? Number(m[1]!.replace(/,/g, '.').replace(/_/g, '')) : Number(m[1]!.replace(/[,_]/g, ''));
  if (!Number.isFinite(num)) return undefined;
  const n = Math.round(num * (unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1));
  return n > 0 ? n : undefined;
}
