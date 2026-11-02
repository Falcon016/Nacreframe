import type { SwarmAgentConfig } from '../config/schema.js';

export const USER = 'you';
export const SYSTEM = 'system';

export interface BusMessage {
  id: number;
  ts: number;
  from: string;
  /** Recipient agent name; undefined means the whole channel. */
  to?: string;
  text: string;
  kind: 'chat' | 'system';
}

export interface Teammate {
  name: string;
  role: string;
  running: boolean;
}

/** The handle each agent's swarm tools use. */
export interface SwarmMember {
  readonly name: string;
  say(text: string, to?: string): { ok: true } | { ok: false; error: string };
  note(key: string, value: string): void;
  notes(): Record<string, string>;
  roster(): Teammate[];
  spawn?(cfg: SwarmAgentConfig, task?: string): Promise<string>;
}
