import { timingSafeEqual } from 'node:crypto';
import { decodeSecret, sign } from './signing.js';

/** Signatures older or newer than this, relative to the receiver's clock, are rejected. */
export const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

export interface WebhookInput {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  /** The body exactly as received: never a parsed and re-serialised object. */
  rawBody: Buffer | string;
}

export type VerifyResult =
  | { ok: true; duplicate?: never }
  | { ok: true; duplicate: true }
  | { ok: false; reason: 'missing_header' | 'stale_timestamp' | 'bad_signature' };

/**
 * Verifies a Standard Webhooks delivery, as a receiver should:
 *
 * 1. `webhook-id`, `webhook-timestamp` and `webhook-signature` are all present;
 * 2. the timestamp is Unix seconds within 5 minutes of `now`, in either direction
 *    (bounds how long a captured delivery can be replayed);
 * 3. HMAC-SHA256 over `{id}.{timestamp}.{rawBody}` matches at least one `v1,` entry
 *    of the space-separated signature header (a list, so secrets can rotate),
 *    compared in constant time; entries of other versions are ignored;
 * 4. an ID already in `seen` is reported as `duplicate`.
 *
 * On `{ ok: true, duplicate: true }` the caller should acknowledge with a 2xx and not
 * process the event again: an error status would make the sender keep retrying a
 * delivery the receiver already has. The duplicate check runs only after the
 * signature is valid, so an unsigned request can't probe which IDs were seen.
 * Recording the ID in `seen` after processing is the caller's job.
 */
export function verifyWebhook(
  input: WebhookInput,
  secret: string | Buffer,
  now: Date,
  seen: { has(id: string): boolean },
): VerifyResult {
  const { id, timestamp, signature, rawBody } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_header' };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'stale_timestamp' };
  const nowSec = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = typeof secret === 'string' ? decodeSecret(secret) : secret;
  const expected = Buffer.from(sign(key, id, timestamp, rawBody).slice('v1,'.length), 'base64');

  let matched = false;
  for (const entry of signature.split(' ')) {
    if (!entry.startsWith('v1,')) continue;
    const candidate = Buffer.from(entry.slice('v1,'.length), 'base64');
    // timingSafeEqual throws on unequal lengths; a wrong length is simply a mismatch.
    // Every entry is checked, with no early return.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }
  if (!matched) return { ok: false, reason: 'bad_signature' };

  if (seen.has(id)) return { ok: true, duplicate: true };
  return { ok: true };
}
