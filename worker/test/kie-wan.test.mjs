import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareKieWanWire } from "../kie-wan.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/wan-video.json", import.meta.url)));
const adapter = managedCreateAdapter("kie.jobs", "kie.job_create");
const prepare = body => adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
const textInput = input => ({ ...wire.text, input: { ...wire.text.input, ...input } });
const imageInput = input => ({ ...wire.image, input: { ...wire.image.input, ...input } });
test("registered Kie Wan text preparation keeps native identity and string duration without borrowing Alibaba/fal contracts", () => {
  const prepared = prepare(wire.text);
  assert.deepEqual(prepared.body, wire.text); assert.notEqual(prepared.body, wire.text);
  assert.equal(prepared.requestedVersion, wire.text.model); assert.equal(prepared.headers.has("authorization"), false);
  for (const duration of ["5", "10", "15"]) assert.equal(prepare(textInput({ duration })).body.input.duration, duration);
  for (const duration of [5, "6", "05", null, ["5"]]) assert.throws(() => prepare(textInput({ duration })), /duration/);
  for (const model of ["wan2.6-t2v", "alibaba/wan2.6-t2v", "fal-ai/wan/v2.2-a14b/text-to-video", "wan/2-7-text-to-video"]) {
    assert.throws(() => prepareKieWanWire({ ...wire.text, model }));
  }
});
test("text resolution is explicit and exact; missing image options remain unknown native defaults", () => {
  for (const resolution of ["720p", "1080p"]) assert.equal(prepare(textInput({ resolution })).body.input.resolution, resolution);
  for (const resolution of [undefined, null, "720P", "480p", ["1080p"]]) assert.throws(() => prepare(textInput({ resolution })), /resolution/);
  const image = prepareKieWanWire({ model: wire.image.model, input: { prompt: "Sail", image_urls: wire.image.input.image_urls } });
  assert.equal(image.requestedDurationSeconds, null); assert.equal(image.upstreamCostMicros, null);
  assert.equal(Object.hasOwn(image.body.input, "resolution"), false);
  const text = prepareKieWanWire({ model: wire.text.model, input: { prompt: "Sail", resolution: "720p" } });
  assert.equal(text.requestedDurationSeconds, null);
});
test("native prompt limits and unsupported geometry/audio cannot silently change a paid request", () => {
  assert.equal(prepare(textInput({ prompt: "🦊".repeat(5000) })).body.input.prompt.length, 10000);
  for (const prompt of [" ", "x".repeat(5001), "bad\ud800"]) assert.throws(() => prepare(textInput({ prompt })));
  for (const prompt of ["a", " a "]) assert.throws(() => prepareKieWanWire(imageInput({ prompt })));
  for (const input of [{ aspect_ratio: "16:9" }, { size: "1280x720" }, { sound: false }, { generate_audio: true }, { prompt_extend: true }, { seed: 1 }]) {
    assert.throws(() => prepare(textInput(input)));
  }
  for (const extra of [{ callBackUrl: "https://sink.example/hook" }, { apiKey: "synthetic" }]) assert.throws(() => prepare({ ...wire.text, ...extra }));
});
test("one image URL qualifies only its wire shape; unowned assets and actual image creates stay denied", () => {
  assert.deepEqual(prepareKieWanWire(wire.image).body, wire.image);
  assert.throws(() => prepare(wire.image), /kie_image_binding_required/); assert.equal(wire.imageActivation.enabled, false);
  for (const image_urls of [[], [...wire.image.input.image_urls, ...wire.image.input.image_urls], ["http://assets.example/in.png"],
    ["https://127.0.0.1/in.png"], ["https://host.internal/in.png"], ["https://user:synthetic@assets.example/in.png"], ["data:image/png;base64,AAAA"]]) {
    assert.throws(() => prepareKieWanWire(imageInput({ image_urls })));
  }
  assert.throws(() => prepare(textInput({ image_urls: wire.image.input.image_urls })));
});
test("Wan uses the existing scoped lifecycle; partial output, missing metrics and unavailable observations retain distinct meanings", async () => {
  const context = action => ({ action, requestedVersion: wire.text.model, pathParams: {}, ...(action === "create" ? {} : { expectedId: wire.taskId }) });
  assert.equal((await adapter.read(Response.json(wire.submission), context("create"))).followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.partial), context("retrieve"))).terminal, null);
  const completed = await adapter.read(Response.json(wire.completed), context("retrieve"));
  assert.equal(completed.terminal, "succeeded"); assert.equal(completed.followUp, undefined);
  const noMedia = await adapter.read(Response.json({ code: 200, data: { taskId: wire.taskId, state: "success" } }), context("retrieve"));
  assert.equal(noMedia.terminal, "succeeded");
  await assert.rejects(adapter.read(Response.json(wire.expiredObservation), context("retrieve")));
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
  assert.equal(prepareKieWanWire(wire.text).upstreamCostMicros, null, "synthetic credits do not define a dollar tariff");
});
test("no new cancel, result, remote fetch or automatic create retry path is introduced", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper I/O"); });
  const control = adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {});
  assert.equal(control.query.get("taskId"), wire.taskId); assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  assert.equal(prepare(wire.text).requestedVersion, wire.text.model);
});
