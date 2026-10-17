import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputName, validateInputFile } from "../lib/notebook/inputs.ts";
import { inputWrapperSource } from "../lib/notebook/input-wrapper.ts";
import { NOTEBOOK_TOOLS } from "../lib/notebook/tools.ts";

test("fileParams has the official four fields and refuses unsafe URLs and names", () => {
  const tool = NOTEBOOK_TOOLS.find((item) => item.name === "import_file")!;
  assert.deepEqual(tool._meta["openai/fileParams"], ["file"]);
  const schema = tool.inputSchema.properties.file as any;
  assert.deepEqual(Object.keys(schema.properties), ["download_url", "file_id", "mime_type", "file_name"]);
  assert.deepEqual(schema.required, ["download_url", "file_id"]);
  const file = { download_url: "https://files.example.com/synthetic?signature=temporary", file_id: "file_synthetic" };
  assert.equal(validateInputFile(file).file_name, undefined); assert.equal(inputName(undefined), "input.bin");
  for (const url of ["http://example.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://metadata.internal/x", "https://user:secret@example.com/x"]) {
    assert.throws(() => validateInputFile({ ...file, download_url: url }), /input_url/);
  }
  for (const name of ["../secret", "/tmp/x", "a\\b", "a\u0000b", ".hidden", "a%2fb"]) {
    assert.throws(() => validateInputFile({ ...file, file_name: name }), /filename/);
  }
});

const python = process.env.NOTEBOOK_TEST_PYTHON ?? fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
test("actual Python attachment wrapper: streamed hash/bytes, no overwrite, expiry and no URL in metadata", {
  skip: !existsSync(python) && "project Python unavailable",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "colab-input-test-"));
  const file = { download_url: "https://files.example.com/data?signature=do-not-persist", file_id: "file_synthetic", file_name: "data.csv" };
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const wrappers = ids.map((id) => inputWrapperSource("44444444-4444-4444-8444-444444444444", id, file));
  wrappers.push(wrappers[0]);
  try {
    const harness = fileURLToPath(new URL("./input_harness.py", import.meta.url));
    const code = join(directory, "generated.py"); writeFileSync(code, wrappers[0]);
    const lint = spawnSync(python, ["-m", "flake8", code, harness], { encoding: "utf8", timeout: 10_000 });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const execution = spawnSync(python, ["-c", "import json,runpy,sys; h=runpy.run_path(sys.argv[1]); print(json.dumps(h['check_input_wrappers'](json.load(sys.stdin))))", harness], {
      input: JSON.stringify({ root: directory, wrappers }), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(execution.status, 0, execution.stderr);
    const value = JSON.parse(execution.stdout);
    assert.equal(value.downloads, 3);
    assert.equal(value.results[0].status, "ready"); assert.equal(value.results[0].size, 24);
    assert.equal(value.results[0].sha256, "30a1c52363aa476d75e6e850e440fa5aa209ec5879fdeabf22d02a5b356cb7e2");
    assert.equal(value.results[2].error.code, "download_expired");
    assert.ok(!execution.stdout.includes("do-not-persist")); assert.ok(!execution.stdout.includes("download_url"));
  } finally { rmSync(directory, { recursive: true }); }
});
