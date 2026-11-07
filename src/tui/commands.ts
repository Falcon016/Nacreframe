import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTokenCount } from '../util/text.js';
import { Session, sessionDir } from '../agent/session.js';
import type { ApprovalMode, SandboxMode } from '../config/schema.js';
import { trustProject } from '../config/load.js';
import { projectKey } from '../paths.js';
import type { LoginTarget, Runtime } from '../runtime.js';
import { SWARM_PRESETS, type FlushPlan } from '../runtime.js';
import { assembleTeam, parseTeam, PRESET_SUMMARY, roleByKey, ROLES, type TeamSlot } from '../swarm/roles.js';
import { checkForUpdate, requestRelaunch, runUpdate, short } from '../update.js';
import { BIN } from '../version.js';
import type { AskOptions, Choice } from './dialogs.js';
import { replayInto, type UiStore } from './store.js';
import { MODE_STYLE } from './theme.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/types.js';
import {
  builtinUrl,
  providerNameProblem,
  validateUrl,
  type Listing,
  type ProviderPlan,
} from '../llm/connect.js';

export type Overlay = {
  title: string;
  items: Choice<unknown>[];
  initial?: number;
  onSelect(v: never): void;
  onCancel?(): void;
};

export interface CmdCtx {
  runtime: Runtime;
  store: UiStore;
  /** Send text to the agent as a normal user prompt. */
  prompt(text: string): void;
  overlay(o: Overlay): void;
  exit(): void;
  togglePanes(): void;
  /** Show (true), hide (false) or flip (undefined) agents' reasoning. */
  setThinking(on?: boolean): void;
  refresh(): void;
  /** Ask for a line of text; undefined when skipped. `secret` masks it (API keys), `initial` pre-fills it. */
  ask(question: string, opts?: AskOptions): Promise<string | undefined>;
}

/** Show a picker and wait for the choice; undefined if the user presses esc. */
function pick<T>(c: CmdCtx, title: string, items: Choice<T>[], initial?: number): Promise<T | undefined> {
  return new Promise((resolve) =>
    c.overlay({
      title,
      items: items as Choice<unknown>[],
      ...(initial !== undefined ? { initial } : {}),
      onSelect: (v: never) => resolve(v as T),
      onCancel: () => resolve(undefined),
    }),
  );
}

const NEW_SERVER = '\0new';

const keyHint = (k: LoginTarget['key']) => (k === 'saved' ? 'key saved' : k ? `key from ${k}` : '');

function targetHint(t: LoginTarget): string {
  const where = t.kind === 'cloud' ? (t.key ? keyHint(t.key) : 'needs an API key') : (t.baseUrl ?? '');
  return [where, t.kind !== 'cloud' ? keyHint(t.key) : '', t.current ? 'in use' : '']
    .filter(Boolean)
    .join(' · ');
}

/** Ask for a server address until it is valid; undefined if the user backs out. */
async function askAddress(c: CmdCtx, label: string, initial: string): Promise<string | undefined> {
  let start = initial;
  for (;;) {
    const v = await c.ask(`${label} server address`, {
      title: `Connect ${label}`,
      initial: start,
      help: 'An OpenAI-compatible base URL, usually ending in /v1. Enter keeps it; ctrl+u clears it.',
    });
    if (v === undefined || v === '') return undefined;
    const problem = validateUrl(v);
    if (!problem) return v.replace(/\/+$/, '');
    c.store.notice(problem, 'warn');
    start = v;
  }
}

/**
 * `/login`, after pi's: pick a provider, then give it what it needs. A cloud provider takes an API key; a local or
 * added server takes an address (pre-filled, so swapping llama.cpp servers is one edit) and a key only if it asks
 * for one. Each is checked by listing its models before anything is saved, then you pick one of them.
 */
async function login(c: CmdCtx, arg: string): Promise<void> {
  const { runtime, store } = c;
  const targets = runtime.loginTargets();
  let id: string | undefined = arg || undefined;
  if (id && id !== NEW_SERVER && !targets.some((t) => t.id === id)) {
    const problem = providerNameProblem(id);
    if (problem) return store.notice(`Unknown provider "${id}". ${problem}`, 'error');
    // `/login gpu` with a new name adds a server called gpu.
  }
  if (!id) {
    const current = targets.findIndex((t) => t.current);
    id = await pick<string>(
      c,
      'Log in to a provider',
      [
        ...targets.map((t) => ({ label: t.label, value: t.id, hint: targetHint(t) })),
        { label: 'Add another server…', value: NEW_SERVER, hint: 'any OpenAI-compatible address' },
      ],
      current >= 0 ? current : 0,
    );
    if (!id) return;
  }

  let target = targets.find((t) => t.id === id);
  if (!target) {
    let name = id === NEW_SERVER ? '' : id;
    while (!name) {
      const v = await c.ask('A short name for this server', {
        title: 'Add a server',
        help: 'Its models will be written as <name>/<model>, e.g. gpu/qwen3-32b.',
      });
      if (!v) return;
      const problem =
        providerNameProblem(v) ??
        (targets.some((t) => t.id === v) ? `"${v}" is already set up; pick it from /login.` : undefined);
      if (problem) store.notice(problem, 'warn');
      else name = v;
    }
    target = { id: name, label: name, kind: 'custom', type: 'openai', key: undefined, current: false };
  }
  const t = target;

  let plan: ProviderPlan = { id: t.id, type: t.type };
  let key: string | undefined;
  let listing: Listing;

  if (t.kind === 'cloud') {
    const typed = await c.ask(`${t.label} API key`, {
      title: `Log in to ${t.label}`,
      secret: true,
      help: [
        t.preset?.keyUrl ? `Create one at ${t.preset.keyUrl}` : '',
        t.key ? `Leave it empty to keep the ${t.key === 'saved' ? 'saved key' : `key from ${t.key}`}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
    if (typed === undefined || (!typed && !t.key)) return store.notice('Login cancelled; nothing changed.');
    key = typed || undefined;
    store.setStatus(`Checking with ${t.label}…`);
    listing = await runtime.probeProvider(plan, key);
    store.setStatus(undefined);
  } else {
    const url = await askAddress(c, t.label, t.baseUrl ?? builtinUrl(t.id));
    if (!url) return store.notice('Login cancelled; nothing changed.');
    plan = { ...plan, baseUrl: url };
    store.setStatus(`Asking ${url} for its models…`);
    listing = await runtime.probeProvider(plan);
    store.setStatus(undefined);
    if (!listing.ok && listing.kind === 'rejected') {
      const typed = await c.ask(`${t.label} wants an API key (${listing.message}).`, {
        title: `Log in to ${t.label}`,
        secret: true,
        help: 'The key the server was started with, e.g. llama-server --api-key.',
      });
      if (!typed) return store.notice('Login cancelled; nothing changed.');
      key = typed;
      store.setStatus(`Asking ${url} for its models…`);
      listing = await runtime.probeProvider(plan, key);
      store.setStatus(undefined);
    }
  }

  if (!listing.ok) {
    if (listing.kind === 'rejected')
      return store.notice(`${t.label} refused that key (${listing.message}). Nothing was saved.`, 'error');
    const where = plan.baseUrl ?? t.label;
    const choice = await pick<'save' | 'cancel'>(c, `${where} did not answer (${listing.message})`, [
      { label: 'Cancel', value: 'cancel', hint: 'nothing is saved' },
      { label: 'Save anyway', value: 'save', hint: t.preset?.startHint ?? 'use it once the server is up' },
    ]);
    if (choice !== 'save') return store.notice('Login cancelled; nothing changed.');
  }

  const saved = await runtime.saveProvider(plan, key);
  const what = [plan.baseUrl ? `→ ${plan.baseUrl}` : '', key ? 'key saved' : ''].filter(Boolean).join(', ');
  store.notice(`Logged in to ${t.label}${what ? ` (${what})` : ''}.`, 'success');
  if (saved.reconnectError)
    store.notice(`The current model could not reconnect: ${saved.reconnectError}`, 'warn');
  c.refresh();

  const models = listing.ok ? listing.models : [];
  if (!models.length) return;
  const current = runtime.modelSpec;
  const specs = models.map((m) => `${t.id}/${m.id}`);
  const spec = await pick<string>(
    c,
    `Use a model from ${t.label}? (esc keeps ${current ?? 'the current one'})`,
    models.map((m, i) => ({
      label: specs[i]!,
      value: specs[i]!,
      hint: [m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k ctx` : '', m.loaded ? 'loaded' : '']
        .filter(Boolean)
        .join(' · '),
    })),
    Math.max(0, specs.indexOf(current ?? '')),
  );
  if (!spec || (spec === current && !saved.reconnectError)) return;
  try {
    const m = await runtime.setModel(spec);
    store.notice(
      `Model → ${spec} · context ${m.contextWindow.toLocaleString()} tokens (${m.contextSource})`,
      'success',
    );
  } catch (e) {
    store.notice((e as Error).message, 'error');
  }
}

/** `/logout`: forget a saved key; for a server you added, optionally forget the server too. */
async function logout(c: CmdCtx, arg: string): Promise<void> {
  const { runtime, store } = c;
  const targets = runtime.loginTargets().filter((t) => t.key === 'saved' || t.kind === 'custom');
  if (!targets.length) return store.notice('No saved keys or added servers to remove.');
  let id: string | undefined = arg || undefined;
  if (!id)
    id = await pick<string>(
      c,
      'Log out of a provider',
      targets.map((t) => ({ label: t.label, value: t.id, hint: targetHint(t) })),
    );
  if (!id) return;
  const t = targets.find((x) => x.id === id);
  if (!t) return store.notice(`"${id}" has no saved key or added server.`, 'warn');
  let forgetServer = false;
  if (t.kind === 'custom') {
    const choice = await pick<'server' | 'key'>(c, `Log out of ${t.label}`, [
      { label: 'Remove the server', value: 'server', hint: `forget ${t.baseUrl ?? 'it'} and its key` },
      ...(t.key === 'saved' ? [{ label: 'Only remove the key', value: 'key' as const }] : []),
    ]);
    if (!choice) return;
    forgetServer = choice === 'server';
  }
  const done = runtime.logout(t.id, forgetServer);
  const parts = [done.key ? 'key removed' : '', done.server ? 'server removed' : ''].filter(Boolean);
  store.notice(
    parts.length ? `Logged out of ${t.label}: ${parts.join(', ')}.` : `Nothing saved for ${t.label}.`,
    'success',
  );
  const env = runtime.loginTargets().find((x) => x.id === t.id)?.key;
  if (env && env !== 'saved') store.notice(`${t.label} still has a key from ${env}.`, 'warn');
  if (runtime.modelSpec?.split('/')[0] === t.id)
    store.notice(`The current model is from ${t.label}; pick another with /model.`, 'warn');
  c.refresh();
}

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describePlan(p: FlushPlan): string {
  if (!p.sessions.length && !p.swarms.length) return 'nothing to delete';
  const parts = [
    p.sessions.length ? plural(p.sessions.length, 'conversation') : '',
    p.swarms.length ? plural(p.swarms.length, 'swarm') : '',
  ].filter(Boolean);
  return `${parts.join(' and ')}, ${fmtBytes(p.bytes)}`;
}

const MESSAGE_LIMITS = [60, 120, 250, 500, 1000, 0];
const TOOL_LIMITS = [60, 150, 300, 0];

/**
 * Ask how long agents may work before checking in, and save the answers to the config. Esc keeps the current
 * value.
 */
async function chooseLimits(c: CmdCtx): Promise<void> {
  const { runtime, store } = c;
  const msgs = runtime.config.swarm.maxMessages;
  const tools = runtime.config.maxToolIterations;
  const withCurrent = (list: number[], cur: number) => (list.includes(cur) ? list : [cur, ...list]);
  const mList = withCurrent(MESSAGE_LIMITS, msgs);
  const maxMessages = await pick(
    c,
    'How many messages may the agents send each other before checking in with you? Anything you type resets the count.',
    mList.map((n) => ({
      label: n ? `${n} messages` : 'No limit',
      value: n,
      hint: n
        ? `about ${Math.floor(n / 2)} hand-offs${n === msgs ? ' (current)' : ''}`
        : `runs until the work is done or you press esc${msgs === 0 ? ' (current)' : ''}`,
    })),
    mList.indexOf(msgs),
  );
  const tList = withCurrent(TOOL_LIMITS, tools);
  const maxToolIterations = await pick(
    c,
    'How many tool calls may one agent make in a single turn?',
    tList.map((n) => ({
      label: n ? `${n} tool calls` : 'No limit',
      value: n,
      ...(n === tools ? { hint: 'current' } : {}),
    })),
    tList.indexOf(tools),
  );
  const next = {
    ...(maxMessages !== undefined ? { maxMessages } : {}),
    ...(maxToolIterations !== undefined ? { maxToolIterations } : {}),
  };
  if (!Object.keys(next).length) return;
  try {
    runtime.setLimits(next);
    const m = runtime.config.swarm.maxMessages;
    const tc = runtime.config.maxToolIterations;
    store.notice(
      `Limits saved to your config: ${m ? `${m} messages` : 'no message limit'} between yours, ${tc ? `${tc} tool calls` : 'no tool-call limit'} per turn.`,
      'success',
    );
  } catch (e) {
    store.notice(`Could not save the limits: ${(e as Error).message}`, 'error');
  }
}

/** `/swarm custom`: choose how many agents and what each one does, then start (and optionally save) the team. */
async function customTeam(words: string[], c: CmdCtx): Promise<void> {
  const { runtime, store } = c;
  let slots: TeamSlot[];
  const own = async (n: number): Promise<TeamSlot | undefined> => {
    const name = await c.ask(`Agent ${n}: a one-word name (for example "tester")`);
    if (!name?.trim()) return undefined;
    const role = await c.ask(`What should ${name.trim()} do? One or two sentences.`);
    if (!role?.trim()) return undefined;
    return { name: name.trim(), role: role.trim() };
  };
  if (words.length) {
    const parsed = parseTeam(words);
    if ('error' in parsed) return store.notice(parsed.error, 'error');
    if (parsed.slots.length < 2) return store.notice('A team needs at least two agents.', 'warn');
    slots = parsed.slots;
  } else {
    const max = Math.max(2, runtime.config.swarm.maxAgents);
    const count = await pick(
      c,
      'How many agents?',
      Array.from({ length: max - 1 }, (_, i) => ({
        label: `${i + 2} agents`,
        value: i + 2,
        hint: i === 0 ? 'a lead and one teammate' : `a lead and ${i + 1} teammates`,
      })),
      1,
    );
    if (!count) return store.notice('Team not started.');
    const OWN = '__own__';
    const choose = async (title: string, lead: boolean, n: number): Promise<TeamSlot | undefined> => {
      const key = await pick<string>(c, title, [
        ...ROLES.filter((r) => r.lead === lead).map((r) => ({
          label: r.label,
          value: r.key,
          hint: r.summary,
        })),
        { label: 'Write my own role', value: OWN, hint: 'name it and describe what it does' },
      ]);
      if (!key) return undefined;
      return key === OWN ? own(n) : { template: roleByKey(key)! };
    };
    slots = [];
    const lead = await choose('Who leads? The lead talks to you and hands out the work.', true, 1);
    if (!lead) return store.notice('Team not started.');
    slots.push(lead);
    for (let i = 2; i <= count; i++) {
      const s = await choose(`Agent ${i} of ${count}: what does it do?`, false, i);
      if (!s) return store.notice('Team not started.');
      slots.push(s);
    }
  }
  const team = assembleTeam(slots);
  await chooseLimits(c);
  store.notice(
    ['Your team:', ...team.map((a, i) => `  ${a.name}${i === 0 ? ' (lead)' : ''}: ${a.role}`)].join('\n'),
  );
  const go = await pick(c, 'Start this team?', [
    { label: 'Start', value: 'start' },
    { label: 'Start and save it as my team', value: 'save', hint: '/swarm config starts it again' },
    { label: 'Cancel', value: 'cancel' },
  ]);
  if (!go || go === 'cancel') return store.notice('Team not started.');
  try {
    if (go === 'save') runtime.saveSwarmTeam(team);
    const sw = await runtime.startSwarm(team);
    store.attachSwarm(sw);
    store.notice(
      `Swarm is up: ${sw.names.join(', ')}.${go === 'save' ? ' Saved as your team; /swarm config starts it again.' : ''} Type to talk to ${sw.names[0]} (the lead), or @name to address anyone.`,
      'success',
    );
  } catch (e) {
    store.notice((e as Error).message, 'error');
  }
}

export interface BuiltinCommand {
  name: string;
  description: string;
  usage?: string;
  run(args: string, c: CmdCtx): void | Promise<void>;
}

const MODES = Object.keys(MODE_STYLE) as ApprovalMode[];
const SANDBOXES: SandboxMode[] = ['off', 'guard', 'container'];

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export const BUILTINS: BuiltinCommand[] = [
  {
    name: 'help',
    description: 'Show commands and shortcuts',
    run(_a, { runtime, store }) {
      const lines = [
        'Commands',
        ...BUILTINS.map((c) => `  /${(c.usage ?? c.name).padEnd(26)} ${c.description}`),
        ...runtime.commands.map((c) => `  /${c.name.padEnd(26)} ${c.description}`),
        '',
        'Keys   enter send, \\+enter or ctrl+j newline, shift+tab cycle mode, esc interrupt, ↑/↓ history',
        'Swarm  plain text goes to the lead; @name text addresses one agent; /swarm panes toggles split view',
      ];
      store.notice(lines.join('\n'));
    },
  },
  {
    name: 'model',
    usage: 'model [provider/model]',
    description: 'Pick the model',
    async run(args, { runtime, store, overlay }) {
      const choose = async (spec: string) => {
        try {
          const m = await runtime.setModel(spec);
          const ctx = m.contextWindow.toLocaleString();
          store.notice(
            `Model → ${spec} · context ${ctx} tokens (${m.contextSource}) · compaction at ${Math.round(runtime.agent.limits().target).toLocaleString()}`,
            'success',
          );
        } catch (e) {
          store.notice((e as Error).message, 'error');
        }
      };
      if (args) return choose(args.trim());
      store.setStatus('Asking providers which models they have…');
      const models = await runtime.listModels();
      store.setStatus(undefined);
      if (!models.length) {
        return store.notice(
          'No provider answered. Start a local server, run `nexus auth set <provider>`, or pass --model <provider>/<model>.',
          'warn',
        );
      }
      overlay({
        title: 'Select a model',
        items: models.map((m) => ({
          label: m.spec,
          value: m.spec,
          hint: [
            m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k ctx` : '',
            m.loaded ? 'loaded' : '',
          ]
            .filter(Boolean)
            .join(' · '),
        })),
        onSelect: (v: string) => void choose(v),
      });
    },
  },
  {
    name: 'login',
    usage: 'login [provider]',
    description: 'Connect a provider: an API key, or a server address to swap',
    run: (args, c) => login(c, args.trim()),
  },
  {
    name: 'logout',
    usage: 'logout [provider]',
    description: "Remove a provider's saved key (and a server you added)",
    run: (args, c) => logout(c, args.trim()),
  },
  {
    name: 'mode',
    usage: 'mode [ask|edits|auto|plan]',
    description: 'Set the approval mode',
    run(args, { runtime, store, overlay, refresh }) {
      const set = (m: ApprovalMode) => {
        runtime.setApprovalMode(m);
        if (m === 'auto' && runtime.sandbox.mode === 'off')
          store.notice('Auto-approve with the sandbox OFF: commands run with your full privileges.', 'warn');
        store.notice(`Mode → ${m} (${MODE_STYLE[m].hint})`, 'success');
        refresh();
      };
      const a = args.trim() as ApprovalMode;
      if (a)
        return MODES.includes(a)
          ? set(a)
          : store.notice(`Unknown mode "${a}". Use ${MODES.join(', ')}.`, 'error');
      overlay({
        title: 'Approval mode',
        items: MODES.map((m) => ({ label: m, value: m, hint: MODE_STYLE[m].hint })),
        initial: MODES.indexOf(runtime.policy.mode),
        onSelect: set,
      });
    },
  },
  {
    name: 'sandbox',
    usage: 'sandbox [off|guard|container]',
    description: 'Set the sandbox level',
    run(args, { runtime, store, overlay }) {
      const set = (m: SandboxMode) => {
        try {
          runtime.setSandboxMode(m);
          store.notice(`Sandbox → ${runtime.sandbox.describe()}`, m === 'off' ? 'warn' : 'success');
        } catch (e) {
          store.notice((e as Error).message, 'error');
        }
      };
      const a = args.trim() as SandboxMode;
      if (a)
        return SANDBOXES.includes(a)
          ? set(a)
          : store.notice(`Unknown sandbox "${a}". Use ${SANDBOXES.join(', ')}.`, 'error');
      overlay({
        title: 'Sandbox',
        items: [
          { label: 'off', value: 'off', hint: 'no isolation' },
          {
            label: 'guard',
            value: 'guard',
            hint: 'file tools confined to the workspace; secrets scrubbed from commands',
          },
          { label: 'container', value: 'container', hint: 'commands run in a Docker/Podman container' },
        ],
        initial: SANDBOXES.indexOf(runtime.sandbox.mode),
        onSelect: set,
      });
    },
  },
  {
    name: 'update',
    description: 'Update NexusHarness to the latest version',
    async run(_a, c) {
      const { runtime, store } = c;
      if (runtime.agent.isRunning || runtime.swarm?.names.some((n) => runtime.swarm?.agent(n)?.isRunning))
        return store.notice('Wait for the agents to finish (or press esc) before updating.', 'warn');
      store.notice('Checking for updates…');
      const r = await checkForUpdate();
      if (!r.ok) return store.notice(r.error, 'warn');
      const { check } = r;
      if (check.upToDate)
        return store.notice(
          `NexusHarness ${check.current.version} is up to date (${check.ref} @ ${short(check.current.commit)}).`,
          'success',
        );
      const newer =
        check.latest.version !== check.current.version
          ? `NexusHarness ${check.latest.version} is available (you have ${check.current.version}).`
          : `A newer build of NexusHarness ${check.current.version} is available (${short(check.current.commit)} → ${short(check.latest.commit)}).`;
      const go = await pick(c, `${newer} Latest change: ${check.latest.subject}`, [
        {
          label: 'Update now',
          value: true,
          hint: 'about a minute; your conversations and settings are kept',
        },
        { label: 'Not now', value: false },
      ]);
      if (!go) return store.notice(`Not updated. Run /update or ${BIN} update any time.`);
      store.notice('Updating: downloading, installing dependencies and building…');
      const out: string[] = [];
      const code = await runUpdate(check, { onLine: (l) => out.push(l) });
      if (code !== 0)
        return store.notice(
          [
            'The update failed. Nothing you were working on is lost; the last lines were:',
            ...out.slice(-8),
          ].join('\n') + `\n\nTry again later, or run \`${BIN} doctor --fix\`.`,
          'error',
        );
      const again = await pick(
        c,
        `Updated to ${check.latest.version} (${short(check.latest.commit)}). Restart to use it?`,
        [
          {
            label: 'Restart now',
            value: true,
            hint: runtime.swarm
              ? 'continues this conversation; /swarm resume brings the team back'
              : 'continues this conversation',
          },
          { label: 'Later', value: false, hint: 'the new version starts next time you run nexus' },
        ],
      );
      if (!again) return store.notice('Updated. The new version starts next time you run nexus.', 'success');
      requestRelaunch(check);
      c.exit();
    },
  },
  {
    name: 'effort',
    usage: 'effort [low|medium|high|xhigh|default]',
    description: 'How hard reasoning models think',
    async run(args, c) {
      const { runtime, store } = c;
      const a = args.trim().toLowerCase();
      const describe = (e: ReasoningEffort | undefined) =>
        e
          ? `Reasoning effort: ${e}. Saved; applies to every agent from the next request.`
          : "Reasoning effort: the model's default (nothing is sent).";
      let choice: ReasoningEffort | 'default' | undefined;
      if (a) {
        if (a !== 'default' && !(REASONING_EFFORTS as readonly string[]).includes(a))
          return store.notice('Usage: /effort low|medium|high|xhigh, or /effort default', 'warn');
        choice = a as ReasoningEffort | 'default';
      } else {
        const current = runtime.config.reasoningEffort ?? 'default';
        const options: { label: string; value: ReasoningEffort | 'default'; hint: string }[] = [
          { label: 'low', value: 'low', hint: 'quick answers, little thinking' },
          { label: 'medium', value: 'medium', hint: 'a balance of speed and depth' },
          { label: 'high', value: 'high', hint: 'thinks it through' },
          { label: 'xhigh', value: 'xhigh', hint: 'thinks longest; models without it get high' },
          { label: 'default', value: 'default', hint: "leave it to each model's own default" },
        ];
        choice = await pick(
          c,
          'Reasoning effort (models without reasoning levels ignore it)',
          options.map((o) => ({ ...o, hint: o.value === current ? `${o.hint} (current)` : o.hint })),
          options.findIndex((o) => o.value === current),
        );
        if (!choice) return;
      }
      runtime.setReasoningEffort(choice === 'default' ? undefined : choice);
      store.notice(describe(runtime.config.reasoningEffort), 'success');
    },
  },
  {
    name: 'context',
    usage: 'context [size|auto]',
    description: 'Show or set the context window size (e.g. /context 128k)',
    async run(args, { runtime, store }) {
      const a = args.trim().toLowerCase();
      if (a) {
        const tokens = a === 'auto' ? undefined : parseTokenCount(a);
        if (a !== 'auto' && tokens === undefined)
          return store.notice(
            'Usage: /context <size>, e.g. /context 131072 or /context 128k; /context auto',
            'warn',
          );
        if (tokens !== undefined && (tokens < 1024 || tokens > 10_000_000))
          return store.notice('The context window must be between 1,024 and 10,000,000 tokens.', 'warn');
        try {
          await runtime.setContextWindow(tokens);
        } catch (e) {
          return store.notice((e as Error).message, 'warn');
        }
      }
      const m = runtime.agent.model;
      if (!runtime.modelSpec) return store.notice('No model selected. Choose one with /model first.', 'warn');
      const from =
        m.contextSource === 'config'
          ? 'set by you'
          : m.contextSource === 'detected'
            ? 'reported by the server'
            : 'assumed: the server did not report one';
      const used = runtime.agent.contextTokens;
      const n = (x: number) => x.toLocaleString('en-US');
      const lines = [
        `${a ? 'Context window now' : 'Context window'}: ${n(m.contextWindow)} tokens (${from}) for ${runtime.modelSpec}.`,
        `In use: ${n(used)} (${Math.round((used / m.contextWindow) * 100)}%). Compaction starts at ${n(runtime.agent.limits().target)}.`,
      ];
      if (m.contextSource === 'config' && m.serverWindow && m.serverWindow !== m.contextWindow)
        lines.push(
          m.contextWindow > m.serverWindow
            ? `The server reported ${n(m.serverWindow)}: requests larger than that will fail until it runs with a bigger context.`
            : `The server reported ${n(m.serverWindow)}.`,
        );
      lines.push(
        m.contextSource === 'config'
          ? 'Saved for this model. /context auto goes back to what the server reports.'
          : 'Change it with /context <size>, e.g. /context 128k. It is saved for this model.',
      );
      store.notice(lines.join('\n'), m.contextSource === 'default' ? 'warn' : a ? 'success' : 'info');
    },
  },
  {
    name: 'skills',
    usage: 'skills [name]',
    description: 'List the skills the agent can load, or show one',
    run(args, c) {
      const all = c.runtime.skills.list();
      const name = args.trim();
      if (name) {
        const s = all.find((x) => x.name === name);
        if (!s) return c.store.notice(`No skill named "${name}". /skills lists them.`, 'warn');
        return c.store.notice(`${s.name} (${s.source}): ${s.description}\n${s.path}`);
      }
      if (!all.length) return c.store.notice('No skills installed.');
      c.store.notice(
        [
          'Skills (the agent loads one when a task matches it; ask for one by name to use it directly):',
          ...all.map(
            (s) =>
              `  ${s.name}${s.source === 'built-in' ? '' : ` [${s.source}]`}: ${s.description.split('. ')[0]}.`,
          ),
          `Add your own as ${join(c.runtime.loaded.paths.config, 'skills', '<name>', 'SKILL.md')}.`,
        ].join('\n'),
      );
    },
  },
  {
    name: 'thinking',
    usage: 'thinking [on|off]',
    description: "Show or hide agents' reasoning (also ctrl+t)",
    run(args, c) {
      const a = args.trim().toLowerCase();
      if (a && a !== 'on' && a !== 'off') return c.store.notice('Usage: /thinking [on|off]', 'warn');
      c.setThinking(a === 'on' ? true : a === 'off' ? false : undefined);
    },
  },
  {
    name: 'flush',
    usage: 'flush [all|<days>] [everywhere]',
    description: 'Delete old saved conversations and swarms',
    async run(args, c) {
      const { runtime, store } = c;
      type Scope = { olderThanDays?: number; allFolders?: boolean };
      let scope: Scope | undefined;
      const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length) {
        scope = {};
        for (const w of words) {
          const days = /^(\d+)d?$/.exec(w);
          if (days) scope.olderThanDays = Number(days[1]);
          else if (w === 'everywhere') scope.allFolders = true;
          else if (w !== 'all')
            return store.notice(
              'Usage: /flush [all|<days>] [everywhere], for example /flush 30 or /flush all',
              'warn',
            );
        }
      } else {
        const options: { label: string; value: Scope }[] = [
          { label: 'Older than 30 days, this folder', value: { olderThanDays: 30 } },
          { label: 'Older than 7 days, this folder', value: { olderThanDays: 7 } },
          { label: 'Everything saved for this folder', value: {} },
          { label: 'Older than 30 days, every folder', value: { olderThanDays: 30, allFolders: true } },
          { label: 'Everything saved, every folder', value: { allFolders: true } },
        ];
        scope = await pick(
          c,
          'Delete which saved conversations and swarms? The current conversation is always kept.',
          options.map((o) => ({ ...o, hint: describePlan(runtime.flushPlan(o.value)) })),
        );
      }
      if (!scope) return;
      const plan = runtime.flushPlan(scope);
      if (!plan.sessions.length && !plan.swarms.length) return store.notice('Nothing to delete.');
      const ok = await pick(
        c,
        `Delete ${describePlan(plan)}? This cannot be undone.`,
        [
          { label: 'Delete', value: true },
          { label: 'Keep everything', value: false },
        ],
        1,
      );
      if (!ok) return store.notice('Nothing was deleted.');
      runtime.flush(plan);
      store.notice(
        `Deleted ${describePlan({ ...plan })}. The current conversation${runtime.swarm ? ' and the running swarm were' : ' was'} kept.`,
        'success',
      );
    },
  },
  {
    name: 'clear',
    description: 'Start a fresh conversation',
    run(_a, { runtime, store }) {
      if (runtime.agent.isRunning)
        return store.notice('Wait for the current turn to finish (or press esc) first.', 'warn');
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      runtime.newSession();
      store.clear();
      store.notice('Started a new conversation.');
    },
  },
  {
    name: 'compact',
    usage: 'compact [focus]',
    description: 'Summarise older messages to free context',
    async run(args, { runtime, store }) {
      try {
        const ok = await runtime.agent.compactNow(undefined, args || undefined);
        if (!ok) store.notice('Nothing to compact yet.');
      } catch (e) {
        store.notice(`Compaction failed: ${(e as Error).message}`, 'error');
      }
    },
  },
  {
    name: 'resume',
    description: 'Resume an earlier session in this folder',
    run(_a, { runtime, store, overlay }) {
      const list = Session.list(sessionDir(runtime.loaded.paths.data, projectKey(runtime.cwd))).slice(0, 30);
      overlay({
        title: 'Resume a session',
        items: list.map((s) => ({ label: s.preview, value: s.file, hint: timeAgo(s.updated) })),
        onSelect: (file: string) => {
          const s = Session.load(file);
          runtime.agent.setSession(s);
          replayInto(store, s.messages());
          store.notice(`Resumed session ${s.id}.`, 'success');
        },
      });
    },
  },
  {
    name: 'tree',
    description: 'Rewind to an earlier message and branch from there',
    run(_a, { runtime, store, overlay }) {
      const s = runtime.agent.session;
      const turns = s.userTurns();
      overlay({
        title: 'Branch from before… (your earlier messages)',
        items: turns.map((t, i) => ({
          label: `${i + 1}. ${t.text.replace(/\s+/g, ' ').slice(0, 90)}`,
          value: t.id,
        })),
        onSelect: (id: string) => {
          const e = s.path().find((x) => x.id === id);
          s.branchTo(e?.parentId ?? null);
          replayInto(store, s.messages());
          store.notice(
            'Rewound. Your next message starts a new branch; the original is kept in the session file.',
            'success',
          );
        },
      });
    },
  },
  {
    name: 'swarm',
    usage: 'swarm [duo|trio|quad|custom|config|resume|stop|panes|status|limit]',
    description: 'Start collaborating agents in a shared channel',
    async run(args, c) {
      const { runtime, store } = c;
      const a = args.trim() || 'status';
      if (a === 'panes') return c.togglePanes();
      if (a === 'limit' || a.startsWith('limit ')) {
        const v = a.split(/\s+/)[1];
        if (!v) return chooseLimits(c);
        const n = v === 'off' || v === 'none' ? 0 : Number(v);
        if (!Number.isInteger(n) || n < 0)
          return store.notice('Usage: /swarm limit [<messages>|off], for example /swarm limit 250', 'warn');
        runtime.setLimits({ maxMessages: n });
        return store.notice(
          `Message limit saved: ${n ? `${n} messages between yours` : 'no limit'}.${runtime.swarm ? ' A paused team carries on as soon as you speak.' : ''}`,
          'success',
        );
      }
      if (a === 'custom' || a.startsWith('custom ')) {
        if (runtime.swarm) return store.notice('A swarm is already running. Use /swarm stop first.', 'warn');
        return customTeam(a.split(/\s+/).slice(1), c);
      }
      if (a === 'resume') {
        const saved = runtime.listSwarms();
        if (!saved.length) return store.notice('No saved swarms for this folder yet.');
        return c.overlay({
          title: 'Resume a swarm',
          items: saved.map((x) => ({
            label: `${x.name} — ${x.agents.join(', ')}`,
            value: x.id,
            hint: `${x.messages} messages · ${timeAgo(x.updatedAt)}`,
          })),
          onSelect: async (id: string) => {
            try {
              const sw = await runtime.resumeSwarm(id);
              store.attachSwarm(sw);
              store.notice(`Resumed swarm ${sw.names.join(', ')}.`, 'success');
            } catch (e) {
              store.notice((e as Error).message, 'error');
            }
          },
        });
      }
      if (a === 'stop') {
        runtime.stopSwarm();
        store.detachSwarm();
        return store.notice('Swarm stopped. Back to a single agent.');
      }
      if (a === 'status') {
        if (!runtime.swarm)
          return store.notice(
            [
              'No swarm running. Start one with:',
              ...Object.keys(SWARM_PRESETS).map((k) => `  /swarm ${k.padEnd(8)} ${PRESET_SUMMARY[k] ?? ''}`),
              '  /swarm custom   choose how many agents and what each one does',
              ...(runtime.config.swarm.agents.length
                ? ['  /swarm config   the team saved in your config']
                : []),
            ].join('\n'),
          );
        return store.notice(
          runtime.swarm
            .roster()
            .map((t) => `${t.running ? '●' : '○'} ${t.name} — ${t.role}`)
            .join('\n'),
        );
      }
      try {
        const sw = await runtime.startSwarm(a);
        store.attachSwarm(sw);
        store.notice(
          `Swarm "${a}" is up: ${sw.names.join(', ')}. Type to talk to ${sw.names[0]} (the lead), or @name to address anyone.`,
          'success',
        );
      } catch (e) {
        store.notice((e as Error).message, 'error');
      }
    },
  },
  {
    name: 'browser',
    usage: 'browser [status|takeover|release|close]',
    description: 'Control the live browser',
    async run(args, { runtime, store }) {
      const b = runtime.browser;
      if (!b) return store.notice('Browser control is disabled (browser.enabled = false).', 'warn');
      const a = args.trim() || 'status';
      if (a === 'takeover') {
        b.setControl('user');
        return store.notice(
          'You have control of the browser. The agent is paused on browser actions. /browser release hands it back.',
        );
      }
      if (a === 'release') {
        b.setControl('agent');
        return store.notice('The agent has control of the browser again.');
      }
      if (a === 'close') {
        await b.close();
        return store.notice('Browser closed.');
      }
      store.notice(
        b.isOpen
          ? `Browser open at ${b.currentUrl ?? 'about:blank'} · controlled by ${b.controlledBy}`
          : 'Browser not open yet; it launches on first use.',
      );
    },
  },
  {
    name: 'tools',
    description: 'List tools the agent can use',
    run(_a, { runtime, store }) {
      store.notice(
        runtime.tools
          .all()
          .map((t) => `${t.name.padEnd(24)} ${t.risk}`)
          .join('\n'),
      );
    },
  },
  {
    name: 'mcp',
    description: 'Show connected MCP servers',
    run(_a, { runtime, store }) {
      store.notice(
        runtime.mcp.length
          ? runtime.mcp.map((m) => `${m.name} — ${m.tools.length} tools`).join('\n')
          : 'No MCP servers connected. Configure "mcpServers" in your config.',
      );
    },
  },
  {
    name: 'trust',
    description: "Trust this project's config, skills and extensions",
    run(_a, { runtime, store }) {
      if (!runtime.loaded.projectConfigPath)
        return store.notice('No project config (.nexusharness/config.json) here.');
      trustProject(runtime.loaded.paths, resolve(runtime.loaded.projectConfigPath, '..', '..'));
      store.notice(`Trusted. Restart ${BIN} to load the project's full configuration.`, 'success');
    },
  },
  {
    name: 'export',
    usage: 'export [file.md]',
    description: 'Save the conversation as Markdown',
    run(args, { runtime, store }) {
      const file = resolve(runtime.cwd, args.trim() || `nexusharness-${runtime.agent.session.id}.md`);
      try {
        runtime.sandbox.checkPath(file, 'write');
      } catch (e) {
        return store.notice((e as Error).message, 'error');
      }
      const out: string[] = [`# NexusHarness session ${runtime.agent.session.id}\n`];
      for (const m of runtime.agent.session.messages()) {
        for (const b of m.content) {
          if (b.type === 'text') out.push(`**${m.role === 'user' ? 'You' : 'Assistant'}**\n\n${b.text}\n`);
          else if (b.type === 'tool_use')
            out.push(`> tool: \`${b.name}\` ${JSON.stringify(b.input).slice(0, 200)}\n`);
        }
      }
      writeFileSync(file, out.join('\n'));
      store.notice(`Saved ${file}`, 'success');
    },
  },
  { name: 'quit', description: 'Exit', run: (_a, c) => c.exit() },
  { name: 'exit', description: 'Exit', run: (_a, c) => c.exit() },
];
