# Decisions

The key trade-offs, the assumptions, and what was skipped. Every decision, with its date and reasoning, is in [`docs/notes/decision-log.md`](docs/notes/decision-log.md); the significant ones have an ADR in [`docs/adr/`](docs/adr/).

## Key decisions

**Shape of the build**
- **A working core over breadth.** Everything the brief requires is built. The one stretch item is the `case.escalated` event path, as a local queue: a `webhook_deliveries` table plus a background dispatcher, with retries and dead-lettering.
- **Node 26, TypeScript strict, Express 5 with `express-openapi-validator`.** Requests **and responses** are validated against `openapi.yaml` at runtime, and response schemas are closed. An undeclared field such as ARR fails instead of leaking ([ADR-0001](docs/adr/ADR-0001-runtime-and-core-stack.md)).
- **Ports and adapters.** One mock process serves all three upstreams over HTTP, with fault injection. Vendor shapes (`Status`, `ACC-77`) stop at the adapter, so switching provider means writing a new adapter ([ADR-0002](docs/adr/ADR-0002-upstream-integration-and-mocks.md)).

**Data from the three systems**
- **Cases are never cached;** writes go straight through. Agents act on case state, and acting on stale state is worse than slow state.
- **Entitlement is a polled snapshot** (every 15 minutes). The source's own export time is its `asOf`, and after 48 hours the data counts as stale (503). The last good snapshot doubles as the fallback when a refresh fails ([ADR-0003](docs/adr/ADR-0003-entitlement-snapshot-precedence-and-ids.md)).
- **Precedence by field.** Tier and renewal come from the XML feed when it is newer; name and ARR only ever come from the CSV, the system of record for money.
- **Account IDs:** canonical `ACC-NNN` plus an explicit crosswalk. Unmatched IDs are logged; names are never matched. A wrong join silently gives one customer another's ARR.
- **Partial failure:** entitlement is required and usage is optional. If the warehouse is down, the customer view still returns, with `degraded: true`.

**API contract** ([ADR-0005](docs/adr/ADR-0005-api-contract-conventions.md))
- **Errors:** RFC 9457, with `type` as the identifier and `Retry-After` on 429 and 503. No custom `code` or `retryable` fields, because the standard already carries that information.
- **Versioning:** `/v1` in the path and additive changes only. To retire a version: `Deprecation` and `Sunset` headers, then a 6-month overlap.
- **ARR needs `finance:read`.** Without it, the field is left out, not set to null: hidden must not read as zero.
- **Concurrency and retries:**
  - `Idempotency-Key` on comments (kept 24 hours), because a duplicate comment is a real side effect.
  - `If-Match` on escalate, because the gap between reading a case and acting on it is widest when a human must approve.
- **Cursors are keyset-based and opaque, but not signed.** Authorization is checked again on every request, so signing would add a secret without adding safety.

**Resilience**
- **Every upstream call has:**
  - a timeout, inside an overall 10-second budget per request;
  - retries with backoff and jitter, for reads and idempotent writes only;
  - a circuit breaker.
- **A comment create is never retried,** because it could land twice.
- **A 429 from an upstream opens the breaker for every caller,** because the upstream quota belongs to the whole platform.

**Agent enablement** ([ADR-0006](docs/adr/ADR-0006-mcp-and-agent-guardrails.md))
- **The agent acts for a user, not as itself.** The MCP server exchanges the user's token (RFC 8693) for a delegated one:
  - `sub` is the user, and `act.sub` is the agent;
  - its scopes are the user's scopes ∩ the agent's policy.
- **Escalation has two phases.**
  - `escalate_case` only stores a pending action and returns its ID.
  - A human approves it with their **own** token, tied to the case `ETag`; the proposal expires after 15 minutes.
  - The model has no tool that can approve anything.
- **Defences against prompt injection are structural first:**
  - tools act on one case at a time;
  - an escalation needs a human's approval;
  - the API enforces scopes and rate limits.
- **Content handling comes on top:** upstream text is wrapped as untrusted, normalised and capped, and likely injections are flagged. Detection is best-effort; the structure limits the damage from whatever gets through.
- **stdio transport for now.** One local user and no network surface. Streamable HTTP with MCP authorization is the production path, and the tools don't depend on the transport.

## MCP tools versus REST resources
REST serves many consumers through stable, general resources. A tool serves one model answering one kind of question, so it is shaped by the task and by what models are bad at: time arithmetic, protocol headers, and knowing whether a retry is safe.

| REST | Tool | What changes, and why |
|---|---|---|
| `GET /v1/cases` | `search_cases` | `minOpenHours` instead of a timestamp, so the model needs no clock. Compact rows with only what the question needs; at most 20. With no `status` given, it searches every state except closed, because "open" in a question means not closed |
| `GET /v1/customers/{id}` | `get_customer_summary` | Tier, entitlements, latest usage and its trend, and which sources are degraded. `arr` appears only if the user's scopes allow it |
| `GET /v1/cases/{id}` | `get_case` (added) | The latest 5 comments, each wrapped as untrusted text with flags. This is the only way comments reach the agent; the `ETag` stays hidden |
| `POST …/comments` + `Idempotency-Key` | `add_case_comment` | The server derives the key from (user, case, body), so a model's retry can't post twice. Comments containing emails, phone numbers or money amounts are refused |
| `POST …/escalate` + `If-Match` | `escalate_case` | Proposes instead of acting; the human's approval sends the `If-Match` |

Each description says when to use the tool and when not to, the units and limits of each parameter, and what to do on each error (for example, on `rate_limited`, wait `retryAfterSeconds`).

**Other guardrails:**
- emails and phone numbers are masked in tool output;
- each response is capped at about 8 KB, with 300 characters per text field;
- each agent has its own rate-limit bucket at the API, plus a cap of 30 calls per MCP session;
- every tool call and every approval decision writes an `audit_log` row (user, agent, outcome, correlation ID).

## Data model
SQLite through the built-in `node:sqlite`: no operations work and a single file, and it ports to Postgres. All SQL sits in a repository layer, and tables are `STRICT`.

| Table | Purpose | Key and indexes |
|---|---|---|
| `idempotency_keys` | Replay or reject repeated comment creates | PK `(client_id, sub, endpoint, key)`, so one caller can never see another's keys; `expires_at` for the 24h sweep |
| `audit_log` | Append-only record of who did what; triggers reject UPDATE and DELETE | `(resource_type, resource_id, at)`, `(actor_sub, at)`, `(actor_agent, at)`: one index for each audit question |
| `pending_actions` | Escalations waiting for a human | `(status, expires_at)` for open and expired proposals; `(case_id, status)` to reuse an open proposal instead of creating a duplicate |
| `webhook_deliveries` | Outbox for `case.escalated`, storing the exact signed bytes | `(status, next_attempt_at)`: the dispatcher's query for "pending and due" |
| `webhook_subscriptions` | Registered receivers; `secret_ref`, never the secret | none (a small table, read in full) |

## Assumptions
- **The sample question asks for customers.** The answer is four accounts (ACC-007, ACC-012, ACC-030, ACC-042), each with its qualifying P1 cases. "Open" means not closed, ">48 hours" is strict, and the 90-day window includes both ends ([S1](docs/specs/S1-upstream-sources-and-fixtures.md)).
- **Status and priority values are inferred** from a single sample: the statuses are `open`, `in_progress` and `closed`; priorities are `P1`–`P4`; tiers are platinum, gold and silver.
- **Contract end stands in for renewal**, unless the XML feed has a newer `renewal`. The CSV export is assumed nightly and the XML feed hourly.
- **The case system supplies a version number** (the mock adds one) to use as the `ETag`. Without one, the adapter would hash the case's fields.
- **Usage lags by up to a month:** months are reported once they close, and the response says which month the figures cover.

## Skipped, and how I'd do it with more time
- **Streamable HTTP with MCP authorization.** The MCP server would become an OAuth resource server: each request's token is exchanged, and it runs stateless behind the gateway. The tools, approval and audit stay as they are.
- **A real approvals service.** It would:
  - show the exact action in a UI or Slack, bound to the request (RFC 9396);
  - confirm high-risk actions through a step-up or backchannel prompt on the approver's device;
  - allow an optional second approver;
  - keep its own store instead of sharing the API's SQLite file.
- **A full transactional outbox and a broker.** A relay table feeding Kafka or EventBridge, so other consumers can subscribe. It would also close today's gap: if the upstream escalation succeeds but the local transaction fails, that event is lost.
- **Distributed and per-user rate limits.** Today's buckets are in memory and keyed by client or by agent. In production, the gateway or Redis would enforce the limits, with a key per agent and user.
- **Property-based contract testing.** Schemathesis against the running stack, to send inputs nobody picked by hand. Today every test validates its responses strictly against the contract.
- **Postman in CI.** Boot the mocks and the API in the CI job, then run Newman with a JUnit report. Today it runs by hand (`make postman`).
- **Customer lookup by ERP ID or name.** Accept known aliases through the crosswalk, and add `GET /v1/customers?q=` returning ranked candidates. Fuzzy matching would only ever be used for search, never for joining systems.
- **Agent evals.** A golden set of questions, run on every change to a tool description, the prompt or the model. Today there is one scripted demo plus targeted injection tests.
- **Stronger injection detection:** catch look-alike characters and decode base64, and track sensitive values across a session so a later write can't leak them.
- **A real IdP and token service** in place of the dev issuer, which simulates both.

The full list, with the reasoning for each item, is in the [decision log](docs/notes/decision-log.md#skipped-and-how-id-do-it-with-more-time).
