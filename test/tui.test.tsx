import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime.js';
import { App } from '../src/tui/App.js';
import { UiStore } from '../src/tui/store.js';
import { NACRE } from '../src/tui/theme.js';
import { startMockLlm } from './mock-llm.js';
import { tmpWorkspace } from './helpers.js';

/** Strip ANSI escapes so assertions read like what a person sees. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

class FakeTty extends PassThrough {
  isTTY = true;
  columns = 110;
  rows = 40;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

let mock: Awaited<ReturnType<typeof startMockLlm>>;
beforeAll(async () => (mock = await startMockLlm()));
afterAll(() => mock.server.close());

async function boot(mode: 'ask' | 'auto' = 'ask') {
  const ws = tmpWorkspace();
  const home = join(ws.dir, '.home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({
      model: 'mock/m',
      approval: { mode },
      browser: { enabled: false },
      providers: { mock: { type: 'openai', baseUrl: mock.url } },
    }),
  );
  const work = join(ws.dir, 'work');
  mkdirSync(work);
  const runtime = await Runtime.create({
    cwd: work,
    env: { ...process.env, NACRE_HOME: home },
    ephemeral: true,
  });
  const store = new UiStore();
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const app = render(<App runtime={runtime} store={store} theme={NACRE} />, {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const screen = () => plain(out);
  const type = async (s: string) => {
    for (const ch of s) {
      stdin.write(ch);
      await sleep(4);
    }
  };
  return {
    runtime,
    work,
    screen,
    type,
    key: (s: string) => stdin.write(s),
    async stop() {
      app.unmount();
      await runtime.dispose();
      ws.cleanup();
    },
  };
}

describe('interactive UI', () => {
  it('renders the banner, streams a reply and shows markdown', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('Nacreframe'));
      await ui.type('hello there');
      ui.key('\r');
      await until(() => ui.screen().includes('mock model'));
      await until(() => ui.screen().includes('const x = 1;'));
      const s = ui.screen();
      expect(s).toContain('hello there'); // the user's message
      expect(s).toContain('inline code');
      expect(s).not.toContain('**mock**'); // bold markers were rendered, not printed
      expect(s).toMatch(/ask/); // footer mode
    } finally {
      await ui.stop();
    }
  });

  it('asks before writing a file in ask mode, and writes after approval', async () => {
    const ui = await boot('ask');
    try {
      await until(() => ui.screen().includes('Nacreframe'));
      await ui.type('write note.txt');
      ui.key('\r');
      await until(() => ui.screen().includes('Approval needed'));
      expect(existsSync(join(ui.work, 'note.txt'))).toBe(false);
      expect(ui.screen()).toContain('new file note.txt'); // diff preview
      await ui.type('y');
      await until(() => existsSync(join(ui.work, 'note.txt')));
      await until(() => ui.screen().includes('All done'));
    } finally {
      await ui.stop();
    }
  });

  it('denies a write when the user answers no', async () => {
    const ui = await boot('ask');
    try {
      await until(() => ui.screen().includes('Nacreframe'));
      await ui.type('write nope.txt');
      ui.key('\r');
      await until(() => ui.screen().includes('Approval needed'));
      await ui.type('n');
      await until(() => ui.screen().includes('All done'));
      expect(existsSync(join(ui.work, 'nope.txt'))).toBe(false);
    } finally {
      await ui.stop();
    }
  });

  it('shift+tab cycles the approval mode and slash commands work', async () => {
    const ui = await boot('ask');
    try {
      await until(() => ui.screen().includes('Nacreframe'));
      ui.key('\u001b[Z'); // shift+tab
      await until(() => ui.runtime.policy.mode === 'edits');
      await ui.type('/mode plan');
      ui.key('\r');
      await until(() => ui.runtime.policy.mode === 'plan');
      await ui.type('/sandbox off');
      ui.key('\r');
      await until(() => ui.runtime.sandbox.mode === 'off');
      await ui.type('/he');
      await until(() => ui.screen().includes('Show commands and shortcuts'));
    } finally {
      await ui.stop();
    }
  });

  it('runs a collaborating swarm and shows the live channel', async () => {
    const ui = await boot('auto');
    try {
      await until(() => ui.screen().includes('Nacreframe'));
      await ui.type('/swarm duo');
      ui.key('\r');
      await until(() => ui.screen().includes('Swarm "duo" is up'));
      await ui.type('hello team');
      ui.key('\r');
      await until(() => ui.screen().includes('hello team'));
      await until(() => ui.screen().includes('mock model')); // the lead replied
      expect(ui.screen()).toContain('planner');
      expect(ui.screen()).toContain('builder');
    } finally {
      await ui.stop();
    }
  });
});
