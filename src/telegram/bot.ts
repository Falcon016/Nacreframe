import type { AgentEvent, ApprovalRequest, ApprovalResponse } from '../agent/agent.js';
import { Session, sessionDir } from '../agent/session.js';
import { approvalModeSchema } from '../config/schema.js';
import { projectKey } from '../paths.js';
import type { Runtime } from '../runtime.js';
import type { Question } from '../tools/types.js';
import { parseTokenCount } from '../util/text.js';
import { BIN, NAME } from '../version.js';
import {
  MAX_MESSAGE,
  TelegramError,
  type TelegramApi,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './api.js';
import { escapeHtml, splitMarkdown, toTelegramHtml } from './format.js';

export interface BotOptions {
  api: TelegramApi;
  /** Telegram user ids allowed to talk to the agent. */
  allowedUsers: number[];
  /** Folder the agent works in. */
  cwd: string;
  /** One runtime per chat. */
  createRuntime: (cwd: string) => Promise<Runtime>;
  log?: (line: string) => void;
  /** Long-poll wait in seconds (tests use 0). */
  pollTimeout?: number;
  /** Least time between edits of the progress message, in ms (Telegram rate-limits edits). */
  editEveryMs?: number;
}

const COMMANDS = [
  { command: 'new', description: 'Start a new conversation' },
  { command: 'continue', description: 'Pick up the latest saved conversation' },
  { command: 'stop', description: 'Stop the current task' },
  { command: 'status', description: 'Model, approvals, context and folder' },
  { command: 'mode', description: 'Approvals: ask, edits, auto or plan' },
  { command: 'model', description: 'Show or switch the model' },
  { command: 'compact', description: 'Summarise the older conversation now' },
  { command: 'context', description: 'Show or set the context window (e.g. /context 128k)' },
  { command: 'help', description: 'What this bot can do' },
];

const HELP = [
  `<b>${NAME}</b>: your coding agent, from Telegram.`,
  '',
  'Send a message to give it a task. While it works you can send more to steer it.',
  'When it needs approval you get buttons; reply with text instead to deny and say what to do.',
  '',
  ...COMMANDS.map((c) => `/${c.command}: ${escapeHtml(c.description)}`),
].join('\n');

/**
 * `nexus telegram`: a bot that relays one owner's messages to an agent and its replies back. Only users in
 * `allowedUsers`, only private chats. Each chat gets its own runtime, with approvals and questions as buttons.
 */
export class TelegramBot {
  private chats = new Map<number, ChatSession>();
  private offset = 0;
  private ctrl = new AbortController();
  private strangers = new Set<number>();
  me: TgUser | undefined;

  constructor(private o: BotOptions) {}

  private log(line: string) {
    this.o.log?.(line);
  }

  /** Check the token, clear any webhook and register the command menu. */
  async start(): Promise<TgUser> {
    this.me = await this.o.api.getMe();
    await this.o.api.deleteWebhook().catch(() => undefined);
    await this.o.api.setMyCommands(COMMANDS).catch(() => undefined);
    return this.me;
  }

  /** Poll until `stop()`. Network trouble is retried with a growing pause. */
  async run(): Promise<void> {
    let backoff = 1000;
    while (!this.ctrl.signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await this.o.api.getUpdates(this.offset, this.o.pollTimeout ?? 25, this.ctrl.signal);
        backoff = 1000;
      } catch (e) {
        if (this.ctrl.signal.aborted) break;
        if (e instanceof TelegramError && e.status === 401) {
          this.log('Telegram rejected the bot token. Run `nexus setup` to enter a new one.');
          throw e;
        }
        if (e instanceof TelegramError && e.status === 409) {
          this.log('Another copy of this bot is already polling Telegram. Stop it first.');
          throw e;
        }
        this.log(`${(e as Error).message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff, this.ctrl.signal);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        await this.handle(u).catch((e: unknown) =>
          this.log(`Could not handle an update: ${(e as Error).message}`),
        );
      }
      if (!updates.length && (this.o.pollTimeout ?? 25) === 0) await sleep(50, this.ctrl.signal);
    }
  }

  async stop(): Promise<void> {
    this.ctrl.abort();
    await Promise.all([...this.chats.values()].map((c) => c.dispose()));
    this.chats.clear();
  }

  private allowed(user: TgUser | undefined, chatType: string | undefined): boolean {
    return !!user && !user.is_bot && chatType === 'private' && this.o.allowedUsers.includes(user.id);
  }

  async handle(u: TgUpdate): Promise<void> {
    const msg = u.message;
    const cb = u.callback_query;
    const from = msg?.from ?? cb?.from;
    const chat = msg?.chat ?? cb?.message?.chat;
    if (!from || !chat) return;
    if (!this.allowed(from, chat.type)) {
      // Groups are ignored outright. A stranger in a private chat learns their id once, so the owner can add
      // them on purpose; nothing else is said or done.
      if (chat.type === 'private' && msg && !this.strangers.has(from.id)) {
        this.strangers.add(from.id);
        this.log(
          `Ignored a message from user ${from.id}${from.username ? ` (@${from.username})` : ''}: not allowed`,
        );
        await this.o.api
          .sendMessage(chat.id, `This bot is private. Your Telegram user id is ${from.id}.`)
          .catch(() => undefined);
      }
      if (cb) await this.o.api.answerCallbackQuery(cb.id).catch(() => undefined);
      return;
    }
    const session = await this.session(chat.id);
    if (cb) return session.onCallback(cb.id, cb.data ?? '');
    if (msg) return session.onMessage(msg);
  }

  private async session(chatId: number): Promise<ChatSession> {
    let s = this.chats.get(chatId);
    if (!s) {
      const runtime = await this.o.createRuntime(this.o.cwd);
      s = new ChatSession(chatId, runtime, this.o);
      this.chats.set(chatId, s);
      this.log(
        `Chat ${chatId} connected (${runtime.modelSpec ?? 'no model'}, ${runtime.policy.mode}, in ${runtime.cwd})`,
      );
    }
    return s;
  }
}

type Pending =
  | {
      kind: 'approval';
      id: number;
      messageId?: number;
      req: ApprovalRequest;
      resolve(r: ApprovalResponse): void;
    }
  | { kind: 'question'; id: number; messageId?: number; q: Question; resolve(a: string): void };

/** One chat: its runtime, the progress message for the current task, and anything waiting for an answer. */
class ChatSession {
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private pending: Pending | undefined;
  private typing: NodeJS.Timeout | undefined;
  private activity: { messageId?: number; lines: string[]; tools: Map<string, number>; dirty: boolean } = {
    lines: [],
    tools: new Map(),
    dirty: false,
  };
  private editTimer: NodeJS.Timeout | undefined;
  private lastEdit = 0;
  private steps = 0;
  private speed: number | undefined;
  private unsub: () => void;

  constructor(
    private chatId: number,
    private rt: Runtime,
    private o: BotOptions,
  ) {
    this.unsub = rt.agent.events.on('event', (e) => this.onEvent(e));
    rt.broker.approvalHandler = (req, signal) => this.askApproval(req, signal);
    rt.broker.questionHandler = (_agent, q) => this.askQuestion(q);
  }

  async dispose(): Promise<void> {
    this.stopTyping();
    clearTimeout(this.editTimer);
    this.unsub();
    await this.rt.dispose();
  }

  /** Telegram calls for this chat run one at a time, so messages arrive in order. */
  private send<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(fn).catch((e: unknown) => {
      this.o.log?.(`Telegram: ${(e as Error).message}`);
      return undefined;
    });
    this.queue = next;
    return next;
  }

  private say(html: string, opts: { silent?: boolean } = {}) {
    return this.send(() => this.o.api.sendMessage(this.chatId, html, { html: true, ...opts }));
  }

  /** A model reply: Markdown converted to Telegram HTML, split to fit; plain text if Telegram refuses the HTML. */
  private reply(md: string) {
    for (const part of splitMarkdown(md)) {
      void this.send(async () => {
        try {
          return await this.o.api.sendMessage(this.chatId, toTelegramHtml(part), { html: true });
        } catch (e) {
          if (e instanceof TelegramError && e.status === 400)
            return this.o.api.sendMessage(this.chatId, part.slice(0, MAX_MESSAGE));
          throw e;
        }
      });
    }
  }

  // ---- incoming --------------------------------------------------------------------------------------

  async onMessage(m: TgMessage): Promise<void> {
    const text = (m.text ?? '').trim();
    if (!text) {
      await this.say('Only text messages for now.');
      return;
    }
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) return this.command(cmd[1]!.toLowerCase(), (cmd[2] ?? '').trim());

    const p = this.pending;
    if (p?.kind === 'question') {
      this.settle(p, `Answered: ${text}`);
      p.resolve(text);
      return;
    }
    if (p?.kind === 'approval') {
      this.settle(p, `Denied: ${text}`);
      p.resolve({ allow: false, feedback: text });
      return;
    }
    const agent = this.rt.agent;
    if (agent.isRunning || agent.isCompacting) {
      agent.steer(text);
      await this.say('Added to the current task.', { silent: true });
      return;
    }
    void agent.run(text);
  }

  async onCallback(id: string, data: string): Promise<void> {
    const m = /^(ap|q):(\d+):(\w+)$/.exec(data);
    const p = this.pending;
    if (!m || !p || String(p.id) !== m[2]) {
      await this.o.api
        .answerCallbackQuery(id, 'That is no longer waiting for an answer.')
        .catch(() => undefined);
      return;
    }
    await this.o.api.answerCallbackQuery(id).catch(() => undefined);
    if (p.kind === 'approval' && m[1] === 'ap') {
      const choice = m[3];
      this.settle(
        p,
        choice === 'y' ? 'Allowed' : choice === 'a' ? `Always allowed: ${p.req.grantLabel}` : 'Denied',
      );
      p.resolve(
        choice === 'y' ? { allow: true } : choice === 'a' ? { allow: true, always: true } : { allow: false },
      );
    } else if (p.kind === 'question' && m[1] === 'q') {
      const answer = p.q.options?.[Number(m[3])];
      if (answer === undefined) return;
      this.settle(p, `Answered: ${answer}`);
      p.resolve(answer);
    }
  }

  private async command(name: string, arg: string): Promise<void> {
    const rt = this.rt;
    const agent = rt.agent;
    switch (name) {
      case 'start':
      case 'help':
        await this.say(HELP);
        return;
      case 'stop':
        if (!agent.isRunning) return void (await this.say('Nothing is running.'));
        agent.abort();
        return;
      case 'new':
        if (agent.isRunning) return void (await this.say('Stop the current task first (/stop).'));
        rt.newSession();
        await this.say('Started a new conversation.');
        return;
      case 'continue': {
        if (agent.isRunning) return void (await this.say('Stop the current task first (/stop).'));
        const current = agent.session.filePath;
        const latest = Session.list(sessionDir(rt.loaded.paths.data, projectKey(rt.cwd))).find(
          (s) => s.file !== current,
        );
        if (!latest) return void (await this.say('There is no earlier conversation in this folder.'));
        agent.setSession(Session.load(latest.file));
        await this.say(`Picked up: <i>${escapeHtml(latest.preview.slice(0, 200))}</i>`);
        return;
      }
      case 'status': {
        const win = agent.model.contextWindow;
        const pct = win > 0 ? `${Math.round((agent.contextTokens / win) * 100)}%` : 'unknown';
        await this.say(
          [
            `<b>Model</b> ${escapeHtml(rt.modelSpec ?? 'none: pick one with /model')}`,
            `<b>Approvals</b> ${rt.policy.mode}`,
            `<b>Sandbox</b> ${escapeHtml(rt.sandbox.mode)}`,
            `<b>Context</b> ${pct}${this.speed ? ` · last reply ${this.speed} tok/s` : ''}`,
            `<b>Folder</b> <code>${escapeHtml(rt.cwd)}</code>`,
            agent.isRunning ? '<i>Working on a task.</i>' : '<i>Idle.</i>',
          ].join('\n'),
        );
        return;
      }
      case 'mode': {
        const parsed = approvalModeSchema.safeParse(arg.toLowerCase());
        if (!parsed.success)
          return void (await this.say(
            `Approvals are <b>${rt.policy.mode}</b>. Use /mode ask, /mode edits, /mode auto or /mode plan.`,
          ));
        rt.setApprovalMode(parsed.data);
        await this.say(`Approvals set to <b>${parsed.data}</b> for this chat.`);
        return;
      }
      case 'model': {
        if (!arg)
          return void (await this.say(
            `Using <b>${escapeHtml(rt.modelSpec ?? 'no model')}</b>. Switch with /model provider/model (for example /model ollama/qwen3:8b). <code>${BIN} models</code> lists them.`,
          ));
        if (agent.isRunning) return void (await this.say('Stop the current task first (/stop).'));
        try {
          await rt.setModel(arg);
          await this.say(`Switched to <b>${escapeHtml(arg)}</b>.`);
        } catch (e) {
          await this.say(`Could not switch: ${escapeHtml((e as Error).message)}`);
        }
        return;
      }
      case 'context': {
        const a = arg.toLowerCase();
        if (a) {
          const tokens = a === 'auto' ? undefined : parseTokenCount(a);
          if (
            (a !== 'auto' && tokens === undefined) ||
            (tokens !== undefined && (tokens < 1024 || tokens > 10_000_000))
          )
            return void (await this.say('Use /context 131072, /context 128k, or /context auto.'));
          try {
            await rt.setContextWindow(tokens);
          } catch (e) {
            return void (await this.say(escapeHtml((e as Error).message)));
          }
        }
        const m = agent.model;
        const from =
          m.contextSource === 'config'
            ? 'set by you'
            : m.contextSource === 'detected'
              ? 'from the server'
              : 'assumed';
        await this.say(
          `<b>Context window</b> ${m.contextWindow.toLocaleString('en-US')} tokens (${from}). ` +
            (m.contextSource === 'config'
              ? '/context auto goes back to the server.'
              : 'Set it with /context 128k.'),
        );
        return;
      }
      case 'compact':
        if (agent.isRunning) return void (await this.say('Stop the current task first (/stop).'));
        await this.say((await agent.compactNow()) ? 'Compacted.' : 'Nothing to compact yet.');
        return;
      default:
        await this.say(`Unknown command /${escapeHtml(name)}. /help lists them.`);
    }
  }

  // ---- approvals and questions ---------------------------------------------------------------------

  private askApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const p: Pending = { kind: 'approval', id, req, resolve };
      this.pending = p;
      signal.addEventListener('abort', () => {
        if (this.pending === p) this.settle(p, 'No longer needed');
        resolve({ allow: false });
      });
      const preview = req.preview ? `\n<pre>${escapeHtml(truncate(req.preview, 2500))}</pre>` : '';
      const text =
        `<b>Approve?</b> ${escapeHtml(req.description)}\n<i>${escapeHtml(req.reason)}</i>${preview}\n\n` +
        `"Always" allows: ${escapeHtml(req.grantLabel)}. Or reply with text to deny and say what to do instead.`;
      void this.send(async () => {
        const sent = await this.o.api.sendMessage(this.chatId, truncate(text, MAX_MESSAGE), {
          html: true,
          keyboard: [
            [
              { text: 'Allow', callback_data: `ap:${id}:y` },
              { text: 'Always', callback_data: `ap:${id}:a` },
              { text: 'Deny', callback_data: `ap:${id}:n` },
            ],
          ],
        });
        p.messageId = sent.message_id;
      });
    });
  }

  private askQuestion(q: Question): Promise<string> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const p: Pending = { kind: 'question', id, q, resolve };
      this.pending = p;
      const keyboard = (q.options ?? []).map((o, i) => [
        { text: o.slice(0, 60), callback_data: `q:${id}:${i}` },
      ]);
      void this.send(async () => {
        const sent = await this.o.api.sendMessage(
          this.chatId,
          `<b>Question</b>\n${escapeHtml(q.question)}${keyboard.length ? '\n\nPick one, or reply with your own answer.' : ''}`,
          { html: true, ...(keyboard.length ? { keyboard } : {}) },
        );
        p.messageId = sent.message_id;
      });
    });
  }

  /** Close an approval or question: record the outcome on its message and remove the buttons. */
  private settle(p: Pending, outcome: string) {
    if (this.pending === p) this.pending = undefined;
    const subject = p.kind === 'approval' ? p.req.description : p.q.question;
    void this.send(async () => {
      if (p.messageId === undefined) return;
      await this.o.api.editMessageText(
        this.chatId,
        p.messageId,
        `${escapeHtml(truncate(subject, 300))}\n<b>${escapeHtml(truncate(outcome, 300))}</b>`,
        { html: true },
      );
    });
  }

  // ---- agent events ----------------------------------------------------------------------------------

  private onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'turn_start':
        this.steps = 0;
        this.activity = { lines: [], tools: new Map(), dirty: false };
        this.startTyping();
        break;
      case 'assistant': {
        const text = e.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        if (text) this.reply(text);
        break;
      }
      case 'tool_start':
        this.steps++;
        this.activity.tools.set(e.id, this.activity.lines.length);
        this.addLine(`▸ ${e.description}`);
        break;
      case 'tool_end': {
        const i = this.activity.tools.get(e.id);
        if (i !== undefined && e.result.isError) {
          this.activity.lines[i] = this.activity.lines[i]!.replace(/^▸/, '✗');
          this.activity.dirty = true;
          this.scheduleEdit();
        }
        break;
      }
      case 'compaction':
        if (e.phase === 'start') this.addLine('Compacting the context…');
        else if (e.ok) this.addLine(`Context compacted: ${e.beforePct}% → ${e.afterPct}%`);
        break;
      case 'usage':
        if (e.tokensPerSecond) this.speed = e.tokensPerSecond;
        break;
      case 'error':
        void this.say(`⚠️ ${escapeHtml(e.message)}`);
        break;
      case 'paused':
        void this.say(`⏸ ${escapeHtml(e.reason)}`);
        break;
      case 'turn_end':
        this.stopTyping();
        this.finishActivity(e.stopReason);
        if (e.stopReason === 'aborted') void this.say('Stopped.');
        else if (e.stopReason === 'max_tokens')
          void this.say('The reply hit the output limit and was cut off.');
        else if (e.stopReason === 'max_iterations')
          void this.say('Stopped at the tool-call limit for one turn. Send a message to continue.');
        break;
    }
  }

  private startTyping() {
    this.stopTyping();
    const tick = () => void this.o.api.sendChatAction(this.chatId, 'typing').catch(() => undefined);
    tick();
    this.typing = setInterval(tick, 4500);
  }

  private stopTyping() {
    if (this.typing) clearInterval(this.typing);
    this.typing = undefined;
  }

  /** One progress message per task, edited as tools run (at most every `editEveryMs`). */
  private addLine(line: string) {
    this.activity.lines.push(line);
    this.activity.dirty = true;
    this.scheduleEdit();
  }

  private activityText(header: string): string {
    const lines = this.activity.lines;
    const shown = lines.slice(-12);
    const more = lines.length - shown.length;
    return [
      header,
      ...(more ? [`… ${more} earlier steps`] : []),
      ...shown.map((l) => escapeHtml(truncate(l, 200))),
    ].join('\n');
  }

  private scheduleEdit() {
    if (this.editTimer) return;
    const wait = Math.max(0, (this.o.editEveryMs ?? 2000) - (Date.now() - this.lastEdit));
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      this.flushActivity('<b>Working</b>');
    }, wait);
  }

  private flushActivity(header: string) {
    if (!this.activity.dirty || !this.activity.lines.length) return;
    this.activity.dirty = false;
    this.lastEdit = Date.now();
    const act = this.activity;
    const text = this.activityText(header);
    void this.send(async () => {
      if (act.messageId === undefined) {
        const sent = await this.o.api.sendMessage(this.chatId, text, { html: true, silent: true });
        act.messageId = sent.message_id;
      } else {
        await this.o.api
          .editMessageText(this.chatId, act.messageId, text, { html: true })
          .catch((e: unknown) => {
            if (!(e instanceof TelegramError && /not modified/.test(e.message))) throw e;
          });
      }
    });
  }

  private finishActivity(stop: string) {
    clearTimeout(this.editTimer);
    this.editTimer = undefined;
    if (!this.activity.lines.length) return;
    const win = this.rt.agent.model.contextWindow;
    const stats = [
      `${this.steps} step${this.steps === 1 ? '' : 's'}`,
      ...(this.speed ? [`${this.speed} tok/s`] : []),
      ...(win > 0 ? [`context ${Math.round((this.rt.agent.contextTokens / win) * 100)}%`] : []),
    ].join(' · ');
    this.activity.dirty = true;
    this.flushActivity(`<b>${stop === 'aborted' ? 'Stopped' : 'Done'}</b> · ${stats}`);
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });
