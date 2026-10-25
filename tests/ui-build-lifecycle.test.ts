import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("typecheck generates a missing UI module and rebuilds changed sources in an isolated checkout", { timeout: 60_000 }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "notebook-ui-source-"));
  try {
    cpSync(join(root, "ui"), join(fixture, "ui"), {
      recursive: true,
      filter: (path) => !path.includes("node_modules"),
    });
    mkdirSync(join(fixture, "scripts"));
    cpSync(join(root, "scripts/build-notebook-ui.mjs"), join(fixture, "scripts/build-notebook-ui.mjs"));
    mkdirSync(join(fixture, "lib/notebook"), { recursive: true });
    for (const name of ["client", "contract", "png", "types"]) {
      cpSync(join(root, `lib/notebook/${name}.ts`), join(fixture, `lib/notebook/${name}.ts`));
    }
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
    symlinkSync(join(root, "ui/node_modules"), join(fixture, "ui/node_modules"), "junction");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", scripts: pkg.scripts }));
    writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, skipLibCheck: true, types: [] },
      include: ["lib/notebook/ui-bundle.generated.ts"],
    }));
    const generated = join(fixture, "lib/notebook/ui-bundle.generated.ts");
    const run = (script: string) => {
      assert.ok(process.env.npm_execpath, "Run through npm test to use its npm entrypoint");
      const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", script], {
        cwd: fixture, encoding: "utf8", timeout: 25_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    assert.equal(existsSync(generated), false);
    run("typecheck");
    const first = readFileSync(generated, "utf8");
    const css = join(fixture, "ui/styles.css");
    writeFileSync(css, readFileSync(css, "utf8") + "\n.build-regression-fixture{color:rgb(12,34,56)}\n");
    run("typecheck");
    const changed = readFileSync(generated, "utf8");
    assert.notEqual(changed, first);
    assert.match(changed, /\.build-regression-fixture/);
    writeFileSync(generated, changed.replace("Colab Notebook", "Tampered fixture"));
    const corrupted = spawnSync(process.execPath, ["scripts/build-notebook-ui.mjs", "--check"], {
      cwd: fixture, encoding: "utf8", timeout: 25_000,
    });
    assert.equal(corrupted.status, 1, corrupted.stdout + corrupted.stderr);
    assert.match(corrupted.stderr, /differs from a fresh source build/);
    run("check:ui");
    assert.equal(readFileSync(generated, "utf8").includes("NOTEBOOK_UI_TEMPLATE"), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
