#!/usr/bin/env node
// Must stay the first import, and this file must not contain JSX (which adds a React import above it):
// ./env.js decides which React build loads.
import { restoreNodeEnv } from './env.js';
import { createElement } from 'react';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { AuthStore } from './config/auth.js';
import { loadConfig, trustProject } from './config/load.js';
import { approvalModeSchema, sandboxModeSchema } from './config/schema.js';
import { doctor } from './doctor.js';
import { checkForUpdate, pendingRelaunch, relaunch, runUpdate, short } from './update.js';
import { runPrint } from './modes/print.js';
import { runRpc } from './modes/rpc.js';
import { Runtime } from './runtime.js';
import { setupCommand } from './setup/index.js';
import { App } from './tui/App.js';
import { UiStore } from './tui/store.js';
import { pickTheme } from './tui/theme.js';
import { BIN, NAME, VERSION } from './version.js';
import { dirname, resolve } from 'node:path';

const HELP = `${NAME} ${VERSION} — a terminal-native AI agent harness

Usage
  ${BIN} [options] [prompt]        Start the interactive UI (optionally with a first prompt)
  ${BIN} -p "prompt" [options]     Run once and print the answer (reads piped stdin as context)
  ${BIN} models                    List the models your providers offer (with context windows)
  ${BIN} serve [options]           Start the self-hosted web dashboard (\`${BIN} serve --help\`)
  ${BIN} setup                     Guided setup: provider, API key, model, safety and Telegram (\`${BIN} setup --help\`)
  ${BIN} telegram                  Run your Telegram bot, to use the agent from your phone
  ${BIN} auth set <provider>       Store an API key (hidden prompt, or pipe it on stdin)
  ${BIN} auth list | remove <p>    Manage stored keys
  ${BIN} trust                     Trust this project's .nacreframe config, skills and extensions
  ${BIN} update [--check]          Update to the latest version (--check only looks)
  ${BIN} doctor [--fix]            Check your environment; --fix repairs what it can (-y: no questions)

Options
  -m, --model <provider/model>     e.g. anthropic/claude-sonnet-5-5, ollama/qwen3:8b
      --approval <mode>            ask | edits | auto | plan        (default: ask)
      --sandbox <level>            off | guard | container          (default: guard)
  -c, --continue                   Resume the latest session in this folder
  -r, --resume <id>                Resume a specific session
      --no-session                 Do not save this session
      --no-browser                 Disable browser tools
      --mode <text|json|rpc>       Output mode for -p (rpc: JSON lines over stdio)
  -p, --print                      Non-interactive mode
  -v, --version                    Print version
  -h, --help                       Show this help

Environment
  ANTHROPIC_API_KEY, OPENAI_API_KEY   Provider keys (or use \`${BIN} auth set\`)
  NACRE_MODEL, NACRE_APPROVAL, NACRE_SANDBOX, NACRE_HOME, NO_COLOR
`;

/**
 * Read piped stdin. When `firstChunkTimeoutMs` is set (a prompt was already given on the command
 * line) an open-but-silent pipe, as left by CI runners or parent processes, is treated as empty
 * instead of blocking forever.
 */
async function readStdin(firstChunkTimeoutMs?: number): Promise<string> {
  const chunks: Buffer[] = [];
  const it = process.stdin[Symbol.asyncIterator]();
  let first = true;
  for (;;) {
    const next = it.next();
    const r =
      first && firstChunkTimeoutMs
        ? await Promise.race([
            next,
            new Promise<null>((res) => setTimeout(() => res(null), firstChunkTimeoutMs)),
          ])
        : await next;
    if (r === null) {
      process.stdin.destroy();
      break;
    }
    if (r.done) break;
    first = false;
    chunks.push(r.value as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  process.stdout.write(promptText);
  return new Promise((resolveSecret) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolveSecret(buf.trim());
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function noModelMessage(runtime: Runtime): Promise<string> {
  const models = await runtime.listModels();
  const list = models.length
    ? models
        .slice(0, 25)
        .map((m) => `  ${m.spec}${m.contextWindow ? `  (${Math.round(m.contextWindow / 1000)}k ctx)` : ''}`)
        .join('\n')
    : '  (no provider answered — start a local server or run `nacre auth set <provider>`)';
  return `No model selected. Choose one with --model <provider>/<model>, NACRE_MODEL, or "model" in your config.\nNew here? \`${BIN} setup\` walks you through it.\n\nAvailable now:\n${list}`;
}

async function serveCommand(args: string[]): Promise<number> {
  const { serve } = await import('./server/serve.js');
  return serve(args);
}

async function modelsCommand(cwd: string): Promise<number> {
  const runtime = await Runtime.create({ cwd, ephemeral: true, overrides: { browser: { enabled: false } } });
  const models = await runtime.listModels();
  await runtime.dispose();
  if (!models.length) {
    console.log(
      'No provider answered. Start a local server (llama.cpp, Ollama, LM Studio) or run `nacre auth set <provider>`.',
    );
    return 1;
  }
  for (const m of models) {
    console.log(
      `${m.spec.padEnd(64)} ${m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx`.padEnd(14) : ''.padEnd(14)} ${m.loaded ? 'loaded' : ''}`.trimEnd(),
    );
  }
  return 0;
}

async function authCommand(args: string[]): Promise<number> {
  const loaded = loadConfig({ cwd: process.cwd() });
  const store = new AuthStore(loaded.paths);
  const [sub, provider] = args;
  if (sub === 'list') {
    const keys = store.list();
    console.log(
      keys.length
        ? keys.map((k) => `${k}  (stored)`).join('\n')
        : 'No stored keys. Environment variables are used otherwise.',
    );
    return 0;
  }
  if (!provider || !loaded.config.providers[provider]) {
    console.error(
      `Usage: ${BIN} auth set|remove <provider>\nProviders: ${Object.keys(loaded.config.providers).join(', ')}`,
    );
    return 2;
  }
  if (sub === 'remove') {
    console.log(store.remove(provider) ? `Removed key for ${provider}.` : `No stored key for ${provider}.`);
    return 0;
  }
  if (sub === 'set') {
    const key = await readSecret(`API key for ${provider}: `);
    if (!key) {
      console.error('No key entered.');
      return 1;
    }
    store.set(provider, key);
    console.log(`Saved to ${loaded.paths.config} with owner-only permissions.`);
    return 0;
  }
  console.error(`Unknown auth command "${sub ?? ''}".`);
  return 2;
}

function friendlyStartupError(e: Error): string {
  if (/No API key/.test(e.message)) {
    return `${e.message}\n\nNew here? \`${BIN} setup\` walks you through it.\nTo use a local model instead:  ${BIN} -m ollama/<model>   (or lmstudio/<model>)`;
  }
  return e.message;
}

async function main(): Promise<number> {
  // Every static import (React included) has loaded by now.
  restoreNodeEnv();
  // Subcommands with their own flags are dispatched before the interactive flags are parsed.
  if (process.argv[2] === 'serve') return serveCommand(process.argv.slice(3));
  if (process.argv[2] === 'setup') return setupCommand(process.argv.slice(3));
  if (process.argv[2] === 'telegram') {
    const { telegramCommand } = await import('./telegram/run.js');
    return telegramCommand(process.argv.slice(3));
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        model: { type: 'string', short: 'm' },
        approval: { type: 'string' },
        sandbox: { type: 'string' },
        continue: { type: 'boolean', short: 'c' },
        resume: { type: 'string', short: 'r' },
        'no-session': { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        mode: { type: 'string' },
        print: { type: 'boolean', short: 'p' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        fix: { type: 'boolean' },
        check: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
      },
    });
  } catch (e) {
    console.error((e as Error).message + `\nRun \`${BIN} --help\`.`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(`${NAME} ${VERSION}`);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const cwd = process.cwd();
  const [first, ...rest] = positionals;
  if (first === 'doctor') return doctor(cwd, { fix: !!values.fix, yes: !!values.yes });
  if (first === 'update') return updateCommand(!!values.check);
  if (first === 'models') return modelsCommand(cwd);
  if (first === 'serve') return serveCommand(rest);
  if (first === 'auth') return authCommand(rest);
  if (first === 'trust') {
    const loaded = loadConfig({ cwd });
    const dir = loaded.projectConfigPath ? resolve(dirname(loaded.projectConfigPath), '..') : cwd;
    trustProject(loaded.paths, dir);
    console.log(`Trusted ${dir}`);
    return 0;
  }

  const overrides: Record<string, unknown> = {};
  if (values.model) overrides.model = values.model;
  if (values.approval) {
    const a = approvalModeSchema.safeParse(values.approval);
    if (!a.success) {
      console.error(`--approval must be one of ${approvalModeSchema.options.join(', ')}`);
      return 2;
    }
    overrides.approval = { mode: a.data };
  }
  if (values.sandbox) {
    const s = sandboxModeSchema.safeParse(values.sandbox);
    if (!s.success) {
      console.error(`--sandbox must be one of ${sandboxModeSchema.options.join(', ')}`);
      return 2;
    }
    overrides.sandbox = { mode: s.data };
  }
  if (values['no-browser']) overrides.browser = { enabled: false };

  let runtime: Runtime;
  try {
    runtime = await Runtime.create({
      cwd,
      overrides,
      resume: values.resume ?? (values.continue ? true : false),
      ephemeral: !!values['no-session'],
    });
  } catch (e) {
    console.error(`${NAME}: ${friendlyStartupError(e as Error)}`);
    return 1;
  }

  const shutdown = () => void runtime.dispose().finally(() => process.exit(130));
  process.once('SIGTERM', shutdown);

  // ---- non-interactive modes -------------------------------------------------------------------
  if ((values.print || values.mode === 'rpc') && !runtime.modelSpec) {
    console.error(await noModelMessage(runtime));
    await runtime.dispose();
    return 2;
  }
  if (values.mode === 'rpc') {
    await runRpc(runtime);
    await runtime.dispose();
    return 0;
  }
  if (values.print) {
    let prompt = positionals.join(' ').trim();
    if (!process.stdin.isTTY) {
      const piped = (await readStdin(prompt ? 1500 : undefined)).trim();
      if (piped) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped;
    }
    if (!prompt) {
      console.error('Nothing to do: pass a prompt or pipe one on stdin.');
      await runtime.dispose();
      return 2;
    }
    const code = await runPrint(runtime, { prompt, json: values.mode === 'json' });
    await runtime.dispose();
    return code;
  }

  // ---- interactive UI ----------------------------------------------------------------------------
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${NAME} needs an interactive terminal. Use \`${BIN} -p "..."\` for scripts.`);
    await runtime.dispose();
    return 2;
  }
  const store = new UiStore({ printAsStreamed: true });
  const theme = pickTheme(runtime.config.theme);
  // createElement, not JSX: this entry file must not import React before ./env.js has run (see there).
  const app = render(
    createElement(App, {
      runtime,
      store,
      theme,
      ...(positionals.length ? { initialPrompt: positionals.join(' ') } : {}),
    }),
    {
      exitOnCtrlC: false,
      // We only get here on a real terminal (checked above). Without this, Ink treats a stray CI=true in the
      // environment (dev containers, some IDE shells) as "not interactive" and never draws the live UI.
      interactive: true,
    },
  );
  await app.waitUntilExit();
  await runtime.dispose();
  // /update → "Restart now": hand the terminal to the new version, continuing the latest conversation.
  const next = pendingRelaunch();
  if (next) return relaunch(next);
  return 0;
}

async function updateCommand(checkOnly: boolean): Promise<number> {
  console.log('Checking for updates…');
  const r = await checkForUpdate();
  if (!r.ok) {
    console.error(r.error);
    return 1;
  }
  const { check } = r;
  if (check.upToDate) {
    console.log(
      `${NAME} ${check.current.version} is up to date (${check.ref} @ ${short(check.current.commit)}).`,
    );
    return 0;
  }
  console.log(
    `${NAME} ${check.latest.version} is available (you have ${check.current.version}, ${short(check.current.commit)} → ${short(check.latest.commit)}).\nLatest change: ${check.latest.subject}`,
  );
  if (checkOnly) {
    console.log(`Run \`${BIN} update\` to install it.`);
    return 0;
  }
  return runUpdate(check, { inherit: true });
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`${NAME}: unexpected error: ${e.stack ?? e.message}`);
    process.exit(1);
  },
);
