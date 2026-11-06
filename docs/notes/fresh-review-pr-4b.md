# PR 4b: what the fresh-context review caught

The reviewer (opus, given only the diff, spec S2 and the review checklist) sent about 70 crafted requests at the running server and ran 22 mutations on a scratch copy. All algorithm and key attacks were refused (alg none, HS256 key confusion, forged `jwk`/`jku`, unknown or missing `kid`, `crit`, `b64:false`), and scopes matched the contract for every operation.

## Fixed

| Finding | Severity | Why our checks missed it | Fix |
|---|---|---|---|
| 400 and 403 responses to authenticated callers carried no RateLimit headers and used no quota: unlimited invalid requests, each costing a token verification | critical | The rate-limit tests only sent valid requests; the limiter was placed after validation by design and nobody tested an invalid one | The security handler charges the buckets right after verification |
| JWKS answering 500, HTML or a non-key-set body would become 401 if the error list regressed | major | Only a closed port was tested | Tests against a fake identity provider |
| A token without `exp`, or with a malformed `act`, would be accepted if the checks regressed | major | No negative tests for those claims | Tests for each; nested `act` chains now refused |
| An identity provider outage over 10 minutes made every request 503, each waiting 5s | major | Default jose cache settings, not considered | Keys cached for an hour, refetched on unknown `kid`, 2s timeout; stale-on-error deferred |

## Reported, not fixed
- Agent buckets are keyed by agent across all users, and every user of a client shares its bucket. Decide per-user limits in Part C.
- A token bucket allows a burst plus refill (about 2× the advertised quota in the first minute); the headers describe the refill rate.
- No RFC 9068 `typ: at+jwt` check or maximum token age; revisit with a real identity provider.
- Oversized headers get Node's bare 431, not problem+json.
- The Docker image sets `NODE_ENV=development`, so the "refused in production" guard needs the deployer to set it; the image is dev-only.
- Bucket sweeping is O(n) at the cap; keys only come from verified tokens.
