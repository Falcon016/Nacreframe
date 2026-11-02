import { describe, expect, it } from 'vitest';
import { assemble } from '../src/llm/assemble.js';
import { AnthropicProvider, buildBody as anthropicBody } from '../src/llm/anthropic.js';
import { OpenAICompatProvider, buildBody as openaiBody } from '../src/llm/openai.js';
import { ProviderError, type Message } from '../src/llm/types.js';
import { parseSse } from '../src/util/sse.js';

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describe('sse parser', () => {
  it('handles events split across chunks, CRLF and comments', async () => {
    const res = sseResponse([': ping\r\n\r\nevent: a\r\ndata: {"x"', ':1}\r\n\r\ndata: one\ndata: two\n\n']);
    const out = [];
    for await (const e of parseSse(res.body!)) out.push(e);
    expect(out).toEqual([{ event: 'a', data: '{"x":1}' }, { data: 'one\ntwo' }]);
  });
});

describe('anthropic provider', () => {
  it('streams text, tool calls and usage into one assistant message', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        ev('message_start', { message: { usage: { input_tokens: 12 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me ' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'look.' } }),
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'read' },
        }),
        ev('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } }),
        ev('message_stop', {}),
      ])) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'test', fetchImpl });
    const r = await assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 }));
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 33 });
    expect(r.message.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.ts' } },
    ]);
  });

  it('retries 429 then succeeds, honouring the retry budget', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3
        ? new Response('{"error":{"message":"slow down"}}', { status: 429 })
        : sseResponse([ev('message_stop', {})]);
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'test', fetchImpl });
    const orig = globalThis.setTimeout;
    // collapse backoff so the test is fast
    globalThis.setTimeout = ((fn: () => void) => orig(fn, 0)) as typeof setTimeout;
    try {
      await assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 }));
    } finally {
      globalThis.setTimeout = orig;
    }
    expect(calls).toBe(3);
  });

  it('does not retry a 400 and surfaces the API message', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"bad request body"}}', { status: 400 })) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'test', fetchImpl });
    await expect(
      assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 })),
    ).rejects.toThrow(/bad request body/);
  });

  it('marks the cache breakpoint and converts tool results with images', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'a',
            content: 'ok',
            images: [{ mediaType: 'image/png', data: 'AAA' }],
          },
        ],
      },
    ];
    const body = anthropicBody({
      model: 'm',
      system: 's',
      messages,
      tools: [{ name: 'read', description: 'd', inputSchema: {} }],
      maxTokens: 5,
    }) as {
      messages: { content: { cache_control?: unknown; content?: { type: string }[] }[] }[];
    };
    const last = body.messages.at(-1)!.content.at(-1)!;
    expect(last.cache_control).toBeTruthy();
    expect(last.content!.map((c) => c.type)).toEqual(['text', 'image']);
  });
});

describe('openai-compatible provider', () => {
  it('assembles streamed tool calls and maps stop reasons', async () => {
    const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const fetchImpl = (async () =>
      sseResponse([
        chunk({ choices: [{ delta: { content: 'Checking' } }] }),
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_9', function: { name: 'grep', arguments: '{"pattern"' } }],
              },
            },
          ],
        }),
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"foo"}' } }] } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        chunk({ usage: { prompt_tokens: 7, completion_tokens: 3 }, choices: [] }),
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ id: 'local', baseUrl: 'http://localhost:1234/v1', fetchImpl });
    const r = await assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 }));
    expect(r.stopReason).toBe('tool_use'); // local servers often say "stop" even when calling tools
    expect(r.message.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_9',
      name: 'grep',
      input: { pattern: 'foo' },
    });
    expect(r.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('generates ids for servers that omit tool call ids', async () => {
    const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const fetchImpl = (async () =>
      sseResponse([
        chunk({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { name: 'ls', arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ])) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ id: 'local', baseUrl: 'http://x/v1', fetchImpl });
    const r = await assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 }));
    const call = r.message.content[0]!;
    expect(call.type === 'tool_use' && call.id.length).toBeGreaterThan(5);
  });

  it('sends tool results as tool-role messages', () => {
    const body = openaiBody({
      model: 'm',
      system: 'sys',
      maxTokens: 5,
      tools: [],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'data' }] },
      ],
    }) as { messages: { role: string; tool_call_id?: string }[] };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'assistant', 'tool']);
    expect(body.messages[2]!.tool_call_id).toBe('c1');
  });

  it('throws ProviderError for HTTP failures', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ id: 'x', baseUrl: 'http://x/v1', fetchImpl });
    await expect(
      assemble(p.stream({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 })),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
