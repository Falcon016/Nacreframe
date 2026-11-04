import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
  /** Where it came from: `built-in`, `user` or `project`. */
  source: string;
}

/** Skills shipped with NexusHarness (`skills/` beside `src/` and `dist/`). User and project skills override them. */
export const BUILTIN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** Parse the tiny `---\nkey: value\n---` front-matter subset used by SKILL.md files. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0)
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2]! };
}

export class SkillStore {
  private skills = new Map<string, Skill>();

  /** Later dirs override earlier ones (built-in first, then user skills, project skills last). */
  load(dirs: (string | { dir: string; source: string })[]): string[] {
    const warnings: string[] = [];
    this.skills.clear();
    for (const d of dirs) {
      const { dir, source } = typeof d === 'string' ? { dir: d, source: 'user' } : d;
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        try {
          const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
          const name = meta.name || entry.name;
          if (!meta.description) {
            warnings.push(`Skill ${file} has no description and was skipped`);
            continue;
          }
          this.skills.set(name, {
            name,
            description: meta.description,
            body: body.trim(),
            path: file,
            source,
          });
        } catch (e) {
          warnings.push(`Could not load skill ${file}: ${(e as Error).message}`);
        }
      }
    }
    return warnings;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
  names(): string[] {
    return [...this.skills.keys()];
  }
  get(name: string): string | undefined {
    const s = this.skills.get(name);
    return s ? `# Skill: ${s.name}\n\n${s.body}` : undefined;
  }
}
