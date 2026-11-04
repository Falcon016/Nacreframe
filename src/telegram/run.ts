import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AuthStore } from '../config/auth.js';
import { loadConfig } from '../config/load.js';
import { Runtime } from '../runtime.js';
import { BIN } from '../version.js';
import { expandHome, maskToken, TelegramApi, TELEGRAM_KEY } from './api.js';
import { TelegramBot } from './bot.js';

const HELP = `Usage: ${BIN} telegram [--cwd <folder>]

Runs your Telegram bot: messages from the users allowed in your config go to an agent working in the
folder, and its replies, approvals and questions come back to Telegram. Set it up with \`${BIN} setup\`.

  --cwd <folder>   Folder the agent works in (default: telegram.cwd in your config, else this folder)

The bot token comes from $NEXUS_TELEGRAM_TOKEN or the one \`${BIN} setup\` stored. Stop with Ctrl+C.`;

export async function telegramCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { cwd: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const loaded = loadConfig({ cwd: process.cwd(), env });
  const token = env.NEXUS_TELEGRAM_TOKEN || new AuthStore(loaded.paths).get(TELEGRAM_KEY);
  if (!token) {
    console.error(
      `No Telegram bot token yet. Run \`${BIN} setup\` to connect one (or set NEXUS_TELEGRAM_TOKEN).`,
    );
    return 1;
  }
  const allowed = loaded.config.telegram.allowedUsers;
  if (!allowed.length) {
    console.error(
      `Nobody is allowed to use the bot yet. Run \`${BIN} setup\` to add your Telegram account, or put your user id in telegram.allowedUsers in ${loaded.userConfigPath}.`,
    );
    return 1;
  }
  const cwd = resolve(expandHome(values.cwd ?? loaded.config.telegram.cwd ?? process.cwd()));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    console.error(`The bot's folder ${cwd} does not exist.`);
    return 1;
  }

  let api: TelegramApi;
  try {
    api = new TelegramApi(token);
  } catch (e) {
    console.error(`${(e as Error).message} Run \`${BIN} setup\` to enter it again.`);
    return 1;
  }
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
  const bot = new TelegramBot({
    api,
    allowedUsers: allowed,
    cwd,
    log,
    createRuntime: (dir) => Runtime.create({ cwd: dir, env, overrides: { browser: { headless: true } } }),
  });
  let me;
  try {
    me = await bot.start();
  } catch (e) {
    console.error(`Could not start the bot (${maskToken(token)}): ${(e as Error).message}`);
    return 1;
  }
  log(`@${me.username ?? me.first_name} is running. Working in ${cwd}.`);
  log(`Allowed Telegram users: ${allowed.join(', ')}. Ctrl+C stops it.`);
  for (const w of loaded.warnings) log(w);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('Stopping…');
    void bot.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await bot.run();
    return 0;
  } catch {
    return 1;
  } finally {
    await bot.stop();
  }
}
