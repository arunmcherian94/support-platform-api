# ADR-0001: Runtime and core stack

- **Status:** Accepted (2026-11-06, Gate 0)
- **Deciders:** @arunmcherian94 (repository owner)

## Context
The service fronts three mocked upstreams for two kinds of consumer: apps and iPaaS flows, and AI agents over MCP. The contract (`openapi.yaml`, OpenAPI 3.1) is the source of truth at runtime. The service must validate **requests and responses** against it, so a handler cannot drift from the contract silently. The stack also needs a reference-quality MCP SDK, a zero-ops local store, and composable resilience policies.

## Decision

| Concern | Choice | Version pinned |
|---|---|---|
| Runtime | Node.js 26 (Active LTS) in Docker and CI; `engines: >=24` locally | 26.x |
| Language | TypeScript, `strict` | 6.0.x |
| HTTP | Express 5 + `express-openapi-validator` (request + response validation, OAS 3.1) | 5.3 / 5.6 |
| Store | SQLite via built-in `node:sqlite`, WAL mode, behind a repository layer | Node built-in |
| Resilience | `cockatiel` (timeout, retry with backoff + jitter, circuit breaker, composed per upstream) | 4.0 |
| Auth | `jose` for JWT signing (dev issuer), JWKS and verification | 6.2 |
| Logging | `pino`, JSON | 10.4 |
| MCP | TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`), spec 2026-07-28, stdio | 2.4 |
| Tests | Vitest; Schemathesis (via `uvx`) against the running server; Newman for the Postman collection | 5.1 / 4.33 / 6.2 |
| Contract lint | Spectral CLI with a custom ruleset; oasdiff for breaking-change detection | 6.17 / 1.35 |

## Alternatives considered
- **Fastify + `fastify-openapi-glue`.** Faster router, and the first proposal. Rejected because Fastify uses response schemas for *serialisation* (fast-json-stringify), not validation. OAS 3.1 / JSON Schema 2020-12 also needs a custom Ajv setup. Router throughput doesn't matter here: upstream I/O dominates latency.
- **`openapi-backend`.** Supports 3.1, but response validation is a manual per-handler call. Kept as the fallback if `express-openapi-validator` blocks us.
- **TypeScript 7.0 (native compiler).** `typescript-eslint` 8.72 supports `<6.1.0` only.
- **`better-sqlite3`.** Mature, but a native build in Docker and on reviewers' machines. `node:sqlite` is Stability 1.2 (release candidate) in Node 26; a swap means changing one file behind the repository layer.
- **MCP SDK v1 (`@modelcontextprotocol/sdk` 1.32).** Maintenance-only since v2's release (2026-07-27) and limited to the 2025-11-25 protocol. v2 implements 2026-07-28 and still negotiates 2025-11-25 with older clients.
- **`opossum` instead of `cockatiel`.** Circuit breaker only (plus timeout and fallback); retries with backoff would need a second library composed by hand. Cockatiel composes all the policies in one typed API with `AbortSignal` propagation.

## Consequences
- Every response is validated in-process. That costs some CPU per request; acceptable here, and in production it can be sampled or limited to non-prod. Contract drift fails tests rather than reaching consumers.
- MCP 2026-07-28 is stateless and says cross-call state should be server-minted handles passed as tool arguments. That matches our pending-action approval design. Server-initiated elicitation is replaced by Multi Round-Trip Requests, so human approval goes through the demo harness and doesn't depend on client elicitation support.
- **Risk:** SDK v2 and Express 5 APIs are newer than most published examples. Generated code is checked against installed type definitions (CLAUDE.md §11, failure patterns).
- **Risk:** `express-openapi-validator`'s last release was 2026-01-20. If it blocks a 3.1 feature we need, we fall back to `openapi-backend`.

## Sources (checked 2026-11-06)
- Node.js release index: https://nodejs.org/dist/index.json
- npm registry metadata for every package above; `typescript-eslint` peerDependencies
- express-openapi-validator README (OAS 3.1 since 5.4.0; `validateResponses`)
- fastify-openapi-glue README (draft-07 default; 2020-12 needs custom setup)
- MCP specification 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28
- modelcontextprotocol/typescript-sdk README (main = v2, stable line), plus inspection of the published `@modelcontextprotocol/core` 2.4.0 package
- Node.js v26 `sqlite` docs (Stability 1.2)

## Revisit when
- `typescript-eslint` supports TypeScript 7.
- `node:sqlite` causes a problem we can't work around.
- `express-openapi-validator` can't express a contract feature we need.
