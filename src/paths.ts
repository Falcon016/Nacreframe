import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Cross-platform config/data/state directories (XDG on Linux, Library on macOS, AppData on Windows). */
export interface AppPaths {
  config: string;
  data: string;
  state: string;
}

/** `slug` is the folder name; the old name (`nacreframe`) is only used to find settings to move over. */
export function appPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  slug = 'nexusharness',
): AppPaths {
  const homeVar = env.NEXUS_HOME ?? env.NACRE_HOME;
  const home = homeVar ? resolve(homeVar) : undefined;
  if (home) return { config: join(home, 'config'), data: join(home, 'data'), state: join(home, 'state') };
  const h = homedir();
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? join(h, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(h, 'AppData', 'Local');
    return {
      config: join(roaming, slug),
      data: join(local, slug, 'data'),
      state: join(local, slug, 'state'),
    };
  }
  if (platform === 'darwin') {
    const lib = join(h, 'Library');
    return {
      config: join(lib, 'Application Support', slug),
      data: join(lib, 'Application Support', slug, 'data'),
      state: join(lib, 'Application Support', slug, 'state'),
    };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(h, '.config'), slug),
    data: join(env.XDG_DATA_HOME ?? join(h, '.local', 'share'), slug),
    state: join(env.XDG_STATE_HOME ?? join(h, '.local', 'state'), slug),
  };
}

export function projectKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
}
