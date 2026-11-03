import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { systemChecks } from '../doctor.js';
import { parseModelSpec } from '../llm/registry.js';
import { appPaths } from '../paths.js';
import { BIN, NAME, VERSION } from '../version.js';
import { applyPlan, planFromFlags, type SetupPlan } from './plan.js';
import { Cancelled, TtyPrompter } from './prompt.js';
import { Term } from './ui.js';
import { runWizard } from './wizard.js';

const HELP = `${NAME} ${VERSION} — guided setup

Usage
  ${BIN} setup                       Interactive wizard (provider, key, model, safety, Telegram)
  ${BIN} setup --yes [options]       No questions: apply only the options you pass

Options (with --yes)
      --provider <id>              anthropic | openai | ollama | lmstudio | llamacpp | <your own name>
      --base-url <url>             Server address (required for your own provider name)
  -m, --model <provider/model>     Default model, or just <model> together with --provider
      --approval <mode>            ask | edits | auto | plan
      --sandbox <level>            off | guard | container
      --browser | --no-browser     Allow or forbid browser control
      --key-stdin                  Read the API key for --provider from stdin
  -y, --yes                        Do not ask anything
  -h, --help                       Show this help

Examples
  ${BIN} setup
  printf '%s' "$ANTHROPIC_API_KEY" | ${BIN} setup --yes --provider anthropic --key-stdin
  ${BIN} setup --yes --provider ollama --model qwen3:8b --approval edits
`;

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export async function setupCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        provider: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string', short: 'm' },
        approval: { type: 'string' },
        sandbox: { type: 'string' },
        browser: { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        'key-stdin': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error((e as Error).message + `\nRun \`${BIN} setup --help\`.`);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    console.log(HELP);
    return 0;
  }

  const term = new Term();
  const paths = appPaths();
  const cwd = process.cwd();

  if (!v.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        `${BIN} setup needs an interactive terminal.\nFor scripts and CI use \`${BIN} setup --yes\` with options (see \`${BIN} setup --help\`).`,
      );
      return 2;
    }
    const prompt = new TtyPrompter(process.stdin, term);
    try {
      return await runWizard({ term, prompt, env: process.env, cwd, paths, systemChecks });
    } catch (e) {
      if (e instanceof Cancelled) return 130;
      throw e;
    }
  }

  // ---- non-interactive ---------------------------------------------------------------------------
  let key: string | undefined;
  if (v['key-stdin']) {
    key = (await readAll(process.stdin)).trim();
    if (!key) {
      console.error('--key-stdin was given but nothing arrived on stdin.');
      return 2;
    }
  }
  const made = planFromFlags(v, key);
  if ('error' in made) {
    console.error(`${BIN} setup: ${made.error}`);
    return 2;
  }
  const plan: SetupPlan = made.plan;

  // A model that names an unknown provider would only fail later, at startup. Say so now.
  if (plan.model) {
    try {
      const loaded = loadConfig({
        cwd,
        paths,
        overrides: plan.provider
          ? {
              providers: {
                [plan.provider.id]: {
                  type: plan.provider.type,
                  ...(plan.provider.baseUrl ? { baseUrl: plan.provider.baseUrl } : {}),
                },
              },
            }
          : {},
      });
      parseModelSpec(plan.model, loaded.config);
    } catch (e) {
      console.error(`${BIN} setup: ${(e as Error).message}`);
      return 2;
    }
  }

  if (Object.keys(plan).length === 0) {
    console.log(
      `Nothing to change. Pass options such as --provider, --model, --approval (see \`${BIN} setup --help\`).`,
    );
    return 0;
  }
  try {
    const r = applyPlan(plan, paths);
    console.log(`Saved ${r.configPath}`);
    if (r.keySaved) console.log(`Stored the API key for ${plan.provider!.id} (owner-only permissions).`);
    if (r.replacedInvalid)
      console.error('Warning: the previous config.json was not valid JSON and was replaced.');
    return 0;
  } catch (e) {
    console.error(`${BIN} setup: could not save: ${(e as Error).message}`);
    return 1;
  }
}
