# AI usage

I built this with Claude Code: models chosen per task, subagents, and project rules in [`CLAUDE.md`](CLAUDE.md). The demo agent itself runs on OpenAI's `gpt-6-luna`. The full record is in [`docs/notes/ai-usage-log.md`](docs/notes/ai-usage-log.md): one line for every mistake that a review, a test or I caught.

## How I used it
- **Specs before code.** For each phase, Claude drafted a spec with numbered acceptance criteria; I questioned it, changed it and approved it (`docs/specs/`). Critical work merged its spec in a PR of its own before any code was written: auth, idempotency, webhook signing, escalation and the MCP guardrails. Contract changes also went in PRs of their own.
- **The model matched to the risk.** Each plan sorted work into slices by risk tier. Opus took the auth, approval and guardrail code; Sonnet took scoped wiring and reviews of small diffs. Independent slices ran in parallel subagents, each in its own git worktree (`.claude/skills/build-slice`).
- **Research against what's installed, not memory.** Library APIs were checked against the installed type definitions and the package registry: MCP SDK v2, the OpenAI Responses API, cockatiel's breaker.
- **Design discussions, not dictation.** At each gate Claude laid out the options and I chose. Several of the decisions that matter most came from my pushback:
  - entitlement staleness measured from the export's own time, not the poll interval;
  - searching for "open" cases meaning every state except closed;
  - standard RFC 9457 problem types instead of invented fields.
- **A human holds the authority.** I reviewed and merged every one of the 22 PRs myself. Claude never merges or pushes to `main`, the same rule the escalate tool follows.

## What it got wrong
About 30 logged mistakes, falling into five patterns:
- **Out-of-date knowledge stated with confidence.**
  - GitHub Actions pinned two major versions behind the latest.
  - Status and tier enums invented from memory (`resolved`, `bronze`).
  - A misreading of what the MCP SDK supports.
- **Conventions invented where a standard exists:** `code` and `retryable` fields on errors, and HMAC-signed cursors. I asked for standard practice, and both were dropped.
- **Tests that share the code's blind spots.** The same agent wrote the code and the tests, so the tests passed over real defects:
  - correlation IDs corrupted by the phone-number mask;
  - rate limits charged only after request validation, so bad requests were free;
  - pending escalations that never expired, because two processes each restarted the fixture clock.
- **Sabotage checks that could never fail.** Three of a slice's own checks still passed when the code was broken: one test's queued row was never due, and re-serialising a body changed nothing.
- **Gaps only a real model shows.** In the first live demo the model searched `status: ["open"]` and missed an `in_progress` P1 case. My description never defined the statuses, and the tests always sent the right filter. The [demo README](mcp/demo/README.md) covers it.

## How I verified the output
Checks in layers, each catching what the one before it can't:
1. **Ground truth that I own.** The fixtures and the expected answer to the sample question (four accounts, five cases, plus near-misses) were fixed before any code. They are tested end to end through the API and through MCP.
2. **The contract enforced at runtime.** Every response in every test is validated strictly against `openapi.yaml`, so drift fails the suite. Spectral lints the spec, and Newman runs the Postman checks.
3. **Sabotage checks.** For each critical rule, I broke the code on purpose and confirmed that a test failed. About 80 are recorded in [`docs/review-checklist.md`](docs/review-checklist.md). This tests the tests: three checks that couldn't fail were found this way and replaced.
4. **Fresh-context review.** A reviewer subagent with no memory of the build reads the diff against the spec and the checklist. It ran on nine PRs and found 6 critical and 20 major defects in code that passed every test. Each was fixed with a test confirmed to fail on the old code; [example](docs/notes/fresh-review-pr-4a.md).
5. **Real model runs.** Four paid live runs (under a tenth of a cent each, logged in [`docs/notes/spend-log.md`](docs/notes/spend-log.md)). The first found the status gap that no test could. The later runs confirmed the fix, and confirmed that a finance user's agent gets no ARR and can't write ([transcripts](mcp/demo/transcripts/)).
6. **Guards in code, not instructions.** Rules that matter are enforced mechanically:
   - ESLint bans `Date.now()`, so all time comes from the injected clock;
   - a Spectral rule requires closed response schemas;
   - CI runs typecheck, lint and tests on every PR;
   - paid calls need `--live`.

**What I'd change next time:** run mutation testing (Stryker) on the critical modules in place of hand-run sabotage checks, and run a small agent eval set in CI, not just one demo question.
