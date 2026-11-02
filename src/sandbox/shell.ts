import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ShellInfo {
  file: string;
  name: 'bash' | 'sh' | 'zsh' | 'powershell' | 'pwsh';
  args: (command: string) => string[];
}

let cached: ShellInfo | undefined;

/** Pick the shell used for the `bash` tool on this machine. Cached after first lookup. */
export function detectShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ShellInfo {
  if (cached && env === process.env && platform === process.platform) return cached;
  const info = detect(env, platform);
  if (env === process.env && platform === process.platform) cached = info;
  return info;
}

function detect(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellInfo {
  if (platform === 'win32') {
    const gitBash = [
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      join(env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ].find((p) => existsSync(p));
    if (gitBash) return { file: gitBash, name: 'bash', args: (c) => ['-c', c] };
    // Deliberately skip System32\bash.exe: that is the WSL launcher, not a native shell.
    const pwsh = which('pwsh.exe', env);
    if (pwsh) return { file: pwsh, name: 'pwsh', args: psArgs };
    return { file: which('powershell.exe', env) ?? 'powershell.exe', name: 'powershell', args: psArgs };
  }
  const preferred = env.SHELL;
  if (preferred && /(^|\/)(bash|zsh)$/.test(preferred) && existsSync(preferred)) {
    return { file: preferred, name: preferred.endsWith('zsh') ? 'zsh' : 'bash', args: (c) => ['-c', c] };
  }
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (existsSync(p)) return { file: p, name: 'bash', args: (c) => ['-c', c] };
  }
  return { file: '/bin/sh', name: 'sh', args: (c) => ['-c', c] };
}

const psArgs = (c: string) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', c];

function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Kill a process and its children on every platform. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
