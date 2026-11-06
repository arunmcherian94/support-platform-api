# ADR-0005: API contract conventions

- **Status:** Accepted (2026-11-06, Gate 2a)
- **Deciders:** @arunmcherian94 (repository owner)

## Context
Part A asks for a contract-first OpenAPI spec that shows decisions on:
- resource modelling;
- errors;
- versioning;
- authorization;
- idempotency, concurrency and rate limits;
- the webhook.

Three groups of consumers read the contract:
- **Apps and iPaaS flows** need predictable, standard behaviour.
- **Agents** (through the MCP server) need errors they can act on.
- **Reviewers** need every decision visible in `openapi.yaml` itself.

The guiding rule at this gate was **standard practice first**. We add a field or header only when no standard covers the need.

## Decision

### Resources
- Canonical, platform-owned shapes: `Customer`, `Case`, `Comment`, `Escalation`. No upstream shape is exposed.
- **`Customer` is an aggregate** (entitlement plus a usage summary), because consumers want the joined view and the join has rules (precedence, staleness).
- **Cases are exposed as a resource** backed by the case system, enriched with a small `account` summary (name, tier, renewal).
- **`GET /v1/cases/{caseId}`** is added beyond the minimum. It is the way to obtain a case's current `ETag` before escalating.
- **Escalation** is a flag-like sub-object on the case (`escalation`, `null` until set). Status stays `open`, `in_progress` or `closed`.
- `POST …/escalate` is a state-transition action (a "custom method" in Google AIP-136 terms), as the brief names it.

### Errors (RFC 9457)
- Every non-2xx response is `application/problem+json`.
- The **`type` URI is the machine-readable identifier**. We add no separate `code` field, and no `retryable` flag.
- **Retry semantics** come from the status code plus `Retry-After` (RFC 9110).
- **Extensions:** `errors[]` with `pointer` and `detail` (the shape of RFC 9457's own example), and `correlationId`.
- **A distinct `type` exists only where one status calls for different client actions:**
  - 400: `validation-failed`, `invalid-cursor`, `idempotency-key-required`;
  - 409: `request-in-progress`, `invalid-state`;
  - 422: `idempotency-key-reused`, `escalation-not-allowed`;
  - 503: `upstream-unavailable`, `entitlement-stale`.
- **Request validation is 400.** 422 is kept for what the idempotency draft and the escalation policy define.
- 401 and 403 carry `WWW-Authenticate` per RFC 6750. 403 uses `error="insufficient_scope"`.
- The MCP layer derives a `retryable` signal for tools from the status code. The REST contract doesn't carry it.

### Versioning and deprecation
- Major version in the path (`/v1`), the most widely used scheme and the simplest for gateways and iPaaS connectors.
- Within a major version, changes are additive only, and clients must ignore unknown fields.
- A breaking change means `/v2`, with at least 6 months of overlap for internal consumers.
- **Deprecation signals:** `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link: rel="deprecation"`.
- **CI:** Spectral governs style; breaking-change detection (oasdiff) runs in CI.

### Authorization
- **Scheme:** OAuth 2.0 bearer JWTs.
- **Scopes:** `customers:read`, `cases:read`, `cases:comment`, `cases:escalate`, `finance:read`.
- **ARR** is present only with `finance:read`. Without it, the field is **omitted** (not `null`), so consumers can't confuse "hidden" with "zero".
- **Agents** use a delegated token: `sub` is the user, `act.sub` is the agent. Its scopes are the intersection of the user's scopes and the agent's policy (Part C).

### Idempotency (draft-ietf-httpapi-idempotency-key-header-08)
- **Required only where a duplicate is a real side effect:** `POST /v1/cases/{caseId}/comments`.
- **Not on escalate.** The "not already escalated" rule and `If-Match` already make a repeat harmless: it returns 409 with the current escalation, so a retrying client can recognise its own.
- **Key scope:** client, user, endpoint and case, and key.
- **TTL:** 24h.
- **Outcomes:**
  - same key and same body: replay of the stored response (`Idempotent-Replayed: true`);
  - different body: 422;
  - still in flight: 409;
  - missing key: 400.

### Concurrency
- **Cases carry a strong `ETag`.** It is derived from an opaque concurrency token that each case-system adapter supplies: the upstream `version` today, a last-modified timestamp or another marker for other systems. The domain never interprets the token.
- **`If-Match` is required on escalate:** mismatch → 412, missing → 428.
- **Not on comments,** which are append-only. Not on the customer aggregate or on lists.
- **Conditional GETs (`If-None-Match`) are not offered:** computing the tag needs the upstream call anyway, so it would save bytes but not load.

### Rate limits
- `RateLimit-Policy` and `RateLimit` headers (draft-ietf-httpapi-ratelimit-headers-11) on every authenticated response.
- 429 with `Retry-After`.

### Pagination
- **Keyset cursor:** opaque base64url, not signed. Filters and authorization are re-applied on every request, so a tampered cursor can only reach data the caller may see anyway.
- **Cursor contents:** the last item's sort values and ID, a hash of the filter and sort set, and a format version.
- A cursor that is malformed or doesn't match the current filters → 400 `invalid-cursor`.
- `limit` is 1–100, default 25.

### Comments on closed cases
- The case system owns that rule; we add none. If the upstream rejects a comment, the adapter maps the rejection to our problem types.

### Escalation rules

| Priority | Platinum | Gold | Silver | Tier unknown |
|---|---|---|---|---|
| P1, P2 | allowed | allowed | allowed | allowed |
| P3, P4 | allowed | 422 | 422 | 422 |

- **Status:** must be `open` or `in_progress`; otherwise 409 `invalid-state`. An already-escalated case also gets 409.
- **Missing tier:** P3 and P4 need the tier, so stale entitlement data → 503 `entitlement-stale` for them. P1 and P2 don't need it and still proceed.
- **Reasons:** `sla_risk`, `customer_impact`, `renewal_risk`, `security`, `other`. A `note` is required when the reason is `other`.
- **`escalatedBy`** records `user` always. `agent` and `approvedBy` are present when an agent proposed the escalation and a human approved it.
- **The response is a synchronous 200,** because the upstream write is synchronous.

### Webhook `case.escalated` (Standard Webhooks)
- **Envelope:** `{type, timestamp, data}`.
- **Headers:** `webhook-id`, `webhook-timestamp`, `webhook-signature` (HMAC-SHA256 over `id.timestamp.body`; a space-separated, versioned list so secrets can rotate).
- **Payload, kept deliberately small:**
  - case ID, account ID, priority;
  - escalation reason, time and actor;
  - the case's `ETag` and a URL for the full case.

  It never carries ARR or free text, so a receiver can't get data its own scopes wouldn't allow.
- **Delivery:**
  - at least once, no ordering guarantee;
  - receivers dedupe on `webhook-id` and use the ETag and timestamp to discard stale events;
  - 15s timeout per attempt; 2xx means delivered; 410 disables the subscription;
  - retries after 5s, 1m, 5m, 30m, 2h, 6h and 14h (±20% jitter, about 23h in total), then dead-letter with manual redelivery.

## Alternatives considered
- **`code` and `retryable` extensions on problems:** common in practice, but `type` is the standard identifier and `Retry-After` the standard retry signal. Adding both would duplicate them.
- **422 for all semantic validation:** splits validation across two statuses for little client benefit.
- **Header or date-based versioning** (Stripe, GitHub): better for frequent small breaking changes with per-client pinning. It costs server complexity and fits gateways and iPaaS connectors less naturally.
- **Signed (HMAC) cursors:** they add a secret to manage and rotate, with no security gain while authorization is re-applied per request.
- **Idempotency keys on escalate:** they would add a stored response per escalation to protect against a duplicate that the state rule already prevents.
- **Fat webhook payloads:** convenient for iPaaS, but they leak data past the receiver's scopes and go stale. **Thin, IDs-only payloads:** force a call back for routing fields every flow needs.
- **`escalated` as a status:** it would collide with the work states (an escalated case is still open or in progress).

## Consequences
- The contract is larger than the minimum, but every decision is visible in `openapi.yaml`, and Spectral enforces the conventions (`.spectral.yaml`).
- Clients must read `type` to tell apart the paired statuses (409, 422, 503, 400). Agents get this through the MCP layer's structured errors.
- **Security.** ARR is omitted at the response boundary. Webhook payloads exclude sensitive and free-text data. Cursors carry no authority.
- **Performance.** No conditional GETs on cases; acceptable while case reads are single upstream calls.

## Sources (checked 2026-11-06)
- RFC 9457 (Problem Details), RFC 9110 (HTTP semantics, `Retry-After`, `If-Match`), RFC 6750 (bearer token errors), RFC 6585 (428, 429), RFC 9745 (`Deprecation`), RFC 8594 (`Sunset`).
- draft-ietf-httpapi-idempotency-key-header-08; draft-ietf-httpapi-ratelimit-headers-11.
- Standard Webhooks specification (standardwebhooks.com).
- Google AIP-136 (custom methods), AIP-158 (pagination), AIP-185 (versioning).

## Revisit when
- A consumer needs many small breaking changes: consider date-based versions.
- Cursors start carrying data the caller may not see: encrypt them, not just encode.
- Webhook consumers need ordering: add per-case sequence numbers or move to an event stream.
