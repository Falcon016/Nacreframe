import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInstall } from './doctor.js';
import { BIN } from './version.js';

/**
 * Updating an installer-made copy: check the branch it was installed from for a newer commit, then run the
 * installer that is already on disk in update mode (it downloads, reinstalls dependencies, rebuilds and
 * relinks). If the download fails nothing on disk changes; `nacre doctor --fix` repairs a half-finished one.
 */

export interface UpdateCheck {
  root: string;
  binDir: string;
  ref: string;
  repo: string;
  current: { version: string; commit: string };
  latest: { version: string; commit: string; subject: string };
  upToDate: boolean;
}

export type UpdateResult = { ok: true; check: UpdateCheck } | { ok: false; error: string };

const git = (cwd: string, args: string[], timeout = 60_000): Promise<string> =>
  new Promise((res, rej) =>
    execFile(
      'git',
      args,
      { cwd, timeout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout.trim())),
    ),
  );

const versionOf = (pkg: string): string => {
  try {
    return (JSON.parse(pkg) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
};

/** The folder this copy runs from (the one holding dist/ and node_modules/). */
export const installRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The manual steps, for copies the installer did not make. */
export function manualUpdateHint(root: string): string {
  return existsSync(join(root, '.git'))
    ? `This copy was not installed with install.sh, so it cannot update itself. In ${root}, run:\n  git pull && npm ci && npm run build`
    : `This copy was not installed with install.sh, so it cannot update itself. Reinstall with:\n  curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh`;
}

export async function checkForUpdate(
  root = installRoot(),
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<UpdateResult> {
  if (process.platform === 'win32')
    return {
      ok: false,
      error:
        'Updating from inside Nacreframe needs the POSIX installer (Linux, macOS or WSL). On Windows: git pull && npm ci && npm run build',
    };
  const install = detectInstall(root, env, home);
  if (!install || !existsSync(join(root, '.git'))) return { ok: false, error: manualUpdateHint(root) };
  let ref = 'main';
  try {
    ref = readFileSync(join(root, '.nacre-ref'), 'utf8').trim() || 'main';
  } catch {
    /* installed before the installer recorded its branch: it defaulted to main */
  }
  try {
    const repo = await git(root, ['remote', 'get-url', 'origin']);
    const commit = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['fetch', '-q', '--depth', '1', 'origin', ref]);
    const latestCommit = await git(root, ['rev-parse', 'FETCH_HEAD']);
    const latestPkg = await git(root, ['show', 'FETCH_HEAD:package.json']);
    const subject = await git(root, ['log', '-1', '--format=%s', 'FETCH_HEAD']);
    const current = { version: versionOf(readFileSync(join(root, 'package.json'), 'utf8')), commit };
    return {
      ok: true,
      check: {
        root,
        binDir: install.binDir,
        ref,
        repo,
        current,
        latest: { version: versionOf(latestPkg), commit: latestCommit, subject },
        upToDate: commit === latestCommit,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `Could not check for updates: ${(e as Error).message.split('\n')[0]}. Check your connection; for a private repository, make sure git is signed in.`,
    };
  }
}

/**
 * Run the installer in update mode. `stdio: 'inherit'` shows its own progress (the CLI); otherwise each line of
 * output goes to `onLine` (the terminal UI, which owns the screen). Resolves to the installer's exit code.
 */
export function runUpdate(
  check: UpdateCheck,
  opts: { inherit?: boolean; onLine?: (line: string) => void } = {},
): Promise<number> {
  return new Promise((res) => {
    const child = spawn(
      'sh',
      [join(check.root, 'install.sh'), '--yes', '--no-setup', '--dir', check.root, '--bin-dir', check.binDir],
      {
        stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NACRE_REF: check.ref,
          NACRE_REPO: check.repo,
          ...(opts.inherit ? {} : { NO_COLOR: '1' }),
        },
      },
    );
    let partial = '';
    const feed = (d: Buffer) => {
      const lines = (partial + d.toString()).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine?.(l.trimEnd());
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', () => res(127));
    child.on('exit', (code) => {
      if (partial.trim()) opts.onLine?.(partial.trimEnd());
      res(code ?? 1);
    });
  });
}

let pending: UpdateCheck | undefined;
/** Ask the CLI to start the updated `nacre` once the terminal UI has closed. */
export const requestRelaunch = (check: UpdateCheck): void => {
  pending = check;
};
export const pendingRelaunch = (): UpdateCheck | undefined => pending;

/** Start the freshly updated `nacre` in place of this process, continuing the latest conversation. */
export function relaunch(check: UpdateCheck): Promise<number> {
  return new Promise((res) => {
    const child = spawn(join(check.binDir, BIN), ['--continue'], { stdio: 'inherit' });
    child.on('error', () => res(1));
    child.on('exit', (code) => res(code ?? 0));
  });
}

export const short = (commit: string) => commit.slice(0, 7);
