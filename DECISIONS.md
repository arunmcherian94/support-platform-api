# Decisions

Key trade-offs, assumptions and what was skipped, recorded at the time each decision was made. Significant decisions link to an ADR in [`docs/adr/`](docs/adr/) with the full alternatives and sources.

## Decision log

| # | Decision | Why (short) | ADR |
|---|---|---|---|
| 1 | Node 26 LTS, TypeScript 6, Express 5 + `express-openapi-validator` | The running service must validate **responses** against the OAS 3.1 contract; Fastify only serialises against response schemas | [ADR-0001](docs/adr/ADR-0001-runtime-and-core-stack.md) |
| 2 | SQLite via built-in `node:sqlite` behind a repository layer | Zero ops and no native build; the schema ports to Postgres | ADR-0001 |
| 3 | MCP TypeScript SDK v2, spec 2026-07-28, stdio | Current stable line; the stateless spec's "server-minted handles as tool arguments" fits our pending-action approval design | ADR-0001 |
| 4 | Two passes: pass 1 builds what's required; outbox stretch only if time remains | Working core over breadth. Escalate is built minimally because the `escalate_case` tool needs a real endpoint | — |
| 5 | Ports and adapters; one mock process serving all three upstreams over HTTP, with fault injection | Vendor shapes stay at the boundary; a provider switch means a new adapter; resilience claims can be demonstrated | [ADR-0002](docs/adr/ADR-0002-upstream-integration-and-mocks.md) |
| 6 | Cases never cached; writes go through synchronously | Agents act on case state; stale state on a write path is worse than latency | ADR-0002 |
| 7 | Entitlement is a refreshed snapshot; 15-minute conditional polling; maximum staleness 48h (from the CSV export) before 503 | Exports are periodic files (assumed nightly CSV, hourly XML); polling faster buys no freshness; the last good snapshot gives stale-on-error fallback | [ADR-0003](docs/adr/ADR-0003-entitlement-snapshot-precedence-and-ids.md) |
| 8 | Field-level precedence: tier and renewal from XML when newer, else CSV; name and ARR from CSV only | Fresher data where it's fresher, system of record for money | ADR-0003 |
| 9 | Account IDs: canonical `ACC-NNN` plus an explicit crosswalk; unmatched IDs reported; no name matching | `ACC-77` vs `ACC-007` is a real mismatch that padding can't fix; a wrong join is worse than a reported gap | ADR-0003 |
| 10 | iPaaS consumes the API and (in production) runs bulk export ingestion; custom code owns rules, auth, guardrails, MCP | Each tool where it is strong | [ADR-0004](docs/adr/ADR-0004-ipaas-placement.md) |
| 11 | Entitlement required, usage optional in the customer aggregate | No customer without entitlement; usage loss → `degraded: true` | ADR-0002 |
| 12 | Errors: RFC 9457 with `type` as the identifier; no `code` or `retryable` extensions; 400 for request validation | Standard first: `type` and `Retry-After` already carry what those fields would | [ADR-0005](docs/adr/ADR-0005-api-contract-conventions.md) |
| 13 | Versioning: `/v1` in the path; additive changes only; `Deprecation` + `Sunset` headers; 6 months' overlap | Most common scheme; simplest for gateways and iPaaS connectors | ADR-0005 |
| 14 | ARR omitted (not nulled) without `finance:read` | "Hidden" must not read as "zero" | ADR-0005 |
| 15 | `Idempotency-Key` on comments only, 24h | Duplicate comments are a real side effect; escalate's state rule and `If-Match` already block repeats | ADR-0005 |
| 16 | Strong `ETag` from an adapter-supplied concurrency token; `If-Match` required on escalate only | The gap between reading and acting (stretched by human approval) is where stale decisions happen | ADR-0005 |
| 17 | Keyset cursors, opaque and unsigned, bound to filters and sort | Authorization is re-applied per request, so signing adds a secret without adding safety | ADR-0005 |
| 18 | Escalation is a sub-object, not a status; eligibility matrix by priority and tier; synchronous 200 | Escalated cases are still open or in progress; the upstream write is synchronous | ADR-0005 |
| 19 | `case.escalated`: Standard Webhooks; small payload (IDs, routing fields, actor; no ARR or free text); retries over about 23h, then dead-letter | Receivers fetch the rest with their own scopes | ADR-0005 |
| 20 | Comments on closed cases: no platform rule | The case system owns that rule | ADR-0005 |
| 21 | `GET /v1/cases/{caseId}` added | The way to get the `ETag` that escalate needs | ADR-0005 |
| 22 | Gate 3a: `make run` **and** `docker compose up` | `make` for development, Compose for reviewers | [S2](docs/specs/S2-platform-foundations.md) |
| 23 | Gate 3a: timeouts per upstream within an overall request budget | One slow optional upstream must not consume the whole request | read-path spec |
| 24 | Gate 3a: retries via cockatiel with backoff and jitter; reads and idempotent writes only; 429 honours `Retry-After` | Retrying a non-idempotent write can duplicate it | read-path spec |
| 25 | Gate 3a: a circuit breaker per upstream; the entitlement snapshot doubles as a stale-on-error fallback | Fail fast when an upstream is down; the snapshot design gives fallback for free (ADR-0003) | read-path spec |
| 26 | Gate 3a: validation driven by `openapi.yaml`; responses strict in dev/test/CI, log-only option in production | The contract is the runtime source of truth; contract drift shouldn't become an outage | S2 |
| 27 | Gate 3a: contract tests = response validation in every test, plus a local Schemathesis run | Schemathesis generates inputs nobody hand-picked; it needs the running stack, so it stays out of CI | — |
| 28 | Gate 3a: Postman collection generated from the spec, then functional and regression checks added; Newman run | Starts complete, then gains the checks that matter | — |
| 29 | Gate 3a: pino JSON logs, correlation ID plus `traceparent` | Required correlation, ready for tracing later | S2 |
| 31 | Response schemas are closed (`additionalProperties`/`unevaluatedProperties: false`), enforced at runtime and by a Spectral rule | An undeclared field such as ARR can't leak past the contract; clients still ignore unknown fields, so additions stay non-breaking | [ADR-0005](docs/adr/ADR-0005-api-contract-conventions.md) |
| 30 | Critical-tier specs ship in their own PR, merged before code | Approving a design and approving code are different acts; the merge makes the design decision durable and visible | CLAUDE.md §11 |
| 32 | Resilience numbers: 10 s request budget (configurable); cases 3 s × 3 attempts, warehouse 1.5 s × 2; breaker opens after 5 consecutive failures, half-open after 10 s; **429 counts as a breaker failure**, other 4xx never do | Few retries, so a struggling upstream isn't hammered; the optional warehouse fails fast to a degraded answer. The upstream's quota belongs to the platform, so a 429 means everyone slows down; per-caller limits must stay below each caller's share so one consumer can't open the breaker for all | [S3](docs/specs/S3-read-path.md) |
| 33 | Case search pushes every filter to the case system; tier and renewal filters become an account list (400 above 500 accounts) | The case system sorts and pages, so one page needs one upstream call, with no in-memory scan or record cap | S3 |
| 34 | Comment idempotency: atomic key claim; only successes stored; the upstream write is a single attempt, never retried | Failures release the key so the client can retry it. A create that lands upstream but times out can still be duplicated by a retry: closing that needs the case system (external-ID upsert), so it's documented, not built | [S4](docs/specs/S4-comments-and-webhooks.md) |

## Data quirks and how they're handled
- **Mixed casing in case JSON** (`Status`, `Comments` vs `openedAt`): normalised to canonical camelCase in the case adapter; upstream shapes never leave the adapter.
- **Inconsistent account IDs** (`ACC-77` vs `ACC-007`): see decision 9.
- **Comments have no IDs in the sample shape.** The case mock gives each comment an `id` (Salesforce's CaseComment has one), because the contract returns comment IDs.
- **Renewal in two sources** (`contract_end` vs `renewal`): see decision 8. Responses carry `source` and `asOf` for tier and renewal.
- **Monthly usage grain**: the summary returns the latest month plus a month-on-month trend, not raw rows.

## Assumptions
- Interpretation of the sample question (open statuses, strict 48h, inclusive 90-day window): [S1 §4](docs/specs/S1-upstream-sources-and-fixtures.md).
- Support tiers are `platinum`, `gold` and `silver`; the scenario names only Platinum.
- **Status and priority vocabularies** are inferred from one sample, which shows only `open` and `P1`. We assume `open`, `in_progress` and `closed`, and `P1`–`P4`.
- **Case change marker.** The sample case has no `version` or `updatedAt`. The mock adds a `version`, which becomes the ETag. For a provider without one, the adapter would hash the case's canonical fields. It would not use the latest comment's `at`: that changes only when a comment is added, so a priority change or a closure would keep the same ETag, exactly the changes `If-Match` exists to catch.
- **One row per account.** The sample has one CSV row per account. If an account appears more than once, the row with the latest `contract_end` wins and the duplicate is logged (ADR-0003 §4). The fixtures include an older, expired contract for ACC-012 to prove it.
- **Contract end stands in for renewal.** Notice periods aren't modelled; an explicit XML `renewal` takes precedence when newer.
- **XML timestamp.** The sample XML fragment has no root element or timestamp; the fixture adds `<entitlements generatedAt=…>`. A feed without one would fall back to the HTTP `Last-Modified` date or the fetch time.
- **Usage lags by up to a month.** Months are reported once closed, so at the fixture date (6 Nov) the latest month is October. Responses carry `latestMonth`, and consumers should present it as "as of October", not as current.
- **The sample question asks for customers.** The answer is four accounts (ACC-007, ACC-012, ACC-030, ACC-042), each with its qualifying cases, not a list of five case IDs.
- **Account IDs in the API are canonical only** (`ACC-NNN`). ERP IDs such as `ACC-77` are resolved internally and never exposed. Passing one gets a 400 (see Skipped for the lookup we'd add).
- Export cadence: nightly CSV, hourly XML (ADR-0003).

## Data model
SQLite via `node:sqlite`: zero ops, a single file, built into Node, and WAL mode lets reads proceed during writes. All SQL lives in the repository layer, so moving engines touches one place. Tables are `STRICT`; times are RFC 3339 UTC text; migrations are numbered `.sql` files applied once each, in order, in their own transaction.

| Table | Purpose | Primary key and why | Indexes and the query each serves | Retention |
| --- | --- | --- | --- | --- |
| `idempotency_keys` | Replay or reject repeated writes | `(client_id, sub, endpoint, key)`: keys are scoped to caller and endpoint, so one client can never collide with or read another's | `expires_at`: the sweep `DELETE ... WHERE expires_at < now` | 24 hours, then swept |
| `audit_log` | Who did what to which resource | `id` (autoincrementing): a total order for an append-only log | `(resource_type, resource_id, at)`: history of one case or account. `(actor_sub, at)`: what a user did. `(actor_agent, at)`: what an agent did | Kept. Triggers reject UPDATE and DELETE. In production, shipped to an immutable store with its own retention |
| `webhook_subscriptions` | Registered receivers | `id`: the handle in the API | None: the table is small and read whole when fanning out. `secret_ref` points at a secret, never holds one | Until deleted |
| `webhook_deliveries` | Outbox: one row per event per subscription, with the exact signed bytes | `id`: it is the `webhook-id` receivers use to dedupe | `(status, next_attempt_at)`: the worker's "pending and due" poll | 30 days after delivered or dead |

Postgres path: the same tables with native types (`timestamptz`, `jsonb`, `bigint`); append-only enforced by `REVOKE UPDATE, DELETE` instead of triggers; the delivery index becomes a partial index on `status = 'pending'`; sweeping runs as a scheduled job; the outbox poll uses `FOR UPDATE SKIP LOCKED` so several workers can share it.

## Skipped, and how I'd do it with more time
_Filled in as items are deferred; the final list mirrors the traceability matrix._

- **Looking up customers by the IDs and names users know.** Users more often know the ERP's ID (`ACC-77`), or the customer's name, than our canonical ID. Today the API accepts only canonical IDs. With more time:
  - accept known aliases on `GET /v1/customers/{id}`, resolved through the crosswalk, and return the canonical `id` in the response;
  - add `GET /v1/customers?q=` returning ranked candidates (exact alias, name prefix, fuzzy name), each with its match type, for the user or agent to confirm.

  Fuzzy matching is only ever for **search**, never for **joins** between systems: a wrong join silently attaches one customer's tier and ARR to another (ADR-0003).
- **Rate limits per user, not just per client and agent.** Buckets are keyed by client and by agent, so every user of a client shares one bucket, and an agent's bucket spans all its users. To revisit in Part C with the agent's delegated identity (e.g. agent + user keys).
- **Distributed rate limiting.** Buckets are in memory, per instance: N replicas allow N times the quota. In production the gateway or a shared store (Redis) enforces the limit; this service keeps per-agent limits as defence in depth.
- **JWKS stale-on-error.** Keys are cached for an hour; an identity provider outage longer than that gives 503. With more time, keep the last good key set for a bounded period beyond that.
- **Access-token hardening for a real IdP:** require `typ: at+jwt` (RFC 9068) and a maximum token age.
- - **Comment paging.** `GET /v1/cases/{caseId}` returns the newest 50 comments plus `commentCount`. A `GET /v1/cases/{caseId}/comments?cursor=` sub-collection is an additive change when a consumer needs older comments.
