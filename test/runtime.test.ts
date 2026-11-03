import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { AuthStore } from '../src/config/auth.js';
import { contextFromArgs, OpenAICompatProvider } from '../src/llm/openai.js';
import { ProviderRegistry } from '../src/llm/registry.js';
import { projectKey } from '../src/paths.js';
import { Runtime } from '../src/runtime.js';
import { startMockLlm } from './mock-llm.js';
import { tmpWorkspace } from './helpers.js';

/** The shape llama.cpp's router-mode llama-server returns from /v1/models (abridged). */
const ROUTER_MODELS = {
  data: [
    {
      id: 'gemma-100k',
      aliases: ['gemma:alias'],
      status: { value: 'unloaded', args: ['/app/llama-server', '--ctx-size', '100000', '--parallel', '1'] },
    },
    {
      id: 'tiny-16k',
      status: { value: 'loaded', args: ['--port', '0', '-c', '16384'], preset: '[tiny]\nctx-size = 16384' },
    },
    {
      id: 'preset-only',
      status: { value: 'unloaded', args: [], preset: '[p]\nctx-size = 36000\nthreads = 8' },
    },
    { id: 'no-info' },
  ],
};

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    return path in routes
      ? new Response(JSON.stringify(routes[path]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('{"error":{"message":"not found"}}', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('context window detection', () => {
  it('reads --ctx-size / -c / preset values from a llama.cpp router', async () => {
    const p = new OpenAICompatProvider({
      id: 'llamacpp',
      baseUrl: 'http://x/v1',
      fetchImpl: fakeFetch({ '/v1/models': ROUTER_MODELS }),
    });
    const models = await p.listModels();
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(by['gemma-100k']).toMatchObject({
      contextWindow: 100000,
      loaded: false,
      aliases: ['gemma:alias'],
    });
    expect(by['tiny-16k']).toMatchObject({ contextWindow: 16384, loaded: true });
    expect(by['preset-only']!.contextWindow).toBe(36000);
    expect(by['no-info']!.contextWindow).toBeUndefined();
  });

  it('falls back to /props for single-model servers and /api/ps for Ollama', async () => {
    const single = new OpenAICompatProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      fetchImpl: fakeFetch({
        '/v1/models': { data: [{ id: 'm' }] },
        '/props': { default_generation_settings: { n_ctx: 8192 } },
      }),
    });
    expect((await single.listModels())[0]!.contextWindow).toBe(8192);

    const ollama = new OpenAICompatProvider({
      id: 'o',
      baseUrl: 'http://x/v1',
      fetchImpl: fakeFetch({
        '/v1/models': { data: [{ id: 'qwen3:8b' }] },
        '/api/ps': { models: [{ name: 'qwen3:8b', context_length: 4096 }] },
      }),
    });
    expect((await ollama.listModels())[0]!.contextWindow).toBe(4096);
  });

  it('parses context size from args robustly', () => {
    expect(contextFromArgs(['--ctx-size', '100000'], undefined)).toBe(100000);
    expect(contextFromArgs(['-c', 'abc'], undefined)).toBeUndefined();
    expect(contextFromArgs(undefined, 'a = 1\nctx-size = 2048')).toBe(2048);
    expect(contextFromArgs(['--ctx-size'], undefined)).toBeUndefined();
  });

  it('resolves a model with the detected window, letting explicit config win', async () => {
    const ws = tmpWorkspace();
    try {
      const home = join(ws.dir, 'home');
      mkdirSync(join(home, 'config'), { recursive: true });
      writeFileSync(
        join(home, 'config', 'config.json'),
        JSON.stringify({
          providers: { llamacpp: { baseUrl: 'http://127.0.0.1:11434/v1' } },
          contextWindows: { 'llamacpp/tiny-16k': 12000 },
        }),
      );
      const { config, paths } = loadConfig({ cwd: ws.dir, env: { NACRE_HOME: home }, paths: undefined });
      const registry = new ProviderRegistry(
        config,
        new AuthStore(paths),
        {},
        fakeFetch({ '/v1/models': ROUTER_MODELS }),
      );
      const detected = await registry.resolveDetected('llamacpp/gemma-100k');
      expect(detected).toMatchObject({ contextWindow: 100000, contextSource: 'detected' });
      expect((await registry.resolveDetected('llamacpp/gemma:alias')).contextWindow).toBe(100000); // by alias
      expect(await registry.resolveDetected('llamacpp/tiny-16k')).toMatchObject({
        contextWindow: 12000,
        contextSource: 'config', // the explicit override beats what the server says
      });
      const unknown = await registry.resolveDetected('llamacpp/no-info');
      expect(unknown).toMatchObject({ contextWindow: 32768, contextSource: 'default' }); // conservative, flagged
    } finally {
      ws.cleanup();
    }
  });

  it('uses the built-in llamacpp provider and keeps 11434 reachable via config', () => {
    const ws = tmpWorkspace();
    try {
      const home = join(ws.dir, 'h');
      mkdirSync(join(home, 'config'), { recursive: true });
      const plain = loadConfig({ cwd: ws.dir, env: { NACRE_HOME: home } }).config;
      expect(plain.providers.llamacpp?.baseUrl).toBe('http://127.0.0.1:8080/v1');
      writeFileSync(
        join(home, 'config', 'config.json'),
        JSON.stringify({ providers: { llamacpp: { baseUrl: 'http://127.0.0.1:11434/v1' } } }),
      );
      const custom = loadConfig({ cwd: ws.dir, env: { NACRE_HOME: home } }).config;
      expect(custom.providers.llamacpp).toMatchObject({
        type: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
    } finally {
      ws.cleanup();
    }
  });
});

describe('runtime with the mock server', () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  beforeAll(async () => (mock = await startMockLlm()));
  afterAll(() => mock.server.close());

  function setup(config: Record<string, unknown> = {}) {
    const ws = tmpWorkspace();
    const home = join(ws.dir, '.home');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'config.json'),
      JSON.stringify({
        approval: { mode: 'auto' },
        browser: { enabled: false },
        providers: { mock: { type: 'openai', baseUrl: mock.url } },
        ...config,
      }),
    );
    const work = join(ws.dir, 'work');
    mkdirSync(work);
    const boot = (extra: { model?: string } = {}) =>
      Runtime.create({
        cwd: work,
        env: { ...process.env, NACRE_HOME: home },
        ...(extra.model ? { overrides: { model: extra.model } } : {}),
      });
    return { ws, boot, work };
  }

  it('has no default model and fails loudly, listing what is available', async () => {
    const { ws, boot } = setup();
    const rt = await boot();
    try {
      expect(rt.modelSpec).toBeUndefined();
      const errors: string[] = [];
      rt.agent.events.on('event', (e) => e.type === 'error' && errors.push(e.message));
      await rt.agent.run('hello');
      expect(errors.join()).toContain('No model selected');
      const models = await rt.listModels();
      expect(models.map((m) => m.spec)).toContain('mock/mock-1');
      await rt.setModel('mock/mock-1');
      expect(rt.modelSpec).toBe('mock/mock-1');
    } finally {
      await rt.dispose();
      ws.cleanup();
    }
  });

  it('persists a swarm and resumes it with channel history, notes, and each member’s own context', async () => {
    const { ws, boot } = setup({ model: 'mock/m' });
    const first = await boot();
    let swarmId: string;
    try {
      const sw = await first.startSwarm('duo');
      swarmId = sw.id!;
      sw.say('please plan the work');
      await sw.idle();
      sw.agent('planner')!.session.append({
        role: 'user',
        content: [{ type: 'text', text: 'marker-from-planner-context' }],
      });
      first.stopSwarm();
    } finally {
      await first.dispose();
    }

    const second = await boot();
    try {
      expect(second.listSwarms().map((s) => s.id)).toContain(swarmId);
      const sw = await second.resumeSwarm(swarmId);
      expect(sw.names).toEqual(['planner', 'builder']);
      expect(sw.log.some((m) => m.text === 'please plan the work')).toBe(true); // channel history restored
      const ctx = JSON.stringify(sw.agent('planner')!.session.messages());
      expect(ctx).toContain('marker-from-planner-context'); // the member's own conversation, like any session
      expect(ctx).toContain('Hello! This is the **mock** model'); // …including what it answered before
      // and it keeps working after the resume
      sw.say('continue');
      await sw.idle();
      expect(JSON.stringify(sw.agent('planner')!.session.messages())).toContain('continue');
    } finally {
      await second.dispose();
      ws.cleanup();
    }
  });

  it('gives only the swarm lead the ask_user tool, and tells each member who it reports to', async () => {
    const { ws, boot } = setup({ model: 'mock/m' });
    const rt = await boot();
    try {
      await rt.startSwarm('duo');
      const planner = rt.systemPrompt('planner');
      const builder = rt.systemPrompt('builder');
      expect(planner).toMatch(/Tools:.*ask_user/);
      expect(builder).not.toMatch(/Tools:.*ask_user/);
      expect(planner).toContain('You are the lead');
      expect(builder).toContain('You report to planner');
    } finally {
      rt.stopSwarm();
      await rt.dispose();
      ws.cleanup();
    }
  });

  it('does not offer swarm_spawn unless adding teammates is allowed, so a team stays the size you chose', async () => {
    const { ws, boot } = setup({ model: 'mock/m' });
    const rt = await boot();
    try {
      const sw = await rt.startSwarm('trio');
      expect(sw.names).toEqual(['architect', 'builder', 'reviewer']);
      expect(rt.systemPrompt('architect')).not.toContain('swarm_spawn');
    } finally {
      rt.stopSwarm();
      await rt.dispose();
      ws.cleanup();
    }
  });

  it('flushes old saved conversations and swarms, never the current one, and only this folder unless asked', async () => {
    const { ws, boot } = setup({ model: 'mock/m' });
    const rt = await boot();
    try {
      const data = join(ws.dir, '.home', 'data');
      const here = join(data, 'sessions', projectKey(rt.cwd));
      const elsewhere = join(data, 'sessions', 'some-other-folder');
      mkdirSync(here, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      const old = Date.now() / 1000 - 60 * 86_400;
      const make = (dir: string, name: string, aged: boolean) => {
        const f = join(dir, name);
        writeFileSync(f, '{"type":"session"}\n');
        if (aged) utimesSync(f, old, old);
        return f;
      };
      const oldHere = make(here, 'old.jsonl', true);
      const newHere = make(here, 'new.jsonl', false);
      const oldThere = make(elsewhere, 'old.jsonl', true);
      const current = rt.agent.session.filePath!;
      writeFileSync(current, '{"type":"session"}\n');
      utimesSync(current, old, old); // even an old-looking current conversation is kept

      const swarmDir = join(data, 'swarms', projectKey(rt.cwd), 'run1');
      mkdirSync(swarmDir, { recursive: true });
      writeFileSync(join(swarmDir, 'channel.jsonl'), 'x');
      utimesSync(join(swarmDir, 'channel.jsonl'), old, old);

      const recent = rt.flushPlan({ olderThanDays: 30 });
      expect(recent.sessions).toEqual([oldHere]);
      expect(recent.swarms).toEqual([swarmDir]);
      expect(recent.bytes).toBeGreaterThan(0);

      expect(rt.flushPlan({}).sessions.sort()).toEqual([newHere, oldHere].sort());
      expect(rt.flushPlan({ olderThanDays: 30, allFolders: true }).sessions.sort()).toEqual(
        [oldHere, oldThere].sort(),
      );

      const done = rt.flush(rt.flushPlan({ olderThanDays: 30, allFolders: true }));
      expect(done).toMatchObject({ sessions: 2, swarms: 1 });
      expect(existsSync(oldHere) || existsSync(oldThere) || existsSync(swarmDir)).toBe(false);
      expect(existsSync(newHere) && existsSync(current)).toBe(true);
      expect(existsSync(elsewhere)).toBe(false); // emptied folders are tidied away
    } finally {
      await rt.dispose();
      ws.cleanup();
    }
  });

  it('saves a custom team so /swarm config starts it again', async () => {
    const { ws, boot } = setup({ model: 'mock/m' });
    const rt = await boot();
    try {
      const team = [
        { name: 'lead', role: 'Lead. Run it.' },
        { name: 'doer', role: 'Do it. Report back to lead.' },
      ];
      rt.saveSwarmTeam(team);
      const saved = JSON.parse(readFileSync(join(ws.dir, '.home', 'config', 'config.json'), 'utf8'));
      expect(saved.swarm.agents).toEqual(team);
      expect(saved.model).toBe('mock/m'); // the rest of the settings are kept
      const sw = await rt.startSwarm('config');
      expect(sw.names).toEqual(['lead', 'doer']);
    } finally {
      rt.stopSwarm();
      await rt.dispose();
      ws.cleanup();
    }
  });

  it('compacts a swarm member exactly like the main agent (80% rule, summary, no loss)', async () => {
    const { ws, boot } = setup({ model: 'mock/m', contextWindows: { 'mock/m': 4000 } });
    const rt = await boot();
    try {
      const sw = await rt.startSwarm('duo');
      const planner = sw.agent('planner')!;
      for (let i = 0; i < 8; i++) {
        planner.session.append({
          role: 'user',
          content: [{ type: 'text', text: `topic ${i}: ${'x'.repeat(1200)}` }],
        });
        planner.session.append({
          role: 'assistant',
          content: [{ type: 'text', text: `reply ${i}: ${'y'.repeat(1200)}` }],
        });
      }
      const before = planner.session.messageEntries().length;
      const events: string[] = [];
      planner.events.on('event', (e) => e.type === 'compaction' && events.push(e.phase));
      sw.say('keep going');
      await sw.idle();
      expect(events).toEqual(['start', 'end']);
      expect(planner.session.path().some((e) => e.type === 'compaction')).toBe(true);
      expect(planner.session.messageEntries().length).toBeGreaterThanOrEqual(before); // nothing deleted
      expect(planner.session.messages()[0]!.content[0]).toMatchObject({ type: 'text' });
    } finally {
      await rt.dispose();
      ws.cleanup();
    }
  });
});
