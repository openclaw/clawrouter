import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareKieGrokWire } from "../kie-grok.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/grok-video.json", import.meta.url)));
const adapter = managedCreateAdapter("kie.jobs", "kie.job_create");
const prepare = (body = wire.text) => adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller", "idempotency-key": "synthetic-replay" }), {}, new URLSearchParams());
const textInput = input => ({ ...wire.text, input: { ...wire.text.input, ...input } });
const imageInput = input => ({ ...wire.image, input: { ...wire.image.input, ...input } });

test("registered Kie create preserves native numeric text duration and selected identity without forwarding caller headers", () => {
  const prepared = prepare();
  assert.deepEqual(prepared.body, wire.text); assert.notEqual(prepared.body, wire.text);
  assert.equal(prepared.requestedVersion, wire.text.model);
  assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.has("idempotency-key"), false);
  for (const duration of [6, 10, 29, 30]) assert.equal(prepare(textInput({ duration })).body.input.duration, duration);
  for (const duration of ["6", 5, 31, 6.5, NaN, Infinity, null, [6]]) assert.throws(() => prepare(textInput({ duration })), /duration/);
});
test("image duration is a canonical string, never a numeric value or a rounded request", () => {
  for (const duration of ["6", "10", "29", "30"]) assert.equal(prepareKieGrokWire(imageInput({ duration })).requestedDurationSeconds, Number(duration));
  for (const duration of [6, "06", "6.0", " 6", "5", "31", null, ["6"]]) assert.throws(() => prepareKieGrokWire(imageInput({ duration })), /duration/);
  const minimal = prepareKieGrokWire({ model: wire.text.model, input: { prompt: "Paper fox" } });
  assert.equal(minimal.requestedDurationSeconds, null); assert.equal(minimal.upstreamCostMicros, null);
  assert.deepEqual(minimal.body.input, { prompt: "Paper fox" });
});
test("only frozen geometry and scalar resolutions qualify; audio/mode/size are not silently ignored", () => {
  for (const resolution of ["480p", "720p", "1080p"]) assert.equal(prepare(textInput({ resolution })).body.input.resolution, resolution);
  for (const aspect_ratio of ["16:9", "2:3", "3:2", "1:1", "9:16"]) assert.equal(prepare(textInput({ aspect_ratio })).body.input.aspect_ratio, aspect_ratio);
  for (const input of [{ resolution: "720P" }, { resolution: ["720p"] }, { resolution: null }, { aspect_ratio: "auto" },
    { aspect_ratio: ["16:9"] }, { sound: false }, { generate_audio: false }, { mode: "normal" }, { size: "1280x720" }]) assert.throws(() => prepare(textInput(input)));
  assert.throws(() => prepareKieGrokWire(imageInput({ aspect_ratio: "1:1" })), /input/);
});
test("bounded prompts and product identities cannot smuggle callbacks, credentials or other Grok APIs", () => {
  assert.equal(prepare(textInput({ prompt: "🦊".repeat(5000) })).body.input.prompt.length, 10000);
  for (const prompt of [" ", "x".repeat(5001), "bad\ud800"]) assert.throws(() => prepare(textInput({ prompt })));
  for (const extra of [{ callBackUrl: "https://sink.example/hook" }, { apiKey: "synthetic" }]) assert.throws(() => prepare({ ...wire.text, ...extra }));
  for (const model of ["grok-imagine-video", "xai/grok-imagine-video", "grok-imagine/video-extend"]) assert.throws(() => prepareKieGrokWire({ ...wire.text, model }));
});
test("one image URL is wire data, not authority; upload, task_id and actual image dispatch remain closed", () => {
  assert.deepEqual(prepareKieGrokWire(wire.image).body, wire.image);
  assert.throws(() => prepare(wire.image), /kie_image_binding_required/);
  assert.equal(wire.imageActivation.enabled, false);
  for (const image_urls of [[], [...wire.image.input.image_urls, ...wire.image.input.image_urls], ["http://assets.example/in.png"],
    ["https://127.0.0.1/in.png"], ["https://host.internal/in.png"], ["https://user:synthetic@assets.example/in.png"],
    ["data:image/png;base64,AAAA"]]) assert.throws(() => prepareKieGrokWire(imageInput({ image_urls })));
  for (const input of [{ task_id: "foreign_task", index: 0 }, { image_urls: wire.image.input.image_urls }]) assert.throws(() => prepare(textInput(input)));
  assert.throws(() => prepareKieGrokWire(imageInput({ task_id: "foreign_task" })));
});
test("partial outputs do not settle; known terminal jobs stop without media or a dollar receipt", async () => {
  const context = action => ({ action, requestedVersion: wire.text.model, pathParams: {}, ...(action === "create" ? {} : { expectedId: wire.taskId }) });
  assert.equal((await adapter.read(Response.json(wire.submission), context("create"))).followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.partial), context("retrieve"))).terminal, null);
  for (const body of [wire.completed, { code: 200, data: { taskId: wire.taskId, state: "success" } }]) {
    const result = await adapter.read(Response.json(body), context("retrieve"));
    assert.equal(result.terminal, "succeeded"); assert.equal(result.followUp, undefined);
  }
  assert.equal((await adapter.read(Response.json(wire.failed), context("retrieve"))).terminal, "failed");
  assert.equal(prepareKieGrokWire(wire.text).upstreamCostMicros, null, "native credits never establish a dollar rate");
  await assert.rejects(adapter.read(Response.json(wire.observationLost), context("retrieve")), /kie_request_rejected/);
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
});
test("the existing bound GET is the only control; no cancellation, fetch or create replay is introduced", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected I/O"); });
  assert.equal(adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {}).query.get("taskId"), wire.taskId);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  assert.throws(() => adapter.control("cancel", { method: "DELETE", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {}));
  assert.equal(prepare().requestedVersion, wire.text.model);
});
