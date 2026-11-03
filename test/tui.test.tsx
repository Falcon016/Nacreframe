import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime.js';
import { App } from '../src/tui/App.js';
import { UiStore } from '../src/tui/store.js';
import { NACRE } from '../src/tui/theme.js';
import { startMockLlm } from './mock-llm.js';
import { tmpWorkspace } from './helpers.js';

/** Strip ANSI escapes so assertions read like what a person sees. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// CI runners (Windows especially) can be slow when other test files run alongside this one.
vi.setConfig({ testTimeout: 60_000 });

async function until(cond: () => boolean, ms = 25_000): Promise<void> {
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
    // Ink switches to "print only the last frame" when it sees CI=true; the fake terminal here is interactive.
    interactive: true,
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
    stdout,
    raw: () => out,
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
      await until(() => ui.screen().includes('nacreframe'));
      // The welcome panel: wordmark set into the top edge of a frame, the mascot, and the keys worth knowing.
      const welcome = ui.screen();
      expect(welcome).toMatch(/╭─\[●\] nacreframe ─+ v\d+\.\d+\.\d+ ─╮/);
      expect(welcome).toContain('▀'); // the mascot is half-block pixel art
      expect(welcome).toContain('/swarm duo');
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
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('write note.txt');
      ui.key('\r');
      await until(() => ui.screen().includes('Approve this action?'));
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
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('write nope.txt');
      ui.key('\r');
      await until(() => ui.screen().includes('Approve this action?'));
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
      await until(() => ui.screen().includes('nacreframe'));
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
      await until(() => ui.screen().includes('nacreframe'));
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

  it('starts from a clean screen and reprints everything after the window is resized', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      const before = ui.raw().length;
      // Going fullscreen: the terminal reflows what is on screen, so redrawing in place would leave ghosts.
      ui.stdout.columns = 160;
      ui.stdout.rows = 50;
      ui.stdout.emit('resize');
      await until(() => ui.raw().slice(before).includes('\x1b[2J\x1b[3J\x1b[H'));
      await until(() => ui.raw().slice(ui.raw().lastIndexOf('\x1b[2J')).includes('nacreframe'));
      // A resize that ends where it started changes nothing.
      const settled = ui.raw().length;
      ui.stdout.columns = 120;
      ui.stdout.emit('resize');
      ui.stdout.columns = 160;
      ui.stdout.emit('resize');
      await sleep(400);
      expect(ui.raw().slice(settled)).not.toContain('\x1b[2J');
    } finally {
      await ui.stop();
    }
  });
});
