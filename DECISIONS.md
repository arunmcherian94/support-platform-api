# Decisions

Key trade-offs, assumptions and what was skipped, recorded at the time each decision was made. Significant decisions link to an ADR in [`docs/adr/`](docs/adr/) with the full alternatives and sources.

## Decision log

| # | Decision | Why (short) | ADR |
|---|---|---|---|
| 1 | Node 26 LTS, TypeScript 6, Express 5 + `express-openapi-validator` | The running service must validate **responses** against the OAS 3.1 contract; Fastify only serialises against response schemas | [ADR-0001](docs/adr/ADR-0001-runtime-and-core-stack.md) |
| 2 | SQLite via built-in `node:sqlite` behind a repository layer | Zero ops and no native build; the schema ports to Postgres | ADR-0001 |
| 3 | MCP TypeScript SDK v2, spec 2026-07-28, stdio | Current stable line; the stateless spec's "server-minted handles as tool arguments" fits our pending-action approval design | ADR-0001 |
| 4 | Build what the brief requires; stretch: the event path for `case.escalated` as a local queue (`webhook_deliveries` plus a background dispatcher) | Working core over breadth. The brief allows a simple local queue for the stretch; escalate is built minimally because the `escalate_case` tool needs a real endpoint | S4 |
| 5 | Ports and adapters; one mock process serving all three upstreams over HTTP, with fault injection | Vendor shapes stay at the boundary; a provider switch means a new adapter; resilience claims can be demonstrated | [ADR-0002](docs/adr/ADR-0002-upstream-integration-and-mocks.md) |
| 6 | Cases never cached; writes go through synchronously | Agents act on case state; stale state on a write path is worse than latency | ADR-0002 |
| 7 | Entitlement is a refreshed snapshot; polled every 15 minutes; maximum staleness 48h (from the CSV export) before 503 | Exports are periodic files (assumed nightly CSV, hourly XML); polling faster buys no freshness; the last good snapshot gives stale-on-error fallback | [ADR-0003](docs/adr/ADR-0003-entitlement-snapshot-precedence-and-ids.md) |
| 8 | Field-level precedence: tier and renewal from XML when newer, else CSV; name and ARR from CSV only | Fresher data where it's fresher, system of record for money | ADR-0003 |
| 9 | Account IDs: canonical `ACC-NNN` plus an explicit crosswalk; unmatched IDs reported; no name matching | `ACC-77` vs `ACC-007` is a real mismatch that padding can't fix; a wrong join is worse than a reported gap | ADR-0003 |
| 10 | iPaaS consumes the API and (in production) runs bulk export ingestion; custom code owns rules, auth, guardrails, MCP | Each tool where it is strong | [ADR-0004](docs/adr/ADR-0004-ipaas-placement.md) |
| 11 | Entitlement required, usage optional in the customer aggregate | No customer without entitlement; usage loss → `degraded: true` | ADR-0002 |
| 12 | Errors: RFC 9457 with `type` as the identifier; no `code` or `retryable` extensions; 400 for request validation | Standard first: `type` and `Retry-After` already carry what those fields would | [ADR-0005](docs/adr/ADR-0005-api-contract-conventions.md) |
| 13 | Versioning: `/v1` in the path; additive changes only; `Deprecation` + `Sunset` headers; 6 months' overlap | Most common scheme; simplest for gateways and iPaaS connectors | ADR-0005 |
| 14 | ARR omitted (not nulled) without `finance:read` | "Hidden" must not read as "zero" | ADR-0005 |
| 15 | `Idempotency-Key` on comments only, 24h | Duplicate comments are a real side effect; escalate's state rule and `If-Match` already block repeats | ADR-0005 |
| 16 | Strong `ETag` from an adapter-supplied concurrency token; `If-Match` required on escalate only | The gap between reading and acting (stretched by human approval) is where stale decisions happen | ADR-0005 |
| 17 | Keyset cursors, opaque and unsigned, bound to filters and sort | Authorization is re-applied per request, so signing adds a secret without adding safety | ADR-0005 |
| 18 | Escalation is a sub-object, not a status; eligibility matrix by priority and tier; synchronous 200 | Escalated cases are still open or in progress; the upstream write is synchronous | ADR-0005 |
| 19 | `case.escalated`: Standard Webhooks; small payload (IDs, routing fields, actor; no ARR or free text); retries over about 23h, then dead-letter | Receivers fetch the rest with their own scopes | ADR-0005 |
| 20 | Comments on closed cases: no platform rule | The case system owns that rule | ADR-0005 |
| 21 | `GET /v1/cases/{caseId}` added | The way to get the `ETag` that escalate needs | ADR-0005 |
| 22 | Gate 3a: `make run` **and** `docker compose up` | `make` for development, Compose for reviewers | [S2](docs/specs/S2-platform-foundations.md) |
| 23 | Gate 3a: timeouts per upstream within an overall request budget | One slow optional upstream must not consume the whole request | read-path spec |
| 24 | Gate 3a: retries via cockatiel with backoff and jitter; reads and idempotent writes only; 429 honours `Retry-After` | Retrying a non-idempotent write can duplicate it | read-path spec |
| 25 | Gate 3a: a circuit breaker per upstream; the entitlement snapshot doubles as a stale-on-error fallback | Fail fast when an upstream is down; the snapshot design gives fallback for free (ADR-0003) | read-path spec |
| 26 | Gate 3a: validation driven by `openapi.yaml`; responses strict in dev/test/CI, log-only option in production | The contract is the runtime source of truth; contract drift shouldn't become an outage | S2 |
| 27 | Gate 3a: contract tests = strict response validation against `openapi.yaml` in every test | Any response that drifts from the contract fails the suite; property-based testing (Schemathesis) was planned but not built, see "Skipped" | — |
| 28 | Gate 3a: Postman collection generated from the spec, then functional and regression checks added; Newman run | Starts complete, then gains the checks that matter | — |
| 29 | Gate 3a: pino JSON logs, correlation ID plus `traceparent` | Required correlation, ready for tracing later | S2 |
| 31 | Response schemas are closed (`additionalProperties`/`unevaluatedProperties: false`), enforced at runtime and by a Spectral rule | An undeclared field such as ARR can't leak past the contract; clients still ignore unknown fields, so additions stay non-breaking | [ADR-0005](docs/adr/ADR-0005-api-contract-conventions.md) |
| 30 | Critical-tier specs ship in their own PR, merged before code | Approving a design and approving code are different acts; the merge makes the design decision durable and visible | CLAUDE.md §11 |
| 32 | Resilience numbers: 10 s request budget (configurable); cases 3 s × 3 attempts, warehouse 1.5 s × 2; breaker opens after 5 consecutive failures, half-open after 10 s; **429 counts as a breaker failure**, other 4xx never do | Few retries, so a struggling upstream isn't hammered; the optional warehouse fails fast to a degraded answer. The upstream's quota belongs to the platform, so a 429 means everyone slows down; per-caller limits must stay below each caller's share so one consumer can't open the breaker for all | [S3](docs/specs/S3-read-path.md) |
| 33 | Case search pushes every filter to the case system; tier and renewal filters become an account list (400 above 500 accounts) | The case system sorts and pages, so one page needs one upstream call, with no in-memory scan or record cap | S3 |
| 34 | Comment idempotency: atomic key claim; only successes stored; the upstream write is a single attempt, never retried | Failures release the key so the client can retry it. A create that lands upstream but times out can still be duplicated by a retry: closing that needs the case system (external-ID upsert), so it's documented, not built | [S4](docs/specs/S4-comments-and-webhooks.md) |
| 35 | Escalation is two-phase: `escalate_case` stores a pending action; a human approves with their own token, bound to the case `ETag` | The agent decides what to do but never carries the authority to do it; a client prompt can't be seen or enforced by the server | [ADR-0006](docs/adr/ADR-0006-mcp-and-agent-guardrails.md) |
| 36 | Agent identity by token exchange: `sub` = user, `act.sub` = agent, scopes = user ∩ agent policy, no chained delegation | The agent can never do more than its user; ARR never reaches it | ADR-0006 |
| 37 | MCP over stdio now; Streamable HTTP with MCP authorization is the production path | One local user, no network surface, reproducible runs; tools, approval and audit don't depend on the transport | ADR-0006 |
| 38 | Five task-shaped tools (`get_case` added) with closed schemas, compact rows and structured errors | Tools follow the question, not the resources; `get_case` is the only way comments reach the agent | ADR-0006 |
| 39 | Untrusted text normalised, masked, defanged, capped and flagged; detection best-effort, enforcement structural | No detector catches everything; single-case tools, approval and scopes cap the damage of whatever gets through | ADR-0006 |
| 40 | Demo: OpenAI Responses API (`gpt-6-luna`, overridable) in a manual tool loop over the MCP client; dry run by default, one live run with a committed transcript | Reviewers need no key; the cheapest current model keeps the paid run small; the loop is short enough to read, and the approval prompt sits between turns | [S5](docs/specs/S5-agent-enablement.md) |

## Requirements traceability
Built = implemented and tested; Documented = deferred with a plan under "Skipped"; Part D = still to write.

| ID | Requirement | Where | Status |
|---|---|---|---|
| G1 | List what was skipped and how it would be done | This file, "Skipped" | Built |
| G2 | AI usage: what for, what it got wrong, how verified | `AI_USAGE.md`, `docs/notes/ai-usage-log.md` | Part D |
| G3 | Mocks only; no real credentials; nothing paid deployed | `mocks/`, `.env.example` | Built |
| S1 | Three stubbed upstreams: JSON, CSV and one XML feed | `mocks/` | Built |
| S2 | Two consumer types: apps/iPaaS and AI agents | REST API + `mcp/` | Built |
| A1 | Aggregated customer view (entitlement + usage) | `openapi.yaml`, `GET /v1/customers/{id}` | Built |
| A2 | Case search with filtering, sorting, cursor pagination | `GET /v1/cases` | Built |
| A3 | Idempotent comment create | `POST /v1/cases/{id}/comments` | Built |
| A4 | Escalation with business rules | `POST /v1/cases/{id}/escalate` | Built |
| A5 | `case.escalated` webhook with signature verification | `openapi.yaml` `webhooks`, `src/events/` | Built |
| A6 | Resource modelling; aggregate vs expose | `openapi.yaml`, ADR-0005 | Built |
| A7 | Consistent error model | RFC 9457 problem types, ADR-0005 | Built |
| A8 | Versioning and deprecation | `/v1`, ADR-0005 | Built |
| A9 | OAuth scopes; ARR only with `finance:read` | `openapi.yaml` security, row 14 | Built |
| A10 | Idempotency keys, ETags, rate-limit headers | ADR-0005, rows 15–17 | Built |
| A11 | Why REST; where GraphQL or gRPC fit | `openapi.yaml` description | Built |
| B1 | Items 1–3 plus the webhook sender | `src/` | Built |
| B2 | Single-command run | `make run`, `docker compose up` | Built |
| B3 | Persistent store with a justified schema | `src/store/`, "Data model" | Built |
| B4 | Timeouts, retries with backoff, circuit breaker | `src/adapters/`, rows 23–25, 32 | Built |
| B5 | Degraded flag on partial failure | `GET /v1/customers/{id}` | Built |
| B6 | Input validation and consistent errors | spec-driven validation | Built |
| B7 | Unit and contract tests | `tests/` (strict response validation in every test) | Built |
| B8 | Postman collection and environment | `postman/` | Built |
| B9 | Structured logs with correlation IDs | `src/observability/` | Built |
| B10 | Stretch: event path for `case.escalated` | local queue: `webhook_deliveries` + dispatcher (row 4) | Built |
| C1 | MCP server wrapping the API | `mcp/server/` (stdio) | Built |
| C2 | The four named tools (plus `get_case`) | `mcp/server/tools.ts` | Built |
| C3 | Deliberate tool schemas and descriptions | `mcp/server/tools.ts`, "Agent enablement" | Built |
| C4 | Tools vs REST resources | "Agent enablement" | Built |
| C5 | Identity propagation, not a super-user | token exchange, row 36 | Built |
| C6 | Human in the loop for high-risk writes | pending actions + `make approve`, row 35 | Built |
| C7 | Prompt injection via data | guardrails, ADR-0006 | Built |
| C8 | PII and ARR redaction; output limits | guardrails, ADR-0006 | Built |
| C9 | Per-agent rate limits; audit every tool call | `src/http/rate-limit.ts`, `audit_log` | Built |
| C10 | Demo: an LLM answers the sample question | `mcp/demo/`, transcripts | Built |
| C11 | One real failure and its fix | `mcp/demo/README.md` | Built |
| D1–D8 | Platform write-up | `PLATFORM.md` (spec S6) | Part D |
| X1 | All deliverables at their paths | repo root | Part D (README, PLATFORM, AI_USAGE) |
| X2 | README gets a reviewer running in under 5 minutes | `README.md` | Part D |

## Data quirks and how they're handled
- **Mixed casing in case JSON** (`Status`, `Comments` vs `openedAt`): normalised to canonical camelCase in the case adapter; upstream shapes never leave the adapter.
- **Inconsistent account IDs** (`ACC-77` vs `ACC-007`): see decision 9.
- **Comments have no IDs in the sample shape.** The case mock gives each comment an `id` (Salesforce's CaseComment has one), because the contract returns comment IDs.
- **Renewal in two sources** (`contract_end` vs `renewal`): see decision 8. Responses carry `source` and `asOf` for tier and renewal.
- **Monthly usage grain**: the summary returns the latest month plus a month-on-month trend, not raw rows.

## Assumptions
- Interpretation of the sample question (open statuses, strict 48h, inclusive 90-day window): [S1 §4](docs/specs/S1-upstream-sources-and-fixtures.md).
- Support tiers are `platinum`, `gold` and `silver`; the scenario names only Platinum.
- **Status and priority vocabularies** are inferred from one sample, which shows only `open` and `P1`. We assume `open`, `in_progress` and `closed`, and `P1`–`P4`.
- **Case change marker.** The sample case has no `version` or `updatedAt`. The mock adds a `version`, which becomes the ETag. For a provider without one, the adapter would hash the case's canonical fields. It would not use the latest comment's `at`: that changes only when a comment is added, so a priority change or a closure would keep the same ETag, exactly the changes `If-Match` exists to catch.
- **One row per account.** The sample has one CSV row per account. If an account appears more than once, the row with the latest `contract_end` wins and the duplicate is logged (ADR-0003 §4). The fixtures include an older, expired contract for ACC-012 to prove it.
- **Contract end stands in for renewal.** Notice periods aren't modelled; an explicit XML `renewal` takes precedence when newer.
- **XML timestamp.** The sample XML fragment has no root element or timestamp; the fixture adds `<entitlements generatedAt=…>`. A feed without one is treated as a failed refresh: without the source's own time, staleness can't be judged.
- **Usage lags by up to a month.** Months are reported once closed, so at the fixture date (6 Nov) the latest month is October. Responses carry `latestMonth`, and consumers should present it as "as of October", not as current.
- **The sample question asks for customers.** The answer is four accounts (ACC-007, ACC-012, ACC-030, ACC-042), each with its qualifying cases, not a list of five case IDs.
- **Account IDs in the API are canonical only** (`ACC-NNN`). ERP IDs such as `ACC-77` are resolved internally and never exposed. Passing one gets a 400 (see Skipped for the lookup we'd add).
- Export cadence: nightly CSV, hourly XML (ADR-0003).

## Data model
SQLite via `node:sqlite`: zero ops, a single file, built into Node, and WAL mode lets reads proceed during writes. All SQL lives in the repository layer, so moving engines touches one place. Tables are `STRICT`; times are RFC 3339 UTC text; migrations are numbered `.sql` files applied once each, in order, in their own transaction.

| Table | Purpose | Primary key and why | Indexes and the query each serves | Retention |
| --- | --- | --- | --- | --- |
| `idempotency_keys` | Replay or reject repeated writes | `(client_id, sub, endpoint, key)`: keys are scoped to caller and endpoint, so one client can never collide with or read another's | `expires_at`: the sweep `DELETE ... WHERE expires_at < now` | 24 hours, then swept |
| `audit_log` | Who did what to which resource | `id` (autoincrementing): a total order for an append-only log | `(resource_type, resource_id, at)`: history of one case or account. `(actor_sub, at)`: what a user did. `(actor_agent, at)`: what an agent did | Kept. Triggers reject UPDATE and DELETE. In production, shipped to an immutable store with its own retention |
| `pending_actions` | Escalations proposed by the agent, waiting for a human | `id` (`pa_…`, random): the handle the human approves | `(status, expires_at)`: open proposals and expiry. `(case_id, status)`: reuse an open proposal instead of creating a duplicate | Kept with the audit log; decided rows are history |
| `webhook_subscriptions` | Registered receivers | `id`: the handle in the API | None: the table is small and read whole when fanning out. `secret_ref` points at a secret, never holds one | Until deleted |
| `webhook_deliveries` | Outbox: one row per event per subscription, with the exact signed bytes | `id`: it is the `webhook-id` receivers use to dedupe | `(status, next_attempt_at)`: the worker's "pending and due" poll | 30 days after delivered or dead |

Postgres path: the same tables with native types (`timestamptz`, `jsonb`, `bigint`); append-only enforced by `REVOKE UPDATE, DELETE` instead of triggers; the delivery index becomes a partial index on `status = 'pending'`; sweeping runs as a scheduled job; the outbox poll uses `FOR UPDATE SKIP LOCKED` so several workers can share it.

## Agent enablement (Part C)
Full reasoning and the threat model are in [ADR-0006](docs/adr/ADR-0006-mcp-and-agent-guardrails.md); the spec is [S5](docs/specs/S5-agent-enablement.md).

### Tools versus REST resources
REST serves many consumers with stable, general resources. A tool serves one model answering one kind of question, so it is shaped by the task and by what the model is bad at (time arithmetic, protocol headers, retry safety).

| REST | Tool | What changes, and why |
|---|---|---|
| `GET /v1/cases?openedBefore=…&accountTier=…&renewalWithinDays=…` | `search_cases` | `minOpenHours` instead of a timestamp: the model needs no clock. Rows carry only what the question needs (ID, subject, priority, status, hours open, account name, tier, renewal date). At most 20 rows; the tool's own cursor. Leaving `status` out means every state except closed (REST applies no status filter), because "open" in a question means not closed |
| `GET /v1/customers/{id}` | `get_customer_summary` | Tier, entitlements, latest usage and trend, and which sources are degraded; no provenance envelope. `arr` only when the API returns it |
| `GET /v1/cases/{id}` | `get_case` | The latest 5 comments, each as untrusted text with flags; the `ETag` is never shown to the model |
| `POST /v1/cases/{id}/comments` + `Idempotency-Key` | `add_case_comment` | The server derives the key from (user, case, body), so a model's retry can't post twice; the comment is echoed back; sensitive content refused |
| `POST /v1/cases/{id}/escalate` + `If-Match` | `escalate_case` | Proposes instead of acting: stores the arguments and the current `ETag`, returns a preview and a pending ID. The human's approval sends `If-Match` |

Descriptions are written for the model: when to use the tool and when not, units and limits for each parameter, and what to do on each error code (`rate_limited`: wait `retryAfterSeconds`; `awaiting_human_approval`: tell the user and don't retry).

### Identity propagation

```
user (jdoe) --login--> dev issuer --user token--> MCP server (USER_TOKEN)
MCP server --token exchange, as support-copilot--> dev issuer
           <-- delegated token: sub=jdoe, act.sub=support-copilot, scopes = jdoe ∩ copilot
MCP server --Bearer delegated token, X-Request-Id--> API --> upstreams
API and MCP server --> audit_log (sub, agent, client, outcome, correlation ID)
human (jdoe) --own token, If-Match--> API   (approval: make approve or the demo prompt)
```

| User | User scopes | ∩ copilot policy (`customers:read cases:read cases:comment cases:escalate`) | Effect |
|---|---|---|---|
| jdoe (support) | customers, cases, comment, escalate | all four | Full agent toolset |
| fbaker (finance) | customers, cases, `finance:read` | customers, cases | No comments or escalations; `finance:read` dropped, so no ARR |

### Guardrails, as decided at Gate 4a
- **Human in the loop:** server-side pending action, 15-minute expiry, approved with the human's own token and the stored `ETag`; rejected, expired and stale proposals never run. `add_case_comment` is the low-risk write: no approval, but echoed back and checked for sensitive content.
- **Prompt injection:** structural first (single-case tools, approval, scopes, rate limits); then content handling (untrusted wrapper, normalisation, flags).
- **Redaction:** ARR by scope at the API; emails and phone numbers masked in tool output; comment bodies and escalation notes with emails, phones or money refused.
- **Output limits:** 20 rows, 300 characters per text field, about 8 KB per response.
- **Rate limits:** the API's per-agent bucket (keyed by `act.sub`) plus 30 calls per MCP session.
- **Audit:** a row per tool call and per approval decision. Example: `SELECT at, action, actor_sub, actor_agent, outcome, correlation_id FROM audit_log WHERE action LIKE 'mcp.%' OR action LIKE 'approval.%' ORDER BY id;`

### Known limits of what's built
- Any dev client may use the exchange grant; the intersection still caps the result. A real token service restricts the grant to registered agent clients.
- `support-copilot` can still get a non-delegated token by client credentials (used before token exchange existed). In production that client would have no client-credentials grant.
- Account names and comment authors are cleaned and masked but not wrapped or flagged as untrusted.
- URL defanging misses scheme-less hosts (`evil.example/x`) and doesn't strip userinfo.
- The approval's audit row links to the proposal by pending-action ID, not by the proposing call's correlation ID.
- A `make mcp` session lasts as long as `USER_TOKEN` (15 minutes with the dev issuer); then tools return `unauthorized`.
- The escalation is written upstream first, then its audit row and `case.escalated` delivery are stored in one local transaction. If that transaction fails after the upstream write, the error is logged and the 200 still returned, so that event and audit row are lost. A transactional outbox with an upstream reconciliation would close the gap (see "Skipped").
- Pre-handler failures (malformed JSON-RPC, unknown tool names) are refused by the SDK and not audited; every call that reaches a tool handler is.
- The demo calls OpenAI's Responses API directly rather than through a provider interface; a second provider means putting the loop's two provider-specific pieces (the create call and the tool-output shape) behind one. OpenAI was chosen over the originally planned Anthropic API because a key was already available; nothing in the MCP server depends on the provider.

## Skipped, and how I'd do it with more time
_Filled in as items are deferred; the final list mirrors the traceability matrix._

- **Looking up customers by the IDs and names users know.** Users more often know the ERP's ID (`ACC-77`), or the customer's name, than our canonical ID. Today the API accepts only canonical IDs. With more time:
  - accept known aliases on `GET /v1/customers/{id}`, resolved through the crosswalk, and return the canonical `id` in the response;
  - add `GET /v1/customers?q=` returning ranked candidates (exact alias, name prefix, fuzzy name), each with its match type, for the user or agent to confirm.

  Fuzzy matching is only ever for **search**, never for **joins** between systems: a wrong join silently attaches one customer's tier and ARR to another (ADR-0003).
- **Rate limits per user, not just per client and agent.** Buckets are keyed by client and by agent, so every user of a client shares one bucket, and an agent's bucket spans all its users. Delegated tokens now carry both `sub` and `act.sub`, so an agent-plus-user key is a small change in `src/http/rate-limit.ts`; not built.
- **Distributed rate limiting.** Buckets are in memory, per instance: N replicas allow N times the quota. In production the gateway or a shared store (Redis) enforces the limit; this service keeps per-agent limits as defence in depth.
- **JWKS stale-on-error.** Keys are cached for an hour; an identity provider outage longer than that gives 503. With more time, keep the last good key set for a bounded period beyond that.
- **Access-token hardening for a real IdP:** require `typ: at+jwt` (RFC 9068) and a maximum token age.
- **Comment paging.** `GET /v1/cases/{caseId}` returns the newest 50 comments plus `commentCount`. A `GET /v1/cases/{caseId}/comments?cursor=` sub-collection is an additive change when a consumer needs older comments.
- **Postman collection in CI.** `postman/` runs by hand against `make run` (`make postman`); CI runs typecheck, lint and the Vitest suite, which already covers these behaviours. Running it in CI means starting mocks and API in the job, then Newman, with a JUnit report.
- **Streamable HTTP with MCP authorization.** The server would become an OAuth resource server: protected-resource metadata, each request's bearer token exchanged per call, stateless behind the gateway (TLS, WAF, rate limits), scaled horizontally. Migration swaps the transport and takes identity from each request instead of `USER_TOKEN`; tools, guardrails, approval and audit stay.
- **An approvals service.** Approvals in a UI or chat with the exact action shown, transaction-bound authorization requests (RFC 9396 authorization details), step-up or backchannel confirmation for high-risk actions, optional second approver, its own store instead of the API's SQLite file. Also records `approvedBy` on the case through a proposal reference in the escalate request (a contract change).
- **MCP elicitation for approval.** Could become a convenience on top of the server-side gate once client support settles; never the control.
- **Tracking sensitive values across a session.** Remember values returned earlier (ARR, contacts) and refuse writes that contain them, not just ones that match patterns.
- **Homoglyph and base64 detection.** Map confusable characters across scripts to a skeleton before detecting; decode base64-looking runs and scan them.
- **Client-side allow-listing against tool poisoning.** The host pins which servers and tool descriptions it trusts; outside this server's control.
- **A test for every tool error code.** The S5 subset is tested (scope, not found, rate limit, session cap, validation, sensitive content, invalid state, approval outcomes); `upstream_unavailable` and `unauthorized` are covered only by the problem-mapping unit test.
- **MCP resources and prompts, and an approval-status tool.** Not needed for the question; a status tool would let the agent report a decision without the harness telling it.
- **A real token service and identity provider.** The dev issuer simulates both; production uses the company IdP's token-exchange endpoint.
- **Agent evals.** One scripted demo question and targeted injection tests now; a golden set run on every prompt, tool-description or model change later.
- **Conditional polling of the entitlement feeds.** Each poll is a plain fetch of a small file. For large exports, send `If-None-Match` / `If-Modified-Since` with the last validators so an unchanged feed costs a `304`, not a download; or move to the ERP's change feed or webhooks instead of polling.
- **Paging through the case system.** The case adapter asks for one page per request with keyset parameters. A real Salesforce adapter would follow `nextRecordsUrl` (query locators) when one page doesn't cover the request.
- **Property-based contract testing.** Strict response validation runs in every test, so any response that breaks the contract fails the suite. Schemathesis against the running stack would add inputs nobody hand-picked (malformed and edge-case requests, flagging any 5xx or undeclared status). It needs mocks and API running, so it would be a local `make` target or a CI job that boots the stack.
- **A full transactional outbox and a broker.** The stretch is met by a local queue: escalate stores the `case.escalated` delivery in the same transaction as its audit row, and a background dispatcher sends it with retries and dead-lettering. Production would add a separate outbox table with a relay, so other consumers can subscribe, and a broker (Kafka or EventBridge) in place of the table. It would also close the gap where the upstream write succeeds but the local transaction fails.
