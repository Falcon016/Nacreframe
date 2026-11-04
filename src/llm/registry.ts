import type { AuthStore } from '../config/auth.js';
import type { Config } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';
import type { Provider, StreamEvent } from './types.js';
import { ProviderError } from './types.js';

export interface ResolvedModel {
  provider: Provider;
  providerId: string;
  model: string;
  /** Context window in tokens; compaction is measured against it. Updated if the server proves it smaller. */
  contextWindow: number;
  contextSource: 'config' | 'detected' | 'default';
  /** What the server reported at startup, when it did (kept when the user sets another size). */
  serverWindow?: number;
  /** The most output tokens the provider accepts in one reply, once it has told us (from a rejected request). */
  maxOutput?: number;
}

const DEFAULT_CONTEXT = 200_000;

/** Split `provider/model`. Model ids may themselves contain slashes (e.g. `ollama/library/qwen`). */
export function parseModelSpec(spec: string, config: Config): { providerId: string; model: string } {
  const i = spec.indexOf('/');
  const head = i === -1 ? '' : spec.slice(0, i);
  if (head && config.providers[head]) return { providerId: head, model: spec.slice(i + 1) };
  throw new Error(
    `Model "${spec}" must be written as <provider>/<model>. Known providers: ${Object.keys(config.providers).join(', ')}`,
  );
}

export class ProviderRegistry {
  private cache = new Map<string, Provider>();

  constructor(
    private config: Config,
    private auth: AuthStore,
    private env: NodeJS.ProcessEnv = process.env,
    private fetchImpl?: typeof fetch,
  ) {}

  get(providerId: string): Provider {
    const hit = this.cache.get(providerId);
    if (hit) return hit;
    const cfg = this.config.providers[providerId];
    if (!cfg) throw new Error(`Unknown provider "${providerId}"`);
    const key = this.auth.get(providerId) ?? (cfg.apiKeyEnv ? this.env[cfg.apiKeyEnv] : undefined);
    const f = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};
    let p: Provider;
    if (cfg.type === 'anthropic') {
      if (!key) throw new Error(missingKey(providerId, cfg.apiKeyEnv));
      p = new AnthropicProvider({
        id: providerId,
        apiKey: key,
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        ...f,
      });
    } else {
      if (!cfg.baseUrl) throw new Error(`Provider "${providerId}" needs a baseUrl`);
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(cfg.baseUrl);
      if (!key && !local && cfg.apiKeyEnv) throw new Error(missingKey(providerId, cfg.apiKeyEnv));
      p = new OpenAICompatProvider({
        id: providerId,
        baseUrl: cfg.baseUrl,
        apiKey: key,
        headers: cfg.headers,
        ...f,
      });
    }
    this.cache.set(providerId, p);
    return p;
  }

  /** Resolve with a configured/default context window (synchronous; see `resolveDetected`). */
  resolve(spec: string): ResolvedModel {
    const { providerId, model } = parseModelSpec(spec, this.config);
    const cfg = this.config.providers[providerId];
    const configured = this.config.contextWindows[spec] ?? cfg?.contextWindow;
    return {
      provider: this.get(providerId),
      providerId,
      model,
      contextWindow: configured ?? defaultContext(cfg?.type),
      contextSource: configured ? 'config' : 'default',
    };
  }

  /**
   * Resolve and find out the model's real context window. Compaction triggers at a fraction of this number,
   * so a wrong guess would mean overflowing the server (too large) or compacting needlessly (too small).
   * The server is always asked (once, here); a size the user set (`contextWindows`, `/context`) wins over what it
   * reports, and with neither a conservative default is used.
   */
  async resolveDetected(spec: string, timeoutMs = 3000): Promise<ResolvedModel> {
    const r = this.resolve(spec);
    if (!r.provider.listModels) return r;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const models = await r.provider.listModels(ctrl.signal);
      const hit = models.find((m) => m.id === r.model || m.aliases?.includes(r.model));
      if (hit?.contextWindow)
        return r.contextSource === 'config'
          ? { ...r, serverWindow: hit.contextWindow }
          : {
              ...r,
              contextWindow: hit.contextWindow,
              contextSource: 'detected',
              serverWindow: hit.contextWindow,
            };
    } catch {
      /* server unreachable or not reporting: keep the default */
    } finally {
      clearTimeout(timer);
    }
    return r;
  }
}

/** Placeholder used until the user picks a model: fails loudly instead of silently choosing one. */
class NoModelProvider implements Provider {
  readonly id = 'none';
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<StreamEvent> {
    throw new ProviderError(
      'No model selected. Choose one with /model, or start with --model <provider>/<model>.',
    );
  }
}

export const NO_MODEL: ResolvedModel = {
  provider: new NoModelProvider(),
  providerId: 'none',
  model: '',
  contextWindow: 0,
  contextSource: 'default',
};

/** Anthropic models are ≥200k; for unknown OpenAI-compatible servers assume a modest window so we never overflow. */
function defaultContext(type: 'anthropic' | 'openai' | undefined): number {
  return type === 'anthropic' ? DEFAULT_CONTEXT : 32_768;
}

function missingKey(id: string, env?: string): string {
  return `No API key for "${id}". Set ${env ?? 'the key'} in your environment or run \`nacre auth set ${id}\`.`;
}
