import { existsSync } from 'node:fs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Approver, type AgentEvent } from '../src/agent/agent.js';
import { Session } from '../src/agent/session.js';
import { configSchema, type Config } from '../src/config/schema.js';
import type { ResolvedModel } from '../src/llm/registry.js';
import type { Provider, StreamEvent, StreamRequest } from '../src/llm/types.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { bashTool } from '../src/tools/bash.js';
import { editTool, readTool, writeTool } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { globTool, grepTool, lsTool } from '../src/tools/search-tools.js';

export function tmpWorkspace(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nacre-test-')));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }),
  };
}

export function testConfig(over: Record<string, unknown> = {}): Config {
  return configSchema.parse(over);
}

/** A provider that replays scripted turns and records the requests it received. */
export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  requests: StreamRequest[] = [];
  constructor(
    private turns: (StreamEvent[] | ((req: StreamRequest) => StreamEvent[] | Promise<StreamEvent[]>))[],
  ) {}
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const t = this.turns.shift();
    if (!t) throw new Error('ScriptedProvider ran out of turns');
    const events = typeof t === 'function' ? await t(req) : t;
    for (const e of events) {
      if (req.signal?.aborted) throw new Error('aborted');
      yield e;
    }
  }
}

type Turn = StreamEvent[] | ((req: StreamRequest) => StreamEvent[] | Promise<StreamEvent[]>);

/**
 * A provider that tells compaction's summary requests apart from real conversation calls, so tests can
 * script the conversation (`main`) separately from the summariser (`summary`, answered on every call).
 */
export class AutoProvider implements Provider {
  readonly id = 'auto';
  requests: StreamRequest[] = [];
  constructor(
    public main: Turn[] = [],
    public summary: Turn = [
      {
        type: 'text',
        delta:
          'Summary: the user and the assistant discussed many numbered topics; no work is pending right now.',
      },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ) {}
  static isSummary(r: StreamRequest) {
    return r.tools.length === 0 && r.system.includes('compress');
  }
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const t = AutoProvider.isSummary(req) ? this.summary : this.main.shift();
    if (!t) throw new Error('AutoProvider ran out of main turns');
    const events = typeof t === 'function' ? await t(req) : t;
    for (const e of events) {
      if (req.signal?.aborted) throw new Error('aborted');
      yield e;
    }
  }
  get summaries() {
    return this.requests.filter(AutoProvider.isSummary);
  }
  get calls() {
    return this.requests.filter((r) => !AutoProvider.isSummary(r));
  }
}

export const say = (text: string): StreamEvent[] => [
  { type: 'text', delta: text },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'done', stopReason: 'end_turn' },
];

export const callTool = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_delta', id, json: JSON.stringify(input) },
  { type: 'done', stopReason: 'tool_use' },
];

export function standardTools(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, lsTool, bashTool]) r.register(t);
  return r;
}

export function resolved(provider: Provider, contextWindow = 200_000): ResolvedModel {
  return { provider, providerId: 'scripted', model: 'test-model', contextWindow, contextSource: 'config' };
}

export function makeAgent(
  dir: string,
  provider: Provider,
  opts: {
    mode?: Config['approval']['mode'];
    approver?: Approver;
    id?: string;
    tools?: ToolRegistry;
    window?: number;
    session?: Session;
    config?: Record<string, unknown>;
  } = {},
) {
  const config = testConfig(opts.config ?? {});
  const policy = new PolicyEngine({ mode: opts.mode ?? 'auto', rules: [] });
  const session = opts.session ?? Session.create(dir);
  const agent = new Agent({
    id: opts.id ?? 'main',
    cwd: dir,
    config,
    model: resolved(provider, opts.window),
    tools: opts.tools ?? standardTools(),
    policy,
    sandbox: new GuardSandbox({ cwd: dir, denyPaths: config.sandbox.denyPaths }),
    session,
    approver: opts.approver ?? (async () => ({ allow: true })),
    system: () => 'test system prompt',
    retryDelaysMs: [0, 0],
  });
  const events: AgentEvent[] = [];
  agent.events.on('event', (e) => events.push(e));
  return { agent, events, policy, session };
}

/** Installed Chrome or Edge that Playwright can drive, if any (tests that need one skip otherwise). */
export function findBrowser(): 'chrome' | 'msedge' | undefined {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const chrome = [
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Google/Chrome/Application/chrome.exe'),
    join(local, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  if (chrome.some((p) => existsSync(p))) return 'chrome';
  const edge = [
    join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/microsoft-edge',
  ];
  if (edge.some((p) => existsSync(p))) return 'msedge';
  return undefined;
}
