# S4 — Comments and webhooks

- **Status:** Draft. Approved by merging its spec PR.
- **Decisions:** ADR-0005 (idempotency, webhook conventions), DECISIONS rows 15 and 19, ADR-0002 (writes go through to the case system synchronously), Gate 3a row 24 (retry only idempotent writes).
- **Traceability:** A3 and A5 (implementation), B1 (item 3 plus the webhook sender and reference receiver), the Part B ACs on idempotent comments and webhook verification.

## 1. Problem
`POST /v1/cases/{caseId}/comments` must be safe to retry: a client that times out and sends again must not create a second comment. The `case.escalated` webhook needs a sender that signs, delivers and retries, and a receiver that proves signatures, timestamps and replays are checked. Escalate itself comes in Part C; this spec builds the delivery path it will use.

## 2. Scope

### 2.1 Idempotent comment create
The contract already fixes the outcomes (ADR-0005): replay on the same key and body, 422 on a different body, 409 while in flight, 24-hour keys. This section fixes how.

- **Key scope:** the `idempotency_keys` primary key `(client_id, sub, endpoint, key)`, with `endpoint` = `addCaseComment:{caseId}`. One client can never collide with, or replay, another's keys.
- **Key value:** the header is a Structured Field string per the draft (`"…"`); an unquoted value is also accepted. The unquoted text is the key.
- **Request hash:** SHA-256 over the operation, the case ID and the canonical JSON of the body. The same body with different whitespace or key order hashes the same.
- **Claiming a key is one atomic insert** (`INSERT … ON CONFLICT DO NOTHING`) of an `in_flight` row. Never check-then-insert, so two concurrent requests can't both proceed.
- **When the key already exists:**
  - expired (`expires_at` passed): treated as absent and replaced;
  - different request hash: 422 `idempotency-key-reused`, whatever the row's state;
  - `in_flight`: 409 `request-in-progress`. An `in_flight` row older than 60 seconds (well past the 10 s request budget) is treated as abandoned by a crashed request and may be taken over;
  - `completed`: replay the stored status, body and `Location`, with `Idempotent-Replayed: true`. The case system is not called.
- **What is stored:** only a successful create (201). Any failure deletes the `in_flight` row, so the client may retry with the same key. That is safe because of the next point.
- **The write itself is idempotent upstream.** The platform passes a derived external ID with the comment: SHA-256 of `(client_id, sub, caseId, key)`, truncated. The case system dedupes on it, as a Salesforce upsert on an external-ID field does. So:
  - a request that timed out after the case system created the comment can be retried with the same key, and the case system returns the existing comment instead of creating a second;
  - the comment write may therefore be retried automatically (decision 24 allows retries of idempotent writes), with the case-system policy from S3.

  The mock case system gains this: `POST /cases/{id}/comments` accepts `externalId` and, for one it has seen on that case, returns the existing comment.
- **Missing header:** 400 `idempotency-key-required` (the validator's generic `validation-failed` is mapped for this header).
- **Author** is the token's `sub`: for agents, the user the agent acts for.
- **Upstream outcomes:** 201 → 201 with `Location: /v1/cases/{caseId}/comments/{commentId}`; a 404 → 404 `not-found`; other failures map as in S3 §2.3. The platform adds no rule on closed cases (decision 20).
- **Audit:** each create, replay and rejection writes an `audit_log` row: actor `sub`, agent, client, action `case.comment`, the case, the outcome, latency, and redacted arguments (body length only, never the text).
- **Expiry:** expired keys are swept hourly (`DELETE … WHERE expires_at < now`) and are also ignored on read, so the sweep is housekeeping, not correctness.

### 2.2 Webhook subscriptions
- Seeded at start-up from `config/webhook-subscriptions.json` (id, URL, event types, secret references), upserted into `webhook_subscriptions`. There is no subscription API (deferred, CLAUDE.md §4).
- **Secrets are referenced, never stored:** `secret_ref` names one or more environment variables (comma-separated, for rotation). Each holds a Standard Webhooks secret (`whsec_` + base64). Start-up stops with a config error if a referenced variable is missing. `.env.example` carries an obviously fake development secret.
- The default subscription points at the reference receiver (§2.5), so `make run` shows deliveries end to end.

### 2.3 Enqueueing events
- `enqueueEvent(db, type, data)` builds the Standard Webhooks envelope `{ type, timestamp, data }`, serialises it **once**, and inserts one `webhook_deliveries` row per active subscription to that event type, inside the caller's transaction. Escalate (Part C) calls it in the same transaction as its audit record, so an event is never lost or sent for a change that didn't happen.
- The stored `payload` is the exact bytes that are signed and sent; it is never re-serialised.
- Each row's `id` is the `webhook-id` (`msg_` + random), the same on every retry of that delivery.
- Escalate isn't built yet, so tests enqueue directly (the brief's "test-only trigger"). No HTTP endpoint triggers events.

### 2.4 Dispatcher
- Polls every `WEBHOOK_DISPATCH_INTERVAL_MS` (default 1000) for `status = 'pending' AND next_attempt_at <= now` (the injected clock), oldest first, up to 20 per tick. Ticks never overlap.
- **Each attempt:**
  - signs with a fresh `webhook-timestamp` (Unix seconds from the clock): `v1,` + base64(HMAC-SHA256(secret, `{id}.{timestamp}.{payload}`)), one entry per secret in the subscription, space-separated;
  - POSTs the stored bytes with `content-type: application/json`, a 15-second timeout, and redirects not followed;
  - **2xx:** `delivered`, with `delivered_at`.
  - **410:** the subscription is disabled (`active = 0`, `disabled_reason`) and the delivery is marked `dead`.
  - **anything else** (other status, timeout, network error): `attempt + 1`, `last_status` and `last_error` (status or error class only, never the response body), and `next_attempt_at` from the schedule.
- **Schedule:** retries after 5 s, 1 min, 5 min, 30 min, 2 h, 6 h and 14 h, each ±20% jitter (about 23 hours in total). After the last retry fails, the delivery is `dead`.
- Deliveries for disabled subscriptions are not attempted.
- **Shutdown:** the dispatcher stops polling and waits for in-flight attempts (bounded by their timeout) before the database closes.
- **One process.** With several instances, the poll would claim rows with `FOR UPDATE SKIP LOCKED` on Postgres (DECISIONS "Data model").

### 2.5 Reference receiver
- `src/events/verify.ts`: `verifyWebhook({ id, timestamp, signature, rawBody }, secrets, now)`, the verification a receiver should run:
  - all three headers present;
  - timestamp within 5 minutes of `now`, in either direction;
  - an HMAC over `{id}.{timestamp}.{raw body}` with each of the receiver's secrets, compared in constant time with each `v1,` entry;
  - verified against the raw bytes, never a re-parsed body.
- A small receiver app (`mocks/webhook-receiver.ts`), started by `make run`, uses it: raw-body parsing, then verify, then dedupe on `webhook-id` (remembered for longer than the timestamp window), then 204. A failure gets 400 for missing headers and 401 for a bad signature or timestamp. A duplicate gets 204 without processing again, so the sender stops retrying. It lists what it accepted at `GET /received` for tests and demos.

### 2.6 Config
New variables, validated at start-up:
- `WEBHOOK_DISPATCH_INTERVAL_MS` (default 1000);
- the secret variables named by subscriptions (e.g. `WEBHOOK_SECRET_LOCAL`).

**Out of scope:**
- escalate and the `case.escalated` payload's content (Part C);
- the transactional outbox (pass 2; the deliveries table already acts as one for this event);
- a subscription management API, and manual redelivery tooling for dead deliveries (deferred);
- ordering guarantees (the contract says none).

## 3. Acceptance criteria

| ID | Criterion |
|---|---|
| S4-1 | A comment create returns 201 with the canonical `Comment` and a `Location`. The same key and body again returns the identical status, body and `Location` with `Idempotent-Replayed: true`, and the case system is not called a second time. |
| S4-2 | The same key with a different body gets 422 `idempotency-key-reused`. A missing key gets 400 `idempotency-key-required`. |
| S4-3 | Two concurrent requests with the same key: exactly one reaches the case system; the other gets 409 `request-in-progress` (or, if it arrives after completion, the replay). |
| S4-4 | Keys are scoped: the same key from another client, another user or another case is a new request. An expired key is a new request. |
| S4-5 | A failed create stores nothing, so a retry with the same key proceeds. If the case system created the comment but the response was lost, the retry returns that comment and creates no second one (external-ID dedupe, proven against the mock). |
| S4-6 | Each create writes an audit row with the actor, the agent if any, the outcome and the body length, never the body text. |
| S4-7 | An enqueued event is delivered to each matching active subscription with `webhook-id`, `webhook-timestamp` and `webhook-signature`, and the bytes received equal the stored payload. |
| S4-8 | The reference receiver accepts a valid delivery and rejects a tampered body, the wrong secret, a timestamp outside 5 minutes, and a replayed `webhook-id` (no second processing). With two secrets configured (rotation), a delivery verifies against either. |
| S4-9 | A failing receiver gets retries on the documented schedule (checked on the injected clock, jitter within ±20%), and the delivery becomes `dead` after the last retry. A 410 disables the subscription and stops delivery. A 2xx stops retries. |
| S4-10 | Delivery state and logs never contain the receiver's response body or the secret. |
| S4-11 | `make run` delivers an enqueued event to the reference receiver, and shutdown stops the dispatcher cleanly. |

## 4. Sabotage checks (each must make a test fail)
- Drop the request-hash comparison (a different body replays the first response).
- Leave the client out of the key scope.
- Check-then-insert instead of the atomic claim (S4-3 fails under concurrency).
- Store failed responses (a retry after a failure replays the error).
- Sign without the timestamp, or over a re-serialised body.
- Skip the receiver's timestamp tolerance or its `webhook-id` dedupe.
- Retry after a 410, or never mark a delivery `dead`.

Constant-time comparison is verified by reading, as in S2 (timing isn't test-detectable).

## 5. Decisions taken in this spec (to confirm by merging)
1. **Only successful creates are stored;** failures release the key. Replaying a stored error would force a new key, and a new key is how duplicates happen.
2. **The idempotency key also travels upstream as an external ID,** so the case system dedupes the write itself. That closes the gap the platform alone can't: a create that succeeded upstream but timed out on the way back. It also makes the comment write safe to retry automatically. A provider without external IDs would need a lookup-before-retry instead (documented).
3. **An `in_flight` key is abandoned after 60 seconds,** so a crash mid-request can't block the key for 24 hours.
4. **Webhook secrets live in environment variables named by the subscription,** several per subscription for rotation; the database holds only the names.
5. **A fresh signature per attempt** (Standard Webhooks signs the attempt's timestamp), over bytes serialised once at enqueue.
6. **The reference receiver answers 204 to a duplicate** rather than an error, so a sender that missed the first 2xx stops retrying.
7. **No breaker on webhook delivery:** the retry schedule already spaces attempts out, and one receiver's outage mustn't pause the others.
