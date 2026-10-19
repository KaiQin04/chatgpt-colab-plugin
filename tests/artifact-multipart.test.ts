import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ArtifactStore, MACHINE_DOWNLOAD_HEADER } from "../lib/notebook/artifact-store.ts";
import { archiveRun, artifactView } from "../lib/notebook/artifacts.ts";
import { deleteArtifactObject, verifyMultipart } from "../lib/notebook/artifact-object.ts";
import { machineArtifactDownload } from "../lib/notebook/machine-download.ts";
import { NotebookStore } from "../lib/notebook/store.ts";
import { notebookCall } from "../lib/notebook/service.ts";
import { ARTIFACT_PART_BYTES as PART } from "../lib/notebook/policy.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { Store } from "../lib/platform/store.ts";
import type { RuntimeRow } from "../lib/notebook/types.ts";
import { fixture, noNetwork, OWNER } from "./helpers.ts";

// Node-only test adapter; production uses the native Workers streaming digest.
class TestDigestStream extends WritableStream<Uint8Array> {
  digest: Promise<ArrayBuffer>;
  constructor() {
    let resolve!: (value: ArrayBuffer) => void, reject!: (error: unknown) => void;
    const digest = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
    const hash = createHash("sha256");
    super({ write: (chunk) => { hash.update(chunk); }, close: () => resolve(new Uint8Array(hash.digest()).buffer), abort: reject });
    this.digest = digest;
  }
}
Object.defineProperty(crypto, "DigestStream", { value: TestDigestStream, configurable: true });

class MultipartBucket {
  parts = new Map<number, Uint8Array>();
  created = 0; completed = false; aborted = 0; version = "synthetic-version-1";
  failPart = false; loseCompleteAck = false; corrupt = false; calls: number[] = [];
  key = "";
  async createMultipartUpload(key: string) { this.key = key; this.created++; return { uploadId: "synthetic-upload" }; }
  resumeMultipartUpload(key: string, id: string) {
    assert.equal(key, this.key); assert.equal(id, "synthetic-upload");
    return {
      uploadPart: async (partNumber: number, data: Uint8Array) => {
        assert.ok(data.length <= PART); this.calls.push(partNumber); this.parts.set(partNumber, data);
        if (this.failPart) { this.failPart = false; throw new Error("lost part acknowledgement"); }
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (parts: R2UploadedPart[]) => {
        assert.equal(parts.length, this.parts.size);
        assert.ok(parts.every((part, index) => part.partNumber === index + 1 && part.etag === `part-${index + 1}`));
        this.completed = true;
        if (this.loseCompleteAck) { this.loseCompleteAck = false; throw new Error("lost completion acknowledgement"); }
        return this.head(key);
      },
      abort: async () => { this.aborted++; if (!this.completed) this.parts.clear(); },
    };
  }
  async head(key: string) {
    if (!this.completed || key !== this.key) return null;
    return { key, version: this.version, checksums: {}, size: [...this.parts.values()].reduce((sum, data) => sum + data.length, 0) };
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const head = await this.head(key); if (!head) return null;
    let offset = options?.range?.offset ?? 0, remaining = options?.range?.length ?? head.size;
    const bucket = this;
    return { ...head, range: options?.range, body: new ReadableStream<Uint8Array>({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const source = bucket.parts.get(Math.floor(offset / PART) + 1)!;
      const length = Math.min(remaining, source.length - offset % PART);
      let data = source.subarray(offset % PART, offset % PART + length);
      if (bucket.corrupt && offset === 0) { data = data.slice(); data[0] ^= 1; }
      offset += length; remaining -= length; controller.enqueue(data);
    } }) };
  }
  async delete() { this.parts.clear(); this.completed = false; }
}

async function prepared(size = 3 * PART + 17) {
  const f = fixture(), bucket = new MultipartBucket(); f.env.BUCKET = bucket as unknown as R2Bucket;
  await new Store(f.env).owner(OWNER);
  const notebooks = new NotebookStore(f.env, OWNER.userId), artifacts = new ArtifactStore(f.env, OWNER.userId);
  const notebookId = crypto.randomUUID(), cellId = crypto.randomUUID();
  const { runtime } = await notebooks.reserveOpen(notebookId, "Synthetic multipart", "open-large");
  await notebooks.selectRuntimeCompute(runtime.id, { kind: "CPU", accelerator: "CPU" });
  await notebooks.observedRuntimeCompute(runtime.id, { kind: "CPU", accelerator: "CPU", variant: "DEFAULT" });
  await notebooks.endpoint(runtime.id, "synthetic-endpoint"); await notebooks.opened(runtime.id, "synthetic-kernel");
  await notebooks.upsertCell({ notebookId, cellId, kind: "code", source: "pass", expectedVersion: 0, actor: "user" });
  const { run } = await notebooks.reserveRun({ notebookId, cellId, cellVersion: 1, idempotencyKey: "run-large", actor: "assistant" });
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += PART) hash.update(new Uint8Array(Math.min(PART, size - offset)).fill(offset / PART));
  const sha256 = hash.digest("hex");
  await notebooks.updateRun(run.id, "ok", { protocol: 1, runId: run.id, status: "ok", outputs: [], truncated: false,
    startedAt: Date.now(), finishedAt: Date.now(), executionCount: 1,
    artifacts: { files: [{ path: "large.bin", size, sha256 }], errors: [] } });
  const offsets: number[] = [];
  const remote = { readArtifact: async () => { throw new Error("whole-file read forbidden"); },
    readArtifactRange: async (_runtime: RuntimeRow, path: string, bytes: number, offset: number, length: number) => {
      assert.equal(path, "large.bin"); assert.equal(bytes, size); assert.ok(length <= PART);
      offsets.push(offset); return new Uint8Array(length).fill(offset / PART);
    } };
  const archive = () => archiveRun(f.env, OWNER.userId, runForArchive(), runtime, remote, new AbortController().signal, Date.now);
  const runForArchive = () => f.sqlite.prepare("SELECT * FROM notebook_runs WHERE id=?").get(run.id) as unknown as typeof run;
  const row = async () => (await artifacts.list(notebookId, run.id))[0];
  const expireLease = () => f.sqlite.prepare("UPDATE notebook_artifacts SET upload_lease_expires_at=0").run();
  return { ...f, bucket, notebooks, artifacts, notebookId, runtime, run, offsets, archive, row, expireLease, sha256, size };
}

test("64 MiB multipart resumes uncertain parts/completion, verifies full bytes and pins the downloaded version", async () => {
  const f = await prepared(8 * PART + 17);
  try {
    assert.equal((await f.archive()).saved, false); // create
    await f.archive(); // part 1
    f.bucket.failPart = true;
    assert.equal((await f.archive()).error!.code, "artifact_storage_failed");
    assert.equal(artifactView(await f.row()).progress!.uploadedBytes, PART);
    assert.equal((await f.archive()).processed, 0); // lease blocks uncertain overlap
    f.expireLease(); await f.archive(); // retry part 2
    assert.deepEqual(f.offsets.slice(0, 3), [0, PART, PART]);
    for (let i = 2; i < 9; i++) await f.archive();
    f.bucket.loseCompleteAck = true;
    assert.ok((await f.archive()).error); assert.equal((await f.row()).state, "pending");
    f.expireLease();
    const result = await f.archive();
    assert.equal(result.saved, true); assert.equal(f.bucket.created, 1);
    const row = await f.row(); assert.equal(row.storage_version, f.bucket.version);
    assert.equal((await f.notebooks.notebook(f.notebookId)).active_run_id, null);
    const grant = await f.artifacts.downloadToken(row.id, Date.now(), "machine");
    const request = () => new Request(`${SITE_ORIGIN}/api/artifacts/${row.id}/machine`, {
      headers: { [MACHINE_DOWNLOAD_HEADER]: grant.token, Range: `bytes=${PART - 11}-${PART + 11}` },
    });
    const response = await machineArtifactDownload(request(), f.env, row.id);
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([...Array(11).fill(0), ...Array(12).fill(1)]));
    f.bucket.version = "replaced-object";
    assert.equal((await machineArtifactDownload(request(), f.env, row.id)).status, 502);
  } finally { f.close(); }
});

test("concurrent polls create one upload, corruption stays unavailable, and discard waits for the writer before cleanup", async () => {
  const f = await prepared();
  try {
    await Promise.all([f.archive(), f.archive()]); assert.equal(f.bucket.created, 1);
    for (let i = 0; i < 6 && !f.bucket.completed; i++) await f.archive();
    assert.equal(f.bucket.completed, true);
    f.bucket.corrupt = true;
    assert.equal((await f.archive()).error!.code, "artifact_storage_readback_mismatch");
    assert.equal((await f.row()).state, "pending");
    assert.equal((await f.notebooks.notebook(f.notebookId)).active_run_id, f.run.id);
    await assert.rejects(f.artifacts.downloadToken((await f.row()).id, Date.now(), "machine"), /expired/);
    await f.notebooks.discardArtifacts(f.run.id, f.notebookId, { code: "explicit_discard" });
    assert.equal((await f.artifacts.retiring(Date.now())).length, 0);
    f.expireLease();
    const retiring = await f.artifacts.retiring(Date.now()); assert.equal(retiring.length, 1);
    await deleteArtifactObject(f.env.BUCKET!, retiring[0]); await f.artifacts.expired(retiring[0].id);
    assert.equal(f.bucket.aborted, 1); assert.equal(f.bucket.parts.size, 0);
    assert.equal((await f.archive()).processed, 0);
  } finally { f.close(); }
});

test("notebook deletion aborts pending multipart before purging its ledger", async () => {
  const f = await prepared();
  try {
    await f.archive(); await f.archive();
    await f.notebooks.discardArtifacts(f.run.id, f.notebookId, { code: "explicit_discard" });
    f.sqlite.prepare("UPDATE notebooks SET state='closed' WHERE id=?").run(f.notebookId);
    f.sqlite.prepare("UPDATE notebook_runtimes SET released=1 WHERE id=?").run(f.runtime.id);
    const result = await notebookCall("delete_notebook", { notebookId: f.notebookId, confirmArtifactCount: 1 }, f.env,
      OWNER, { fetcher: noNetwork });
    assert.equal(result.deleted, true); assert.equal(f.bucket.aborted, 1);
    assert.equal(f.bucket.parts.size, 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM notebook_artifacts").get()!.n, 0);
  } finally { f.close(); }
});

test("expired or discarded upload claims cannot acknowledge parts or make an artifact ready", async () => {
  const f = await prepared();
  try {
    await f.archive();
    const old = await f.artifacts.claimUpload((await f.row()).id, Date.now()); assert.ok(old);
    f.expireLease();
    const current = await f.artifacts.claimUpload(old.id, Date.now()); assert.ok(current);
    await assert.rejects(f.artifacts.extendVerificationLease(old, Date.now(), 240_000), /upload_conflict/);
    const leaseAt = Date.now();
    await f.artifacts.extendVerificationLease(current, leaseAt, 240_000);
    assert.equal((await f.row()).upload_lease_expires_at, leaseAt + 240_000);
    await assert.rejects(f.artifacts.uploadCheckpoint(old, old.upload_id!, [], Date.now(),
      { version: "stale", mediaType: "application/octet-stream" }), /upload_conflict/);
    await f.artifacts.releaseUpload(old);
    assert.equal((await f.row()).upload_lease_token, current.upload_lease_token);
    await f.notebooks.discardArtifacts(f.run.id, f.notebookId, { code: "explicit_discard" });
    await assert.rejects(f.artifacts.extendVerificationLease(current, Date.now(), 240_000), /upload_conflict/);
    await assert.rejects(f.artifacts.uploadCheckpoint(current, current.upload_id!, [], Date.now()), /upload_conflict/);
    await assert.rejects(deleteArtifactObject(f.env.BUCKET!, await f.row()), /upload_busy/);
    assert.equal(f.bucket.aborted, 0);
  } finally { f.close(); }
});

test("cancelling verification cancels the R2 stream and retains the completed upload for retry", async () => {
  const f = await prepared();
  try {
    for (let i = 0; i < 6; i++) await f.archive();
    const original = f.bucket.get.bind(f.bucket); let cancelled = false;
    f.bucket.get = async (key) => ({ ...await f.bucket.head(key), body: new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }) }) as never;
    const controller = new AbortController();
    const verification = verifyMultipart(f.env.BUCKET!, await f.row(), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(verification, /deadline/);
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(cancelled, true);
    f.bucket.get = original;
    assert.equal((await f.archive()).saved, true); assert.equal(f.bucket.created, 1);
  } finally { f.close(); }
});
