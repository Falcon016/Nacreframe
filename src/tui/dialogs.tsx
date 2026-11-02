import { Box, Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../agent/agent.js';
import { agentColor, useTheme } from './context.js';
import { diffColor } from './markdown.js';
import { GLYPH } from './theme.js';

/** One-line text prompt used for feedback and free-form answers. */
function LineInput({
  label,
  onSubmit,
  onCancel,
}: {
  label: string;
  onSubmit(v: string): void;
  onCancel(): void;
}) {
  const t = useTheme();
  const [v, setV] = useState('');
  usePaste((s) => setV((x) => x + s.replace(/\s+/g, ' ')));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(v.trim());
    if (key.backspace || key.delete) return setV((x) => x.slice(0, -1));
    if (key.ctrl && input === 'u') return setV('');
    if (!key.ctrl && !key.meta && !key.tab && input) setV((x) => x + input);
  });
  return (
    <Box>
      <Text color={t.accent}>{label} </Text>
      <Text>{v}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export function SelectList<T>({
  title,
  items,
  onSelect,
  onCancel,
  initial = 0,
}: {
  title: string;
  items: Choice<T>[];
  onSelect(v: T): void;
  onCancel(): void;
  initial?: number;
}) {
  const t = useTheme();
  const [i, setI] = useState(Math.min(initial, Math.max(0, items.length - 1)));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setI((x) => (x + items.length - 1) % items.length);
    if (key.downArrow) return setI((x) => (x + 1) % items.length);
    if (key.return && items[i]) return onSelect(items[i]!.value);
    if (/^[1-9]$/.test(input) && items[Number(input) - 1]) onSelect(items[Number(input) - 1]!.value);
  });
  const win = 10;
  const start = Math.max(0, Math.min(i - 4, items.length - win));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.lavender} paddingX={1}>
      <Text bold color={t.lavender}>
        {title}
      </Text>
      {items.length === 0 ? <Text color={t.dim}>Nothing to show.</Text> : null}
      {items.slice(start, start + win).map((it, k) => {
        const idx = start + k;
        const on = idx === i;
        return (
          <Text key={idx} color={on ? t.accent : t.text}>
            {on ? '› ' : '  '}
            {it.label}
            {it.hint ? <Text color={t.faint}> {it.hint}</Text> : null}
          </Text>
        );
      })}
      <Text color={t.faint}>↑↓ move · enter select · esc cancel</Text>
    </Box>
  );
}

export function ApprovalDialog({
  req,
  pending,
  onResolve,
}: {
  req: ApprovalRequest;
  pending: number;
  onResolve(r: ApprovalResponse): void;
}) {
  const t = useTheme();
  const [i, setI] = useState(0);
  const [feedback, setFeedback] = useState(false);
  const options = [
    { label: 'Yes', hint: 'run it once', r: { allow: true } as ApprovalResponse },
    {
      label: `Yes, and don't ask again for ${req.grantLabel}`,
      hint: 'this session',
      r: { allow: true, always: true } as ApprovalResponse,
    },
    { label: 'No', hint: '', r: { allow: false } as ApprovalResponse },
    { label: 'No, and tell it what to do instead', hint: '', r: undefined },
  ];
  useInput(
    (input, key) => {
      if (key.escape) return onResolve({ allow: false });
      if (key.upArrow) return setI((x) => (x + options.length - 1) % options.length);
      if (key.downArrow || key.tab) return setI((x) => (x + 1) % options.length);
      const pick = (n: number) => {
        const o = options[n]!;
        if (o.r) onResolve(o.r);
        else setFeedback(true);
      };
      if (key.return) return pick(i);
      if (input === 'y') return pick(0);
      if (input === 'a') return pick(1);
      if (input === 'n') return pick(2);
      if (/^[1-4]$/.test(input)) pick(Number(input) - 1);
    },
    { isActive: !feedback },
  );

  const color = agentColor(t, req.agentId);
  const previewLines = req.preview ? req.preview.split('\n') : [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.gold} paddingX={1}>
      <Text>
        <Text bold color={t.gold}>
          {GLYPH.brand} Approve this action?
        </Text>
        {req.agentId !== 'main' ? <Text color={color}> · {req.agentId}</Text> : null}
        {pending > 1 ? <Text color={t.faint}> · {pending - 1} more waiting</Text> : null}
      </Text>
      <Text>
        <Text bold>{req.toolName}</Text> <Text color={t.text}>{req.description}</Text>
      </Text>
      <Text color={t.dim}>{req.reason}</Text>
      {previewLines.length ? (
        <Box flexDirection="column" marginTop={1}>
          {previewLines.slice(0, 18).map((l, k) => (
            <Text key={k} color={diffColor(l, t)} wrap="truncate-end">
              {l || ' '}
            </Text>
          ))}
          {previewLines.length > 18 ? (
            <Text color={t.faint}>… +{previewLines.length - 18} more lines</Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {feedback ? (
          <LineInput
            label="Tell it what to do:"
            onSubmit={(v) => onResolve({ allow: false, ...(v ? { feedback: v } : {}) })}
            onCancel={() => setFeedback(false)}
          />
        ) : (
          options.map((o, k) => (
            <Text key={k} color={k === i ? t.accent : t.text}>
              {k === i ? '› ' : '  '}
              {k + 1}. {o.label}
            </Text>
          ))
        )}
      </Box>
      {feedback ? null : <Text color={t.faint}>y yes · a always · n no · esc deny</Text>}
    </Box>
  );
}

export function QuestionDialog({
  agent,
  question,
  options,
  onAnswer,
}: {
  agent: string;
  question: string;
  options?: string[];
  onAnswer(a: string): void;
}) {
  const t = useTheme();
  const [typing, setTyping] = useState(!options?.length);
  const color = agentColor(t, agent);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.teal} paddingX={1}>
      <Text>
        <Text bold color={t.teal}>
          ◆ Question
        </Text>
        {agent !== 'main' ? <Text color={color}> · {agent}</Text> : null}
      </Text>
      <Text>{question}</Text>
      <Box marginTop={1} flexDirection="column">
        {typing ? (
          <LineInput
            label="❯"
            onSubmit={(v) => onAnswer(v || '(no answer)')}
            onCancel={() => (options?.length ? setTyping(false) : onAnswer('(skipped)'))}
          />
        ) : (
          <SelectList<string | null>
            title="Choose"
            items={[
              ...(options ?? []).map((o) => ({ label: o, value: o as string | null })),
              { label: 'Type my own answer…', value: null },
            ]}
            onSelect={(v) => (v === null ? setTyping(true) : onAnswer(v))}
            onCancel={() => onAnswer('(skipped)')}
          />
        )}
      </Box>
    </Box>
  );
}
