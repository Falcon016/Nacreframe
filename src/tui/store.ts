import type { AgentEvent } from '../agent/agent.js';
import { isHarnessNote, type Agent } from '../agent/agent.js';
import type { BrowserEvent } from '../browser/service.js';
import type { Message } from '../llm/types.js';
import type { Swarm } from '../swarm/swarm.js';
import type { ToolResult } from '../tools/types.js';
import { oneLine } from '../util/text.js';

export type Level = 'info' | 'warn' | 'error' | 'success';

export type Item =
  | { id: number; kind: 'user'; text: string }
  /** `cont`: a later part of a reply whose start is already printed (`gap`: a blank line comes before it). */
  | { id: number; kind: 'assistant'; text: string; agent: string; cont?: boolean; gap?: boolean }
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
  /** What an agent reasoned before answering; shown in full only while thinking is switched on. */
  | { id: number; kind: 'thinking'; agent: string; text: string; ms: number }
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
  /** The reasoning streamed so far in this message (the last few thousand characters). */
  thought: string;
  thinkingSince?: number;
  thinkingUntil?: number;
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
  compacting?: { pct: number; incoming?: boolean };
  /** Show agents' reasoning in full (otherwise a one-line "thought for 8s"). */
  showThinking: boolean;
  /** Messages the swarm's agents have sent each other since you last spoke, against the limit (0 = none). */
  swarmBudget?: { used: number; limit: number };
  /** Generation speed: replies streaming now (summed across agents), else the last finished reply. */
  speed?: { tokensPerSecond: number; live: boolean };
}

/** How much live reasoning to keep per agent: enough to show its tail, not the whole essay. */
const THOUGHT_TAIL = 6000;

/**
 * How much of a reply being streamed is final and can be printed for good: whole lines, but never part of a
 * code block or a table that is still open (they are printed whole, once they end).
 */
export function settledLength(text: string): number {
  let cut = 0;
  let inFence = false;
  for (let pos = 0, nl = text.indexOf('\n'); nl !== -1; pos = nl + 1, nl = text.indexOf('\n', pos)) {
    const line = text.slice(pos, nl);
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || /^\s*\|/.test(line)) continue;
    cut = nl + 1;
  }
  return cut;
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

function clearThinking(a: LiveAgent): void {
  a.thinking = 0;
  a.thought = '';
  delete a.thinkingSince;
  delete a.thinkingUntil;
}

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
  private compacting: { pct: number; incoming?: boolean } | undefined;
  private showThinking = false;
  private swarmBudget: { used: number; limit: number } | undefined;
  /** Per agent, for replies printed line by line: whether part is printed, and the full reasoning so far. */
  private streamed = new Map<string, { printed: boolean; thought: string }>();
  private liveSpeed = new Map<string, number>();
  private lastSpeed: number | undefined;

  /**
   * `printAsStreamed`: print each finished line of a reply as it arrives, so only the unfinished part stays in
   * the live area (the terminal UI: a live area taller than the window leaves copies behind in scrollback).
   * Swarm agents' replies are still printed whole, so the agents' lines do not interleave.
   */
  constructor(private opts: { printAsStreamed?: boolean } = {}) {
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
      showThinking: this.showThinking,
      ...(this.swarmActive && this.swarmBudget ? { swarmBudget: this.swarmBudget } : {}),
      ...(this.liveSpeed.size
        ? { speed: { tokensPerSecond: [...this.liveSpeed.values()].reduce((a, b) => a + b, 0), live: true } }
        : this.lastSpeed
          ? { speed: { tokensPerSecond: this.lastSpeed, live: false } }
          : {}),
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

  setShowThinking(on: boolean): void {
    this.showThinking = on;
    this.publish(true);
  }

  private agentLive(name: string, meta: Partial<LiveAgent> = {}): LiveAgent {
    let a = this.live.get(name);
    if (!a) {
      a = { name, text: '', thinking: 0, thought: '', tools: [], running: false, startedAt: Date.now() };
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
    this.swarmBudget = swarm.budget();
    const off: (() => void)[] = [];
    off.push(
      swarm.events.on('budget', (b) => {
        this.swarmBudget = b;
        this.publish();
      }),
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
        clearThinking(a);
        this.streamed.delete(name);
        break;
      case 'text':
        if (a.thinkingSince && !a.thinkingUntil) a.thinkingUntil = Date.now();
        a.text += e.delta;
        if (this.opts.printAsStreamed && !inSwarm) this.printSettled(name, a);
        break;
      case 'thinking': {
        a.thinking += e.delta.length;
        a.thinkingSince ??= Date.now();
        a.thought = (a.thought + e.delta).slice(-THOUGHT_TAIL);
        const s = this.streamed.get(name) ?? { printed: false, thought: '' };
        s.thought += e.delta;
        this.streamed.set(name, s);
        break;
      }
      case 'assistant': {
        const s = this.streamed.get(name);
        this.streamed.delete(name);
        if (s?.printed) {
          // The start of this reply is printed already: print what is left of it.
          this.pushPart(name, a.text, true);
        } else {
          // Commit the reasoning and the streamed text once the message is complete.
          const thought = e.message.content
            .map((b) => (b.type === 'thinking' ? b.text : ''))
            .join('')
            .trim();
          this.pushThought(name, a, thought);
          const text = e.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
          if (text) this.push({ kind: 'assistant', text, agent: name });
        }
        a.text = '';
        clearThinking(a);
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
        this.liveSpeed.delete(name);
        if (e.tokensPerSecond) this.lastSpeed = e.tokensPerSecond;
        break;
      }
      case 'context':
        this.contextTokens = e.tokens;
        break;
      case 'speed':
        this.liveSpeed.set(name, e.tokensPerSecond);
        break;
      case 'queued':
        this.queued = e.count;
        break;
      case 'compaction':
        if (e.phase === 'start') {
          this.compacting = { pct: e.pct, ...(e.incoming ? { incoming: true } : {}) };
          this.status = e.incoming
            ? `New tool output would take the context to ${e.pct}%: compacting before it goes in. Anything you type is queued.`
            : `Context at ${e.pct}%: compacting. The chat is paused; anything you type is queued.`;
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
        this.liveSpeed.delete(name);
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

  private pushThought(name: string, a: LiveAgent, thought: string): void {
    if (!thought) return;
    const ms = a.thinkingSince ? (a.thinkingUntil ?? Date.now()) - a.thinkingSince : 0;
    this.push({ kind: 'thinking', agent: name, text: thought, ms });
  }

  /** Print the finished lines of a reply being streamed; the rest stays live. */
  private printSettled(name: string, a: LiveAgent): void {
    // Trailing blank lines wait, so the spacing is printed with the line that follows them.
    const part = a.text.slice(0, settledLength(a.text)).replace(/\n(?:[ \t]*\n)+$/, '\n');
    if (!part.trim()) return;
    const s = this.streamed.get(name) ?? { printed: false, thought: '' };
    if (!s.printed) this.pushThought(name, a, s.thought.trim());
    this.pushPart(name, part, s.printed);
    s.printed = true;
    this.streamed.set(name, s);
    a.text = a.text.slice(part.length);
  }

  private pushPart(name: string, part: string, cont: boolean): void {
    const gap = cont && /^[ \t]*\n/.test(part);
    const text = part
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\n$/, '')
      .trimEnd();
    if (!text.trim()) return;
    this.push({
      kind: 'assistant',
      text,
      agent: name,
      ...(cont ? { cont: true } : {}),
      ...(gap ? { gap: true } : {}),
    });
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Rebuild the on-screen transcript from stored messages (used by /resume and /tree). */
export function replayInto(store: UiStore, messages: Message[]): void {
  store.clear();
  const calls = new Map<string, { name: string; description: string }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'thinking' && b.text.trim()) {
        store.push({ kind: 'thinking', agent: 'main', text: b.text.trim(), ms: 0 });
      } else if (b.type === 'text') {
        if (m.role === 'user') {
          if (!isHarnessNote(b.text)) store.user(b.text);
        } else store.push({ kind: 'assistant', text: b.text, agent: 'main' });
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
