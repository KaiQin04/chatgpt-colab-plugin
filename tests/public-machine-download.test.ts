import assert from "node:assert/strict";
import { test } from "node:test";
import { machineArtifactDownload } from "../lib/notebook/machine-download.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { fixture } from "./helpers.ts";

test("public machine downloads reject unconfirmed deployments before storage access", async () => {
  const f = fixture();
  try {
    f.env.DB!.prepare = () => { throw new Error("unexpected_storage_access"); };
    for (const value of [undefined, "false", "TRUE", "1"]) {
      f.env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED = value;
      const id = "11111111-1111-4111-8111-111111111111";
      const response = await machineArtifactDownload(
        new Request(`${SITE_ORIGIN}/api/artifacts/${id}/machine`), f.env, id,
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { error: { code: string } }).error.code,
        "private_service_boundary_required");
    }
  } finally { f.close(); }
});
