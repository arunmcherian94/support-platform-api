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

## Data quirks and how they're handled
- **Mixed casing in case JSON** (`Status`, `Comments` vs `openedAt`): normalised to canonical camelCase in the case adapter; upstream shapes never leave the adapter.
- **Inconsistent account IDs** (`ACC-77` vs `ACC-007`): see decision 9.
- **Renewal in two sources** (`contract_end` vs `renewal`): see decision 8. Responses carry `source` and `asOf` for tier and renewal.
- **Monthly usage grain**: the summary returns the latest month plus a month-on-month trend, not raw rows.

## Assumptions
- Interpretation of the sample question (open statuses, strict 48h, inclusive 90-day window): [S1 §4](docs/specs/S1-upstream-sources-and-fixtures.md).
- Support tiers are `platinum`, `gold` and `silver`; the scenario names only Platinum.
- Export cadence: nightly CSV, hourly XML (ADR-0003).

## Skipped, and how I'd do it with more time
_Filled in as items are deferred; the final list mirrors the traceability matrix._
