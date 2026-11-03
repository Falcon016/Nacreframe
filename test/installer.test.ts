import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpWorkspace } from './helpers.js';

const SCRIPT = resolve('install.sh');
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;
// Where the installer puts the PATH entry for bash: macOS shells read .bash_profile, Linux ones .bashrc.
const RC_NAME = process.platform === 'darwin' ? '.bash_profile' : '.bashrc';

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

  const oldNode = () => {
    const stub = join(ws.dir, 'old-node');
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, 'node'), '#!/bin/sh\necho v18.19.0\n');
    chmodSync(join(stub, 'node'), 0o755);
    return stub;
  };

  it('replaces a Node.js that is too old, and says what to do if it cannot', () => {
    // It offers a private copy by default; with the download unreachable it stops and explains.
    const r = sh(['--yes'], { PATH: `${oldNode()}:${process.env.PATH}`, NACRE_NODE_DIST: 'file:///nowhere' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Node.js is too old');
    expect(r.stdout).toContain('v18.19.0');
    expect(r.stderr).toContain('Could not install Node.js');
    expect(r.stderr).toContain('22.18');
    expect(existsSync(join(home, '.nacreframe', 'package.json'))).toBe(false);
  });

  it('points to Node.js downloads on systems it has no build for', () => {
    const stub = join(ws.dir, 'odd-uname');
    mkdirSync(stub);
    writeFileSync(join(stub, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo SunOS ;; *) echo sparc ;; esac\n');
    chmodSync(join(stub, 'uname'), 0o755);
    const r = sh(['--yes'], { PATH: `${oldNode()}:${stub}:${process.env.PATH}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no official Node.js download');
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
    // `nacre` is a small launcher (it can use a private Node.js and repairs a damaged install), not a symlink.
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(lstatSync(link).mode & 0o111).not.toBe(0);
    expect(readFileSync(link, 'utf8')).toContain(`NACRE_DIR='${join(home, '.nacreframe')}'`);
    expect(existsSync(join(home, '.nacreframe', 'node_modules', 'typescript'))).toBe(false); // dev tools pruned

    const rc = readFileSync(join(home, RC_NAME), 'utf8');
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
    expect(readFileSync(join(home, RC_NAME), 'utf8').match(/>>> nacreframe >>>/g)).toHaveLength(1);

    // ---- a new version upstream is picked up ----
    const pkgPath = join(source, 'package.json');
    writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    git(source, 'commit', '-qam', 'bump');
    const update = sh(['--yes']);
    expect(update.status, update.stdout + update.stderr).toBe(0);
    expect(update.stdout).toMatch(/Downloaded Nacreframe 9\.9\.9/);
    expect(update.stdout).toContain('was 0.1.0');

    // ---- `nacre update` does the same from the installed command, following the installed branch ----
    expect(readFileSync(join(home, '.nacreframe', '.nacre-ref'), 'utf8').trim()).toBe('main');
    const nacre = (...args: string[]) =>
      spawnSync(link, args, { encoding: 'utf8', env: { ...env, NO_COLOR: '1' }, timeout: 280_000 });
    expect(nacre('update', '--check').stdout).toContain('is up to date');
    writeFileSync(
      pkgPath,
      readFileSync(pkgPath, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.10"'),
    );
    git(source, 'commit', '-qam', 'Add the frobnicator');
    const check = nacre('update', '--check');
    expect(check.stdout).toContain('9.9.10 is available (you have 9.9.9');
    expect(check.stdout).toContain('Latest change: Add the frobnicator');
    expect(nacre('--version').stdout).toContain('9.9.9'); // --check changed nothing
    const upd = nacre('update');
    expect(upd.status, upd.stdout + upd.stderr).toBe(0);
    expect(nacre('--version').stdout).toContain('9.9.10');
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
    expect(existsSync(join(other, RC_NAME))).toBe(false);
    expect(r.stdout).toContain('is not on your PATH');
    expect(r.stdout).toContain('export PATH=');
    expect(lstatSync(join(other, 'bin', 'nacre')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(other, 'bin', 'nacre'), 'utf8')).toContain('NACRE_DIR=');
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

  // ---- a machine that is missing things -------------------------------------------------------------

  /** A PATH holding only the basic tools the installer needs, so Node.js (or git) is genuinely absent. */
  const bareTools = (name: string, omit: string[] = []) => {
    const dir = join(ws.dir, name);
    mkdirSync(dir);
    const tools = `sh git curl tar gzip grep sed tr cut head tail awk mktemp uname sleep ls cat rm mkdir mv cp
      chmod ln readlink dirname basename id kill date sha256sum shasum openssl find env xargs wc sort touch ldd`;
    for (const t of tools.split(/\s+/)) {
      if (omit.includes(t)) continue;
      const found = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, join(dir, t));
    }
    return dir;
  };
  const nodePlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const nodeArch = { x64: 'x64', arm64: 'arm64' }[process.arch as string];

  /** A stand-in for nodejs.org: the tarball holds shims that run the Node.js already on this machine. */
  const fakeNodeDist = (name: string, corrupt = false) => {
    const dir = join(ws.dir, name);
    const top = `node-v22.99.0-${nodePlatform}-${nodeArch}`;
    mkdirSync(join(dir, top, 'bin'), { recursive: true });
    const npmPath = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
    for (const [bin, target] of [
      ['node', process.execPath],
      ['npm', npmPath],
    ] as const) {
      writeFileSync(join(dir, top, 'bin', bin), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(dir, top, 'bin', bin), 0o755);
    }
    const tgz = `${top}.tar.gz`;
    expect(spawnSync('tar', ['-czf', tgz, top], { cwd: dir }).status).toBe(0);
    const sum = createHash('sha256')
      .update(readFileSync(join(dir, tgz)))
      .digest('hex');
    writeFileSync(join(dir, 'SHASUMS256.txt'), `${corrupt ? '0'.repeat(64) : sum}  ${tgz}\n`);
    return `file://${dir}`;
  };

  it.skipIf(!nodeArch)(
    'installs a private Node.js when there is none, and the nacre command uses it',
    () => {
      const bare = join(ws.dir, 'home-bare');
      mkdirSync(bare);
      const dist = fakeNodeDist('node-dist');
      const env = { PATH: bareTools('tools-nonode', ['node', 'npm', 'npx']), NACRE_NODE_DIST: dist };
      const r = sh(['--yes'], env, bare);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Installed Node\.js v\d+\.\d+\.\d+, private copy/);
      const nodeBin = join(bare, '.nacreframe', 'runtime', 'node', 'bin', 'node');
      expect(existsSync(nodeBin)).toBe(true);

      // Still no Node.js on PATH: the launcher finds the private one.
      const cmd = join(bare, '.local', 'bin', 'nacre');
      const run = (args: string[]) =>
        spawnSync(cmd, args, {
          encoding: 'utf8',
          env: { PATH: env.PATH, HOME: bare, NACRE_HOME: join(bare, 'nh'), NACRE_REPO: source },
        });
      expect(run(['--version']).stdout).toMatch(/^Nacreframe \d+\.\d+\.\d+/);

      // Damage the install: the next `nacre` repairs it before starting.
      rmSync(join(bare, '.nacreframe', 'node_modules'), { recursive: true, force: true });
      rmSync(join(bare, '.nacreframe', 'dist'), { recursive: true, force: true });
      const healed = run(['--version']);
      expect(healed.stderr).toContain('missing or damaged');
      expect(healed.stdout).toMatch(/^Nacreframe \d+\.\d+\.\d+/);
      expect(existsSync(join(bare, '.nacreframe', 'dist', 'cli.js'))).toBe(true);

      // A later run reuses the private copy instead of downloading again.
      const again = sh(['--yes', '--no-modify-path'], env, bare);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(again.stdout).toContain('(private copy)');
    },
    290_000,
  );

  it.skipIf(!nodeArch)('refuses a Node.js download whose checksum does not match', () => {
    const other = join(ws.dir, 'home-badsum');
    mkdirSync(other);
    const r = sh(
      ['--yes'],
      {
        PATH: bareTools('tools-badsum', ['node', 'npm', 'npx']),
        NACRE_NODE_DIST: fakeNodeDist('bad-dist', true),
      },
      other,
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('Checksum mismatch');
    expect(existsSync(join(other, '.nacreframe', 'runtime', 'node'))).toBe(false);
  });

  it('says how to get git when it is missing, and never runs sudo on its own', () => {
    const other = join(ws.dir, 'home-nogit');
    mkdirSync(other);
    const tools = bareTools('tools-nogit', ['git']);
    symlinkSync(process.execPath, join(tools, 'node')); // Node.js is fine; only git is missing
    const r = sh(['--yes'], { PATH: tools }, other);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('git was not found');
    expect(r.stdout + r.stderr).toContain('run this installer again');
    expect(readdirSync(other)).toEqual([]);
  });

  it('uninstalls: removes the program, link and PATH entry, keeps your settings', () => {
    const r = sh(['--uninstall']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(home, '.nacreframe'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'nacre'))).toBe(false);
    expect(readFileSync(join(home, RC_NAME), 'utf8')).not.toContain('nacreframe');
    expect(existsSync(join(home, 'nacre-home', 'config', 'config.json'))).toBe(true);
    expect(r.stdout).toContain('settings, API keys and sessions were kept');
    // And a second uninstall is harmless.
    expect(sh(['--uninstall']).status).toBe(0);
  }, 60_000);
});
