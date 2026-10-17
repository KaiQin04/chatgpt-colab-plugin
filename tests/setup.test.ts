import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLENDER_SHA256, BLENDER_URL, DEFAULT_PACKAGES, packageList, SetupStore } from "../lib/notebook/setup.ts";
import type { SetupRow } from "../lib/notebook/setup.ts";
import { setupWrapperSource } from "../lib/notebook/setup-wrapper.ts";
import { fixture, OWNER } from "./helpers.ts";

test("owner package settings use CAS and accept only bounded plain distribution names", async () => {
  const f = fixture();
  try {
    const store = new SetupStore(f.env, OWNER.userId);
    assert.deepEqual((await store.settings()).packages, DEFAULT_PACKAGES);
    assert.deepEqual(packageList(["LightGBM", "lightgbm", "scikit_learn"]), ["lightgbm", "scikit-learn"]);
    for (const name of ["--extra-index-url", "https://example.com/x", "numpy>=2", "numpy[extra]", "x; echo leak"]) {
      assert.throws(() => packageList([name]), /invalid/);
    }
    const saved = await store.saveSettings(["polars"], 0); assert.equal(saved.version, 1);
    await assert.rejects(store.saveSettings(["duckdb"], 0), /version_conflict/);
    assert.equal((await store.saveSettings([], 1)).version, 2);
    assert.deepEqual((await store.settings()).packages, []);
  } finally { f.close(); }
});

const python = process.env.NOTEBOOK_TEST_PYTHON ?? fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
test("actual setup wrapper compiles/lints, installs missing only, verifies/reuses Blender and rejects wrong hash", {
  skip: !existsSync(python) && "project Python unavailable",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "colab-setup-test-"));
  const jobs = ["packages", "blender", "blender", "blender"].map((kind, index) => ({
    id: `${index + 1}1111111-1111-4111-8111-111111111111`, notebook_id: "55555555-5555-4555-8555-555555555555",
    kind, config_json: JSON.stringify(kind === "packages" ? ["present", "missing"] : []),
  } as SetupRow));
  const wrappers = jobs.map(setupWrapperSource); wrappers.push(wrappers[0]);
  try {
    const harness = fileURLToPath(new URL("./setup_harness.py", import.meta.url));
    const code = join(directory, "generated.py"); writeFileSync(code, wrappers[0]);
    const lint = spawnSync(python, ["-m", "flake8", code, harness], { encoding: "utf8", timeout: 10_000 });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const execution = spawnSync(python, ["-c", "import json,runpy,sys; h=runpy.run_path(sys.argv[1]); print(json.dumps(h['check_setup_wrappers'](json.load(sys.stdin))))", harness], {
      input: JSON.stringify({ root: directory, wrappers, sha256: BLENDER_SHA256, url: BLENDER_URL }), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(execution.status, 0, execution.stderr);
    const value = JSON.parse(execution.stdout);
    assert.equal(value.pip_calls, 1); assert.equal(value.archive_reads, 2);
    assert.equal(value.results[0].status, "ready");
    assert.deepEqual(value.results[0].packages.map((item: any) => item.installed), [false, true]);
    assert.equal(value.results[1].blender.version, "5.2.2"); assert.equal(value.results[1].blender.downloaded, true);
    assert.equal(value.results[2].blender.downloaded, false);
    assert.equal(value.results[3].error.code, "blender_checksum_mismatch");
    assert.deepEqual(value.version_errors, Array(3).fill("blender_version_mismatch"));
  } finally { rmSync(directory, { recursive: true }); }
});
