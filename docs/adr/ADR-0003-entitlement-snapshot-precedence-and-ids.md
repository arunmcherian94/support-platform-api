# ADR-0003: Entitlement data — snapshot access, source precedence and account IDs

- **Status:** Accepted (2026-11-06, Gate 1)
- **Deciders:** human owner

## Context
Entitlement data comes from two feeds:
- a **CSV export** from the ERP, the system of record: name, tier, contract end, ARR;
- an **XML feed** with tier and renewal, which refreshes more often.

The sample data has two problems:
1. **Renewal appears in both.** It's `contract_end` in the CSV and `renewal` in the XML, and the two can disagree.
2. **Account IDs don't reconcile.** The CSV has `ACC-77`; every other system has `ACC-007` for what is clearly the same account (Acme Corp, Platinum, 2027-01-15). Zero-padding cannot fix this: `ACC-77` padded to three digits is `ACC-077`, not `ACC-007`. It is a genuine ID mismatch between systems, not a formatting variant.

Agents must know how old data is before acting on it, and Finance needs ARR from the system of record.

## Decision

**1. Snapshot access, not a fetch per request.**
- The adapter loads both feeds at start-up and refreshes on an interval (default 5 minutes in dev).
- Requests read the last good snapshot.
- If a refresh fails, we keep serving the last good snapshot, and `asOf` shows its real age. That makes stale-on-error a fallback built into the design.
- "Entitlement unavailable" means one of two things: no snapshot has ever loaded, or the snapshot is older than the **maximum staleness of 24 hours**. Either returns a documented 503 problem response.

**2. Field-level precedence.**

| Field | Source |
|---|---|
| Name, ARR | CSV only |
| Tier, renewal date | XML when the XML feed's `asOf` is newer than the CSV export's; otherwise CSV |

- Tier and renewal each carry their own `source` and `asOf` in the canonical model and the API response.
- When the two sources disagree, we serve the value precedence picks. We also log a structured data-quality event and count it in a metric.

**3. Account ID normalisation in two steps.**
- **Canonical format** `ACC-NNN`: prefix uppercased, numeric part zero-padded to at least three digits. This handles formatting variants (`acc-7`, `ACC-07` → `ACC-007`).
- **Explicit crosswalk** (`mocks/fixtures/entitlement/id-crosswalk.csv`, `source_id → canonical_id`) for known aliases that formatting can't reconcile, e.g. `ACC-77 → ACC-007`. This stands in for a master-data-management mapping. The crosswalk is applied before format normalisation.
- **Unmatched IDs are reported, never dropped or guessed.** Records whose ID matches nothing in the other systems are logged as data-quality events, counted in a metric, and listed in the `/readyz` detail. We never match on account name.

## Alternatives considered
- **Fetch per request.** Rejected: an export is a file produced on a schedule, so re-reading it per request adds latency and load and gains no freshness.
- **Whole-record precedence (XML wins everything it has).** Simpler, but it loses the CSV's authority on ARR, and ARR is what Finance relies on.
- **CSV-only renewal** (ignore the fresher XML). Simpler, but agents would answer "renewal in the next 90 days" on stale dates.
- **Fuzzy match on account name.** It would "fix" the sample, but it silently joins the wrong accounts when names collide or change. For data that drives escalation and ARR visibility, a wrong join is worse than a reported gap.
- **Zero-padding only.** Doesn't reconcile `ACC-77` with `ACC-007` (see Context).

## Consequences
- The Copilot question works off a snapshot up to 5 minutes old in normal operation, and up to 24 hours old during an ERP outage. Responses carry `asOf`, so agents and apps can see this.
- The crosswalk is a maintained artefact. In production it belongs in master data management, not a repository file.
- **Security.** ARR lives in the snapshot in memory. Field-level authorization (`finance:read`) is applied at the API response boundary, so the snapshot never decides visibility.

## Revisit when
- The ERP offers change events or a REST API with modified-since filters: switch from snapshot polling to incremental sync.
- The crosswalk grows past a handful of entries: master data management integration becomes a dependency.
