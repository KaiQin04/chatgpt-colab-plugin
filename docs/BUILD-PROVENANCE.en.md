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
npm run install:ci
npm run check:ui
npm run check
npm run build
```

From v0.3.3, `npm run install:ci` explicitly installs the root and UI lockfiles,
including development and optional dependencies. There is no root `postinstall`
or other automatic install lifecycle hook. Plain root `npm ci` installs only the
root lockfile; for manual setup, follow it with
`npm ci --prefix ui --include=dev --include=optional`.

The portable and managed Linux installers share a bounded UI installation step.
The managed path retains its isolated environment and install lock across both
installs. An installation failure fails the setup command. Dependency packages
can still have their own installation scripts; this change removes the root
package's automatic hook, not all dependency lifecycle execution. Do not enable
global `ignore-scripts` as a substitute: it also skips the UI generation hooks
before test/build commands.

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
a generated-build-output classification. A later scan of v0.3.2 commit
`2764088a9661df01b21473e02795541cd9573a00` reported no obfuscation and no failed
checks, with one warning about the root install hook. The v0.3.3 setup change
removes that hook; its scanner status requires a scan of the new commit.

Removing generated output from the current Git tree makes the source easier to
review. It does not guarantee a particular scanner grade or replace source and
dependency security review. Only a fresh scan of the new commit can establish
whether the scanner's warning has changed.
