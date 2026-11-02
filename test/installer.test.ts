import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpWorkspace } from './helpers.js';

const SCRIPT = resolve('install.sh');
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasSh || !hasGit)('install.sh', () => {
  let ws: ReturnType<typeof tmpWorkspace>;
  let source: string; // a git repository holding a copy of this working tree
  let home: string;

  const sh = (args: string[], extra: NodeJS.ProcessEnv = {}, who = home) =>
    spawnSync('sh', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 280_000,
      env: {
        ...process.env,
        HOME: who,
        SHELL: '/bin/bash',
        NO_COLOR: '1',
        NACRE_REPO: source,
        NACRE_HOME: join(who, 'nacre-home'),
        npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
        TMPDIR: ws.dir,
        ...extra,
      },
    });
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });

  beforeAll(() => {
    ws = tmpWorkspace();
    home = join(ws.dir, 'home');
    mkdirSync(home);
    source = join(ws.dir, 'source');
    mkdirSync(source);
    const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
    }).stdout.split('\0');
    for (const f of list) {
      if (!f || !existsSync(f)) continue;
      mkdirSync(dirname(join(source, f)), { recursive: true });
      cpSync(f, join(source, f));
    }
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '-A');
    expect(git(source, 'commit', '-qm', 'snapshot').status).toBe(0);
  }, 60_000);
  afterAll(() => ws?.cleanup());

  it('is valid POSIX shell and documents its options', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
    const help = sh(['--help']);
    expect(help.status).toBe(0);
    for (const flag of [
      '--yes',
      '--no-setup',
      '--no-modify-path',
      '--ref',
      '--dir',
      '--bin-dir',
      '--uninstall',
    ])
      expect(help.stdout).toContain(flag);
    expect(help.stdout).toContain('| sh');
  });

  it('rejects unknown options without touching anything', () => {
    const r = sh(['--frobnicate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown option: --frobnicate');
    expect(existsSync(join(home, '.nacreframe'))).toBe(false);
  });

  it('stops with a helpful message when Node.js is too old', () => {
    const stub = join(ws.dir, 'old-node');
    mkdirSync(stub);
    writeFileSync(join(stub, 'node'), '#!/bin/sh\necho v18.19.0\n');
    chmodSync(join(stub, 'node'), 0o755);
    const r = sh(['--yes'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Node.js v18.19.0 is too old');
    expect(r.stderr).toContain('22.18');
    expect(r.stderr).toContain('fnm');
    expect(existsSync(join(home, '.nacreframe'))).toBe(false);
  });

  it('sends native Windows shells to WSL or the manual steps', () => {
    const stub = join(ws.dir, 'fake-uname');
    mkdirSync(stub);
    writeFileSync(join(stub, 'uname'), '#!/bin/sh\necho MINGW64_NT-10.0\n');
    chmodSync(join(stub, 'uname'), 0o755);
    const r = sh(['--yes'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Linux, macOS and WSL');
    expect(r.stdout).toContain('npm link');
  });

  it('installs, updates, runs on its own and uninstalls cleanly', () => {
    // ---- fresh install ----
    const first = sh(['--yes']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('Nacreframe is installed.');
    const link = join(home, '.local', 'bin', 'nacre');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(home, '.nacreframe', 'dist', 'cli.js'));
    expect(existsSync(join(home, '.nacreframe', 'node_modules', 'typescript'))).toBe(false); // dev tools pruned

    const rc = readFileSync(join(home, '.bashrc'), 'utf8');
    expect(rc).toContain('# >>> nacreframe >>>');
    expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"');

    // The installed command works, and so does its wizard in scripted mode.
    const env = { ...process.env, HOME: home, NACRE_HOME: join(home, 'nacre-home') };
    const version = spawnSync(link, ['--version'], { encoding: 'utf8', env });
    expect(version.stdout).toMatch(/^Nacreframe \d+\.\d+\.\d+/);
    const setup = spawnSync(link, ['setup', '--yes', '--provider', 'ollama', '--model', 'qwen3:8b'], {
      encoding: 'utf8',
      env,
    });
    expect(setup.status, setup.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'nacre-home', 'config', 'config.json'), 'utf8'))).toMatchObject(
      {
        model: 'ollama/qwen3:8b',
      },
    );

    // ---- running it again changes nothing, and does not duplicate the PATH entry ----
    const again = sh(['--yes'], { PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}` });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('is already up to date');
    expect(again.stdout).toContain('Nacreframe is up to date.');
    expect(readFileSync(join(home, '.bashrc'), 'utf8').match(/>>> nacreframe >>>/g)).toHaveLength(1);

    // ---- a new version upstream is picked up ----
    const pkgPath = join(source, 'package.json');
    writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    git(source, 'commit', '-qam', 'bump');
    const update = sh(['--yes']);
    expect(update.status, update.stdout + update.stderr).toBe(0);
    expect(update.stdout).toMatch(/Downloaded Nacreframe 9\.9\.9/);
    expect(update.stdout).toContain('was 0.1.0');
  }, 290_000);

  it('can leave profile files alone, and says how to finish by hand', () => {
    const other = join(ws.dir, 'home2');
    mkdirSync(other);
    // Reuses the finished build, so this is quick.
    const r = sh(
      ['--yes', '--no-modify-path', '--dir', join(home, '.nacreframe'), '--bin-dir', join(other, 'bin')],
      {},
      other,
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(other, '.bashrc'))).toBe(false);
    expect(r.stdout).toContain('is not on your PATH');
    expect(r.stdout).toContain('export PATH=');
    expect(lstatSync(join(other, 'bin', 'nacre')).isSymbolicLink()).toBe(true);
  }, 120_000);

  it('refuses to overwrite a folder or command it does not own', () => {
    const squat = join(ws.dir, 'home3');
    mkdirSync(join(squat, '.nacreframe'), { recursive: true });
    writeFileSync(join(squat, '.nacreframe', 'precious.txt'), 'keep me');
    const folder = sh(['--yes'], {}, squat);
    expect(folder.status).toBe(1);
    expect(folder.stderr).toContain('is not a Nacreframe install');
    expect(readFileSync(join(squat, '.nacreframe', 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('uninstalls: removes the program, link and PATH entry, keeps your settings', () => {
    const r = sh(['--uninstall']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(home, '.nacreframe'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'nacre'))).toBe(false);
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).not.toContain('nacreframe');
    expect(existsSync(join(home, 'nacre-home', 'config', 'config.json'))).toBe(true);
    expect(r.stdout).toContain('settings, API keys and sessions were kept');
    // And a second uninstall is harmless.
    expect(sh(['--uninstall']).status).toBe(0);
  }, 60_000);
});
