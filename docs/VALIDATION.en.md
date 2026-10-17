# Validation record

[English](VALIDATION.en.md) | [繁體中文](VALIDATION.md)

## v0.1.1 — October 17, 2026

- 105 application tests and 2 configuration tests passed, with no skipped tests. Type checking, UI bundle generation, and the production build passed.
- The MCP panel resource URI now includes the UI source hash, so a new editor build receives a new resource identity. A regression test and reviewed golden snapshots cover this change.
- On the maintainer's existing private deployment, an actual browser Shift + Enter run of `print(1 + 2)` returned `3`. The UI displayed “由你執行” (“Run by you”), and the persisted run had `actor: user`.
- A manual Run button action in the refreshed embedded MCP panel also recorded `actor: user`, but that attempt hit a Colab WebSocket handshake timeout. It is not counted as a successful end-to-end embedded-button execution.
- English README, deployment, OAuth, and validation documents are linked to their Traditional Chinese equivalents.

The maintainer's deployment is not evidence that a fresh third-party account can complete setup. A new-account Site creation, OAuth authorization, and private-plugin installation flow remains unverified.

## v0.1.0

The initial sanitized release passed 104 application tests and 2 configuration tests, type checking, UI source-hash checks, and a production build. Tests included real local Python wrapper harnesses, authorization boundaries, notebook and artifact state transitions, and manual-versus-assistant attribution.

That release's validation was local and synthetic; it did not allocate a runtime or change the maintainer's live Site. Public directory listing, Google production verification, and arbitrary VPS or Cloudflare hosting were not validated.
