import type { ApprovalMode } from '../config/schema.js';

/**
 * "Nexus": electric blue on black, from the logo. Cool white text, a cyan-blue accent for what is yours to act on or
 * is live, a softer sky blue for reasoning and inline code, and a small set of status colours shared with the web
 * dashboard. The terminal background stays the user's own; matching black-and-blue terminal colour schemes live in
 * assets/terminal-themes/.
 */
export interface Theme {
  name: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  teal: string;
  sky: string;
  gold: string;
  green: string;
  red: string;
  blue: string;
  rose: string;
  /** Panel borders: quiet deep blue. */
  frame: string;
  agents: string[];
}

export const NEXUS: Theme = {
  name: 'nexus',
  text: '#e6edf7',
  dim: '#9eabc0',
  faint: '#6b7891',
  accent: '#5cc8ff',
  teal: '#66cfc0',
  sky: '#8fb8ff',
  gold: '#e2b866',
  green: '#74d19b',
  red: '#ef7b7b',
  blue: '#5b8cff',
  rose: '#e98bd0',
  frame: '#1f3f7a',
  agents: ['#e98bd0', '#66cfc0', '#e2b866', '#5b8cff', '#74d19b', '#f0a3c0', '#5cc8ff', '#f0a98e'],
};

/** Colour-free fallback for NO_COLOR / dumb terminals. */
export const MONO: Theme = {
  name: 'mono',
  text: 'white',
  dim: 'gray',
  faint: 'gray',
  accent: 'white',
  teal: 'white',
  sky: 'white',
  gold: 'white',
  green: 'white',
  red: 'white',
  blue: 'white',
  rose: 'white',
  frame: 'gray',
  agents: ['white'],
};

export function pickTheme(name: string, env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.NO_COLOR || name === 'mono') return MONO;
  return NEXUS;
}

export type ColorKey = Exclude<keyof Theme, 'name' | 'agents'>;

export const MODE_STYLE: Record<ApprovalMode, { label: string; color: ColorKey; hint: string }> = {
  ask: { label: 'ask', color: 'gold', hint: 'asks before every change' },
  edits: { label: 'edits', color: 'teal', hint: 'auto-approves file edits' },
  auto: { label: 'auto', color: 'rose', hint: 'auto-approves within the sandbox' },
  plan: { label: 'plan', color: 'sky', hint: 'read-only planning' },
};

export const GLYPH = {
  /** The logo in text form: a glowing node in its ring, as in the NexusHarness mark. */
  mark: '◉',
  node: '◉',
  user: '❯',
  tool: '●',
  result: '⎿',
  ok: '✓',
  fail: '✗',
  deny: '⊘',
  think: '✻',
  bar: '▍',
  spinner: ['◜', '◠', '◝', '◞', '◡', '◟'],
} as const;
