import { AuthStore } from '../config/auth.js';
import { BUILTIN_PROVIDERS } from '../config/load.js';
import { providerSchema, type Config } from '../config/schema.js';
import type { AppPaths } from '../paths.js';
import { ProviderRegistry } from './registry.js';
import { ProviderError, type ModelInfo } from './types.js';

/**
 * Connecting to providers, shared by `nexus setup` and `/login`: the providers offered by name, checking an address
 * or key before it is saved, and the config entry for a provider pointed somewhere else.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  blurb: string;
  /** Cloud providers need an API key; local servers need an address (and sometimes a key). */
  kind: 'cloud' | 'local';
  keyUrl?: string;
  startHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb: 'Claude models',
    kind: 'cloud',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'GPT models',
    kind: 'cloud',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: 'models on this computer',
    kind: 'local',
    startHint: 'Start it with `ollama serve`, then fetch a model, e.g. `ollama pull qwen3:8b`.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    blurb: 'models on this computer',
    kind: 'local',
    startHint: 'In LM Studio open the Developer tab and start the local server.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    blurb: 'a llama-server on this computer',
    kind: 'local',
    startHint: 'Start it with `llama-server -m <model.gguf> --port 8080`.',
  },
];

export const builtinUrl = (id: string): string =>
  ((BUILTIN_PROVIDERS[id] as { baseUrl?: string } | undefined)?.baseUrl ?? '').replace(/\/+$/, '');

/** Where a provider should point: its id, wire type, and address (omitted = the built-in default). */
export interface ProviderPlan {
  id: string;
  type: 'openai' | 'anthropic';
  baseUrl?: string;
}

/** The credential store, plus keys typed but not saved yet. */
export class PendingAuth extends AuthStore {
  readonly pending = new Map<string, string>();
  constructor(paths: AppPaths) {
    super(paths);
  }
  override get(provider: string): string | undefined {
    return this.pending.get(provider) ?? super.get(provider);
  }
}

export type Listing =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; kind: 'rejected' | 'unreachable' | 'other'; message: string };

export function errorText(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const base = e instanceof Error ? e.message : String(e);
  return cause?.code ? `${base} (${cause.code})` : base;
}

/** The config with one provider added or pointed somewhere else. */
export function withProvider(config: Config, p: ProviderPlan): Config {
  const base = config.providers[p.id];
  const next = providerSchema.parse({
    ...(base ?? {}),
    type: p.type,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
  });
  return { ...config, providers: { ...config.providers, [p.id]: next } };
}

/** Ask a provider for its models: proves the address and key work. Nothing is saved. */
export async function probeProvider(
  config: Config,
  auth: AuthStore,
  id: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<Listing> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const registry = new ProviderRegistry(config, auth, env, fetchImpl);
    const provider = registry.get(id);
    if (!provider.listModels) return { ok: true, models: [] };
    return { ok: true, models: await provider.listModels(ctrl.signal) };
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403))
      return { ok: false, kind: 'rejected', message: `HTTP ${e.status}` };
    if (e instanceof ProviderError && e.status)
      return { ok: false, kind: 'other', message: `HTTP ${e.status}` };
    if (ctrl.signal.aborted) return { ok: false, kind: 'unreachable', message: 'timed out' };
    return { ok: false, kind: 'unreachable', message: errorText(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Why a name cannot be used for a server added by hand, or undefined when it can. */
export function providerNameProblem(v: string): string | undefined {
  if (!/^[a-z][a-z0-9_-]{0,23}$/.test(v))
    return 'Use lowercase letters, digits, "-" or "_" (start with a letter).';
  if (Object.hasOwn(BUILTIN_PROVIDERS, v))
    return `"${v}" is a built-in provider; choose another name (or pick it from the list).`;
  return undefined;
}

export const validateUrl = (v: string): string | undefined => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? undefined
      : 'The address must start with http:// or https://';
  } catch {
    return 'That does not look like an address, e.g. http://localhost:8000/v1';
  }
};
