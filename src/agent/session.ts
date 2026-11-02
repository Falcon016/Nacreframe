import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContentBlock, Message } from '../llm/types.js';
import { sortableId } from '../util/id.js';

export type Entry =
  | { type: 'message'; id: string; parentId: string | null; ts: number; message: Message; agentId?: string }
  | {
      type: 'compaction';
      id: string;
      parentId: string | null;
      ts: number;
      summary: string;
      firstKeptId: string;
    }
  | { type: 'label'; id: string; parentId: string | null; ts: number; label: string };

interface Header {
  type: 'session';
  version: 1;
  id: string;
  cwd: string;
  ts: number;
  parent?: string;
}

export interface SessionSummary {
  id: string;
  file: string;
  cwd: string;
  ts: number;
  updated: number;
  preview: string;
}

/**
 * A conversation stored as a tree (like pi): every entry points at its parent, so you can
 * return to any earlier point and branch without losing the original path. Persisted as JSONL.
 */
export class Session {
  readonly id: string;
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private leafId: string | null = null;

  private constructor(
    readonly cwd: string,
    private file: string | undefined,
    id: string,
    readonly createdAt: number,
  ) {
    this.id = id;
  }

  static create(cwd: string, dir?: string): Session {
    const id = sortableId();
    const ts = Date.now();
    const file = dir ? join(dir, `${id}.jsonl`) : undefined;
    const s = new Session(cwd, file, id, ts);
    if (file) {
      mkdirSync(dir!, { recursive: true });
      const header: Header = { type: 'session', version: 1, id, cwd, ts };
      appendFileSync(file, JSON.stringify(header) + '\n');
    }
    return s;
  }

  /** Open a session at a fixed path, creating it if it does not exist yet (used by swarm members). */
  static open(file: string, cwd: string): Session {
    if (existsSync(file)) return Session.load(file);
    const id = sortableId();
    mkdirSync(dirname(file), { recursive: true });
    const header: Header = { type: 'session', version: 1, id, cwd, ts: Date.now() };
    appendFileSync(file, JSON.stringify(header) + '\n');
    return new Session(cwd, file, id, header.ts);
  }

  static load(file: string): Session {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const header = JSON.parse(lines[0] ?? '{}') as Header;
    if (header.type !== 'session') throw new Error(`${file} is not a Nacreframe session file`);
    const s = new Session(header.cwd, file, header.id, header.ts);
    for (const line of lines.slice(1)) {
      try {
        const e = JSON.parse(line) as Entry | { type: 'leaf'; id: string | null };
        if (e.type === 'leaf') s.leafId = e.id;
        else {
          s.entries.set(e.id, e);
          s.order.push(e.id);
          s.leafId = e.id;
        }
      } catch {
        /* skip a torn trailing line from a crash */
      }
    }
    return s;
  }

  static list(dir: string): SessionSummary[] {
    if (!existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      try {
        const s = Session.load(file);
        const first = s
          .path()
          .find(
            (e) =>
              e.type === 'message' &&
              e.message.role === 'user' &&
              e.message.content.some((b) => b.type === 'text'),
          );
        const text =
          first && first.type === 'message'
            ? first.message.content.find((b) => b.type === 'text')
            : undefined;
        out.push({
          id: s.id,
          file,
          cwd: s.cwd,
          ts: s.createdAt,
          updated: statSync(file).mtimeMs,
          preview: text && text.type === 'text' ? text.text.replace(/\s+/g, ' ').slice(0, 80) : '(empty)',
        });
      } catch {
        /* ignore unreadable files */
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  private write(obj: unknown): void {
    if (this.file) appendFileSync(this.file, JSON.stringify(obj) + '\n');
  }

  private add(e: Entry): Entry {
    this.entries.set(e.id, e);
    this.order.push(e.id);
    this.leafId = e.id;
    this.write(e);
    return e;
  }

  get leaf(): string | null {
    return this.leafId;
  }

  append(message: Message, agentId?: string): string {
    const id = sortableId();
    this.add({
      type: 'message',
      id,
      parentId: this.leafId,
      ts: Date.now(),
      message,
      ...(agentId ? { agentId } : {}),
    });
    return id;
  }

  appendCompaction(summary: string, firstKeptId: string): void {
    this.add({
      type: 'compaction',
      id: sortableId(),
      parentId: this.leafId,
      ts: Date.now(),
      summary,
      firstKeptId,
    });
  }

  /** Move the leaf to an earlier entry; the next append starts a new branch from there. */
  branchTo(entryId: string | null): void {
    if (entryId !== null && !this.entries.has(entryId)) throw new Error(`No such entry ${entryId}`);
    this.leafId = entryId;
    this.write({ type: 'leaf', id: entryId });
  }

  /** Entries from the root to the current leaf. */
  path(): Entry[] {
    const out: Entry[] = [];
    let cur = this.leafId;
    while (cur) {
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  /** Branch points: entries that have more than one child. */
  childrenOf(id: string | null): Entry[] {
    return this.order.map((i) => this.entries.get(i)!).filter((e) => e.parentId === id);
  }

  /** User-message entries on the current path, for /tree style navigation. */
  userTurns(): { id: string; text: string }[] {
    return this.path().flatMap((e) => {
      if (e.type !== 'message' || e.message.role !== 'user') return [];
      const t = e.message.content.find((b) => b.type === 'text');
      return t && t.type === 'text' ? [{ id: e.id, text: t.text }] : [];
    });
  }

  /** The conversation to send to the model: compaction summary + kept tail. */
  messages(): Message[] {
    const path = this.path();
    let c = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === 'compaction') {
        c = i;
        break;
      }
    }
    const msgs = (from: number, to: number): Message[] =>
      path.slice(from, to).flatMap((e) => (e.type === 'message' ? [e.message] : []));
    if (c === -1) return msgs(0, path.length);
    const comp = path[c] as Extract<Entry, { type: 'compaction' }>;
    const keptFrom = Math.max(
      0,
      path.findIndex((e) => e.id === comp.firstKeptId),
    );
    const summary: Message = {
      role: 'user',
      content: [{ type: 'text', text: `[Summary of the earlier conversation]\n${comp.summary}` }],
    };
    return [summary, ...msgs(keptFrom, c), ...msgs(c + 1, path.length)];
  }

  /** Raw message entries on the current path (ids needed to choose a compaction cut). */
  messageEntries(): Extract<Entry, { type: 'message' }>[] {
    return this.path().filter((e): e is Extract<Entry, { type: 'message' }> => e.type === 'message');
  }
}

export function isToolResultOnly(content: ContentBlock[]): boolean {
  return content.length > 0 && content.every((b) => b.type === 'tool_result');
}

export function sessionDir(dataDir: string, projectKey: string): string {
  return join(dataDir, 'sessions', projectKey);
}
