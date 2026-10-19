import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactStore, MACHINE_DOWNLOAD_HEADER } from "../lib/notebook/artifact-store.ts";
import { artifactDownload } from "../lib/notebook/download.ts";
import { machineArtifactDownload } from "../lib/notebook/machine-download.ts";
import { mcpPost } from "../lib/mcp/transport.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, noNetwork, OTHER, OWNER, ownerRequest } from "./helpers.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const notebookId = "33333333-3333-4333-8333-333333333333";
const url = `${SITE_ORIGIN}/api/artifacts/${id}/machine`;

async function prepared(size = 4096) {
  const f = fixture();
  await new Store(f.env).owner(OWNER);
  const data = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const checksum = await crypto.subtle.digest("SHA-256", data);
  const sha256 = Buffer.from(checksum).toString("hex");
  const now = Date.now();
  f.sqlite.prepare("INSERT INTO notebooks(id,owner_id,title,version,state,created_at,updated_at) VALUES(?,?,?,1,'closed',?,?)")
    .run(notebookId, OWNER.userId, "Synthetic machine download", now, now);
  for (const artifactId of [id, otherId]) {
    f.sqlite.prepare(`INSERT INTO notebook_artifacts
      (id,owner_id,notebook_id,run_id,path,size,sha256,object_key,media_type,state,created_at,saved_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,?)`)
      .run(artifactId, OWNER.userId, notebookId, "synthetic-run", `${artifactId}.bin`, size, sha256,
        `synthetic/${artifactId}`, "application/octet-stream", now, now, now + 3600000);
  }
  let reads = 0;
  const metadata = { size, checksums: { sha256: checksum } };
  f.env.BUCKET = {
    async head() { reads++; return metadata; },
    async get(_key: string, options?: { range?: { offset: number; length: number } }) {
      reads++;
      const range = options?.range;
      const bytes = range ? data.subarray(range.offset, range.offset + range.length) : data;
      return { ...metadata, range, body: new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 65536) controller.enqueue(bytes.subarray(i, i + 65536));
        controller.close();
      } }) };
    },
  } as unknown as R2Bucket;
  const store = new ArtifactStore(f.env, OWNER.userId);
  return { ...f, store, data, sha256, metadata, reads: () => reads };
}

function request(token: string, headers: Record<string, string> = {}, method = "GET", destination = url): Request {
  // No identity or service header: the trusted platform already consumed service access.
  return new Request(destination, { method, headers: { [MACHINE_DOWNLOAD_HEADER]: token, ...headers } });
}

async function grantViaMcp(f: ReturnType<typeof fixture>, identity: typeof OWNER | null = OWNER) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (identity) {
    headers.set("oai-authenticated-user-id", identity.userId);
    headers.set("oai-authenticated-user-email", identity.email);
  }
  const response = await mcpPost(new Request(`${SITE_ORIGIN}/mcp`, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "create_artifact_download", arguments: { artifactId: id } } }) }), f.env, noNetwork);
  return (await response.json() as { result: { isError?: boolean; structuredContent: {
    error?: { code: string }; artifact: { id: string; size: number; sha256: string };
    download: { url: string; headers: Record<string, string>; expiresAt: number; etag: string };
  } } }).result;
}

test("authenticated MCP issues a scoped grant; machine GET and HEAD need no browser identity or Colab", async () => {
  const f = await prepared();
  try {
    const issued = await grantViaMcp(f);
    assert.equal(issued.isError, undefined);
    const spec = issued.structuredContent;
    assert.equal(spec.download.url, url);
    assert.equal(spec.artifact.size, f.data.length);
    assert.equal(spec.artifact.sha256, f.sha256);
    const token = spec.download.headers[MACHINE_DOWNLOAD_HEADER];
    assert.equal(token.length, 43);
    assert.ok(spec.download.expiresAt <= Date.now() + 300000);
    const stored = f.sqlite.prepare("SELECT * FROM artifact_downloads").all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].owner_id, OWNER.userId); assert.equal(stored[0].artifact_id, id);
    assert.ok(!JSON.stringify(stored).includes(token));
    assert.ok(!JSON.stringify(spec).includes(OWNER.userId));
    assert.ok(!JSON.stringify(spec).includes("object_key"));
    for (const method of ["HEAD", "GET"]) {
      const response = await machineArtifactDownload(request(token, {}, method), f.env, id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Length"), String(f.data.length));
      assert.equal(response.headers.get("ETag"), `"${f.sha256}"`);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(response.headers.get("Location"), null);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(bytes, method === "HEAD" ? new Uint8Array() : f.data);
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes").get()!.n, 0);
  } finally { f.close(); }
});

test("MCP cannot mint for missing identity or another owner", async () => {
  const f = await prepared();
  try {
    for (const identity of [null, OTHER]) {
      assert.equal((await grantViaMcp(f, identity)).isError, true);
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM artifact_downloads").get()!.n, 0);
    await assert.rejects(new ArtifactStore(f.env, OTHER.userId).downloadToken(id, Date.now(), "machine"));
  } finally { f.close(); }
});

test("existing get_artifacts clients receive the same scoped machine grant without new tool discovery", async () => {
  const f = await prepared();
  try {
    const req = ownerRequest("/mcp");
    const response = await mcpPost(new Request(req, { method: "POST", headers: {
      ...Object.fromEntries(req.headers), "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "get_artifacts", arguments: { notebookId, artifactId: id },
    } }) }), f.env, noNetwork);
    const body = await response.json() as { result: { isError?: boolean; structuredContent: {
      artifacts: { id: string; downloadUrl: string; machineDownload: { url: string; headers: Record<string, string> } }[];
    } } };
    assert.equal(body.result.isError, undefined);
    const row = body.result.structuredContent.artifacts[0];
    assert.equal(row.id, id); assert.equal(row.machineDownload.url, url);
    const token = row.machineDownload.headers[MACHINE_DOWNLOAD_HEADER];
    const downloaded = await machineArtifactDownload(request(token), f.env, id);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), f.data);
    const browserToken = new URL(row.downloadUrl).searchParams.get("token")!;
    assert.equal((await machineArtifactDownload(request(browserToken), f.env, id)).status, 403);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes").get()!.n, 0);
  } finally { f.close(); }
});

test("grants cannot cross purpose, owner, artifact or expiry, and errors never echo credentials", async () => {
  const f = await prepared();
  try {
    const machine = await f.store.downloadToken(id, Date.now(), "machine");
    const browser = await f.store.downloadToken(id, Date.now());
    const expired = await f.store.downloadToken(id, Date.now() - 300001, "machine");
    for (const [token, target] of [["", id], ["x".repeat(43), id], [browser.token, id],
      [expired.token, id], [machine.token, otherId], [machine.token, "44444444-4444-4444-8444-444444444444"]]) {
      const response = await machineArtifactDownload(request(token), f.env, target);
      assert.equal(response.status, 403);
      const text = await response.text();
      if (token) assert.ok(!text.includes(token));
      assert.equal(response.headers.get("Content-Disposition"), null);
    }
    assert.equal((await artifactDownload(ownerRequest(`/api/artifacts/${id}?token=${machine.token}`), f.env, id)).status, 403);
    assert.equal((await artifactDownload(new Request(`${SITE_ORIGIN}/api/artifacts/${id}?token=${browser.token}`), f.env, id)).status, 401);
    const identities: Record<string, string>[] = [
      { "oai-authenticated-user-id": OTHER.userId, "oai-authenticated-user-email": OTHER.email },
      { "oai-authenticated-user-id": OWNER.userId },
    ];
    for (const headers of identities) {
      assert.ok((await machineArtifactDownload(request(machine.token, headers), f.env, id)).status >= 400);
    }
    f.sqlite.prepare("UPDATE artifact_downloads SET owner_id=?").run(OTHER.userId);
    assert.equal((await machineArtifactDownload(request(machine.token), f.env, id)).status, 403);
    f.sqlite.prepare("DELETE FROM site_owner").run();
    assert.equal((await machineArtifactDownload(request(machine.token), f.env, id)).status, 403);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM site_owner").get()!.n, 0);
    assert.equal(f.reads(), 0);
  } finally { f.close(); }
});

test("query tokens, cross-origin requests and mutations are rejected before storage access", async () => {
  const f = await prepared();
  try {
    const { token } = await f.store.downloadToken(id, Date.now(), "machine");
    for (const req of [request(token, {}, "GET", `${url}?token=${token}`),
      request(token, { Origin: "https://other.example.test" }), request(token, { "Sec-Fetch-Site": "cross-site" }),
      request(token, {}, "GET", url.replace(SITE_ORIGIN, "https://other.example.test")), request(token, {}, "POST")]) {
      assert.ok((await machineArtifactDownload(req, f.env, id)).status >= 400);
    }
    assert.equal(f.reads(), 0);
  } finally { f.close(); }
});

test("retired/expired artifacts and corrupt R2 metadata fail closed", async () => {
  const f = await prepared();
  try {
    const { token } = await f.store.downloadToken(id, Date.now(), "machine");
    for (const state of ["pending", "deleting", "expired"]) {
      f.sqlite.prepare("UPDATE notebook_artifacts SET state=? WHERE id=?").run(state, id);
      assert.equal((await machineArtifactDownload(request(token), f.env, id)).status, 410);
      await assert.rejects(f.store.downloadToken(id, Date.now(), "machine"));
    }
    f.sqlite.prepare("UPDATE notebook_artifacts SET state='ready',expires_at=1 WHERE id=?").run(id);
    assert.equal((await machineArtifactDownload(request(token), f.env, id)).status, 410);
    assert.equal(f.reads(), 0);
    f.sqlite.prepare("UPDATE notebook_artifacts SET expires_at=? WHERE id=?").run(Date.now() + 60000, id);
    f.metadata.checksums.sha256 = new Uint8Array(32).buffer;
    const response = await machineArtifactDownload(request(token), f.env, id);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Content-Disposition"), null);
  } finally { f.close(); }
});

test("single-range resume preserves bytes and SHA-256 with a 16 MiB fixture", async () => {
  const f = await prepared(16 * 1024 * 1024);
  try {
    const first = await f.store.downloadToken(id, Date.now(), "machine");
    const split = 700001;
    const initial = await machineArtifactDownload(request(first.token, { Range: `bytes=0-${split - 1}` }), f.env, id);
    assert.equal(initial.status, 206);
    assert.equal(initial.headers.get("Content-Range"), `bytes 0-${split - 1}/${f.data.length}`);
    f.sqlite.prepare("UPDATE artifact_downloads SET expires_at=1").run();
    assert.equal((await machineArtifactDownload(request(first.token, { Range: `bytes=${split}-` }), f.env, id)).status, 403);
    const renewed = await f.store.downloadToken(id, Date.now(), "machine");
    const resumed = await machineArtifactDownload(request(renewed.token, { Range: `bytes=${split}-`,
      "If-Range": `"${f.sha256}"`, "If-Match": `"${f.sha256}"` }), f.env, id);
    assert.equal(resumed.status, 206);
    assert.equal(resumed.headers.get("Content-Length"), String(f.data.length - split));
    const complete = Buffer.concat([Buffer.from(await initial.arrayBuffer()), Buffer.from(await resumed.arrayBuffer())]);
    assert.equal(complete.length, f.data.length);
    assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", complete)).toString("hex"), f.sha256);
  } finally { f.close(); }
});

test("range validation, version conditions and empty files never return incorrect partial metadata", async () => {
  const f = await prepared(128);
  try {
    const { token } = await f.store.downloadToken(id, Date.now(), "machine");
    for (const range of ["bytes=128-", "bytes=10-1", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "bytes=9007199254740993-", "items=0-1"]) {
      const response = await machineArtifactDownload(request(token, { Range: range }), f.env, id);
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("Content-Range"), "bytes */128");
    }
    assert.equal(f.reads(), 0);
    assert.equal((await machineArtifactDownload(request(token, { "If-Match": '"stale"' }), f.env, id)).status, 412);
    const suffix = await machineArtifactDownload(request(token, { Range: "bytes=-10" }), f.env, id);
    assert.equal(suffix.status, 206); assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), f.data.slice(-10));
    const full = await machineArtifactDownload(request(token, { Range: "bytes=1-", "If-Range": '"stale"' }), f.env, id);
    assert.equal(full.status, 200); assert.equal(full.headers.get("Content-Range"), null);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), f.data);
  } finally { f.close(); }
  const empty = await prepared(0);
  try {
    const { token } = await empty.store.downloadToken(id, Date.now(), "machine");
    const response = await machineArtifactDownload(request(token), empty.env, id);
    assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal((await machineArtifactDownload(request(token, { Range: "bytes=0-" }), empty.env, id)).status, 416);
  } finally { empty.close(); }
});
