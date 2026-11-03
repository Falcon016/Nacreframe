import { newId } from '../util/id.js';
import { parseSse } from '../util/sse.js';
import { postJsonStream } from './http.js';
import type { Message, ModelInfo, Provider, StopReason, StreamEvent, StreamRequest } from './types.js';
import { ProviderError } from './types.js';

export interface OpenAIOptions {
  id: string;
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
}

/** Any OpenAI-compatible /chat/completions endpoint: OpenAI, Ollama, LM Studio, Unsloth Studio, vLLM, OpenRouter... */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  private baseUrl: string;

  constructor(private opts: OpenAIOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const res = await postJsonStream({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers(),
      body: buildBody(req),
      signal: req.signal,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
    if (!res.body) throw new ProviderError('Empty response body');

    // OpenAI streams tool calls by index; map index -> our stable id.
    const calls = new Map<number, { id: string; started: boolean; name: string; pending: string }>();
    let stop: StopReason = 'other';
    const think = new ThinkTagSplitter();
    for await (const sse of parseSse(res.body, req.signal)) {
      if (sse.data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(sse.data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(chunk.error.message ?? 'stream error');
      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          },
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta;
      const reasoning = d?.reasoning_content ?? d?.reasoning;
      if (reasoning) yield { type: 'thinking', delta: reasoning };
      // Some local models write their reasoning inline as <think>...</think> instead of a separate field.
      if (d?.content) yield* think.push(d.content);
      for (const tc of d?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let c = calls.get(idx);
        if (!c) {
          c = { id: tc.id || newId('call_'), started: false, name: '', pending: '' };
          calls.set(idx, c);
        }
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.pending += tc.function.arguments;
        if (!c.started && c.name) {
          c.started = true;
          yield { type: 'tool_call_start', id: c.id, name: c.name };
        }
        if (c.started && c.pending) {
          yield { type: 'tool_call_delta', id: c.id, json: c.pending };
          c.pending = '';
        }
      }
      if (choice.finish_reason) stop = mapStop(choice.finish_reason, calls.size > 0);
    }
    yield* think.flush();
    // Some local servers report finish_reason "stop" even when calling tools.
    if (calls.size > 0 && stop !== 'max_tokens') stop = 'tool_use';
    yield { type: 'done', stopReason: stop };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const init = { headers: this.headers(), ...(signal ? { signal } : {}) };
    const res = await f(`${this.baseUrl}/models`, init);
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status);
    const j = (await res.json()) as { data?: RawModel[] };
    const models: ModelInfo[] = (j.data ?? []).map(toModelInfo);

    // Single-model llama.cpp servers report their window on /props instead of per model.
    const origin = this.baseUrl.replace(/\/v1$/, '');
    if (models.some((m) => !m.contextWindow)) {
      const n = await getJson<{ default_generation_settings?: { n_ctx?: number } }>(
        f,
        `${origin}/props`,
        init,
      );
      const nctx = n?.default_generation_settings?.n_ctx;
      if (nctx && nctx > 0) for (const m of models) m.contextWindow ??= nctx;
    }
    // Ollama reports the context of models currently loaded.
    if (models.some((m) => !m.contextWindow)) {
      const ps = await getJson<{ models?: { name?: string; model?: string; context_length?: number }[] }>(
        f,
        `${origin}/api/ps`,
        init,
      );
      for (const p of ps?.models ?? []) {
        const hit = models.find((m) => m.id === p.name || m.id === p.model);
        if (hit && p.context_length) hit.contextWindow ??= p.context_length;
      }
    }
    return models;
  }
}

interface RawModel {
  id: string;
  aliases?: string[];
  loaded_context_length?: number;
  max_context_length?: number;
  state?: string;
  status?: { value?: string; args?: string[]; preset?: string };
  meta?: { n_ctx?: number };
}

async function getJson<T>(f: typeof fetch, url: string, init: RequestInit): Promise<T | undefined> {
  try {
    const res = await f(url, init);
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** The context size a server was *started with*: llama.cpp router args, LM Studio, or `meta.n_ctx`. */
export function contextFromArgs(args: string[] | undefined, preset: string | undefined): number | undefined {
  if (args) {
    for (let i = 0; i < args.length - 1; i++) {
      if (['--ctx-size', '-c', '--ctx_size'].includes(args[i]!)) {
        const n = Number(args[i + 1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  const m = preset ? /^ctx-size\s*=\s*(\d+)/m.exec(preset) : null;
  return m ? Number(m[1]) : undefined;
}

function toModelInfo(m: RawModel): ModelInfo {
  const ctx = contextFromArgs(m.status?.args, m.status?.preset) ?? m.loaded_context_length ?? m.meta?.n_ctx;
  const state = m.status?.value ?? m.state;
  return {
    id: m.id,
    ...(m.aliases?.length ? { aliases: m.aliases } : {}),
    ...(ctx ? { contextWindow: ctx } : {}),
    ...(state ? { loaded: state === 'loaded' } : {}),
  };
}

export function buildBody(req: StreamRequest): Record<string, unknown> {
  const tools = req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  return {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    messages: [{ role: 'system', content: req.system }, ...req.messages.flatMap(toWire)],
    ...(tools.length ? { tools } : {}),
  };
}

type WireMsg = Record<string, unknown>;

function toWire(m: Message): WireMsg[] {
  if (m.role === 'assistant') {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = m.content.flatMap((b) =>
      b.type === 'tool_use'
        ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }]
        : [],
    );
    if (!text && !toolCalls.length) return [];
    return [
      { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    ];
  }
  const out: WireMsg[] = [];
  const images: unknown[] = [];
  const userParts: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content || '(no output)' });
      for (const img of b.images ?? []) {
        images.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
      }
    } else if (b.type === 'text') userParts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      userParts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    }
  }
  // Chat-completions tool messages are text-only, so tool images ride along in a follow-up user message.
  if (images.length)
    out.push({ role: 'user', content: [{ type: 'text', text: '(image output from tool)' }, ...images] });
  if (userParts.length) {
    const onlyText = userParts.every((p) => (p as { type: string }).type === 'text');
    out.push({
      role: 'user',
      content: onlyText ? userParts.map((p) => (p as { text: string }).text).join('\n') : userParts,
    });
  }
  return out;
}

function mapStop(r: string, hasCalls: boolean): StopReason {
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  if (r === 'content_filter') return 'refusal';
  if (r === 'stop') return hasCalls ? 'tool_use' : 'end_turn';
  return 'other';
}

interface Chunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

/**
 * Splits streamed content into reasoning and answer when a model wraps its reasoning in <think> tags (Qwen,
 * DeepSeek-R1 and others, when the server does not separate it out). Tags can arrive split across chunks, so
 * anything that might be the start of a tag is held back until the next chunk decides it.
 */
export class ThinkTagSplitter {
  private buf = '';
  private inThink = false;
  /** Only reasoning at the very start of a reply counts; a "<think>" later on is just text. */
  private seenText = false;

  *push(chunk: string): Generator<StreamEvent> {
    this.buf += chunk;
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      if (!this.inThink && this.seenText) {
        if (this.buf) yield { type: 'text', delta: this.buf };
        this.buf = '';
        return;
      }
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        const before = this.buf.slice(0, i);
        if (this.inThink) {
          if (before) yield { type: 'thinking', delta: before };
        } else if (before.trim()) {
          // Text came first: this reply has no leading reasoning block.
          this.seenText = true;
          continue;
        }
        this.buf = this.buf.slice(i + tag.length);
        if (this.inThink) this.buf = this.buf.replace(/^\s+/, ''); // the answer starts after the block
        this.inThink = !this.inThink;
        if (!this.inThink) this.seenText = true;
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      const out = this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      if (out) {
        if (this.inThink) yield { type: 'thinking', delta: out };
        else if (out.trim()) {
          this.seenText = true;
          yield { type: 'text', delta: out };
        } else this.buf = out + this.buf; // leading whitespace before a possible <think>
      }
      return;
    }
  }

  *flush(): Generator<StreamEvent> {
    if (this.buf) yield { type: this.inThink ? 'thinking' : 'text', delta: this.buf };
    this.buf = '';
  }
}
