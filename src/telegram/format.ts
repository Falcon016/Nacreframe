/**
 * Model replies are Markdown; Telegram understands a small HTML subset. Convert the common parts (code blocks,
 * inline code, bold, italic, links, headings, lists, quotes, tables) and escape everything else, then split into
 * messages under Telegram's size limit without cutting a code block in half.
 */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

/** Inline Markdown on one escaped line. Code spans are protected from the other rules. */
function inline(line: string): string {
  const codes: string[] = [];
  let out = line.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, t: string, u: string) => `<a href="${escapeAttr(u.replace(/&amp;/g, '&'))}">${t}</a>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

/** Convert one Markdown text (already small enough for a message) to Telegram HTML. */
export function toTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const lang = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Tables keep their columns in a monospaced block.
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) rows.push(lines[i]!.trim());
        i++;
      }
      i--;
      out.push(`<pre>${escapeHtml(rows.join('\n'))}</pre>`);
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<b>${inline(h[1]!)}</b>`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const q: string[] = [inline(quote[1]!)];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!))
        q.push(inline(lines[++i]!.replace(/^\s*>\s?/, '')));
      out.push(`<blockquote>${q.join('\n')}</blockquote>`);
      continue;
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) {
      out.push(`${li[1]!}• ${inline(li[2]!)}`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────');
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/**
 * Split Markdown into parts of at most `max` characters, at line breaks. A code block that has to be split is
 * closed at the end of one part and reopened (same language) at the start of the next.
 */
export function splitMarkdown(md: string, max = 3500): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let size = 0;
  let open: string | undefined; // the fence line of a code block still open in `cur`
  const flush = () => {
    if (!cur.length) return;
    if (open !== undefined) cur.push('```');
    parts.push(cur.join('\n'));
    cur = open !== undefined ? [open] : [];
    size = cur.reduce((n, l) => n + l.length + 1, 0);
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    // A single line longer than a whole part is cut into pieces.
    const pieces = raw.length > max - 20 ? (raw.match(new RegExp(`[^]{1,${max - 20}}`, 'g')) ?? ['']) : [raw];
    for (const line of pieces) {
      if (size + line.length + 1 + (open !== undefined ? 4 : 0) > max) flush();
      cur.push(line);
      size += line.length + 1;
      if (/^\s*```/.test(line)) open = open === undefined ? line : undefined;
    }
  }
  if (cur.length && cur.some((l) => l.trim()) && !(open !== undefined && cur.length === 1)) {
    parts.push(cur.join('\n'));
  }
  return parts.filter((p) => p.trim());
}
