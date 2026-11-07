# Review checklist

How every PR is checked, weighted by risk (CLAUDE.md §11). Critical-tier PRs get every item; low-tier PRs get the automated checks and the human's review.

## Every PR
- [ ] Checked against the spec's acceptance criteria and `openapi.yaml`, both approved before the code.
- [ ] Typecheck, ESLint, Prettier, Spectral and tests green, locally and in CI.
- [ ] Library APIs checked against the installed types, not memory.
- [ ] No secrets, no personal data, no real company data.

## Critical tier
- [ ] Spec merged in its own PR before the code.
- [ ] Sabotage checks below: each critical rule is broken on purpose and a test fails.
- [ ] Fresh-context review (`.claude/agents/fresh-reviewer.md`) on the diff, spec and this checklist; critical findings fixed before the PR.
- [ ] Line-by-line human reading of auth and scopes, ARR filtering, idempotency, webhook signing, escalation rules and the approval gate, retry and breaker classification, cursor encoding.

## Known failure patterns to look for
- Webhook signature over re-serialised JSON instead of the raw body; non-constant-time comparison; no timestamp tolerance.
- Retries on non-idempotent writes; ignoring `Retry-After`; 4xx counted as provider failure.
- Idempotency key not scoped to the client; check-then-insert race instead of a unique constraint.
- Cursor not bound to filter and sort; offset pagination disguised as a cursor.
- ARR nulled instead of omitted, or leaked through another path (logs, MCP output, error details).
- Time-window logic in local time, or `now` read outside the injected clock.
- Tests that mock the unit under test, assert implementation details, or cover only the happy path.
- Broad `try/catch` that swallows errors and returns 200.
- Request bodies, tokens or personal data in logs.

## Sabotage checks run
Each row: the rule broken on purpose, and the test that failed. Reverted after each run.

| Rule broken | Caught by | PR |
|---|---|---|
| Loosen the 48h threshold to ≥ 47h | `tests/ground-truth.test.ts` (CS-10232 appears) | #3 |
| Pick the earlier row for a duplicated account | `tests/ground-truth.test.ts` (CS-10236 drops) | #4 |
| Read the time with `Date.now()`, `new Date()`, `Date()` or `globalThis.Date.now()` | ESLint (`no-restricted-properties`, `no-restricted-syntax`) | #3 |
| Log request bodies | `tests/http/logging.test.ts` (S2-11) | 4a |
| Stop redacting `Authorization` | `tests/http/logging.test.ts` (redaction) | 4a |
| Turn off strict response validation | `tests/http/pipeline.test.ts` (S2-2) | 4a |
| Put an unknown error's message in the response | `tests/http/pipeline.test.ts` (S2-3) | 4a |
| Accept any inbound `X-Request-Id` | `tests/http/pipeline.test.ts` (S2-4) | 4a |
| Send problems through the validation-hooked `res.json` | `tests/http/review-fixes.test.ts` (undeclared status still a problem) | 4a |
| Revert to the phone pattern that matches inside UUIDs | `tests/http/review-fixes.test.ts` (correlation IDs intact) | 4a |
| Reopen a response schema (`AccountSummary` without `additionalProperties: false`) | Spectral `object-schemas-closed`, and `tests/http/pipeline.test.ts` (undeclared nested field) | closed schemas |
| Keep `/readyz` at 200 while shutting down | `tests/http/shutdown.test.ts` (readiness during shutdown) | 4a |
| Skip the token `audience` check | `tests/auth/token-verification.test.ts` (wrong audience) | 4b |
| Drop the RS256 pin, or allow another RSA algorithm | `tests/auth/token-verification.test.ts` (PS256 with an alg-less JWKS key) | 4b |
| Add `HS256` or `none` to the allowed algorithms | **Not caught by our tests:** jose refuses unsigned tokens and won't use an RSA key for HMAC, so its own defences hold. The pin is still kept. | 4b |
| Ignore the operation's required scopes | `tests/auth/*` (5 tests: getCustomer, addCaseComment, getCase scopes) | 4b |
| Compare client secrets with `===` | **Not test-detectable** (timing); constant-time comparison verified by reading | 4b |
| One global rate-limit bucket | `tests/http/rate-limit.test.ts` (5 tests) | 4b |
| Drop the per-agent bucket | `tests/http/rate-limit.test.ts` (5 tests) | 4b |
| Never refill buckets | `tests/http/rate-limit.test.ts` (5 tests) | 4b |
| Mount the dev issuer regardless of `DEV_ISSUER` | `tests/http/auth-e2e.test.ts` (S2-12) | 4b |
| Don't wire the security handler | `tests/http/auth-e2e.test.ts` (6 tests) | 4b |
| Charge the rate limit after request validation instead of after verification | `tests/auth/review-fixes.test.ts` (400 and 403 charged) | 4b |
| Treat only JWKS timeouts as an unavailable identity provider | `tests/auth/review-fixes.test.ts` (500, HTML, non-key-set → 503) | 4b |
| Require only `sub` (drop `exp`, `iat`, `client_id`) | `tests/auth/review-fixes.test.ts` (no exp refused) | 4b |
| Count 404 and other 4xx toward the breaker | `tests/adapters/http.test.ts`, `tests/http/upstreams.test.ts` (7 tests, incl. 404s never open it) | 5a |
| Retry every upstream error, including 4xx | `tests/adapters/http.test.ts` (3 tests: one attempt on 404/400/422) | 5a |
| Ignore `Retry-After` on a 429 | `tests/adapters/http.test.ts` (3 tests: wait timing, budget, default) | 5a |
| Drop the request-budget check on retries | `tests/adapters/http.test.ts` (2 tests) | 5a |
| Ignore precedence (tier and renewal from the CSV only) | `tests/adapters/entitlement/snapshot.test.ts` (6 tests: ACC-030 renewal, ACC-042 tier) | 5a |
| Skip the ID crosswalk | `tests/adapters/entitlement/*` (8 tests: ACC-77 → ACC-007) | 5a |
| Keep the first row for a duplicated account | `tests/adapters/entitlement/snapshot.test.ts` (ACC-012 latest contract) | 5a |
| Change the 48-hour staleness limit | `tests/adapters/entitlement/source.test.ts` (48h usable, 49h too old) | 5a |
| Expand XML entities | `tests/adapters/entitlement/xml.test.ts` (DOCTYPE entity not expanded) | 5a |
| Await the first entitlement load before listening | `tests/http/upstreams.test.ts` (start-up under 1 s with a slow ERP) | 5a review |
| Keep the JSON parse error as the cause of `bad_response` | `tests/adapters/cases.test.ts` (no body fragment in the logs) | 5a review |
| Retry with no backoff between attempts | `tests/adapters/http.test.ts` (waits the jittered backoff) | 5a review |
| Shift the renewal window by a day (+1) | `tests/http/list-cases.test.ts` (S3-1, S3-9) and `tests/domain/case-search.test.ts` (6 tests) | 5b |
| Shift the renewal window by a day (−1) | `tests/domain/case-search.test.ts` (89-day boundary) only: the fixture's 89/91 near-misses can't catch it at N=90 | 5b |
| Let past renewals match | `tests/domain/case-search.test.ts` (2 tests) only: no fixture account has a past renewal | 5b |
| Leave the filters out of the cursor fingerprint | `tests/domain/cursor.test.ts` (9 tests), `tests/http/list-cases.test.ts` (changed filter or sort) | 5b |
| Drop the account list from the case-system query | `tests/http/list-cases.test.ts` (5 tests) | 5b |
| Return ARR without `finance:read` | `tests/http/get-customer.test.ts` (no ARR key or amount without the scope) | 5b |
| Treat the warehouse as required (503 instead of degraded) | `tests/http/get-customer.test.ts` (2 tests) | 5b |
| Return the oldest 50 comments, or newest first | `tests/http/get-case.test.ts` (2 tests) | 5b |
| Read a coerced query integer as absent | `tests/http/list-cases.test.ts` (S3-5), `tests/http/query-helpers.test.ts` | 5b |
| Make `openedBefore` inclusive (enforced in the case-system query; a real adapter must emit `<`) | `tests/http/list-cases.test.ts` (S3-10 exact-instant test) | 5b review |
| Return an empty page instead of 400 above 500 accounts | `tests/http/list-cases-limits.test.ts` | 5b review |
| Keep the feed's own status when the export is too old | `tests/domain/account.test.ts`, `tests/http/list-cases.test.ts` (too old) | 5b review |
