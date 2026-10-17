import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../lib/platform/store.ts";
import { maintenanceApi } from "../lib/notebook/maintenance-api.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { fixture, noNetwork, OWNER } from "./helpers.ts";

test("unconfirmed private deployment cannot enroll an owner or run maintenance", async () => {
  const f = fixture();
  try {
    for (const confirmation of [undefined, "false", "TRUE", "1"]) {
      f.env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED = confirmation;
      await assert.rejects(new Store(f.env).owner(OWNER), /private_deployment_not_confirmed/);
      const request = new Request(`${SITE_ORIGIN}/api/maintenance`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const response = await maintenanceApi(request, f.env, noNetwork);
      assert.equal(response.ok, false);
      assert.equal((await response.json() as any).error.code, "private_service_boundary_required");
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM site_owner").get()!.count, 0);
    }
    f.env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED = "true";
    await new Store(f.env).owner(OWNER);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM site_owner").get()!.count, 1);
  } finally { f.close(); }
});
