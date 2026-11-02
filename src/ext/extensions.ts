import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { AgentHooks } from '../agent/agent.js';
import type { Config } from '../config/schema.js';
import type { AnyTool } from '../tools/types.js';
import { parseFrontMatter } from './skills.js';

export interface CommandContext {
  cwd: string;
  /** Send a prompt to the agent as if the user had typed it. */
  prompt(text: string): void;
  notify(text: string): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: CommandContext): void | Promise<void>;
}

export interface ExtensionApi {
  readonly cwd: string;
  readonly config: Readonly<Config>;
  /** zod, provided so extensions outside any node_modules tree can define tool schemas. */
  readonly z: typeof z;
  registerTool(tool: AnyTool): void;
  registerCommand(cmd: SlashCommand): void;
  /** Hook called before every tool; may block it or rewrite its input. */
  onBeforeTool(h: NonNullable<AgentHooks['beforeTool']>): void;
  onAfterTool(h: NonNullable<AgentHooks['afterTool']>): void;
}

export type ExtensionModule = { default: (api: ExtensionApi) => void | Promise<void> };

export interface LoadedExtensions {
  tools: AnyTool[];
  commands: SlashCommand[];
  hooks: AgentHooks;
  warnings: string[];
  loaded: string[];
}

const EXTS = new Set(['.js', '.mjs', '.ts', '.mts']);

/**
 * Extensions are plain modules exporting `default(api)`. Node ≥ 22.18 runs `.ts` natively.
 * They execute with the user's full privileges — only load code you trust.
 */
export async function loadExtensions(dirs: string[], cwd: string, config: Config): Promise<LoadedExtensions> {
  const out: LoadedExtensions = { tools: [], commands: [], hooks: {}, warnings: [], loaded: [] };
  const before: NonNullable<AgentHooks['beforeTool']>[] = [];
  const after: NonNullable<AgentHooks['afterTool']>[] = [];
  const api: ExtensionApi = {
    cwd,
    config,
    z,
    registerTool: (t) => void out.tools.push(t),
    registerCommand: (c) => void out.commands.push(c),
    onBeforeTool: (h) => void before.push(h),
    onAfterTool: (h) => void after.push(h),
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!EXTS.has(extname(f))) continue;
      const file = join(dir, f);
      try {
        const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Partial<ExtensionModule>;
        if (typeof mod.default !== 'function') throw new Error('no default export function');
        await mod.default(api);
        out.loaded.push(file);
      } catch (e) {
        out.warnings.push(`Extension ${file} failed to load: ${(e as Error).message}`);
      }
    }
  }
  out.hooks = {
    async beforeTool(ev) {
      let input = ev.input;
      for (const h of before) {
        const r = await h({ ...ev, input });
        if (r?.block) return { block: r.block };
        if (r?.input) input = r.input;
      }
      return input === ev.input ? undefined : { input };
    },
    async afterTool(ev) {
      let result = ev.result;
      for (const h of after) {
        const r = await h({ ...ev, result });
        if (r) result = r;
      }
      return result === ev.result ? undefined : result;
    },
  };
  return out;
}

/** Markdown prompt templates: `<dir>/review.md` becomes `/review`. `$ARGUMENTS` and `$1..$9` are substituted. */
export function loadPromptTemplates(dirs: string[]): SlashCommand[] {
  const cmds: SlashCommand[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (extname(f) !== '.md') continue;
      const name = f
        .slice(0, -3)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-');
      const { meta, body } = parseFrontMatter(readFileSync(join(dir, f), 'utf8'));
      cmds.push({
        name,
        description: meta.description ?? `Prompt template (${f})`,
        run: (args, ctx) => {
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const text = body
            .replaceAll('$ARGUMENTS', args.trim())
            .replace(/\$([1-9])/g, (_m, n: string) => parts[Number(n) - 1] ?? '');
          ctx.prompt(text.trim());
        },
      });
    }
  }
  return cmds;
}
