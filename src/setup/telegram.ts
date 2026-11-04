import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config/schema.js';
import { expandHome, TelegramApi, TelegramError, type TgUpdate, type TgUser } from '../telegram/api.js';
import { BIN } from '../version.js';
import type { SetupPlan } from './plan.js';
import type { WizardContext } from './wizard.js';

export type TelegramPlan = NonNullable<SetupPlan['telegram']>;

/** What the review table says about Telegram. */
export function describeTelegram(t: TelegramPlan | undefined, config: Config): string {
  if (!t) return config.telegram.allowedUsers.length ? 'unchanged' : 'not set up';
  if (t.off) return 'turned off';
  return [
    t.botName ? `@${t.botName}` : 'bot',
    `allows ${t.userLabels?.join(', ') ?? t.allowedUsers.join(', ')}`,
    `works in ${t.cwd ?? 'the folder you start it from'}`,
  ].join(' · ');
}

/**
 * Optional last step: connect a Telegram bot. Checks the token with Telegram, then finds the user's id by asking
 * them to message the bot (so nobody has to look an id up), and confirms the account before allowing it.
 */
export async function chooseTelegram(
  ctx: WizardContext,
  config: Config,
  storedToken: string | undefined,
): Promise<TelegramPlan | undefined> {
  const configured = config.telegram.allowedUsers.length > 0 && !!storedToken;
  const pick = await ctx.prompt.select({
    message: 'Use the agent from Telegram too?',
    help: 'A private bot that only answers you: send tasks from your phone, approve actions with buttons.',
    choices: configured
      ? [
          {
            value: 'keep' as const,
            label: 'Keep it as it is',
            hint: `allows ${config.telegram.allowedUsers.join(', ')}`,
          },
          { value: 'setup' as const, label: 'Set it up again' },
          { value: 'off' as const, label: 'Turn it off', hint: 'forget the token and allowed users' },
        ]
      : [
          { value: 'keep' as const, label: 'Not now', hint: `run \`${BIN} setup\` again any time` },
          { value: 'setup' as const, label: 'Set up a Telegram bot' },
        ],
  });
  if (pick === 'keep') return undefined;
  if (pick === 'off') return { off: true, allowedUsers: [] };
  return setupBot(ctx, config);
}

async function setupBot(ctx: WizardContext, config: Config): Promise<TelegramPlan | undefined> {
  const t = ctx.term;
  t.note('In Telegram, open @BotFather and send /newbot. Choose a name, and it replies with a token.');
  let api: TelegramApi;
  let me: TgUser | undefined;
  let token: string;
  for (;;) {
    token = await ctx.prompt.secret({
      message: 'Bot token',
      help: 'It looks like 123456789:AA… and is stored only on this computer.',
      validate: (v) =>
        !v
          ? 'Paste the token BotFather gave you.'
          : !/^\d+:[\w-]{20,}$/.test(v)
            ? 'That does not look like a bot token.'
            : undefined,
    });
    api = new TelegramApi(token, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
    const sp = t.spinner('Checking the token with Telegram…');
    try {
      me = await api.getMe();
      sp.succeed(`Telegram knows this bot`, `@${me.username ?? me.first_name}`);
      break;
    } catch (e) {
      const rejected = e instanceof TelegramError && (e.status === 401 || e.status === 404);
      if (rejected) sp.fail('Telegram rejected that token', 'check you copied all of it');
      else sp.warn('Could not reach Telegram', (e as Error).message);
      const next = await ctx.prompt.select({
        message: 'What now?',
        choices: [
          { value: 'retry' as const, label: 'Enter the token again' },
          ...(rejected
            ? []
            : [
                {
                  value: 'keep' as const,
                  label: 'Keep it anyway',
                  hint: 'you will type your user id yourself',
                },
              ]),
          { value: 'skip' as const, label: 'Skip Telegram for now' },
        ],
      });
      if (next === 'skip') return undefined;
      if (next === 'keep') break;
    }
  }

  const who = me ? await findUser(ctx, api, me) : await typedUser(ctx);
  if (!who) return undefined;

  const cwd = await ctx.prompt.text({
    message: 'Which folder should the bot work in?',
    initial: config.telegram.cwd ?? ctx.cwd,
    help: `Usually a project folder. \`${BIN} telegram --cwd <folder>\` overrides it for one run.`,
    validate: (v) => {
      const p = resolve(expandHome(v));
      return existsSync(p) && statSync(p).isDirectory() ? undefined : `${p} is not a folder.`;
    },
  });
  return {
    token,
    allowedUsers: [who.id],
    userLabels: [who.label],
    cwd: resolve(expandHome(cwd)),
    ...(me?.username ? { botName: me.username } : {}),
  };
}

/** Ask the user to message the bot, and take the sender's id (after they confirm it is them). */
async function findUser(
  ctx: WizardContext,
  api: TelegramApi,
  me: TgUser,
): Promise<{ id: number; label: string } | undefined> {
  const t = ctx.term;
  const waitMs = Number(ctx.env.NEXUS_TELEGRAM_WAIT_MS) || 120_000;
  await api.deleteWebhook().catch(() => undefined);
  for (;;) {
    t.note(
      `Now send any message to @${me.username ?? me.first_name} from your Telegram account (https://t.me/${me.username ?? ''}).`,
    );
    const sp = t.spinner('Waiting for your message…');
    let offset = 0;
    let found: TgUpdate['message'] | undefined;
    const end = Date.now() + waitMs;
    try {
      while (!found && Date.now() < end) {
        const ups = await api.getUpdates(offset, Math.min(10, Math.ceil((end - Date.now()) / 1000)));
        for (const u of ups) {
          offset = u.update_id + 1;
          const m = u.message;
          if (m?.from && !m.from.is_bot && m.chat.type === 'private') found = m;
        }
      }
      // Mark what was read as handled, so the bot does not later take "hi" for a task.
      if (offset) await api.getUpdates(offset, 0).catch(() => undefined);
    } catch (e) {
      sp.warn('Could not read messages from Telegram', (e as Error).message);
    }
    if (found?.from) {
      const u = found.from;
      const label = `${u.username ? `@${u.username}` : (u.first_name ?? 'user')} (id ${u.id})`;
      sp.succeed('Got a message', label);
      const yes = await ctx.prompt.confirm({
        message: `Allow ${label} to use the bot?`,
        help: 'Only accounts you allow get an answer. Everyone else is ignored.',
      });
      if (yes) {
        await api
          .sendMessage(
            found.chat.id,
            `Connected. This bot now answers you, and only you. Start it with \`${BIN} telegram\`.`,
          )
          .catch(() => undefined);
        return { id: u.id, label };
      }
    } else sp.stop();
    const next = await ctx.prompt.select({
      message: found ? 'Not that account. What now?' : 'No message arrived. What now?',
      choices: [
        { value: 'wait' as const, label: 'Wait for a message again' },
        { value: 'type' as const, label: 'Type my user id', hint: '@userinfobot tells you yours' },
        { value: 'skip' as const, label: 'Skip Telegram for now' },
      ],
    });
    if (next === 'skip') return undefined;
    if (next === 'type') return typedUser(ctx);
  }
}

async function typedUser(ctx: WizardContext): Promise<{ id: number; label: string } | undefined> {
  const v = await ctx.prompt.text({
    message: 'Your Telegram user id',
    help: 'A number. In Telegram, message @userinfobot and it replies with yours.',
    validate: (s) => (/^\d{3,15}$/.test(s) ? undefined : 'Enter the number only, e.g. 123456789.'),
  });
  return { id: Number(v), label: `id ${v}` };
}
