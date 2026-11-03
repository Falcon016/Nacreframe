import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import type { Config } from '../config/schema.js';
import { newId } from '../util/id.js';
import { GuardSandbox } from './guard.js';
import type { ExecSpec, WrappedExec } from './types.js';
import { SandboxError } from './types.js';

type ContainerConfig = Config['sandbox']['container'];

/**
 * Container sandbox: file tools stay path-guarded on the host (the workspace is bind-mounted),
 * while every shell command runs inside a throw-away Docker/Podman container with no host
 * environment, dropped capabilities, resource limits and (by default) no network.
 */
export class ContainerSandbox extends GuardSandbox {
  private runtime: string;

  constructor(
    private cwdRoot: string,
    private cfg: ContainerConfig,
    opts: { allowPaths?: string[]; denyPaths?: string[] } = {},
  ) {
    super({ cwd: cwdRoot, ...opts });
    this.runtime = cfg.runtime;
  }

  static available(runtime: string): boolean {
    const r = spawnSync(runtime, ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return r.status === 0;
  }

  /** Throws a helpful error if the container runtime is not reachable. */
  assertAvailable(): void {
    if (!ContainerSandbox.available(this.runtime)) {
      throw new SandboxError(
        `Container sandbox needs a running ${this.runtime}. Start it, or switch with \`--sandbox guard\`.`,
      );
    }
  }

  override wrapExec(spec: ExecSpec): WrappedExec {
    const name = newId('nacre-');
    const rel = relative(this.cwdRoot, spec.cwd).replaceAll('\\', '/');
    const workdir = rel && !rel.startsWith('..') ? `/workspace/${rel}` : '/workspace';
    const args = [
      'run',
      '--rm',
      '-i',
      '--init',
      '--name',
      name,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '512',
      '--memory',
      this.cfg.memory,
      '--cpus',
      this.cfg.cpus,
      '--network',
      this.cfg.network ? 'bridge' : 'none',
      '-v',
      `${this.cwdRoot}:/workspace`,
      '-w',
      workdir,
      '-e',
      'HOME=/tmp',
    ];
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      args.push('--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
    }
    args.push(this.cfg.image, 'sh', '-c', spec.command);
    const runtime = this.runtime;
    return {
      file: runtime,
      args,
      cwd: spec.cwd,
      // The container gets none of the host environment; only the client needs PATH & friends.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
      kill: () => void spawnSync(runtime, ['kill', name], { stdio: 'ignore', windowsHide: true }),
      shellName: 'sh (container)',
    };
  }

  override describe(): string {
    return `container: ${this.cfg.runtime} ${this.cfg.image}, network ${this.cfg.network ? 'on' : 'off'}`;
  }
}
