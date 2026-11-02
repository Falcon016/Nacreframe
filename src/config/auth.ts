import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths } from '../paths.js';

/**
 * Local credential store: `<config>/auth.json`, created with owner-only permissions.
 * Keys are only ever read from here or from environment variables; they are never put in
 * project config, session logs, or tool output (see util/redact.ts).
 */
export class AuthStore {
  private file: string;

  constructor(private paths: AppPaths) {
    this.file = join(paths.config, 'auth.json');
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const j: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' ? (j as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  get(provider: string): string | undefined {
    return this.read()[provider];
  }

  set(provider: string, key: string): void {
    mkdirSync(this.paths.config, { recursive: true });
    const data = { ...this.read(), [provider]: key };
    writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* chmod is a no-op on some Windows filesystems */
    }
  }

  remove(provider: string): boolean {
    const data = this.read();
    if (!(provider in data)) return false;
    delete data[provider];
    writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    return true;
  }

  list(): string[] {
    return Object.keys(this.read());
  }
}
