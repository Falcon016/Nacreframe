import { chmodSync, existsSync } from 'node:fs';

// Make the CLI entry executable on POSIX installs (a no-op on Windows).
const entry = new URL('../dist/cli.js', import.meta.url);
if (existsSync(entry)) {
  try {
    chmodSync(entry, 0o755);
  } catch {
    /* ignore */
  }
}
