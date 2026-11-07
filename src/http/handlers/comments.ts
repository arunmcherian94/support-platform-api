import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { ReadDeps } from './shared.js';

/** What the comment handler needs: the read dependencies plus the store. */
export interface CommentDeps extends ReadDeps {
  db: DatabaseSync;
}

/** Placeholder replaced by slice F. */
export function addCaseCommentHandler(_deps: CommentDeps): RequestHandler {
  return (_req, _res, next) => {
    next(new Error('operation not implemented'));
  };
}
