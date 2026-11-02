import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { globMatch } from '../util/glob.js';
import { defineTool } from './types.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
]);

interface WalkOptions {
  root: string;
  signal: AbortSignal;
  includeSkipped?: boolean;
  limit?: number;
  check: (path: string) => boolean;
}

/** Depth-first file walk with a hard cap, skipping dependency/build directories. */
async function* walk({
  root,
  signal,
  includeSkipped,
  limit = 50_000,
  check,
}: WalkOptions): AsyncGenerator<string> {
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    if (signal.aborted) return;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeSkipped && SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && check(full)) {
        if (++seen > limit) return;
        yield full;
      }
    }
  }
}

const toRel = (root: string, p: string) => relative(root, p).replaceAll('\\', '/');

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Returns paths sorted by most recently modified.',
  risk: 'read',
  parallel: true,
  schema: z.object({
    pattern: z.string().describe('Glob pattern relative to `path`'),
    path: z.string().optional().describe('Directory to search; defaults to the working directory'),
  }),
  primaryArg: (i) => i.path ?? '.',
  describe: (i) => i.pattern,
  async execute(input, ctx) {
    const root = ctx.sandbox.checkPath(input.path ?? '.', 'read');
    const hits: { rel: string; mtime: number }[] = [];
    for await (const f of walk({ root, signal: ctx.signal, check: () => true })) {
      const rel = toRel(root, f);
      if (
        globMatch(input.pattern, rel) ||
        (!input.pattern.includes('/') && globMatch(input.pattern, rel.split('/').at(-1)!))
      ) {
        const st = await stat(f).catch(() => undefined);
        hits.push({ rel, mtime: st?.mtimeMs ?? 0 });
        if (hits.length >= 2000) break;
      }
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    if (!hits.length) return { content: 'No files matched.' };
    const shown = hits.slice(0, 200).map((h) => h.rel);
    return { content: shown.join('\n') + (hits.length > 200 ? `\n… and ${hits.length - 200} more` : '') };
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching lines as path:line:text. Skips node_modules, .git and build output.',
  risk: 'read',
  parallel: true,
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression'),
    path: z.string().optional().describe('File or directory to search; defaults to the working directory'),
    glob: z.string().optional().describe('Only search files whose path matches this glob'),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(500).optional(),
    context: z.number().int().min(0).max(5).optional().describe('Lines of context around each match'),
  }),
  primaryArg: (i) => i.path ?? '.',
  describe: (i) => i.pattern,
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    } catch (e) {
      return { content: `Invalid regex: ${(e as Error).message}`, isError: true };
    }
    const target = ctx.sandbox.checkPath(input.path ?? '.', 'read');
    const st = await stat(target);
    const root = st.isDirectory() ? target : join(target, '..');
    const files = st.isDirectory()
      ? walk({
          root,
          signal: ctx.signal,
          check: (p) =>
            !input.glob ||
            globMatch(input.glob, toRel(root, p)) ||
            globMatch(input.glob, p.split(/[\\/]/).at(-1)!),
        })
      : (async function* () {
          yield target;
        })();
    const max = input.max_results ?? 100;
    const ctxLines = input.context ?? 0;
    const out: string[] = [];
    let matches = 0;
    outer: for await (const f of files) {
      let text: string;
      try {
        const s = await stat(f);
        if (s.size > 2 * 1024 * 1024) continue;
        const buf = await readFile(f);
        if (buf.subarray(0, 4000).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        const rel = toRel(root, f) || f;
        for (let k = Math.max(0, i - ctxLines); k <= Math.min(lines.length - 1, i + ctxLines); k++) {
          const l = lines[k]!;
          out.push(
            `${rel}${k === i ? ':' : '-'}${k + 1}${k === i ? ':' : '-'}${l.length > 400 ? l.slice(0, 400) + '…' : l}`,
          );
        }
        if (ctxLines) out.push('--');
        if (++matches >= max) {
          out.push(`… stopped at ${max} matches`);
          break outer;
        }
      }
    }
    return { content: out.length ? out.join('\n') : 'No matches.' };
  },
});

export const lsTool = defineTool({
  name: 'ls',
  description: 'List the entries of a directory (directories first, marked with a trailing slash).',
  risk: 'read',
  parallel: true,
  schema: z.object({ path: z.string().optional().describe('Directory; defaults to the working directory') }),
  primaryArg: (i) => i.path ?? '.',
  describe: (i) => i.path ?? '.',
  async execute(input, ctx) {
    const dir = ctx.sandbox.checkPath(input.path ?? '.', 'read');
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    if (!entries.length) return { content: '(empty directory)' };
    const shown = entries.slice(0, 500).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    return {
      content: shown.join('\n') + (entries.length > 500 ? `\n… and ${entries.length - 500} more` : ''),
    };
  },
});
