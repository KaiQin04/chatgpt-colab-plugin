import assert from "node:assert/strict";
import { test } from "node:test";
import { uiSourceHash } from "../scripts/build-notebook-ui.mjs";
import { NOTEBOOK_UI_SOURCE_HASH, NOTEBOOK_UI_TEMPLATE } from "../lib/notebook/ui-bundle.generated.ts";
import { htmlResponse, notebookUiHtml } from "../lib/notebook/ui.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";

test("generated UI bundle matches the current ui/ sources (run npm run build:ui)", () => {
  assert.equal(NOTEBOOK_UI_SOURCE_HASH, uiSourceHash());
});

test("bundled UI is one self-contained document with a single mode slot", () => {
  const html = NOTEBOOK_UI_TEMPLATE;
  assert.match(html, /^<!doctype html>/);
  for (const external of [/<script[^>]+src=/i, /<link\b/i, /<iframe\b/i, /@import/i, /url\(\s*['"]?https?:/i]) {
    assert.doesNotMatch(html, external);
  }
  assert.equal(html.split('"__CCM_MODE__"').length - 1, 1);
  assert.ok(notebookUiHtml("mcp").includes('window.__CCM_MODE__="mcp"'));
  assert.ok(notebookUiHtml("site").includes('window.__CCM_MODE__="site"'));
  assert.equal(html.split('"__CCM_SITE_ORIGIN__"').length - 1, 1);
  assert.ok(notebookUiHtml("mcp").includes(`window.__CCM_SITE_ORIGIN__=${JSON.stringify(SITE_ORIGIN)}`));
  assert.ok(html.length < 1_000_000, `bundle too large: ${html.length}`);
});

test("Site UI responses allow only same-origin framing and retain no-store headers", () => {
  const response = htmlResponse("<!doctype html>");
  assert.equal(response.headers.get("Content-Security-Policy"),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  assert.equal(response.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
});
