import type { Agent, AgentEvent } from '../agent/agent.js';
import type { Message } from '../llm/types.js';
import type { SwarmAgentConfig } from '../config/schema.js';
import { Emitter } from '../util/emitter.js';
import type { SwarmState, SwarmStore } from './store.js';
import { SYSTEM, USER, type BusMessage, type SwarmMember, type Teammate } from './types.js';

export interface SwarmOptions {
  /** Build an agent for a member. The factory wires tools, policy, sandbox and the system prompt. */
  createAgent(cfg: SwarmAgentConfig, member: SwarmMember, roster: () => Teammate[]): Agent;
  maxAgents: number;
  /** Max bus messages between two user messages (runaway-chatter backstop). */
  maxMessages: number;
  allowSpawn: boolean;
  /** Persist roster, notes, pending context and the channel so the swarm can be resumed. */
  store?: SwarmStore;
  /** State to resume from (the agents themselves are re-added by the caller). */
  restore?: { state: SwarmState; log: BusMessage[] };
}

export type SwarmEvents = {
  message: BusMessage;
  agent_added: { name: string; role: string; color?: string };
  agent_status: { name: string; running: boolean };
  agent_event: { name: string; event: AgentEvent };
  budget_exhausted: { limit: number };
};

interface Slot {
  cfg: SwarmAgentConfig;
  agent: Agent;
  /** Messages seen while asleep; delivered with the next wake-up. */
  pending: string[];
  /** Who sent the message that last woke this agent (a teammate's name or the user). */
  wokenBy?: string;
  /** Whether the agent posted to the channel during its current turn. */
  spoke: boolean;
  /** The text of the agent's latest assistant message this turn: its report if it sends none itself. */
  lastText: string;
}

/** The text blocks of an assistant message. */
function textOf(message: Message): string {
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

/**
 * A shared channel where several agents collaborate live. The user sees (and can interject in)
 * the same channel. Wake rules keep it from degenerating into every agent answering every message:
 *   - a message wakes only its addressee (`to=` or an @mention);
 *   - unaddressed messages from the user go to the first agent (the lead);
 *   - everyone else just receives it as context with their next wake-up.
 *
 * Reporting lines are enforced here rather than left to the models, because small models drift out of
 * their roles and end their turn without telling anyone, which silently stalls the team:
 *   - only the lead talks to the user; a teammate's message "to the user" (or to nobody) goes to the lead;
 *   - a teammate that ends its turn without posting anything has its final text delivered as its report,
 *     to whoever woke it (or the lead), which wakes them so the work carries on;
 *   - a lead that writes "@builder do X" as plain text instead of calling swarm_say still reaches the builder;
 *   - every wake-up restates the agent's role and who it answers to.
 */
export class Swarm {
  readonly events = new Emitter<SwarmEvents>();
  readonly log: BusMessage[] = [];
  private slots = new Map<string, Slot>();
  private notesStore: Record<string, string> = {};
  private nextId = 1;
  private budget: number;
  private exhaustedNotified = false;
  private persistTimer: NodeJS.Timeout | undefined;
  private state: SwarmState | undefined;

  constructor(private opts: SwarmOptions) {
    this.budget = opts.maxMessages;
    if (opts.restore) {
      this.state = opts.restore.state;
      this.notesStore = { ...opts.restore.state.notes };
      this.log.push(...opts.restore.log);
      this.nextId = Math.max(0, ...opts.restore.log.map((m) => m.id)) + 1;
    }
  }

  get id(): string | undefined {
    return this.state?.id;
  }

  get names(): string[] {
    return [...this.slots.keys()];
  }

  agent(name: string): Agent | undefined {
    return this.slots.get(name)?.agent;
  }

  /** The configured agents (name, role, colour, model...), for UIs attaching to a running swarm. */
  configs(): SwarmAgentConfig[] {
    return [...this.slots.values()].map((s) => s.cfg);
  }

  /** The first agent added leads: it hears the user and is the only one who answers them. */
  get lead(): string | undefined {
    return this.names[0];
  }

  roster = (): Teammate[] =>
    [...this.slots.values()].map((s) => ({ name: s.cfg.name, role: s.cfg.role, running: s.agent.isRunning }));

  async addAgent(cfg: SwarmAgentConfig, opts: { resumed?: boolean } = {}): Promise<string> {
    if (this.slots.has(cfg.name)) throw new Error(`An agent named "${cfg.name}" already exists`);
    if (this.slots.size >= this.opts.maxAgents)
      throw new Error(`Swarm is limited to ${this.opts.maxAgents} agents`);
    const member = this.memberFor(cfg.name);
    const agent = this.opts.createAgent(cfg, member, this.roster);
    const slot: Slot = {
      cfg,
      agent,
      pending: [...(this.state?.pending[cfg.name] ?? [])],
      spoke: false,
      lastText: '',
    };
    agent.events.on('event', (event) => {
      this.events.emit('agent_event', { name: cfg.name, event });
      if (event.type === 'turn_start') {
        slot.spoke = false;
        slot.lastText = '';
        this.events.emit('agent_status', { name: cfg.name, running: true });
      }
      if (event.type === 'assistant') slot.lastText = textOf(event.message) || slot.lastText;
      if (event.type === 'turn_end') {
        this.events.emit('agent_status', { name: cfg.name, running: false });
        this.afterTurn(slot, event.stopReason);
      }
    });
    this.slots.set(cfg.name, slot);
    this.events.emit('agent_added', {
      name: cfg.name,
      role: cfg.role,
      ...(cfg.color ? { color: cfg.color } : {}),
    });
    if (!opts.resumed) this.system(`${cfg.name} joined (${cfg.role})`);
    this.persist();
    return cfg.name;
  }

  private memberFor(name: string): SwarmMember {
    return {
      name,
      say: (text, to) => {
        if (to && to !== USER && to !== 'all' && !this.slots.has(to)) {
          return {
            ok: false,
            error: `No agent named "${to}". Teammates: ${this.names.filter((n) => n !== name).join(', ') || 'none'}`,
          };
        }
        const slot = this.slots.get(name);
        if (slot) slot.spoke = true;
        // Only the lead answers the user. Everyone else's messages, including ones meant for the user or for
        // nobody in particular, go to the lead, who decides what the user needs to hear.
        let note: string | undefined;
        const lead = this.lead;
        if (lead && name !== lead && (!to || to === USER || to === 'all')) {
          if (to === USER) note = `Sent to ${lead}: only the lead talks to the user.`;
          to = lead;
        }
        return this.route(name, text, to)
          ? { ok: true, ...(note ? { note } : {}) }
          : { ok: false, error: 'Message budget exhausted; wait for the user.' };
      },
      note: (k, v) => {
        this.notesStore[k] = v;
        this.persist();
      },
      notes: () => ({ ...this.notesStore }),
      roster: this.roster,
      ...(this.opts.allowSpawn
        ? {
            spawn: async (cfg: SwarmAgentConfig, task?: string) => {
              await this.addAgent(cfg);
              if (task) this.route(name, task, cfg.name);
              return cfg.name;
            },
          }
        : {}),
    };
  }

  /** The human speaks in the channel. Resets the runaway-chatter budget. */
  say(text: string, to?: string): void {
    this.budget = this.opts.maxMessages;
    this.exhaustedNotified = false;
    this.route(USER, text, to);
  }

  private system(text: string): void {
    this.record({ from: SYSTEM, text, kind: 'system' });
  }

  private record(m: Omit<BusMessage, 'id' | 'ts'>): BusMessage {
    const msg: BusMessage = { id: this.nextId++, ts: Date.now(), ...m };
    this.log.push(msg);
    this.opts.store?.appendMessage(msg);
    this.events.emit('message', msg);
    return msg;
  }

  /**
   * An agent's turn ended. If it never posted to the channel, its final text is its report: deliver it so the
   * team does not stall waiting for a message that will never come.
   */
  private afterTurn(slot: Slot, stop: string): void {
    if (stop === 'aborted' || stop === 'paused' || slot.spoke) return;
    const name = slot.cfg.name;
    const text = slot.lastText;
    const lead = this.lead;
    if (name === lead) {
      // The lead's plain reply is its answer to the user, unless a line of it is addressed to a teammate
      // ("@builder add the tests"). A passing mention ("thanks to @builder") is not a hand-off.
      const handoff = text.split('\n').some((l) => {
        const m = /^\s*@([a-z][a-z0-9_-]*)/i.exec(l);
        return !!m && m[1]!.toLowerCase() !== name && this.slots.has(m[1]!.toLowerCase());
      });
      if (handoff) this.route(name, text, undefined, { auto: true });
      return;
    }
    if (!lead) return;
    const report = text || `(${name} finished without writing a report)`;
    const from = slot.wokenBy;
    if (from && from !== USER && this.slots.has(from)) this.route(name, report, from, { auto: true });
    // Asked directly by the user: they have seen the answer. The lead gets it as context without being woken.
    else if (from === USER) this.route(name, report, lead, { auto: true, wake: false });
    else this.route(name, report, lead, { auto: true });
  }

  private mentionsIn(text: string): string[] {
    return [...text.matchAll(/@([a-z][a-z0-9_-]*)/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((n) => this.slots.has(n));
  }

  /** Returns false if the budget stopped delivery. */
  private route(
    from: string,
    text: string,
    to?: string,
    opts: { auto?: boolean; wake?: boolean } = {},
  ): boolean {
    if (from !== USER) {
      if (this.budget <= 0) {
        if (!this.exhaustedNotified) {
          this.exhaustedNotified = true;
          this.system(
            `Message budget (${this.opts.maxMessages}) reached — agents are paused until you speak.`,
          );
          this.events.emit('budget_exhausted', { limit: this.opts.maxMessages });
        }
        return false;
      }
      this.budget--;
    }
    const mentions = this.mentionsIn(text);
    const explicit = to && this.slots.has(to) ? [to] : [];
    let wake = [...new Set([...explicit, ...mentions])].filter((n) => n !== from);
    if (!wake.length && from === USER && (!to || to === 'all')) {
      const lead = this.lead;
      if (lead) wake = [lead];
    }
    if (opts.wake === false) wake = [];
    this.record({
      from,
      ...(to && to !== 'all' ? { to } : {}),
      text,
      kind: 'chat',
      ...(opts.auto ? { auto: true } : {}),
    });

    const line = `[${from}${to && to !== 'all' ? ` → ${to}` : ''}${opts.auto ? ', report' : ''}] ${text}`;
    for (const [name, slot] of this.slots) {
      if (name === from) continue;
      if (wake.includes(name)) this.wakeup(slot, line, from);
      else slot.pending.push(line);
    }
    this.persist();
    return true;
  }

  private wakeup(slot: Slot, line: string, from: string): void {
    slot.wokenBy = from;
    const context = slot.pending.splice(0);
    this.persist();
    const prompt = [
      context.length ? `Channel activity since you last acted:\n${context.join('\n')}\n` : '',
      `Message for you:\n${line}`,
      `\n${this.reminder(slot.cfg.name, from)}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (slot.agent.isRunning) slot.agent.steer(prompt);
    else void slot.agent.run(prompt);
  }

  /** A short restatement of the agent's place in the team, sent with every wake-up (small models forget). */
  private reminder(name: string, from: string): string {
    const lead = this.lead;
    const others = this.names.filter((n) => n !== name);
    if (name === lead) {
      return `(You are ${name}, the lead. Hand each step to a teammate with swarm_say to="${others[0] ?? 'name'}"${
        others.length > 1 ? ` (teammates: ${others.join(', ')})` : ''
      }; their reports come back to you automatically. Do not do their work for them. When the whole task is done, reply to the user with the result.)`;
    }
    const replyTo = from !== USER && this.slots.has(from) ? from : lead;
    return `(You are ${name}. You report to ${lead}, never to the user. Do the step you were given, then end your turn with a short report of what you did and the result: it is delivered to ${replyTo} automatically. If you are blocked or unsure, say so in that report instead of asking the user.)`;
  }

  /** Resolve when every agent is idle and has no work queued. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.slots.values()].filter((s) => s.agent.isRunning);
      if (!busy.length) return;
      await Promise.all(busy.map((s) => s.agent.idle()));
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Debounced atomic write of the swarm state (roster, notes, undelivered context). */
  private persist(): void {
    if (!this.opts.store || !this.state) return;
    this.persistTimer ??= setTimeout(() => this.flush(), 100);
  }

  /** Write the state now (called on stop / exit). */
  flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.opts.store || !this.state) return;
    this.state = {
      ...this.state,
      agents: [...this.slots.values()].map((s) => s.cfg),
      notes: { ...this.notesStore },
      pending: Object.fromEntries([...this.slots].map(([n, s]) => [n, [...s.pending]])),
    };
    this.opts.store.saveState(this.state);
  }

  abortAll(): void {
    for (const s of this.slots.values()) s.agent.abort();
  }

  notes(): Record<string, string> {
    return { ...this.notesStore };
  }
}
