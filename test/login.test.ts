import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime.js';
import { tmpWorkspace } from './helpers.js';
import { startMockLlm } from './mock-llm.js';

type Mock = Awaited<ReturnType<typeof startMockLlm>>;

/** A server that only lists its models for the right key, like `llama-server --api-key`. */
function keyedServer(key: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.statusCode = 401;
      return void res.end('{"error":{"message":"Invalid API Key"}}');
    }
    res.end(JSON.stringify({ data: [{ id: 'locked-1' }] }));
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }),
    ),
  );
}

let oldServer: Mock;
let newServer: Mock;
beforeAll(async () => {
  oldServer = await startMockLlm();
  newServer = await startMockLlm(0, { models: [{ id: 'big-1' }, { id: 'small-1' }] });
});
afterAll(() => {
  oldServer.server.close();
  newServer.server.close();
});

let ws: ReturnType<typeof tmpWorkspace>;
let home: string;
let rt: Runtime;
const configFile = () => join(home, 'config', 'config.json');
const userConfig = () =>
  JSON.parse(readFileSync(configFile(), 'utf8')) as { providers?: Record<string, unknown> };

beforeEach(async () => {
  ws = tmpWorkspace();
  home = join(ws.dir, '.home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    configFile(),
    JSON.stringify({
      model: 'llamacpp/mock-1',
      browser: { enabled: false },
      approval: { mode: 'auto' },
      providers: {
        llamacpp: { type: 'openai', baseUrl: oldServer.url },
        gpu: { type: 'openai', baseUrl: oldServer.url },
      },
    }),
  );
  rt = await Runtime.create({
    cwd: ws.dir,
    env: { PATH: process.env.PATH, NEXUS_HOME: home },
    ephemeral: true,
  });
});
afterEach(async () => {
  await rt.dispose();
  ws.cleanup();
});

describe('/login', () => {
  it('lists the built-in providers, then servers added by hand, with where each points', () => {
    const targets = rt.loginTargets();
    expect(targets.map((t) => t.id)).toEqual([
      'anthropic',
      'openai',
      'ollama',
      'lmstudio',
      'llamacpp',
      'gpu',
    ]);
    expect(targets.find((t) => t.id === 'llamacpp')).toMatchObject({
      kind: 'local',
      baseUrl: oldServer.url,
      current: true,
    });
    expect(targets.find((t) => t.id === 'gpu')).toMatchObject({ kind: 'custom', current: false });
    expect(targets.find((t) => t.id === 'anthropic')).toMatchObject({ kind: 'cloud', key: undefined });
  });

  it('swaps a llama.cpp server: checks the new one, saves it, and the model in use talks to it next', async () => {
    const plan = { id: 'llamacpp', type: 'openai' as const, baseUrl: newServer.url };
    const listing = await rt.probeProvider(plan);
    expect(listing).toEqual({ ok: true, models: [{ id: 'big-1' }, { id: 'small-1' }] });
    expect(userConfig().providers?.llamacpp).toEqual({ type: 'openai', baseUrl: oldServer.url }); // a check saves nothing

    const saved = await rt.saveProvider(plan);
    expect(saved).toEqual({});
    expect(userConfig().providers?.llamacpp).toEqual({ type: 'openai', baseUrl: newServer.url });
    const before = newServer.requests.length;
    await rt.agent.run('hello');
    expect(newServer.requests.length).toBe(before + 1);

    // Back to the built-in address: nothing is written down, so the default applies.
    await rt.saveProvider({ id: 'llamacpp', type: 'openai' });
    expect(userConfig().providers?.llamacpp).toEqual({ type: 'openai' });
    expect(rt.config.providers.llamacpp?.baseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('tells a refused key from an unreachable server, and saves a key owner-only', async () => {
    const keyed = await keyedServer('s3cret');
    try {
      const plan = { id: 'secure', type: 'openai' as const, baseUrl: keyed.url };
      expect(await rt.probeProvider(plan)).toMatchObject({ ok: false, kind: 'rejected' });
      expect(await rt.probeProvider(plan, 'wrong')).toMatchObject({ ok: false, kind: 'rejected' });
      expect(await rt.probeProvider(plan, 's3cret')).toEqual({ ok: true, models: [{ id: 'locked-1' }] });
      expect(
        await rt.probeProvider({ ...plan, baseUrl: 'http://127.0.0.1:9/v1' }, undefined, 2000),
      ).toMatchObject({
        ok: false,
        kind: 'unreachable',
      });

      await rt.saveProvider(plan, 's3cret');
      const auth = join(home, 'config', 'auth.json');
      expect(JSON.parse(readFileSync(auth, 'utf8'))).toMatchObject({ secure: 's3cret' });
      if (process.platform !== 'win32') expect(statSync(auth).mode & 0o777).toBe(0o600);
      expect(rt.loginTargets().find((t) => t.id === 'secure')).toMatchObject({
        kind: 'custom',
        key: 'saved',
      });
      expect(await rt.listModels()).toContainEqual(expect.objectContaining({ spec: 'secure/locked-1' }));
    } finally {
      keyed.server.close();
    }
  });
});

describe('/logout', () => {
  it('removes a saved key, and forgets a server added by hand only when asked', async () => {
    await rt.saveProvider({ id: 'gpu', type: 'openai', baseUrl: oldServer.url }, 'k1');
    expect(rt.logout('gpu')).toEqual({ key: true, server: false });
    expect(userConfig().providers?.gpu).toBeDefined();
    expect(rt.logout('gpu')).toEqual({ key: false, server: false });

    expect(rt.logout('gpu', true)).toEqual({ key: false, server: true });
    expect(userConfig().providers).not.toHaveProperty('gpu');
    expect(rt.config.providers).not.toHaveProperty('gpu');
    expect(rt.loginTargets().map((t) => t.id)).not.toContain('gpu');

    // A built-in provider is never removed, only its key.
    expect(rt.logout('llamacpp', true)).toEqual({ key: false, server: false });
    expect(rt.config.providers.llamacpp).toBeDefined();
  });
});
