# API platform best practices

A quick reference to the practices this project follows, or argues for, when building an API that sits in front of other systems and serves both apps and AI agents. Each entry gives the rule, the reason for it, and where the repo applies it. **Proposed** means the practice is recommended but not built here; the last section lists where the repo falls short of its own list.

Longer reasoning lives in [`DECISIONS.md`](../DECISIONS.md), [`PLATFORM.md`](../PLATFORM.md) and the [ADRs](adr/).

---

## 1. Contract first

| Practice | Why | Here |
|---|---|---|
| The OpenAPI document is the source of truth, written before the code | Consumers, mocks, tests, SDKs and docs all come from one artifact, so they can't disagree | [`openapi.yaml`](../openapi.yaml) (3.1) |
| Validate **requests and responses** against the contract at runtime | If you validate only requests, a handler can still drift silently; response validation turns the drift into a test failure | [ADR-0001](adr/ADR-0001-runtime-and-core-stack.md), [`src/http/app.ts`](../src/http/app.ts) |
| Close response schemas (`additionalProperties: false`) | Then a field nobody declared (e.g. ARR) fails the response instead of leaking | [ADR-0005](adr/ADR-0005-api-contract-conventions.md) |
| Lint the contract in CI with house rules, failing on any finding | Conventions get enforced by a machine instead of argued in review | [`.spectral.yaml`](../.spectral.yaml): versioned paths, camelCase, problem+json from shared components, declared scopes, rate-limit headers |
| Put contract changes in their own PR, ahead of the code that needs them | The interface then changes on purpose and in plain sight, never as a side effect | [`CLAUDE.md`](../CLAUDE.md) workflow |
| Diff the contract against `main` in CI and fail on breaking changes | Spectral checks style, but it can't compare two versions | **Proposed** (`oasdiff breaking`) |
| Generate docs and SDKs from the contract | Generated docs can't drift from the code | **Proposed** ([PLATFORM §6](../PLATFORM.md#6-reuse)) |

## 2. Resource modelling

- **Aggregate only where the consumer's question spans several systems.** "Who is this customer" joins entitlement and usage, so `GET /v1/customers/{id}` is an aggregate. Cases stay a plain resource, because the case system owns them and writes go straight to it.
- **Show where the data came from.** Each aggregate carries `sources[]` with each source's `asOf` and status, so a caller can see stale or missing parts instead of guessing.
- **Model a state transition with business rules as an action sub-resource** (`POST /v1/cases/{id}/escalate`), not as a PATCH of a status field. The rules, the errors and the scope then belong to the action.
- **Ports and adapters: vendor shapes stop at the adapter.** The domain sees canonical types; replacing Salesforce or NetSuite means writing a new adapter, not changing the domain ([ADR-0002](adr/ADR-0002-upstream-integration-and-mocks.md), [`src/ports/`](../src/ports/)).
- **Join systems on canonical IDs plus an explicit crosswalk, never on names.** A fuzzy join can silently give one customer another's revenue figures. Unmatched IDs are logged ([ADR-0003](adr/ADR-0003-entitlement-snapshot-precedence-and-ids.md), [`src/adapters/entitlement/ids.ts`](../src/adapters/entitlement/ids.ts)).
- **Precedence goes field by field, not source by source.** Take tier and renewal from the fresher feed; take money only from the system of record.

## 3. Errors: RFC 9457 problem+json

- **Every 4xx and 5xx is `application/problem+json`, built from one shared table.** Clients branch on `type` (a stable URI) and on the status ([`src/http/problems.ts`](../src/http/problems.ts)).
- **Use 400 for request validation (with JSON-pointer `errors[]`), and 422 for well-formed requests the server refuses on meaning** (e.g. an idempotency key reused with a different body).
- **Send `Retry-After` on 429 and 503.** Don't add custom `code` or `retryable` fields; the standard already carries that information.
- **Put a `correlationId` in every error body, equal to `X-Request-Id`.** The body says what went wrong; the logs, found by that ID, say why.
- **Upstream and internal details never cross the boundary.** A 500 says "details logged under correlationId"; an upstream failure becomes a generic 502/503/504. Validator messages describe the rule, never echo the input.
- **The status codes worth knowing:** 401 (missing or invalid token, with `WWW-Authenticate`), 403 `insufficient_scope`, 409 (in progress, or an invalid state), 412 (stale `If-Match`), 428 (`If-Match` required), 429, 502 / 503 / 504 for upstream errors, unavailability and timeouts.

## 4. Versioning and deprecation

- **Put the major version in the path (`/v1`).** Gateways route on it, iPaaS connectors and caches see it, and it shows in every log line. Date- or header-based versioning suits a public API with many small clients better ([ADR-0005](adr/ADR-0005-api-contract-conventions.md)).
- **Make only additive changes within a version.** Breaking means: removing or renaming a field or operation, adding a required input, tightening validation, or changing a type, an enum's meaning or a status code.
- **Clients ignore unknown fields;** the server adds a field only through a contract change.
- **To retire a version:** send the `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers with a `Link rel="deprecation"` to a migration note, and keep at least 6 months of overlap. *The policy is written in the contract; no operation is deprecated yet, so nothing emits these headers.*

## 5. Authentication and authorization

- **OAuth 2.0 scopes are declared per operation in the contract and enforced by the security handler.** The spec is then the single answer to "who can call what" ([`src/auth/security-handler.ts`](../src/auth/security-handler.ts)).
- **Field-level authorization: a hidden field is omitted, not set to null.** A null ARR reads as zero; an omitted ARR reads as "not yours to see". ARR requires `finance:read` ([`src/http/handlers/customers.ts`](../src/http/handlers/customers.ts)).
- **401 and 403 mean different things.** 401 means "who are you?" (send `WWW-Authenticate`); 403 means "you can't do this" (send `error="insufficient_scope"`).
- **Verify the signature, issuer, expiry and audience.** The audience check stops a token minted for another API from working here ([`src/auth/verify.ts`](../src/auth/verify.ts)).
- **Keep access tokens short-lived.** Without a revocation check, the token's lifetime is the only control on a leaked one; sender-constrained tokens (DPoP, mTLS) are the stronger fix.
- **Rotate signing keys in a set order:** publish the new key in the JWKS, wait out the cache, sign with the new key, wait out the token lifetime, then retire the old key. If the verifier can't fetch the JWKS, return 503 with `Retry-After`, not 401.
- **Order of checks per request:** verify the token (401), charge the rate limit (429), check the scope (403), validate the request (400), then run the handler.

## 6. Pagination and filtering

- **Use keyset (cursor) pagination, not offsets.** It stays stable while data changes and costs the same on page 1 and page 1000.
- **Make cursors opaque and bind them to the filter and sort** (a fingerprint inside the cursor), so a cursor can't be replayed against a different search ([`src/domain/cursor.ts`](../src/domain/cursor.ts)).
- **Cursors carry a position, not authority.** Authorization is rechecked on every page, so signing the cursor would add a secret without adding safety.
- **Cap the page size** (`limit` up to 100), use enums for filters, and always add a unique tiebreaker (the ID) to the sort key.

## 7. Safe writes: idempotency and concurrency

- **`Idempotency-Key` on any create whose duplicate is a real side effect** (comments here). Records are kept for 24 hours ([`src/store/idempotency.ts`](../src/store/idempotency.ts)).
- **Scope the key to the caller** (PK `(client_id, sub, endpoint, key)`), so one client can never replay or probe another's keys.
- **Enforce it with a unique constraint, not check-then-insert,** and store a hash of the request: the same key with a different body gets 422; a request still in flight gets 409 with `Retry-After`; a completed one is replayed with `Idempotent-Replayed: true`.
- **This is not exactly-once.** A crash between the upstream create and recording the result can still duplicate the create. True exactly-once needs the upstream to accept your key, or an operation record plus reconciliation.
- **Use optimistic concurrency for state changes:** return an `ETag` on reads and require `If-Match` on the write. A missing `If-Match` gets 428; a stale one gets 412. It matters most when a human approval widens the gap between read and act ([`src/http/handlers/escalate.ts`](../src/http/handlers/escalate.ts)).
- **A state transition doesn't need an idempotency key** when its own rules and `If-Match` already make a repeat fail safely (409/412).

## 8. Rate limiting

- **Use the IETF `RateLimit` and `RateLimit-Policy` headers**, not the old `X-RateLimit-*`, on every authenticated response, plus `Retry-After` on 429 ([`src/http/rate-limit.ts`](../src/http/rate-limit.ts)).
- **Charge right after authentication and before validation.** Otherwise invalid and forbidden requests are free, which is exactly what an abuser sends.
- **Keep separate buckets per client and per agent** (keyed on the token's `act.sub`), so one runaway agent can't use up its client's quota.
- **At scale:** a coarse quota at the gateway, and business limits in a shared store (Redis). Limits held in each process's memory multiply with the replica count. **Proposed.**

## 9. Resilience to upstreams

- **Give each request a budget** (10 s here) and each attempt a shorter timeout inside it, so retries can't overrun the request ([`src/adapters/deadline.ts`](../src/adapters/deadline.ts)).
- **Retry only reads and idempotent writes, with exponential backoff and full jitter.** A comment create is never retried: a lost response would turn the retry into a duplicate.
- **One circuit breaker per upstream.** Once it opens, calls fail in about a millisecond instead of piling up on a dead dependency ([`src/adapters/resilience.ts`](../src/adapters/resilience.ts)).
- **Classify failures.** 5xx and timeouts count against the breaker; 4xx don't. Handle an upstream 429 on its own: honour its `Retry-After` rather than treat it as an outage.
- **Partial failure degrades instead of failing.** Entitlement is required; usage is optional. With the warehouse down, the customer view returns 200 with `degraded: true`, `usage: null` and that source marked `unavailable`. A 503 would turn a partial outage into a full one.
- **A last-good snapshot serves as the fallback, with an explicit staleness limit.** Entitlement is polled every 15 minutes. Its age is measured from the source's own export time, not the poll time, and data older than 48 hours returns 503 ([ADR-0003](adr/ADR-0003-entitlement-snapshot-precedence-and-ids.md)).
- **Don't cache what someone acts on.** Cases are always read live; acting on stale state is worse than acting slowly.
- **Liveness and readiness are separate checks.** `/healthz` reports that the process is alive; `/readyz` returns 503 until the snapshot is usable. A hung dependency at boot should hold traffic back, not crash-loop the pod ([`src/http/health.ts`](../src/http/health.ts)).
- **Drain gracefully on SIGTERM,** with a time bound ([`src/server.ts`](../src/server.ts)).

## 10. Webhooks and events

- **Sign the exact bytes sent** (Standard Webhooks: HMAC-SHA256 over `{id}.{timestamp}.{payload}`), never a re-serialised body ([`src/events/signing.ts`](../src/events/signing.ts)).
- **On the receiving side:** compare in constant time, reject timestamps outside ±5 minutes, and dedupe on the delivery ID to stop replays within that window ([`src/events/verify.ts`](../src/events/verify.ts)).
- **Allow several signatures in the header,** so a secret can rotate with no gap: sign with the current and the previous secret during the overlap.
- **Use an outbox:** write the event in the same transaction as the state change, and let a dispatcher deliver it with retries, backoff and a dead-letter state ([`src/events/enqueue.ts`](../src/events/enqueue.ts), [`src/events/dispatcher.ts`](../src/events/dispatcher.ts)).
- **Store a reference to the secret (`secret_ref`), never the secret.**
- **At scale:** relay the outbox to a broker (Kafka, EventBridge, SQS) and claim work with `SELECT … FOR UPDATE SKIP LOCKED`. **Proposed.**

## 11. Data and time

- **The audit log is append-only and enforced by the database:** triggers reject UPDATE and DELETE ([`src/store/audit.ts`](../src/store/audit.ts)).
- **Create one index per question you will actually ask,** e.g. `(status, next_attempt_at)` for "pending and due", `(actor_sub, at)` for "what did this user do" ([DECISIONS: data model](../DECISIONS.md#data-model)).
- **Use `STRICT` tables and keep all SQL in a repository layer,** so moving to Postgres is contained ([`src/store/`](../src/store/)).
- **Migrations go expand-then-contract,** so the previous release still runs during a rollback.
- **Inject the clock.** A lint rule bans `Date.now()`, which keeps time-window logic testable and fixture answers reproducible. Use UTC and RFC 3339 throughout ([`src/clock.ts`](../src/clock.ts)).

## 12. Observability and SLOs

- **One structured JSON log line per request:** route template, status, latency, client, user, agent ([`src/observability/logger.ts`](../src/observability/logger.ts)).
- **Correlation:** accept a valid `X-Request-Id` or generate one and echo it; parse or generate a W3C `traceparent`.
- **Never log bodies or tokens; mask emails and phone numbers.** Tests pin both rules.
- **Keep metric labels low-cardinality.** Customer and case IDs go in traces and logs, never in metric labels.
- **Use RED metrics per route** (rate, errors, duration), plus upstream breaker state, snapshot age and webhook queue depth. **Proposed** (OpenTelemetry).
- **Availability SLI = good ÷ valid requests.** 5xx count as bad; 4xx (including your own 429) are excluded. A degraded 200 counts as available, and a separate **completeness SLI** keeps partial answers visible.
- **Alert on multi-window burn rate:** page at 14.4× over 1 hour or 6× over 6 hours; open a ticket at 1× over 3 days. Once the error budget is spent, reliability work comes before new features ([PLATFORM §2](../PLATFORM.md#2-nfrs-and-slos)).

## 13. Gateway versus service

**The gateway protects the platform; the service enforces business rules.** Nothing that needs domain knowledge goes in the gateway.

| Gateway | Service |
|---|---|
| TLS, WAF, JWT signature, issuer, expiry and audience | Scopes per operation and per field |
| Coarse quota and burst limit per client | Business rate limits per client and per agent |
| Body size and content type | Full request **and response** validation against the contract |
| Header changes only (request ID, routing) | Aggregation, staleness, partial results, idempotency, `If-Match`, audit |

Logic in a gateway is hard to test, version and review, and it ties you to a vendor. The service keeps its own checks as defence in depth ([PLATFORM §1](../PLATFORM.md#1-gateway-versus-service)).

## 14. Exposing an API to AI agents (MCP)

**Tool design** ([DECISIONS: MCP tools versus REST](../DECISIONS.md#mcp-tools-versus-rest-resources), [`mcp/server/tools.ts`](../mcp/server/tools.ts))
- **Shape tools around tasks, not resources.** REST serves many consumers through general resources; a tool serves one model answering one kind of question.
- **Don't make the model do what it does badly:** time arithmetic (`minOpenHours` instead of a timestamp), protocol headers (the `ETag` stays hidden), and judging whether a retry is safe (the server derives the idempotency key from user, case and body).
- **Use enums over free text, tight JSON schemas, and sensible defaults.** "Open" in a question means not closed, so the default is every state except closed.
- **Return compact, capped responses:** only the fields the question needs, at most 20 rows, about 8 KB per response, 300 characters per text field. Never pass raw upstream payloads through.
- **Each description says** when to use the tool and when not to, each parameter's units and limits, and what to do on each error (e.g. wait `retryAfterSeconds` on `rate_limited`).

**Identity and authority** ([ADR-0006](adr/ADR-0006-mcp-and-agent-guardrails.md))
- **The agent acts for a user, never as a super-user.** Exchange the user's token for a delegated one (RFC 8693): `sub` is the user, `act.sub` is the agent, and the scopes are the user's scopes intersected with the agent's policy.
- **The MCP server never decides access;** the API enforces scopes on every call.
- **Keep sensitive data out of the agent's policy altogether.** Here the agent policy never includes `finance:read`, so ARR can't reach a model.
- **High-risk actions are proposed, then approved.** `escalate_case` only stores a pending action; a human approves it with their **own** token, tied to the case's `ETag`, and the proposal expires after 15 minutes. The model has no tool that can approve anything ([`mcp/server/approvals.ts`](../mcp/server/approvals.ts)).

**Prompt injection via data** ([`mcp/server/guardrails.ts`](../mcp/server/guardrails.ts))
- **Structural defences come first:** tools act on one case at a time, there is no tool that executes anything, escalations need a human, and the API enforces scopes and limits. They hold even when detection misses.
- **Content handling sits on top:** upstream text is wrapped and labelled as untrusted, normalised, capped, and likely injections are flagged. Detection is best-effort.
- **Mask PII in tool output,** and refuse writes that contain emails, phone numbers or money amounts.

**Operations**
- **Rate-limit each agent at the API, and cap calls per session at the MCP server.**
- **Audit every tool call and every approval decision:** user, agent, outcome, correlation ID.
- **Run a golden set of questions on every change to a tool description, the prompt or the model.** **Proposed.**
- **Transport:** stdio for local use; Streamable HTTP with MCP authorization on its own gateway route in production. Tools shouldn't depend on the transport.

## 15. Governance and delivery

- **Make the right path the easy one:** a published lint ruleset, a project template with CI already wired, and generated SDKs. Start in warning mode on existing APIs; enforce on new ones.
- **Start with one or two teams who want the standard,** fix what they hit, and show their results. Tie adoption to something teams want, such as catalog listing or gateway onboarding.
- **Write ADRs for decisions** (why, with alternatives) **and specs for behaviour** (what, as numbered testable acceptance criteria) ([`docs/adr/`](adr/), [`docs/specs/`](specs/)).
- **Keep a review checklist of known failure patterns** ([`docs/review-checklist.md`](review-checklist.md)).
- **CI/CD stages:** lint, typecheck, test, contract test, breaking-change check, secret and dependency scan → build one signed image with an SBOM → staging smoke tests → production canary at 5% → 25% → 100%, gated on SLO burn, with automatic rollback ([PLATFORM §7](../PLATFORM.md#7-cicd)).
- **Change control for regulated environments:** every change goes through a PR reviewed by someone other than the author, deploys come only from the pipeline, there is no standing production access, and break-glass access is logged.

## 16. iPaaS versus custom code

**iPaaS for moving data, custom code for rules and risk** ([ADR-0004](adr/ADR-0004-ipaas-placement.md)).
- **iPaaS:** scheduled ingestion of ERP exports, and workflows triggered by webhooks (e.g. `case.escalated` opens a CSM task). Connectors, schedules, retries and monitoring are what it does well.
- **Custom code:** the API and its contract, aggregation, field-level authorization, idempotency, resilience, webhook signing, and the MCP server with its guardrails. These need code review, tests and low latency.
- **Avoid iPaaS "system APIs" on the request path.** They add a hop and a second failure domain, and split retry logic across two layers.

## 17. REST, GraphQL or gRPC

REST suits a mix of iPaaS connectors, apps and agents: they all speak HTTP, and you get gateway policy on path and method, HTTP caching and conditional requests, and OpenAPI tooling for linting, diffing and code generation. GraphQL earns its place behind a UI that composes many entities on one screen. gRPC fits internal, high-throughput or streaming paths, such as usage events flowing into a warehouse.

## 18. Verifying AI-generated code

- **Spec before code.** Review the output against acceptance criteria you approved, not against the model's own idea of done.
- **A human owns the ground truth.** Fix the fixtures and expected answers before the code exists ([`tests/ground-truth.test.ts`](../tests/ground-truth.test.ts)); tests written by the same agent can share its misunderstanding.
- **Run sabotage checks.** For each critical rule, break it on purpose and confirm a test fails ([review checklist](review-checklist.md#sabotage-checks-run)). This tests the tests; mutation testing automates it.
- **Review critical diffs in a fresh context:** a reviewer agent with only the diff, the spec and the checklist. It caught real defects that passed every test ([`docs/notes/ai-usage-log.md`](notes/ai-usage-log.md)).
- **Weight review by risk.** Read auth, money fields, idempotency, signing and approvals line by line; skim the wiring.
- **Keep PRs small and single-purpose.** AI makes code cheap to write and expensive to review. The agent proposes; a human reviews and merges.

## 19. Where this repo falls short of this list

| Gap | Consequence | Fix |
|---|---|---|
| No breaking-change check in CI, although the contract's description implies one | A breaking contract change could merge | Add an `oasdiff breaking` step against `main`'s contract |
| Rate limits in memory, SQLite on one file, a dispatcher and a snapshot poller in every process | Wrong behaviour with more than one replica | Gateway plus Redis for limits, Postgres, `SKIP LOCKED` workers, a shared snapshot store |
| The circuit breaker counts upstream 429s | Exhausting the quota opens the breaker for everyone | Handle 429 separately and honour `Retry-After` |
| A stale idempotency claim can be taken over before the body hash is compared | A different body under the same key could take over the claim | Compare the hash first; allow takeover only for an identical request |
| The sender signs webhooks with one secret | Rotating the secret breaks receivers | Sign with the current and previous secret during the overlap |
| The receiver-side verifier dedupes against a set of seen IDs that the caller supplies; nothing here persists that set | Unless the receiver stores the IDs, a replay within the 5-minute window is accepted after a restart or on another instance | Ship a receiver SDK that keeps seen IDs in a durable store for at least the tolerance window |
| An approver can approve an escalation their own agent proposed | Weaker separation of duties | Require approver ≠ requester, an approver role from the IdP, and two approvers for high-risk actions |
| No deprecation headers emitted | None yet, since nothing is deprecated | Emit `Deprecation`/`Sunset` when the first operation is retired |
