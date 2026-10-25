# Notebook UI build provenance

[繁體中文](BUILD-PROVENANCE.md)

From v0.3.2, Git tracks the readable UI source, build scripts and dependency
lockfiles. It does not track the generated notebook UI module or intermediate
bundles. Historical release tags retain their original files.

The production build creates ignored `lib/notebook/ui-bundle.generated.ts`
from `ui/` and the shared notebook modules using `scripts/build-notebook-ui.mjs`.
The resulting self-contained HTML/JavaScript/CSS supports the MCP Apps panel
without loading scripts or styles from an external host. Vite minification
keeps the deployed document within its size budget. Deployment artifacts still
contain the built UI; source repositories and source archives contain readable
inputs instead.

## Reproduce and verify

Use Node.js 24 LTS:

```sh
npm ci
npm run check:ui
npm run check
npm run build
```

The root `postinstall` runs `npm ci --prefix ui` with development and optional
dependencies, so both lockfiles are installed. If installation scripts are
explicitly disabled, run `npm ci --prefix ui --include=dev --include=optional`
before these commands.

The npm lifecycle generates the module before `test`, `typecheck`, `dev`,
`dev:ui` and `build`, including on a clean checkout. `check:ui` first generates
it, then independently rebuilds and compares every byte. The low-level
`node scripts/build-notebook-ui.mjs --check` only compares and fails if the
existing module is missing, stale or different. `npm run build:ui` is also
available for explicit generation. Do not commit the module or `.ui-build/`.

A regression test uses an isolated source tree without the generated module,
runs the real Vite/TypeScript pipeline, changes a source input and checks that
it rebuilds. Runtime tests also check the source hash, self-contained document,
size budget, sanitization and access boundaries.

## Scanner interpretation

M8ven's report flagged one minified/bundled file without naming it. Before
v0.3.2, the generated module was the only tracked JS/TS file with a line longer
than 20,000 characters. Rebuilding it reproduced every byte, strongly supporting
a generated-build-output classification. Exact attribution remains unconfirmed
because the public report does not disclose a filename.

Removing generated output from the current Git tree makes the source easier to
review. It does not guarantee a particular scanner grade or replace source and
dependency security review. Only a fresh scan of the new commit can establish
whether the scanner's warning has changed.
