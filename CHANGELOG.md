# Changelog

## 0.3.1 — 2026-10-25

- Patch Next.js, React Server Components (including the Vite RSC plugin's vendored copy), Vinext, Vite, Cloudflare build tooling, DOMPurify, Zod and affected transitive dependencies. Both npm lockfiles have no known vulnerabilities in the release-time npm audit.
- Preserve connector preview validation behavior while migrating its record schemas to Zod 4; add regression coverage for JSON records and strict envelopes.
- Add `npm run check:ui` to reproduce and compare the complete committed UI bundle byte-for-byte. Include bilingual build provenance documentation for minification-related scanner warnings.
- Rebuild the notebook panel and update only the expected panel URI, length and digest snapshots. No database migration is required.

Upgrading an existing deployment still requires applying and deploying this release to that Site. Preserve its identity, origin, secrets, data and audience. Automated checks and synthetic browser validation do not establish fresh Google OAuth or live Colab execution compatibility.

## 0.3.0 — 2026-10-19

- Reconcile externally terminated runtimes using two complete provider absence observations at least 15 seconds apart. Failed or cancelled queries invalidate older absence evidence. Saved outputs remain available; unresolved execution and unsaved artifacts stay explicitly incomplete or blocked.
- Retry a recoverable WebSocket handshake once before submission. Failures proven to occur before sending release their local execution locks; attempts after sending remain unknown and are never automatically replayed.
- Resume multipart artifact uploads, verify full-object hashes, and support artifacts up to 10 GiB per file and 40 GiB per run.
- Add expiring, owner-issued machine download grants with byte ranges for resumable transfers. Machine downloads require a confirmed owner-private deployment.
- Show provider-confirmed runtime counts separately from records awaiting confirmation, with English and Traditional Chinese interface text.

### Upgrade

Apply migrations `0011_fat_spirit.sql` and `0012_ordinary_night_thrasher.sql` through the existing Sites deployment workflow. They add artifact upload metadata and runtime observation fields; do not recreate or clear storage. Preserve your existing Site identity, deployment origin, secrets, and owner-private audience. See [the upgrade guide](docs/RELEASING.md).

Validation covers automated tests, type checking, and production builds. It does not establish fresh-account Google OAuth compatibility or a live Colab execution test for this release.
