# Customer Entitlement & Support Case Platform API

One REST API that joins three systems (a support case system, entitlement exports from the ERP, and a usage warehouse) into a single view of a customer and their cases, plus an MCP server that lets an AI agent use it safely on a user's behalf.

Everything runs locally: the three upstreams are mocks with fixed fixture data, and tokens come from a dev issuer. No accounts or keys are needed, except an OpenAI key for the optional live agent demo.

## Quick start

Needs Node 26 (see `.nvmrc`) and `make`. Docker is an alternative: `docker compose up` instead of `make run`.

```sh
make install      # pinned dependencies
make run          # mocks on :8081, API on :8080, at a fixed fixture clock
```

In a second terminal, get a token and ask the sample question (Platinum customers, P1 cases open over 48 hours, renewal within 90 days):

```sh
TOKEN=$(make -s token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/v1/cases?accountTier=platinum&priority=P1&status=open&status=in_progress&openedBefore=2026-11-04T12:00:00Z&renewalWithinDays=90"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/customers/ACC-007
```

The first call returns five cases (CS-10231, CS-10233, CS-10236, CS-10239, CS-10240). The customer view has no `arr`, because the support user lacks `finance:read`. Try `make -s token CLIENT=finance-app` to see it, or `CLIENT=ipaas-flow` to get a 403 on customers. The dev clients and their scopes are in `config/dev-clients.json`.

## Test

```sh
make check        # typecheck, lint (ESLint, Prettier, Spectral on the contract) and all tests: what CI runs
make postman      # the Postman collection through Newman, against a running `make run`
```

The Postman collection and environment are in `postman/` if you prefer the app.

## Demo the agent

```sh
make demo         # dry run: starts the MCP server, lists its tools. No LLM call.
make demo-live    # the agent answers the sample question (paid; needs OPENAI_API_KEY, under $0.001 a run)
```

When the agent proposes an escalation, the script asks you to approve it at the terminal; nothing is escalated until you do. Recorded runs, including one that failed and how it was fixed, are in [`mcp/demo/`](mcp/demo/README.md). To use the MCP server from your own client: `USER_TOKEN=$(make -s token) make mcp` (stdio).

Restart `make run` to reset state (escalations and comments are held by the mocks in memory). `make help` lists every target.

## Deliverables

| Deliverable | Where |
|---|---|
| API contract (OpenAPI 3.1) | [`openapi.yaml`](openapi.yaml), linted by [`.spectral.yaml`](.spectral.yaml) |
| Implementation and tests | [`src/`](src/), [`tests/`](tests/) |
| MCP server and agent demo | [`mcp/`](mcp/) |
| Postman collection and environment | [`postman/`](postman/) |
| Trade-offs, assumptions, what was skipped | [`DECISIONS.md`](DECISIONS.md) |
| Platform practices and NFRs | [`PLATFORM.md`](PLATFORM.md) |
| How AI was used and verified | [`AI_USAGE.md`](AI_USAGE.md) |

## Repository layout

| Folder | What's in it |
|---|---|
| `src/` | The API: `http/` (routes, middleware), `domain/` (pure rules), `adapters/` (one per upstream), `store/` (SQLite), `events/` (webhooks), `auth/` (dev issuer, token exchange) |
| `mcp/` | `server/` (tools, guardrails, approvals) and `demo/` (agent script, transcripts) |
| `mocks/` | The three mock upstreams, fixture data and fault injection |
| `tests/` | Unit, integration and MCP tests; every API response in them is validated against the contract |
| `postman/` | Collection and local environment |
| `scripts/` | `run.ts` (starts everything) and `approve.ts` (human approval of an escalation) |
| `config/` | Dev-only clients for the local token issuer |
| `docs/` | `specs/` (what was built, with acceptance criteria), `adr/` (key decisions), `notes/` (full decision log, journal, AI mistake log, spend log), `review-checklist.md` |
| `.claude/` | The AI tooling used to build this: a fresh-context reviewer agent and the build skill |
