import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Check } from '../src/doctor.js';
import { appPaths, type AppPaths } from '../src/paths.js';
import { applyPlan, mergeConfig, planFromFlags, planToPatch } from '../src/setup/plan.js';
import {
  Cancelled,
  parseKeys,
  TtyPrompter,
  type Choice,
  type Prompter,
  type SelectOptions,
  type TextOptions,
} from '../src/setup/prompt.js';
import { Term } from '../src/setup/ui.js';
import { runWizard } from '../src/setup/wizard.js';
import { tmpWorkspace } from './helpers.js';
import { startMockLlm } from './mock-llm.js';

// ---- helpers -------------------------------------------------------------------------------------

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8'));

/** Answers the wizard's questions from a script, by menu label, so the tests read like a conversation. */
class ScriptedPrompter implements Prompter {
  asked: string[] = [];
  menus: { message: string; choices: Choice<unknown>[] }[] = [];
  constructor(private script: (string | boolean | 'CANCEL')[]) {}

  private next(what: string): string | boolean {
    const a = this.script.shift();
    if (a === undefined) throw new Error(`Script ran out at: ${what}`);
    if (a === 'CANCEL') throw new Cancelled();
    return a;
  }
  async select<T>(o: SelectOptions<T>): Promise<T> {
    this.asked.push(o.message);
    this.menus.push({ message: o.message, choices: o.choices as Choice<unknown>[] });
    const want = this.next(o.message);
    const hit = o.choices.find((c) => c.label === want);
    if (!hit)
      throw new Error(
        `"${o.message}" has no choice "${String(want)}": ${o.choices.map((c) => c.label).join(' | ')}`,
      );
    if (hit.disabled) throw new Error(`"${hit.label}" is disabled: ${hit.disabled}`);
    return hit.value;
  }
  async confirm(o: { message: string }): Promise<boolean> {
    this.asked.push(o.message);
    return this.next(o.message) as boolean;
  }
  private typed(o: Pick<TextOptions, 'message' | 'validate'>): string {
    this.asked.push(o.message);
    const v = String(this.next(o.message));
    const problem = o.validate?.(v);
    if (problem) throw new Error(`"${o.message}" rejected "${v}": ${problem}`);
    return v;
  }
  async text(o: TextOptions): Promise<string> {
    return this.typed(o);
  }
  async secret(o: Omit<TextOptions, 'initial' | 'placeholder'>): Promise<string> {
    return this.typed(o);
  }
  assertDone() {
    expect(this.script, 'unused script entries').toEqual([]);
  }
}

const SYSTEM: Check[] = [
  { id: 'node', ok: true, label: 'Node.js', detail: 'v24.0.0' },
  { id: 'git', ok: true, label: 'git', detail: 'git version 2.45.0' },
  { id: 'browser', ok: 'warn', label: 'Chrome / Edge', detail: 'not found — set browser.channel' },
  {
    id: 'container',
    ok: 'warn',
    label: 'Container runtime',
    detail: 'none running — container sandbox unavailable',
  },
];

function capture() {
  let text = '';
  const term = new Term({
    out: { write: (s: string) => (text += s) },
    color: false,
    unicode: true,
    env: {},
  });
  return { term, output: () => text };
}

const GOOD_KEY = 'test-key-good-0001';
const BAD_KEY = 'test-key-bad-0002';

/** Anthropic's model list for the good key, 401 for anything else, and nothing else reachable. */
const fakeNetwork =
  (mock?: { url: string }): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (mock && url.startsWith(mock.url)) return fetch(input, init);
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      const key = new Headers(init?.headers).get('x-api-key');
      if (key === GOOD_KEY || key === 'env-key-from-shell')
        return Response.json({ data: [{ id: 'claude-test-1' }, { id: 'claude-test-2' }] });
      return new Response('{"error":"bad key"}', { status: 401 });
    }
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };

let ws: ReturnType<typeof tmpWorkspace>;
let paths: AppPaths;
beforeEach(() => {
  ws = tmpWorkspace();
  paths = appPaths({ NACRE_HOME: join(ws.dir, 'home') });
  mkdirSync(ws.dir + '/proj');
});
afterEach(() => ws.cleanup());

const configFile = () => join(paths.config, 'config.json');
const authFile = () => join(paths.config, 'auth.json');

function wizard(
  script: (string | boolean | 'CANCEL')[],
  extra: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; mock?: { url: string } } = {},
) {
  const prompt = new ScriptedPrompter([...script]);
  const out = capture();
  const run = () =>
    runWizard({
      term: out.term,
      prompt,
      env: { NACRE_HOME: join(ws.dir, 'home'), ...extra.env },
      cwd: join(ws.dir, 'proj'),
      paths,
      fetchImpl: extra.fetchImpl ?? fakeNetwork(extra.mock),
      systemChecks: async () => SYSTEM,
    });
  return { prompt, out, run };
}

// ---- the plan and the config file ----------------------------------------------------------------

describe('setup plan', () => {
  it('only writes what the user chose, and leaves a built-in provider alone', () => {
    expect(planToPatch({ provider: { id: 'anthropic', type: 'anthropic' }, approval: 'edits' })).toEqual({
      approval: { mode: 'edits' },
    });
    expect(
      planToPatch({
        provider: { id: 'ollama', type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1' },
        model: 'ollama/x',
        browser: false,
      }),
    ).toEqual({
      providers: { ollama: { type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1' } },
      model: 'ollama/x',
      browser: { enabled: false },
    });
  });

  it('merges nested objects but replaces lists and scalars', () => {
    expect(
      mergeConfig(
        { approval: { mode: 'ask', rules: [{ tool: 'bash' }] }, theme: 'mono', x: 1 },
        { approval: { mode: 'auto' }, x: 2 },
      ),
    ).toEqual({ approval: { mode: 'auto', rules: [{ tool: 'bash' }] }, theme: 'mono', x: 2 });
  });

  it('keeps unrelated settings, writes a .bak and stores the key outside config.json', () => {
    mkdirSync(paths.config, { recursive: true });
    const old = { theme: 'mono', approval: { mode: 'ask', rules: [{ tool: 'bash', action: 'deny' }] } };
    writeFileSync(configFile(), JSON.stringify(old));
    const r = applyPlan(
      {
        provider: { id: 'openai', type: 'openai' },
        apiKey: 'test-key-openai',
        approval: 'plan',
        model: 'openai/m',
      },
      paths,
    );
    expect(readJson(configFile())).toEqual({
      theme: 'mono',
      approval: { mode: 'plan', rules: [{ tool: 'bash', action: 'deny' }] },
      model: 'openai/m',
    });
    expect(readJson(r.backupPath!)).toEqual(old);
    expect(readFileSync(configFile(), 'utf8')).not.toContain('test-key-openai');
    expect(readJson(authFile())).toEqual({ openai: 'test-key-openai' });
    if (process.platform !== 'win32') expect(statSync(authFile()).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite (or back up) a config that would not change', () => {
    applyPlan({ approval: 'ask' }, paths);
    const r = applyPlan({ approval: 'ask' }, paths);
    expect(r.backupPath).toBeUndefined();
    expect(existsSync(configFile() + '.bak')).toBe(false);
  });

  it('sets aside a config.json that is not valid JSON instead of crashing', () => {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(configFile(), '{ nope');
    const r = applyPlan({ sandbox: 'guard' }, paths);
    expect(r.replacedInvalid).toBe(true);
    expect(readFileSync(r.backupPath!, 'utf8')).toBe('{ nope');
    expect(readJson(configFile())).toEqual({ sandbox: { mode: 'guard' } });
  });

  it('turns flags into a plan and explains mistakes', () => {
    expect(
      planFromFlags(
        { provider: 'ollama', model: 'qwen3:8b', approval: 'edits', 'no-browser': true },
        undefined,
      ),
    ).toEqual({
      plan: {
        provider: { id: 'ollama', type: 'openai' },
        model: 'ollama/qwen3:8b',
        approval: 'edits',
        browser: false,
      },
    });
    const err = (f: Parameters<typeof planFromFlags>[0], k?: string) =>
      (planFromFlags(f, k) as { error: string }).error;
    expect(err({ approval: 'yolo' })).toContain('ask, edits, auto, plan');
    expect(err({ sandbox: 'vm' })).toContain('off, guard, container');
    expect(err({ provider: 'mine' })).toContain('--base-url is required');
    expect(err({ provider: 'mine', 'base-url': 'ftp://x' })).toContain('http://');
    expect(err({ model: 'plain' })).toContain('<provider>/<model>');
    expect(err({ browser: true, 'no-browser': true })).toContain('not both');
    expect(err({}, 'secret')).toContain('no --provider');
    expect(err({ 'base-url': 'http://x/v1' })).toContain('needs --provider');
  });
});

// ---- the wizard ----------------------------------------------------------------------------------

describe('setup wizard', () => {
  it('walks through Anthropic, rejects a bad key, accepts a good one and saves everything', async () => {
    const w = wizard([
      'Anthropic',
      BAD_KEY,
      'Enter a different key',
      GOOD_KEY,
      'claude-test-2',
      'edits',
      'guard',
      false,
      'Save and finish',
    ]);
    expect(await w.run()).toBe(0);
    w.prompt.assertDone();
    expect(readJson(configFile())).toEqual({
      model: 'anthropic/claude-test-2',
      approval: { mode: 'edits' },
      sandbox: { mode: 'guard' },
      browser: { enabled: false },
    });
    expect(readJson(authFile())).toEqual({ anthropic: GOOD_KEY });
    const out = w.out.output();
    expect(out).toContain('Anthropic rejected that key');
    expect(out).toContain('Anthropic accepted the key');
    expect(out).toContain('You are all set');
    expect(out).not.toContain(GOOD_KEY);
    expect(out).not.toContain(BAD_KEY);
    expect(readFileSync(configFile(), 'utf8')).not.toContain(GOOD_KEY);
  });

  it('offers container only when a container runtime is running', async () => {
    const w = wizard(['Skip for now', 'ask', 'guard', false, 'Save and finish']);
    expect(await w.run()).toBe(0);
    const sandbox = w.prompt.menus.find((m) => m.message.includes('fenced'))!;
    expect(sandbox.choices.find((c) => c.label === 'container')?.disabled).toMatch(/Docker or Podman/);
    expect(readJson(configFile())).toEqual({
      approval: { mode: 'ask' },
      sandbox: { mode: 'guard' },
      browser: { enabled: false },
    });
  });

  it('asks twice before turning the sandbox off', async () => {
    const w = wizard(['Skip for now', 'ask', 'off', false, 'guard', false, 'Save and finish']);
    expect(await w.run()).toBe(0);
    w.prompt.assertDone();
    expect(readJson(configFile()).sandbox).toEqual({ mode: 'guard' });
  });

  it('reuses a key from the environment without asking for or storing one', async () => {
    const w = wizard(['Anthropic', true, 'claude-test-1', 'ask', 'guard', true, 'Save and finish'], {
      env: { ANTHROPIC_API_KEY: 'env-key-from-shell' },
    });
    expect(await w.run()).toBe(0);
    w.prompt.assertDone();
    expect(w.prompt.asked.some((q) => q.includes('API key') && !q.includes('already have'))).toBe(false);
    expect(existsSync(authFile())).toBe(false);
    expect(w.out.output()).toContain('key from $ANTHROPIC_API_KEY');
  });

  it('connects to any OpenAI-compatible server, lists its models and records the provider', async () => {
    const mock = await startMockLlm();
    try {
      const w = wizard(
        ['Something else', '', mock.url, '', 'mock-1', 'ask', 'guard', true, 'Save and finish'],
        {
          mock,
        },
      );
      expect(await w.run()).toBe(0);
      w.prompt.assertDone();
      expect(readJson(configFile())).toEqual({
        providers: { custom: { type: 'openai', baseUrl: mock.url } },
        model: 'custom/mock-1',
        approval: { mode: 'ask' },
        sandbox: { mode: 'guard' },
        browser: { enabled: true },
      });
      expect(existsSync(authFile())).toBe(false);
      expect(w.out.output()).toContain('2 models available');
    } finally {
      mock.server.close();
    }
  });

  it('helps when a local server is not running: start it, point elsewhere, or carry on', async () => {
    const mock = await startMockLlm();
    try {
      // 1) not running -> use a different address that works
      const a = wizard(
        ['Ollama', 'Use a different address', mock.url, 'mock-2', 'ask', 'guard', false, 'Save and finish'],
        {
          mock,
        },
      );
      expect(await a.run()).toBe(0);
      a.prompt.assertDone();
      expect(a.out.output()).toContain('Could not reach Ollama');
      expect(a.out.output()).toContain('ollama serve');
      expect(readJson(configFile())).toMatchObject({
        providers: { ollama: { type: 'openai', baseUrl: mock.url } },
        model: 'ollama/mock-2',
      });

      // 2) not running -> continue without checking, type a model name
      ws.cleanup();
      ws = tmpWorkspace();
      paths = appPaths({ NACRE_HOME: join(ws.dir, 'home') });
      mkdirSync(ws.dir + '/proj');
      const b = wizard([
        'Ollama',
        'Continue without checking',
        'qwen3:8b',
        'ask',
        'guard',
        false,
        'Save and finish',
      ]);
      expect(await b.run()).toBe(0);
      b.prompt.assertDone();
      expect(readJson(configFile()).model).toBe('ollama/qwen3:8b');
      expect(readJson(configFile()).providers).toBeUndefined(); // the built-in address needs no entry
    } finally {
      mock.server.close();
    }
  });

  it('can go back and pick another provider', async () => {
    const w = wizard([
      'Ollama',
      'Choose another provider',
      'Skip for now',
      'ask',
      'guard',
      false,
      'Save and finish',
    ]);
    expect(await w.run()).toBe(0);
    w.prompt.assertDone();
  });

  it('keeps everything else in an existing config and says where the old one went', async () => {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ theme: 'mono', mcpServers: { demo: { command: 'demo' } } }));
    const w = wizard(['Skip for now', 'plan', 'guard', false, 'Save and finish']);
    expect(await w.run()).toBe(0);
    expect(readJson(configFile())).toMatchObject({
      theme: 'mono',
      mcpServers: { demo: { command: 'demo' } },
      approval: { mode: 'plan' },
    });
    expect(existsSync(configFile() + '.bak')).toBe(true);
    expect(w.out.output()).toContain('config.json.bak');
  });

  it('starts over on request, and quits without writing anything', async () => {
    const again = wizard([
      'Skip for now',
      'auto',
      'guard',
      false,
      'Start over',
      'Skip for now',
      'ask',
      'guard',
      false,
      'Quit without saving',
    ]);
    expect(await again.run()).toBe(1);
    again.prompt.assertDone();
    expect(existsSync(configFile())).toBe(false);
    expect(again.out.output()).toContain('Nothing was saved');
  });

  it('treats Ctrl+C as a clean cancel and saves nothing', async () => {
    const w = wizard(['Anthropic', 'CANCEL']);
    expect(await w.run()).toBe(130);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(authFile())).toBe(false);
    expect(w.out.output()).toContain('Nothing was saved');
  });

  it('warns when an environment variable will override what was just saved', async () => {
    const w = wizard(['Skip for now', 'ask', 'guard', false, 'Save and finish'], {
      env: { NACRE_SANDBOX: 'off' },
    });
    expect(await w.run()).toBe(0);
    expect(w.out.output()).toContain('NACRE_SANDBOX is set in your environment');
  });

  it('explains a broken existing config instead of asking questions on top of it', async () => {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ approval: { mode: 'bogus' } }));
    const w = wizard([]);
    expect(await w.run()).toBe(1);
    expect(w.out.output()).toContain('Your current configuration has a problem');
    expect(w.prompt.asked).toEqual([]);
  });
});

// ---- the terminal prompter -----------------------------------------------------------------------

class FakeTty extends EventEmitter {
  isTTY = true;
  raw = false;
  setRawMode(m: boolean) {
    this.raw = m;
  }
  resume() {}
  pause() {}
  setEncoding() {}
  type(s: string) {
    this.emit('data', s);
  }
}

describe('terminal prompts', () => {
  const setup = () => {
    const stdin = new FakeTty();
    const out = capture();
    return { stdin, out, p: new TtyPrompter(stdin as never, out.term) };
  };
  const UP = '\x1b[A';
  const DOWN = '\x1b[B';
  const choices: Choice<string>[] = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Bravo', disabled: 'not today' },
    { value: 'c', label: 'Charlie', hint: 'third' },
  ];

  it('parses arrows, enter, pasted text and CRLF', () => {
    expect(parseKeys('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[3~\x1b[H\x1b[F')).toEqual(
      ['up', 'down', 'right', 'left', 'delete', 'home', 'end'].map((name) => ({ name })),
    );
    expect(parseKeys('ab\r\n')).toEqual([
      { name: 'char', char: 'a' },
      { name: 'char', char: 'b' },
      { name: 'enter' },
    ]);
    expect(parseKeys('\x03')).toEqual([{ name: 'ctrl-c' }]);
    expect(parseKeys('\x1b[1;5Cx')).toEqual([{ name: 'right' }, { name: 'char', char: 'x' }]);
  });

  it('moves with the arrow keys, skips disabled rows and restores the terminal', async () => {
    const { stdin, out, p } = setup();
    const answer = p.select({ message: 'Pick', choices });
    expect(stdin.raw).toBe(true);
    stdin.type(DOWN); // Alpha -> (Bravo is disabled) -> Charlie
    stdin.type('\r');
    expect(await answer).toBe('c');
    expect(stdin.raw).toBe(false);
    expect(out.output()).toContain('Pick');
    expect(out.output()).toMatch(/✓ Pick\s+Charlie/);
  });

  it('wraps around, and number keys jump to a row', async () => {
    const a = setup();
    const first = a.p.select({ message: 'Pick', choices });
    a.stdin.type(UP); // wraps from Alpha to Charlie
    a.stdin.type('\r');
    expect(await first).toBe('c');

    const b = setup();
    const second = b.p.select({ message: 'Pick', choices, initial: 2 });
    b.stdin.type('2'); // disabled: ignored
    b.stdin.type('1');
    b.stdin.type('\r');
    expect(await second).toBe('a');
  });

  it('answers yes/no with one key and honours the default on Enter', async () => {
    const a = setup();
    const yes = a.p.confirm({ message: 'Sure?', initial: false });
    a.stdin.type('Y');
    expect(await yes).toBe(true);
    const b = setup();
    const dflt = b.p.confirm({ message: 'Sure?', initial: false });
    b.stdin.type('\r');
    expect(await dflt).toBe(false);
  });

  it('edits text in place, validates on Enter and ignores a pasted line ending', async () => {
    const { stdin, p } = setup();
    const v = p.text({
      message: 'Name',
      initial: 'ab',
      validate: (s) => (s.length < 3 ? 'too short' : undefined),
    });
    stdin.type('\x1b[D'); // cursor between a and b
    stdin.type('X');
    stdin.type('\r'); // "aXb" is long enough
    expect(await v).toBe('aXb');

    const w = setup();
    const bad = w.p.text({ message: 'Name', validate: (s) => (s.length < 3 ? 'too short' : undefined) });
    w.stdin.type('hi\r');
    expect(w.out.output()).toContain('too short');
    w.stdin.type('\x7f\x7f\x7fabcd\r\n');
    expect(await bad).toBe('abcd');
  });

  it('never shows a secret on screen', async () => {
    const { stdin, out, p } = setup();
    const k = p.secret({ message: 'Key' });
    stdin.type('super-secret-value');
    stdin.type('\r');
    expect(await k).toBe('super-secret-value');
    expect(out.output()).not.toContain('super-secret');
    expect(out.output()).toContain('••••');
  });

  it('rejects with Cancelled on Ctrl+C and leaves raw mode', async () => {
    const { stdin, p } = setup();
    const answer = p.select({ message: 'Pick', choices });
    stdin.type('\x03');
    await expect(answer).rejects.toBeInstanceOf(Cancelled);
    expect(stdin.raw).toBe(false);
  });
});

// ---- the command ---------------------------------------------------------------------------------

describe('nacre setup (command line)', () => {
  const TSX = resolve('node_modules/tsx/dist/cli.mjs');
  const CLI = resolve('src/cli.tsx');
  let cws: ReturnType<typeof tmpWorkspace>;
  beforeAll(() => {
    cws = tmpWorkspace();
  });
  afterAll(() => cws.cleanup());
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [TSX, CLI, 'setup', ...args], {
      env: { ...process.env, NACRE_HOME: join(cws.dir, 'home'), NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      cwd: cws.dir,
      ...(input !== undefined ? { input } : {}),
    });

  it('shows help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--key-stdin');
  });

  it('refuses to run the wizard without a terminal, and says what to do instead', () => {
    const r = run([], '');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('interactive terminal');
    expect(r.stderr).toContain('--yes');
  });

  it('applies flags without asking, taking the key from stdin', () => {
    const r = run(
      [
        '--yes',
        '--provider',
        'anthropic',
        '--key-stdin',
        '-m',
        'claude-test-1',
        '--approval',
        'edits',
        '--no-browser',
      ],
      'test-key-stdin-0003\n',
    );
    expect(r.status, r.stderr).toBe(0);
    const home = join(cws.dir, 'home', 'config');
    expect(readJson(join(home, 'config.json'))).toEqual({
      model: 'anthropic/claude-test-1',
      approval: { mode: 'edits' },
      browser: { enabled: false },
    });
    expect(readJson(join(home, 'auth.json'))).toEqual({ anthropic: 'test-key-stdin-0003' });
    expect(r.stdout).not.toContain('test-key-stdin');
  });

  it('rejects bad options with exit code 2 and a clear message', () => {
    expect(run(['--yes', '--approval', 'yolo']).stderr).toContain('--approval must be one of');
    expect(run(['--yes', '--approval', 'yolo']).status).toBe(2);
    const unknown = run(['--yes', '--model', 'nowhere/x']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Known providers');
    expect(run(['--bogus']).status).toBe(2);
  });

  it('says so when there is nothing to change', () => {
    const r = run(['--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nothing to change');
  });
});
