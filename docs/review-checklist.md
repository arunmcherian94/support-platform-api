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
