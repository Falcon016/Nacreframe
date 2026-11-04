import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appPaths, type AppPaths } from './paths.js';

/**
 * Names from before the rename to NexusHarness (it was Nacreframe, with the `nacre` command). Existing installs keep
 * working: old environment variables are honoured, old settings are moved over once, and old project folders and
 * instruction files are still read.
 */
export const LEGACY = {
  slug: 'nacreframe',
  projectDir: '.nacreframe',
  envPrefix: 'NACRE_',
  bin: 'nacre',
  refFile: '.nacre-ref',
  instructions: 'NACREFRAME.md',
} as const;

export const PROJECT_DIR = '.nexusharness';

/** `NACRE_X` still works: it is copied to `NEXUS_X` when that is not set. */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY.envPrefix) || v === undefined) continue;
    const name = `NEXUS_${k.slice(LEGACY.envPrefix.length)}`;
    if (env[name] === undefined) env[name] = v;
  }
}

/** The project folder in `dir`: `.nexusharness`, or the old `.nacreframe` when only that one exists. */
export function projectDirIn(dir: string): string {
  const current = join(dir, PROJECT_DIR);
  const old = join(dir, LEGACY.projectDir);
  return !existsSync(current) && existsSync(old) ? old : current;
}

/**
 * Move settings, keys and sessions from the old folders the first time NexusHarness starts. Nothing happens when
 * a home folder is set by hand (`NEXUS_HOME`) or the new folders already exist. Returns what was moved, as
 * `[from, to]` pairs, so the CLI can say so once.
 */
export function migrateLegacyDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, string][] {
  if (env.NEXUS_HOME || env.NACRE_HOME) return [];
  const next = appPaths(env, platform);
  const old = appPaths(env, platform, LEGACY.slug);
  const moved: [string, string][] = [];
  // Config first: on macOS data and state live inside it and move with it.
  for (const key of ['config', 'data', 'state'] as const satisfies (keyof AppPaths)[]) {
    const from = old[key];
    const to = next[key];
    if (from === to || !existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch {
        // Another drive or a busy folder: copy instead, and leave the old one in place.
        cpSync(from, to, { recursive: true, preserveTimestamps: true });
      }
      moved.push([from, to]);
    } catch {
      /* leave it: the old folder is untouched and the user can move it by hand */
    }
  }
  return moved;
}

/**
 * An install updated from inside the app before the rename got only the old `nacre` launcher (its installer still
 * had the old name). Add `nexus` beside it: a copy of that launcher, which already starts this install. Returns the
 * path when one was added.
 */
export function addMissingLauncher(binDir: string, legacyMark: string): string | undefined {
  const old = join(binDir, LEGACY.bin);
  const next = join(binDir, 'nexus');
  try {
    if (existsSync(next) || !existsSync(old)) return undefined;
    const text = readFileSync(old, 'utf8');
    if (!text.includes(legacyMark)) return undefined;
    writeFileSync(next, text, { mode: 0o755 });
    chmodSync(next, 0o755);
    return next;
  } catch {
    return undefined;
  }
}
