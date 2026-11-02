import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Cross-platform config/data/state directories (XDG on Linux, Library on macOS, AppData on Windows). */
export interface AppPaths {
  config: string;
  data: string;
  state: string;
}

export function appPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): AppPaths {
  const home = env.NACRE_HOME ? resolve(env.NACRE_HOME) : undefined;
  if (home) return { config: join(home, 'config'), data: join(home, 'data'), state: join(home, 'state') };
  const h = homedir();
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? join(h, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(h, 'AppData', 'Local');
    return {
      config: join(roaming, 'nacreframe'),
      data: join(local, 'nacreframe', 'data'),
      state: join(local, 'nacreframe', 'state'),
    };
  }
  if (platform === 'darwin') {
    const lib = join(h, 'Library');
    return {
      config: join(lib, 'Application Support', 'nacreframe'),
      data: join(lib, 'Application Support', 'nacreframe', 'data'),
      state: join(lib, 'Application Support', 'nacreframe', 'state'),
    };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(h, '.config'), 'nacreframe'),
    data: join(env.XDG_DATA_HOME ?? join(h, '.local', 'share'), 'nacreframe'),
    state: join(env.XDG_STATE_HOME ?? join(h, '.local', 'state'), 'nacreframe'),
  };
}

export function projectKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
}
