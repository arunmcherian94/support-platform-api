# Engineering journal

Dated log of what was done, what changed and why, and open questions. Newest entries at the bottom.

## 2026-11-06 13:06 IST — Phase 0: research spike

**What was done.** Verified current versions and capabilities of every library in the proposed stack against primary sources: the npm and PyPI registries, the Node.js release index, upstream READMEs, and the MCP specification repository. The published SDK packages were inspected directly where docs and code disagreed.

**Versions verified (2026-11-06):**

| Area | Finding | Source |
|---|---|---|
| Node.js | v26 "Lithium" is Active LTS (26.13.0, 2026-10-28). v24 "Krypton" is Maintenance LTS (24.22.2). | nodejs.org/dist/index.json |
| TypeScript | 7.0.2 (native compiler) is out, but `typescript-eslint` 8.72.1 supports `typescript >=4.8.4 <6.1.0`. Latest compatible: 6.0.3. | npm registry |
| Fastify | 5.12.8. `fastify-openapi-glue` 4.12.0 needs a custom Ajv draft-2020-12 setup for 3.1 schemas. Fastify uses response schemas for serialization, not validation. | npm, fastify-openapi-glue README |
| Express | 5.3.0. `express-openapi-validator` 5.6.2 supports OAS 3.1 (since 5.4.0) and in-process response validation (`validateResponses`). Last release 2026-01-20. | npm, README |
| openapi-backend | 5.23.0, supports 3.1; response validation is an explicit `validateResponse` call. Kept as fallback. | README |
| SQLite | `node:sqlite` is Stability 1.2 (release candidate) in Node 26, built in, no native build. `better-sqlite3` 13.0.3 is the alternative. | nodejs/node v26.x docs |
| cockatiel | 4.0.0 (2026-05-26). Maintained. | npm, changelog |
| MCP spec | Latest revision is **2026-07-28**: stateless (no `initialize` handshake, no sessions), `server/discover`, Multi Round-Trip Requests (`input_required`) replace server-initiated elicitation/sampling. Roots, Sampling and Logging are deprecated. | modelcontextprotocol/modelcontextprotocol `schema/`, 2026-07-28 changelog |
| MCP TS SDK | v2 (`@modelcontextprotocol/server` / `client` 2.4.0) is the stable line and implements 2026-07-28: the published package contains `server/discover` and `input_required`, and it still negotiates 2025-11-25 with older clients. v1 (`@modelcontextprotocol/sdk` 1.32.2) is in maintenance until at least 2027-01. | typescript-sdk README (main), package contents |
| Contract tooling | Spectral CLI 6.17.1; oasdiff v1.35.0; Schemathesis 4.33.1 (run via `uvx`). | npm, GitHub releases, PyPI |
| Other | pino 10.4.0, vitest 5.1.0, jose 6.2.15, zod 4.6.7 (required by MCP SDK v2), newman 6.2.3, `@anthropic-ai/sdk` 1.6.0. | npm |

**What changed against the CLAUDE.md proposals (pending Gate 0):**

1. **HTTP framework: Express 5 + `express-openapi-validator` instead of Fastify.** The deciding requirement is that the running service validates *responses* against `openapi.yaml`. Fastify only serialises against response schemas, and 3.1 needs extra Ajv wiring. Fastify's throughput edge doesn't matter here, because latency is dominated by upstream I/O. Fallback: `openapi-backend` with an explicit response-validation hook.
2. **TypeScript 6.0.3, not 7.0.** The lint toolchain does not support 7 yet. Revisit when `typescript-eslint` widens its peer range.
3. **Node 26 (Active LTS)** for Docker and CI, with `engines: >=24` so a machine on Node 24 still runs `make run`.
4. **`node:sqlite` instead of `better-sqlite3`.** Zero native build, so a simpler Docker image and a faster cold start for reviewers. It sits behind the repository layer, so swapping to `better-sqlite3` is a one-file change if the release-candidate status bites.
5. **MCP: SDK v2 targeting spec 2026-07-28.** Two consequences for later phases:
   - The approval flow fits the new spec's guidance directly: cross-call state goes in explicit server-minted handles passed as ordinary tool arguments (SEP-2567). That handle is our pending-action ID.
   - MCP elicitation is now a Multi Round-Trip Request rather than a server-initiated request. We will not depend on client elicitation support; the human approves through the demo harness instead.

   Risk: v2 APIs are newer than most examples online, so generated code must be checked against the installed type definitions.

**Unchanged:** OpenAPI 3.1 (tooling support confirmed across validator, Spectral, Schemathesis and oasdiff), cockatiel, pino, Vitest, jose for JWT/JWKS, Spectral, outbox stretch, ports and adapters.

**Open questions:**
- Local environment: Node 26 not installed (system Node is 24.21); Docker daemon (colima) not running; git user identity not configured.
- GitHub remote: repository name and visibility.
- Demo model ID to be confirmed at Gate 4 (Part C), not now.

## 2026-11-06 13:35 IST — Gate 0 decided; scaffold

**Decided.** The human owner approved the stack in ADR-0001: Node 26, TS 6.0, Express 5 + express-openapi-validator, `node:sqlite`, cockatiel, MCP SDK v2.

**Scope split into two passes.** Pass 1 builds only what the brief requires. Consequences:
- The contract still specifies all five items.
- Escalate is built minimally in Part C, because `escalate_case` needs a real endpoint. It enqueues the webhook delivery in the same transaction as the audit record.
- The transactional outbox and dispatcher move to pass 2.

The PR plan in CLAUDE.md §11 is renumbered to match.

**Process.** Added the coding flow to CLAUDE.md §11: spec → approve → plan → approve → build → test → fresh-context review → triage → fix critical → PR → human review → human merge, with an optional clean-room run. Also added:
- the `build-slice` project skill (parallel slices, model chosen by risk tier);
- the `fresh-reviewer` agent;
- a README folder-structure overview requirement (CLAUDE.md §7).

**Scaffold notes.**
- npm 11 blocks dependency install scripts by default. esbuild's postinstall was blocked, and `tsx` and `vitest` work without it, so install scripts stay blocked. That's one less supply-chain execution path.
- Tooling only for now. Each runtime library joins in the PR that first uses it, so each dependency is justified where it appears.
- Plan adjustment: `docker-compose.yml` and the `Dockerfile` move from PR 1 to the platform-foundations PR, where there is a service to run. A compose stub that runs nothing is noise.
- Repo bootstrap: one empty root commit is pushed to `main` so feature branches have a base. This is the only direct push to `main`.

**Open questions.** None blocking. Phase 1 source decisions are next.

## 2026-11-06 14:20 IST — Phase 1: Gate 1 decided

**What was done.**
- The human owner approved all seven source decisions. They're recorded as ADR-0002 (integration pattern and mocks), ADR-0003 (entitlement snapshot, precedence, IDs) and ADR-0004 (iPaaS placement).
- Spec S1 holds the ground-truth table for the sample question. Its date arithmetic was verified by script, not by hand.
- DECISIONS.md started, with the decision log and data quirks.
- CI kept as the minimal workflow (typecheck, lint, tests). Schemathesis and Newman stay as local `make` targets: running the server and mocks inside CI isn't worth the time here.
- Coding flow tiered by risk (CLAUDE.md §11). Critical PRs get every step; low-risk PRs get a combined spec and plan approval and no fresh-context review.

**What changed and why.** Working through the ID quirk showed that zero-padding can't reconcile `ACC-77` with `ACC-007` (`ACC-77` pads to `ACC-077`). It's a genuine cross-system mismatch, so we added an explicit crosswalk rather than a formatting rule.

**Open questions (for Part A).**
- How "no usage data" vs "warehouse down" appear in the customer response.
- Whether escalation is a status or a flag.

## 2026-11-06 18:30 IST — Phase 2: Gate 2a decided, contract written

**What was done.**
- The human owner decided every Gate 2a item; recorded in ADR-0005 and DECISIONS.md rows 12–21. The S1 ground truth is approved.
- `openapi.yaml` (OAS 3.1) covers the five required items plus `GET /v1/cases/{caseId}` and the health probes. Every decision on the Part A checklist is visible in the spec: the API description, components, headers and per-operation text.
- `.spectral.yaml` extends the recommended OAS ruleset with eight convention rules. Each custom rule was checked by breaking the spec on purpose and confirming the rule fires. `npm run lint` now includes Spectral, so CI runs it.

**What changed and why.**
- The first proposals added `code` and `retryable` to problems and signed (HMAC) cursors. The human asked for standard practice instead. `type` and `Retry-After` already carry that information, and with authorization re-applied per request, signing a cursor adds a secret without adding safety. Both were dropped.
- Idempotency keys are required on comments only. Escalate's state rule and `If-Match` already prevent a repeat.
- Pinned `@stoplight/spectral-cli` 6.17.0, not 6.17.1, which was published hours earlier. A short cool-down on fresh releases is a cheap supply-chain control.
- `npm audit` reports 10 moderate findings (minimatch, via typescript-eslint; dev tooling only). They exist on `main` too; Spectral adds none. They'll clear when typescript-eslint updates its dependency.

**Open questions.** Gate 4a: should the API itself require a verifiable approval reference when an agent token escalates (defence in depth behind the MCP approval gate)?

## 2026-11-06 19:40 IST — Phase 3: fixtures and mock upstreams

**What was done.**
- Injectable clock, with ESLint banning direct time reads elsewhere (S1-6).
- Fixtures from the approved ground truth, including three comments seeded for the Part C guardrail tests.
- An independent oracle test that derives the sample-question answer from the raw fixture files.
- One mock process with per-upstream fault injection: the case system (Salesforce-style paging, version-checked `PATCH`), the entitlement exports (conditional GETs) and the warehouse (Snowflake-style statements, allow-list only). `make mocks` starts it on :8081 with the fixture clock.

**How it was built.** The base (clock, fixtures, server, faults) was written in session. The three route groups ran as parallel sonnet slices, each owning its own two files, then were reviewed and integrated.

**What changed and why.**
- Worktrees are cut from the default branch, so the first dispatch started the slices on `main`. The base-commit check in each prompt stopped them before they wrote anything.
- After a reset instruction, the resumed slices ran in the main checkout instead. File ownership kept them from colliding.
- Both lessons are now in the build-slice skill.

**Review notes (minor, not fixed).**
- The entitlement mock compares `If-None-Match` strongly, so a weak `W/` tag won't match. Our adapter never sends one.
- The warehouse returns reals as `String(value)` (`"385"`, not `"385.000"`); the adapter parses them as numbers.

**Open questions.** None.

## 2026-11-06 20:30 IST — Sample-data assumptions

**What was done.** A sweep of the scenario's sample data for traps beyond the casing and ID quirks. Recorded in DECISIONS.md:
- the question asks for customers, not cases;
- the sample case has no change marker;
- contract end vs renewal, and several contracts per account;
- usage lag;
- status and priority vocabularies inferred from one sample;
- the missing XML timestamp;
- canonical-only IDs, with alias and name lookup deferred.

**What changed and why.**
- Duplicate account rows in the CSV: the row with the latest `contract_end` wins, and the duplicate is logged (ADR-0003 §4). An older, expired Gold row for ACC-012 proves it: picking the wrong row drops CS-10236 from the answer, and the oracle test catches it. A full contract model (highest active tier, summed ARR) was considered and judged more than the sample data justifies.
- The usage seed now covers August–October, the last three closed months at the fixture date. The scenario's September sample row is kept.
- The oracle test also asserts the customer-level answer.

**Open questions.** None.

## 2026-11-06 21:15 IST — Process: spec PRs for critical work; Gate 3a

**What changed and why.** The human asked whether a spec should be committed in a PR before it is built. The working agreement only required specs to be written and approved before code, with approval given in the session. For critical-tier work, specs now ship in their own `spec/…` PR, and merging it is the approval:
- design and code approval become separate, visible acts on GitHub, as with design proposals merged before code (KEPs, RFCs);
- small spec corrections found while building go in the implementation PR as their own commit, listed under "Spec changes";
- larger corrections go back through a spec PR.

**Gate 3a.** Recommendations for every required Part B item are recorded as DECISIONS.md rows 22–29, approved with the S2 spec PR.

## 2026-11-06 22:30 IST — PR 4a: platform core

**What was done.** S2 criteria 1–4 and 8–11:
- the contract-driven app (request and response validation, problem errors, correlation and logging);
- config validated at start-up, and graceful shutdown with a drain deadline;
- the store's migration runner and real schema, with the data-model section in DECISIONS.md;
- `make run`, Dockerfile and Docker Compose.

The store and run slices were built in parallel (sonnet, worktrees with a verified base); the base and the integration tests were built in session.

**What changed and why.**
- **The fresh-context review found four critical defects in code that passed every test:**
  - correlation IDs corrupted by the phone mask;
  - an HTML stack-trace page for undeclared statuses;
  - 500s for malformed JSON;
  - personal data in error stacks.

  All were fixed with tests that were checked against the original code. Most majors were fixed too (case-insensitive redaction at any depth, listen errors, the drain deadline, production config). The rest are listed in the PR.
- **Spec change:** the first migration ships the real schema, as the approved plan said, instead of the spec's trivial migration. Recorded in S2.

**Open questions.**
- `docker compose up` is untested: Docker isn't running on this machine.
- Extra response fields pass validation, because response schemas don't set `unevaluatedProperties: false`. That's a contract follow-up.

## 2026-11-06 23:20 IST — Contract: closed response schemas

**What changed and why.** The PR 4a review showed that undeclared response fields passed validation, because no response schema was closed. That is exactly how ARR could leak onto a case.
- Every component object schema now sets `additionalProperties: false`.
- `Case` and `CaseDetail` share `CaseFields` and close it with `unevaluatedProperties: false`.
- A Spectral rule keeps new schemas closed.
- A runtime test proves an extra field (ARR on a case, or nested in the account summary) becomes a 500 in strict mode.
- Clients remain tolerant readers, so additions stay non-breaking.

## 2026-11-06 23:55 IST — PR 4b: auth and rate limits

**What was done.** S2-5, S2-6, S2-7 and S2-12:
- the dev token issuer, mounted only with `DEV_ISSUER=true` and refused in production;
- token verification against the issuer's JWKS URL (RS256 pinned; iss, aud, exp and nbf checked on the injected clock);
- each operation's scopes taken from `openapi.yaml`;
- per-client and per-agent token buckets with `RateLimit` headers;
- 503 when the identity provider is unreachable.

The two slices (auth, rate limits) ran in parallel on opus in worktrees. Integration and the end-to-end tests were done in session.

**What changed and why.**
- **The validator rebuilds errors thrown by a security handler,** losing the problem type and `WWW-Authenticate`, and turns any status other than 401/403 into a 500. So the handler leaves its problem on `res.locals`, and the error handler prefers it.
- **Adding `HS256` or `none` to the allowed algorithms isn't caught by our tests,** because jose refuses those tokens itself. We still pin RS256; dropping the pin is caught.
- **The slices paused** when the permission system declined their first writes. They resumed after the human approved, with explicit worktree paths.

**Open questions.** None.
