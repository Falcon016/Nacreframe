import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effortFix } from '../src/agent/agent.js';
import { buildBody as anthropicBody } from '../src/llm/anthropic.js';
import { buildBody as openaiBody } from '../src/llm/openai.js';
import { ProviderError, type StreamRequest } from '../src/llm/types.js';
import { Runtime } from '../src/runtime.js';
import { AutoProvider, makeAgent, say, tmpWorkspace } from './helpers.js';
import { startMockLlm } from './mock-llm.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const req: StreamRequest = { model: 'm', system: 's', messages: [], tools: [], reasoningEffort: 'high' };

describe('reasoning effort', () => {
  it('is sent the way each kind of server reads it, and not at all when unset', () => {
    // llama.cpp, Ollama, LM Studio: the field, and the chat template's argument (vLLM, llama.cpp templates).
    expect(openaiBody(req, { templateKwargs: true })).toMatchObject({
      reasoning_effort: 'high',
      chat_template_kwargs: { reasoning_effort: 'high' },
    });
    // OpenAI itself refuses fields it does not know.
    expect(openaiBody(req, { templateKwargs: false })).not.toHaveProperty('chat_template_kwargs');
    expect(anthropicBody(req)).toMatchObject({ output_config: { effort: 'high' } });
    const { reasoningEffort: _unset, ...plain } = req;
    expect(openaiBody(plain, { templateKwargs: true })).not.toHaveProperty('reasoning_effort');
    expect(anthropicBody(plain)).not.toHaveProperty('output_config');
  });

  it('reads what a refusal asks for', () => {
    expect(
      effortFix("Invalid value for 'reasoning_effort': 'xhigh'. Must be one of low, medium, high", 'xhigh'),
    ).toBe('high');
    expect(effortFix('Unrecognized request argument supplied: reasoning_effort', 'medium')).toBe('none');
    expect(effortFix('output_config.effort: this model does not support effort', 'low')).toBe('none');
    expect(effortFix('max_tokens is too large', 'high')).toBeUndefined();
  });

  it('steps down from xhigh, then drops the setting for a model that takes none, without an error', async () => {
    let n = 0;
    const p = new AutoProvider([
      () => {
        n++;
        throw new ProviderError("Invalid value for 'reasoning_effort': 'xhigh'", 400);
      },
      () => {
        n++;
        throw new ProviderError('Unrecognized request argument supplied: reasoning_effort', 400);
      },
      say('ok'),
      say('again'),
    ]);
    const { agent, events } = makeAgent(ws.dir, p, { config: { reasoningEffort: 'xhigh' } });
    await agent.run('hi');
    await agent.run('more');
    expect(n).toBe(2);
    expect(p.calls.map((r) => r.reasoningEffort ?? 'none')).toEqual(['xhigh', 'high', 'none', 'none']);
    expect(agent.model.effortCap).toBe('none');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'status' && /takes no reasoning effort/.test(e.text))).toBe(true);
  });
});

describe('setting the effort', () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  beforeAll(async () => (mock = await startMockLlm()));
  afterAll(() => mock.server.close());

  it('saves the choice, applies it to the next request, and goes back to the default', async () => {
    const home = join(ws.dir, '.home');
    mkdirSync(join(home, 'config'), { recursive: true });
    const file = join(home, 'config', 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        model: 'mock/m',
        browser: { enabled: false },
        approval: { mode: 'auto' },
        providers: { mock: { type: 'openai', baseUrl: mock.url } },
      }),
    );
    const rt = await Runtime.create({
      cwd: ws.dir,
      env: { ...process.env, NEXUS_HOME: home },
      ephemeral: true,
    });
    try {
      const seen: unknown[] = [];
      rt.events.on('effort', (e) => seen.push(e));
      rt.agent.model.effortCap = 'none'; // learned from an earlier refusal…
      rt.setReasoningEffort('medium');
      expect(rt.agent.model.effortCap).toBeUndefined(); // …is asked again after a change
      expect(JSON.parse(readFileSync(file, 'utf8')).reasoningEffort).toBe('medium');
      const before = mock.requests.length;
      await rt.agent.run('hello');
      expect((mock.requests.at(before) as { reasoning_effort?: string }).reasoning_effort).toBe('medium');
      rt.setReasoningEffort(undefined);
      expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('reasoningEffort');
      expect(seen).toEqual(['medium', undefined]);
    } finally {
      await rt.dispose();
    }
  });
});
