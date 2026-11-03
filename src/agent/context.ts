import type { ContentBlock, Message, ToolSpec } from '../llm/types.js';
import { estimateTokens } from '../util/text.js';

/** Compaction always triggers at or before this fraction of the context window. Not configurable above it. */
export const COMPACT_THRESHOLD_MAX = 0.8;
/** Above this fraction a request is never sent: the chat pauses instead. */
export const HARD_LIMIT = 0.95;
/** Minimum head-room (tokens) that must remain for the model's reply. */
export const MIN_REPLY_TOKENS = 256;

export function estimateMessages(messages: Message[], opts: { thinking?: boolean } = {}): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'thinking') chars += opts.thinking === false ? 0 : b.text.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length + 24;
      else if (b.type === 'tool_result') chars += b.content.length + (b.images?.length ?? 0) * 4000 + 24;
      else chars += 4000;
    }
    chars += 16; // role / framing overhead
  }
  return estimateTokens('x'.repeat(chars));
}

export function estimateSpecs(tools: ToolSpec[]): number {
  return estimateTokens(JSON.stringify(tools));
}

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

const interrupted = (id: string): ToolResult => ({
  type: 'tool_result',
  toolUseId: id,
  content: 'Interrupted before this tool produced a result (the session ended or crashed mid-run).',
  isError: true,
});

const toolUses = (m: Message): ToolUse[] =>
  m.role === 'assistant' ? m.content.filter((b): b is ToolUse => b.type === 'tool_use') : [];

/**
 * Make a message list valid for any provider: every tool_use is answered by a tool_result in the very next
 * message, and no tool_result is orphaned. Missing results are synthesised as errors, so a crash between a
 * tool call and its result (or a hand-edited session file) can never poison the next request.
 * Pure: returns a new array and never mutates its input.
 */
export function sanitizeMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      if (!m.content.length) continue;
      out.push(m);
      const uses = toolUses(m);
      if (!uses.length) continue;
      const next = messages[i + 1];
      const have = new Set<string>();
      const kept: ContentBlock[] = [];
      if (next?.role === 'user') {
        for (const b of next.content) {
          if (b.type === 'tool_result') {
            if (uses.some((u) => u.id === b.toolUseId) && !have.has(b.toolUseId)) {
              have.add(b.toolUseId);
              kept.push(b);
            }
          } else kept.push(b);
        }
        i++; // the next message is consumed here
      }
      const missing = uses.filter((u) => !have.has(u.id)).map((u) => interrupted(u.id));
      const results = [...kept.filter((b) => b.type === 'tool_result'), ...missing];
      const rest = kept.filter((b) => b.type !== 'tool_result');
      out.push({ role: 'user', content: [...results, ...rest] });
    } else {
      // A user message here has no preceding tool_use (those were consumed above): strip stray tool_results.
      const content = m.content.filter((b) => b.type !== 'tool_result');
      if (content.length) out.push(content.length === m.content.length ? m : { role: 'user', content });
    }
  }
  return out;
}

/** Ids of tool calls at the end of the conversation that never got a result. */
export function danglingToolUseIds(messages: Message[]): string[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return [];
  return toolUses(last).map((u) => u.id);
}

export function syntheticResults(ids: string[]): Message {
  return { role: 'user', content: ids.map(interrupted) };
}
