import assert from "node:assert/strict";
import { test } from "node:test";
import { notebookExportDownload } from "../lib/notebook/export-download.ts";
import { notebookCall } from "../lib/notebook/service.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, noNetwork, OTHER, OWNER, ownerRequest } from "./helpers.ts";

const id = "11111111-1111-4111-8111-111111111111";
const path = `/api/notebooks/${id}/export`;

test("HTTPS export is a private downloadable nbformat file without network or runtime allocation", async () => {
  const f = fixture();
  try {
    await new Store(f.env).owner(OWNER);
    f.sqlite.prepare("INSERT INTO notebooks(id,owner_id,title,version,state,created_at,updated_at) VALUES(?,?,?,1,'closed',1,1)")
      .run(id, OWNER.userId, '測試 "notebook"');
    await notebookCall("upsert_cell", { notebookId: id, cellId: "33333333-3333-4333-8333-333333333333",
      kind: "code", source: "answer = 42", expectedVersion: 0 }, f.env, OWNER, { fetcher: noNetwork });
    const response = await notebookExportDownload(ownerRequest(path), f.env, id, noNetwork);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(response.headers.get("Content-Type")!, /^application\/x-ipynb\+json/);
    assert.equal(response.headers.get("Content-Disposition"),
      `attachment; filename="notebook.ipynb"; filename*=UTF-8''${encodeURIComponent('測試 _notebook_.ipynb')}`);
    const body = await response.text();
    assert.equal(Number(response.headers.get("Content-Length")), new TextEncoder().encode(body).byteLength);
    const value = JSON.parse(body);
    assert.equal(value.nbformat, 4); assert.equal(value.nbformat_minor, 5);
    assert.equal(value.cells[0].source, "answer = 42");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes").get()!.n, 0);
  } finally { f.close(); }
});

test("export rejects absent/other identity and missing/invalid notebooks without attachment headers", async () => {
  const f = fixture();
  try {
    await new Store(f.env).owner(OWNER);
    for (const [request, notebookId, status] of [
      [new Request(`https://example.test${path}`), id, 401],
      [ownerRequest(path, OTHER), id, 403],
      [ownerRequest(path), id, 404],
      [ownerRequest(path), "invalid", 400],
    ] as const) {
      const response = await notebookExportDownload(request, f.env, notebookId, noNetwork);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Content-Disposition"), null);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.ok((await response.json() as { error: unknown }).error);
    }
  } finally { f.close(); }
});
