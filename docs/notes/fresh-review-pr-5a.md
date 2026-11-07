# Fresh-context review, PR 5a (upstream adapters)

The reviewer saw only the diff, S3, the contract and the review checklist. Result: **no critical findings, 3 major, 6 minor.** All 385 tests passed before the review.

## Fixed (major)
| Finding | Why our checks missed it | Fix and proof |
|---|---|---|
| Start-up awaited the first entitlement load, against S3 §2.2: a hanging ERP held liveness unreachable for up to ~35 s | The integration tests relied on the blocking: they asserted readiness right after start-up | Load in the background; tests wait for readiness. New test: start-up returns in under 1 s with a 1.5 s ERP; fails when the `await` is restored |
| A `JSON.parse` error kept as the cause of `bad_response` quotes part of the upstream body, which the logger serialises | The malformed-body tests checked the error kind, not what the error carried | A fixed reason instead of the parse error. New test: a body with a name, ARR and email never reaches the logs; fails with the old cause |
| No test failed if retries ran back to back | The backoff function was unit-tested, but every retry test ran all timers at once | New test pins the jitter and checks the second attempt waits ~100 ms; fails with zero backoff |

Also fixed (minor): Salesforce-style error arrays now yield their `errorCode` in logs; the readiness test that claimed "recovers" now proves it.

## Left as follow-ups (minor)
- An export with no timestamp header and no `Last-Modified` takes the fetch time as its age, which could hide the 48-hour rule.
- With no traffic, readiness keeps showing an open breaker as `unavailable` (cockatiel moves to half-open only on the next call).
- A half-open probe that fails for a reason that doesn't count (a budget-clipped attempt) closes the breaker.
- `stop()` doesn't cancel an entitlement refresh already in flight.
- A 404 doesn't reset the consecutive-failure count (cockatiel leaves errors it doesn't handle unrecorded).
