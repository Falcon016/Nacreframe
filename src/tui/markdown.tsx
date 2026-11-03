import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from './context.js';
import type { Theme } from './theme.js';

/** Inline markdown: `code`, **bold**, *italic*, [text](url). */
export function inline(text: string, t: Theme, base: { color?: string; bold?: boolean } = {}): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last)
      out.push(
        <Text key={k++} {...base}>
          {text.slice(last, m.index)}
        </Text>,
      );
    const s = m[0];
    if (m[1])
      out.push(
        <Text key={k++} color={t.lavender}>
          {s.slice(1, -1)}
        </Text>,
      );
    else if (m[2])
      out.push(
        <Text key={k++} bold {...(base.color ? { color: base.color } : {})}>
          {s.slice(2, -2)}
        </Text>,
      );
    else if (m[3])
      out.push(
        <Text key={k++} italic {...(base.color ? { color: base.color } : {})}>
          {s.slice(1, -1)}
        </Text>,
      );
    else {
      const [, label, url] = /\[([^\]]+)\]\(([^)]+)\)/.exec(s)!;
      out.push(
        <Text key={k++}>
          <Text color={t.blue} underline>
            {label}
          </Text>
          <Text color={t.faint}> ({url})</Text>
        </Text>,
      );
    }
    last = m.index + s.length;
  }
  if (last < text.length)
    out.push(
      <Text key={k++} {...base}>
        {text.slice(last)}
      </Text>,
    );
  return out;
}

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; lines: string[] }
  | { t: 'li'; marker: string; indent: number; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; rows: string[][] }
  | { t: 'blank' };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: 'code', lang: fence[1] ?? '', lines: body });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const rows: string[][] = [];
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      blocks.push({ t: 'table', rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) blocks.push({ t: 'h', level: h[1]!.length, text: h[2]! });
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) blocks.push({ t: 'hr' });
    else {
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li)
        blocks.push({
          t: 'li',
          indent: Math.floor(li[1]!.length / 2),
          marker: /\d/.test(li[2]!) ? li[2]! : '•',
          text: li[3]!,
        });
      else if (/^\s*>\s?/.test(line)) blocks.push({ t: 'quote', text: line.replace(/^\s*>\s?/, '') });
      else if (!line.trim()) blocks.push({ t: 'blank' });
      else blocks.push({ t: 'p', text: line });
    }
  }
  return blocks;
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length));
}

export function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const blocks = parseBlocks(text);
  const nodes: ReactNode[] = [];
  let prevBlank = true;
  blocks.forEach((b, i) => {
    switch (b.t) {
      case 'blank':
        if (!prevBlank) nodes.push(<Text key={i}> </Text>);
        prevBlank = true;
        return;
      case 'h':
        nodes.push(
          <Text key={i} bold color={b.level <= 2 ? t.accent : t.text}>
            {b.level <= 1 ? b.text.toUpperCase() : b.text}
          </Text>,
        );
        break;
      case 'p':
        nodes.push(<Text key={i}>{inline(b.text, t)}</Text>);
        break;
      case 'li':
        nodes.push(
          <Text key={i}>
            {'  '.repeat(b.indent)}
            <Text color={t.accent}>{b.marker}</Text> {inline(b.text, t)}
          </Text>,
        );
        break;
      case 'quote':
        nodes.push(
          <Text key={i} color={t.dim}>
            ▎ {inline(b.text, t, { color: t.dim })}
          </Text>,
        );
        break;
      case 'hr':
        nodes.push(
          <Text key={i} color={t.faint}>
            {'─'.repeat(32)}
          </Text>,
        );
        break;
      case 'code':
        nodes.push(<CodeBlock key={i} lang={b.lang} lines={b.lines} />);
        break;
      case 'table': {
        const widths = b.rows[0]!.map((_, c) => Math.max(...b.rows.map((r) => (r[c] ?? '').length)));
        nodes.push(
          <Box key={i} flexDirection="column">
            {b.rows.map((r, ri) => (
              <Text key={ri} {...(ri === 0 ? { bold: true } : {})}>
                {r.map((c, ci) => pad(c, widths[ci] ?? 0)).join(' │ ')}
              </Text>
            ))}
          </Box>,
        );
        break;
      }
    }
    prevBlank = false;
  });
  return <Box flexDirection="column">{nodes}</Box>;
}

export function CodeBlock({ lang, lines }: { lang: string; lines: string[] }) {
  const t = useTheme();
  const diff = lang === 'diff' || lang === 'patch';
  return (
    <Box flexDirection="column" marginY={0}>
      {lang ? <Text color={t.faint}>{lang}</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} color={diff ? diffColor(l, t) : t.text} wrap="wrap">
          <Text color={t.faint}>│ </Text>
          {l || ' '}
        </Text>
      ))}
    </Box>
  );
}

export function diffColor(line: string, t: Theme): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return t.green;
  if (line.startsWith('-') && !line.startsWith('---')) return t.red;
  if (line.startsWith('@@')) return t.lavender;
  return t.dim;
}

/**
 * The end of `text` that fits in `rows` terminal rows at `width` columns, for the live area: it must stay
 * shorter than the window, or the terminal scrolls part of it into history on every redraw. If the cut falls
 * inside a code block, its opening fence is kept so the rest still renders as code.
 */
export function fitTail(text: string, width: number, rows: number): { text: string; hidden: number } {
  const w = Math.max(10, width);
  const height = (l: string) => Math.max(1, Math.ceil((l.length + 2) / w));
  const lines = text.split('\n');
  let total = 0;
  for (const l of lines) total += height(l);
  if (total <= rows) return { text, hidden: 0 };
  const room = Math.max(1, rows - 1); // one row for the opening fence's label, if the cut is inside a block
  let used = 0;
  let i = lines.length;
  while (i > 0 && used + height(lines[i - 1]!) <= room) used += height(lines[--i]!);
  let kept = lines.slice(i);
  if (!kept.length) {
    // One line longer than the whole space: show its end.
    const last = lines.at(-1)!;
    kept = [last.slice(-Math.max(w, room * w - 4))];
    i = lines.length - 1;
  }
  let fence: string | undefined;
  for (const l of lines.slice(0, i)) if (/^\s*```/.test(l)) fence = fence === undefined ? l : undefined;
  return { text: [...(fence !== undefined ? [fence] : []), ...kept].join('\n'), hidden: i };
}
