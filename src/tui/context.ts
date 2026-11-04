import { createContext, useContext } from 'react';
import { NEXUS, type Theme } from './theme.js';

export const ThemeContext = createContext<Theme>(NEXUS);
export const useTheme = (): Theme => useContext(ThemeContext);

const assigned = new Map<string, number>();

/** Stable colour per agent name for the lifetime of the process. */
export function agentColor(theme: Theme, name: string, preferred?: string): string {
  if (name === 'you') return theme.accent;
  if (name === 'system') return theme.faint;
  if (preferred && /^#|^[a-z]+$/i.test(preferred)) {
    const named: Record<string, keyof Theme> = {
      magenta: 'rose',
      cyan: 'teal',
      yellow: 'gold',
      green: 'green',
      blue: 'blue',
      red: 'red',
    };
    const key = named[preferred.toLowerCase()];
    if (key) return theme[key] as string;
    if (preferred.startsWith('#')) return preferred;
  }
  if (!assigned.has(name)) assigned.set(name, assigned.size);
  return theme.agents[assigned.get(name)! % theme.agents.length]!;
}
