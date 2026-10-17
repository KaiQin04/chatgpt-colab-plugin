import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonWrapperSource } from "../lib/notebook/wrapper.ts";
import { parseRunResult } from "../lib/notebook/runtime.ts";

const python = process.env.NOTEBOOK_TEST_PYTHON ?? fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
test("actual Python wrapper: shared variables, capped control/Unicode output, whole PNG, exception, interrupt and late flush", {
  skip: !existsSync(python) && "project Python unavailable; set NOTEBOOK_TEST_PYTHON",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "colab-wrapper-test-"));
  const runIds = Array.from({ length: 6 }, () => crypto.randomUUID());
  const sources = [
    "shared_value = 42\nprint(shared_value)\nfrom pathlib import Path\nassert Path.cwd().name == 'workspace'\nassert Path('inputs').is_dir()\nPath('outputs/result.txt').write_text('synthetic artifact', encoding='utf-8')",
    "print(shared_value + 1)\nprint('\\x00' * 30000)",
    "print('中' * 10000)",
    "get_ipython().display_pub.publish({'image/png': 'iVBORw0KGgo' + 'A' * 30000, 'text/plain': 'image omitted'})\nraise ValueError('synthetic failure')",
    "print('before interrupt')\nraise KeyboardInterrupt()",
    "get_ipython().display_pub.publish({'text/html': '<script>bad</script>', 'text/plain': 'safe text'})",
  ];
  const wrappers = sources.map((source, index) => pythonWrapperSource(
    "11111111-1111-4111-8111-111111111111", runIds[index], source,
  ));
  try {
    const harness = fileURLToPath(new URL("./wrapper_harness.py", import.meta.url));
    const execution = spawnSync(python, ["-c", "import json,runpy,sys; h=runpy.run_path(sys.argv[1]); print(json.dumps(h['check_wrappers'](json.load(sys.stdin)), ensure_ascii=False))", harness], {
      input: JSON.stringify({ root: directory, wrappers }), encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000,
    });
    assert.equal(execution.status, 0, execution.stderr);
    const data = JSON.parse(execution.stdout);
    assert.equal(data.shared_value, 42);
    const values = data.results.map((value: unknown, index: number) => parseRunResult(JSON.stringify(value), runIds[index]));
    assert.equal(values[0].status, "ok"); assert.equal(values[0].executionCount, 1);
    assert.equal(values[0].artifacts!.files[0].path, "result.txt");
    assert.equal(values[0].artifacts!.files[0].size, 18);
    assert.ok((values[1].outputs[0] as any).text.startsWith("43\n"));
    assert.equal(values[1].truncated, true); assert.equal(values[2].truncated, true);
    assert.equal(values[3].status, "error"); assert.ok(!JSON.stringify(values[3]).includes("image/png"));
    assert.equal(values[4].status, "interrupted");
    assert.equal(values[5].executionCount, 6); assert.ok(!JSON.stringify(values[5]).includes("text/html"));
  } finally { rmSync(directory, { recursive: true }); }
});
