import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { kieManagedAdapter as adapter } from "../managed-kie.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/jobs.json", import.meta.url), "utf8"));
const context = { action: "retrieve", expectedId: wire.submission.data.taskId, requestedVersion: wire.request.body.model, pathParams: {} };

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
