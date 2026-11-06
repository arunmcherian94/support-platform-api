---
name: build-slice
description: Orchestrate building an approved spec and plan on this repo. Splits the work into small slices, runs independent slices in parallel subagents on the model that fits each slice's risk, then runs tests, a fresh-context review, finding triage and PR preparation. Use only after the spec and the plan are both approved (coding-flow steps 2 and 4 in CLAUDE.md).
---

# build-slice

Runs steps 5–10 of the coding flow in `CLAUDE.md` §11. It never runs steps 1–4 (spec and plan approval) and never merges.

## Preconditions (stop if any is false)
- The spec in `docs/specs/` has ACs, and the human owner approved it in this session.
- The plan lists slices, and the human owner approved it in this session.
- No slice changes `openapi.yaml` unless this is a contract PR. Contract changes go in their own PR first.
- You are on a feature branch cut from up-to-date `main`.

## 1. Slice the plan
Fill in this table for each slice and show it before starting:

| Slice | Files it owns | Depends on | Risk tier | Model | Tests it adds |
|---|---|---|---|---|---|

- **Files it owns** must not overlap between slices that run in parallel. Shared files (e.g. `src/http/app.ts` wiring, `package.json`) belong to a final integration slice that you do yourself.
- **Depends on**: a slice that needs another slice's types or exports waits for it.

## 2. Pick the model by risk, not by size

| Tier | What | Model |
|---|---|---|
| Critical | Auth and scope enforcement, ARR filtering, idempotency, webhook signing/verification, escalation rules and approval gate, retry/breaker classification, cursor encoding | `opus` |
| Standard | Handlers, adapters, mocks, repositories, ordinary tests | `sonnet` |
| Mechanical | Config, boilerplate, Postman scaffolding, fixture files written from an already-approved ground-truth table | `haiku` |

**Work the table doesn't list.** The examples above aren't a complete list, so classify by what a defect would cause:
1. **Critical** if a defect could:
   - expose data the caller shouldn't see;
   - let an action through that should be refused;
   - repeat or lose a write;
   - break the contract silently.
2. **Mechanical** if the output is fully determined by an approved input (a table, a schema, a template) and a test or linter would catch any deviation.
3. **Standard** otherwise.

Tie-breakers:
- **Unsure between two tiers:** take the higher one.
- **A slice that mixes tiers:** split it, or run it at its highest tier.
- **Record the reason:** write it in the slice table ("Model" column, e.g. `opus — touches scope check`), so the human can challenge it at plan approval.

The human can promote any slice; nothing is demoted once a slice has started.

Critical-tier code is always read line by line by the human afterwards, whichever model wrote it.

## 3. Dispatch
- Launch independent slices in one message, each with `isolation: "worktree"`.
- **Commit everything the slices depend on first.** A worktree is cut from the default branch, not from your feature branch, so each prompt must start with: "run `git reset --hard <feature-branch>`, confirm `git log --oneline -1` shows `<expected commit>`, run `npm ci`; if the commit doesn't match, stop and report." Without that check, a slice builds against the wrong base without noticing.
- **Resuming a slice loses its worktree.** A resumed agent runs in the main checkout. Either give it an explicit worktree path to `cd` into, or let it commit only its own files on the feature branch, and commit nothing yourself until it reports back.
- Give each subagent a self-contained prompt:
  - the slice row;
  - the spec path and the AC IDs it covers;
  - the relevant `openapi.yaml` paths;
  - the layering rule (`domain/` has no I/O, adapters normalise at the boundary);
  - "verify library APIs against the installed type definitions in `node_modules`, not memory";
  - "tests in the same commit as the behaviour, Conventional Commits".
- Dependent slices run after their dependencies are integrated.
- Integrate the worktree branches yourself, resolve conflicts, then do the integration slice.

## 4. Test (step 6)
Run `make lint`, `make typecheck` and `make test` (and `make postman` once it exists).

For each critical rule the PR touches, do its sabotage check from `docs/review-checklist.md`:
1. Break the rule.
2. Confirm a test fails.
3. Revert.
4. Record the result in the checklist.

## 5. Fresh-context review (step 7)
Launch the `fresh-reviewer` agent with the diff range (`git diff main...HEAD`), the spec path and the AC IDs. Do not pass the conversation, your reasoning or the slice prompts.

## 6. Triage and fix (steps 8–9)
- **Critical**: fix now, re-run tests, re-run the reviewer on the fix.
- **Major**: fix if under ~15 minutes; otherwise list under "Out of scope / follow-ups".
- **Minor**: list in the PR under "Review notes".
- Any real AI mistake caught (by tests, the reviewer or the human) gets one line in `docs/notes/ai-usage-log.md`.

## 7. Prepare the PR (step 10)
Fill `.github/pull_request_template.md`, open it with `gh pr create`, and stop. The human reviews and merges.
