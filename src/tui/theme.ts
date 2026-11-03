import type { ApprovalMode } from '../config/schema.js';

/**
 * "Nacre": deep purple on black. Pearl-white text, a violet accent for what is yours to act on or is live, and
 * a small set of status colours shared with the web dashboard. The terminal background stays the user's own;
 * matching black-and-purple terminal colour schemes live in assets/terminal-themes/.
 */
export interface Theme {
  name: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  teal: string;
  lavender: string;
  gold: string;
  green: string;
  red: string;
  blue: string;
  rose: string;
  /** Panel borders: quiet deep purple. */
  frame: string;
  agents: string[];
}

export const NACRE: Theme = {
  name: 'nacre',
  text: '#ebe7f2',
  dim: '#a59db5',
  faint: '#6f6884',
  accent: '#9d84ff',
  teal: '#66cfc0',
  lavender: '#b7a4ff',
  gold: '#e2b866',
  green: '#74d19b',
  red: '#ef7b7b',
  blue: '#82aaf2',
  rose: '#e98bd0',
  frame: '#4b3b7c',
  agents: ['#e98bd0', '#66cfc0', '#e2b866', '#82aaf2', '#74d19b', '#f0a3c0', '#b7a4ff', '#f0a98e'],
};

/** Colour-free fallback for NO_COLOR / dumb terminals. */
export const MONO: Theme = {
  name: 'mono',
  text: 'white',
  dim: 'gray',
  faint: 'gray',
  accent: 'white',
  teal: 'white',
  lavender: 'white',
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
  return NACRE;
}

export type ColorKey = Exclude<keyof Theme, 'name' | 'agents'>;

export const MODE_STYLE: Record<ApprovalMode, { label: string; color: ColorKey; hint: string }> = {
  ask: { label: 'ask', color: 'gold', hint: 'asks before every change' },
  edits: { label: 'edits', color: 'teal', hint: 'auto-approves file edits' },
  auto: { label: 'auto', color: 'rose', hint: 'auto-approves within the sandbox' },
  plan: { label: 'plan', color: 'lavender', hint: 'read-only planning' },
};

export const GLYPH = {
  /** The logo in text form: a pearl held between two brackets. */
  mark: ['[', '●', ']'],
  pearl: '●',
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
