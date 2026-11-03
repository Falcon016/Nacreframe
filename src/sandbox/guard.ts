import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { globMatch } from '../util/glob.js';
import { scrubEnv } from '../util/redact.js';
import { detectShell } from './shell.js';
import type { Access, ExecSpec, Sandbox, WrappedExec } from './types.js';
import { SandboxError } from './types.js';

export interface GuardOptions {
  cwd: string;
  allowPaths?: string[];
  denyPaths?: string[];
  /** `off` skips path enforcement entirely (used for sandbox.mode = "off"). */
  enforce?: boolean;
}

const WIN = process.platform === 'win32';
const fold = (p: string) => (WIN ? p.toLowerCase() : p);

/** Resolve symlinks for the longest existing ancestor so a link inside the workspace cannot point outside it. */
export function realResolve(p: string): string {
  const abs = resolve(p);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(probe.slice(parent.length).replace(/^[\\/]+/, ''));
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(probe);
  } catch {
    real = probe;
  }
  return tail.length ? join(real, ...tail) : real;
}

export function isInside(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Path guard: file tools are confined to the workspace (plus explicit allow-paths and a private temp dir),
 * and deny-globs always win. Commands are run with a scrubbed environment.
 *
 * NOTE: this is policy enforcement for the agent's file tools, NOT an OS boundary for shell commands.
 * For real isolation of `bash`, use `sandbox.mode = "container"`.
 */
export class GuardSandbox implements Sandbox {
  readonly mode: 'off' | 'guard' = 'guard';
  readonly roots: readonly string[];
  private deny: string[];
  private enforce: boolean;
  private cwd: string;

  constructor(opts: GuardOptions) {
    this.cwd = realResolve(opts.cwd);
    this.enforce = opts.enforce ?? true;
    this.roots = [
      this.cwd,
      ...(opts.allowPaths ?? []).map((p) => realResolve(p)),
      realResolve(join(tmpdir(), 'nacreframe')),
    ];
    this.deny = opts.denyPaths ?? [];
    if (!this.enforce) this.mode = 'off';
  }

  checkPath(path: string, access: Access): string {
    if (WIN && /^\\\\[?.]\\/.test(path))
      throw new SandboxError(`Device/extended paths are not allowed: ${path}`);
    if (WIN && path.replace(/^[a-zA-Z]:/, '').includes(':')) {
      throw new SandboxError(`Alternate data streams are not allowed: ${path}`);
    }
    const abs = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
    const real = realResolve(abs);

    if (this.enforce && !this.roots.some((r) => isInside(real, r))) {
      throw new SandboxError(
        `${access === 'write' ? 'Write' : 'Read'} outside the workspace is blocked by the sandbox: ${path}`,
      );
    }
    const rel = relative(this.cwd, real).replaceAll('\\', '/');
    const absNorm = real.replaceAll('\\', '/');
    for (const g of this.deny) {
      if (globMatch(g, rel) || globMatch(g, absNorm) || globMatch(g, rel.split('/').at(-1) ?? '')) {
        throw new SandboxError(`Path is protected by sandbox.denyPaths (${g}): ${path}`);
      }
    }
    return real;
  }

  wrapExec(spec: ExecSpec): WrappedExec {
    const shell = detectShell();
    return {
      file: shell.file,
      args: shell.args(spec.command),
      cwd: spec.cwd,
      env: scrubEnv(spec.env),
      shellName: shell.name,
    };
  }

  describe(): string {
    return this.enforce ? `guard: file tools stay inside ${this.cwd}` : 'off: no isolation';
  }
}

/** Sandbox with no isolation (`sandbox.mode = "off"`). Env scrubbing is also skipped. */
export class OffSandbox extends GuardSandbox {
  constructor(cwd: string) {
    super({ cwd, enforce: false });
  }
  override wrapExec(spec: ExecSpec): WrappedExec {
    const shell = detectShell();
    return {
      file: shell.file,
      args: shell.args(spec.command),
      cwd: spec.cwd,
      env: spec.env,
      shellName: shell.name,
    };
  }
}
