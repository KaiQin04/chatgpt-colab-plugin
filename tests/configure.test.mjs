import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configure } from "../scripts/configure.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "colab-configure-"));
  mkdirSync(join(root, ".openai"));
  mkdirSync(join(root, "lib/platform"), { recursive: true });
  writeFileSync(join(root, ".openai/hosting.json"), JSON.stringify({ d1: "DB", r2: "BUCKET", capabilities: ["mcp"] }));
  writeFileSync(join(root, "lib/platform/deployment.ts"), 'export const SITE_ORIGIN = "https://unconfigured.invalid";\n');
  return root;
}

test("configuration is repeatable, preserves bindings and refuses switching existing Sites", () => {
  const root = fixture();
  try {
    const input = { siteUrl: "https://personal.example.chatgpt.site/", projectId: "appgprj_synthetic" };
    const result = configure(root, input);
    assert.equal(result.callbackUrl, "https://personal.example.chatgpt.site/oauth/google/callback");
    assert.deepEqual(configure(root, input), result);
    const before = readFileSync(join(root, ".openai/hosting.json"), "utf8");
    assert.deepEqual(JSON.parse(before), { d1: "DB", r2: "BUCKET", capabilities: ["mcp"], project_id: input.projectId });
    assert.throws(() => configure(root, { ...input, projectId: "appgprj_other" }), /differs/);
    assert.throws(() => configure(root, { ...input, siteUrl: "https://other.chatgpt.site" }), /differs/);
    assert.equal(readFileSync(join(root, ".openai/hosting.json"), "utf8"), before);
  } finally { rmSync(root, { recursive: true }); }
});

test("invalid origins and project identifiers cannot write deployment configuration", () => {
  const root = fixture();
  try {
    const before = readFileSync(join(root, "lib/platform/deployment.ts"), "utf8");
    for (const siteUrl of ["http://a.chatgpt.site", "https://evil.example", "https://a.chatgpt.site.evil.example",
      "https://a.chatgpt.site/path", "https://a.chatgpt.site/?token=secret", "https://a.chatgpt.site/#x",
      "https://user:secret@a.chatgpt.site", "https://a.chatgpt.site:8443", "not a url"]) {
      assert.throws(() => configure(root, { siteUrl, projectId: "appgprj_synthetic" }));
    }
    assert.throws(() => configure(root, { siteUrl: "https://a.chatgpt.site", projectId: "invalid" }));
    assert.equal(readFileSync(join(root, "lib/platform/deployment.ts"), "utf8"), before);
  } finally { rmSync(root, { recursive: true }); }
});
