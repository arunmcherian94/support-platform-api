# ADR-0004: iPaaS placement

- **Status:** Accepted (2026-11-06, Gate 1). PLATFORM.md §8 expands the reasoning.
- **Deciders:** human owner

## Context
The platform is consumed by traditional apps and iPaaS flows (MuleSoft, Workato, Boomi), and by AI agents. iPaaS tools are good at connector-based, scheduled or event-triggered data movement. They are weak at fine-grained authorization, custom business rules, agent guardrails and contract-first API governance.

## Decision
- **iPaaS is a consumer of the platform API.** Workflow automation such as "when a case is escalated, open a CSM task" calls the REST API or subscribes to the `case.escalated` webhook, using the same contract, scopes and rate limits as any client.
- **In production, iPaaS is the home for scheduled bulk ingestion** of the ERP exports (CSV/XML) into the platform's entitlement store. Moving files on a schedule, with retries and monitoring, is what iPaaS does well. Locally, the entitlement adapter does this ingestion itself (ADR-0003).
- **Custom code** owns everything with rules or risk:
  - the platform API and its contract;
  - authorization, including field-level ARR visibility;
  - idempotency and concurrency;
  - the MCP server and agent guardrails;
  - webhook signing.

## Alternatives considered
- **Build the whole API in the iPaaS** (e.g. MuleSoft API-led "system" and "process" APIs). Fast for connectors, but field-level authorization, delegated agent identity, the approval gate and the injection guardrails become hard to express, test and review. It also couples the platform's contract to a vendor runtime.
- **No iPaaS anywhere.** That means writing and operating custom file-transfer jobs the iPaaS already provides, with connectors, scheduling, retries and alerting.

## Consequences
- The contract is the integration boundary for every consumer, including iPaaS, so governance (Spectral, breaking-change checks) covers iPaaS traffic too.
- Ingestion in production depends on an iPaaS flow being operated well. Its freshness SLO feeds the entitlement `asOf` and the 24-hour staleness limit in ADR-0003.

## Revisit when
- A consumer needs transformations the API shouldn't own (e.g. a downstream system's format): that belongs in an iPaaS process flow, not a new endpoint.
