import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AuthStore } from '../config/auth.js';
import { BUILTIN_PROVIDERS } from '../config/load.js';
import { appPaths, type AppPaths } from '../paths.js';
import {
  approvalModeSchema,
  sandboxModeSchema,
  type ApprovalMode,
  type PartialConfig,
  type SandboxMode,
} from '../config/schema.js';

/** Everything `nacre setup` can change. Fields left out are left alone. */
export interface SetupPlan {
  provider?: {
    id: string;
    type: 'anthropic' | 'openai';
    /** Only needed for custom endpoints, or a built-in provider on a non-default address. */
    baseUrl?: string;
  };
  /** Stored in the credential file (owner-only), never in config.json. */
  apiKey?: string;
  /** `<provider>/<model>` */
  model?: string;
  approval?: ApprovalMode;
  sandbox?: SandboxMode;
  browser?: boolean;
}

export interface ApplyResult {
  configPath: string;
  /** Set when an existing config.json was copied aside before being changed. */
  backupPath?: string;
  /** True when the old config.json could not be parsed and was set aside instead of merged. */
  replacedInvalid: boolean;
  keySaved: boolean;
}

export const isPlain = (v: unknown): v is PartialConfig => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge plain objects; anything else in `patch` replaces what is in `base`. */
export function mergeConfig(base: PartialConfig, patch: PartialConfig): PartialConfig {
  const out: PartialConfig = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out;
}

/** The slice of config.json that a plan changes. */
export function planToPatch(plan: SetupPlan): PartialConfig {
  const patch: PartialConfig = {};
  const p = plan.provider;
  if (p) {
    const builtin = BUILTIN_PROVIDERS[p.id] as { baseUrl?: string } | undefined;
    const needsEntry = !builtin || (p.baseUrl !== undefined && p.baseUrl !== builtin.baseUrl);
    if (needsEntry) {
      patch.providers = { [p.id]: { type: p.type, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}) } };
    }
  }
  if (plan.model) patch.model = plan.model;
  if (plan.approval) patch.approval = { mode: plan.approval };
  if (plan.sandbox) patch.sandbox = { mode: plan.sandbox };
  if (plan.browser !== undefined) patch.browser = { enabled: plan.browser };
  return patch;
}

/** Write the plan to the user's config and credential files. Safe to run repeatedly. */
export function applyPlan(plan: SetupPlan, paths: AppPaths = appPaths()): ApplyResult {
  const configPath = join(paths.config, 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });

  let current: PartialConfig = {};
  let replacedInvalid = false;
  let existed = false;
  if (existsSync(configPath)) {
    existed = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!isPlain(parsed)) throw new Error('not an object');
      current = parsed;
    } catch {
      replacedInvalid = true;
    }
  }

  const next = mergeConfig(current, planToPatch(plan));
  const text = JSON.stringify(next, null, 2) + '\n';
  const unchanged = existed && !replacedInvalid && JSON.stringify(current) === JSON.stringify(next);

  let backupPath: string | undefined;
  if (!unchanged) {
    if (existed) {
      backupPath = `${configPath}.bak`;
      copyFileSync(configPath, backupPath);
    }
    // Write beside the target and rename, so a crash never leaves a half-written config.
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
  }

  let keySaved = false;
  if (plan.provider && plan.apiKey) {
    new AuthStore(paths).set(plan.provider.id, plan.apiKey);
    keySaved = true;
  }
  return { configPath, ...(backupPath ? { backupPath } : {}), replacedInvalid, keySaved };
}

// ---- non-interactive flags -----------------------------------------------------------------------

export interface SetupFlags {
  provider?: string | undefined;
  'base-url'?: string | undefined;
  model?: string | undefined;
  approval?: string | undefined;
  sandbox?: string | undefined;
  browser?: boolean | undefined;
  'no-browser'?: boolean | undefined;
}

/** Turn command-line flags into a plan, or explain what is wrong with them. */
export function planFromFlags(
  f: SetupFlags,
  apiKey: string | undefined,
): { plan: SetupPlan } | { error: string } {
  const plan: SetupPlan = {};
  if (f.provider) {
    const id = f.provider;
    const builtin = BUILTIN_PROVIDERS[id] as { type: 'anthropic' | 'openai' } | undefined;
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(id))
      return { error: `--provider "${id}" must be lowercase letters, digits, "-" or "_".` };
    if (f['base-url']) {
      let url: URL;
      try {
        url = new URL(f['base-url']);
      } catch {
        return { error: `--base-url "${f['base-url']}" is not a valid URL.` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return { error: '--base-url must start with http:// or https://' };
    }
    if (!builtin && !f['base-url'])
      return {
        error: `"${id}" is not a built-in provider, so --base-url is required (the server's /v1 address).`,
      };
    plan.provider = {
      id,
      type: builtin?.type ?? 'openai',
      ...(f['base-url'] ? { baseUrl: f['base-url'].replace(/\/+$/, '') } : {}),
    };
    if (apiKey) plan.apiKey = apiKey;
  } else if (f['base-url']) return { error: '--base-url needs --provider.' };
  else if (apiKey)
    return { error: 'An API key was given on stdin, but no --provider says which one it is for.' };

  if (f.model) {
    const spec = f.model.includes('/') || !f.provider ? f.model : `${f.provider}/${f.model}`;
    if (!spec.includes('/'))
      return { error: `--model must look like <provider>/<model>, e.g. ollama/qwen3:8b.` };
    plan.model = spec;
  }
  if (f.approval) {
    const a = approvalModeSchema.safeParse(f.approval);
    if (!a.success) return { error: `--approval must be one of ${approvalModeSchema.options.join(', ')}.` };
    plan.approval = a.data;
  }
  if (f.sandbox) {
    const s = sandboxModeSchema.safeParse(f.sandbox);
    if (!s.success) return { error: `--sandbox must be one of ${sandboxModeSchema.options.join(', ')}.` };
    plan.sandbox = s.data;
  }
  if (f.browser && f['no-browser']) return { error: 'Use either --browser or --no-browser, not both.' };
  if (f.browser) plan.browser = true;
  if (f['no-browser']) plan.browser = false;
  return { plan };
}
