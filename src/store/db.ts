import { DatabaseSync } from 'node:sqlite';

// Stub: replaced by the store slice.
export function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path);
}
