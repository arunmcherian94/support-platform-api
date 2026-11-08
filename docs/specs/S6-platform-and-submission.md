# S6: Platform write-up and submission

- **Status:** Implemented (PLATFORM.md and README.md).
- **Traceability:** D1 to D8, G1, G2, X1, X2 (`docs/notes/decision-log.md`, "Requirements traceability").

## 1. Deliverables
- **`PLATFORM.md`** (2–3 pages): a clear position on each of D1–D8 below, not a survey. Concrete numbers. Say what is built in this repo (Spectral rules, CI, the webhook queue) and what is proposed. Drafted by Claude; the human owner rewrites it in their own voice.
- **`AI_USAGE.md`:** what AI was used for, what it got wrong (from `docs/notes/ai-usage-log.md`, with real counts and examples), and how output was verified.
- **`README.md`:** run, test and demo in under 5 minutes from a fresh clone; a deliverables map (each deliverable and its path); a one-line-per-folder overview, including `.claude/`.
- **`DECISIONS.md`:** compact (key decisions, tools vs REST, data model, assumptions, top skips); the full log and traceability table live in `docs/notes/decision-log.md`, every row Built or Documented with a plan.

## 2. PLATFORM.md topics
| ID | Topic | Must take a position on |
|---|---|---|
| D1 | Gateway vs service | Which policies sit in the gateway and which in the service; how MCP traffic flows |
| D2 | NFRs and SLOs | Targets for the aggregate endpoint and the MCP tools (availability, p95/p99, throughput), SLI definitions, error budget, burn-rate alerts |
| D3 | Observability | Logs, metrics, traces; what the dashboard shows |
| D4 | Governance | Spectral, the review checklist, documentation standard, breaking-change detection in CI, adoption without authority |
| D5 | Security and compliance | Secrets, mTLS, network and private SaaS connectivity, audit and change control (SOX, FedRAMP) |
| D6 | Reuse | A shared connector, SDK or integration-catalog entry |
| D7 | CI/CD | Stages including security scanning, canary and rollback |
| D8 | iPaaS vs custom code | Which parts of this scenario go to iPaaS and which stay custom, and why |

## 3. Acceptance criteria
| ID | Criterion |
|---|---|
| S6-1 | Every one of D1–D8 has a clear position. |
| S6-2 | SLOs are concrete for both the aggregate endpoint and the MCP tools, with SLI definitions, an error budget and burn-rate alerting. |
| S6-3 | The iPaaS section names specific parts of this scenario for iPaaS and for custom code, with reasons. |
| S6-4 | `PLATFORM.md` fits in 2–3 pages. |
| S6-5 | A fresh clone followed by the README's steps reaches a successful API call in under 5 minutes, and `make test` passes. |

## 4. Submission checklist
- Every traceability row is Built or Documented with a plan.
- `make check` and `make postman` pass locally; CI is green.
- Demo transcripts committed; the failure case and its fix documented.
- `DECISIONS.md` covers the key trade-offs, assumptions, the data model and indexes, tools vs REST, and the main skips with a plan for each; the rest is in the decision log.
- No secrets, no copy of the brief, no real data anywhere in the repo or its history.
- Docs never overclaim: mocks, the dev issuer and the simulated token exchange are labelled.
- All PRs merged; history shows small, well-described commits.
