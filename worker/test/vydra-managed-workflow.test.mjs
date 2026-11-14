import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { vydraManagedAdapter as adapter } from "../managed-vydra.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/vydra/jobs.json", import.meta.url), "utf8"));
const context = { action: "retrieve", expectedId: wire.submission.id, requestedVersion: wire.request.body.workflow, pathParams: {} };

test("Vydra present workflow identities must match the original create on both submission and retrieval", async () => {
  for (const action of ["create", "retrieve"]) for (const key of ["workflow", "workflowSlug"]) {
    const native = action === "create" ? wire.submission : wire.responses.completed;
    assert.equal((await adapter.read(Response.json({ ...native, [key]: context.requestedVersion }), { ...context, action })).id, context.expectedId);
    for (const value of ["generate_image", null, 1, {}]) await assert.rejects(adapter.read(Response.json({ ...native, [key]: value }), { ...context, action }), /vydra_job_workflow_mismatch/);
  }
});

test("missing workflow or refund counters cannot turn uncertain cancellation into a free terminal job", async () => {
  const body = structuredClone(wire.responses.completed); delete body.workflow; delete body.workflowSlug; delete body.creditsCharged;
  const done = await adapter.read(Response.json(body), context); assert.equal(done.terminal, "succeeded"); assert.equal(done.actualCostMicros, undefined);
  const created = await adapter.read(Response.json(body, { status: 201 }), { ...context, action: "create" });
  assert.equal(created.terminal, null); assert.equal(created.followUp, "retrieve");
  const canceled = await adapter.read(Response.json(wire.cancel.response), { ...context, action: "cancel" });
  assert.equal(canceled.terminal, null); assert.equal(canceled.followUp, "retrieve"); assert.equal(canceled.actualCostMicros, undefined);
  await assert.rejects(adapter.read(Response.json({ ...body, id: "foreign" }), context), /vydra_job_id_mismatch/);
});
