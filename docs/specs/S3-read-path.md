# S3 — Read path

- **Status:** Implemented (PRs #10 and 5b). Approved by merging #9.
- **Decisions:** ADR-0002 (ports and adapters, required vs optional upstreams), ADR-0003 (entitlement snapshot, precedence, IDs), ADR-0005 (contract conventions), Gate 3a rows 23–25 in DECISIONS.md (timeouts, retries, breakers).
- **Traceability:** A1, A2 (implementation), A9 (ARR by scope), B1 (items 1–2), B4, B5, B9 (propagation to upstreams), the Part B ACs on degraded mode, resilience, ARR and the Copilot question.

## 1. Problem
The contract defines `GET /v1/customers/{customerId}`, `GET /v1/cases` and `GET /v1/cases/{caseId}`. Today they return 500 because no handler exists. Building them needs:
- adapters that turn three upstream shapes into the canonical model;
- an entitlement snapshot that applies the precedence and ID rules;
- resilience on every upstream call, with failures mapped to the contract's problem types;
- a cross-system join and keyset cursor for case search.

The sample question has a fixed answer (S1 §4). This spec is done when the API returns that answer.

## 2. Scope

### 2.1 Ports and adapters (`src/ports/`, `src/adapters/`)
| Port | Operations | Adapter does |
|---|---|---|
| `CaseSystem` | `search(query)` returns one sorted page (filters, account list, sort, "after" position, limit); `get(caseId)` | Normalises mixed casing (`Status`, `Comments`) to the canonical model; ETag = `"` + base64url(`caseId:version`) + `"`; maps upstream errors to failure classes (§2.3) |
| `EntitlementSource` | `snapshot()` returns the last good snapshot and its health | Fetches the CSV and XML, parses, normalises IDs and applies precedence (§2.2) |
| `UsageWarehouse` | `monthlyUsage(accountId, months)` | Sends the one allow-listed parameterised statement (`LIMIT 2`); maps rows to canonical usage |

Domain code (joins, filters, the usage trend, cursors) lives in `src/domain/`, has no I/O, and reads time only from the injected clock.

### 2.2 Entitlement snapshot (ADR-0003, as built)
- **Loaded at start-up, then polled** every `ENTITLEMENT_REFRESH_SECONDS` (default 900) with a plain fetch; an unchanged body keeps the current snapshot. `asOf` comes only from the source's own time (`X-Export-Timestamp`, `generatedAt`); a feed without it counts as a failed refresh. Start-up does not wait for or require the first load: until it succeeds, readiness reports the snapshot `unavailable`.
- **IDs:** crosswalk first, then the canonical format (`ACC-` + at least three digits). An ID that fits neither is logged as a data-quality event and left out.
- **Duplicates:** the row with the latest `contract_end` wins; each duplicate is logged.
- **Precedence per field:** tier and renewal from the XML when the feed's `generatedAt` is newer than the CSV export's time, otherwise from the CSV. Name and ARR come only from the CSV.
- **Staleness:** the snapshot is unusable when it never loaded or the CSV export is older than 48 hours. A failed refresh keeps the last good snapshot, and the affected source reports `stale` in `sources[]`.
- **Unmatched IDs:** XML accounts with no CSV row, and case account IDs with no entitlement record seen during reads, are logged as data-quality events: XML-only accounts on each rebuild, case accounts once per ID (again if the ID gains a record and later loses it). They are not listed on `/readyz`, which needs no authentication.
- **ARR stays in the snapshot.** Whether a response includes it is decided at the response boundary (§2.4), never in the snapshot.

### 2.3 Resilience (cockatiel 4.0.0, Gate 3a)
Each upstream gets its own policy: a timeout per attempt, retries, and a circuit breaker. The whole request has a **10 second budget** (`REQUEST_BUDGET_MS`, so it can be set below whatever gateway or agent timeout sits in front): a retry starts only if its timeout fits in the time left.

| Upstream | Timeout per attempt | Retries | Breaker |
|---|---|---|---|
| Case system (required) | 3 s | 2 (3 attempts) | Opens after 5 consecutive failures; half-open after 10 s |
| Usage warehouse (optional) | 1.5 s | 1 (2 attempts) | Same |
| Entitlement (background poll, not on the request path) | 5 s | 2 | None: the snapshot is the fallback |

- **Backoff:** exponential from 100 ms, full jitter, capped at 1 s.
- **Retries are few on purpose:** each one adds load to an upstream that is already struggling. The optional warehouse gets one, because its latency is the customer summary's latency and a degraded answer beats a late one.
- **Retried, and counted as breaker failures:** timeouts, network errors and 5xx.
- **429 also counts as a breaker failure.** The upstream sees one caller (the platform's integration credential with its shared quota), so a 429 means the platform as a whole must slow down. It is retried only after its `Retry-After`, and only if that fits in the budget; otherwise 503 `upstream-unavailable` with the upstream's `Retry-After` passed on. One heavy consumer could still use up the shared quota and open the breaker for everyone: the guard is our per-client and per-agent limits, which must stay below each caller's share of the upstream quota (PLATFORM.md). With per-user upstream credentials this would change: 429 would stop counting, and only the affected user would back off.
- **Never retried and never counted:** other 4xx. A 404 is an answer, not an outage. Any other 4xx means our request was wrong, so it is logged and becomes a 502.
- **Breaker transitions** (closed → open → half-open → closed) are logged with the upstream's name.
- **Mapping to problems,** for a required upstream:

| Outcome | Problem |
|---|---|
| Breaker open, or connection refused after retries | 503 `upstream-unavailable`, `Retry-After` = the half-open delay (10 s), an upper bound: cockatiel doesn't expose when the breaker opened |
| Timeout after retries, or budget exhausted | 504 `upstream-timeout` |
| 5xx after retries, unexpected 4xx, or an unparseable body | 502 `upstream-error` |

- **Propagation:** every upstream call carries `X-Request-Id` (the correlation ID) and a `traceparent` with our trace ID and a new span ID.
- Upstream bodies are never logged or returned, only status and error code (S2 logging rule).

### 2.4 `GET /v1/customers/{customerId}`
- **Entitlement is required.** If the snapshot is unusable, the response is 503 `entitlement-stale`. An account not in the snapshot gets 404.
- **Usage is optional.** The warehouse fails → `usage: null`, `degraded: true`, source `unavailable` with `asOf: null`. No rows → `usage: null`, source `no_data`, not degraded.
- **Usage summary:** the latest month and the change from the previous month, as a percentage with one decimal. `changeFromPreviousMonthPct` is null with no previous month, or when any previous value is 0. The usage source's `asOf` is the first day of the month after `latestMonth` (when that month closed).
- **ARR only with `finance:read`.** Without it, `arr` is omitted (not nulled), and `arr` is left out of the export source's `fields`. A test asserts the body never contains the ARR amount.
- **`sources[]`:** export, feed and warehouse, each with `status`, `asOf` and the `fields` it supplied. The feed is `no_data` when the XML has no row for the account.

### 2.5 `GET /v1/cases`
Every filter runs in the case system, so it returns exactly one page and nothing is scanned in memory.
1. **Entitlement filters become an account list.** `accountTier` and `renewalWithinDays` (today through today + N days, UTC dates, inclusive, "today" from the injected clock) are resolved against the snapshot into the matching canonical account IDs, intersected with `accountId` if given. An empty list returns an empty page without calling upstream. More than **500 accounts** gets 400 `validation-failed` asking for narrower filters, because the upstream query would be too long; the fix at that scale is a joined read model (ADR-0002).
2. **One upstream query** with status, priority, opened range, the account list, the sort (case ID as tie-break; `priority` ascending means P1 first), the cursor's "after" position and `limit + 1` (the extra record says whether a next page exists). Salesforce queries support all of these (`IN`, `ORDER BY`, keyset `WHERE`), so the mock case system gains a repeatable `accountId`, a sort and an "after" parameter.
3. **Join `account`** (name, tier, renewal) from the snapshot onto the page. A case whose account has no entitlement record gets `account: null` and is reported as unmatched; it can never match an entitlement filter, since its account is not in the list.

- **Cursor:** base64url JSON `{ v: 1, k: [sortValue, caseId], f: fingerprint }`, unsigned (decision 17). The fingerprint is a SHA-256 over the normalised filters, the sort, and the date that `renewalWithinDays` was resolved against. A different fingerprint, or a cursor that can't be decoded, gets 400 `invalid-cursor`. `limit` may change between pages.
- **Keyset semantics:** a case created or changed behind the cursor's position after the first page isn't seen until the next search. That is standard for keyset paging and is documented in the operation description.
- **Entitlement unusable:** without entitlement filters → 200 with `account: null` on every case, `degraded: true`, and entitlement sources `stale` or `unavailable`. With an entitlement filter → 503 `entitlement-stale`, because filtering without the data would silently drop matches (already in the contract).
- **`sources[]`:** `case_system` with `asOf` = now (read live), plus the export and the feed.

### 2.6 `GET /v1/cases/{caseId}`
- A live read; `ETag` header from the adapter. Upstream 404 → 404 `not-found`.
- The newest 50 comments (newest last) and `commentCount` (the total).
- `account` is joined from the snapshot; null when the snapshot is unusable or the account has no record. `CaseDetail` has no `degraded` field, so a null `account` is the signal.

### 2.7 Readiness (completes S2's interim checks)
- `entitlementSnapshot`: `ok` when usable; `unavailable` fails readiness (503).
- `caseSystem` and `usageWarehouse` come from their breaker state, not a live probe: closed = `ok`, half-open = `degraded`, open = `unavailable`. They never fail readiness, so a dependency's outage doesn't take every replica out of rotation.

### 2.8 Config
New variables, validated at start-up: `ENTITLEMENT_REFRESH_SECONDS` (≥ 1) and `REQUEST_BUDGET_MS` (default 10000). Upstream base URLs already exist. Per-attempt timeouts and retry counts are constants in one file, not env: they're design decisions, reviewed with the code. The budget is env because it depends on what sits in front of the service.

**Out of scope:**
- comments and the write path (the comments PR);
- escalate (Part C);
- a read model for cross-system filters at scale (deferred, ADR-0002);
- caching cases (rejected, decision 6);
- searching customers by alias or name (deferred, DECISIONS "Skipped");

## 3. Acceptance criteria

| ID | Criterion |
|---|---|
| S3-1 | **The Copilot question:** the query in the `listCases` description, at the fixture clock, returns exactly CS-10231, CS-10233, CS-10236, CS-10239 and CS-10240, checked against the S1 ground truth through the real server and mocks. |
| S3-2 | Entitlement precedence and IDs work end to end: ACC-030's renewal comes from the XML, ACC-042's tier from the XML, ACC-77 appears as ACC-007, and ACC-012 uses its latest contract. Each response shows the `source` and `asOf` it used. |
| S3-3 | `GET /v1/customers/ACC-007` returns `arr` with `finance:read` and omits it without; the body without the scope contains no ARR amount. |
| S3-4 | Warehouse down → 200, `usage: null`, `degraded: true`, warehouse source `unavailable`. ACC-015 (no usage rows) → `usage: null`, source `no_data`, `degraded: false`. |
| S3-5 | Snapshot never loaded or CSV older than 48h → `getCustomer` gives 503 `entitlement-stale`; `listCases` with an entitlement filter gives 503 `entitlement-stale`; without one, 200 with `account: null` and `degraded: true`. A failed refresh keeps the last good snapshot and marks the source `stale`. |
| S3-6 | Retries happen only for timeouts, network errors, 5xx and 429, at most 2 for cases and 1 for the warehouse, and only within the request budget; a 4xx is never retried. 429 waits for `Retry-After`, or gives 503 with `Retry-After` when that doesn't fit in the budget. Backoff is exponential with jitter. |
| S3-7 | The breaker opens after 5 consecutive failures, goes half-open after 10s, and closes on a successful probe. Each transition is logged. 429s count toward opening it; other 4xx never do. A test drives open → half-open → closed with fake timers (cockatiel's breaker reads the system clock, not the injected one). |
| S3-8 | Failures map to problems as in §2.3: breaker open → 503 with `Retry-After`; timeout → 504; 5xx or a bad body → 502. No upstream body reaches the response or the logs. |
| S3-9 | Paging through the Copilot query with `limit=2` returns all five cases exactly once, in order. A cursor reused with a changed filter or sort, or a tampered cursor, gets 400 `invalid-cursor`. Ties on `openedAt` are ordered by case ID. Entitlement filters reach the mock as an account list (no full scan); more than 500 matching accounts gets 400. |
| S3-10 | Filter boundaries hold: `openedBefore` is exclusive and `openedAfter` inclusive (a case opened exactly at the bound); `renewalWithinDays=89` includes ACC-012 and excludes ACC-015; a renewal in the past never matches. |
| S3-11 | `GET /v1/cases/CS-10231` returns the canonical case, an `ETag` derived from its version, comments newest last, and `commentCount`. Unknown case → 404. No upstream field names (`Status`, `Comments`) appear in any response. |
| S3-12 | `/readyz` reports the snapshot and the breaker states, and fails only on the database or the snapshot. A read that sees ACC-099 logs it as unmatched; `/readyz` lists no account IDs. |
| S3-13 | Upstream calls carry `X-Request-Id` and `traceparent`, checked at the mock. |
| S3-14 | Every response in these tests passes strict response validation (closed schemas), as for all tests. |

## 4. Sabotage checks (each must make a test fail)
- Make `openedBefore` inclusive, or change the renewal window by one day.
- Ignore precedence (CSV only) or skip the crosswalk.
- Return ARR without checking `finance:read`.
- Count a 4xx other than 429 toward the breaker, or retry a 4xx.
- Ignore `Retry-After` on 429.
- Leave the filters out of the cursor fingerprint.
- Drop the account list from the upstream query (the tier and renewal filters stop applying).
- Treat the warehouse as required (a 503 instead of degraded).

## 5. Decisions taken in this spec (to confirm by merging)
1. **Request budget 10 s (configurable); per attempt 3 s × 3 attempts for cases, 1.5 s × 2 for the warehouse.** Worst cases, not typical latency; PLATFORM.md sets latency targets from upstream SLOs.
2. **Breaker: 5 consecutive failures, 10 s half-open.** Consecutive, not a rate, because it's easy to explain and test. A sampling breaker (failure rate over a window) is the production choice at real traffic.
3. **A 429 counts toward the breaker,** because the upstream's quota is the platform's, shared by every caller; per-caller limits keep one consumer from using it all. An unexpected 4xx becomes a 502 without counting: our bug shouldn't open a circuit against a healthy upstream.
4. **Search pushes every filter to the case system,** turning entitlement filters into an account list (400 above 500 accounts). The case system sorts and pages, so there is no in-memory scan or record cap.
5. **The cursor binds the date `renewalWithinDays` was resolved against,** so a cursor from yesterday gets `invalid-cursor` instead of a page computed with a different window.
6. **Readiness reads breaker state rather than probing upstreams,** and only the database and snapshot fail it.
7. **The snapshot loads in the background;** start-up doesn't block on the ERP.
