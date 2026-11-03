import { parseSse } from '../util/sse.js';
import { postJsonStream } from './http.js';
import type {
  ContentBlock,
  Message,
  ModelInfo,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
} from './types.js';
import { ProviderError } from './types.js';

export interface AnthropicOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const VERSION = '2023-06-01';

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly keepsThinking = true; // signed thinking blocks are sent back within a tool loop
  private baseUrl: string;

  constructor(private opts: AnthropicOptions) {
    this.id = opts.id ?? 'anthropic';
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const res = await postJsonStream({
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.opts.apiKey, 'anthropic-version': VERSION },
      body: buildBody(req),
      signal: req.signal,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
    if (!res.body) throw new ProviderError('Empty response body');

    const blocks = new Map<number, { kind: 'text' | 'tool' | 'thinking'; id?: string }>();
    let stop: StopReason = 'other';
    for await (const sse of parseSse(res.body, req.signal)) {
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(sse.data) as AnthropicEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          yield { type: 'usage', usage: usageOf(ev.message?.usage) };
          break;
        case 'content_block_start': {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use') {
            blocks.set(ev.index, { kind: 'tool', id: cb.id });
            yield { type: 'tool_call_start', id: cb.id, name: cb.name };
          } else if (cb?.type === 'thinking') blocks.set(ev.index, { kind: 'thinking' });
          else blocks.set(ev.index, { kind: 'text' });
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          const b = blocks.get(ev.index);
          if (d?.type === 'text_delta') yield { type: 'text', delta: d.text };
          else if (d?.type === 'thinking_delta') yield { type: 'thinking', delta: d.thinking };
          else if (d?.type === 'signature_delta') yield { type: 'signature', signature: d.signature };
          else if (d?.type === 'input_json_delta' && b?.id) {
            yield { type: 'tool_call_delta', id: b.id, json: d.partial_json };
          }
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stop = mapStop(ev.delta.stop_reason);
          if (ev.usage) yield { type: 'usage', usage: usageOf(ev.usage) };
          break;
        case 'error':
          throw new ProviderError(
            ev.error?.message ?? 'stream error',
            undefined,
            ev.error?.type === 'overloaded_error',
          );
        default:
          break;
      }
    }
    yield { type: 'done', stopReason: stop };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.baseUrl}/v1/models?limit=100`, {
      headers: { 'x-api-key': this.opts.apiKey, 'anthropic-version': VERSION },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status);
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id }));
  }
}

export function buildBody(req: StreamRequest): Record<string, unknown> {
  const messages = req.messages.map(toWire);
  // Prompt caching: mark the final block of the last message so the whole prefix is cacheable.
  const last = messages.at(-1);
  const lastBlock = last?.content.at(-1);
  if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };

  const tools = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 32_000, // required by the API
    stream: true,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages,
    ...(tools.length ? { tools } : {}),
  };
  if (req.thinkingBudget && req.thinkingBudget >= 1024) {
    body.thinking = { type: 'enabled', budget_tokens: req.thinkingBudget };
  } else if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

interface WireBlock {
  type: string;
  cache_control?: unknown;
  [k: string]: unknown;
}
interface WireMessage {
  role: string;
  content: WireBlock[];
}

function toWire(m: Message): WireMessage {
  return { role: m.role, content: m.content.map(blockToWire).filter((b): b is WireBlock => !!b) };
}

function blockToWire(b: ContentBlock): WireBlock | undefined {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'text', text: b.text } : undefined;
    case 'thinking':
      return b.signature ? { type: 'thinking', thinking: b.text, signature: b.signature } : undefined;
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result': {
      const parts: WireBlock[] = [{ type: 'text', text: b.content || '(no output)' }];
      for (const img of b.images ?? []) {
        parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: parts,
        ...(b.isError ? { is_error: true } : {}),
      };
    }
  }
}

function mapStop(r: string): StopReason {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(u?: AnthropicUsage) {
  if (!u) return {};
  return {
    ...(u.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
    ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: u.cache_creation_input_tokens }
      : {}),
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type AnthropicEvent =
  | { type: 'message_start'; message?: { usage?: AnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block?: { type: string; id: string; name: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta?:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: 'error'; error?: { type?: string; message?: string } }
  | { type: 'content_block_stop' | 'message_stop' | 'ping' };
