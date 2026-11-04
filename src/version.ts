import { readFileSync } from 'node:fs';

export const NAME = 'NexusHarness';
export const BIN = 'nexus';

/** Read from package.json (one folder up from both src/ and dist/), so an update shows its new version. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
