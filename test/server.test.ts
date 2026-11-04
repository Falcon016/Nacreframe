import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime.js';
import { startServer, type RunningServer } from '../src/server/app.js';
import type { WebState } from '../src/server/sessions.js';
import { startMockLlm } from './mock-llm.js';
import { tmpWorkspace } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let ws: ReturnType<typeof tmpWorkspace>;
let srv: RunningServer;
let work: string;
let cookie = '';

const H = { 'content-type': 'application/json', 'x-nexus': '1' };
const api = (path: string, init: RequestInit & { json?: unknown; cookie?: string } = {}) =>
  fetch(srv.url + path, {
    ...init,
    headers: {
      ...H,
      ...((init.cookie ?? cookie) ? { cookie: init.cookie ?? cookie } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json), method: init.method ?? 'POST' } : {}),
  });

/** Subscribe to a session's SSE feed and keep every state message. */
async function watch(id: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/sessions/${id}/events`, {
    headers: { cookie },
    signal: ctrl.signal,
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const states: WebState[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) states.push(JSON.parse(data) as WebState);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const last = () => states.at(-1)!;
  const allItems = () => states.flatMap((s) => s.items);
  return { states, last, allItems, close: () => ctrl.abort() };
}

async function newSession(extra: Record<string, unknown> = {}) {
  const res = await api('/api/sessions', { json: { cwd: work, model: 'mock/m', ...extra } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  mock = await startMockLlm();
  ws = tmpWorkspace();
  const home = join(ws.dir, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({
      browser: { enabled: false },
      providers: { mock: { type: 'openai', baseUrl: mock.url } },
    }),
  );
  work = join(ws.dir, 'work');
  mkdirSync(work);
  const web = join(ws.dir, 'web');
  mkdirSync(join(web, 'fonts'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(web, 'secret.txt'), 'not for the web? it is fine, txt is served from web/ only');
  writeFileSync(join(ws.dir, 'outside.html'), 'OUTSIDE');
  srv = await startServer({
    host: '127.0.0.1',
    port: 0,
    roots: [work],
    token: TOKEN,
    staticDir: web,
    env: { ...process.env, NEXUS_HOME: home },
  });
  const login = await api('/api/login', { json: { token: TOKEN } });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
}, 60_000);

afterAll(async () => {
  await srv?.close();
  mock?.server.close();
  ws?.cleanup();
});

describe('authentication and request hardening', () => {
  it('refuses to listen on a network address without a token', async () => {
    await expect(
      startServer({
        host: '0.0.0.0',
        port: 0,
        roots: [work],
        staticDir: ws.dir,
        env: { ...process.env, NEXUS_HOME: join(ws.dir, 'home') },
      }),
    ).rejects.toThrow(/without a login token/);
  });

  it('serves the app shell publicly but locks the API behind login', async () => {
    expect((await fetch(srv.url + '/')).status).toBe(200);
    expect((await api('/api/info', { cookie: '' })).status).toBe(401);
    expect((await api('/api/sessions', { cookie: '' })).status).toBe(401);
    const ok = await api('/api/info');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { roots: string[] }).roots).toEqual([work]);
  });

  it('sets an HttpOnly, SameSite=Strict session cookie and also accepts a bearer token', async () => {
    const res = await api('/api/login', { json: { token: TOKEN }, cookie: '' });
    const c = res.headers.get('set-cookie')!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    const bearer = await fetch(srv.url + '/api/info', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(200);
    const wrong = await fetch(srv.url + '/api/info', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('rate-limits failed logins', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await api('/api/login', { json: { token: 'wrong' + i }, cookie: '' })).status;
    expect(last).toBe(429);
    // even the right token is refused while locked out, so guessing cannot continue
    expect((await api('/api/login', { json: { token: TOKEN }, cookie: '' })).status).toBe(429);
  });

  it('rejects state-changing requests without the X-Nexus header or from another origin', async () => {
    const noHeader = await fetch(srv.url + '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ cwd: work }),
    });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await api('/api/sessions', {
      json: { cwd: work },
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('rejects an unexpected Host header (DNS-rebinding protection)', async () => {
    const status = await new Promise<number>((resolveStatus, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: srv.port, path: '/api/info', headers: { host: 'evil.example', cookie } },
        (res) => resolveStatus(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('sends security headers and cannot be framed', async () => {
    const res = await fetch(srv.url + '/');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves only files inside the static directory', async () => {
    for (const p of [
      '/..%2foutside.html',
      '/%2e%2e/outside.html',
      '/..\\outside.html',
      '/.env',
      '/fonts',
      '/nope.js',
    ]) {
      const r = await fetch(srv.url + p);
      expect(r.status, p).toBe(404);
    }
    expect((await fetch(srv.url + '/secret.txt')).status).toBe(200); // known type, inside web/
  });
});

describe('workspace and id validation', () => {
  it('only opens folders inside the allowed roots', async () => {
    expect((await api('/api/sessions', { json: { cwd: ws.dir } })).status).toBe(403); // parent of root
    expect((await api('/api/sessions', { json: { cwd: join(work, '..', '..') } })).status).toBe(403);
    expect((await api('/api/sessions', { json: { cwd: join(work, 'missing') } })).status).toBe(400);
    expect((await api('/api/sessions', { json: {} })).status).toBe(400);
  });

  it('refuses path-like resume ids (no file reads through the API)', async () => {
    for (const resume of ['../../etc/passwd', 'C:\\Windows\\win.ini', join(ws.dir, 'outside.html'), 'a/b']) {
      expect((await api('/api/sessions', { json: { cwd: work, model: 'mock/m', resume } })).status).toBe(400);
    }
    expect(
      (await api('/api/sessions', { json: { cwd: work, model: 'mock/m', swarmResume: '../x' } })).status,
    ).toBe(400);
  });

  it('rejects oversized or malformed bodies', async () => {
    const id = await newSession();
    expect((await api(`/api/sessions/${id}/prompt`, { method: 'POST', body: '[1,2]' })).status).toBe(400);
    // A real 413 reply, not a dropped connection.
    const big = await api(`/api/sessions/${id}/prompt`, { method: 'POST', body: 'x'.repeat(3_000_000) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/too large/i);
    // …and the server keeps serving afterwards.
    expect((await api('/api/models')).status).toBe(200);
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
  });
});

describe('sessions over the API', () => {
  it('lists models, streams a conversation over SSE and reports context numbers', async () => {
    const models = (await (await api('/api/models')).json()) as { models: { spec: string }[] };
    expect(models.models.map((m) => m.spec)).toContain('mock/mock-1');

    const id = await newSession({ approval: 'auto' });
    const w = await watch(id);
    await until(() => w.states.length > 0);
    expect(w.states[0]!.reset).toBe(true);
    expect(w.states[0]!.session).toMatchObject({ model: 'mock/m', mode: 'auto', cwd: work });

    expect((await api(`/api/sessions/${id}/prompt`, { json: { text: 'hello server' } })).status).toBe(202);
    await until(() => w.allItems().some((i) => i.kind === 'assistant' && i.text.includes('mock')));
    expect(w.allItems().some((i) => i.kind === 'user' && i.text === 'hello server')).toBe(true);
    expect(w.last().tokens.input).toBeGreaterThan(0);
    expect(w.last().session.running).toBe(false);

    // A second viewer joining later gets the full transcript (reset), not just new items.
    const w2 = await watch(id);
    await until(() => w2.states.length > 0);
    expect(w2.states[0]!.reset).toBe(true);
    expect(w2.allItems().some((i) => i.kind === 'user' && i.text === 'hello server')).toBe(true);
    w.close();
    w2.close();
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    expect((await api(`/api/sessions/${id}/abort`, { json: {} })).status).toBe(404);
  });

  it('asks for approval over the API, writes only after allow, and honours deny', async () => {
    const id = await newSession({ approval: 'ask' });
    const w = await watch(id);
    await until(() => w.states.length > 0);

    await api(`/api/sessions/${id}/prompt`, { json: { text: 'write approved.txt' } });
    await until(() => !!w.last().approval);
    const a = w.last().approval!;
    expect(a).toMatchObject({ toolName: 'write', agentId: 'main' });
    expect(a.preview).toContain('approved.txt');
    expect(existsSync(join(work, 'approved.txt'))).toBe(false);
    expect((await api(`/api/sessions/${id}/approval`, { json: { id: a.id + 99, allow: true } })).status).toBe(
      409,
    ); // stale id
    expect((await api(`/api/sessions/${id}/approval`, { json: { id: a.id, allow: true } })).status).toBe(200);
    await until(() => existsSync(join(work, 'approved.txt')));
    await until(() => !w.last().session.running);

    await api(`/api/sessions/${id}/prompt`, { json: { text: 'write denied.txt' } });
    await until(() => !!w.last().approval);
    await api(`/api/sessions/${id}/approval`, {
      json: { id: w.last().approval!.id, allow: false, feedback: 'not now' },
    });
    await until(() => !w.last().session.running);
    expect(existsSync(join(work, 'denied.txt'))).toBe(false);
    w.close();
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
  });

  it('changes mode and sandbox, refusing invalid values', async () => {
    const id = await newSession();
    const w = await watch(id);
    await until(() => w.states.length > 0);
    expect(
      (await api(`/api/sessions/${id}/settings`, { json: { mode: 'plan', sandbox: 'off' } })).status,
    ).toBe(200);
    await until(() => w.last().session.mode === 'plan');
    expect(w.last().session.sandbox).toBe('off');
    expect((await api(`/api/sessions/${id}/settings`, { json: { mode: 'yolo' } })).status).toBe(400);
    expect((await api(`/api/sessions/${id}/settings`, { json: { model: 'nope/none' } })).status).toBe(400);
    w.close();
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
  });

  it('tells connected browsers to start over when a new conversation begins', async () => {
    const id = await newSession({ approval: 'auto' });
    const w = await watch(id);
    await until(() => w.states.length > 0);
    await api(`/api/sessions/${id}/prompt`, { json: { text: 'first conversation' } });
    await until(() => w.allItems().some((i) => i.kind === 'assistant') && !w.last().session.running);

    const before = w.states.length;
    expect((await api(`/api/sessions/${id}/new`, { json: {} })).status).toBe(200);
    // Without a reset the page would keep drawing the old transcript above the new one.
    await until(() => w.states.length > before && w.states.slice(before).some((s) => s.reset));
    const reset = w.states.slice(before).find((s) => s.reset)!;
    expect(reset.items).toEqual([]);

    await api(`/api/sessions/${id}/prompt`, { json: { text: 'second conversation' } });
    await until(() => w.states.slice(before).some((s) => s.items.some((i) => i.kind === 'assistant')));
    const afterItems = w.states.slice(before).flatMap((s) => s.items);
    expect(afterItems.some((i) => i.kind === 'user' && i.text === 'second conversation')).toBe(true);
    expect(afterItems.some((i) => i.kind === 'user' && i.text === 'first conversation')).toBe(false);
    w.close();
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
  });

  it('releases the runtime when a session fails halfway through being created', async () => {
    const dispose = vi.spyOn(Runtime.prototype, 'dispose');
    try {
      const res = await api('/api/sessions', {
        json: { cwd: work, model: 'mock/m', swarmResume: 'doesnotexist01' },
      });
      expect(res.status).toBe(400);
      expect(dispose).toHaveBeenCalledTimes(1); // otherwise its browser and child processes would leak
      expect(((await (await api('/api/sessions')).json()) as { sessions: unknown[] }).sessions).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ cwd: work, swarm: true })]),
      );
    } finally {
      dispose.mockRestore();
    }
  });

  it('runs a persistent swarm and lists it for resume', async () => {
    const id = await newSession({ approval: 'auto' });
    const w = await watch(id);
    await until(() => w.states.length > 0);
    expect((await api(`/api/sessions/${id}/swarm`, { json: { action: 'start', arg: 'duo' } })).status).toBe(
      200,
    );
    await until(() => w.last().session.swarm.active);
    expect(w.last().session.swarm.names).toEqual(['planner', 'builder']);
    await api(`/api/sessions/${id}/prompt`, { json: { text: 'plan it' } });
    await until(() =>
      w.allItems().some((i) => i.kind === 'channel' && i.from === 'you' && i.text === 'plan it'),
    );
    await until(() => !w.last().session.running);
    w.close();
    await api(`/api/sessions/${id}`, { method: 'DELETE' });

    const saved = (await (await api(`/api/saved?cwd=${encodeURIComponent(work)}`)).json()) as {
      swarms: { id: string; agents: string[] }[];
    };
    expect(saved.swarms[0]!.agents).toEqual(['planner', 'builder']);
    expect(JSON.stringify(saved)).not.toContain(ws.dir); // no server paths leak to the client

    const id2 = await newSession({ swarmResume: saved.swarms[0]!.id, approval: 'auto' });
    const w2 = await watch(id2);
    await until(() => w2.states.length > 0);
    expect(w2.last().session.swarm.active).toBe(true);
    expect(w2.allItems().some((i) => i.kind === 'channel' && i.text === 'plan it')).toBe(true);
    w2.close();
    await api(`/api/sessions/${id2}`, { method: 'DELETE' });
  });

  it('limits how many sessions can be open', async () => {
    const small = await startServer({
      host: '127.0.0.1',
      port: 0,
      roots: [work],
      token: TOKEN,
      staticDir: ws.dir,
      maxSessions: 1,
      env: { ...process.env, NEXUS_HOME: join(ws.dir, 'home') },
    });
    try {
      const login = await fetch(small.url + '/api/login', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ token: TOKEN }),
      });
      const c = login.headers.get('set-cookie')!.split(';')[0]!;
      const mk = () =>
        fetch(small.url + '/api/sessions', {
          method: 'POST',
          headers: { ...H, cookie: c },
          body: JSON.stringify({ cwd: work, model: 'mock/m' }),
        });
      expect((await mk()).status).toBe(201);
      expect((await mk()).status).toBe(429);
    } finally {
      await small.close();
    }
  });
});
