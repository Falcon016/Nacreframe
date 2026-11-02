import type { ContentBlock, Message, StopReason, StreamEvent, Usage } from './types.js';

export interface Assembled {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  /** Tool calls whose JSON arguments could not be parsed (id -> raw text). */
  badToolCalls: Map<string, string>;
}

export interface AssembleHooks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (id: string, name: string) => void;
}

/** Fold a provider event stream into a single assistant message. */
export async function assemble(
  events: AsyncIterable<StreamEvent>,
  hooks: AssembleHooks = {},
): Promise<Assembled> {
  const blocks: ContentBlock[] = [];
  const toolJson = new Map<string, string>();
  const toolIndex = new Map<string, number>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = 'other';

  const tail = <T extends ContentBlock['type']>(type: T) => {
    const last = blocks.at(-1);
    return last && last.type === type ? (last as Extract<ContentBlock, { type: T }>) : undefined;
  };

  for await (const ev of events) {
    switch (ev.type) {
      case 'text': {
        const t = tail('text');
        if (t) t.text += ev.delta;
        else blocks.push({ type: 'text', text: ev.delta });
        hooks.onText?.(ev.delta);
        break;
      }
      case 'thinking': {
        const t = tail('thinking');
        if (t) t.text += ev.delta;
        else blocks.push({ type: 'thinking', text: ev.delta });
        hooks.onThinking?.(ev.delta);
        break;
      }
      case 'signature': {
        const t = tail('thinking');
        if (t) t.signature = (t.signature ?? '') + ev.signature;
        break;
      }
      case 'tool_call_start':
        toolIndex.set(ev.id, blocks.length);
        toolJson.set(ev.id, '');
        blocks.push({ type: 'tool_use', id: ev.id, name: ev.name, input: {} });
        hooks.onToolStart?.(ev.id, ev.name);
        break;
      case 'tool_call_delta':
        toolJson.set(ev.id, (toolJson.get(ev.id) ?? '') + ev.json);
        break;
      case 'usage':
        if (ev.usage.inputTokens !== undefined) usage.inputTokens = ev.usage.inputTokens;
        if (ev.usage.outputTokens !== undefined) usage.outputTokens = ev.usage.outputTokens;
        if (ev.usage.cacheReadTokens !== undefined) usage.cacheReadTokens = ev.usage.cacheReadTokens;
        if (ev.usage.cacheWriteTokens !== undefined) usage.cacheWriteTokens = ev.usage.cacheWriteTokens;
        break;
      case 'done':
        stopReason = ev.stopReason;
        break;
    }
  }

  const badToolCalls = new Map<string, string>();
  for (const [id, raw] of toolJson) {
    const block = blocks[toolIndex.get(id)!];
    if (!block || block.type !== 'tool_use') continue;
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        block.input = parsed as Record<string, unknown>;
      else badToolCalls.set(id, raw);
    } catch {
      badToolCalls.set(id, raw);
    }
  }
  return { message: { role: 'assistant', content: blocks }, stopReason, usage, badToolCalls };
}
