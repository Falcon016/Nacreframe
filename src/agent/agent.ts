import type { Config } from '../config/schema.js';
import { assemble } from '../llm/assemble.js';
import type { ResolvedModel } from '../llm/registry.js';
import type { ContentBlock, Message, StopReason, StreamEvent, Usage } from '../llm/types.js';
import { ProviderError } from '../llm/types.js';
import type { PolicyEngine } from '../policy/engine.js';
import { describeGrant, grantKey } from '../policy/engine.js';
import type { Sandbox } from '../sandbox/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AnyTool, ToolContext, ToolResult, TodoItem, Question } from '../tools/types.js';
import { Emitter } from '../util/emitter.js';
import { redact } from '../util/redact.js';
import { estimateTokens, truncateMiddle } from '../util/text.js';
import type { BrowserService } from '../browser/service.js';
import type { SwarmMember } from '../swarm/types.js';
import { compact, CompactionError, type CompactResult } from './compaction.js';
import {
  COMPACT_THRESHOLD_MAX,
  danglingToolUseIds,
  estimateMessages,
  estimateSpecs,
  HARD_LIMIT,
  MIN_REPLY_TOKENS,
  sanitizeMessages,
  syntheticResults,
} from './context.js';
import type { Session } from './session.js';

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'assistant'; message: Message }
  | { type: 'tool_start'; id: string; name: string; description: string; input: unknown }
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult }
  | { type: 'tool_denied'; id: string; name: string; reason: string }
  /** `tokensPerSecond`: how fast this reply was generated, from its first token to its last. */
  | { type: 'usage'; usage: Usage; total: Usage; contextTokens: number; tokensPerSecond?: number }
  /** How full the context is now (after a reply, tool results or compaction). */
  | { type: 'context'; tokens: number }
  /** Generation speed while a reply streams (an estimate from the text so far; `usage` has the final figure). */
  | { type: 'speed'; tokensPerSecond: number }
  | { type: 'compacted'; droppedMessages: number }
  /** `incoming`: tokens about to be added (tool results), compacted for before they go in. */
  | {
      type: 'compaction';
      phase: 'start';
      pct: number;
      usedTokens: number;
      windowTokens: number;
      incoming?: number;
    }
  | { type: 'compaction'; phase: 'end'; ok: boolean; beforePct: number; afterPct: number }
  | { type: 'queued'; count: number }
  | { type: 'paused'; reason: string }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'turn_end'; stopReason: StopReason | 'aborted' | 'max_iterations' | 'paused' };

export interface ApprovalRequest {
  agentId: string;
  toolName: string;
  description: string;
  reason: string;
  risk: string;
  preview?: string;
  grantLabel: string;
}

export interface ApprovalResponse {
  allow: boolean;
  /** Remember the decision for the rest of the session. */
  always?: boolean;
  /** Message returned to the model when denying. */
  feedback?: string;
}

export type Approver = (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResponse>;

export interface AgentHooks {
  beforeTool?(ev: {
    agentId: string;
    name: string;
    input: Record<string, unknown>;
  }): Promise<{ block?: string; input?: Record<string, unknown> } | void>;
  afterTool?(ev: {
    agentId: string;
    name: string;
    input: Record<string, unknown>;
    result: ToolResult;
  }): Promise<ToolResult | void>;
}

export interface AgentServices {
  ask?: (q: Question) => Promise<string>;
  setTodos?: (todos: TodoItem[]) => void;
  browser?: BrowserService;
  swarm?: SwarmMember;
  skills?: { get(name: string): string | undefined; names(): string[] };
}

export interface AgentOptions {
  id: string;
  cwd: string;
  config: Config;
  model: ResolvedModel;
  smallModel?: ResolvedModel;
  tools: ToolRegistry;
  policy: PolicyEngine;
  sandbox: Sandbox;
  session: Session;
  approver: Approver;
  system: () => string;
  services?: AgentServices;
  hooks?: AgentHooks;
  /** Delays between compaction retries (tests shorten these). */
  retryDelaysMs?: number[];
}

const OVERFLOW =
  /prompt is too long|context (length|window|size)|maximum context|too many tokens|exceeds the (model|context|available)|input is too long|n_ctx/i;

/**
 * What a provider's rejection of the requested output size tells us, if it was one:
 * - `maxOutput`: the model's own ceiling for one reply (hosted APIs cap it well below the context window);
 * - `room`: how much the server says is really left in the window after the prompt (our estimate was low).
 * Undefined when the error is about something else, or the prompt alone is too long (that is compaction's job).
 */
export function outputLimitFix(message: string): { maxOutput: number } | { room: number } | undefined {
  const n = (s: string | undefined) => Number(s);
  let m = /supports at most (\d+) completion tokens/i.exec(message); // OpenAI
  if (m) return { maxOutput: n(m[1]) };
  m = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(message); // Anthropic
  if (m) return { maxOutput: n(m[1]) };
  let room: number | undefined;
  if ((m = /(\d+)\s*\+\s*\d+\s*>\s*(\d+)/.exec(message)) && /max_tokens/i.test(message))
    room = n(m[2]) - n(m[1]); // Anthropic: "input + max_tokens > limit"
  else if ((m = /maximum context length is (\d+)[^]*?(\d+) in the messages/i.exec(message)))
    room = n(m[1]) - n(m[2]); // vLLM and others: "(P in the messages, C in the completion)"
  else if (
    (m = /maximum context length is (\d+) tokens and your request has (\d+) input tokens/i.exec(message))
  )
    room = n(m[1]) - n(m[2]); // newer vLLM
  if (room !== undefined) return room >= MIN_REPLY_TOKENS ? { room } : undefined;
  // Some other complaint about the output size without numbers: fall back to a size every provider accepts.
  if (
    /\b(max_tokens|max_completion_tokens|max_output_tokens|n_predict|num_predict)\b/i.test(message) &&
    !OVERFLOW.test(message)
  )
    return { maxOutput: 8192 };
  return undefined;
}

/** Marks the harness's reminder to update the task list (a user message the user did not type). */
export const TODO_CHECK = '[Task list check]';
/** Marks the harness's request to carry on with a reply cut off at the compaction line. */
export const CONTINUE_NOTE = '[Continue]';
/** User messages the harness wrote itself, which UIs do not show as typed by the user. */
export const isHarnessNote = (text: string) => text.startsWith(TODO_CHECK) || text.startsWith(CONTINUE_NOTE);

/** Replies cut off at the compaction line that are carried on after compacting, per run. */
const MAX_CONTINUATIONS = 4;
/**
 * The least room under the compaction line worth sending a request with (2% of the window, at most 1024 tokens):
 * compaction starts this close to the line, and with less room than this after compacting, a reply may use the
 * window's own room instead.
 */
const usefulReply = (window: number) => Math.max(64, Math.min(1024, Math.floor(window * 0.02)));

const formatTodos = (todos: TodoItem[]) =>
  todos
    .map(
      (t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`,
    )
    .join('\n');

/** Thrown to end a turn without sending anything further, leaving the conversation intact. */
export class PauseTurn extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PauseTurn';
  }
}

export interface EnsureOptions {
  /** Compact even if below the threshold (manual /compact, overflow recovery). */
  force?: boolean;
  /** Report problems as a return value instead of pausing the turn (manual /compact). */
  manual?: boolean;
  /** Called after a finished answer: failures are reported but do not end the turn as an error. */
  quiet?: boolean;
  instructions?: string | undefined;
  /** Tokens about to be added (tool results): make room for them before they go in. */
  incoming?: number;
}

export class Agent {
  readonly id: string;
  readonly events = new Emitter<{ event: AgentEvent }>();
  readonly readState = new Map<string, number>();
  readonly totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  contextTokens = 0;

  private steering: string[] = [];
  private followUps: string[] = [];
  private controller: AbortController | undefined;
  private running = false;
  /** Output size of the last request, and the room a provider said is really left (used once, for the retry). */
  private lastMaxTokens: number | undefined;
  private roomOverride: number | undefined;
  private compacting = false;
  private idleWaiters: (() => void)[] = [];
  /** Exact context size reported by the provider after the last response (when it reports one). */
  private reported: { tokens: number; messages: number } | undefined;
  /** The task list this agent keeps with todo_write, and whether this run did any work / was reminded of it. */
  private todos: TodoItem[] = [];
  private workedThisRun = false;
  private todoReminded = false;
  /** Whether the last request's reply size was set by the room left below the compaction line. */
  private cappedAtLine = false;

  constructor(private o: AgentOptions) {
    this.id = o.id;
  }

  get isRunning(): boolean {
    return this.running;
  }
  get isCompacting(): boolean {
    return this.compacting;
  }
  /** Messages typed while the agent was busy or compacting, waiting to be delivered in order. */
  get queued(): number {
    return this.steering.length + this.followUps.length;
  }
  get model(): ResolvedModel {
    return this.o.model;
  }
  get smallModelResolved(): ResolvedModel | undefined {
    return this.o.smallModel;
  }
  get session(): Session {
    return this.o.session;
  }
  setModel(m: ResolvedModel): void {
    this.o.model = m;
    this.reported = undefined;
  }
  setSession(s: Session): void {
    this.o.session = s;
    this.readState.clear();
    this.reported = undefined;
    this.todos = [];
  }
  setSandbox(sb: Sandbox): void {
    this.o.sandbox = sb;
  }
  setServices(s: AgentServices): void {
    this.o.services = { ...this.o.services, ...s };
  }

  private emit(event: AgentEvent): void {
    this.events.emit('event', event);
  }
  private emitQueue(): void {
    this.emit({ type: 'queued', count: this.queued });
  }

  /** Inject a message into the running turn (delivered before the next model call, never during compaction). */
  steer(text: string): void {
    this.steering.push(text);
    this.emitQueue();
  }

  /** Queue a message to run after the current turn completes. */
  followUp(text: string): void {
    this.followUps.push(text);
    this.emitQueue();
  }

  abort(): void {
    this.controller?.abort();
  }

  idle(): Promise<void> {
    return this.running ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  private drainSteering(): void {
    let any = false;
    while (this.steering.length) {
      this.o.session.append(
        { role: 'user', content: [{ type: 'text', text: this.steering.shift()! }] },
        this.id,
      );
      any = true;
    }
    if (any) this.emitQueue();
  }

  /** Close any tool call left unanswered by a crash or abort so the next request is valid. */
  private repairSession(): void {
    const ids = danglingToolUseIds(this.o.session.messages());
    if (ids.length) this.o.session.append(syntheticResults(ids), this.id);
  }

  /** Run one user prompt to completion (model calls + tool loop). */
  async run(input: string | ContentBlock[]): Promise<void> {
    if (this.running) {
      if (typeof input === 'string') this.steer(input);
      return;
    }
    this.running = true;
    this.workedThisRun = false;
    this.todoReminded = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let stop: StopReason | 'aborted' | 'max_iterations' | 'paused' = 'end_turn';
    try {
      this.emit({ type: 'turn_start' });
      this.repairSession();
      // Anything typed while a previous turn was paused goes first, in the order it was typed.
      this.drainSteering();
      this.o.session.append(
        { role: 'user', content: typeof input === 'string' ? [{ type: 'text', text: input }] : input },
        this.id,
      );
      for (;;) {
        stop = await this.loop(signal);
        if (signal.aborted) break;
        // A message steered in after the final model reply must not be lost: run another pass for it.
        if (this.steering.length) continue;
        const next = this.followUps.shift();
        if (!next) break;
        this.emitQueue();
        this.o.session.append({ role: 'user', content: [{ type: 'text', text: next }] }, this.id);
      }
    } catch (e) {
      if (signal.aborted) stop = 'aborted';
      else if (e instanceof PauseTurn) {
        stop = 'paused';
        this.emit({ type: 'paused', reason: e.message });
      } else {
        stop = 'other';
        this.emit({ type: 'error', message: friendly(e) });
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.emit({ type: 'turn_end', stopReason: stop });
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private async loop(signal: AbortSignal): Promise<StopReason | 'aborted' | 'max_iterations'> {
    const max = this.o.config.maxToolIterations || Infinity; // 0 = no limit
    let recovered = false;
    let outputFixes = 0;
    let continuations = 0;
    for (let iter = 0; iter < max; iter++) {
      if (signal.aborted) return 'aborted';
      this.drainSteering();
      // The chat is held here, before anything is sent, until the context fits.
      await this.ensureRoom(signal);
      if (this.steering.length) {
        // Typed while we were compacting: include it in this very request, then make sure it still fits.
        this.drainSteering();
        await this.ensureRoom(signal);
      }

      let result;
      try {
        result = await this.callModel(signal);
      } catch (e) {
        if (signal.aborted) return 'aborted';
        const fix = e instanceof ProviderError && e.status === 400 ? outputLimitFix(e.message) : undefined;
        if (fix && outputFixes < 3) {
          // The reply size we asked for was refused: take the provider's real figure and ask again.
          outputFixes++;
          if ('maxOutput' in fix && fix.maxOutput < (this.lastMaxTokens ?? Infinity))
            this.o.model.maxOutput = fix.maxOutput;
          else if ('room' in fix) this.roomOverride = fix.room;
          else throw e;
          iter--;
          continue;
        }
        const overflow =
          e instanceof ProviderError && (e.status === 400 || e.status === 413) && OVERFLOW.test(e.message);
        if (!recovered && overflow) {
          // The provider's real limit is lower than we believed: learn it, compact harder, retry once.
          recovered = true;
          this.learnWindow();
          this.emit({
            type: 'status',
            text: 'The model reported a smaller context window — compacting and retrying…',
          });
          await this.ensureRoom(signal, { force: true });
          continue;
        }
        throw e;
      }
      const { message, stopReason, badToolCalls } = result;
      if (message.content.length) this.o.session.append(message, this.id);
      this.noteReported(result.usage, message);
      this.emit({ type: 'assistant', message });
      this.emitContext();

      const calls = message.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (
        !calls.length &&
        stopReason === 'max_tokens' &&
        this.cappedAtLine &&
        continuations < MAX_CONTINUATIONS
      ) {
        // The reply reached the compaction line: compact, then let the model carry on from where it stopped.
        const { compacted } = await this.ensureRoom(signal, { force: true, quiet: true });
        if (compacted) {
          continuations++;
          this.o.session.append(
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `${CONTINUE_NOTE} Your reply was cut off because the context reached its limit, and the older conversation was summarised to make room. Continue exactly where you stopped, without repeating what you already wrote.`,
                },
              ],
            },
            this.id,
          );
          this.emitContext();
          continue;
        }
      }
      if (!calls.length) {
        const reminder = stopReason === 'end_turn' ? this.todoReminder() : undefined;
        if (reminder) {
          // The list still shows open items after the work is done: one nudge to bring it up to date.
          this.todoReminded = true;
          this.o.session.append({ role: 'user', content: [{ type: 'text', text: reminder }] }, this.id);
          this.emit({ type: 'status', text: 'Asking the model to bring its task list up to date' });
          continue;
        }
        // Compact right after a long answer so the pause happens now, not in the middle of the next request.
        await this.ensureRoom(signal, { quiet: true });
        return stopReason === 'max_tokens' ? 'max_tokens' : stopReason;
      }

      if (calls.some((c) => c.name !== 'todo_write')) this.workedThisRun = true;
      const results = await this.runTools(calls, badToolCalls, signal);
      // Results that would take the context past the compaction line: make room first, so nothing is cut.
      // (Quiet: if that fails, the results still go in and the next request pauses with them saved.)
      const incoming = estimateMessages([{ role: 'user', content: results }]);
      if (!signal.aborted) await this.ensureRoom(signal, { quiet: true, incoming });
      this.o.session.append({ role: 'user', content: results }, this.id);
      this.emitContext();
      if (signal.aborted) return 'aborted';
    }
    this.emit({ type: 'status', text: `Stopped after ${max} tool iterations. Send a message to continue.` });
    return 'max_iterations';
  }

  /**
   * A reminder to update the task list, when a run that did work is about to end with items still open on it.
   * Once per run, and only when the model can update it.
   */
  private todoReminder(): string | undefined {
    // Swarm members report with their final words, which the reminder's short answer would replace.
    if (this.todoReminded || !this.workedThisRun || this.o.services?.swarm || !this.o.tools.get('todo_write'))
      return undefined;
    const open = this.todos.filter((t) => t.status !== 'completed');
    if (!open.length) return undefined;
    return (
      `${TODO_CHECK} Your task list still shows ${open.length} unfinished item${open.length === 1 ? '' : 's'}:\n` +
      `${formatTodos(open)}\n` +
      'Call todo_write with the complete list so it matches what was actually done: mark finished items completed. ' +
      'If an item was not done, leave it pending and say so in one short line. Do not repeat your previous answer.'
    );
  }

  // ---- context accounting & compaction -------------------------------------------------------------

  /** What we send: valid by construction (see sanitizeMessages). */
  private view(): Message[] {
    return sanitizeMessages(this.o.session.messages());
  }

  /** Tokens the next request would use: provider-reported when available, else a conservative estimate. */
  private promptTokens(): number {
    const msgs = this.view();
    const thinking = this.keepsThinking;
    const fixed = estimateTokens(this.o.system()) + estimateSpecs(this.o.tools.specs());
    const est = fixed + estimateMessages(msgs, { thinking });
    const r = this.reported;
    if (r && msgs.length >= r.messages) {
      return Math.max(
        r.tokens + estimateMessages(msgs.slice(r.messages), { thinking }),
        Math.floor(est * 0.85),
      );
    }
    return est;
  }

  /** Whether reasoning stays in the context (sent back with the conversation) for this provider. */
  private get keepsThinking(): boolean {
    return this.o.model.provider.keepsThinking === true;
  }

  /** How full the context is right now, for UIs. */
  private emitContext(): void {
    this.contextTokens = this.promptTokens();
    this.emit({ type: 'context', tokens: this.contextTokens });
  }

  private noteReported(u: Usage, message: Message): void {
    const prompt = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    // The reply's reasoning counts as output but is not sent back by every provider: leave it out there.
    const dropped = this.keepsThinking
      ? 0
      : estimateTokens(message.content.map((b) => (b.type === 'thinking' ? b.text : '')).join(''));
    // Some local servers omit usage; without it we keep estimating.
    this.reported =
      prompt > 0
        ? { tokens: prompt + Math.max(0, u.outputTokens - dropped), messages: this.view().length }
        : undefined;
  }

  /** The compaction trigger (never above 80% of the window) and the hard ceiling a request must stay under. */
  limits(): { window: number; target: number; hard: number } {
    const w = this.o.model.contextWindow;
    if (w <= 0) return { window: 0, target: Infinity, hard: Infinity };
    const reserve = Math.min(this.o.config.maxTokens || Infinity, Math.floor(w * 0.2));
    const threshold = Math.min(this.o.config.compaction.threshold, COMPACT_THRESHOLD_MAX);
    return {
      window: w,
      target: Math.min(Math.floor(w * threshold), w - reserve),
      hard: Math.min(Math.floor(w * HARD_LIMIT), w - MIN_REPLY_TOKENS),
    };
  }

  private learnWindow(): void {
    const used = this.promptTokens();
    const learned = Math.max(2048, Math.floor(used * 0.97));
    if (this.o.model.contextWindow <= 0 || learned < this.o.model.contextWindow) {
      this.o.model.contextWindow = learned;
    }
  }

  /**
   * Guarantee the next request fits. If the context is at/over the compaction threshold the turn is
   * held, the older conversation is summarised (transactionally), and only then does it continue.
   * If that is impossible the turn is paused instead: nothing is sent and nothing is changed.
   */
  async ensureRoom(signal: AbortSignal, opts: EnsureOptions = {}): Promise<{ compacted: boolean }> {
    const { window, target, hard } = this.limits();
    if (window <= 0 || this.compacting) return { compacted: false };
    const incoming = opts.incoming ?? 0;
    let used = this.promptTokens() + incoming;
    // Replies are kept below the line (see callModel), so compact once too little room is left under it for one.
    const line = target - usefulReply(window);
    if (!opts.force && used < line) return { compacted: false };

    const pct = (t: number) => Math.round((t / window) * 100);
    const before = used;
    this.compacting = true;
    this.emit({
      type: 'compaction',
      phase: 'start',
      pct: pct(used),
      usedTokens: used,
      windowTokens: window,
      ...(incoming ? { incoming } : {}),
    });
    let compacted = false;
    let failure: string | undefined;
    try {
      const k = this.o.config.compaction.keepRecent;
      for (const keep of [...new Set([k, Math.ceil(k / 2), 2, 1])]) {
        let res: CompactResult | undefined;
        try {
          res = await this.compactOnce(keep, signal, opts.instructions);
        } catch (e) {
          if (signal.aborted) throw e;
          failure = friendly(e);
          break;
        }
        if (!res) continue; // nothing cuttable (or nothing gained) at this depth: try keeping less
        compacted = true;
        failure = undefined;
        this.reported = undefined;
        this.emit({ type: 'compacted', droppedMessages: res.droppedMessages });
        used = this.promptTokens() + incoming;
        if (used < line) break;
      }
    } finally {
      this.compacting = false;
      this.emit({
        type: 'compaction',
        phase: 'end',
        ok: compacted,
        beforePct: pct(before),
        afterPct: pct(used),
      });
    }

    if (opts.manual) {
      if (failure) this.emit({ type: 'error', message: `Compaction failed: ${failure}` });
      return { compacted };
    }
    const stuck = failure
      ? `Auto-compaction failed (${failure}).`
      : used >= hard
        ? `The context is ${pct(used)}% full and could not be reduced safely.`
        : undefined;
    if (stuck && opts.quiet) {
      this.emit({ type: 'status', text: `${stuck} It will be retried before the next message.` });
    } else if (stuck) {
      throw new PauseTurn(
        `${stuck} The chat is paused and the conversation is intact — nothing was lost or sent. ` +
          `Fix the cause (or switch to a larger-context model with /model) and send a message to continue.`,
      );
    } else if (used >= target && !opts.force) {
      this.emit({ type: 'status', text: `Context is still ${pct(used)}% full after compaction.` });
    }
    if (compacted) this.emitContext();
    return { compacted };
  }

  /** One compaction attempt at a given depth, retrying transient provider failures. */
  private async compactOnce(
    keep: number,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<CompactResult | undefined> {
    const small = this.o.smallModel ?? this.o.model;
    const delays = this.o.retryDelaysMs ?? [1000, 3000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await compact({
          session: this.o.session,
          provider: small.provider,
          model: small.model,
          window: small.contextWindow > 0 ? small.contextWindow : 8192,
          keepRecent: keep,
          signal,
          ...(instructions ? { instructions } : {}),
          // The summary replaces the todo_write calls that held the list, so carry the list itself over.
          ...(this.todos.length
            ? {
                appendix: `Task list when this summary was written (keep it current with todo_write):\n${formatTodos(this.todos)}`,
              }
            : {}),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof CompactionError && !e.retryable) return undefined;
        if (attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  /** Manual /compact. Returns false when there was nothing to do or it could not be done. */
  async compactNow(signal?: AbortSignal, instructions?: string): Promise<boolean> {
    if (this.running || this.compacting) {
      this.emit({ type: 'status', text: 'Finish or interrupt the current turn before compacting.' });
      return false;
    }
    const ctrl = new AbortController();
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    this.controller = ctrl;
    try {
      this.repairSession();
      return (await this.ensureRoom(ctrl.signal, { force: true, manual: true, instructions })).compacted;
    } finally {
      this.controller = undefined;
    }
  }

  private async callModel(signal: AbortSignal) {
    const m = this.o.model;
    const { window, target } = this.limits();
    const used = this.promptTokens();
    // As much output as the window holds on top of the prompt (less a margin for estimation error), unless the
    // config or the provider's own ceiling asks for less. With no known window, the server decides.
    let room = window > 0 ? window - used - Math.max(256, Math.floor(window * 0.01)) : Infinity;
    if (this.roomOverride !== undefined) {
      room = Math.min(room, this.roomOverride - 64);
      this.roomOverride = undefined;
    }
    // Keep the reply below the compaction line too, so the context never passes it: a reply that reaches it is
    // continued after compacting (see loop). If compaction could not make enough room, the window's room is used.
    const toLine = window > 0 ? target - used : Infinity;
    const byLine = toLine >= usefulReply(window) && toLine < room;
    if (byLine) room = toLine;
    const want = Math.min(this.o.config.maxTokens || Infinity, m.maxOutput ?? Infinity, room);
    const maxTokens = Number.isFinite(want) ? Math.max(MIN_REPLY_TOKENS, want) : undefined;
    this.lastMaxTokens = maxTokens;
    this.cappedAtLine = byLine && want === room;
    const stream = m.provider.stream({
      model: m.model,
      system: this.o.system(),
      messages: this.view(),
      tools: this.o.tools.specs(),
      ...(maxTokens ? { maxTokens } : {}),
      ...(this.o.config.thinkingBudget ? { thinkingBudget: this.o.config.thinkingBudget } : {}),
      signal,
    });
    const speed = new SpeedMeter((tps) => this.emit({ type: 'speed', tokensPerSecond: tps }));
    const r = await assemble(speed.watch(stream), {
      onText: (delta) => this.emit({ type: 'text', delta }),
      onThinking: (delta) => this.emit({ type: 'thinking', delta }),
    });
    this.totalUsage.inputTokens += r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0);
    this.totalUsage.outputTokens += r.usage.outputTokens;
    this.contextTokens =
      r.usage.inputTokens +
      (r.usage.cacheReadTokens ?? 0) +
      (r.usage.cacheWriteTokens ?? 0) +
      r.usage.outputTokens;
    const tokensPerSecond = speed.final(r.usage.outputTokens);
    this.emit({
      type: 'usage',
      usage: r.usage,
      total: { ...this.totalUsage },
      contextTokens: this.contextTokens,
      ...(tokensPerSecond ? { tokensPerSecond } : {}),
    });
    return r;
  }

  // ---- tool execution ---------------------------------------------------------------------------

  private toolContext(signal: AbortSignal, id: string): ToolContext {
    const s = this.o.services ?? {};
    return {
      cwd: this.o.cwd,
      signal,
      sandbox: this.o.sandbox,
      config: this.o.config,
      agentId: this.id,
      readState: this.readState,
      progress: (text) => this.emit({ type: 'tool_progress', id, text }),
      ...(s.ask ? { ask: s.ask } : {}),
      setTodos: (todos) => {
        this.todos = todos;
        s.setTodos?.(todos);
      },
      ...(s.browser ? { browser: s.browser } : {}),
      ...(s.swarm ? { swarm: s.swarm } : {}),
      ...(s.skills ? { skills: s.skills } : {}),
    };
  }

  private async runTools(
    calls: Extract<ContentBlock, { type: 'tool_use' }>[],
    bad: Map<string, string>,
    signal: AbortSignal,
  ): Promise<ContentBlock[]> {
    interface Prepared {
      call: (typeof calls)[number];
      tool?: AnyTool;
      input?: Record<string, unknown>;
      early?: ToolResult;
    }
    const prepared: Prepared[] = [];

    // Pass 1: validate, apply hooks, decide, and gather approvals one at a time.
    for (const call of calls) {
      const p: Prepared = { call };
      prepared.push(p);
      if (signal.aborted) {
        p.early = { content: 'Interrupted by user before this tool ran.', isError: true };
        continue;
      }
      if (bad.has(call.id)) {
        p.early = {
          content: `Tool call arguments were not valid JSON (possibly truncated by the output limit): ${truncateMiddle(bad.get(call.id)!, 300)}`,
          isError: true,
        };
        continue;
      }
      const parsed = this.o.tools.parse(call.name, call.input);
      if (!parsed.ok) {
        p.early = { content: parsed.error, isError: true };
        continue;
      }
      let input = parsed.input as Record<string, unknown>;
      const tool = this.o.tools.get(call.name)!;
      const hook = await this.o.hooks?.beforeTool?.({ agentId: this.id, name: call.name, input });
      if (hook?.block) {
        p.early = { content: `Blocked by extension: ${hook.block}`, isError: true };
        this.emit({ type: 'tool_denied', id: call.id, name: call.name, reason: hook.block });
        continue;
      }
      if (hook?.input) input = hook.input;
      p.tool = tool;
      p.input = input;
      const description = safeDescribe(tool, input);
      this.emit({ type: 'tool_start', id: call.id, name: call.name, description, input });

      const decision = this.o.policy.decide(tool, input);
      if (decision.action === 'deny') {
        p.early = { content: `Denied: ${decision.reason}`, isError: true };
        this.emit({ type: 'tool_denied', id: call.id, name: call.name, reason: decision.reason });
      } else if (decision.action === 'ask') {
        let preview: string | undefined;
        try {
          preview = await tool.preview?.(input as never, this.toolContext(signal, call.id));
        } catch (e) {
          preview = `(preview unavailable: ${(e as Error).message})`;
        }
        const key = grantKey(tool, input);
        const resp = await this.o.approver(
          {
            agentId: this.id,
            toolName: call.name,
            description,
            reason: decision.reason,
            risk: tool.risk,
            ...(preview ? { preview } : {}),
            grantLabel: describeGrant(key),
          },
          signal,
        );
        if (!resp.allow) {
          const why = resp.feedback
            ? `The user denied this action: ${resp.feedback}`
            : 'The user denied this action.';
          p.early = { content: why, isError: true };
          this.emit({
            type: 'tool_denied',
            id: call.id,
            name: call.name,
            reason: resp.feedback ?? 'denied by user',
          });
        } else if (resp.always) this.o.policy.grant(tool, input);
      }
    }

    // Pass 2: execute, running consecutive parallel-safe tools together.
    const results = new Map<string, ToolResult>();
    const exec = async (p: Prepared) => {
      if (p.early) {
        results.set(p.call.id, p.early);
        return;
      }
      let result = await this.o.tools.run(p.call.name, p.input, this.toolContext(signal, p.call.id));
      const after = await this.o.hooks?.afterTool?.({
        agentId: this.id,
        name: p.call.name,
        input: p.input!,
        result,
      });
      if (after) result = after;
      result = { ...result, content: truncateMiddle(redact(result.content), this.toolOutputCap()) };
      results.set(p.call.id, result);
      this.emit({ type: 'tool_end', id: p.call.id, name: p.call.name, result });
    };
    for (let i = 0; i < prepared.length;) {
      const p = prepared[i]!;
      if (p.tool?.parallel && !p.early) {
        const batch = [p];
        while (prepared[i + batch.length]?.tool?.parallel && !prepared[i + batch.length]!.early)
          batch.push(prepared[i + batch.length]!);
        await Promise.all(batch.map(exec));
        i += batch.length;
      } else {
        await exec(p);
        i++;
      }
      if (p.early) this.emit({ type: 'tool_end', id: p.call.id, name: p.call.name, result: p.early });
    }

    // Many parallel calls must not add up to more than a slice of the window either.
    const batchCap = this.toolOutputCap() * 3;
    const contents = calls.map((c) => (results.get(c.id) ?? { content: 'No result.' }).content);
    const total = contents.reduce((n, c) => n + c.length, 0);
    const share = total > batchCap ? batchCap / total : 1;

    return calls.map((c, idx): ContentBlock => {
      const r = results.get(c.id) ?? { content: 'No result.', isError: true };
      return {
        type: 'tool_result',
        toolUseId: c.id,
        content:
          share < 1
            ? truncateMiddle(contents[idx]!, Math.max(500, Math.floor(contents[idx]!.length * share)))
            : contents[idx]!,
        ...(r.isError ? { isError: true } : {}),
        ...(r.images?.length ? { images: r.images } : {}),
      };
    });
  }

  /** Largest single tool result (characters) that may enter the context: a slice of the window. */
  private toolOutputCap(): number {
    const w = this.o.model.contextWindow;
    return w > 0 ? Math.max(3000, Math.floor(w * 0.08 * 3.5)) : 100_000;
  }
}

/** The same rate as estimateTokens, without building a string. */
const charsToTokens = (chars: number) => Math.ceil(chars / 3.5);

/**
 * Generation speed of one reply, timed from its first output token to its last (so the wait for the prompt to
 * be read is not counted). While it streams, an estimate from the characters so far is reported twice a second;
 * at the end the provider's token count replaces it (or the estimate, when the server reports no usage).
 */
export class SpeedMeter {
  private first = 0;
  private last = 0;
  private chars = 0;
  private reported = 0;
  constructor(
    private onLive: (tokensPerSecond: number) => void,
    private now: () => number = () => performance.now(),
  ) {}

  async *watch(stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
    for await (const e of stream) {
      const n =
        e.type === 'text' || e.type === 'thinking'
          ? e.delta.length
          : e.type === 'tool_call_delta'
            ? e.json.length
            : e.type === 'tool_call_start'
              ? e.name.length
              : 0;
      if (n) this.add(n);
      yield e;
    }
  }

  add(chars: number): void {
    const t = this.now();
    if (!this.first) this.first = t;
    this.last = t;
    this.chars += chars;
    if (t - this.reported >= 500 && t - this.first >= 500) {
      this.reported = t;
      this.onLive(Math.round(charsToTokens(this.chars) / ((t - this.first) / 1000)));
    }
  }

  /** Tokens per second for the whole reply, or undefined when it was too short to time. */
  final(outputTokens: number): number | undefined {
    const seconds = (this.last - this.first) / 1000;
    const tokens = outputTokens > 0 ? outputTokens : charsToTokens(this.chars);
    if (seconds < 0.25 || tokens < 8) return undefined;
    return Math.round(tokens / seconds);
  }
}

function safeDescribe(tool: AnyTool, input: unknown): string {
  try {
    return tool.describe(input as never);
  } catch {
    return tool.name;
  }
}

function friendly(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
