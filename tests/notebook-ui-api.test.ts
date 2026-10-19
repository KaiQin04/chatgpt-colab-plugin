import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, closeNeedsDiscard, NotebookApi } from "../ui/app/api.ts";

test("setup and input uncertainty offer the same explicit discard choice as unsaved output", () => {
  for (const code of ["runtime_setup_in_progress_or_unknown", "input_import_in_progress_or_unknown"]) {
    assert.equal(closeNeedsDiscard(new ApiError(code)), true);
  }
  assert.equal(closeNeedsDiscard(new ApiError("outputs_not_persisted", "close", { outputsPersisted: false })), true);
  assert.equal(closeNeedsDiscard(new ApiError("release_unconfirmed")), false);
  assert.equal(closeNeedsDiscard(new Error("runtime_setup_in_progress_or_unknown")), false);
});

test("compute UI receives unknown presence on provider failure instead of a stale count", async () => {
  const response = { ownerRuntimeCount: null, ownerRuntimeUnknownCount: 3, runtimePresence: "unknown",
    error: { code: "upstream_http_error", stage: "compute" } };
  const api = new NotebookApi({ call: async () => response } as any);
  assert.deepEqual(await api.compute(), { ...response, warning: "upstream_http_error" });
});
