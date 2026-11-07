import { describe, expect, it } from 'vitest';
import { sign } from '../../src/events/signing.js';
import { verifyWebhook, type WebhookInput } from '../../src/events/verify.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = `whsec_${KEY.toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const NOW = new Date('2026-11-06T12:00:00Z');
const NOW_SEC = NOW.getTime() / 1000;
const BODY = '{"type": "case.escalated",  "data": {"caseId": "CS-10231"}}';
const NOTHING_SEEN = new Set<string>();

function delivery(overrides: Partial<WebhookInput> = {}, timestamp = NOW_SEC): WebhookInput {
  return {
    id: 'msg_1',
    timestamp: String(timestamp),
    signature: sign(KEY, 'msg_1', timestamp, BODY),
    rawBody: Buffer.from(BODY),
    ...overrides,
  };
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed delivery (Buffer or string body)', () => {
    expect(verifyWebhook(delivery(), SECRET, NOW, NOTHING_SEEN)).toEqual({ ok: true });
    expect(verifyWebhook(delivery({ rawBody: BODY }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: true,
    });
    expect(verifyWebhook(delivery(), KEY, NOW, NOTHING_SEEN)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(BODY.replace('CS-10231', 'CS-10232'));
    expect(verifyWebhook(delivery({ rawBody: tampered }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a body re-serialised with different spacing (raw bytes only)', () => {
    const reserialised = JSON.stringify(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY);
    expect(verifyWebhook(delivery({ rawBody: reserialised }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verifyWebhook(delivery(), OTHER_SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature whose ID or timestamp was swapped', () => {
    expect(verifyWebhook(delivery({ id: 'msg_2' }), SECRET, NOW, NOTHING_SEEN).ok).toBe(false);
    const signedEarlier = sign(KEY, 'msg_1', NOW_SEC - 10, BODY);
    expect(
      verifyWebhook(delivery({ signature: signedEarlier }), SECRET, NOW, NOTHING_SEEN),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts a timestamp exactly 5 minutes away, in either direction', () => {
    expect(verifyWebhook(delivery({}, NOW_SEC - 300), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: true,
    });
    expect(verifyWebhook(delivery({}, NOW_SEC + 300), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: true,
    });
  });

  it('rejects a timestamp 5 minutes and 1 second old or in the future', () => {
    const stale = { ok: false, reason: 'stale_timestamp' };
    expect(verifyWebhook(delivery({}, NOW_SEC - 301), SECRET, NOW, NOTHING_SEEN)).toEqual(stale);
    expect(verifyWebhook(delivery({}, NOW_SEC + 301), SECRET, NOW, NOTHING_SEEN)).toEqual(stale);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(
      verifyWebhook(delivery({ timestamp: '2026-11-06T12:00:00Z' }), SECRET, NOW, NOTHING_SEEN),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it.each(['id', 'timestamp', 'signature'] as const)('rejects a missing %s header', (header) => {
    expect(verifyWebhook(delivery({ [header]: undefined }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
    expect(verifyWebhook(delivery({ [header]: '' }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('accepts when any v1 entry of a list matches (secret rotation)', () => {
    const good = sign(KEY, 'msg_1', NOW_SEC, BODY);
    const old = sign(Buffer.alloc(32, 9), 'msg_1', NOW_SEC, BODY);
    expect(
      verifyWebhook(delivery({ signature: `${old} ${good}` }), SECRET, NOW, NOTHING_SEEN),
    ).toEqual({ ok: true });
    // Malformed and short entries are mismatches, not exceptions.
    expect(
      verifyWebhook(delivery({ signature: `v1,AAAA v1,!!! ${good}` }), SECRET, NOW, NOTHING_SEEN),
    ).toEqual({ ok: true });
    expect(verifyWebhook(delivery({ signature: 'v1,AAAA' }), SECRET, NOW, NOTHING_SEEN)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('ignores entries of other versions, even with the right digest', () => {
    const digest = sign(KEY, 'msg_1', NOW_SEC, BODY).slice('v1,'.length);
    expect(
      verifyWebhook(
        delivery({ signature: `v2,${digest} v1a,${digest}` }),
        SECRET,
        NOW,
        NOTHING_SEEN,
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('flags an already-seen webhook-id as a duplicate, only after the signature checks out', () => {
    const seen = new Set(['msg_1']);
    expect(verifyWebhook(delivery(), SECRET, NOW, seen)).toEqual({ ok: true, duplicate: true });
    // A forged request reusing a seen ID is still a bad signature, not a duplicate.
    expect(verifyWebhook(delivery(), OTHER_SECRET, NOW, seen)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
