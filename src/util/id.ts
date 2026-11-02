import { randomBytes } from 'node:crypto';

export function newId(prefix = ''): string {
  return prefix + randomBytes(6).toString('hex');
}

/** Time-sortable id: base36 timestamp + random suffix. */
export function sortableId(): string {
  return Date.now().toString(36).padStart(9, '0') + randomBytes(3).toString('hex');
}
