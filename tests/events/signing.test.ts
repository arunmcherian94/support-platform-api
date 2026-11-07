import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeSecret, sign } from '../../src/events/signing.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = `whsec_${KEY.toString('base64')}`;

describe('decodeSecret', () => {
  it('returns the base64-decoded bytes after the whsec_ prefix', () => {
    expect(decodeSecret(SECRET).equals(KEY)).toBe(true);
  });

  it('rejects a secret without the prefix or without key bytes', () => {
    expect(() => decodeSecret(KEY.toString('base64'))).toThrow(/whsec_/);
    expect(() => decodeSecret('whsec_')).toThrow(/no key bytes/);
  });
});

describe('sign', () => {
  it('is v1, + base64(HMAC-SHA256(key, "{id}.{timestamp}.{payload}"))', () => {
    const payload = '{"type":"case.escalated","data":{"caseId":"CS-10231"}}';
    const expected = createHmac('sha256', KEY)
      .update(`msg_abc.1793966400.${payload}`)
      .digest('base64');
    expect(sign(KEY, 'msg_abc', 1793966400, payload)).toBe(`v1,${expected}`);
    // Buffer and string payloads with the same bytes sign the same.
    expect(sign(KEY, 'msg_abc', '1793966400', Buffer.from(payload))).toBe(`v1,${expected}`);
  });

  it('matches the Standard Webhooks reference vector', () => {
    // Published test vector of the Standard Webhooks reference libraries.
    const key = decodeSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
    expect(sign(key, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  it('signs the timestamp and the ID, not only the body', () => {
    const base = sign(KEY, 'msg_abc', 1793966400, '{}');
    expect(sign(KEY, 'msg_abc', 1793966401, '{}')).not.toBe(base);
    expect(sign(KEY, 'msg_abd', 1793966400, '{}')).not.toBe(base);
    expect(sign(KEY, 'msg_abc', 1793966400, '{ }')).not.toBe(base);
  });
});
