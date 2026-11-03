import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { appPaths, type AppPaths } from '../paths.js';
import { configSchema, type Config, type PartialConfig } from './schema.js';

export interface LoadOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  paths?: AppPaths;
  /** Highest-precedence overrides (CLI flags). */
  overrides?: PartialConfig;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
  userConfigPath: string;
  projectConfigPath?: string;
  projectTrusted: boolean;
  paths: AppPaths;
}

const LIST_KEYS = new Set(['rules', 'denyPaths', 'allowPaths', 'allowedHosts', 'blockedHosts', 'agents']);

export const BUILTIN_PROVIDERS: PartialConfig = {
  anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  ollama: { type: 'openai', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { type: 'openai', baseUrl: 'http://localhost:1234/v1' },
  // llama.cpp's llama-server default port. Point it elsewhere with providers.llamacpp.baseUrl.
  llamacpp: { type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' },
};

export function loadConfig(opts: LoadOptions): LoadedConfig {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? appPaths(env);
  const warnings: string[] = [];

  const userConfigPath = join(paths.config, 'config.json');
  const user = readJson(userConfigPath, warnings) ?? {};

  const projectConfigPath = findProjectConfig(opts.cwd);
  const projectRaw = projectConfigPath ? readJson(projectConfigPath, warnings) : undefined;
  const projectTrusted = projectConfigPath ? isTrusted(paths, dirname(dirname(projectConfigPath))) : false;
  let project: PartialConfig = {};
  if (projectRaw) {
    if (projectTrusted) project = projectRaw;
    else {
      const { safe, dropped } = restrictUntrusted(projectRaw);
      project = safe;
      if (dropped.length) {
        warnings.push(
          `Project config ${projectConfigPath} is not trusted; ignored: ${dropped.join(', ')}. Run \`nacre trust\` to enable it.`,
        );
      }
    }
  }

  // Who may command the agent from Telegram is the user's decision alone, even for a trusted project.
  if (project.telegram !== undefined) {
    const { telegram: _ignored, ...rest } = project;
    project = rest;
    warnings.push(
      `Project config ${projectConfigPath} sets telegram; that is only read from your user config.`,
    );
  }

  let merged = merge({ providers: BUILTIN_PROVIDERS }, user);
  merged = merge(merged, project);
  merged = merge(merged, fromEnv(env));
  if (opts.overrides) merged = merge(merged, opts.overrides);

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return {
    config: parsed.data,
    warnings,
    userConfigPath,
    ...(projectConfigPath ? { projectConfigPath } : {}),
    projectTrusted,
    paths,
  };
}

function fromEnv(env: NodeJS.ProcessEnv): PartialConfig {
  const out: PartialConfig = {};
  if (env.NACRE_MODEL) out.model = env.NACRE_MODEL;
  if (env.NACRE_APPROVAL) out.approval = { mode: env.NACRE_APPROVAL };
  if (env.NACRE_SANDBOX) out.sandbox = { mode: env.NACRE_SANDBOX };
  return out;
}

/**
 * A cloned repository can ship `.nacreframe/config.json`. Until the user trusts the project, only settings
 * that can *tighten* behaviour are honoured: anything that could widen access, run code, or auto-approve is dropped.
 */
export function restrictUntrusted(raw: PartialConfig): { safe: PartialConfig; dropped: string[] } {
  const safe: PartialConfig = {};
  const dropped: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'model' || key === 'theme') safe[key] = value;
    else if (key === 'approval' && isObj(value)) {
      const rules = Array.isArray(value.rules)
        ? value.rules.filter((r) => isObj(r) && r.action !== 'allow')
        : [];
      if (rules.length) safe.approval = { rules };
      if (value.mode !== undefined || (Array.isArray(value.rules) && value.rules.length !== rules.length)) {
        dropped.push('approval.mode / allow rules');
      }
    } else if (key === 'sandbox' && isObj(value)) {
      if (Array.isArray(value.denyPaths)) safe.sandbox = { denyPaths: value.denyPaths };
      if (value.mode !== undefined || value.allowPaths !== undefined || value.container !== undefined) {
        dropped.push('sandbox.mode / allowPaths / container');
      }
    } else if (key === 'browser' && isObj(value)) {
      if (Array.isArray(value.blockedHosts)) safe.browser = { blockedHosts: value.blockedHosts };
      if (Object.keys(value).some((k) => k !== 'blockedHosts')) dropped.push('browser (except blockedHosts)');
    } else dropped.push(key);
  }
  return { safe, dropped };
}

export function merge(base: PartialConfig, over: PartialConfig, key = ''): PartialConfig {
  const out: PartialConfig = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (Array.isArray(v) && Array.isArray(b) && LIST_KEYS.has(k)) out[k] = [...b, ...v];
    else if (isPlain(v) && isPlain(b)) out[k] = merge(b, v, k);
    else if (v !== undefined) out[k] = v;
  }
  void key;
  return out;
}

function isPlain(v: unknown): v is PartialConfig {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readJson(path: string, warnings: string[]): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlain(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (e) {
    warnings.push(`Could not read ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Walk up from cwd looking for `.nacreframe/config.json`, stopping at the filesystem root. */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, '.nacreframe', 'config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---- trust store -----------------------------------------------------------------------------

function trustFile(paths: AppPaths): string {
  return join(paths.state, 'trusted-projects.json');
}

function readTrusted(paths: AppPaths): string[] {
  try {
    const j: unknown = JSON.parse(readFileSync(trustFile(paths), 'utf8'));
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export function isTrusted(paths: AppPaths, projectDir: string): boolean {
  const dir = norm(projectDir);
  return readTrusted(paths).some((t) => dir === norm(t) || dir.startsWith(norm(t) + sep));
}

export function trustProject(paths: AppPaths, projectDir: string): void {
  const list = readTrusted(paths);
  if (!list.some((t) => norm(t) === norm(projectDir))) list.push(resolve(projectDir));
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(trustFile(paths), JSON.stringify(list, null, 2) + '\n');
}
