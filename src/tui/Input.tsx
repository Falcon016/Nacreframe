import { Box, Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import { useTheme } from './context.js';
import { GLYPH } from './theme.js';

export interface CommandHint {
  name: string;
  description: string;
}

interface Props {
  isActive: boolean;
  busy: boolean;
  commands: CommandHint[];
  history: string[];
  onSubmit(text: string): void;
  onCycleMode(): void;
  /** Ctrl+T: show or hide agents' reasoning. */
  onToggleThinking?(): void;
  /** Esc / Ctrl+C with an empty buffer. */
  onInterrupt(kind: 'esc' | 'ctrl-c'): void;
  placeholder?: string;
}

interface Buf {
  value: string;
  cursor: number;
}

const clean = (s: string) =>
  s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

function wordLeft(v: string, c: number): number {
  let i = c;
  while (i > 0 && /\s/.test(v[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
  return i;
}
function wordRight(v: string, c: number): number {
  let i = c;
  while (i < v.length && /\s/.test(v[i]!)) i++;
  while (i < v.length && !/\s/.test(v[i]!)) i++;
  return i;
}

export function matchCommands(value: string, commands: CommandHint[]): CommandHint[] {
  if (!value.startsWith('/') || /\s/.test(value)) return [];
  const q = value.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(q)).slice(0, 7);
}

export function Input({
  isActive,
  busy,
  commands,
  history,
  onSubmit,
  onCycleMode,
  onToggleThinking,
  onInterrupt,
  placeholder,
}: Props) {
  const t = useTheme();
  const [buf, setBuf] = useState<Buf>({ value: '', cursor: 0 });
  const [sel, setSel] = useState(0);
  const [hist, setHist] = useState<{ idx: number; draft: string }>({ idx: -1, draft: '' });

  const menu = matchCommands(buf.value, commands);
  const menuOpen = menu.length > 0;
  const selected = menu[Math.min(sel, menu.length - 1)];

  const edit = (fn: (b: Buf) => Buf) => {
    setBuf(fn);
    setSel(0);
    setHist((h) => (h.idx === -1 ? h : { idx: -1, draft: '' }));
  };
  const insert = (text: string) =>
    edit((b) => ({
      value: b.value.slice(0, b.cursor) + text + b.value.slice(b.cursor),
      cursor: b.cursor + text.length,
    }));

  usePaste(
    (text) => {
      const c = clean(text);
      if (c) insert(c);
    },
    { isActive },
  );

  useInput(
    (input, key) => {
      if (key.tab && key.shift) return onCycleMode();
      if (key.ctrl && input === 't') return onToggleThinking?.();
      if (key.ctrl && input === 'c') {
        if (buf.value) return edit(() => ({ value: '', cursor: 0 }));
        return onInterrupt('ctrl-c');
      }
      if (key.escape) {
        if (buf.value && !busy) return edit(() => ({ value: '', cursor: 0 }));
        return onInterrupt('esc');
      }
      if (key.return) {
        if (key.meta || key.shift) return insert('\n');
        if (buf.value.endsWith('\\'))
          return edit((b) => ({ value: b.value.slice(0, -1) + '\n', cursor: b.cursor }));
        if (menuOpen && selected && buf.value !== '/' + selected.name) {
          return edit(() => ({ value: `/${selected.name} `, cursor: selected.name.length + 2 }));
        }
        const text = buf.value.trim();
        if (!text) return;
        onSubmit(text);
        setBuf({ value: '', cursor: 0 });
        setHist({ idx: -1, draft: '' });
        return;
      }
      if (key.tab) {
        if (menuOpen && selected)
          edit(() => ({ value: `/${selected.name} `, cursor: selected.name.length + 2 }));
        return;
      }
      if (key.ctrl && input === 'j') return insert('\n');

      if (key.upArrow || key.downArrow) {
        if (menuOpen) return setSel((s) => (s + (key.downArrow ? 1 : menu.length - 1)) % menu.length);
        const onFirst = !buf.value.slice(0, buf.cursor).includes('\n');
        const onLast = !buf.value.slice(buf.cursor).includes('\n');
        if (key.upArrow && onFirst && history.length) {
          const idx = Math.min(history.length - 1, hist.idx + 1);
          const draft = hist.idx === -1 ? buf.value : hist.draft;
          const v = history[history.length - 1 - idx]!;
          setHist({ idx, draft });
          setBuf({ value: v, cursor: v.length });
        } else if (key.downArrow && onLast && hist.idx >= 0) {
          const idx = hist.idx - 1;
          const v = idx === -1 ? hist.draft : history[history.length - 1 - idx]!;
          setHist({ idx, draft: hist.draft });
          setBuf({ value: v, cursor: v.length });
        }
        return;
      }
      if (key.leftArrow)
        return setBuf((b) => ({
          ...b,
          cursor: key.ctrl || key.meta ? wordLeft(b.value, b.cursor) : Math.max(0, b.cursor - 1),
        }));
      if (key.rightArrow)
        return setBuf((b) => ({
          ...b,
          cursor:
            key.ctrl || key.meta ? wordRight(b.value, b.cursor) : Math.min(b.value.length, b.cursor + 1),
        }));
      if (key.home || (key.ctrl && input === 'a'))
        return setBuf((b) => ({ ...b, cursor: b.value.lastIndexOf('\n', b.cursor - 1) + 1 }));
      if (key.end || (key.ctrl && input === 'e')) {
        return setBuf((b) => {
          const n = b.value.indexOf('\n', b.cursor);
          return { ...b, cursor: n === -1 ? b.value.length : n };
        });
      }
      if (key.backspace)
        return edit((b) =>
          b.cursor
            ? { value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), cursor: b.cursor - 1 }
            : b,
        );
      if (key.delete)
        return edit((b) => ({ ...b, value: b.value.slice(0, b.cursor) + b.value.slice(b.cursor + 1) }));
      if (key.ctrl && input === 'w') {
        return edit((b) => {
          const s = wordLeft(b.value, b.cursor);
          return { value: b.value.slice(0, s) + b.value.slice(b.cursor), cursor: s };
        });
      }
      if (key.ctrl && input === 'u') {
        return edit((b) => {
          const s = b.value.lastIndexOf('\n', b.cursor - 1) + 1;
          return { value: b.value.slice(0, s) + b.value.slice(b.cursor), cursor: s };
        });
      }
      if (key.ctrl && input === 'k') {
        return edit((b) => {
          const n = b.value.indexOf('\n', b.cursor);
          return { ...b, value: b.value.slice(0, b.cursor) + (n === -1 ? '' : b.value.slice(n)) };
        });
      }
      if (key.ctrl || key.meta) return;
      const c = clean(input);
      if (c) insert(c);
    },
    { isActive },
  );

  const lines = buf.value.split('\n');
  let remaining = buf.cursor;
  const rendered = lines.map((line, i) => {
    const here = remaining <= line.length && remaining >= 0;
    const col = remaining;
    remaining -= line.length + 1;
    if (!here || !isActive) return <Text key={i}>{line || ' '}</Text>;
    const ch = line[col] ?? ' ';
    return (
      <Text key={i}>
        {line.slice(0, col)}
        <Text inverse>{ch}</Text>
        {line.slice(col + 1)}
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={isActive ? (busy ? t.faint : t.accent) : t.faint} paddingX={1}>
        <Box marginRight={1}>
          <Text color={busy ? t.faint : t.accent}>{GLYPH.user}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {buf.value ? (
            rendered
          ) : (
            <Text color={t.faint}>{isActive ? (placeholder ?? 'Ask anything…') : ''}</Text>
          )}
        </Box>
      </Box>
      {menuOpen ? (
        <Box flexDirection="column" paddingX={2}>
          {menu.map((c, i) => (
            <Text key={c.name} color={i === Math.min(sel, menu.length - 1) ? t.accent : t.dim}>
              {i === Math.min(sel, menu.length - 1) ? '› ' : '  '}/{c.name.padEnd(10)}{' '}
              <Text color={t.faint}>{c.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
