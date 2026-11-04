import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpWorkspace } from './helpers.js';

const TSX = resolve('node_modules/tsx/dist/cli.mjs');
const CLI = resolve('src/cli.ts');

let ws: ReturnType<typeof tmpWorkspace>;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  ws = tmpWorkspace();
  mkdirSync(join(ws.dir, 'home'), { recursive: true });
  env = { ...process.env, NEXUS_HOME: join(ws.dir, 'home') };
});
afterEach(() => ws.cleanup());

const run = (...args: string[]) =>
  spawnSync(process.execPath, [TSX, CLI, ...args], { env, encoding: 'utf8', timeout: 60_000, cwd: ws.dir });

describe('command line', () => {
  it("loads React's production build, but does not pass NODE_ENV on to the commands it runs", () => {
    const script = [
      "import { restoreNodeEnv } from './src/env.ts';",
      "import 'react';",
      'const atLoad = process.env.NODE_ENV;',
      'restoreNodeEnv();',
      'console.log(JSON.stringify({ atLoad, after: process.env.NODE_ENV ?? null }));',
    ].join('\n');
    const { NODE_ENV: _drop, ...clean } = process.env;
    const r = spawnSync(process.execPath, [TSX, '--input-type=module', '-e', script], {
      env: clean,
      encoding: 'utf8',
      cwd: resolve('.'),
      timeout: 60_000,
    });
    expect(JSON.parse(r.stdout)).toEqual({ atLoad: 'production', after: null });
  });

  it('prints version and help', () => {
    expect(run('--version').stdout).toMatch(/^NexusHarness \d+\.\d+\.\d+/);
    expect(run('--help').stdout).toContain('nexus serve');
  });

  it('refuses scripted use without a model, saying what is available', () => {
    const r = run('-p', 'hello');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('No model selected');
  });

  it('gives `serve` its own flags and validates them', () => {
    const help = run('serve', '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--allow-host');
    expect(run('serve', '--port', '99999').status).toBe(2);
    const bad = run('serve', '--no-auth', '--host', '0.0.0.0');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('only allowed when listening on a loopback');
    expect(run('serve', '--tls-cert', 'x.pem').status).toBe(2);
  });

  it('really starts the dashboard, prints a sign-in link and serves the app', async () => {
    const root = join(ws.dir, 'projects');
    mkdirSync(root);
    const child = spawn(process.execPath, [TSX, CLI, 'serve', '--port', '0', '--root', root], {
      env,
      cwd: tmpdir(), // not inside the workspace we delete afterwards (Windows cannot remove an in-use folder)
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    try {
      const deadline = Date.now() + 30_000;
      while (!/sign in\s+http/.test(out) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      const url = /listening\s+(http:\/\/\S+)/.exec(out)?.[1];
      const token = /#token=([\w-]+)/.exec(out)?.[1];
      expect(url, out).toBeTruthy();
      expect(token).toBeTruthy();

      const page = await fetch(url! + '/');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('NexusHarness');
      expect((await fetch(url! + '/api/info')).status).toBe(401);
      const info = await fetch(url! + '/api/info', { headers: { authorization: `Bearer ${token}` } });
      expect(info.status).toBe(200);
      expect(((await info.json()) as { roots: string[] }).roots).toEqual([root]);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  }, 60_000);
});
