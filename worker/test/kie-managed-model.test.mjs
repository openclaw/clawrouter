import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { kieManagedAdapter as adapter } from "../managed-kie.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/jobs.json", import.meta.url), "utf8"));
const context = { action: "retrieve", expectedId: wire.submission.data.taskId, requestedVersion: wire.request.body.model, pathParams: {} };

test("the declaration cannot silently reactivate the unqualified frozen Seedance default or unowned image modes", () => {
  const prepare = body => adapter.prepare(body, new Headers(), {}, new URLSearchParams());
  assert.throws(() => prepare({ model: "bytedance/seedance-1.5-pro", input: { prompt: "A paper boat", duration: 5 } }), /kie_seedance_native_contract_unqualified/);
  for (const model of ["kling-2.6/image-to-video", "grok-imagine/image-to-video", "wan/2-6-image-to-video"]) {
    assert.throws(() => prepare({ model, input: { prompt: "A paper boat", image_url: "https://assets.example/unowned.png" } }), /kie_image_binding_required/);
  }
  // Native Kling uses string duration; omitted sound is not a fabricated default.
  assert.deepEqual(prepare(wire.request.body).body, wire.request.body);
  assert.throws(() => prepare({ ...wire.request.body, input: { ...wire.request.body.input, duration: 5 } }));
  const missingSound = structuredClone(wire.request.body); delete missingSound.input.sound;
  assert.equal(Object.hasOwn(prepare(missingSound).body.input, "sound"), false);
  assert.throws(() => prepare({ ...wire.request.body, input: { ...wire.request.body.input, sound: "false" } }));
  const control = adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, context.expectedId, {});
  assert.equal(control.query.get("taskId"), context.expectedId);
});

test("Kie observations retain original model identity before exposing terminal evidence", async () => {
  for (const body of [wire.responses.waiting, wire.responses.partial, wire.responses.success]) {
    assert.equal((await adapter.read(Response.json(body), context)).id, context.expectedId);
    for (const model of ["grok-imagine/text-to-video", null, 1, {}]) await assert.rejects(adapter.read(Response.json({ ...body, data: { ...body.data, model } }), context), /kie_task_model_mismatch/);
  }
});

test("absent model metadata does not fabricate a failure or zero-cost terminal receipt", async () => {
  const body = structuredClone(wire.responses.success); delete body.data.model; delete body.data.creditsConsumed;
  const observed = await adapter.read(Response.json(body), context);
  assert.equal(observed.terminal, "succeeded"); assert.equal(observed.cost, undefined); assert.equal(observed.actualCostMicros, undefined);
  assert.equal((await adapter.read(Response.json(wire.responses.partial), context)).terminal, null);
  await assert.rejects(adapter.read(Response.json({ ...body, data: { ...body.data, taskId: "foreign" } }), context), /kie_task_id_mismatch/);
});
