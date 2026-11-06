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
