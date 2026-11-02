import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SwarmAgentConfig } from '../config/schema.js';
import { sortableId } from '../util/id.js';
import type { BusMessage } from './types.js';

export interface SwarmState {
  version: 1;
  id: string;
  /** Preset or label the swarm was started from. */
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  agents: SwarmAgentConfig[];
  notes: Record<string, string>;
  /** Channel lines each sleeping agent has seen but not yet been woken with. */
  pending: Record<string, string[]>;
}

export interface SwarmSummary {
  id: string;
  name: string;
  dir: string;
  agents: string[];
  updatedAt: number;
  messages: number;
}

/**
 * On-disk layout of a swarm run, so it resumes like any session:
 *   <dir>/swarm.json      roster, shared notes, undelivered channel context
 *   <dir>/channel.jsonl   every channel message, append-only
 *   <dir>/<agent>.jsonl   each member's own conversation (the normal session format, with compaction)
 */
export class SwarmStore {
  private constructor(readonly dir: string) {}

  static create(root: string, name: string, cwd: string): { store: SwarmStore; state: SwarmState } {
    const id = sortableId();
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const state: SwarmState = {
      version: 1,
      id,
      name,
      cwd,
      createdAt: now,
      updatedAt: now,
      agents: [],
      notes: {},
      pending: {},
    };
    const store = new SwarmStore(dir);
    store.saveState(state);
    return { store, state };
  }

  static open(root: string, id: string): { store: SwarmStore; state: SwarmState; log: BusMessage[] } {
    const dir = join(root, id);
    const store = new SwarmStore(dir);
    const state = store.loadState();
    if (!state) throw new Error(`No saved swarm "${id}"`);
    return { store, state, log: store.loadLog() };
  }

  static list(root: string): SwarmSummary[] {
    if (!existsSync(root)) return [];
    const out: SwarmSummary[] = [];
    for (const id of readdirSync(root)) {
      try {
        const dir = join(root, id);
        const state = new SwarmStore(dir).loadState();
        if (!state) continue;
        out.push({
          id: state.id,
          name: state.name,
          dir,
          agents: state.agents.map((a) => a.name),
          updatedAt: state.updatedAt,
          messages: new SwarmStore(dir).loadLog().length,
        });
      } catch {
        /* skip unreadable runs */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  sessionFile(agent: string): string {
    return join(this.dir, `${agent}.jsonl`);
  }

  /** Atomic: write a temp file then rename, so a crash never leaves half a state file. */
  saveState(state: SwarmState): void {
    const file = join(this.dir, 'swarm.json');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n');
    renameSync(tmp, file);
  }

  loadState(): SwarmState | undefined {
    try {
      const j = JSON.parse(readFileSync(join(this.dir, 'swarm.json'), 'utf8')) as SwarmState;
      return j.version === 1 ? j : undefined;
    } catch {
      return undefined;
    }
  }

  appendMessage(m: BusMessage): void {
    appendFileSync(join(this.dir, 'channel.jsonl'), JSON.stringify(m) + '\n');
  }

  loadLog(): BusMessage[] {
    try {
      return readFileSync(join(this.dir, 'channel.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as BusMessage];
          } catch {
            return []; // torn trailing line from a crash
          }
        });
    } catch {
      return [];
    }
  }
}
