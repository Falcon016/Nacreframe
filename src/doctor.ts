import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore } from './config/auth.js';
import { loadConfig, BUILTIN_PROVIDERS, merge } from './config/load.js';
import { configSchema } from './config/schema.js';
import { appPaths, type AppPaths } from './paths.js';
import { detectShell } from './sandbox/shell.js';
import { patchUserConfig } from './setup/plan.js';
import { Cancelled, TtyPrompter, type Prompter } from './setup/prompt.js';
import { Term } from './setup/ui.js';
import { BIN, NAME, VERSION } from './version.js';
import { LEGACY, PROJECT_DIR } from './legacy.js';

/** Something `nexus doctor --fix` can do about a problem. */
export interface Fix {
  /** Same id = same fix; it runs once even if several checks point at it. */
  id: string;
  /** What it will do, in a few plain words. */
  label: string;
  /** Needs a person at the keyboard (typing a key, answering the wizard). */
  interactive?: boolean;
  /** Does something big or outside NexusHarness's own folders: ask first unless --yes was given. */
  confirm?: string;
  run(): Promise<string | undefined>;
}

export interface Check {
  /** Stable key so other commands (the setup wizard) can pick out a result. */
  id:
    | 'node'
    | 'shell'
    | 'git'
    | 'container'
    | 'browser'
    | 'config'
    | 'provider'
    | 'data'
    | 'install'
    | 'path'
    | 'keys';
  ok: boolean | 'warn';
  label: string;
  detail: string;
  fix?: Fix;
}

const MIN_NODE = { major: 22, minor: 18 };

export function nodeIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

const run = (cmd: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolveRun) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 4000 }, (err, stdout) =>
      resolveRun(err ? undefined : stdout.trim().split('\n')[0]),
    );
  });

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

/** Checks about the machine itself (no configuration needed). Shared by `nexus doctor` and `nexus setup`. */
export async function systemChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({
    id: 'node',
    ok: nodeIsNewEnough(process.versions.node),
    label: 'Node.js',
    detail: `v${process.versions.node}${nodeIsNewEnough(process.versions.node) ? '' : ` — need ≥ ${MIN_NODE.major}.${MIN_NODE.minor}`}`,
  });
  const shell = detectShell();
  checks.push({
    id: 'shell',
    ok: true,
    label: 'Shell for bash tool',
    detail: `${shell.name} (${shell.file})`,
  });
  const [git, docker, podman] = await Promise.all([
    run('git', ['--version']),
    run('docker', ['version', '--format', '{{.Server.Version}}']),
    run('podman', ['version', '--format', '{{.Version}}']),
  ]);
  checks.push({ id: 'git', ok: git ? true : 'warn', label: 'git', detail: git ?? 'not found' });
  checks.push({
    id: 'container',
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
    id: 'browser',
    ok: chrome ? true : 'warn',
    label: 'Chrome / Edge',
    detail:
      chrome ??
      'not found — set browser.channel to "chromium" and run `npx playwright-core install chromium`',
  });
  return checks;
}

// ---- how this copy of NexusHarness was installed ---------------------------------------------------------

export interface InstallInfo {
  /** The folder holding dist/ and node_modules/. */
  root: string;
  /** Where the `nexus` launcher script is, if it exists. */
  launcher?: string;
  binDir: string;
}

const MARK = '# nexus launcher written by the NexusHarness installer';
/** Launchers written before the rename say this instead, and set NACRE_DIR. */
export const LEGACY_MARK = '# nacre launcher written by the Nacreframe installer';

const launcherFor = (f: string, root: string): boolean => {
  try {
    const text = readFileSync(f, 'utf8');
    return (
      (text.includes(MARK) && text.includes(`NEXUS_DIR='${root}'`)) ||
      (text.includes(LEGACY_MARK) && text.includes(`NACRE_DIR='${root}'`))
    );
  } catch {
    return false;
  }
};

/**
 * Finds the `nexus` launcher made by install.sh for this copy, or says this is not an installer-made copy. An
 * install from before the rename has only a `nacre` launcher: it is recognised, but `launcher` stays unset so
 * doctor offers to repair it (which adds `nexus`).
 */
export function detectInstall(root: string, env: NodeJS.ProcessEnv, home: string): InstallInfo | undefined {
  if (process.platform === 'win32' || !existsSync(join(root, 'install.sh'))) return undefined;
  const dirs = [...(env.PATH ?? '').split(delimiter), join(home, '.local', 'bin')].filter(Boolean);
  for (const d of dirs)
    if (launcherFor(join(d, BIN), root)) return { root, launcher: join(d, BIN), binDir: d };
  for (const d of dirs) if (launcherFor(join(d, LEGACY.bin), root)) return { root, binDir: d };
  // No launcher found, but this is where the installer puts things by default: it can be put back.
  if ([PROJECT_DIR, LEGACY.projectDir].some((dir) => resolve(root) === resolve(join(home, dir)))) {
    return { root, binDir: join(home, '.local', 'bin') };
  }
  return undefined;
}

function profileHasPathEntry(home: string, env: NodeJS.ProcessEnv): boolean {
  const files = [
    join(env.ZDOTDIR ?? home, '.zshrc'),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.profile'),
    join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'fish', 'conf.d', 'nexusharness.fish'),
    join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'fish', 'conf.d', `${LEGACY.slug}.fish`),
  ];
  return files.some((f) => {
    try {
      const text = readFileSync(f, 'utf8');
      return text.includes('nexusharness') || text.includes(LEGACY.slug);
    } catch {
      return false;
    }
  });
}

// ---- doctor ----------------------------------------------------------------------------------------------

export interface DoctorOptions {
  /** Repair what can be repaired (default: only offer, when there is a person to ask). */
  fix?: boolean;
  /** Say yes to every question. */
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  paths?: AppPaths;
  home?: string;
  installRoot?: string;
  out?: (line: string) => void;
  /** Whether a person is at the terminal. Default: stdin and stdout are terminals. */
  interactive?: boolean;
  prompt?: Prompter;
  /** Runs a command with the terminal attached; resolves to its exit code. */
  runCommand?: (cmd: string, args: string[]) => Promise<number>;
  /** The machine checks (default: the real ones). */
  system?: () => Promise<Check[]>;
  /** Starts the setup wizard. */
  setup?: () => Promise<number>;
}

const defaultRunCommand = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', () => resolveRun(127));
    child.on('exit', (code) => resolveRun(code ?? 1));
  });

export async function doctor(cwd: string, opts: DoctorOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? appPaths(env);
  const home = opts.home ?? homedir();
  const out = opts.out ?? ((l: string) => console.log(l));
  const interactive = opts.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const exec = opts.runCommand ?? defaultRunCommand;
  const root = opts.installRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Looked up again after each repair: the launcher may have just been put back.
  let install = detectInstall(root, env, home);
  let prompter = opts.prompt;
  const prompt = (): Prompter => (prompter ??= new TtyPrompter(process.stdin, new Term()));

  // ---- fixes -----------------------------------------------------------------------------------------
  const repairInstall: Fix = {
    id: 'repair-install',
    label: 'Repair the installation (re-download, reinstall dependencies, rebuild, relink)',
    run: async () => {
      if (!install) throw new Error('this copy was not made by the installer');
      const code = await exec('sh', [
        join(install.root, 'install.sh'),
        '--repair',
        '--dir',
        install.root,
        '--bin-dir',
        install.binDir,
      ]);
      if (code !== 0) throw new Error(`the installer exited with status ${code}`);
      return 'Repaired. Open a new terminal if `nexus` is not found.';
    },
  };

  const resetConfig = (file: string): Fix => ({
    id: 'reset-config',
    label: `Move the broken settings file aside and start from defaults (${file})`,
    run: async () => {
      const aside = `${file}.broken-${Date.now()}`;
      renameSync(file, aside);
      return `Moved it to ${aside}. Run \`${BIN} setup\` to choose your settings again.`;
    },
  });

  const enterKey = (provider: string): Fix => ({
    id: `key-${provider}`,
    label: `Enter your ${provider} API key`,
    interactive: true,
    run: async () => {
      const key = await prompt().secret({
        message: `${provider} API key`,
        validate: (v) => (v.trim() ? undefined : 'Paste your key, or press Ctrl+C to skip'),
      });
      new AuthStore(paths).set(provider, key.trim());
      return 'Key saved.';
    },
  });

  const chooseSettings: Fix = {
    id: 'setup',
    label: 'Run the setup wizard',
    interactive: true,
    run: async () => {
      const code = await (opts.setup ?? (async () => (await import('./setup/index.js')).setupCommand([])))();
      if (code !== 0) throw new Error('setup did not finish');
      return undefined;
    },
  };

  const startOllama: Fix = {
    id: 'start-ollama',
    label: 'Start the Ollama server',
    run: async () => {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await reachable('http://localhost:11434/v1/models')) return 'Ollama is running.';
      }
      throw new Error('it did not come up within 10 seconds; try `ollama serve` in another terminal');
    },
  };

  const installChromium: Fix = {
    id: 'install-chromium',
    label: 'Download a private copy of Chromium for the browser tool',
    confirm: 'Download Chromium for the browser tool? (about 150 MB)',
    run: async () => {
      const pw = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
      const code = await exec(process.execPath, [join(pw, 'cli.js'), 'install', 'chromium']);
      if (code !== 0) throw new Error('the download failed');
      patchUserConfig({ browser: { channel: 'chromium' } }, paths);
      return 'Installed, and browser.channel is now "chromium".';
    },
  };

  // ---- checks ----------------------------------------------------------------------------------------
  const gather = async (): Promise<Check[]> => {
    install = detectInstall(root, env, home);
    const checks = await (opts.system ?? systemChecks)();
    for (const c of checks) {
      if (c.id === 'node' && c.ok !== true && install) c.fix = repairInstall;
      if (c.id === 'browser' && c.ok !== true) c.fix = installChromium;
      if (c.id === 'git' && c.ok !== true)
        c.detail = 'not found — install it with your package manager (apt, dnf, brew, ...)';
    }

    if (install) {
      const inst = install;
      checks.push(
        inst.launcher
          ? { id: 'install', ok: true, label: 'nexus command', detail: inst.launcher }
          : {
              id: 'install',
              ok: 'warn',
              label: 'nexus command',
              detail: `missing from ${inst.binDir}`,
              fix: repairInstall,
            },
      );
      const privateNode = join(inst.root, 'runtime', 'node', 'bin', 'node');
      if (existsSync(privateNode)) {
        const v = await run(privateNode, ['--version']);
        if (!v || !nodeIsNewEnough(v))
          checks.push({
            id: 'install',
            ok: false,
            label: 'Private Node.js',
            detail: v ? `${v} is too old` : 'does not run',
            fix: repairInstall,
          });
      }
      const onPath = (env.PATH ?? '')
        .split(delimiter)
        .some((d) => resolve(d || '.') === resolve(inst.binDir));
      if (onPath) checks.push({ id: 'path', ok: true, label: 'PATH', detail: `${inst.binDir} is on it` });
      else if (profileHasPathEntry(home, env))
        checks.push({
          id: 'path',
          ok: true,
          label: 'PATH',
          detail: 'added to your shell profile; open a new terminal to use it',
        });
      else
        checks.push({
          id: 'path',
          ok: 'warn',
          label: 'PATH',
          detail: `${inst.binDir} is not on it, so \`${BIN}\` only works by its full path`,
          fix: repairInstall,
        });
    }

    // Settings: a broken file is the most common reason nothing starts.
    const userConfig = join(paths.config, 'config.json');
    let configProblem: string | undefined;
    if (existsSync(userConfig)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(userConfig, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('not a JSON object');
        const own = configSchema.safeParse(merge({ providers: BUILTIN_PROVIDERS }, parsed as never));
        if (!own.success)
          configProblem = own.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
      } catch (e) {
        configProblem = `not valid JSON (${(e as Error).message})`;
      }
    }
    if (configProblem) {
      checks.push({
        id: 'config',
        ok: false,
        label: 'Config',
        detail: `${userConfig}: ${configProblem}`,
        fix: resetConfig(userConfig),
      });
    } else {
      try {
        const loaded = loadConfig({ cwd, paths, env });
        const auth = new AuthStore(loaded.paths);
        checks.push({
          id: 'config',
          ok: true,
          label: 'Config',
          detail: `${loaded.userConfigPath}${loaded.projectConfigPath ? ` + ${loaded.projectConfigPath} (${loaded.projectTrusted ? 'trusted' : 'untrusted'})` : ''}`,
        });
        const defaultProvider = loaded.config.model?.split('/')[0];
        if (!loaded.config.model)
          checks.push({
            id: 'provider',
            ok: 'warn',
            label: 'Default model',
            detail: `none chosen yet — run \`${BIN} setup\``,
            fix: chooseSettings,
          });
        for (const [id, p] of Object.entries(loaded.config.providers)) {
          if (p.type === 'anthropic' || p.apiKeyEnv) {
            const has = !!(auth.get(id) ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined));
            checks.push({
              id: 'provider',
              ok: has ? true : 'warn',
              label: `Provider ${id}`,
              detail: has
                ? 'API key found'
                : `no key (set ${p.apiKeyEnv ?? 'a key'} or run \`${BIN} auth set ${id}\`)`,
              // Only offer to fix the provider that is actually in use; the others are just information.
              ...(!has && id === defaultProvider ? { fix: enterKey(id) } : {}),
            });
          } else if (p.baseUrl) {
            const up = await reachable(p.baseUrl.replace(/\/+$/, '') + '/models');
            checks.push({
              id: 'provider',
              ok: up ? true : 'warn',
              label: `Provider ${id}`,
              detail: up ? `${p.baseUrl} reachable` : `${p.baseUrl} not reachable`,
              ...(!up && id === 'ollama' && id === defaultProvider && (await run('ollama', ['--version']))
                ? { fix: startOllama }
                : {}),
            });
          }
        }
        for (const w of loaded.warnings)
          checks.push({ id: 'config', ok: 'warn', label: 'Config warning', detail: w });
      } catch (e) {
        checks.push({ id: 'config', ok: false, label: 'Config', detail: (e as Error).message });
      }
    }

    // Stored keys must not be readable by other users.
    const authFile = join(paths.config, 'auth.json');
    if (process.platform !== 'win32' && existsSync(authFile)) {
      const mode = statSync(authFile).mode & 0o777;
      if (mode & 0o077)
        checks.push({
          id: 'keys',
          ok: 'warn',
          label: 'Key file permissions',
          detail: `${authFile} is readable by other users (${mode.toString(8)})`,
          fix: {
            id: 'chmod-keys',
            label: 'Make the key file private (owner only)',
            run: async () => {
              chmodSync(authFile, 0o600);
              return undefined;
            },
          },
        });
    }

    // Folders NexusHarness writes to.
    for (const [label, dir] of [
      ['Settings directory', paths.config],
      ['Data directory', paths.data],
    ] as const) {
      let problem: string | undefined;
      let canMake = false;
      if (!existsSync(dir)) {
        problem = 'does not exist yet';
        canMake = true;
      } else {
        try {
          accessSync(dir, constants.W_OK);
        } catch {
          problem = 'is not writable';
        }
      }
      checks.push({
        id: 'data',
        ok: problem ? (canMake ? 'warn' : false) : true,
        label,
        detail: problem ? `${dir} ${problem}` : dir,
        ...(canMake
          ? {
              fix: {
                id: `mkdir-${dir}`,
                label: `Create ${dir}`,
                run: async () => {
                  mkdirSync(dir, { recursive: true });
                  return undefined;
                },
              },
            }
          : {}),
      });
    }
    return checks;
  };

  const show = (checks: Check[]) => {
    for (const c of checks) {
      const mark = c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗';
      out(` ${mark} ${c.label.padEnd(22)} ${c.detail}`);
    }
  };

  out(`${NAME} ${VERSION} — environment check\n`);
  let checks = await gather();
  show(checks);

  const fixable = () => {
    const seen = new Set<string>();
    const list: Fix[] = [];
    for (const c of checks) {
      if (c.ok !== true && c.fix && !seen.has(c.fix.id)) {
        seen.add(c.fix.id);
        list.push(c.fix);
      }
    }
    return list;
  };
  const failed = () => checks.some((c) => c.ok === false);

  let todo = fixable();
  if (todo.length === 0) {
    if (failed()) out(`\nNothing here can be repaired automatically. See the lines marked ✗ above.`);
    return failed() ? 1 : 0;
  }

  const count = `${todo.length} problem${todo.length > 1 ? 's' : ''}`;
  if (!opts.fix) {
    if (interactive && !opts.yes) {
      out('');
      let go = false;
      try {
        go = await prompt().confirm({
          message: `${count} can be fixed automatically. Fix now?`,
          initial: true,
        });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
      }
      if (!go) {
        out(`\nRun \`${BIN} doctor --fix\` whenever you want to repair ${todo.length > 1 ? 'them' : 'it'}.`);
        return failed() ? 1 : 0;
      }
    } else {
      out(
        `\n${count} can be fixed automatically. Run \`${BIN} doctor --fix\` to repair ${todo.length > 1 ? 'them' : 'it'}.`,
      );
      return failed() ? 1 : 0;
    }
  }

  out('\nFixing:');
  // Repair the installation first: the other fixes run on the repaired copy's files.
  todo = [...todo.filter((f) => f.id === 'repair-install'), ...todo.filter((f) => f.id !== 'repair-install')];
  for (const f of todo) {
    if (f.interactive && !interactive) {
      out(` - ${f.label}: skipped, this needs a terminal. Run \`${BIN} doctor --fix\` in one.`);
      continue;
    }
    if (f.confirm && !opts.yes) {
      if (!interactive) {
        out(` - ${f.label}: skipped; run \`${BIN} doctor --fix --yes\` to allow it.`);
        continue;
      }
      let yes = false;
      try {
        yes = await prompt().confirm({ message: f.confirm, initial: false });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
      }
      if (!yes) {
        out(` - ${f.label}: skipped.`);
        continue;
      }
    }
    out(` • ${f.label}...`);
    try {
      const note = await f.run();
      out(` ✓ Done${note ? `. ${note}` : ''}`);
    } catch (e) {
      if (e instanceof Cancelled) out(` - Skipped.`);
      else out(` ✗ Could not do that: ${(e as Error).message}`);
    }
  }

  out(`\nChecking again:\n`);
  checks = await gather();
  show(checks);
  const left = fixable().length;
  if (left) out(`\n${left} problem${left > 1 ? 's are' : ' is'} still open.`);
  return failed() ? 1 : 0;
}
