import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStore } from './config/auth.js';
import { loadConfig } from './config/load.js';
import { appPaths } from './paths.js';
import { detectShell } from './sandbox/shell.js';
import { BIN, NAME, VERSION } from './version.js';

interface Check {
  ok: boolean | 'warn';
  label: string;
  detail: string;
}

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 4000 });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined;
};

async function reachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function findChrome(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
          ];
  return candidates.find((c) => c && existsSync(c));
}

export async function doctor(cwd: string): Promise<number> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    ok: major >= 22,
    label: 'Node.js',
    detail: `v${process.versions.node}${major >= 22 ? '' : ' — need ≥ 22.18'}`,
  });
  const shell = detectShell();
  checks.push({ ok: true, label: 'Shell for bash tool', detail: `${shell.name} (${shell.file})` });
  const git = run('git', ['--version']);
  checks.push({ ok: git ? true : 'warn', label: 'git', detail: git ?? 'not found' });
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
  const podman = docker ? undefined : run('podman', ['version', '--format', '{{.Version}}']);
  checks.push({
    ok: docker || podman ? true : 'warn',
    label: 'Container runtime',
    detail: docker
      ? `docker ${docker}`
      : podman
        ? `podman ${podman}`
        : 'none running — container sandbox unavailable',
  });
  const chrome = findChrome();
  checks.push({
    ok: chrome ? true : 'warn',
    label: 'Chrome / Edge',
    detail:
      chrome ??
      'not found — set browser.channel to "chromium" and run `npx playwright-core install chromium`',
  });

  try {
    const loaded = loadConfig({ cwd });
    const auth = new AuthStore(loaded.paths);
    checks.push({
      ok: true,
      label: 'Config',
      detail: `${loaded.userConfigPath}${loaded.projectConfigPath ? ` + ${loaded.projectConfigPath} (${loaded.projectTrusted ? 'trusted' : 'untrusted'})` : ''}`,
    });
    for (const [id, p] of Object.entries(loaded.config.providers)) {
      if (p.type === 'anthropic' || p.apiKeyEnv) {
        const has = !!(auth.get(id) ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined));
        checks.push({
          ok: has ? true : 'warn',
          label: `Provider ${id}`,
          detail: has
            ? 'API key found'
            : `no key (set ${p.apiKeyEnv ?? 'a key'} or run \`${BIN} auth set ${id}\`)`,
        });
      } else if (p.baseUrl) {
        const up = await reachable(p.baseUrl.replace(/\/+$/, '') + '/models');
        checks.push({
          ok: up ? true : 'warn',
          label: `Provider ${id}`,
          detail: up ? `${p.baseUrl} reachable` : `${p.baseUrl} not reachable`,
        });
      }
    }
    for (const w of loaded.warnings) checks.push({ ok: 'warn', label: 'Config warning', detail: w });
  } catch (e) {
    checks.push({ ok: false, label: 'Config', detail: (e as Error).message });
  }
  checks.push({ ok: true, label: 'Data directory', detail: appPaths().data });

  console.log(`${NAME} ${VERSION} — environment check\n`);
  for (const c of checks) {
    const mark = c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗';
    console.log(` ${mark} ${c.label.padEnd(22)} ${c.detail}`);
  }
  return checks.some((c) => c.ok === false) ? 1 : 0;
}
