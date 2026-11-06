# PR 4a: what the fresh-context review caught, and why nothing else did

The fresh-context reviewer (`.claude/agents/fresh-reviewer.md`, given only the diff, spec S2 and the review checklist) found four critical defects in code that passed all 112 tests. It reproduced each with probe scripts against the running app:

- the phone mask still matched digit runs inside UUIDs, corrupting about one in eight correlation IDs in the logs;
- problems sent through the validation-hooked `res.json` fell through to Express's HTML error page, stack trace included, when the status wasn't declared;
- malformed or oversized JSON bodies returned 500;
- error stacks repeated unmasked personal data.

It also found a test that could not fail (shutdown without asserting the database closed) and a sabotage check the contract can't support (extra response fields pass validation). All critical findings were fixed with tests, each confirmed to fail on the old code.

**Why the other checks missed them.** Typecheck, lint, the tests and the sabotage checks all ran green. Each defect sat outside what the author had thought to check, and every one of those checks was written by the same author, in the same context, as the code:

| Defect | Why our checks missed it | How the reviewer found it |
|---|---|---|
| Correlation IDs masked as phone numbers | The false-positive test used hand-picked strings (a date, one trace ID, a count), and the correlation test used `req-123.abc`, which has no long digit runs. Example-based tests only cover the examples someone thought of. | Pushed 10,000 random UUIDs through the logger and counted the ones changed (1,255). That's property-style input nobody hand-picked. |
| HTML stack-trace page for an undeclared status | The author didn't know `express-openapi-validator` hooks `res.json` for every response, error responses included. The tests only raised statuses the operation declares (400, 404, 500). | Read the library's source for the response hook, then asked what happens when a problem's status isn't declared, and ran it. |
| Malformed JSON returns 500 | Every test sent well-formed JSON. The error mapping recognised validator errors by their `errors[]` array, and body-parser errors don't have one. | Sent broken and oversized bodies at the boundary. |
| Personal data in error stacks | The fix masked `err.message` and assumed that covered the error. The tests asserted on the message only, and the stack's first line repeats the message. | Read the serialised log line in full, not just the field the code claimed to handle. |

**Why sabotage checks couldn't catch these:** they break rules the author already listed and confirm a test notices. They test the tests, but only for rules someone thought of. All four defects were rules nobody had written down.

**Why the reviewer could:** fresh context, so none of the author's assumptions. A brief to find concrete failure scenarios, not to confirm the ACs. Permission to run probes against the real app and to read library source. And it checked the spec's absolute claims ("every log line", "unknown errors never leak", 4xx never becomes 5xx) against inputs, not against the code's intent.

**What we change:**
- Generated inputs for the masker: the test now pushes 200 random UUIDs through the logger on every run (`tests/http/review-fixes.test.ts`). A property-testing library would generalise this; not added yet.
- Schemathesis in the contract-test step. It generates malformed and edge-case requests and flags any 5xx or undeclared status, so it would have caught defects 2 and 3. It's planned (Gate 3a), but hadn't been run yet.
- The fresh-context review stays mandatory for critical PRs. In a team setting it runs in CI as an advisory check, never as approval.
