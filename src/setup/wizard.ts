import { join } from 'node:path';
import { AuthStore } from '../config/auth.js';
import { BUILTIN_PROVIDERS, loadConfig, type LoadedConfig } from '../config/load.js';
import { providerSchema, type Config } from '../config/schema.js';
import type { Check } from '../doctor.js';
import { ProviderRegistry } from '../llm/registry.js';
import { ProviderError, type ModelInfo } from '../llm/types.js';
import type { AppPaths } from '../paths.js';
import { BIN, NAME, VERSION } from '../version.js';
import { applyPlan, type SetupPlan } from './plan.js';
import { Cancelled, type Prompter } from './prompt.js';
import { chooseTelegram, describeTelegram } from './telegram.js';
import type { Term } from './ui.js';
import { TELEGRAM_KEY } from '../telegram/api.js';

export interface WizardContext {
  term: Term;
  prompt: Prompter;
  env: NodeJS.ProcessEnv;
  cwd: string;
  paths: AppPaths;
  /** Network access for key checks and local-server detection (tests substitute their own). */
  fetchImpl?: typeof fetch;
  systemChecks: () => Promise<Check[]>;
}

type ProviderPlan = NonNullable<SetupPlan['provider']>;

interface ProviderOutcome {
  provider: ProviderPlan;
  label: string;
  apiKey?: string;
  /** Where an already-available key came from, for the summary. */
  keyFrom?: string;
  /** Models the server listed; undefined when it could not be reached. */
  models?: ModelInfo[];
}

interface Preset {
  id: string;
  label: string;
  blurb: string;
  kind: 'cloud' | 'local';
  keyUrl?: string;
  startHint?: string;
}

const PRESETS: Preset[] = [
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

const builtinUrl = (id: string): string =>
  ((BUILTIN_PROVIDERS[id] as { baseUrl?: string } | undefined)?.baseUrl ?? '').replace(/\/+$/, '');

/** The credential store, plus keys typed during this run that are not saved yet. */
class PendingAuth extends AuthStore {
  readonly pending = new Map<string, string>();
  constructor(paths: AppPaths) {
    super(paths);
  }
  override get(provider: string): string | undefined {
    return this.pending.get(provider) ?? super.get(provider);
  }
}

type Listing =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; kind: 'rejected' | 'unreachable' | 'other'; message: string };

function errorText(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const base = e instanceof Error ? e.message : String(e);
  return cause?.code ? `${base} (${cause.code})` : base;
}

export async function runWizard(ctx: WizardContext): Promise<number> {
  const t = ctx.term;
  t.banner(
    `${NAME.toLowerCase()} setup`,
    `v${VERSION}. About a minute; nothing is saved until the last step. Ctrl+C quits.`,
  );

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig({ cwd: ctx.cwd, env: ctx.env, paths: ctx.paths });
  } catch (e) {
    t.fail('Your current configuration has a problem', (e as Error).message);
    t.note(`Fix or remove ${ctx.paths.config}/config.json and run \`${BIN} setup\` again.`);
    return 1;
  }
  const auth = new PendingAuth(ctx.paths);
  const config = loaded.config;

  try {
    // ---- 1. system ---------------------------------------------------------------------------
    t.heading('Your system', '1 of 5');
    const sp = t.spinner('Looking around…');
    const checks = await ctx.systemChecks();
    sp.stop();
    const byId = (id: Check['id']) => checks.find((c) => c.id === id);
    for (const id of ['node', 'git', 'browser', 'container'] as const) {
      const c = byId(id);
      if (!c) continue;
      if (c.ok === true) t.ok(c.label, c.detail);
      else if (c.ok === 'warn') t.warning(c.label, c.detail.split(' — ')[0]);
      else t.fail(c.label, c.detail);
    }
    const hasContainer = byId('container')?.ok === true;
    const hasBrowser = byId('browser')?.ok === true;

    for (;;) {
      const plan: SetupPlan = {};

      // ---- 2. provider -----------------------------------------------------------------------
      t.heading('Where your models come from', '2 of 5');
      const outcome = await chooseProvider(ctx, config, auth);
      if (outcome) {
        plan.provider = outcome.provider;
        if (outcome.apiKey) plan.apiKey = outcome.apiKey;
      }

      // ---- 3. model --------------------------------------------------------------------------
      if (outcome) {
        t.heading('Your model', '3 of 5');
        const model = await chooseModel(ctx, outcome, config.model);
        if (model) plan.model = model;
      } else {
        t.heading('Your model', '3 of 5');
        t.info('Skipped. Pick one in the app, or run `' + BIN + ' auth set <provider>` later.');
      }

      // ---- 4. safety -------------------------------------------------------------------------
      t.heading('Safety', '4 of 5');
      plan.approval = await ctx.prompt.select({
        message: 'How much should the agent ask before it acts?',
        initial: ['ask', 'edits', 'auto', 'plan'].indexOf(config.approval.mode),
        choices: [
          { value: 'ask' as const, label: 'ask', hint: 'confirm file edits and commands (recommended)' },
          { value: 'edits' as const, label: 'edits', hint: 'edit files freely, confirm commands' },
          { value: 'auto' as const, label: 'auto', hint: 'no prompts; dangerous commands are still blocked' },
          { value: 'plan' as const, label: 'plan', hint: 'read-only: investigate and propose a plan' },
        ],
      });
      plan.sandbox = await chooseSandbox(ctx, config, hasContainer);
      plan.browser = await ctx.prompt.confirm({
        message: 'Let the agent drive a web browser?',
        initial: hasBrowser ? config.browser.enabled : false,
        help: hasBrowser
          ? 'Uses the Chrome or Edge on this computer, and you can watch every step.'
          : `No Chrome or Edge found. You can turn this on later (see \`${BIN} doctor\`).`,
      });

      // ---- 5. telegram -----------------------------------------------------------------------
      t.heading('Telegram', '5 of 5');
      const telegram = await chooseTelegram(ctx, config, auth.get(TELEGRAM_KEY));
      if (telegram) plan.telegram = telegram;

      // ---- review ----------------------------------------------------------------------------
      t.heading('Review');
      t.table([
        ['Provider', outcome ? describeOutcome(outcome) : 'not set'],
        ['Model', plan.model ?? 'choose in the app'],
        ['Approvals', plan.approval],
        ['Sandbox', plan.sandbox],
        ['Browser', plan.browser ? 'on' : 'off'],
        ['Telegram', describeTelegram(plan.telegram, config)],
        ['Saved to', join(ctx.paths.config, 'config.json')],
      ]);
      t.line();
      const next = await ctx.prompt.select({
        message: 'Save these settings?',
        choices: [
          { value: 'save' as const, label: 'Save and finish' },
          { value: 'again' as const, label: 'Start over', hint: 'go back to the provider question' },
          { value: 'quit' as const, label: 'Quit without saving' },
        ],
      });
      if (next === 'again') continue;
      if (next === 'quit') {
        t.line();
        t.info('Nothing was saved.');
        return 1;
      }
      return save(ctx, plan, outcome);
    }
  } catch (e) {
    if (e instanceof Cancelled) {
      t.line();
      t.info(`Setup cancelled. Nothing was saved. Run \`${BIN} setup\` whenever you like.`);
      return 130;
    }
    throw e;
  }
}

// ---- providers -----------------------------------------------------------------------------------

async function listModels(
  ctx: WizardContext,
  config: Config,
  auth: PendingAuth,
  id: string,
  timeoutMs: number,
): Promise<Listing> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const registry = new ProviderRegistry(config, auth, ctx.env, ctx.fetchImpl);
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

/** The loaded config with one provider added or pointed somewhere else. */
function withProvider(config: Config, p: ProviderPlan): Config {
  const base = config.providers[p.id];
  const next = providerSchema.parse({
    ...(base ?? {}),
    type: p.type,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
  });
  return { ...config, providers: { ...config.providers, [p.id]: next } };
}

async function chooseProvider(
  ctx: WizardContext,
  config: Config,
  auth: PendingAuth,
): Promise<ProviderOutcome | null> {
  const t = ctx.term;
  const locals = PRESETS.filter((p) => p.kind === 'local');
  const sp = t.spinner('Looking for model servers on this computer…');
  const running = new Map<string, boolean>();
  await Promise.all(
    locals.map(async (p) => {
      const r = await listModels(ctx, config, auth, p.id, 900);
      running.set(p.id, r.ok);
    }),
  );
  sp.stop();
  const found = locals.filter((p) => running.get(p.id));
  if (found.length) t.ok(`Found ${found.map((p) => p.label).join(', ')} running`);

  const keyHint = (p: Preset): string => {
    const env = config.providers[p.id]?.apiKeyEnv;
    const has = auth.get(p.id)
      ? 'key saved'
      : env && ctx.env[env]
        ? `key found in $${env}`
        : 'needs an API key';
    return `${p.blurb} · ${has}`;
  };
  const currentProvider = config.model?.split('/')[0];
  const presetIndex = PRESETS.findIndex((p) => p.id === currentProvider);
  const firstRunning = PRESETS.findIndex((p) => running.get(p.id));

  for (;;) {
    const pick = await ctx.prompt.select<string>({
      message: 'Which provider do you want to use?',
      help: 'You can add or switch providers any time by running this again.',
      initial: presetIndex >= 0 ? presetIndex : firstRunning >= 0 ? firstRunning : 0,
      choices: [
        ...PRESETS.map((p) => ({
          value: p.id,
          label: p.label,
          hint:
            p.kind === 'cloud'
              ? keyHint(p)
              : `${p.blurb} · ${running.get(p.id) ? 'running now' : 'not running'}`,
        })),
        {
          value: 'custom',
          label: 'Something else',
          hint: 'any OpenAI-compatible server (vLLM, a gateway, ...)',
        },
        { value: 'skip', label: 'Skip for now', hint: `choose later with \`${BIN}\` or \`${BIN} auth set\`` },
      ],
    });
    if (pick === 'skip') return null;
    const preset = PRESETS.find((p) => p.id === pick);
    const result = preset
      ? preset.kind === 'cloud'
        ? await setupCloud(ctx, config, auth, preset)
        : await setupServer(
            ctx,
            config,
            auth,
            preset.id,
            preset.label,
            preset.startHint,
            builtinUrl(preset.id),
          )
      : await setupCustom(ctx, config, auth);
    if (result !== 'back') return result;
  }
}

async function setupCloud(
  ctx: WizardContext,
  config: Config,
  auth: PendingAuth,
  preset: Preset,
): Promise<ProviderOutcome | 'back'> {
  const t = ctx.term;
  const cfg = config.providers[preset.id]!;
  const provider: ProviderPlan = { id: preset.id, type: cfg.type };
  const envName = cfg.apiKeyEnv;
  const existing = auth.get(preset.id)
    ? 'saved earlier'
    : envName && ctx.env[envName]
      ? `$${envName}`
      : undefined;

  let needNew = true;
  if (existing) {
    needNew = !(await ctx.prompt.confirm({
      message: `Use the ${preset.label} API key you already have?`,
      help: `Found: ${existing}`,
    }));
  }
  for (;;) {
    let key: string | undefined;
    if (needNew) {
      key = await ctx.prompt.secret({
        message: `${preset.label} API key`,
        help: `Create one at ${preset.keyUrl}. It is stored only on this computer.`,
        validate: (v) =>
          !v
            ? 'Paste your key to continue.'
            : /\s/.test(v)
              ? 'Keys have no spaces; check what you pasted.'
              : undefined,
      });
      auth.pending.set(preset.id, key);
    }
    const sp = t.spinner(`Checking the key with ${preset.label}…`);
    const r = await listModels(ctx, config, auth, preset.id, 8000);
    if (r.ok) {
      sp.succeed(`${preset.label} accepted the key`);
      return {
        provider,
        label: preset.label,
        ...(key ? { apiKey: key } : {}),
        ...(!key && existing ? { keyFrom: existing } : {}),
        models: r.models,
      };
    }
    if (r.kind === 'rejected') sp.fail(`${preset.label} rejected that key`, r.message);
    else sp.warn(`Could not check the key with ${preset.label}`, r.message);
    const action = await ctx.prompt.select({
      message: 'What now?',
      choices: [
        { value: 'retry' as const, label: 'Enter a different key' },
        {
          value: 'keep' as const,
          label: 'Keep this key anyway',
          hint:
            r.kind === 'rejected'
              ? 'it was rejected, so requests will fail'
              : 'e.g. you are offline right now',
        },
        { value: 'back' as const, label: 'Choose another provider' },
      ],
    });
    if (action === 'back') {
      auth.pending.delete(preset.id);
      return 'back';
    }
    if (action === 'keep') {
      return {
        provider,
        label: preset.label,
        ...(key ? { apiKey: key } : {}),
        ...(!key && existing ? { keyFrom: existing } : {}),
      };
    }
    needNew = true;
  }
}

/** A local or custom OpenAI-compatible server: find it, and let the user fix the address if needed. */
async function setupServer(
  ctx: WizardContext,
  config: Config,
  auth: PendingAuth,
  id: string,
  label: string,
  startHint: string | undefined,
  defaultUrl: string,
): Promise<ProviderOutcome | 'back'> {
  const t = ctx.term;
  let url = (config.providers[id]?.baseUrl ?? defaultUrl).replace(/\/+$/, '');
  for (;;) {
    const provider: ProviderPlan = {
      id,
      type: 'openai',
      ...(url !== defaultUrl || !BUILTIN_PROVIDERS[id] ? { baseUrl: url } : {}),
    };
    const sp = t.spinner(`Connecting to ${label} at ${url}…`);
    const r = await listModels(ctx, withProvider(config, provider), auth, id, 4000);
    if (r.ok) {
      sp.succeed(
        `${label} is running`,
        `${r.models.length} model${r.models.length === 1 ? '' : 's'} available`,
      );
      return { provider, label, models: r.models };
    }
    if (r.kind === 'rejected')
      sp.fail(`${label} refused the connection`, `${r.message} — it may need an API key`);
    else sp.warn(`Could not reach ${label} at ${url}`, r.message);
    if (startHint) t.note(startHint);
    const action = await ctx.prompt.select({
      message: 'What now?',
      choices: [
        { value: 'retry' as const, label: 'Check again', hint: 'after starting the server' },
        { value: 'url' as const, label: 'Use a different address' },
        { value: 'keep' as const, label: 'Continue without checking', hint: 'you can start it later' },
        { value: 'back' as const, label: 'Choose another provider' },
      ],
    });
    if (action === 'back') return 'back';
    if (action === 'keep') return { provider, label };
    if (action === 'url') {
      url = (
        await ctx.prompt.text({
          message: `${label} address`,
          initial: url,
          help: 'The OpenAI-compatible base URL, usually ending in /v1.',
          validate: validateUrl,
        })
      ).replace(/\/+$/, '');
    }
  }
}

async function setupCustom(
  ctx: WizardContext,
  config: Config,
  auth: PendingAuth,
): Promise<ProviderOutcome | 'back'> {
  const typedName = await ctx.prompt.text({
    message: 'A short name for this provider',
    placeholder: 'custom',
    help: 'Models will be written as <name>/<model>. Press Enter to use "custom".',
    validate: (v) =>
      v === ''
        ? undefined
        : !/^[a-z][a-z0-9_-]{0,23}$/.test(v)
          ? 'Use lowercase letters, digits, "-" or "_" (start with a letter).'
          : config.providers[v]
            ? `"${v}" is already taken; choose another name.`
            : undefined,
  });
  const id = typedName || 'custom';
  const address = await ctx.prompt.text({
    message: 'Server address',
    placeholder: 'http://localhost:8000/v1',
    help: 'The OpenAI-compatible base URL, usually ending in /v1.',
    validate: validateUrl,
  });
  const key = await ctx.prompt.secret({
    message: 'API key',
    help: 'Leave blank if the server does not need one.',
  });
  if (key) auth.pending.set(id, key);
  const url = address.replace(/\/+$/, '');
  const base = withProvider(config, { id, type: 'openai', baseUrl: url });
  const result = await setupServer(ctx, base, auth, id, id, undefined, url);
  if (result === 'back') {
    auth.pending.delete(id);
    return 'back';
  }
  return { ...result, ...(key ? { apiKey: key } : {}) };
}

function validateUrl(v: string): string | undefined {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? undefined
      : 'The address must start with http:// or https://';
  } catch {
    return 'That does not look like an address, e.g. http://localhost:8000/v1';
  }
}

// ---- model and safety ----------------------------------------------------------------------------

async function chooseModel(
  ctx: WizardContext,
  outcome: ProviderOutcome,
  currentSpec: string | undefined,
): Promise<string | undefined> {
  const id = outcome.provider.id;
  const prefix = `${id}/`;
  const current = currentSpec?.startsWith(prefix) ? currentSpec.slice(prefix.length) : undefined;
  const models = outcome.models ?? [];
  const typed = async (): Promise<string | undefined> => {
    const name = await ctx.prompt.text({
      message: 'Model name',
      help: `Written as ${prefix}<name>. Leave blank to choose in the app.`,
      ...(current ? { initial: current } : {}),
    });
    return name ? prefix + name : undefined;
  };
  if (models.length === 0) {
    if (outcome.models)
      ctx.term.info('The server did not list any models yet (for Ollama: `ollama pull <model>`).');
    return typed();
  }

  const LIMIT = 10;
  const shown = models.slice(0, LIMIT);
  const hint = (m: ModelInfo) =>
    [m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : '', m.loaded ? 'loaded' : '']
      .filter(Boolean)
      .join(' · ');
  const pick = await ctx.prompt.select<string>({
    message: 'Which model should it start with?',
    help:
      models.length > LIMIT
        ? `Showing ${LIMIT} of ${models.length}. Choose "Type a name" for any other.`
        : 'You can switch any time with /model.',
    initial: Math.max(
      0,
      shown.findIndex((m) => m.id === current),
    ),
    choices: [
      ...shown.map((m) => ({ value: `m:${m.id}`, label: m.id, hint: hint(m) })),
      { value: 'type', label: 'Type a name…' },
      { value: 'later', label: 'Decide later', hint: 'the app will show a model picker' },
    ],
  });
  if (pick === 'later') return undefined;
  if (pick === 'type') return typed();
  return prefix + pick.slice(2);
}

async function chooseSandbox(ctx: WizardContext, config: Config, hasContainer: boolean) {
  for (;;) {
    const mode = await ctx.prompt.select({
      message: 'How tightly should the agent be fenced in?',
      initial: ['guard', 'container', 'off'].indexOf(config.sandbox.mode),
      choices: [
        {
          value: 'guard' as const,
          label: 'guard',
          hint: 'file tools stay inside your project (recommended)',
        },
        {
          value: 'container' as const,
          label: 'container',
          hint: 'every command runs in a throw-away Docker container',
          ...(hasContainer ? {} : { disabled: 'needs Docker or Podman running' }),
        },
        { value: 'off' as const, label: 'off', hint: 'no limits at all' },
      ],
    });
    if (mode !== 'off') return mode;
    const sure = await ctx.prompt.confirm({
      message: 'Really turn the sandbox off?',
      initial: false,
      help: 'The agent could then read and change any file you can.',
    });
    if (sure) return mode;
  }
}

// ---- finishing -----------------------------------------------------------------------------------

function describeOutcome(o: ProviderOutcome): string {
  const bits = [o.label];
  if (o.apiKey) bits.push('new key (stored securely)');
  else if (o.keyFrom) bits.push(`key from ${o.keyFrom}`);
  if (o.provider.baseUrl) bits.push(o.provider.baseUrl);
  if (o.models === undefined && o.provider.type === 'openai') bits.push('not checked');
  return bits.join(' · ');
}

function save(ctx: WizardContext, plan: SetupPlan, outcome: ProviderOutcome | null): number {
  const t = ctx.term;
  t.line();
  let result;
  try {
    result = applyPlan(plan, ctx.paths);
  } catch (e) {
    t.fail('Could not save your settings', (e as Error).message);
    t.note(`Check that ${ctx.paths.config} is writable, then run \`${BIN} setup\` again.`);
    return 1;
  }
  t.ok('Settings saved', result.configPath);
  if (result.keySaved) t.ok('API key stored with owner-only permissions', `${ctx.paths.config}/auth.json`);
  if (result.telegramTokenSaved)
    t.ok('Telegram bot token stored with owner-only permissions', `${ctx.paths.config}/auth.json`);
  if (plan.telegram?.off) t.ok('Telegram bot turned off');
  if (result.backupPath) t.info(`Your previous settings are kept in ${result.backupPath}`);
  if (result.replacedInvalid)
    t.warning(
      'The old config.json was not valid JSON, so it was replaced',
      `(copy in ${result.backupPath ?? 'config.json.bak'})`,
    );

  const overrides: [string, string, unknown][] = [
    ['NACRE_MODEL', 'model', plan.model],
    ['NACRE_APPROVAL', 'approval mode', plan.approval],
    ['NACRE_SANDBOX', 'sandbox', plan.sandbox],
  ];
  for (const [name, what, chosen] of overrides) {
    if (chosen !== undefined && ctx.env[name])
      t.warning(`${name} is set in your environment`, `and overrides the ${what} you just saved`);
  }

  t.heading('You are all set');
  t.line();
  t.table([
    [BIN, 'start the terminal UI (run it inside a project folder)'],
    [`${BIN} serve`, 'open the browser dashboard'],
    ...(plan.telegram && !plan.telegram.off
      ? [
          [`${BIN} telegram`, 'start your Telegram bot (keep it running to use it from your phone)'] as [
            string,
            string,
          ],
        ]
      : []),
    [`${BIN} -p "..."`, 'one-shot answers for scripts'],
    [`${BIN} doctor`, 'check your environment'],
    [`${BIN} setup`, 'run this wizard again'],
  ]);
  t.line();
  if (!outcome) t.note(`Add a provider later with \`${BIN} setup\` or \`${BIN} auth set <provider>\`.`);
  t.line();
  return 0;
}
