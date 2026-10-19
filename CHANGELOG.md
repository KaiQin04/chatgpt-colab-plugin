# Changelog

## 0.3.0 — 2026-10-19

- Reconcile externally terminated runtimes using two complete provider absence observations at least 15 seconds apart. Failed or cancelled queries invalidate older absence evidence. Saved outputs remain available; unresolved execution and unsaved artifacts stay explicitly incomplete or blocked.
- Retry a recoverable WebSocket handshake once before submission. Failures proven to occur before sending release their local execution locks; attempts after sending remain unknown and are never automatically replayed.
- Resume multipart artifact uploads, verify full-object hashes, and support artifacts up to 10 GiB per file and 40 GiB per run.
- Add expiring, owner-issued machine download grants with byte ranges for resumable transfers. Machine downloads require a confirmed owner-private deployment.
- Show provider-confirmed runtime counts separately from records awaiting confirmation, with English and Traditional Chinese interface text.

### Upgrade

Apply migrations `0011_fat_spirit.sql` and `0012_ordinary_night_thrasher.sql` through the existing Sites deployment workflow. They add artifact upload metadata and runtime observation fields; do not recreate or clear storage. Preserve your existing Site identity, deployment origin, secrets, and owner-private audience. See [the upgrade guide](docs/RELEASING.md).

Validation covers automated tests, type checking, and production builds. It does not establish fresh-account Google OAuth compatibility or a live Colab execution test for this release.
