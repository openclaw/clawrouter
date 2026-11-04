import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url), "utf8"));

test("PixVerse registry selects only text creation and retains the scoped native retrieve contract", async () => {
  const adapter = managedCreateAdapter("pixverse.video", "pixverse.text_video"); assert.ok(adapter);
  assert.equal(managedLifecycleAdapter("pixverse.video"), adapter);
  for (const format of ["pixverse.image_video", "pixverse.image_upload", "pixverse.video_get"]) assert.equal(managedCreateAdapter("pixverse.video", format), undefined);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  const prepared = adapter.prepare(fixture.text.body, new Headers({ "Ai-trace-id": "caller-trace" }), {}, new URLSearchParams());
  const observation = await adapter.read(Response.json(fixture.text.response), { action: "create", requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams });
  assert.equal(observation.id, String(fixture.text.response.Resp.video_id)); assert.equal(observation.followUp, "retrieve");
  const first = adapter.control("retrieve", fixture.retrieve, observation.id, prepared.pathParams);
  const second = adapter.control("retrieve", fixture.retrieve, observation.id, prepared.pathParams);
  assert.equal(first.path, "/openapi/v2/video/result/" + observation.id);
  assert.notEqual(first.headers.get("ai-trace-id"), second.headers.get("ai-trace-id"));
  assert.notEqual(prepared.headers.get("ai-trace-id"), "caller-trace");
  assert.equal(first.headers.has("API-KEY"), false); assert.deepEqual(first.transientHeaders, ["ai-trace-id"]);
  assert.throws(() => adapter.prepare(fixture.image.body, new Headers(), {}, new URLSearchParams()), /unsupported_pixverse_input/);
});

test("PixVerse registry preserves deleted-job uncertainty without treating credits as dollars", async () => {
  const adapter = managedCreateAdapter("pixverse.video", "pixverse.text_video"), id = "123";
  const observation = await adapter.read(Response.json({ ErrCode: 0, Resp: { status: 6, credits: 0 } }), { action: "retrieve", expectedId: id, requestedVersion: "v6", pathParams: {} });
  assert.equal(observation.id, id); assert.equal(observation.terminal, null);
  assert.equal(observation.observationUnavailable, "deleted"); assert.equal(observation.followUp, undefined);
  assert.equal(observation.actualCostMicros, undefined);
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, fixture.retrieve, id, {}));
  await assert.rejects(() => adapter.read(Response.json({ ErrCode: 0, Resp: { video_id: 124, status: 1 } }), { action: "retrieve", expectedId: id, requestedVersion: "v6", pathParams: {} }), /identity_mismatch/);
  assert.throws(() => adapter.identify("retrieve", { video_id: id }, new URLSearchParams({ img_id: "123" })));
});
