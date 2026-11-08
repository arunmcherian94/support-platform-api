# ADR-0003: Entitlement data — snapshot access, source precedence and account IDs

- **Status:** Accepted (2026-11-06, Gate 1)
- **Amended:** 2026-11-08: polls are plain fetches (no conditional GET); `/readyz` no longer lists unmatched IDs, which are logged instead.
- **Deciders:** @arunmcherian94 (repository owner)

## Context
Entitlement data comes from two feeds:
- a **CSV export** from the ERP, the system of record: name, tier, contract end, ARR;
- an **XML feed** with tier and renewal, which refreshes more often.

We assume a typical ERP cadence: the CSV export runs nightly and the XML feed hourly. Polling faster than a feed changes buys no freshness.

The sample data has two problems:
1. **Renewal appears in both.** It's `contract_end` in the CSV and `renewal` in the XML, and the two can disagree.
2. **Account IDs don't reconcile.** The CSV has `ACC-77`; every other system has `ACC-007` for what is clearly the same account (Acme Corp, Platinum, 2027-01-15). Zero-padding cannot fix this: `ACC-77` padded to three digits is `ACC-077`, not `ACC-007`. It is a genuine ID mismatch between systems, not a formatting variant.

Agents must know how old data is before acting on it, and Finance needs ARR from the system of record.

## Decision

**1. Snapshot access, not a fetch per request.**
- The adapter loads both feeds at start-up, then polls each one every **15 minutes** (`ENTITLEMENT_REFRESH_SECONDS`; the demo and tests set it lower).
- Each poll is a plain fetch. An unchanged body is not parsed or rebuilt again.
- So data age is bounded by the export cadence plus at most one poll interval, not by the poll interval alone.
- Requests read the last good snapshot.
- If a refresh fails, we keep serving the last good snapshot, and `asOf` shows its real age. That makes stale-on-error a fallback built into the design.
- **Maximum staleness is 48 hours, measured from the CSV export's timestamp.** A nightly export is normally up to about 24 hours old, so a 24-hour limit would fail every day just before the next export. 48 hours tolerates one missed run.
- "Entitlement unavailable" means one of two things: no snapshot has ever loaded, or the CSV export is older than 48 hours. Either returns a documented 503 problem response.
- A stale or missing XML feed doesn't cause a 503: precedence falls back to the CSV for tier and renewal, and the response shows the source it used.

**2. Field-level precedence.**

| Field | Source |
|---|---|
| Name, ARR | CSV only |
| Tier, renewal date | XML when the XML feed's `asOf` is newer than the CSV export's; otherwise CSV |

- Tier and renewal each carry their own `source` and `asOf` in the canonical model and the API response.
- Name and ARR carry the CSV export's `asOf`.
- **ARR updates happen in the ERP, never through us.** A changed ARR reaches the platform in the next CSV export, and the next poll picks it up. The platform is read-only for ARR. So ARR can lag a tier change seen in the XML by up to one export cycle; per-field `source` and `asOf` make that visible.
- When the two sources disagree, we serve the value precedence picks. We also log a structured data-quality event and count it in a metric.

**3. Account ID normalisation in two steps.**
- **Canonical format** `ACC-NNN`: prefix uppercased, numeric part zero-padded to at least three digits. This handles formatting variants (`acc-7`, `ACC-07` → `ACC-007`).
- **Explicit crosswalk** (`mocks/fixtures/entitlement/id-crosswalk.csv`, `source_id → canonical_id`) for known aliases that formatting can't reconcile, e.g. `ACC-77 → ACC-007`. This stands in for a master-data-management mapping. The crosswalk is applied before format normalisation.
- **Unmatched IDs are reported, never dropped or guessed.** Records whose ID matches nothing in the other systems are logged as data-quality events (case accounts once per ID). They are not listed on `/readyz`, which needs no authentication. We never match on account name.

**4. One row per account; duplicates resolved by latest contract end.**
The scenario describes the ERP as holding "accounts, contracts": that is what the ERP stores, not the shape of the export we integrate with. The sample CSV, the XML feed (keyed by account) and the sample question are all account-level, so we take the export as one row per account, rolled up by the ERP.
- If an account appears more than once (typically an old contract next to its renewal), **the row with the latest `contract_end` wins**: its tier, end date and ARR are used.
- Each duplicate is logged as a data-quality event, like unmatched IDs.
- A contract's end date stands in for its renewal date. Notice periods aren't modelled, and an explicit XML `renewal` takes precedence when newer (section 2).

## Alternatives considered
- **Fetch per request.** Rejected: an export is a file produced on a schedule, so re-reading it per request adds latency and load and gains no freshness.
- **Whole-record precedence (XML wins everything it has).** Simpler, but it loses the CSV's authority on ARR, and ARR is what Finance relies on. (The XML doesn't carry ARR, so ARR always comes from the CSV.)
- **CSV-only renewal** (ignore the fresher XML). Simpler, but agents would answer "renewal in the next 90 days" on stale dates.
- **Fuzzy match on account name.** It would "fix" the sample, but it silently joins the wrong accounts when names collide or change. For data that drives escalation and ARR visibility, a wrong join is worse than a reported gap.
- **First or last row wins.** Simple, but it depends on export order and can pick an expired contract.
- **Full contract model** (highest active tier, earliest active end, summed ARR). More faithful to an account holding several concurrent contracts, but more rules than the sample data justifies. Revisit if the ERP exports concurrent contracts.
- **Zero-padding only.** Doesn't reconcile `ACC-77` with `ACC-007` (see Context).

## Consequences
- Normal data age is set by the feeds, not by us: up to about a day for name and ARR, about an hour for tier and renewal, plus up to 15 minutes of polling delay. During an ERP outage, data can be up to 48 hours old. Responses carry `asOf` for each field group, so agents and apps can see this.
- A same-day ARR correction is invisible until the next export. If Finance needs faster corrections, the fix is in the ERP integration (an ad hoc export or change events), not a shorter poll interval.
- The crosswalk is a maintained artefact. In production it belongs in master data management, not a repository file.
- **Security.** ARR lives in the snapshot in memory. Field-level authorization (`finance:read`) is applied at the API response boundary, so the snapshot never decides visibility.

## Revisit when
- The ERP offers change events or a REST API with modified-since filters: switch from snapshot polling to incremental sync.
- The real export cadence differs from the nightly CSV / hourly XML assumption: retune the poll interval and the staleness limit to match it.
- The crosswalk grows past a handful of entries: master data management integration becomes a dependency.
