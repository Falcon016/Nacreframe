import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session, sessionDir } from '../agent/session.js';
import type { ApprovalMode, SandboxMode } from '../config/schema.js';
import { trustProject } from '../config/load.js';
import { projectKey } from '../paths.js';
import type { Runtime } from '../runtime.js';
import { SWARM_PRESETS } from '../runtime.js';
import { BIN } from '../version.js';
import type { Choice } from './dialogs.js';
import { replayInto, type UiStore } from './store.js';
import { MODE_STYLE } from './theme.js';

export type Overlay = { title: string; items: Choice<unknown>[]; initial?: number; onSelect(v: never): void };

export interface CmdCtx {
  runtime: Runtime;
  store: UiStore;
  /** Send text to the agent as a normal user prompt. */
  prompt(text: string): void;
  overlay(o: Overlay): void;
  exit(): void;
  togglePanes(): void;
  refresh(): void;
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
        'Keys   enter send · \\+enter or ctrl+j newline · shift+tab cycle mode · esc interrupt · ↑/↓ history',
        'Swarm  @name text → address one agent · plain text → the lead · /swarm panes toggles split view',
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
          'No provider answered. Start a local server, run `nacre auth set <provider>`, or pass --model <provider>/<model>.',
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
    usage: 'swarm [duo|trio|config|resume|stop|panes|status]',
    description: 'Start collaborating agents in a shared channel',
    async run(args, c) {
      const { runtime, store } = c;
      const a = args.trim() || 'status';
      if (a === 'panes') return c.togglePanes();
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
            `No swarm running. Start one with /swarm ${Object.keys(SWARM_PRESETS).join(' | /swarm ')}`,
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
    name: 'skills',
    description: 'List available skills',
    run(_a, { runtime, store }) {
      const s = runtime.skills.list();
      store.notice(
        s.length
          ? s.map((x) => `${x.name} — ${x.description}`).join('\n')
          : `No skills found. Add SKILL.md files under ${resolve(runtime.loaded.paths.config, 'skills')}/<name>/`,
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
        return store.notice('No project config (.nacreframe/config.json) here.');
      trustProject(runtime.loaded.paths, resolve(runtime.loaded.projectConfigPath, '..', '..'));
      store.notice(`Trusted. Restart ${BIN} to load the project's full configuration.`, 'success');
    },
  },
  {
    name: 'export',
    usage: 'export [file.md]',
    description: 'Save the conversation as Markdown',
    run(args, { runtime, store }) {
      const file = resolve(runtime.cwd, args.trim() || `nacreframe-${runtime.agent.session.id}.md`);
      try {
        runtime.sandbox.checkPath(file, 'write');
      } catch (e) {
        return store.notice((e as Error).message, 'error');
      }
      const out: string[] = [`# Nacreframe session ${runtime.agent.session.id}\n`];
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
