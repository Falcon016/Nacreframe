import type { Config } from '../config/schema.js';
import { ContainerSandbox } from './container.js';
import { GuardSandbox, OffSandbox } from './guard.js';
import type { Sandbox } from './types.js';

export type { Sandbox } from './types.js';
export { SandboxError } from './types.js';

export function createSandbox(config: Config, cwd: string): Sandbox {
  const { mode, allowPaths, denyPaths, container } = config.sandbox;
  if (mode === 'off') return new OffSandbox(cwd);
  if (mode === 'container') {
    const sb = new ContainerSandbox(cwd, container, { allowPaths, denyPaths });
    sb.assertAvailable();
    return sb;
  }
  return new GuardSandbox({ cwd, allowPaths, denyPaths });
}
