import type { ApprovalMode } from '../config/schema.js';

/**
 * "Nacre": mother-of-pearl on deep ink. Warm pearl text, a muted violet-grey for chrome, and a
 * small set of iridescent accents. The terminal background stays the user's own; matching terminal
 * colour schemes live in assets/terminal-themes/.
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
  agents: string[];
}

export const NACRE: Theme = {
  name: 'nacre',
  text: '#e9e4da',
  dim: '#9a95a8',
  faint: '#5f5a70',
  accent: '#e3b7c4',
  teal: '#8fd3c8',
  lavender: '#b4a7e8',
  gold: '#e6c384',
  green: '#9fd4a8',
  red: '#e58a8a',
  blue: '#8db4f0',
  rose: '#d79bd6',
  agents: ['#d79bd6', '#8fd3c8', '#e6c384', '#8db4f0', '#9fd4a8', '#e3b7c4', '#b4a7e8', '#f0a58f'],
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
  brand: '◆',
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
