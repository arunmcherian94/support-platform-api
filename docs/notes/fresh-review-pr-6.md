# Fresh-context review, PR 6 (comments and webhooks)

Reviewer saw only the diff, S4, the contract and the checklist. **0 critical, 0 major, 7 minor.** All 554 tests passed. It confirmed the atomic claim and compare-and-swap takeover, single-attempt writes, signing over exact bytes, constant-time verification, the retry schedule, and that no secret or receiver body reaches storage or logs.

## Fixed
- A store error after a successful upstream create returned 500 and left the key in flight: now logged, and the answer is still 201.
- The listen-error path closed the database without waiting for the dispatcher.
- The spec now says an abandoned key is taken over like an expired one, whatever the body (the code already did).
- A stale test comment.

## Left open (minor)
- A malformed upstream response after a confirmed create releases the key, so a retry can duplicate the comment (same class as the documented timeout gap).
- The dispatcher-before-database shutdown order is tested at the dispatcher, not through server shutdown.
- After a 410, other attempts already in flight to that subscription in the same tick still run, and their rows stay pending rather than dead.
