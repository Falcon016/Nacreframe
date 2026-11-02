import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { unifiedDiff } from '../util/diff.js';
import { fileLocks } from '../util/mutex.js';
import { newId } from '../util/id.js';
import { defineTool, type ToolContext } from './types.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Atomic write: temp file in the same directory, then rename. Preserves nothing but content. */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${newId()}.tmp`);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Refuse edits to files this agent has not read, or that changed on disk since it did. */
function assertFresh(path: string, current: number, ctx: ToolContext): void {
  const seen = ctx.readState.get(path);
  if (seen === undefined) throw new Error(`You must read ${path} before modifying it.`);
  if (Math.abs(seen - current) > 1) {
    throw new Error(
      `${path} changed on disk since you last read it (another agent or process?). Read it again first.`,
    );
  }
}

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a file from the workspace. Returns numbered lines. Use offset/limit for large files. Can also read PNG/JPEG/GIF/WebP images.',
  risk: 'read',
  parallel: true,
  schema: z.object({
    path: z.string().describe('File path, absolute or relative to the working directory'),
    offset: z.number().int().min(1).optional().describe('1-based line to start from'),
    limit: z.number().int().min(1).max(MAX_LINES).optional().describe('Max lines to return'),
  }),
  primaryArg: (i) => i.path,
  describe: (i) => i.path,
  async execute(input, ctx) {
    const path = ctx.sandbox.checkPath(input.path, 'read');
    const st = await stat(path);
    if (st.isDirectory()) return { content: `${input.path} is a directory; use the ls tool.`, isError: true };
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (type) {
      if (st.size > 5 * 1024 * 1024) return { content: 'Image is larger than 5MB.', isError: true };
      const data = (await readFile(path)).toString('base64');
      ctx.readState.set(path, st.mtimeMs);
      return { content: `Image ${input.path} (${st.size} bytes)`, images: [{ mediaType: type, data }] };
    }
    if (st.size > MAX_READ_BYTES * 8)
      return { content: `File is too large (${st.size} bytes). Use grep or read a range.`, isError: true };
    const buf = await readFile(path);
    if (isBinary(buf))
      return { content: `${input.path} looks like a binary file (${st.size} bytes).`, isError: true };
    ctx.readState.set(path, st.mtimeMs);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = (input.offset ?? 1) - 1;
    const limit = input.limit ?? MAX_LINES;
    const slice = lines.slice(start, start + limit);
    const width = String(start + slice.length).length;
    let out = slice
      .map(
        (l, i) =>
          `${String(start + i + 1).padStart(width)}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l}`,
      )
      .join('\n');
    if (out.length > MAX_READ_BYTES)
      out = out.slice(0, MAX_READ_BYTES) + '\n… [output truncated; use offset/limit]';
    if (start + slice.length < lines.length)
      out += `\n… [${lines.length - start - slice.length} more lines; use offset=${start + slice.length + 1}]`;
    if (!out) out = '(empty file)';
    return { content: out };
  },
});

export const writeTool = defineTool({
  name: 'write',
  description:
    'Create a new file or completely overwrite an existing one. For existing files you must read them first. Prefer `edit` for targeted changes.',
  risk: 'edit',
  schema: z.object({
    path: z.string().describe('File path, absolute or relative to the working directory'),
    content: z.string().describe('Full file contents'),
  }),
  primaryArg: (i) => i.path,
  describe: (i) => `${i.path} (${i.content.split('\n').length} lines)`,
  async preview(input, ctx) {
    const path = ctx.sandbox.checkPath(input.path, 'write');
    const old = await readFile(path, 'utf8').catch(() => undefined);
    return unifiedDiff(
      old ?? '',
      input.content,
      3,
      old === undefined ? `new file ${input.path}` : `--- ${input.path}`,
    ).text;
  },
  async execute(input, ctx) {
    const path = ctx.sandbox.checkPath(input.path, 'write');
    return fileLocks.run(path, async () => {
      const current = await mtimeOf(path);
      const old = current === undefined ? undefined : await readFile(path, 'utf8');
      if (current !== undefined) assertFresh(path, current, ctx);
      await atomicWrite(path, input.content);
      ctx.readState.set(path, (await mtimeOf(path)) ?? Date.now());
      const d = unifiedDiff(
        old ?? '',
        input.content,
        3,
        `${old === undefined ? 'Created' : 'Updated'} ${input.path}`,
      );
      return {
        content: `${old === undefined ? 'Created' : 'Overwrote'} ${input.path} (+${d.added} -${d.removed})`,
        display: d.text,
      };
    });
  },
});

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace an exact string in a file. `old_string` must match exactly once (include enough surrounding context to be unique) unless replace_all is true. Read the file first.',
  risk: 'edit',
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1).describe('Exact text to replace, including whitespace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace every occurrence'),
  }),
  primaryArg: (i) => i.path,
  describe: (i) => i.path,
  async preview(input, ctx) {
    const path = ctx.sandbox.checkPath(input.path, 'write');
    const old = await readFile(path, 'utf8');
    const next = applyEdit(old, input.old_string, input.new_string, input.replace_all ?? false);
    return unifiedDiff(old, next, 3, `--- ${input.path}`).text;
  },
  async execute(input, ctx) {
    const path = ctx.sandbox.checkPath(input.path, 'write');
    return fileLocks.run(path, async () => {
      const current = await mtimeOf(path);
      if (current === undefined) throw new Error(`${input.path} does not exist. Use write to create it.`);
      assertFresh(path, current, ctx);
      const raw = await readFile(path, 'utf8');
      const crlf = raw.includes('\r\n');
      const text = crlf ? raw.replaceAll('\r\n', '\n') : raw;
      const next = applyEdit(
        text,
        input.old_string.replaceAll('\r\n', '\n'),
        input.new_string.replaceAll('\r\n', '\n'),
        input.replace_all ?? false,
      );
      await atomicWrite(path, crlf ? next.replaceAll('\n', '\r\n') : next);
      ctx.readState.set(path, (await mtimeOf(path)) ?? Date.now());
      const d = unifiedDiff(text, next, 3, `Edited ${input.path}`);
      return { content: `Edited ${input.path} (+${d.added} -${d.removed})`, display: d.text };
    });
  },
});

export function applyEdit(text: string, oldStr: string, newStr: string, all: boolean): string {
  if (oldStr === newStr) throw new Error('old_string and new_string are identical.');
  const first = text.indexOf(oldStr);
  if (first === -1)
    throw new Error('old_string was not found. It must match exactly, including whitespace and indentation.');
  if (all) return text.split(oldStr).join(newStr);
  if (text.indexOf(oldStr, first + oldStr.length) !== -1) {
    throw new Error(
      'old_string matches more than once. Add surrounding context to make it unique, or set replace_all.',
    );
  }
  return text.slice(0, first) + newStr + text.slice(first + oldStr.length);
}
