export type Access = 'read' | 'write';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface ExecSpec {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WrappedExec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Extra teardown when the command is aborted (e.g. `docker kill`). */
  kill?: () => void;
  shellName: string;
}

export interface Sandbox {
  readonly mode: 'off' | 'guard' | 'container';
  /** Directories the file tools may touch. */
  readonly roots: readonly string[];
  /** Validate and normalise a path; returns the absolute path to use, or throws SandboxError. */
  checkPath(path: string, access: Access): string;
  /** Turn a shell command into a concrete process invocation. */
  wrapExec(spec: ExecSpec): WrappedExec;
  /** One-line human description for the status bar and /sandbox. */
  describe(): string;
}
