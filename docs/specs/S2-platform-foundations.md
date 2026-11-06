# S2 — Platform foundations

- **Status:** Draft. Merging this spec PR approves it (critical tier, CLAUDE.md §11), together with the Gate 3a decisions in DECISIONS.md.
- **Decisions:** ADR-0001 (stack), ADR-0005 (contract conventions).
- **Traceability:** B2, B6, B9, A7, A9 (verification part), A10 (rate-limit part), C8 (PII redaction, logging part), C9 (per-agent limits).

## 1. Problem
Every endpoint needs the same base:
- requests and responses validated against `openapi.yaml`;
- one error format;
- correlation IDs in every log line;
- verified tokens with scopes;
- rate limits;
- a store;
- a single command to run it all.

Building this once, before any endpoint, means each later PR adds behaviour, not plumbing.

## 2. Scope
1. **Server** (Express 5 + `express-openapi-validator`):
   - routes and validation come from `openapi.yaml`;
   - responses are validated too;
   - `/healthz` and `/readyz` (database check only; upstream checks come with the read path);
   - graceful shutdown: stop accepting, drain in-flight requests, close the database.
2. **Errors:** one error handler maps everything to RFC 9457 problems with the `type` URIs from the contract.
   - Validator failures become 400 `validation-failed`, with JSON-pointer `errors[]`.
   - Anything unexpected becomes 500 `internal-error`, with no details in the response; the details are logged under the correlation ID.
3. **Correlation and logging** (pino, JSON):
   - an inbound `X-Request-Id` is accepted if it is at most 128 characters of `[A-Za-z0-9._-]`; otherwise one is generated;
   - W3C `traceparent` is parsed, or generated if absent;
   - both are kept in `AsyncLocalStorage`, so every log line carries `correlationId` without passing it around;
   - `X-Request-Id` is echoed on every response;
   - **No secrets or personal data in logs.** The rule is structural first:
     - **Bodies are never logged.** Request and response bodies (comments, ARR, credentials) don't reach the logger. Log lines carry metadata only: method, route template, status, latency, correlation ID, client ID and user `sub`.
     - **Named fields are redacted:** `Authorization` and `Cookie` headers, `client_secret`, `assertion`, and any `password`, `secret` or `token` field.
     - **Errors carry no input values.** `errors[].detail` says what was wrong, not what was sent. Upstream failures are logged as status and error code, never the upstream body.
     - **Backstop:** a log serializer masks email addresses and phone numbers in any string that reaches the logger. It is best-effort, behind the structural rule.
     - **User IDs (`sub`) are kept,** for accountability. The audit log (later PRs) is the authoritative record, with its own retention and redacted arguments.
4. **Dev token issuer** (dev-only, clearly labelled):
   - an RS256 key pair generated at start-up;
   - `GET /dev/.well-known/jwks.json`;
   - `POST /dev/oauth/token` with the `client_credentials` grant for clients seeded from config. Each client has a secret, a set of allowed scopes and, for user simulation, a fixed `sub`.
   - **Not built:** the authorization-code flow listed in the contract (documented as not built). Token exchange comes in Part C.
   - **Off unless asked for.** The issuer routes are mounted only when `DEV_ISSUER=true`. Start-up refuses `DEV_ISSUER=true` together with `NODE_ENV=production`, so a token-minting endpoint can't ship enabled by accident.
   - **Why not a real identity provider locally** (e.g. Keycloak in Compose): more realistic (real login, key rotation), but a heavy container and slow start-up for a reviewer's five-minute setup. The verification path is the same either way: switching providers means changing the issuer URL, JWKS URL and audience in config.
5. **Token verification** (`jose`), done the way a real resource server does it:
   - signature checked against the issuer's JWKS URL;
   - `alg` pinned to RS256;
   - `iss`, `aud` (`support-platform-api`), `exp` and `nbf` checked, with 30s clock tolerance, using the injected clock.
   - **Scopes come from the contract:** each operation's `security` entry in `openapi.yaml` is the source of required scopes, enforced through the validator's security handler.
   - Missing or invalid token → 401 with `WWW-Authenticate: Bearer error="invalid_token"`. Missing scope → 403 with `error="insufficient_scope", scope="…"`.
6. **Rate limiting:** in-memory token buckets, keyed by client (`client_id`) and, for agent tokens, also by agent (`act.sub`). Both must have capacity.
   - **Defaults:** 100 requests/60s per client, 30/60s per agent; configurable via env.
   - Every authenticated response carries `RateLimit-Policy` and `RateLimit` (draft-11 syntax), showing the tighter of the two buckets.
   - 429 `rate-limited` with `Retry-After`.
   - Buckets use the injected clock.
   - **Unauthenticated floods** are the gateway's job (PLATFORM.md), not this limiter's.
7. **Store:**
   - `node:sqlite` in WAL mode, file path from config (`:memory:` in tests);
   - a migration runner (ordered SQL files, a `schema_migrations` table, applied at start-up, in a transaction);
   - a repository layer.
   - **The first migration ships the store's real schema:** `idempotency_keys`, `audit_log` (append-only, enforced by triggers), `webhook_subscriptions` and `webhook_deliveries`, with their indexes. The data-model rationale is in DECISIONS.md. The brief requires a justified schema with indexes, and designing the tables now keeps that requirement met however far later PRs get. Each table's repository arrives with the PR that first uses it; `pending_actions` arrives with Part C. Later changes are new migrations. *(Changed during planning: the spec first said a trivial migration.)*
8. **Config:** env parsed and validated at start-up; a bad value stops the process with a clear message. `.env.example` lists every variable.
9. **Run:**
   - `make run` starts the mocks and the API locally;
   - `docker compose up` does the same in containers (Dockerfile plus `docker-compose.yml`);
   - both use the fixture clock by default.

**Out of scope:**
- ARR field filtering and upstream calls (read path);
- idempotency (comments PR);
- token exchange and agent policy (Part C);
- `traceparent` propagation to upstreams (read path, which makes the calls);
- OpenTelemetry export (deferred).

## 3. Acceptance criteria

| ID | Criterion |
|---|---|
| S2-1 | `make run` and `docker compose up` start the API (:8080) and mocks (:8081) from a clean clone; `/healthz` returns 200 and `/readyz` returns 200 with the database `ok`. |
| S2-2 | A request that violates `openapi.yaml` gets 400 `validation-failed` with `errors[]` pointers. A handler response that violates the contract fails the test suite (it surfaces as a 500 and is logged). |
| S2-3 | Every non-2xx is `application/problem+json` with `type`, `title`, `status` and `correlationId`. Unknown errors never leak a message or stack. |
| S2-4 | Every log line is JSON with `correlationId`. A valid inbound `X-Request-Id` is echoed; an invalid one is replaced. |
| S2-12 | The dev issuer's routes return 404 unless `DEV_ISSUER=true`. `DEV_ISSUER=true` with `NODE_ENV=production` stops start-up. |
| S2-11 | Logs never contain request or response bodies, credentials or personal data. With requests carrying the fixture email and phone, an ARR value, a client secret and a bearer token, the captured logs contain none of them. |
| S2-5 | Tokens from the dev issuer verify through its JWKS URL. Wrong `iss`, wrong `aud`, expired, not-yet-valid, `alg: none`, HS256, a bad signature, or a missing token all give 401 with `WWW-Authenticate`. |
| S2-6 | An operation's required scope comes from its `security` entry in `openapi.yaml`; a token without it gets 403 `insufficient-scope` naming the scope. |
| S2-7 | Rate limits are per client and per agent. The 101st request in a window gets 429 with `Retry-After`. Another client is unaffected. Headers are on every authenticated response. Advancing the test clock refills the bucket. |
| S2-8 | Migrations apply once, in order, inside a transaction. A failed migration leaves the schema unchanged and stops start-up. |
| S2-9 | Invalid config (e.g. a non-numeric port, a missing issuer URL) stops start-up with a message naming the variable. |
| S2-10 | SIGTERM drains in-flight requests and closes the database before exit. |

## 4. Sabotage checks (each must make a test fail)
- Skip the `aud` check, or accept `alg: none`.
- Ignore the operation's scopes.
- Key the rate limiter globally instead of per client.
- Return a value the contract doesn't allow (e.g. a status outside its enum). *Extra, undeclared fields currently pass: response schemas don't set `unevaluatedProperties: false`. Tightening that is a contract change, recorded as a follow-up.*
- Log the `Authorization` header, or log request bodies.
- Mount the dev issuer regardless of `DEV_ISSUER`.

## 5. Decisions taken in this spec
- **Response validation:** strict (a violation becomes a 500, and tests fail) in dev, test and CI. Production would run it in log-only mode behind a flag (`RESPONSE_VALIDATION=strict|log`), so contract drift is caught in logs and alerts instead of becoming an outage. The trade-off: drift reaches clients until it is fixed.
