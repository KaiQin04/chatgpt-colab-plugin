# Notebook UI build provenance

[繁體中文](BUILD-PROVENANCE.md)

`lib/notebook/ui-bundle.generated.ts` contains the notebook editor as a single,
minified HTML/JavaScript/CSS string. `scripts/build-notebook-ui.mjs` builds the
readable `ui/` source with Vite and embeds the result in a TypeScript module.
`ui/vite.config.ts` explicitly enables minification. This is generated build
output; the original application source is included in this repository.

The self-contained document supports the MCP Apps panel without loading scripts
or styles from an external host. Minification reduces its transfer size. A
scanner may classify the long string as obfuscated or unreadable code; that
classification alone does not establish malicious behavior.

## Reproduce and verify

Use Node.js 24 LTS and install both lockfiles before checking:

```sh
npm run install:ci
npm ci --prefix ui
npm run check:ui
```

`check:ui` rebuilds into ignored `.ui-build/` and compares the complete generated
module byte-for-byte with the committed file. It exits unsuccessfully on any
difference, including edits that leave `NOTEBOOK_UI_SOURCE_HASH` unchanged. It
does not overwrite the committed module. `npm run check` includes this check.
To intentionally regenerate the module, run `npm run build:ui`, inspect the
source/dependency changes and generated diff, and rerun the checks.

## Investigation on 2026-10-25

M8ven's public report for commit `0ca092ac77e813ec6b8252c1bb695585f99c73ce`
flagged one unreadable/minified file without naming it. The generated module
was the only tracked JS/TS file with a line longer than 20,000 characters.
Rebuilding the pre-update module with its installed dependencies reproduced
every byte; its SHA-256 was
`a3dcf182cec7431c93cdd76eb610cf43319d332844bc036d8d54f09d127c65c8`.

This establishes the module's build provenance and strongly supports a
minification classification rather than concealed application source. Exact
attribution of M8ven's finding remains unconfirmed because its public report
does not disclose a filename. No dispute or publisher email was submitted as
part of this investigation. Reproducibility is not a substitute for reviewing
the source or dependencies for security defects.
