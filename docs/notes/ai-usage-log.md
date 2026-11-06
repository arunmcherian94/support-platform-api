# AI usage log

One line per occurrence: what the AI got wrong or nearly got wrong, how it was caught, the fix. Feeds `AI_USAGE.md`.

- 2026-11-06 Phase 0: initial read of the MCP SDK v2 package took the `LATEST_PROTOCOL_VERSION = '2025-11-25'` constant to mean v2 lacked the 2026-07-28 spec. Caught by checking the published package for `server/discover` and `input_required` (present); the constant only tracks the legacy handshake. Fix: record SDK capabilities from package contents, not a single constant or the README.
- 2026-11-06 Scaffold: CI workflow written with `actions/checkout@v5` / `actions/setup-node@v5` from memory; latest releases are v7.0.1 / v7.1.0. Caught by checking the GitHub releases API before committing. Fix: bumped to v7. Pattern: versions written from memory are stale; check the registry.
