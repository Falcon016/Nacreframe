import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainerSandbox } from '../src/sandbox/container.js';
import { bashTool } from '../src/tools/bash.js';
import { testConfig, tmpWorkspace } from './helpers.js';

const image = process.env.NACRE_TEST_IMAGE ?? 'node:22-bookworm-slim';
const hasDocker = ContainerSandbox.available('docker');
// Only run when the image is already present so the suite never triggers a surprise download.
const hasImage =
  hasDocker && spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasImage)('container sandbox', () => {
  let ws: ReturnType<typeof tmpWorkspace>;
  beforeEach(() => (ws = tmpWorkspace()));
  afterEach(() => ws.cleanup());

  const run = async (command: string, network = false) => {
    const cfg = testConfig().sandbox.container;
    const sb = new ContainerSandbox(ws.dir, { ...cfg, image, network });
    const ctx = {
      cwd: ws.dir,
      sandbox: sb,
      signal: new AbortController().signal,
      readState: new Map(),
      progress() {},
      config: testConfig(),
      agentId: 't',
    };
    return bashTool.execute({ command, timeout_ms: 60_000 }, ctx);
  };

  it('runs commands inside the container with the workspace mounted', async () => {
    writeFileSync(join(ws.dir, 'hello.txt'), 'from host');
    const r = await run('pwd && cat hello.txt && echo made-in-container > out.txt');
    expect(r.content).toContain('/workspace');
    expect(r.content).toContain('from host');
    expect(readFileSync(join(ws.dir, 'out.txt'), 'utf8')).toContain('made-in-container'); // writes land on the host
  }, 90_000);

  it('hides host files outside the workspace and host environment variables', async () => {
    process.env.NACRE_CONTAINER_TEST_VALUE = 'leak-me';
    try {
      const r = await run(
        'echo "env=[$NACRE_CONTAINER_TEST_VALUE]"; test -d /Users && echo HOST_USERS_VISIBLE || echo no-host-users; test -d /mnt/c && echo HOST_C_VISIBLE || echo no-host-c',
      );
      expect(r.content).toContain('env=[]');
      expect(r.content).not.toContain('leak-me');
      expect(r.content).toContain('no-host-users');
      expect(r.content).toContain('no-host-c');
    } finally {
      delete process.env.NACRE_CONTAINER_TEST_VALUE;
    }
  }, 90_000);

  it('has no network by default', async () => {
    const r = await run('ls /sys/class/net');
    expect(r.content.trim()).toBe('lo');
  }, 90_000);

  it('is killed on timeout and leaves no container behind', async () => {
    const cfg = testConfig().sandbox.container;
    const sb = new ContainerSandbox(ws.dir, { ...cfg, image });
    const ctx = {
      cwd: ws.dir,
      sandbox: sb,
      signal: new AbortController().signal,
      readState: new Map(),
      progress() {},
      config: testConfig(),
      agentId: 't',
    };
    const r = await bashTool.execute({ command: 'sleep 60', timeout_ms: 1000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('timed out');
    await new Promise((res) => setTimeout(res, 1500));
    const left = spawnSync('docker', ['ps', '-q', '--filter', 'name=nacre-'], {
      encoding: 'utf8',
    }).stdout.trim();
    expect(left).toBe('');
    expect(existsSync(ws.dir)).toBe(true);
  }, 90_000);
});
