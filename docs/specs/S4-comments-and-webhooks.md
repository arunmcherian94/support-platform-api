# S4 — Comments and webhooks

- **Status:** Implemented (PR 6). Approved by merging #13.
- **Decisions:** ADR-0005 (idempotency, webhook conventions), DECISIONS rows 15 and 19, ADR-0002 (writes go through to the case system synchronously), Gate 3a row 24 (retry only idempotent writes).
- **Traceability:** A3 and A5 (implementation), B1 (item 3 plus the webhook sender), the Part B ACs on idempotent comments and webhook verification.

## 1. Problem
`POST /v1/cases/{caseId}/comments` must be safe to retry: a client that times out and sends again must not create a second comment. The `case.escalated` webhook needs a sender that signs, delivers and retries. The brief asks for a sender or a receiver; we build the sender, because escalate (Part C) must send `case.escalated`, plus the verification function a receiver runs, which the tests use to prove the signatures. Escalate itself comes in Part C; this spec builds the delivery path it will use.

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
  - `in_flight`: 409 `request-in-progress`. An `in_flight` row older than 60 seconds (well past the 10 s request budget) is treated as abandoned by a crashed request and may be taken over. Like an expired key, an abandoned one counts as absent, so it is taken over whatever the new body (the hash rule below applies to live keys);
  - `completed`: replay the stored status, body and `Location`, with `Idempotent-Replayed: true`. The case system is not called.
- **What is stored:** only a successful create (201). Any failure deletes the `in_flight` row, so the client may retry with the same key.
- **The comment write is not retried automatically.** A POST to the case system isn't idempotent, so a retry could duplicate it (decision 24). It runs with the case-system timeout and breaker, as a single attempt.
- **The remaining gap, stated plainly:** if the case system creates the comment but its response is lost (a timeout), the key is released and a client retry creates a second comment. The platform can't tell whether the create landed. Closing that needs the case system's help (an external-ID upsert, or a lookup before retrying); most case systems don't offer it for comments, so it is documented, not built.
- **Missing header:** 400 `idempotency-key-required` (the validator's generic `validation-failed` is mapped for this header).
- **Author** is the token's `sub`: for agents, the user the agent acts for.
- **Upstream outcomes:** 201 → 201 with `Location: /v1/cases/{caseId}/comments/{commentId}`; a 404 → 404 `not-found`; other failures map as in S3 §2.3. The platform adds no rule on closed cases (decision 20).
- **Expiry:** an expired key is ignored on read and replaced on the next claim, so correctness never depends on cleanup. A periodic sweep (`DELETE … WHERE expires_at < now`, served by the `expires_at` index) is housekeeping, deferred.
- **Audit** of writes, with `sub` and `act.sub`, is built once in Part C, where the audit log is designed for tool calls.

### 2.2 Webhook subscription
- **One subscription, from the environment:** `WEBHOOK_URL` and `WEBHOOK_SECRET` (a Standard Webhooks secret, `whsec_` + base64). With no URL there is no subscription and nothing is enqueued. Start-up upserts it into `webhook_subscriptions` (event type `case.escalated`) and stops with a config error if the URL is set without a valid secret. `.env.example` carries an obviously fake development secret.
- **The secret stays in the environment:** the table's `secret_ref` holds the variable's name, never the secret.
- One subscription per deployment is enough here; a subscription API and secret rotation are deferred (the signature header is already a list, so rotation is additive).

### 2.3 Enqueueing events
- `enqueueEvent(db, type, data)` builds the Standard Webhooks envelope `{ type, timestamp, data }`, serialises it **once**, and inserts one `webhook_deliveries` row per active subscription to that event type, inside the caller's transaction. Escalate (Part C) calls it in the same transaction as its audit record, so an event is never lost or sent for a change that didn't happen.
- The stored `payload` is the exact bytes that are signed and sent; it is never re-serialised.
- Each row's `id` is the `webhook-id` (`msg_` + random), the same on every retry of that delivery.
- Escalate isn't built yet, so tests enqueue directly (the brief's "test-only trigger"). No HTTP endpoint triggers events.

### 2.4 Dispatcher
- Polls every `WEBHOOK_DISPATCH_INTERVAL_MS` (default 1000) for `status = 'pending' AND next_attempt_at <= now` (the injected clock), oldest first, up to 20 per tick. Ticks never overlap.
- **Each attempt:**
  - signs with a fresh `webhook-timestamp` (Unix seconds from the clock): `v1,` + base64(HMAC-SHA256(secret, `{id}.{timestamp}.{payload}`));
  - POSTs the stored bytes with `content-type: application/json`, a 15-second timeout, and redirects not followed;
  - **2xx:** `delivered`, with `delivered_at`.
  - **410:** the subscription is disabled (`active = 0`, `disabled_reason`) and the delivery is marked `dead`.
  - **anything else** (other status, timeout, network error): `attempt + 1`, `last_status` and `last_error` (status or error class only, never the response body), and `next_attempt_at` from the schedule.
- **Schedule:** retries after 5 s, 1 min, 5 min, 30 min, 2 h, 6 h and 14 h, each ±20% jitter (about 23 hours in total). After the last retry fails, the delivery is `dead`.
- Deliveries for disabled subscriptions are not attempted.
- **Shutdown:** the dispatcher stops polling and waits for in-flight attempts (bounded by their timeout) before the database closes.
- **One process.** With several instances, the poll would claim rows with `FOR UPDATE SKIP LOCKED` on Postgres (DECISIONS "Data model").

### 2.5 Receiver verification
- `src/events/verify.ts`: `verifyWebhook({ id, timestamp, signature, rawBody }, secret, now, seen)`, the verification a receiver should run:
  - all three headers present;
  - timestamp within 5 minutes of `now`, in either direction;
  - an HMAC over `{id}.{timestamp}.{raw body}`, compared in constant time with each `v1,` entry of the header;
  - verified against the raw bytes, never a re-parsed body;
  - a `webhook-id` already in `seen` is reported as a duplicate (to acknowledge, not process).
- The tests run it inside a small test receiver (raw-body parsing, then `verifyWebhook`), against which the dispatcher delivers. No runnable receiver app ships (the brief asks for a sender or a receiver).

### 2.6 Config
New variables, validated at start-up: `WEBHOOK_URL` (optional), `WEBHOOK_SECRET` (required with a URL) and `WEBHOOK_DISPATCH_INTERVAL_MS` (default 1000).

**Out of scope:**
- escalate and the `case.escalated` payload's content (Part C);
- a separate transactional outbox and broker (the deliveries table and dispatcher already act as the local queue for this event);
- a subscription management API, secret rotation, manual redelivery tooling for dead deliveries, a sweep of expired keys and a runnable receiver app (deferred);
- audit of writes (Part C);
- ordering guarantees (the contract says none).

## 3. Acceptance criteria

| ID | Criterion |
|---|---|
| S4-1 | A comment create returns 201 with the canonical `Comment` and a `Location`. The same key and body again returns the identical status, body and `Location` with `Idempotent-Replayed: true`, and the case system is not called a second time. |
| S4-2 | The same key with a different body gets 422 `idempotency-key-reused`. A missing key gets 400 `idempotency-key-required`. |
| S4-3 | Two concurrent requests with the same key: exactly one reaches the case system; the other gets 409 `request-in-progress` (or, if it arrives after completion, the replay). |
| S4-4 | Keys are scoped: the same key from another client, another user or another case is a new request. An expired key is a new request. |
| S4-5 | A failed create stores nothing, so a retry with the same key proceeds. The comment write is attempted once (never retried automatically). |
| S4-6 | An enqueued event is delivered to each matching active subscription with `webhook-id`, `webhook-timestamp` and `webhook-signature`, and the bytes received equal the stored payload. |
| S4-7 | `verifyWebhook` accepts a real delivery from the dispatcher and rejects a tampered body, the wrong secret, a timestamp outside 5 minutes, and flags a replayed `webhook-id` as a duplicate. |
| S4-8 | A failing receiver gets retries on the documented schedule (checked on the injected clock, jitter within ±20%), and the delivery becomes `dead` after the last retry. A 410 disables the subscription and stops delivery. A 2xx stops retries. |
| S4-9 | Delivery state and logs never contain the receiver's response body or the secret. Shutdown stops the dispatcher and waits for in-flight attempts. |

## 4. Sabotage checks (each must make a test fail)
- Drop the request-hash comparison (a different body replays the first response).
- Leave the client out of the key scope.
- Check-then-insert instead of the atomic claim (S4-3 fails under concurrency).
- Store failed responses (a retry after a failure replays the error).
- Retry the comment write automatically.
- Sign without the timestamp, or over a re-serialised body.
- Skip the timestamp tolerance or the `webhook-id` duplicate check in `verifyWebhook`.
- Retry after a 410, or never mark a delivery `dead`.

Constant-time comparison is verified by reading, as in S2 (timing isn't test-detectable).

## 5. Decisions taken in this spec (to confirm by merging)
1. **Only successful creates are stored;** failures release the key. Replaying a stored error would force a new key, and a new key is how duplicates happen.
2. **No upstream dedupe:** the comment write is a single attempt, and a create that landed upstream but timed out can be duplicated by a client retry. Closing that gap is the case system's job (external-ID upsert), which comment APIs rarely offer; documented, not built.
3. **An `in_flight` key is abandoned after 60 seconds,** so a crash mid-request can't block the key for 24 hours.
4. **One webhook subscription, defined by environment variables;** the database holds the secret's variable name, never the secret. Rotation and a subscription API are deferred.
5. **A fresh signature per attempt** (Standard Webhooks signs the attempt's timestamp), over bytes serialised once at enqueue.
6. **A duplicate `webhook-id` should be acknowledged with a 2xx,** not an error, so a sender that missed the first 2xx stops retrying (documented on `verifyWebhook`).
7. **No breaker on webhook delivery:** the retry schedule already spaces attempts out, and one receiver's outage mustn't pause the others.
