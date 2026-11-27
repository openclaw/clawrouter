import assert from "node:assert/strict";
import test from "node:test";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
import { wanModels } from "../managed-wan.ts";

test("registered Wan denies asset creates while original scoped observations remain readable", async () => {
  const adapter = managedCreateAdapter("dashscope.video", "dashscope.video_create");
  const input = { prompt: "Synthetic scene", img_url: "https://media.example/unowned.png" };
  assert.throws(() => adapter.prepare({ model: "wan2.6-i2v", input }, new Headers(), {}, new URLSearchParams()), /wan_input_asset_binding_required/);
  for (const model of wanModels) {
    const id = "original_job";
    assert.equal(adapter.control("retrieve", { method: "GET", path: "/api/v1/tasks/${task_id}" }, id, {}).path, "/api/v1/tasks/" + id);
    const observed = await adapter.read(Response.json({ output: { task_id: id, task_status: "UNKNOWN" } }),
      { action: "retrieve", expectedId: id, requestedVersion: model, pathParams: {} });
    assert.equal(observed.terminal, null); assert.equal(observed.observationUnavailable, "expired_or_unknown");
    assert.equal(observed.followUp, undefined); assert.equal(observed.actualCostMicros, undefined);
  }
});
