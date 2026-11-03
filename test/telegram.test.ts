import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, trustProject } from '../src/config/load.js';
import { appPaths } from '../src/paths.js';
import { Runtime } from '../src/runtime.js';
import type { TelegramError } from '../src/telegram/api.js';
import { TelegramApi, type TgUpdate } from '../src/telegram/api.js';
import { TelegramBot } from '../src/telegram/bot.js';
import { splitMarkdown, toTelegramHtml } from '../src/telegram/format.js';
import { redact } from '../src/util/redact.js';
import { tmpWorkspace } from './helpers.js';
import { startMockLlm } from './mock-llm.js';

vi.setConfig({ testTimeout: 30_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

const TOKEN = '123456789:AAtest-token-for-the-bot-000000000000';
const OWNER = 4242;

/** Records every Bot API call; answers like Telegram would. */
class FakeTelegram {
  calls: { method: string; body: Record<string, unknown> }[] = [];
  queue: TgUpdate[] = [];
  private nextId = 100;
  fail: Record<string, { status: number; description: string; retry_after?: number } | undefined> = {};
  fetchImpl: typeof fetch = async (input, init) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(input))!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method: m[2]!, body });
    const f = this.fail[m[2]!];
    if (f) {
      this.fail[m[2]!] = undefined;
      return Response.json(
        {
          ok: false,
          description: f.description,
          ...(f.retry_after !== undefined ? { parameters: { retry_after: f.retry_after } } : {}),
        },
        { status: f.status },
      );
    }
    if (m[2] === 'getMe')
      return Response.json({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'Nacre', username: 'nacre_bot' },
      });
    if (m[2] === 'getUpdates') {
      const offset = Number(body.offset ?? 0);
      return Response.json({ ok: true, result: this.queue.filter((u) => u.update_id >= offset) });
    }
    if (m[2] === 'sendMessage')
      return Response.json({
        ok: true,
        result: { message_id: this.nextId++, date: 0, chat: { id: body.chat_id, type: 'private' } },
      });
    return Response.json({ ok: true, result: true });
  };
  sent() {
    return this.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
  }
  edits() {
    return this.calls.filter((c) => c.method === 'editMessageText').map((c) => String(c.body.text));
  }
}

let mock: Awaited<ReturnType<typeof startMockLlm>>;
beforeAll(async () => (mock = await startMockLlm()));
afterAll(() => mock.server.close());

let ws: ReturnType<typeof tmpWorkspace>;
let work: string;
let tg: FakeTelegram;
let bot: TelegramBot;
let runtimes: Runtime[];
beforeEach(() => {
  ws = tmpWorkspace();
  const home = join(ws.dir, '.home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({
      model: 'mock/m',
      approval: { mode: 'ask' },
      browser: { enabled: false },
      providers: { mock: { type: 'openai', baseUrl: mock.url } },
    }),
  );
  work = join(ws.dir, 'work');
  mkdirSync(work);
  tg = new FakeTelegram();
  runtimes = [];
  bot = new TelegramBot({
    api: new TelegramApi(TOKEN, { fetchImpl: tg.fetchImpl }),
    allowedUsers: [OWNER],
    cwd: work,
    pollTimeout: 0,
    editEveryMs: 10,
    createRuntime: async (cwd) => {
      const rt = await Runtime.create({ cwd, env: { ...process.env, NACRE_HOME: home }, ephemeral: true });
      runtimes.push(rt);
      return rt;
    },
  });
});
afterEach(async () => {
  await bot.stop();
  ws.cleanup();
});

let uid = 1;
const text = (t: string, from = OWNER, type: 'private' | 'group' = 'private'): TgUpdate => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: 0,
    text: t,
    from: { id: from, first_name: 'F' },
    chat: { id: from, type },
  },
});
const press = (data: string, from = OWNER): TgUpdate => ({
  update_id: uid++,
  callback_query: {
    id: `cb${uid}`,
    from: { id: from, first_name: 'F' },
    data,
    message: { message_id: 1, date: 0, chat: { id: from, type: 'private' } },
  },
});
const idle = async () => {
  await until(() => runtimes.length > 0 && !runtimes[0]!.agent.isRunning);
  await sleep(60); // let the chat's send queue drain
};

describe('telegram bot', () => {
  it('answers only allowed users in private chats, and tells a stranger their id once', async () => {
    await bot.handle(text('hello', 999));
    await bot.handle(text('hello again', 999));
    await bot.handle(text('hello', OWNER, 'group'));
    expect(tg.sent()).toEqual(['This bot is private. Your Telegram user id is 999.']);
    expect(runtimes).toHaveLength(0); // no agent was ever started for them
  });

  it('runs a task and sends the reply as Telegram HTML', async () => {
    await bot.handle(text('hello there'));
    await idle();
    const reply = tg.sent().find((t) => t.includes('mock'))!;
    expect(reply).toContain('<b>mock</b>');
    expect(reply).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
    expect(tg.calls.some((c) => c.method === 'sendChatAction')).toBe(true);
  });

  it('asks for approval with buttons and acts on the answer', async () => {
    await bot.handle(text('write notes.md'));
    await until(() => tg.sent().some((t) => t.startsWith('<b>Approve?</b>')));
    const ask = tg.calls.find(
      (c) => c.method === 'sendMessage' && String(c.body.text).startsWith('<b>Approve?</b>'),
    )!;
    const buttons = (
      ask.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard[0]!;
    expect(buttons.map((b) => b.text)).toEqual(['Allow', 'Always', 'Deny']);
    await bot.handle(press(buttons[0]!.callback_data));
    await idle();
    expect(readFileSync(join(work, 'notes.md'), 'utf8')).toContain('hello from the mock');
    expect(tg.edits().some((t) => t.includes('<b>Allowed</b>'))).toBe(true);
    // The progress message ends with a summary of the task.
    expect(tg.edits().some((t) => /^<b>Done<\/b> · 1 step/.test(t))).toBe(true);
    // A stale button does nothing.
    await bot.handle(press(buttons[0]!.callback_data));
    expect(tg.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      body: { text: 'That is no longer waiting for an answer.' },
    });
  });

  it('treats a text reply to an approval as "deny, and do this instead"', async () => {
    await bot.handle(text('write notes.md'));
    await until(() => tg.sent().some((t) => t.startsWith('<b>Approve?</b>')));
    await bot.handle(text('call it README.md instead'));
    await idle();
    expect(existsSync(join(work, 'notes.md'))).toBe(false);
    expect(tg.edits().some((t) => t.includes('Denied: call it README.md instead'))).toBe(true);
    const history = JSON.stringify(runtimes[0]!.agent.session.messages());
    expect(history).toContain('call it README.md instead'); // the agent was told why
  });

  it('handles commands: status, mode, new, unknown', async () => {
    await bot.handle(text('/status'));
    await bot.handle(text('/mode auto'));
    await bot.handle(text('/mode sideways'));
    await bot.handle(text('/new'));
    await bot.handle(text('/nope'));
    await sleep(100);
    const sent = tg.sent();
    expect(sent[0]).toContain('<b>Model</b> mock/m');
    expect(sent[0]).toContain('<b>Approvals</b> ask');
    expect(sent[1]).toContain('Approvals set to <b>auto</b>');
    expect(runtimes[0]!.policy.mode).toBe('auto');
    expect(sent[2]).toContain('Use /mode ask');
    expect(sent[3]).toBe('Started a new conversation.');
    expect(sent[4]).toContain('Unknown command');
  });

  it('polls for updates and moves past each one, so nothing is handled twice', async () => {
    tg.queue.push(text('/status'));
    const running = bot.run();
    await until(() => tg.sent().length > 0);
    await sleep(150);
    await bot.stop();
    await running;
    expect(tg.sent().filter((t) => t.includes('<b>Model</b>'))).toHaveLength(1);
    const offsets = tg.calls.filter((c) => c.method === 'getUpdates').map((c) => Number(c.body.offset));
    expect(offsets.at(-1)).toBe(tg.queue[0]!.update_id + 1);
  });

  it('starts by checking the token, clearing any webhook and registering the command menu', async () => {
    const me = await bot.start();
    expect(me.username).toBe('nacre_bot');
    expect(tg.calls.map((c) => c.method)).toEqual(['getMe', 'deleteWebhook', 'setMyCommands']);
  });
});

describe('telegram api', () => {
  it('never puts the token in an error, and waits out flood control', async () => {
    const tg2 = new FakeTelegram();
    const api = new TelegramApi(TOKEN, { fetchImpl: tg2.fetchImpl });
    tg2.fail.sendMessage = { status: 429, description: 'Too Many Requests', retry_after: 0 };
    await api.sendMessage(1, 'hi'); // retried after the wait
    expect(tg2.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);

    const down = new TelegramApi(TOKEN, {
      fetchImpl: async () => {
        throw Object.assign(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`), {
          cause: { code: 'ENOTFOUND' },
        });
      },
    });
    const err = (await down.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err.message).toBe('Could not reach Telegram (ENOTFOUND)');
    expect(() => new TelegramApi('not-a-token')).toThrow(/bot token/);
    expect(redact(`token is ${TOKEN}`)).not.toContain('AAtest');
  });

  it('only takes Telegram settings from the user config, never a project', () => {
    const home = join(ws.dir, '.home2');
    const proj = join(ws.dir, 'cloned');
    mkdirSync(join(proj, '.nacreframe'), { recursive: true });
    writeFileSync(
      join(proj, '.nacreframe', 'config.json'),
      JSON.stringify({ telegram: { allowedUsers: [666] } }),
    );
    const env = { NACRE_HOME: home };
    const paths = appPaths(env);
    const untrusted = loadConfig({ cwd: proj, env, paths });
    expect(untrusted.config.telegram.allowedUsers).toEqual([]);
    expect(untrusted.warnings.join()).toContain('telegram');
    // Even a project you trust cannot decide who may command the agent.
    trustProject(paths, proj);
    const trusted = loadConfig({ cwd: proj, env, paths });
    expect(trusted.config.telegram.allowedUsers).toEqual([]);
    expect(trusted.warnings.join()).toContain('only read from your user config');
  });
});

describe('telegram formatting', () => {
  it('converts Markdown to the HTML Telegram accepts, escaping everything else', () => {
    expect(toTelegramHtml('# Title\n**bold** and *it* and `a<b>` & [docs](https://x.dev/?a=1&b=2)')).toBe(
      '<b>Title</b>\n<b>bold</b> and <i>it</i> and <code>a&lt;b&gt;</code> &amp; <a href="https://x.dev/?a=1&amp;b=2">docs</a>',
    );
    expect(toTelegramHtml('- one\n> quoted\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      '• one\n<blockquote>quoted</blockquote>\n<pre>| a | b |\n| 1 | 2 |</pre>',
    );
    expect(toTelegramHtml('snake_case_name stays')).toBe('snake_case_name stays');
  });

  it('splits long replies without breaking a code block', () => {
    const md = [
      'Intro',
      '```py',
      ...Array.from({ length: 400 }, (_, i) => `x${i} = ${i}`),
      '```',
      'Outro',
    ].join('\n');
    const parts = splitMarkdown(md, 1000);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0); // every part opens and closes its fences
    }
    expect(parts.join('\n')).toContain('x399 = 399');
    expect(parts.at(-1)).toContain('Outro');
  });
});
