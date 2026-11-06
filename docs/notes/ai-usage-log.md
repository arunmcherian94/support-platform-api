# AI usage log

One line per occurrence: what the AI got wrong or nearly got wrong, how it was caught, the fix. Feeds `AI_USAGE.md`.

- 2026-11-06 Phase 0: initial read of the MCP SDK v2 package took the `LATEST_PROTOCOL_VERSION = '2025-11-25'` constant to mean v2 lacked the 2026-07-28 spec. Caught by checking the published package for `server/discover` and `input_required` (present); the constant only tracks the legacy handshake. Fix: record SDK capabilities from package contents, not a single constant or the README.
- 2026-11-06 Scaffold: CI workflow written with `actions/checkout@v5` / `actions/setup-node@v5` from memory; latest releases are v7.0.1 / v7.1.0. Caught by checking the GitHub releases API before committing. Fix: bumped to v7. Pattern: versions written from memory are stale; check the registry.
- 2026-11-06 Gate 1 review: ADR-0003 set a 5-minute entitlement poll and claimed data "up to 5 minutes old". That confused poll interval with data age: a nightly export is up to a day old whatever the poll rate. The 24h staleness limit would also have tripped daily before each export. Caught in human review of the ADR. Fix: 15-minute conditional polling, staleness measured from the CSV export timestamp with a 48h limit, and per-field `asOf` (ARR included).
- 2026-11-06 Gate 1 review: ADR-0004 considered iPaaS only as a consumer and as bulk ingestion; it missed iPaaS as the connectivity layer in front of the upstreams. Caught in human review. Fix: added it as a rejected alternative for request-path calls, with a revisit trigger.
- 2026-11-06 PR #1 review: the build-slice skill mapped tiers to models by example only, with no rule for unlisted work. Caught by a human PR comment. Fix: classify by what a defect would cause, round up when unsure, and record the reason in the slice table.
- 2026-11-06 Gate 2a: proposed `code` and `retryable` extensions on problem responses and HMAC-signed cursors. The human asked for standard practice; neither is needed (`type` + `Retry-After` cover the first; per-request authorization makes signing pointless). Dropped. Pattern: invented conventions where a standard already exists.
- 2026-11-06 PR 3 build: dispatched three parallel slices with worktree isolation, assuming worktrees branch from the current feature branch. They branch from the default branch, so all three started without the base commits. Caught by the base-commit check written into each slice prompt; each stopped before writing code. Fix: reset each worktree to the feature branch; the build-slice skill now requires that step.
- 2026-11-06 PR 3 build: after the reset instruction, the resumed slices ran in the main checkout, not their worktrees. Two committed straight onto the feature branch, one made its own worktree. No conflict, because each owned separate files, but the isolation assumption was wrong. Caught by checking `git worktree list` and the log before integrating. Fix: the build-slice skill now covers resumed slices.
- 2026-11-06 PR 3 review: the clock rule missed `Date()` (no `new`) and `globalThis.Date.now()`. Caught by the human asking for an explanation, which prompted another sabotage check. Fix: two more ESLint selectors; all four forms are now flagged.
- 2026-11-06 PR 4a: the first phone-number mask also matched ISO dates. Caught by a false-positive test written alongside it. Fix: skip dates and bare digit runs.
- 2026-11-06 PR 4a: the fresh-context review found four critical defects in code that passed all 112 tests:
  - the phone mask still matched digit runs inside UUIDs, corrupting about one in eight correlation IDs in the logs;
  - problems sent through the validation-hooked `res.json` fell through to Express's HTML error page, stack trace included, when the status wasn't declared;
  - malformed or oversized JSON bodies returned 500;
  - error stacks repeated unmasked personal data.

  It also found a test that could not fail (shutdown without asserting the database closed) and a sabotage check the contract can't support (extra response fields pass validation). All critical findings were fixed with tests, each confirmed to fail on the old code.

  **Why the other checks missed them.** Typecheck, lint, the tests and the sabotage checks all ran green. Each defect sat outside what the author had thought to check, and every one of those checks was written by the same author, in the same context, as the code:

  | Defect | Why our checks missed it | How the reviewer found it |
  |---|---|---|
  | Correlation IDs masked as phone numbers | The false-positive test used hand-picked strings (a date, one trace ID, a count), and the correlation test used `req-123.abc`, which has no long digit runs. Example-based tests only cover the examples someone thought of. | Pushed 10,000 random UUIDs through the logger and counted the ones changed (1,255). That's property-style input nobody hand-picked. |
  | HTML stack-trace page for an undeclared status | The author didn't know `express-openapi-validator` hooks `res.json` for every response, error responses included. The tests only raised statuses the operation declares (400, 404, 500). | Read the library's source for the response hook, then asked what happens when a problem's status isn't declared, and ran it. |
  | Malformed JSON returns 500 | Every test sent well-formed JSON. The error mapping recognised validator errors by their `errors[]` array, and body-parser errors don't have one. | Sent broken and oversized bodies at the boundary. |
  | Personal data in error stacks | The fix masked `err.message` and assumed that covered the error. The tests asserted on the message only, and the stack's first line repeats the message. | Read the serialised log line in full, not just the field the code claimed to handle. |

  **Why sabotage checks couldn't catch these:** they break rules the author already listed and confirm a test notices. They test the tests, but only for rules someone thought of. All four defects were rules nobody had written down.

  **Why the reviewer could:** fresh context, so none of the author's assumptions. A brief to find concrete failure scenarios, not to confirm the ACs. Permission to run probes against the real app and to read library source. And it checked the spec's absolute claims ("every log line", "unknown errors never leak", 4xx never becomes 5xx) against inputs, not against the code's intent.

  **What we change:**
  - Generated inputs for the masker: the test now pushes 200 random UUIDs through the logger on every run (`tests/http/review-fixes.test.ts`). A property-testing library would generalise this; not added yet.
  - Schemathesis in the contract-test step. It generates malformed and edge-case requests and flags any 5xx or undeclared status, so it would have caught defects 2 and 3. It's planned (Gate 3a), but hadn't been run yet.
  - The fresh-context review stays mandatory for critical PRs. In a team setting it runs in CI as an advisory check, never as approval.
- 2026-11-06 PR 4a: Vitest collected test files from the slice worktrees under `.claude/`, inflating the count to 192. Noticed from the number. Fix: excluded `.claude/` from Vitest, ESLint and Prettier.
