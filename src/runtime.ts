import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Agent, type AgentHooks } from './agent/agent.js';
import { Broker } from './agent/broker.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { Session, sessionDir } from './agent/session.js';
import { browserTools } from './browser/tools.js';
import { BrowserService } from './browser/service.js';
import { AuthStore } from './config/auth.js';
import { loadConfig, trustProject, type LoadedConfig } from './config/load.js';
import type { ApprovalMode, Config, PartialConfig, SandboxMode, SwarmAgentConfig } from './config/schema.js';
import { loadExtensions, loadPromptTemplates, type SlashCommand } from './ext/extensions.js';
import { BUILTIN_SKILLS_DIR, SkillStore } from './ext/skills.js';
import { connectAll, type McpConnection } from './ext/mcp.js';
import { NO_MODEL, ProviderRegistry, type ResolvedModel } from './llm/registry.js';
import { projectKey } from './paths.js';
import { PolicyEngine } from './policy/engine.js';
import { createSandbox } from './sandbox/index.js';
import type { Sandbox } from './sandbox/types.js';
import { SWARM_PRESETS } from './swarm/roles.js';
import { Swarm } from './swarm/swarm.js';
import { SwarmStore, type SwarmSummary } from './swarm/store.js';
import { editUserConfig, isPlain, patchUserConfig } from './setup/plan.js';
import { swarmTools } from './swarm/tools.js';
import { bashTool } from './tools/bash.js';
import { editTool, readTool, writeTool } from './tools/fs-tools.js';
import { askUserTool, skillTool, todoTool } from './tools/misc.js';
import { ToolRegistry } from './tools/registry.js';
import { globTool, grepTool, lsTool } from './tools/search-tools.js';
import type { Question, TodoItem } from './tools/types.js';
import { webFetchTool } from './tools/web.js';
import { Emitter } from './util/emitter.js';
import { projectDirIn } from './legacy.js';
import type { ReasoningEffort } from './llm/types.js';

export interface RuntimeOptions {
  cwd: string;
  overrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** `true` resumes the latest session for this directory; a string is a session id or file path. */
  resume?: boolean | string;
  /** Do not persist the session to disk. */
  ephemeral?: boolean;
  /** Test seam: replace provider fetch. */
  fetchImpl?: typeof fetch;
}

export { SWARM_PRESETS } from './swarm/roles.js';

export interface FlushPlan {
  sessions: string[];
  swarms: string[];
  bytes: number;
}

const safeList = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const safeStat = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};
const childDirs = (dir: string): string[] =>
  safeList(dir)
    .map((n) => join(dir, n))
    .filter((p) => safeStat(p)?.isDirectory());
/** Total size and latest modification time of everything under a folder. */
function treeInfo(dir: string): { newest: number; bytes: number } {
  let newest = 0;
  let bytes = 0;
  for (const n of safeList(dir)) {
    const st = safeStat(join(dir, n));
    if (!st) continue;
    if (st.isDirectory()) {
      const sub = treeInfo(join(dir, n));
      newest = Math.max(newest, sub.newest);
      bytes += sub.bytes;
    } else {
      newest = Math.max(newest, st.mtimeMs);
      bytes += st.size;
    }
  }
  return { newest, bytes };
}

export interface AvailableModel {
  /** `<provider>/<model>`, ready to pass to --model or /model. */
  spec: string;
  provider: string;
  id: string;
  contextWindow?: number;
  loaded?: boolean;
}

/** Tell the user when compaction is running on a guessed window instead of a known one. */
function contextWarnings(spec: string, m: ResolvedModel): string[] {
  if (m.contextSource !== 'default' || m.providerId === 'none') return [];
  return [
    `${spec}: the server did not report a context window, so ${m.contextWindow.toLocaleString()} tokens is assumed. ` +
      `Set the real size with /context <tokens> in the terminal (e.g. /context 128k), or contextWindows in your config, so compaction triggers at the right point.`,
  ];
}

export type RuntimeEvents = {
  notice: string;
  todos: TodoItem[];
  mode: ApprovalMode;
  sandbox: string;
  model: string;
  /** The reasoning effort was changed (undefined: back to the model's default). */
  effort: ReasoningEffort | undefined;
};

/** Everything the UIs need, assembled once. Shared by the TUI, print mode and RPC mode. */
export class Runtime {
  readonly events = new Emitter<RuntimeEvents>();
  readonly broker = new Broker();
  todos: TodoItem[] = [];
  swarm: Swarm | undefined;
  warnings: string[] = [];
  commands: SlashCommand[] = [];

  private constructor(
    readonly cwd: string,
    readonly loaded: LoadedConfig,
    readonly auth: AuthStore,
    readonly registry: ProviderRegistry,
    readonly tools: ToolRegistry,
    readonly policy: PolicyEngine,
    public sandbox: Sandbox,
    readonly skills: SkillStore,
    readonly browser: BrowserService | undefined,
    readonly mcp: McpConnection[],
    private hooks: AgentHooks,
    readonly agent: Agent,
    private systemOverride: string | undefined,
  ) {}

  get config(): Config {
    return this.loaded.config;
  }

  static async create(opts: RuntimeOptions): Promise<Runtime> {
    const env = opts.env ?? process.env;
    const loaded = loadConfig({
      cwd: opts.cwd,
      env,
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
    });
    const { config, paths } = loaded;
    const warnings = [...loaded.warnings];
    const auth = new AuthStore(paths);
    const registry = new ProviderRegistry(config, auth, env, opts.fetchImpl);

    const sandbox = createSandbox(config, opts.cwd);
    const policy = new PolicyEngine({ mode: config.approval.mode, rules: [...config.approval.rules] });

    const tools = new ToolRegistry();
    for (const t of [
      readTool,
      writeTool,
      editTool,
      globTool,
      grepTool,
      lsTool,
      bashTool,
      webFetchTool,
      todoTool,
      askUserTool,
      skillTool,
    ]) {
      tools.register(t);
    }

    const browser = config.browser.enabled
      ? new BrowserService(config.browser, join(paths.data, 'browser-profile', projectKey(opts.cwd)))
      : undefined;
    if (browser) for (const t of browserTools) tools.register(t);

    // Skills, prompt templates and extensions: user-level always; project-level only when trusted.
    const skills = new SkillStore();
    const trusted = loaded.projectTrusted;
    const projectRoot = loaded.projectConfigPath
      ? join(loaded.projectConfigPath, '..')
      : projectDirIn(opts.cwd);
    warnings.push(
      ...skills.load([
        { dir: BUILTIN_SKILLS_DIR, source: 'built-in' },
        { dir: join(paths.config, 'skills'), source: 'user' },
        ...(trusted ? [{ dir: join(projectRoot, 'skills'), source: 'project' }] : []),
      ]),
    );
    const ext = await loadExtensions(
      [join(paths.config, 'extensions'), ...(trusted ? [join(projectRoot, 'extensions')] : [])],
      opts.cwd,
      config,
    );
    warnings.push(...ext.warnings);
    for (const t of ext.tools) tools.register(t);

    let mcp: McpConnection[] = [];
    const servers = config.mcpServers;
    if (Object.keys(servers).length) {
      const r = await connectAll(servers);
      mcp = r.connections;
      warnings.push(...r.warnings);
      for (const c of mcp) for (const t of c.tools) tools.register(t);
    }

    const systemFile = [join(projectRoot, 'SYSTEM.md'), join(paths.config, 'SYSTEM.md')].find(
      (f) => (f.startsWith(paths.config) || trusted) && existsSync(f),
    );
    const systemOverride = systemFile ? readFileSync(systemFile, 'utf8') : undefined;

    const dir = sessionDir(paths.data, projectKey(opts.cwd));
    const session = resolveSession(opts, dir);
    // No default model: the user picks one (--model or /model). Context windows are read from the server.
    const model = config.model ? await registry.resolveDetected(config.model) : NO_MODEL;
    const smallModel = config.smallModel ? await registry.resolveDetected(config.smallModel) : undefined;
    if (config.model) warnings.push(...contextWarnings(config.model, model));

    // The main agent is constructed with a placeholder system fn that is rebound below.
    // Forward reference: the agent's callbacks need the Runtime, which in turn owns the agent.
    // eslint-disable-next-line prefer-const
    let rt!: Runtime;
    const agent = new Agent({
      id: 'main',
      cwd: opts.cwd,
      config,
      model,
      ...(smallModel ? { smallModel } : {}),
      tools,
      policy,
      sandbox,
      session,
      approver: (req, sig) => rt.broker.approver(req, sig),
      system: () => rt.systemPrompt('main'),
      hooks: ext.hooks,
    });
    rt = new Runtime(
      opts.cwd,
      loaded,
      auth,
      registry,
      tools,
      policy,
      sandbox,
      skills,
      browser,
      mcp,
      ext.hooks,
      agent,
      systemOverride,
    );
    rt.warnings = warnings;
    rt.commands = [
      ...loadPromptTemplates([
        join(paths.config, 'prompts'),
        ...(trusted ? [join(projectRoot, 'prompts')] : []),
      ]),
      ...ext.commands,
    ];
    agent.setServices({
      ask: (q) => rt.broker.ask('main', q),
      setTodos: (t) => {
        rt.todos = t;
        rt.events.emit('todos', t);
      },
      ...(browser ? { browser } : {}),
      skills: { get: (n) => skills.get(n), names: () => skills.names() },
    });
    return rt;
  }

  systemPrompt(agentId: string): string {
    const swarmInfo = agentId !== 'main' && this.swarm ? this.swarmPromptFor(agentId) : undefined;
    const registry = agentId === 'main' ? this.tools : this.swarmToolsFor(agentId);
    return buildSystemPrompt(
      {
        cwd: this.cwd,
        configDir: this.loaded.paths.config,
        mode: this.policy.mode,
        sandboxDescription: this.sandbox.describe(),
        toolNames: registry.all().map((t) => t.name),
        skills: this.skills.list().map((s) => ({ name: s.name, description: s.description })),
        ...(swarmInfo ? { swarm: swarmInfo } : {}),
      },
      this.systemOverride,
    );
  }

  private swarmCfg = new Map<string, SwarmAgentConfig>();
  /** The first member of the current swarm: the only one that talks to the user. */
  private swarmLead: string | undefined;

  private swarmPromptFor(name: string) {
    const cfg = this.swarmCfg.get(name);
    if (!cfg || !this.swarm) return undefined;
    return {
      self: name,
      role: cfg.role,
      lead: this.swarmLead ?? name,
      teammates: this.swarm
        .roster()
        .filter((t) => t.name !== name)
        .map((t) => ({ name: t.name, role: t.role })),
    };
  }

  private swarmToolsFor(name: string): ToolRegistry {
    const cfg = this.swarmCfg.get(name);
    const base = this.tools.subset(cfg?.tools);
    const reg = new ToolRegistry();
    // Only the lead may ask the user anything; the others take questions to the lead.
    for (const t of base.all()) if (t.name !== 'ask_user' || name === this.swarmLead) reg.register(t);
    // swarm_spawn only when adding teammates is allowed, so models are not offered a tool that always fails.
    for (const t of swarmTools) if (t.name !== 'swarm_spawn' || this.config.swarm.allowSpawn) reg.register(t);
    return reg;
  }

  // ---- runtime controls -------------------------------------------------------------------------

  /**
   * How hard reasoning models think, for every agent (swarm members too), saved in the user config. `undefined`
   * goes back to each model's own default. Models that refused a level before are asked again.
   */
  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    if (effort) this.config.reasoningEffort = effort;
    else delete this.config.reasoningEffort;
    const models = new Set([
      this.agent.model,
      ...(this.swarm?.names.map((n) => this.swarm!.agent(n)?.model) ?? []),
    ]);
    for (const m of models) if (m) delete m.effortCap;
    editUserConfig((c) => {
      const { reasoningEffort: _old, ...rest } = c;
      return effort ? { ...rest, reasoningEffort: effort } : rest;
    }, this.loaded.paths);
    this.events.emit('effort', effort);
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.policy.setMode(mode);
    this.events.emit('mode', mode);
  }

  setSandboxMode(mode: SandboxMode): void {
    const next = createSandbox({ ...this.config, sandbox: { ...this.config.sandbox, mode } }, this.cwd);
    this.sandbox = next;
    this.agent.setSandbox(next);
    if (this.swarm) for (const n of this.swarm.names) this.swarm.agent(n)?.setSandbox(next);
    this.events.emit('sandbox', next.describe());
  }

  /** `<provider>/<model>` currently in use, or undefined until the user picks one. */
  get modelSpec(): string | undefined {
    const m = this.agent.model;
    return m.providerId === 'none' ? undefined : `${m.providerId}/${m.model}`;
  }

  async setModel(spec: string): Promise<ResolvedModel> {
    const m = await this.registry.resolveDetected(spec);
    this.agent.setModel(m);
    this.events.emit('model', spec);
    return m;
  }

  /** Every model the configured providers offer right now (unreachable providers are skipped). */
  async listModels(): Promise<AvailableModel[]> {
    const out: AvailableModel[] = [];
    await Promise.all(
      Object.keys(this.config.providers).map(async (pid) => {
        try {
          const p = this.registry.get(pid);
          if (!p.listModels) return;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          try {
            for (const m of await p.listModels(ctrl.signal)) {
              out.push({
                spec: `${pid}/${m.id}`,
                provider: pid,
                id: m.id,
                ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
                ...(m.loaded !== undefined ? { loaded: m.loaded } : {}),
              });
            }
          } finally {
            clearTimeout(t);
          }
        } catch {
          /* provider needs a key or is offline: not offered */
        }
      }),
    );
    return out.sort((a, b) => a.spec.localeCompare(b.spec));
  }

  newSession(): void {
    const dir = sessionDir(this.loaded.paths.data, projectKey(this.cwd));
    this.agent.setSession(Session.create(this.cwd, dir));
    this.todos = [];
    this.events.emit('todos', []);
  }

  trust(): void {
    trustProject(
      this.loaded.paths,
      this.loaded.projectConfigPath ? join(this.loaded.projectConfigPath, '..', '..') : this.cwd,
    );
  }

  private swarmRoot(): string {
    return join(this.loaded.paths.data, 'swarms', projectKey(this.cwd));
  }

  listSwarms(): SwarmSummary[] {
    return SwarmStore.list(this.swarmRoot());
  }

  /** Save a team as the user's `swarm.agents`, so `/swarm config` starts it again. */
  saveSwarmTeam(agents: SwarmAgentConfig[]): void {
    patchUserConfig({ swarm: { agents } } as PartialConfig, this.loaded.paths);
    this.config.swarm.agents = agents;
  }

  /**
   * How long agents may work before checking in with you, saved to your config (0 = no limit):
   * `maxMessages` agent-to-agent swarm messages between yours, `maxToolIterations` tool calls in one turn.
   * Takes effect at once, including for a swarm that is running (a paused one carries on if raised).
   */
  /**
   * Set the context window of the model in use, by hand, and save it for that model (`contextWindows` in the user
   * config), so it is used from now on instead of what the server reports. `undefined` forgets the setting and
   * goes back to the server's figure (asking it again), or the default when it reports none.
   */
  async setContextWindow(tokens: number | undefined): Promise<ResolvedModel> {
    const spec = this.modelSpec;
    if (!spec) throw new Error('No model selected. Choose one with /model first.');
    if (tokens === undefined) {
      delete this.config.contextWindows[spec];
      editUserConfig((c) => {
        const windows = isPlain(c.contextWindows) ? { ...c.contextWindows } : {};
        delete windows[spec];
        const { contextWindows: _old, ...rest } = c;
        return Object.keys(windows).length ? { ...rest, contextWindows: windows } : rest;
      }, this.loaded.paths);
    } else {
      this.config.contextWindows[spec] = tokens;
      patchUserConfig({ contextWindows: { [spec]: tokens } }, this.loaded.paths);
    }
    const fresh = await this.registry.resolveDetected(spec);
    // Change the model objects in place: swarm members on the same model share them, and the agents read the
    // window from them on every request.
    const current = this.agent.model;
    const targets = [
      current,
      ...(this.swarm ? this.swarm.names.map((n) => this.swarm!.agent(n)?.model) : []),
    ];
    for (const m of new Set(targets)) {
      if (!m || `${m.providerId}/${m.model}` !== spec) continue;
      m.contextWindow = fresh.contextWindow;
      m.contextSource = fresh.contextSource;
      if (fresh.serverWindow !== undefined) m.serverWindow = fresh.serverWindow;
    }
    this.events.emit('model', spec);
    return current;
  }

  setLimits(l: { maxMessages?: number; maxToolIterations?: number }): void {
    const patch: { swarm?: { maxMessages: number }; maxToolIterations?: number } = {};
    if (l.maxMessages !== undefined) {
      this.config.swarm.maxMessages = l.maxMessages;
      patch.swarm = { maxMessages: l.maxMessages };
      this.swarm?.setLimit(l.maxMessages);
    }
    if (l.maxToolIterations !== undefined) {
      this.config.maxToolIterations = l.maxToolIterations;
      patch.maxToolIterations = l.maxToolIterations;
    }
    patchUserConfig(patch as PartialConfig, this.loaded.paths);
  }

  /**
   * Saved conversations and swarms that `/flush` would delete. Never the conversation in use or the running
   * swarm. `olderThanDays` keeps anything touched more recently; `allFolders` looks beyond this folder.
   */
  flushPlan(opts: { olderThanDays?: number; allFolders?: boolean } = {}): FlushPlan {
    const data = this.loaded.paths.data;
    const cutoff = opts.olderThanDays ? Date.now() - opts.olderThanDays * 86_400_000 : Infinity;
    const keep = new Set(
      [this.agent.session.filePath, this.swarm ? join(this.swarmRoot(), this.swarm.id ?? '') : undefined]
        .filter((p): p is string => !!p)
        .map((p) => resolve(p)),
    );
    const roots = (kind: 'sessions' | 'swarms') =>
      opts.allFolders ? childDirs(join(data, kind)) : [join(data, kind, projectKey(this.cwd))];
    const plan: FlushPlan = { sessions: [], swarms: [], bytes: 0 };
    for (const dir of roots('sessions'))
      for (const f of safeList(dir)) {
        const file = join(dir, f);
        if (!f.endsWith('.jsonl') || keep.has(resolve(file))) continue;
        const st = safeStat(file);
        if (!st || st.mtimeMs >= cutoff) continue;
        plan.sessions.push(file);
        plan.bytes += st.size;
      }
    for (const root of roots('swarms'))
      for (const id of safeList(root)) {
        const dir = join(root, id);
        if (keep.has(resolve(dir))) continue;
        const { newest, bytes } = treeInfo(dir);
        if (newest >= cutoff) continue;
        plan.swarms.push(dir);
        plan.bytes += bytes;
      }
    return plan;
  }

  /** Delete what `flushPlan` listed. Returns how much was removed. */
  flush(plan: FlushPlan): { sessions: number; swarms: number; bytes: number } {
    for (const f of plan.sessions) rmSync(f, { force: true });
    for (const d of plan.swarms) rmSync(d, { recursive: true, force: true });
    // Tidy up per-folder directories that are now empty.
    for (const p of [...plan.sessions, ...plan.swarms]) {
      try {
        rmdirSync(dirname(p));
      } catch {
        /* not empty, or already gone */
      }
    }
    return { sessions: plan.sessions.length, swarms: plan.swarms.length, bytes: plan.bytes };
  }

  /** Start a new collaborating swarm from a preset name or an explicit agent list. */
  async startSwarm(spec: string | SwarmAgentConfig[]): Promise<Swarm> {
    if (this.swarm) throw new Error('A swarm is already running. Use /swarm stop first.');
    const agents =
      typeof spec === 'string'
        ? (SWARM_PRESETS[spec] ?? (spec === 'config' ? this.config.swarm.agents : undefined))
        : spec;
    if (!agents?.length)
      throw new Error(
        `Unknown swarm "${typeof spec === 'string' ? spec : ''}". Presets: ${Object.keys(SWARM_PRESETS).join(', ')}${this.config.swarm.agents.length ? ', config' : ''}`,
      );
    const { store, state } = SwarmStore.create(
      this.swarmRoot(),
      typeof spec === 'string' ? spec : 'custom',
      this.cwd,
    );
    return this.bringUpSwarm(agents.slice(0, this.config.swarm.maxAgents), store, { state, log: [] }, false);
  }

  /** Resume a saved swarm: same roster, notes, channel history and each member's own conversation. */
  async resumeSwarm(id: string): Promise<Swarm> {
    if (this.swarm) throw new Error('A swarm is already running. Use /swarm stop first.');
    const { store, state, log } = SwarmStore.open(this.swarmRoot(), id);
    return this.bringUpSwarm(state.agents, store, { state, log }, true);
  }

  private async bringUpSwarm(
    agents: SwarmAgentConfig[],
    store: SwarmStore,
    restore: NonNullable<ConstructorParameters<typeof Swarm>[0]['restore']>,
    resumed: boolean,
  ): Promise<Swarm> {
    // Resolve every member's model (with real context windows) up front; agent construction is synchronous.
    const models = new Map<string, ResolvedModel>();
    const resolveFor = async (cfg: SwarmAgentConfig): Promise<ResolvedModel> => {
      const m = cfg.model ? await this.registry.resolveDetected(cfg.model) : this.agent.model;
      if (m.providerId === 'none') throw new Error('Pick a model first (/model) — swarm agents need one.');
      models.set(cfg.name, m);
      return m;
    };
    for (const a of agents) await resolveFor(a);
    this.swarmLead = agents[0]?.name;

    const sw = new Swarm({
      maxAgents: this.config.swarm.maxAgents,
      maxMessages: this.config.swarm.maxMessages,
      allowSpawn: this.config.swarm.allowSpawn,
      store,
      restore,
      createAgent: (cfg, member) => {
        this.swarmCfg.set(cfg.name, cfg);
        const model = models.get(cfg.name) ?? this.agent.model;
        return new Agent({
          id: cfg.name,
          cwd: this.cwd,
          config: this.config,
          model,
          ...(this.agent.smallModelResolved ? { smallModel: this.agent.smallModelResolved } : {}),
          tools: this.swarmToolsFor(cfg.name),
          policy: this.policy,
          sandbox: this.sandbox,
          // A normal, persistent session per member: same format, compaction and resume as the main agent.
          session: Session.open(store.sessionFile(cfg.name), this.cwd),
          approver: (req, sig) => this.broker.approver(req, sig),
          system: () => this.systemPrompt(cfg.name),
          hooks: this.hooks,
          services: {
            swarm: member,
            ...(cfg.name === this.swarmLead ? { ask: (q: Question) => this.broker.ask(cfg.name, q) } : {}),
            ...(this.browser ? { browser: this.browser } : {}),
            skills: { get: (n) => this.skills.get(n), names: () => this.skills.names() },
          },
        });
      },
    });
    this.swarm = sw;
    for (const a of agents) await sw.addAgent(a, { resumed });
    sw.flush();
    return sw;
  }

  stopSwarm(): void {
    this.swarm?.abortAll();
    this.swarm?.flush();
    this.swarm = undefined;
    this.swarmCfg.clear();
    this.swarmLead = undefined;
  }

  async dispose(): Promise<void> {
    this.agent.abort();
    this.swarm?.abortAll();
    this.swarm?.flush();
    await Promise.allSettled([this.browser?.close(), ...this.mcp.map((c) => c.close())]);
  }
}

function resolveSession(opts: RuntimeOptions, dir: string): Session {
  if (opts.ephemeral) return Session.create(opts.cwd);
  if (opts.resume) {
    if (typeof opts.resume === 'string') {
      const file = existsSync(opts.resume) ? opts.resume : join(dir, `${opts.resume}.jsonl`);
      return Session.load(file);
    }
    const latest = Session.list(dir)[0];
    if (latest) return Session.load(latest.file);
  }
  return Session.create(opts.cwd, dir);
}
