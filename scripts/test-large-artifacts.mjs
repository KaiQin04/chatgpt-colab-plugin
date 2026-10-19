/** Local workerd/R2 acceptance with synthetic bytes; never contacts Sites or Colab. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const partSize = 8 * 1024 * 1024;
const size = process.argv.includes("--ten-gib") ? 10 * 1024 * 1024 * 1024
  : process.argv.includes("--gib") ? 1024 * 1024 * 1024 : 64 * 1024 * 1024 + 17;
const partsCount = Math.ceil(size / partSize);
const expected = createHash("sha256");
for (let i = 0; i < partsCount; i++) expected.update(Buffer.alloc(Math.min(partSize, size - i * partSize), i));
const sha256 = expected.digest("hex");
const entry = `
import { verifyMultipart, matchesArtifact } from "./lib/notebook/artifact-object.ts";
const key = "synthetic-large-test";
export default { async fetch(request, env) {
  const args = await request.json();
  const upload = args.uploadId ? env.BUCKET.resumeMultipartUpload(key, args.uploadId) : null;
  switch (args.action) {
    case "create": return Response.json({ uploadId: (await env.BUCKET.createMultipartUpload(key)).uploadId });
    case "part": return Response.json(await upload.uploadPart(args.partNumber, new Uint8Array(args.length).fill(args.partNumber - 1)));
    case "complete": await upload.complete(args.parts); return Response.json({ completed: true });
    case "verify": {
      const row = { object_key: key, size: args.size, sha256: args.sha256 };
      const version = await verifyMultipart(env.BUCKET, row, request.signal);
      const head = await env.BUCKET.head(key);
      return Response.json({ version, size: head.size, checksumPresent: !!head.checksums.sha256,
        matches: matchesArtifact(head, { ...row, storage_version: version }),
        rejectsReplacement: !matchesArtifact(head, { ...row, storage_version: "wrong-version" }) });
    }
    case "range": {
      const object = await env.BUCKET.get(key, { range: { offset: args.offset, length: args.length } });
      return new Response(object.body, { status: 206, headers: { "Content-Range":
        "bytes " + args.offset + "-" + (args.offset + args.length - 1) + "/" + object.size } });
    }
    case "cleanup": await upload.abort(); await upload.abort(); await env.BUCKET.delete(key);
      return Response.json({ deleted: !(await env.BUCKET.head(key)) });
  }
} };`;
const bundle = await build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-05-15", r2Buckets: ["BUCKET"] });
let uploadId;
const call = async (args) => {
  const response = await mf.dispatchFetch("http://localhost/test", { method: "POST", body: JSON.stringify({ uploadId, ...args }) });
  assert.ok(response.ok, `Local Worker returned ${response.status}: ${await (response.ok ? Promise.resolve("") : response.text())}`);
  return response;
};
try {
  ({ uploadId } = await (await call({ action: "create" })).json());
  const parts = [], started = performance.now();
  for (let i = 0; i < partsCount; i++) {
    parts.push(await (await call({ action: "part", partNumber: i + 1, length: Math.min(partSize, size - i * partSize) })).json());
    if ((i + 1) % 32 === 0) console.log(JSON.stringify({ uploadedBytes: (i + 1) * partSize, size }));
  }
  await call({ action: "complete", parts });
  const verifyStarted = performance.now();
  const verified = await (await call({ action: "verify", size, sha256 })).json();
  const verifyMs = Math.round(performance.now() - verifyStarted);
  assert.equal(verified.size, size); assert.equal(verified.matches, true); assert.equal(verified.rejectsReplacement, true);
  assert.equal(verified.checksumPresent, false);
  const actual = createHash("sha256"); let bytes = 0;
  const split = Math.floor(size / 2);
  for (const [offset, length] of [[0, split], [split, size - split]]) {
    const response = await call({ action: "range", offset, length }); assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes ${offset}-${offset + length - 1}/${size}`);
    for await (const chunk of response.body) { bytes += chunk.byteLength; actual.update(chunk); }
  }
  assert.equal(bytes, size); assert.equal(actual.digest("hex"), sha256);
  assert.equal((await (await call({ action: "cleanup" })).json()).deleted, true);
  console.log(JSON.stringify({ localWorkerd: true, size, parts: parts.length, sha256,
    verifyMs, elapsedMs: Math.round(performance.now() - started), resumedSha256Matches: true, cleaned: true }));
} finally { await mf.dispose(); }
