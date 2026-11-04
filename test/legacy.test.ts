import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import { detectInstall, LEGACY_MARK } from '../src/doctor.js';
import { addMissingLauncher, adoptLegacyEnv, migrateLegacyDirs, projectDirIn } from '../src/legacy.js';
import { appPaths } from '../src/paths.js';
import { tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

describe('the rename from Nacreframe', () => {
  it('honours NACRE_* variables when the NEXUS_* ones are not set', () => {
    const env: NodeJS.ProcessEnv = {
      NACRE_MODEL: 'ollama/old',
      NACRE_SANDBOX: 'off',
      NEXUS_SANDBOX: 'guard',
    };
    adoptLegacyEnv(env);
    expect(env.NEXUS_MODEL).toBe('ollama/old');
    expect(env.NEXUS_SANDBOX).toBe('guard'); // the new name wins
    expect(appPaths({ NACRE_HOME: join(ws.dir, 'h') }).config).toBe(join(ws.dir, 'h', 'config'));
  });

  it('moves settings, keys and sessions to the new folders once, and never over existing ones', () => {
    const env = {
      XDG_CONFIG_HOME: join(ws.dir, 'cfg'),
      XDG_DATA_HOME: join(ws.dir, 'data'),
      XDG_STATE_HOME: join(ws.dir, 'state'),
    };
    const old = appPaths(env, 'linux', 'nacreframe');
    mkdirSync(old.config, { recursive: true });
    mkdirSync(join(old.data, 'sessions'), { recursive: true });
    writeFileSync(join(old.config, 'auth.json'), '{"anthropic":"test-key"}');
    writeFileSync(join(old.data, 'sessions', 's.jsonl'), '{}\n');

    const moved = migrateLegacyDirs(env, 'linux');
    const next = appPaths(env, 'linux');
    expect(moved.map(([, to]) => to)).toEqual([next.config, next.data]);
    expect(readFileSync(join(next.config, 'auth.json'), 'utf8')).toContain('test-key');
    expect(existsSync(join(next.data, 'sessions', 's.jsonl'))).toBe(true);
    expect(existsSync(old.config)).toBe(false);

    // A later old folder (say, an old copy still running) never overwrites the new one.
    mkdirSync(old.config, { recursive: true });
    writeFileSync(join(old.config, 'auth.json'), '{}');
    expect(migrateLegacyDirs(env, 'linux')).toEqual([]);
    expect(readFileSync(join(next.config, 'auth.json'), 'utf8')).toContain('test-key');
    // And nothing moves when a home folder is set by hand.
    expect(migrateLegacyDirs({ ...env, NEXUS_HOME: join(ws.dir, 'x') }, 'linux')).toEqual([]);
  });

  it('still reads a project’s old .nacreframe folder, and the old theme name', () => {
    mkdirSync(join(ws.dir, '.nacreframe'));
    writeFileSync(join(ws.dir, '.nacreframe', 'config.json'), '{}');
    expect(findProjectConfig(join(ws.dir))).toBe(join(ws.dir, '.nacreframe', 'config.json'));
    expect(projectDirIn(ws.dir)).toBe(join(ws.dir, '.nacreframe'));
    mkdirSync(join(ws.dir, '.nexusharness'));
    writeFileSync(join(ws.dir, '.nexusharness', 'config.json'), '{}');
    expect(findProjectConfig(join(ws.dir))).toBe(join(ws.dir, '.nexusharness', 'config.json')); // new wins
    expect(configSchema.parse({ theme: 'nacre' }).theme).toBe('nexus');
  });

  it.skipIf(process.platform === 'win32')(
    'adds the nexus command beside an old nacre launcher, and doctor recognises the old install',
    () => {
      const root = join(ws.dir, '.nacreframe');
      const bin = join(ws.dir, 'bin');
      mkdirSync(root);
      mkdirSync(bin);
      writeFileSync(join(root, 'install.sh'), '');
      writeFileSync(join(bin, 'nacre'), `#!/bin/sh\n${LEGACY_MARK}\nNACRE_DIR='${root}'\n`, { mode: 0o755 });
      const env = { PATH: bin };
      expect(detectInstall(root, env, ws.dir)).toEqual({ root, binDir: bin }); // found, but no `nexus` yet
      expect(addMissingLauncher(bin, LEGACY_MARK)).toBe(join(bin, 'nexus'));
      expect(readFileSync(join(bin, 'nexus'), 'utf8')).toContain(`NACRE_DIR='${root}'`);
      expect(addMissingLauncher(bin, LEGACY_MARK)).toBeUndefined(); // only once
      // Someone else's `nacre` is left alone.
      writeFileSync(join(bin, 'nacre'), '#!/bin/sh\necho mine\n');
      writeFileSync(join(bin, 'nexus'), '');
      expect(addMissingLauncher(bin, LEGACY_MARK)).toBeUndefined();
    },
  );
});
