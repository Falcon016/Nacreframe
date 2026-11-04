import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { doctor, nodeIsNewEnough, type Check, type DoctorOptions } from '../src/doctor.js';
import type { Prompter } from '../src/setup/prompt.js';
import { tmpWorkspace } from './helpers.js';

/** Answers prompts from a script; running out of answers fails the test. */
class Answers implements Prompter {
  asked: string[] = [];
  constructor(
    private secrets: string[] = [],
    private confirms: boolean[] = [],
  ) {}
  select(): never {
    throw new Error('unexpected select');
  }
  async confirm(o: { message: string }) {
    this.asked.push(o.message);
    const a = this.confirms.shift();
    if (a === undefined) throw new Error(`unexpected confirm: ${o.message}`);
    return a;
  }
  text(): never {
    throw new Error('unexpected text');
  }
  async secret(o: { message: string }) {
    this.asked.push(o.message);
    const a = this.secrets.shift();
    if (a === undefined) throw new Error(`unexpected secret: ${o.message}`);
    return a;
  }
}

const ws = tmpWorkspace();
afterAll(() => ws.cleanup());

let n = 0;
/** A private home with its own settings folder, so nothing touches the real machine. */
function sandbox() {
  const home = join(ws.dir, `home${n++}`);
  const paths = { config: join(home, 'cfg'), data: join(home, 'data'), state: join(home, 'state') };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  const lines: string[] = [];
  const commands: string[][] = [];
  const opts: DoctorOptions = {
    env: { PATH: '/usr/bin' },
    paths,
    home,
    installRoot: join(home, 'not-an-install'),
    out: (l) => lines.push(l),
    interactive: false,
    runCommand: async (cmd, args) => {
      commands.push([cmd, ...args]);
      return 0;
    },
  };
  const text = () => lines.join('\n');
  const config = join(paths.config, 'config.json');
  return { home, paths, opts, lines, text, commands, config, cwd: home };
}

describe('nodeIsNewEnough', () => {
  it('compares the minor version too, not just the major', () => {
    expect(nodeIsNewEnough('22.17.9')).toBe(false); // the old check only looked at "22"
    expect(nodeIsNewEnough('22.18.0')).toBe(true);
    expect(nodeIsNewEnough('v22.23.4')).toBe(true);
    expect(nodeIsNewEnough('24.0.0')).toBe(true);
    expect(nodeIsNewEnough('20.19.0')).toBe(false);
  });
});

describe('nexus doctor', () => {
  let s: ReturnType<typeof sandbox>;
  beforeEach(() => {
    s = sandbox();
  });

  it('only offers a repair when nobody is there to ask, and changes nothing', async () => {
    writeFileSync(s.config, '{ not json');
    const code = await doctor(s.cwd, s.opts);
    expect(code).toBe(1);
    expect(s.text()).toContain('not valid JSON');
    expect(s.text()).toContain('doctor --fix');
    expect(readFileSync(s.config, 'utf8')).toBe('{ not json');
  });

  it('sets aside a settings file that is not valid JSON and carries on with defaults', async () => {
    writeFileSync(s.config, '{ not json');
    const code = await doctor(s.cwd, { ...s.opts, fix: true });
    expect(code).toBe(0);
    expect(existsSync(s.config)).toBe(false);
    const kept = readdirSync(s.paths.config).filter((f) => f.startsWith('config.json.broken-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(s.paths.config, kept[0]!), 'utf8')).toBe('{ not json'); // nothing is thrown away
    expect(s.text()).toContain('Checking again');
    expect(s.text()).toMatch(/✓ Config/);
  });

  it('does the same for settings that are valid JSON but not valid settings', async () => {
    writeFileSync(s.config, JSON.stringify({ approval: { mode: 'yolo' } }));
    expect(await doctor(s.cwd, s.opts)).toBe(1);
    expect(s.text()).toContain('approval.mode');
    expect(await doctor(s.cwd, { ...s.opts, fix: true })).toBe(0);
    expect(existsSync(s.config)).toBe(false);
  });

  it('asks for the API key of the model you actually use, and stores it', async () => {
    writeFileSync(s.config, JSON.stringify({ model: 'anthropic/claude-sonnet-5-5' }));
    const ask = new Answers(['  sk-test-123  ']);
    await doctor(s.cwd, { ...s.opts, fix: true, interactive: true, prompt: ask });
    expect(ask.asked).toEqual(['anthropic API key']); // not openai: it is not in use
    const stored = JSON.parse(readFileSync(join(s.paths.config, 'auth.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(stored.anthropic).toBe('sk-test-123');
    expect(s.text()).toMatch(/✓ Provider anthropic\s+API key found/);
  });

  it('skips fixes that need a person when there is no terminal', async () => {
    writeFileSync(s.config, JSON.stringify({ model: 'anthropic/claude-sonnet-5-5' }));
    await doctor(s.cwd, { ...s.opts, fix: true });
    expect(s.text()).toContain('needs a terminal');
    expect(existsSync(join(s.paths.config, 'auth.json'))).toBe(false);
  });

  it('points a fresh install at the setup wizard', async () => {
    let ran = 0;
    await doctor(s.cwd, {
      ...s.opts,
      fix: true,
      interactive: true,
      prompt: new Answers(),
      setup: async () => {
        ran++;
        writeFileSync(s.config, JSON.stringify({ model: 'ollama/qwen3:8b' }));
        return 0;
      },
    });
    expect(ran).toBe(1);
    expect(s.text()).toMatch(/Default model\s+none chosen yet/);
    expect(s.text().split('Checking again')[1]).not.toContain('Default model'); // the wizard's answer is picked up
  });

  it.skipIf(process.platform === 'win32')('makes a key file that other users can read private', async () => {
    const auth = join(s.paths.config, 'auth.json');
    writeFileSync(auth, '{"anthropic":"k"}');
    chmodSync(auth, 0o644);
    await doctor(s.cwd, s.opts);
    expect(s.text()).toContain('readable by other users');
    expect(statSync(auth).mode & 0o777).toBe(0o644);
    await doctor(s.cwd, { ...s.opts, fix: true });
    expect(statSync(auth).mode & 0o777).toBe(0o600);
  });

  it('creates the folders it writes to when they are missing', async () => {
    const missing = {
      config: join(s.home, 'new', 'cfg'),
      data: join(s.home, 'new', 'data'),
      state: join(s.home, 'new', 'state'),
    };
    await doctor(s.cwd, { ...s.opts, paths: missing, fix: true });
    expect(existsSync(missing.config)).toBe(true);
    expect(existsSync(missing.data)).toBe(true);
  });

  const machine =
    (over: Partial<Record<Check['id'], Partial<Check>>> = {}) =>
    async (): Promise<Check[]> =>
      (
        [
          { id: 'node', ok: true, label: 'Node.js', detail: 'v22.23.4' },
          { id: 'git', ok: true, label: 'git', detail: 'git version 2' },
          { id: 'browser', ok: true, label: 'Chrome / Edge', detail: '/usr/bin/google-chrome' },
        ] as Check[]
      ).map((c) => ({ ...c, ...over[c.id] }));

  it('asks before a big download, and --yes allows it', async () => {
    const noBrowser = machine({ browser: { ok: 'warn', detail: 'not found' } });
    await doctor(s.cwd, { ...s.opts, system: noBrowser, fix: true });
    expect(s.text()).toContain('doctor --fix --yes');
    expect(s.commands).toEqual([]);
    expect(existsSync(s.config)).toBe(false);

    const asked = sandbox();
    const ask = new Answers([], [false]);
    await doctor(asked.cwd, { ...asked.opts, system: noBrowser, fix: true, interactive: true, prompt: ask });
    expect(ask.asked[0]).toContain('Download Chromium');
    expect(asked.commands).toEqual([]); // "no" means no

    const yes = sandbox();
    await doctor(yes.cwd, { ...yes.opts, system: noBrowser, fix: true, yes: true });
    expect(yes.commands).toHaveLength(1);
    expect(yes.commands[0]!.slice(-2)).toEqual(['install', 'chromium']);
    expect(JSON.parse(readFileSync(yes.config, 'utf8'))).toMatchObject({ browser: { channel: 'chromium' } });
  });

  it('says plainly what to do about a missing git, which it cannot install for you', async () => {
    await doctor(s.cwd, {
      ...s.opts,
      system: machine({ git: { ok: 'warn', detail: 'not found' } }),
      fix: true,
    });
    expect(s.text()).toMatch(/! git\s+not found — install it with your package manager/);
  });

  describe.skipIf(process.platform === 'win32')('an installation made by install.sh', () => {
    const MARK = '# nexus launcher written by the NexusHarness installer';
    const setupInstall = (launcher: boolean, pathHasBin: boolean) => {
      const root = join(s.home, '.nexusharness');
      const bin = join(s.home, '.local', 'bin');
      mkdirSync(root, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(root, 'install.sh'), '#!/bin/sh\n');
      if (launcher) writeFileSync(join(bin, 'nexus'), `#!/bin/sh\n${MARK}\nNEXUS_DIR='${root}'\n`);
      return { root, bin, env: { PATH: pathHasBin ? `${bin}:/usr/bin` : '/usr/bin' } };
    };

    it('puts back a launcher that has gone missing, by running the installer in repair mode', async () => {
      const i = setupInstall(false, false);
      await doctor(s.cwd, { ...s.opts, installRoot: i.root, env: i.env, fix: true });
      expect(s.text()).toMatch(/! nexus command\s+missing/);
      expect(s.commands).toEqual([
        ['sh', join(i.root, 'install.sh'), '--repair', '--dir', i.root, '--bin-dir', i.bin],
      ]);
      expect(s.commands).toHaveLength(1); // the PATH problem shares the same fix and it runs once
    });

    it('repairs a Node.js that is too old by letting the installer fetch a private one', async () => {
      const i = setupInstall(true, true);
      await doctor(s.cwd, {
        ...s.opts,
        installRoot: i.root,
        env: i.env,
        fix: true,
        system: machine({ node: { ok: false, detail: 'v20.1.0 — need ≥ 22.18' } }),
      });
      expect(s.commands).toHaveLength(1);
      expect(s.commands[0]).toContain('--repair');
    });

    it('is happy when the launcher exists and its folder is on PATH', async () => {
      const i = setupInstall(true, true);
      await doctor(s.cwd, { ...s.opts, installRoot: i.root, env: i.env });
      expect(s.text()).toMatch(/✓ nexus command/);
      expect(s.text()).toMatch(/✓ PATH/);
    });

    it('warns when the folder is not on PATH, unless the shell profile already adds it', async () => {
      const i = setupInstall(true, false);
      await doctor(s.cwd, { ...s.opts, installRoot: i.root, env: i.env });
      expect(s.text()).toMatch(/! PATH\s+.*is not on it/);
      writeFileSync(
        join(s.home, '.bashrc'),
        '# >>> nexusharness >>>\nexport PATH="$HOME/.local/bin:$PATH"\n',
      );
      const after = sandbox();
      Object.assign(after.opts, { installRoot: i.root, env: i.env, home: s.home });
      await doctor(after.cwd, after.opts);
      expect(after.text()).toMatch(/✓ PATH\s+added to your shell profile/);
    });
  });
});
