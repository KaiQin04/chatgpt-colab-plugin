import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "colab-public-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file, text) => writeFileSync(join(root, file), text);
  for (const dir of ["scripts", ".openai", "lib/platform"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL("../scripts/audit-public.mjs", import.meta.url), join(root, "scripts/audit-public.mjs"));
  write(".openai/hosting.json", '{}\n');
  write("lib/platform/deployment.ts", 'export const SITE_ORIGIN = "https://unconfigured.invalid";\n');
  write("sample.txt", "public\n");
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "test fixture");
  const audit = () => {
    const result = spawnSync(process.execPath, ["scripts/audit-public.mjs"], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { root, git, write, audit };
}

test("clean staged source passes and records the audited Git tree", (t) => {
  const f = fixture(t), result = f.audit();
  assert.equal(result.status, 0);
  assert.ok(result.output.includes(f.git("write-tree").trim()));
});

test("sanitizing the working tree without restaging cannot approve a staged secret", (t) => {
  const f = fixture(t), secret = "GOCSPX-" + "A".repeat(12);
  f.write("sample.txt", secret); f.git("add", "sample.txt");
  f.write("sample.txt", "public\n");
  const result = f.audit();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /sample.txt: unstaged change/);
  assert.ok(!result.output.includes(secret));
});

test("staged credentials and personal paths fail without printing their values", (t) => {
  const f = fixture(t);
  for (const value of ["GOCSPX-" + "B".repeat(12), "/" + "Users/" + "synthetic-owner/private"]) {
    f.write("sample.txt", value); f.git("add", "sample.txt");
    const result = f.audit();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /sample.txt: credential or personal path pattern/);
    assert.ok(!result.output.includes(value));
  }
});

test("untracked files and unstaged changes fail with their paths", (t) => {
  const f = fixture(t);
  f.write("new.txt", "harmless");
  const untracked = f.audit();
  assert.match(untracked.output, /new.txt: untracked file not covered by audit/);
  assert.notEqual(untracked.status, 0);
  f.git("add", "new.txt");
  f.write("sample.txt", "changed");
  const unstaged = f.audit();
  assert.match(unstaged.output, /sample.txt: unstaged change/);
  assert.notEqual(unstaged.status, 0);
});

test("staged manifest and origin checks cannot be bypassed by clean working copies", (t) => {
  const f = fixture(t);
  f.write(".openai/hosting.json", JSON.stringify({ project_id: "appgprj_synthetic" }));
  f.git("add", ".openai/hosting.json");
  assert.match(f.audit().output, /hosting manifest contains a deployment ID/);
  f.write(".openai/hosting.json", "{}\n");
  assert.notEqual(f.audit().status, 0);
  f.git("add", ".openai/hosting.json");
  f.write("lib/platform/deployment.ts", 'export const SITE_ORIGIN = "https://other.chatgpt.site";\n');
  f.git("add", "lib/platform/deployment.ts");
  assert.match(f.audit().output, /deployment origin is not the public placeholder/);
});

test("private identifiers in any staged file fail with no identifier in the output", (t) => {
  const f = fixture(t);
  const values = ["appgprj_" + "private123", "private123" + ".chatgpt.site",
    "appgprj_synthetic" + "_extra", "private." + "a.chatgpt.site"];
  for (const value of values) {
    f.write("sample.txt", value); f.git("add", "sample.txt");
    const result = f.audit();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /sample.txt: private Site identifier pattern/);
    assert.ok(!result.output.includes(value));
  }
});

test("only the exact documented synthetic identifiers pass", (t) => {
  const f = fixture(t);
  f.write("sample.txt", ["appgprj_YOUR_PROJECT_ID", "appgprj_synthetic", "appgprj_other",
    "YOUR-SITE.chatgpt.site", "personal.example.chatgpt.site", "other.chatgpt.site", "a.chatgpt.site"].join("\n"));
  f.git("add", "sample.txt");
  assert.equal(f.audit().status, 0);
});

test("tracked symlinks and forbidden paths are rejected", (t) => {
  const f = fixture(t);
  symlinkSync("sample.txt", join(f.root, "link.txt")); f.git("add", "link.txt");
  const symlink = f.audit();
  assert.match(symlink.output, /link.txt: forbidden path or file type/);
  assert.notEqual(symlink.status, 0);
  f.write(".dev.vars", "synthetic"); f.git("add", ".dev.vars");
  assert.match(f.audit().output, /\.dev.vars: forbidden path or file type/);
});

test("blob boundaries are byte based, including binary data and unusual filenames", (t) => {
  const f = fixture(t);
  f.write("binary.bin", Buffer.from([0, 255, 10, 128]));
  f.write("space and\ttab.txt", "synthetic 中文\n");
  f.git("add", ".");
  assert.equal(f.audit().status, 0);
});

test("staged submodules are forbidden without reading their commit as a file", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "module"));
  f.git("update-index", "--add", "--cacheinfo", "160000", f.git("rev-parse", "HEAD").trim(), "module");
  const result = f.audit();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /module: forbidden path or file type/);
});

test("local Git replacement refs cannot hide the actual staged secret blob", (t) => {
  const f = fixture(t), secret = "GOCSPX-" + "C".repeat(12);
  f.write("sample.txt", secret); f.git("add", "sample.txt");
  const secretOid = f.git("rev-parse", ":sample.txt").trim();
  const safeOid = f.git("rev-parse", "HEAD:sample.txt").trim();
  f.git("replace", secretOid, safeOid);
  const result = f.audit();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /sample.txt: credential or personal path pattern/);
  assert.ok(!result.output.includes(secret));
});
