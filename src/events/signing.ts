import { createHmac } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

/**
 * Decodes a Standard Webhooks secret (`whsec_` + base64) into the HMAC key bytes.
 * Config validation (src/config.ts) has already checked the shape at start-up;
 * this throws on anything else rather than signing with a wrong key.
 */
export function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) {
    throw new Error('webhook secret must start with whsec_');
  }
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  if (key.length === 0) throw new Error('webhook secret has no key bytes');
  return key;
}

/**
 * The Standard Webhooks `v1` signature: base64(HMAC-SHA256(key, `{id}.{timestamp}.{payload}`)).
 * `payload` must be the exact bytes sent (or received), never a re-serialised body;
 * the ID and timestamp are signed so a captured body can't be replayed under another
 * delivery ID or at another time.
 */
export function sign(
  secret: Buffer,
  id: string,
  timestampSec: number | string,
  payload: string | Buffer,
): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${id}.${String(timestampSec)}.`);
  mac.update(payload);
  return `v1,${mac.digest('base64')}`;
}
