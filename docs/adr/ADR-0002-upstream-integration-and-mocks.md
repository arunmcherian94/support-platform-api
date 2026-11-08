# ADR-0002: Upstream integration pattern and mock upstreams

- **Status:** Accepted (2026-11-06, Gate 1)
- **Deciders:** @arunmcherian94 (repository owner)

## Context
The platform fronts three systems with different interfaces:
- a SaaS case system (Salesforce-like REST);
- an ERP entitlement system (CSV export plus an XML feed);
- a usage warehouse (Snowflake-like SQL).

All three are mocked locally. The design must:
- keep vendor shapes out of our canonical model;
- let us switch a provider without rewriting domain code;
- let us demonstrate timeouts, retries, breakers and degraded mode on demand.

It serves two consumer types:
- **Apps and iPaaS flows** need stable, versioned shapes.
- **Agents** need more than fresh data. What the integration layer owes them:
  - fresh case state, and the age (`asOf`) of anything that isn't fresh;
  - partial results that say so (`degraded`, per-source status), never silently missing data;
  - upstream free text kept separate from our own fields, so the MCP layer can treat it as untrusted;
  - errors mapped to stable failure classes (retryable or not, `Retry-After`), so a tool can tell the model what to do next;
  - writes that are safe to retry (idempotency keys, `version`-based concurrency).

  The agent-facing parts that sit above the API (delegated identity, approval, output caps, redaction) are decided in Part C.

## Decision

**Ports and adapters.** There is one port per upstream capability:

| Port | Operations (indicative) | Adapter responsibility |
|---|---|---|
| `CaseSystem` | search cases, get case, add comment, escalate | Normalise mixed casing (`Status`, `Comments` → canonical camelCase), map upstream errors to our failure classes, resilience policy |
| `EntitlementSource` | current snapshot (accounts by canonical ID, with `asOf` per source) | Parse CSV + XML, apply precedence and ID normalisation (ADR-0003) |
| `UsageWarehouse` | monthly usage for one account, last N months | Parameterised SQL, map rows to canonical usage, resilience policy |

Domain code depends only on ports. Switching to ServiceNow or another ERP means writing a new adapter.

**One mock process, three upstreams, all over HTTP:**

| Upstream | Mock interface | Notes |
|---|---|---|
| Case system | `GET /cases` (upstream filters: status, priority, opened range), `GET /cases/{id}`, `POST /cases/{id}/comments`, `PATCH /cases/{id}` | `PATCH` only accepts the escalation fields and requires the current `version`. It exists because our escalate endpoint (Part C) writes through to the case system, as a Salesforce record update would. Returns one page per query; the platform pages by keyset (sort plus the last row's value and ID). Each case has a monotonic `version`. Can return 429 with `Retry-After`. |
| Entitlement system | `GET /exports/accounts.csv`, `GET /feeds/entitlements.xml` | Export timestamp in a response header (CSV) or root attribute (XML), used as `asOf`. |
| Usage warehouse | `POST /api/v2/statements` with `{ statement, bindings }`, backed by a SQLite file | Mirrors the shape of Snowflake's SQL REST API, so the warehouse gets real network timeouts and the same fault injection as the others. |

**Fault injection** is per upstream, set by env at start-up or at runtime through a mock admin endpoint: added latency, forced status (e.g. 503, 429) and down.

**Data access per upstream:**
- **Cases are not cached.** Agents act on case state, so every read goes upstream. Writes (comment, escalate) go through to the case system synchronously; we never own case state. Our ETag is opaque, derived from the upstream `version`.
- **`GET /v1/cases` joins across systems in process.** It fetches with the upstream filters the case system supports, joins tier and renewal from the entitlement snapshot in memory, applies the cross-system filters, then sorts and pages with our keyset cursor.
- **Usage** queries a pre-aggregated monthly table: the last 3 months for one account, indexed on `(account_id, month)`. The response is a summary (latest month plus month-on-month trend), not rows.

**Required vs optional upstreams for `GET /v1/customers/{id}`:**
- Entitlement is **required**: without it there is no customer (name, tier, renewal).
- Usage is **optional**: if it fails, we return 200 with `degraded: true` and the failed source marked in `sources[]`.
- Cases are not part of the customer aggregate.

## Alternatives considered
- **Adapters read fixture files or the SQLite file directly.** Simpler, but there's no network boundary, so timeouts, retries and breakers can't be demonstrated honestly against the warehouse.
- **A separate mock process per upstream.** More realistic, more moving parts for a reviewer's `make run`. One process with three route groups and independent fault controls gives the same behaviour.
- **Cache cases (TTL).** Rejected: agents would act on stale status; staleness on writes is worse than latency.
- **Pre-join into a read model now** (CDC from upstreams into an indexed projection). It's the right production answer for cross-system filters at scale, but too much for this scope. Deferred and documented.

## Consequences
- **Performance.** `GET /v1/cases` with cross-system filters fetches more cases than it returns. That's fine at mock scale; at production scale it becomes an upstream-load and latency problem, hence the read model on the defer list.
- **Resilience.** Every upstream call crosses HTTP, so every claim about resilience can be demonstrated with a command against the mocks.
- **Security.** The warehouse adapter only ever sends parameterised statements from a fixed allow-list. Statement text never comes from API input.

## Revisit when
- Cross-system filtering needs more than one upstream page per request on average: build the read model.
- A real provider's API forces a capability the port doesn't express.
