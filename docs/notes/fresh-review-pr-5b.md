# Fresh-context review, PR 5b (read endpoints)

The reviewer saw only the diff, S3, the contract, the ground truth and the review checklist. Result: **no critical findings, 1 major, 5 minor.** All 463 tests passed before the review. It confirmed ARR visibility, cursor binding, keyset ordering, the renewal window and degraded/no-data/stale handling by reading and testing.

## Fixed
| Finding | Fix and proof |
|---|---|
| **Major:** the 400 for more than 500 matching accounts was tested only in the domain; the handler could drop it unnoticed | Handler-level test with a stubbed snapshot (501 → 400, case system not called; 500 → all sent upstream). Fails when the guard is skipped |
| Past the 48-hour limit, the feed source still read `ok` although no entitlement data was used | Both entitlement sources read `stale`; unit and HTTP tests fail on the old behaviour |
| An empty page (no matching accounts) listed the case system as a source it never read | The case system is left out of `sources` for that page; asserted |
| The too-old path of `listCases` was tested only below HTTP | HTTP test moving the clock past 48 hours |
| The "inclusive `openedBefore`" check from S3 §4 had never been run | Run against the case-system query (the bound is enforced upstream); the exact-instant test fails. Recorded in the checklist |

## Left open
- The contract's `noUsageData` example shows a warehouse `asOf` timestamp; the implementation returns `asOf: null` for "no data". The schema allows both. Settle in a contract PR.
- "A failed refresh marks the source stale" is proven at the adapter level only, not through a response.
