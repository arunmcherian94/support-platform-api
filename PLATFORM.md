# Platform best practices and NFRs

How this API would run as a shared platform in production. Each section takes a position and says what is **built in this repo** and what is **proposed**. The SLO numbers are proposed targets, not measured in this repo; they would be checked against a load test and real traffic before being committed to.

## 1. Gateway versus service

The gateway protects the platform; the service enforces business rules. Nothing that needs domain knowledge lives in the gateway.

| Policy | Gateway (Kong, Apigee, AWS API Gateway, …) | Service |
|---|---|---|
| Auth | TLS, WAF, JWT signature, issuer, expiry and audience | Scopes per operation and per field (ARR only with `finance:read`); delegated tokens with nested delegation refused |
| Rate limiting | Coarse quota and burst limit per client, so floods never reach the service | Business limits: 100/min per client, 30/min per agent (keyed on `act.sub`), with `RateLimit` and `RateLimit-Policy` headers |
| Schema validation | Body size and content type only | Full validation of requests **and responses** against the contract |
| Transformation | Headers only: add a request ID, strip internal headers, route `/v1` | All aggregation of the three systems, staleness, partial results |
| Other | Access logs, CORS | Idempotency, `If-Match`, upstream timeouts and circuit breakers, audit, PII masking |

Logic in a gateway is hard to test, version and review, and it ties the platform to a vendor. Response validation and per-field redaction need the domain, so they stay in the service.

**MCP traffic path:** agent host → gateway, on its own route (`/mcp`, Streamable HTTP; stricter limits, longer timeouts for streaming, no caching) → stateless MCP server → token exchange (RFC 8693) for a delegated token → API through the internal gateway route → API enforces scopes. The MCP server never decides access.

**Built here:** auth, both rate limits and contract validation, all in the service, because there is no gateway in this repo. The MCP server runs over stdio locally (see DECISIONS). In production the coarse layer moves to the gateway and the service keeps its checks as defence in depth.

## 2. NFRs and SLOs

Targets for a tier-1 internal service, measured over 30 days. The API is measured at its edge; MCP tools per tool call at the MCP server, excluding model time and the human's approval time.

| | Customer summary (`GET /v1/customers/{id}`) | MCP read tools | `escalate_case` (propose) |
|---|---|---|---|
| Availability | 99.95% (about 22 min of budget a month) | 99.9% (about 43 min) | 99.9% |
| Latency p95 / p99 | 300 ms / 800 ms | 500 ms / 1.5 s | 500 ms / 1.5 s |
| Throughput | 100 req/s sustained, 300 burst | 30 calls/min per agent by design; total sized by agent count | same |

- **Why the summary can promise more than the tools:** its entitlement data is a local snapshot (bad only after 48 hours stale), and a usage-warehouse failure degrades the response instead of failing it. So it depends on no live upstream to succeed. Most MCP tools (searching cases, commenting, proposing an escalation) call the case system live, with no fallback, so they can't be more available than it is; one target covers all four tools.
- **Why these latencies:** the summary makes one upstream call (the warehouse); the case-based MCP tools make one or two calls to the case system, a SaaS API, plus one hop through the MCP server. The code bounds a request at 10 s and each upstream attempt at 1.5–5 s; those are failure limits, not targets, so hitting the p99 means retries are rare. In production the monthly usage data would be cached, which makes the summary target comfortable.
- **Availability SLI:** good requests ÷ valid requests. 5xx and 503 (stale entitlement, upstream down) are bad. 4xx, including 429 from our own limits, are excluded. A `200` with `degraded: true` counts as available, and a separate **completeness SLI** (share of responses not degraded, target 99%) keeps partial answers visible.
- **Latency SLI:** share of requests faster than the threshold, from server-side histograms.
- **Error budget and alerts:** multi-window burn-rate alerts. Page when the budget burns at 14.4× over 1 hour (confirmed over 5 minutes) or 6× over 6 hours; open a ticket at 1× over 3 days. When the budget is spent, reliability work comes before new features for that service.
- **Agent quality signals** (tracked, not SLOs): tool errors by code, `insufficient_scope` refusals, truncated responses, injection flags, and how many approvals expire unanswered.

**Built here:** the deadline, per-upstream timeouts, retries and circuit breakers that make these targets reachable, and the `degraded` flag. Not built: metrics and alerting.

## 3. Observability

**Built here:**
- Structured JSON logs (pino): one line per request with route template, status, latency, client, user and agent. Bodies are never logged; emails and phone numbers are masked.
- `X-Request-Id` accepted or generated and echoed; a W3C `traceparent` parsed or generated.
- Warnings when an upstream attempt fails or a circuit opens, and data-quality warnings from the entitlement ingest.
- An `audit_log` row for every MCP tool call and approval decision, with user, agent, client and outcome.

**Proposed:** OpenTelemetry for traces (one span per upstream call, with attempt and breaker state) and metrics (RED per route; per upstream latency, errors and breaker state; entitlement snapshot age; webhook queue depth and oldest pending age; MCP calls by tool and outcome). Metric labels stay low-cardinality: customer and case IDs go in traces and logs, never in metric labels.

**The dashboard, top to bottom:**
1. SLO status and error budget left, for the summary endpoint and the MCP tools.
2. Rate, errors and p95/p99 per route.
3. Upstream health: latency, errors, breaker state, and snapshot age against the 48-hour staleness limit.
4. Degraded responses by source.
5. Webhooks: queue depth, oldest pending delivery, failures by subscriber.
6. Agents: calls by tool and outcome, scope refusals, rate-limited calls, approvals pending, approved, rejected and expired.
7. Top clients by traffic and by 429s.

## 4. Governance

**Built here:**
- A Spectral ruleset with 10 custom rules (versioned paths, camelCase, RFC 9457 errors from shared components, declared scopes and auth errors, rate-limit headers, closed schemas), run in CI as part of `npm run lint` and failing on any finding.
- Every test validates responses against the contract at runtime.
- A review checklist (`docs/review-checklist.md`), ADRs for significant choices, and contract changes in their own PRs.

**Proposed:**
- **Breaking-change detection:** `oasdiff` in CI against the main branch's contract. A breaking change fails the build unless it ships as a new version with a deprecation plan (`Deprecation` and `Sunset` headers, a migration note).
- **Documentation standard:** every operation has a summary, examples, its scopes and its error responses; the portal is generated from the contract, so docs can't drift from the code.

**Adoption without formal authority:** make the right path the easy one.
- Publish the ruleset as a versioned package, and a project template with CI already wired.
- Start in warning mode on existing APIs and enforce only on new ones; waivers are written down in the ruleset, not argued in each review.
- Begin with one or two teams who want it, fix what they hit, and show their results.
- Tie it to something teams want: listing in the API catalog and gateway onboarding go through the lint check.
- Publish a lint score per API, and hold open office hours.

## 5. Security and compliance

- **Secrets:** none in the repo (`.env.example` only). In production: a secrets manager (Vault or the cloud's own) injected at runtime, short-lived upstream credentials, scheduled rotation. Webhook signatures are sent as a list, so a subscriber's secret can rotate with no gap (built).
- **mTLS:** between gateway and services, and service to service, through a mesh or SPIFFE workload identities. mTLS authenticates the workload; the token still authenticates the user and client.
- **Network:** services in private subnets, reachable only through the gateway. Egress to SaaS over private connectivity where the vendor offers it (e.g. PrivateLink); otherwise through an egress proxy with an allowlist and fixed IPs the vendor can allowlist.
- **Data:** ARR is visible only with `finance:read`, and the agent policy never includes it, so ARR can't reach a model (built).
- **Audit:** the `audit_log` rows (built) would ship to append-only storage with a retention period set by policy, along with access and configuration changes.
- **Change control (SOX):** every change through a PR with a reviewer who isn't the author, deploys only from the pipeline, no standing production access (break-glass logged), CI evidence kept per release.
- **FedRAMP:** an authorised region, FIPS-validated crypto, continuous vulnerability scanning with fixed remediation times. The control mapping would be done with the compliance team.

## 6. Reuse

The contract is the product; everything else is generated from it or wraps it.
- **SDKs** (TypeScript, Python) generated from `openapi.yaml` and published internally, with token handling, retries that honour `Retry-After`, idempotency keys, pagination and webhook verification built in.
- **iPaaS connector:** a custom connector for MuleSoft or Workato generated from the contract, plus a `case.escalated` webhook trigger.
- **MCP server:** registered as an internal MCP catalog entry with its tools, scopes and owner.
- **Catalog entry:** owner, SLOs, scopes, changelog, versioning and deprecation policy, and a sandbox. The mocks, fixtures and Postman collection in this repo are already that sandbox.

## 7. CI/CD

**Built here:** GitHub Actions on every PR runs typecheck, lint (ESLint, Prettier, Spectral) and the test suite, which includes contract validation of every response and the MCP guardrail tests. The Postman collection runs with Newman locally (`make postman`).

**Proposed pipeline:**
1. **PR:** the above, plus breaking-change check, secret scan, dependency and static analysis, and Newman against the compose stack.
2. **Build once:** container image with an SBOM, image scan, signed.
3. **Staging:** deploy the same image, run smoke tests and Newman.
4. **Production canary:** 5% → 25% → 100%, each step gated on error rate and SLO burn against the current version; automatic rollback on breach.
5. **Safe rollback:** database migrations are expand-then-contract, so the previous version still runs; new agent tools ship behind flags.

## 8. iPaaS versus custom code

**iPaaS for movement, custom code for rules and risk** (ADR-0004).
- **iPaaS (MuleSoft, Workato, Boomi):** scheduled ingestion of the ERP's CSV and XML exports into the entitlement store, and workflow automations triggered by our webhooks (e.g. `case.escalated` → open a CSM task, notify a channel). Connectors, schedules, retries and monitoring are what iPaaS does well.
- **Custom code:** the API and its contract, aggregation, field-level authorisation, idempotency and concurrency, upstream resilience, webhook signing and delivery, and the MCP server with its guardrails and approval gate. These need code review, tests and low latency, and they shouldn't depend on a vendor runtime.
- **Rejected:** iPaaS "system APIs" in front of the upstreams on the request path. They add a hop and a second failure domain, and split retries across two layers. If the organisation already runs them, pointing an adapter at them is an adapter change, not a redesign.
- Locally, the entitlement adapter does the ingestion itself, standing in for the iPaaS flow.
