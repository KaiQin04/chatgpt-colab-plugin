import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("dependency installation has no automatic root lifecycle hooks", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "dependencies"]) {
    assert.equal(pkg.scripts[hook], undefined, `Unexpected automatic install hook: ${hook}`);
  }
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].hasInstallScript, undefined);
});

for (const failure of ["none", "root", "ui"]) {
  test(`explicit installer orders both lockfiles and propagates ${failure} failure`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "colab-install-test-"));
    try {
      mkdirSync(join(fixture, "scripts"));
      mkdirSync(join(fixture, "ui"));
      for (const name of ["install-ci.mjs", "install-notebook-ui.mjs", "npm-install.mjs", "sites-env.mjs", "execution-profile.mjs"]) {
        copyFileSync(join(root, "scripts", name), join(fixture, "scripts", name));
      }
      const receipt = join(fixture, "receipt.json");
      const npm = join(fixture, "fake-npm.mjs");
      writeFileSync(npm, `
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "config") { console.log("https://registry.npmjs.org/"); process.exit(0); }
const prefix = args[args.indexOf("--prefix") + 1];
const phase = prefix.endsWith("/ui") || prefix.endsWith("\\\\ui") ? "ui" : "root";
const receipt = process.env.INSTALL_TEST_RECEIPT;
const calls = existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : [];
calls.push({ phase, args, reports: !!process.env.SITES_INSTALL_REPORT_PATH });
writeFileSync(receipt, JSON.stringify(calls));
if (process.env.INSTALL_TEST_FAILURE === phase) process.exit(phase === "root" ? 42 : 43);
if (phase === "root") {
  mkdirSync(join(prefix, "node_modules/.bin"), { recursive: true });
  const bin = join(prefix, "node_modules/.bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
  writeFileSync(bin, "synthetic executable");
  chmodSync(bin, 0o755);
}
`);
      const report = join(fixture, "install-report.json");
      writeFileSync(report, "{}");
      const result = spawnSync(process.execPath, [join(fixture, "scripts/install-ci.mjs")], {
        cwd: fixture, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, npm_execpath: npm, INSTALL_TEST_RECEIPT: receipt,
          INSTALL_TEST_FAILURE: failure, SITES_INSTALL_REPORT_PATH: report },
      });
      assert.equal(result.status, failure === "root" ? 42 : failure === "ui" ? 43 : 0, result.stdout + result.stderr);
      const calls = JSON.parse(readFileSync(receipt, "utf8"));
      assert.deepEqual(calls.map((call: { phase: string }) => call.phase), failure === "root" ? ["root"] : ["root", "ui"]);
      if (failure !== "root") {
        assert.equal(calls[1].reports, false, "UI install must not overwrite root install telemetry");
        for (const flag of ["ci", "--include=dev", "--include=optional", "--workspaces=false"]) {
          assert.ok(calls[1].args.includes(flag), `Missing UI install option: ${flag}`);
        }
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
