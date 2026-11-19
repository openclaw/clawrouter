import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { falHostedWanModels, falRetiredKlingModel, prepareFalHostedWan } from "../fal-hosted-wan.ts";
import { falQueuePaths } from "../fal-queue.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/hosted-wan.json", import.meta.url)));
const adapter = managedCreateAdapter("fal.queue", "fal.queue_submit");
const prepare = (i, changes = {}) => prepareFalHostedWan(wire.requests[i].model, { ...wire.requests[i].body, ...changes });
test("registered Wan preparation retains exact fal product, native fields and original path parameters", () => {
  assert.deepEqual(wire.requests.map(item => item.model), [...falHostedWanModels]);
  for (let i = 0; i < 2; i++) {
    const prepared = prepare(i), managed = adapter.prepare(wire.requests[i].body, new Headers({ authorization: "Bearer synthetic-caller" }), wire.requests[i].pathParams, new URLSearchParams());
    assert.equal(prepared.path, "/" + wire.requests[i].model); assert.deepEqual(managed.body, prepared.body);
    assert.deepEqual(managed.pathParams, wire.requests[i].pathParams); assert.equal(managed.requestedVersion, prepared.model);
    assert.equal(managed.headers.has("authorization"), false); assert.equal(managed.headers.get("X-Fal-No-Retry"), "1");
    assert.equal(prepared.inputImages, i); assert.equal(prepared.inputBytes, i ? 8 : 0); assert.equal(prepared.upstreamCostMicros, null);
  }
});
test("deprecated Kling stays non-executable with historical wire shape and no silent replacement", () => {
  assert.equal(wire.historicalKling.model, falRetiredKlingModel); assert.equal(wire.historicalKling.executable, false);
  assert.equal(wire.historicalKling.replacementModel, null);
  assert.throws(() => prepareFalHostedWan(falRetiredKlingModel, wire.historicalKling.body), /unsupported_kling_endpoint/);
  assert.throws(() => adapter.prepare(wire.historicalKling.body, new Headers(), { owner: "fal-ai", app: "kling-video", variant: "v2.1", subvariant: "master", mode: "text-to-video" }, new URLSearchParams()));
});
test("unsupported duration/size/advanced settings fail instead of inventing a frame or tariff conversion", () => {
  for (const i of [0, 1]) for (const changes of [{ duration: 5 }, { duration: "5" }, { size: "1280x720" }, { num_frames: 81 },
    { frames_per_second: 16 }, { num_inference_steps: 27 }, { generate_audio: true }, { webhookUrl: "https://sink.example/hook" }]) {
    assert.throws(() => prepare(i, changes));
    assert.throws(() => adapter.prepare({ ...wire.requests[i].body, ...changes }, new Headers(), wire.requests[i].pathParams, new URLSearchParams()));
  }
});
test("native resolution/aspect choices and scalar shapes remain exact; omitted edit geometry stays omitted", () => {
  for (const resolution of ["480p", "580p", "720p"]) assert.equal(prepare(0, { resolution }).body.resolution, resolution);
  for (const changes of [{ resolution: "1080p" }, { resolution: ["720p"] }, { aspect_ratio: "auto" }, { aspect_ratio: ["16:9"] }, { aspect_ratio: "21:9" }]) assert.throws(() => prepare(0, changes));
  assert.equal(Object.hasOwn(prepare(1).body, "aspect_ratio"), false);
});
test("image-to-video requires one bounded inline image without switching text routes or borrowing direct Wan credentials", () => {
  assert.throws(() => prepare(0, { image_url: wire.requests[1].body.image_url }));
  for (const image_url of [undefined, "https://assets.example/input.png", "data:image/png;base64,AB==", "data:video/mp4;base64,AAAA"]) assert.throws(() => prepare(1, { image_url }));
  assert.throws(() => prepare(1, { image_url: "data:image/png;base64," + Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }));
  for (const model of ["wan2.2-t2v-plus", "alibaba/wan", "fal-ai/wan/v3/text-to-video"]) assert.throws(() => prepareFalHostedWan(model, wire.requests[0].body));
});
test("interior version dots cannot become traversal, encoded path injection or arbitrary executable routes", () => {
  assert.equal(falQueuePaths(wire.requests[0].model, wire.requestId).status, "/fal-ai/wan/requests/" + wire.requestId + "/status");
  for (const model of ["fal-ai/wan/../text-to-video", "fal-ai/wan/.hidden", "fal-ai/wan/v2.", "fal-ai/wan/v2..2", "fal-ai/wan/v2%2e2", "fal-ai/wan/v2.2\n"]) assert.throws(() => falQueuePaths(model));
  for (const params of [{ ...wire.requests[0].pathParams, variant: "v9.9" }, { owner: "bytedance", app: "seedance-2.0", variant: "unqualified-mode" },
    { owner: "fal-ai/wan", app: "v2.2-a14b", variant: "text-to-video" }]) assert.throws(() => adapter.prepare(wire.requests[0].body, new Headers(), params, new URLSearchParams()));
});
test("controls share the native owner/app root while full original create identity remains in the job", () => {
  for (const request of wire.requests) {
    const control = adapter.control("retrieve", { method: "GET", path: "/${owner}/${app}/requests/${request_id}/status" }, wire.requestId, request.pathParams);
    assert.equal(control.path, "/fal-ai/wan/requests/" + wire.requestId + "/status");
    assert.equal(adapter.prepare(request.body, new Headers(), request.pathParams, new URLSearchParams()).requestedVersion, request.model);
  }
});
test("native completion needs the original scoped result and never converts queue time into upstream cost", async () => {
  const context = action => ({ action, requestedVersion: wire.requests[0].model, pathParams: wire.requests[0].pathParams,
    ...(action === "create" ? {} : { expectedId: wire.requestId }) });
  assert.equal((await adapter.read(Response.json(wire.submit), context("create"))).followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.running), context("retrieve"))).terminal, null);
  assert.equal((await adapter.read(Response.json(wire.completed), context("retrieve"))).followUp, "result");
  const result = await adapter.read(Response.json(wire.result), context("result"));
  assert.equal(result.terminal, "succeeded"); assert.equal(result.followUp, undefined);
  assert.equal(prepare(0).upstreamCostMicros, null);
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
});
