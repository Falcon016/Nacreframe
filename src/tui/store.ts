import type { AgentEvent } from '../agent/agent.js';
import type { Agent } from '../agent/agent.js';
import type { BrowserEvent } from '../browser/service.js';
import type { Message } from '../llm/types.js';
import type { Swarm } from '../swarm/swarm.js';
import type { ToolResult } from '../tools/types.js';
import { oneLine } from '../util/text.js';

export type Level = 'info' | 'warn' | 'error' | 'success';

export type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; agent: string }
  | {
      id: number;
      kind: 'tool';
      agent: string;
      name: string;
      description: string;
      status: 'ok' | 'error' | 'denied';
      summary: string;
      detail?: string;
      reason?: string;
    }
  | { id: number; kind: 'notice'; level: Level; text: string }
  | { id: number; kind: 'channel'; from: string; to?: string; text: string; auto?: boolean }
  | { id: number; kind: 'banner' };

export interface LiveTool {
  id: string;
  name: string;
  description: string;
  startedAt: number;
  output: string;
}

export interface LiveAgent {
  name: string;
  text: string;
  thinking: number;
  tools: LiveTool[];
  running: boolean;
  startedAt: number;
  lastTool?: string;
  color?: string;
  role?: string;
}

export interface UiSnapshot {
  items: Item[];
  live: LiveAgent[];
  swarmActive: boolean;
  browser: { open: boolean; url?: string; holder: 'agent' | 'user'; lastAction?: string };
  contextTokens: number;
  tokens: { input: number; output: number };
  status?: string;
  /** Messages typed while the agent was busy or compacting, not yet delivered. */
  queued: number;
  /** Set while context is being compacted: the chat is paused until it finishes. */
  compacting?: { pct: number };
}

/** A first line of tool output worth showing under the tool call. */
export function summarize(name: string, r: ToolResult): { summary: string; detail?: string } {
  const text = r.content.trim();
  const lines = text ? text.split('\n') : [];
  if (r.isError) return { summary: oneLine(lines[0] ?? 'failed', 140) };
  switch (name) {
    case 'read':
      return { summary: r.images?.length ? 'image' : `${lines.length} lines` };
    case 'write':
    case 'edit':
      return { summary: lines[0] ?? 'done', ...(r.display ? { detail: r.display } : {}) };
    case 'bash':
      return {
        summary: lines.length ? `${lines.length} lines` : 'no output',
        ...(lines.length
          ? {
              detail:
                lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… +${lines.length - 8} lines` : ''),
            }
          : {}),
      };
    case 'glob':
    case 'ls':
      return { summary: lines[0] === 'No files matched.' ? 'no matches' : `${lines.length} entries` };
    case 'grep':
      return {
        summary: text === 'No matches.' ? 'no matches' : `${lines.filter((l) => l !== '--').length} matches`,
      };
    default:
      return { summary: oneLine(lines[0] ?? 'done', 100) };
  }
}

type Listener = () => void;

/**
 * UI state lives outside React so agent events (which can be very chatty while streaming) are
 * folded into a snapshot and published at most ~30 times a second.
 */
export class UiStore {
  private items: Item[] = [];
  private live = new Map<string, LiveAgent>();
  private nextId = 1;
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private snapshot: UiSnapshot;
  private unsubs: (() => void)[] = [];
  private browser: UiSnapshot['browser'] = { open: false, holder: 'agent' };
  private contextTokens = 0;
  private tokens = { input: 0, output: 0 };
  private swarmActive = false;
  private status: string | undefined;
  private queued = 0;
  private compacting: { pct: number } | undefined;

  constructor() {
    this.snapshot = this.build();
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): UiSnapshot => this.snapshot;

  private build(): UiSnapshot {
    return {
      items: this.items,
      live: [...this.live.values()],
      swarmActive: this.swarmActive,
      browser: this.browser,
      contextTokens: this.contextTokens,
      tokens: this.tokens,
      queued: this.queued,
      ...(this.compacting ? { compacting: this.compacting } : {}),
      ...(this.status ? { status: this.status } : {}),
    };
  }

  private publish(immediate = false): void {
    this.dirty = true;
    if (immediate) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), 33);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  // ---- commit helpers -----------------------------------------------------------------------------

  push(item: DistributiveOmit<Item, 'id'>): void {
    this.items = [...this.items, { ...item, id: this.nextId++ } as Item];
    this.publish(true);
  }
  notice(text: string, level: Level = 'info'): void {
    this.push({ kind: 'notice', level, text });
  }
  user(text: string): void {
    this.push({ kind: 'user', text });
  }
  setStatus(text: string | undefined): void {
    this.status = text;
    this.publish();
  }
  clear(): void {
    this.items = [];
    this.live.clear();
    this.publish(true);
  }

  private agentLive(name: string, meta: Partial<LiveAgent> = {}): LiveAgent {
    let a = this.live.get(name);
    if (!a) {
      a = { name, text: '', thinking: 0, tools: [], running: false, startedAt: Date.now() };
      this.live.set(name, a);
    }
    Object.assign(a, meta);
    return a;
  }

  // ---- event wiring -------------------------------------------------------------------------------

  attachAgent(agent: Agent, name = 'main'): void {
    this.agentLive(name);
    this.unsubs.push(agent.events.on('event', (e) => this.onAgentEvent(name, e)));
  }

  attachSwarm(swarm: Swarm): void {
    this.swarmActive = true;
    this.live.delete('main');
    // Agents may have joined (and the channel started) before the UI attached: seed from current state.
    for (const c of swarm.configs())
      this.agentLive(c.name, { role: c.role, ...(c.color ? { color: c.color } : {}) });
    this.restoreChannel(swarm.log);
    const off: (() => void)[] = [];
    off.push(
      swarm.events.on('agent_added', ({ name, role, color }) => {
        this.agentLive(name, { role, ...(color ? { color } : {}) });
        this.publish(true);
      }),
      swarm.events.on('message', (m) => {
        this.push({
          kind: 'channel',
          from: m.from,
          ...(m.to ? { to: m.to } : {}),
          text: m.text,
          ...(m.auto ? { auto: true } : {}),
        });
      }),
      swarm.events.on('agent_event', ({ name, event }) => this.onAgentEvent(name, event, true)),
    );
    this.unsubs.push(...off);
    this.publish(true);
  }

  /** Replay a saved channel into the transcript when a swarm is resumed. */
  restoreChannel(log: { from: string; to?: string | undefined; text: string; auto?: boolean }[]): void {
    for (const m of log) {
      this.items = [
        ...this.items,
        {
          id: this.nextId++,
          kind: 'channel',
          from: m.from,
          ...(m.to ? { to: m.to } : {}),
          text: m.text,
          ...(m.auto ? { auto: true } : {}),
        },
      ];
    }
    this.publish(true);
  }

  detachSwarm(): void {
    this.swarmActive = false;
    for (const k of [...this.live.keys()]) if (k !== 'main') this.live.delete(k);
    this.agentLive('main');
    this.publish(true);
  }

  attachBrowser(events: { on(e: 'event', h: (e: BrowserEvent) => void): () => void }): void {
    this.unsubs.push(
      events.on('event', (e) => {
        if (e.type === 'opened') this.browser = { ...this.browser, open: true };
        else if (e.type === 'closed') this.browser = { open: false, holder: 'agent' };
        else if (e.type === 'navigated') this.browser = { ...this.browser, open: true, url: e.url };
        else if (e.type === 'action') this.browser = { ...this.browser, lastAction: e.text };
        else if (e.type === 'control') this.browser = { ...this.browser, holder: e.holder };
        else if (e.type === 'blocked') this.notice(`Browser blocked ${e.url}: ${e.reason}`, 'warn');
        this.publish();
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    if (this.timer) clearTimeout(this.timer);
  }

  private onAgentEvent(name: string, e: AgentEvent, inSwarm = false): void {
    const a = this.agentLive(name);
    switch (e.type) {
      case 'turn_start':
        a.running = true;
        a.startedAt = Date.now();
        a.text = '';
        a.thinking = 0;
        break;
      case 'text':
        a.text += e.delta;
        break;
      case 'thinking':
        a.thinking += e.delta.length;
        break;
      case 'assistant': {
        // Commit the streamed text once the message is complete.
        const text = e.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        if (text) this.push({ kind: 'assistant', text, agent: name });
        a.text = '';
        a.thinking = 0;
        break;
      }
      case 'tool_start':
        a.tools.push({
          id: e.id,
          name: e.name,
          description: e.description,
          startedAt: Date.now(),
          output: '',
        });
        a.lastTool = e.description;
        break;
      case 'tool_progress': {
        const t = a.tools.find((x) => x.id === e.id);
        if (t) t.output = e.text;
        break;
      }
      case 'tool_end': {
        const t = a.tools.find((x) => x.id === e.id);
        a.tools = a.tools.filter((x) => x.id !== e.id);
        const s = summarize(e.name, e.result);
        this.push({
          kind: 'tool',
          agent: name,
          name: e.name,
          description: t?.description ?? e.name,
          status: e.result.isError
            ? /^Denied|denied this action|Blocked by/.test(e.result.content)
              ? 'denied'
              : 'error'
            : 'ok',
          summary: s.summary,
          ...(s.detail ? { detail: s.detail } : {}),
        });
        break;
      }
      case 'tool_denied':
        break;
      case 'usage': {
        // Each agent reports its own running total; the footer shows the sum across agents.
        this.perAgent.set(name, { input: e.total.inputTokens, output: e.total.outputTokens });
        this.contextTokens = e.contextTokens;
        let input = 0;
        let output = 0;
        for (const t of this.perAgent.values()) {
          input += t.input;
          output += t.output;
        }
        this.tokens = { input, output };
        break;
      }
      case 'queued':
        this.queued = e.count;
        break;
      case 'compaction':
        if (e.phase === 'start') {
          this.compacting = { pct: e.pct };
          this.status = `Context at ${e.pct}% — compacting. The chat is paused; anything you type is queued.`;
        } else {
          this.compacting = undefined;
          this.status = undefined;
          if (e.ok)
            this.notice(
              `Context compacted: ${e.beforePct}% → ${e.afterPct}%. Nothing was lost; the full history stays in the session file.`,
              'success',
            );
        }
        break;
      case 'paused':
        this.notice(e.reason, 'error');
        break;
      case 'compacted':
        this.notice(`Compacted ${e.droppedMessages} earlier messages into a summary.`, 'info');
        break;
      case 'status':
        this.setStatus(e.text);
        break;
      case 'error':
        this.notice(e.message, 'error');
        break;
      case 'turn_end':
        a.running = false;
        a.tools = [];
        a.text = '';
        this.status = undefined;
        if (e.stopReason === 'aborted') this.notice(`${inSwarm ? name + ': ' : ''}Interrupted.`, 'warn');
        else if (e.stopReason === 'max_tokens')
          this.notice('Response hit the output limit and was cut off.', 'warn');
        break;
    }
    this.publish();
  }

  private perAgent = new Map<string, { input: number; output: number }>();
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Rebuild the on-screen transcript from stored messages (used by /resume and /tree). */
export function replayInto(store: UiStore, messages: Message[]): void {
  store.clear();
  const calls = new Map<string, { name: string; description: string }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') {
        if (m.role === 'user') store.user(b.text);
        else store.push({ kind: 'assistant', text: b.text, agent: 'main' });
      } else if (b.type === 'tool_use') {
        calls.set(b.id, { name: b.name, description: JSON.stringify(b.input).slice(0, 80) });
      } else if (b.type === 'tool_result') {
        const c = calls.get(b.toolUseId);
        const s = summarize(c?.name ?? 'tool', {
          content: b.content,
          ...(b.isError ? { isError: true } : {}),
        });
        store.push({
          kind: 'tool',
          agent: 'main',
          name: c?.name ?? 'tool',
          description: c?.description ?? '',
          status: b.isError ? 'error' : 'ok',
          summary: s.summary,
        });
      }
    }
  }
}
