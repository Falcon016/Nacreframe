import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectKey } from '../src/paths.js';
import { Runtime } from '../src/runtime.js';
import { App } from '../src/tui/App.js';
import { BUILTINS } from '../src/tui/commands.js';
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
  it('has one command per name, and the menu shows each once without React key warnings', async () => {
    const names = BUILTINS.map((c) => c.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('/skill');
      await until(() => ui.screen().includes('List the skills'));
      await sleep(100);
      expect(errors.filter((e) => /same key/.test(e))).toEqual([]);
    } finally {
      spy.mockRestore();
      await ui.stop();
    }
  });

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
      // The dialog is drawn a moment before its key handler is listening; a keypress in between is lost.
      // That gap grows on a busy CI runner, which is what made this test flaky.
      await sleep(250);
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
      await sleep(250); // see above: let the dialog start listening
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

  it('builds a custom swarm from the quick form and starts it', async () => {
    const ui = await boot('auto');
    try {
      await until(() => ui.screen().includes('nacreframe'));
      const press = async (k: string, wait: string) => {
        const mark = ui.raw().length;
        ui.key(k);
        await until(() => plain(ui.raw().slice(mark)).includes(wait));
        await sleep(60);
      };
      await ui.type('/swarm custom architect builder security');
      await press('\r', 'How many messages may the agents send each other');
      ui.key('\u001b[B'); // 60 (current) → 120
      await sleep(40);
      ui.key('\u001b[B'); // → 250
      await sleep(40);
      await press('\r', 'How many tool calls may one agent make');
      await press('\r', 'Start this team?'); // keep the current tool-call limit
      expect(ui.screen()).toContain('security: Security advisor.');
      expect(ui.screen()).toContain('Limits saved to your config: 250 messages');
      await press('\r', 'Swarm is up: architect, builder, security');
      expect(ui.runtime.swarm?.names).toEqual(['architect', 'builder', 'security']);
      // The limit is in the config file and on the counter beside the context meter.
      const cfg = JSON.parse(readFileSync(join(dirname(ui.work), '.home', 'config', 'config.json'), 'utf8'));
      expect(cfg.swarm.maxMessages).toBe(250);
      await until(() => /messages 0\/250\s+context/.test(ui.screen()));
    } finally {
      ui.runtime.stopSwarm();
      await ui.stop();
    }
  });

  it('walks through /swarm custom: size, lead, roles and a role of your own', async () => {
    const ui = await boot('auto');
    const press = async (k: string, wait: string) => {
      const mark = ui.raw().length;
      ui.key(k);
      await until(() => plain(ui.raw().slice(mark)).includes(wait));
      await sleep(60);
    };
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('/swarm custom');
      await press('\r', 'How many agents?');
      await press('\r', 'Who leads?'); // 3 agents is highlighted
      await press('\r', 'Agent 2 of 3'); // Planner
      await press('\r', 'Agent 3 of 3'); // Builder
      for (let i = 0; i < 6; i++) {
        ui.key('\u001b[B');
        await sleep(40);
      }
      await press('\r', 'one-word name'); // Write my own role
      await ui.type('perf');
      await press('\r', 'What should perf do?');
      await ui.type('Profile the hot paths');
      await press('\r', 'How many messages may the agents send each other');
      await press('\r', 'How many tool calls may one agent make');
      await press('\r', 'Start this team?');
      expect(ui.screen()).toContain('perf: Profile the hot paths. Report back to planner.');
      await press('\r', 'Swarm is up');
      expect(ui.runtime.swarm?.names).toEqual(['planner', 'builder', 'perf']);
    } finally {
      ui.runtime.stopSwarm();
      await ui.stop();
    }
  });

  it('asks before /flush deletes anything, defaults to keeping it, and deletes on yes', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      // This test runtime keeps its own conversation in memory; put a saved one where /flush looks.
      const saved = join(dirname(ui.work), '.home', 'data', 'sessions', projectKey(ui.runtime.cwd));
      mkdirSync(saved, { recursive: true });
      const other = join(saved, 'older.jsonl');
      writeFileSync(other, '{"type":"session"}\n');
      await ui.type('/flush all');
      ui.key('\r');
      await until(() => ui.screen().includes('cannot be undone'));
      ui.key('\r'); // the highlighted choice is "Keep everything"
      await until(() => ui.screen().includes('Nothing was deleted.'));
      expect(existsSync(other)).toBe(true);

      const mark = ui.raw().length;
      await ui.type('/flush all');
      ui.key('\r');
      await until(() => ui.raw().slice(mark).includes('cannot be undone'));
      await sleep(100);
      ui.key('\u001b[A'); // up to "Delete"
      await sleep(100);
      ui.key('\r');
      await until(() => ui.screen().includes('Deleted 1 conversation'));
      expect(existsSync(other)).toBe(false);
    } finally {
      await ui.stop();
    }
  });

  it('folds reasoning into one line, and ctrl+t shows it in full', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('think about it');
      ui.key('\r');
      await until(() => ui.screen().includes('Thought it through: the answer is 42.'));
      expect(ui.screen()).toMatch(/✻ thought/);
      expect(ui.screen()).not.toContain('Step one: read the request.');
      const mark = ui.raw().length;
      ui.key('\u0014'); // ctrl+t
      await until(() => plain(ui.raw().slice(mark)).includes('Step one: read the request.'));
      expect(plain(ui.raw().slice(mark))).toContain('thinking shown');
      expect(ui.raw().slice(mark)).toContain('\x1b[2J'); // the transcript was reprinted, not appended to
    } finally {
      await ui.stop();
    }
  });

  it('separates inline <think> reasoning from the answer', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('/thinking on');
      ui.key('\r');
      await until(() => ui.screen().includes('Showing thinking'));
      await ui.type('ponder this');
      ui.key('\r');
      await until(() => ui.screen().includes('Pondered: the answer is 42.'));
      const s = ui.screen();
      expect(s).toContain('Pondering inline, the way small local models do.');
      expect(s).not.toContain('<think>');
    } finally {
      await ui.stop();
    }
  });

  it('explains how to update a copy that was not installed with the installer', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('/update');
      ui.key('\r');
      await until(() => /cannot update itself|POSIX installer/.test(ui.screen()));
    } finally {
      await ui.stop();
    }
  });

  it('streams reasoning as wrapped lines while the model thinks', async () => {
    const ui = await boot();
    try {
      await until(() => ui.screen().includes('nacreframe'));
      await ui.type('/thinking on');
      ui.key('\r');
      await until(() => ui.screen().includes('Showing thinking'));
      await ui.type('deliberate please');
      ui.key('\r');
      // Mid-stream, the live block holds whole wrapped lines from the start of the reasoning, not a sliding tail.
      // The first paragraph has no line break, yet it already spans two lines of the live block.
      await until(() =>
        /│ Let me work through this carefully before answering\.[^\n]*\n\s*│ \w/.test(ui.screen()),
      );
      expect(ui.screen()).not.toContain('Deliberated: the plan is ready.'); // still thinking at that point
      await until(() => ui.screen().includes('Deliberated: the plan is ready.'));
    } finally {
      await ui.stop();
    }
  });
});
