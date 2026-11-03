import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareKieKlingWire } from "../kie-kling.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/kling-video.json", import.meta.url)));
const adapter = managedCreateAdapter("kie.jobs", "kie.job_create");
const prepare = (body = wire.text) => adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller", "idempotency-key": "synthetic-replay" }), {}, new URLSearchParams());
test("the registered jobs adapter validates native Kling text input and preserves selected model and sound", () => {
  const prepared = prepare();
  assert.deepEqual(prepared.body, wire.text); assert.notEqual(prepared.body, wire.text);
  assert.equal(prepared.requestedVersion, wire.text.model); assert.equal(prepared.headers.has("authorization"), false);
  assert.equal(prepared.headers.has("idempotency-key"), false);
  assert.equal(prepare({ ...wire.text, input: { ...wire.text.input, sound: true } }).body.input.sound, true);
  assert.equal(prepareKieKlingWire(wire.text).upstreamCostMicros, null);
});
test("duration/sound/geometry are native scalar values, never rounded, coerced or silently discarded", () => {
  for (const input of [{ duration: 5 }, { duration: "6" }, { duration: null }, { sound: "false" }, { sound: null },
    { aspect_ratio: ["16:9"] }, { resolution: "720p" }, { size: "1280x720" }, { num_images: 2 }]) {
    assert.throws(() => prepare({ ...wire.text, input: { ...wire.text.input, ...input } }));
  }
  const omitted = prepareKieKlingWire({ model: wire.text.model, input: { prompt: "Paper boat" } });
  assert.equal(omitted.requestedDurationSeconds, null); assert.equal(omitted.sound, null);
  assert.deepEqual(omitted.body.input, { prompt: "Paper boat" });
});
test("body extensions, empty/oversized prompts and foreign product identities cannot qualify", () => {
  for (const body of [{ ...wire.text, callBackUrl: "https://sink.example/hook" }, { ...wire.text, apiKey: "synthetic" },
    { ...wire.text, input: { ...wire.text.input, prompt: " " } }, { ...wire.text, input: { ...wire.text.input, prompt: "x".repeat(1001) } },
    { ...wire.text, input: { ...wire.text.input, prompt: "bad\ud800" } }]) assert.throws(() => prepare(body));
  for (const model of ["fal-ai/kling-video/v2.1/master/text-to-video", "kling-3.0/text-to-video"]) assert.throws(() => prepareKieKlingWire({ ...wire.text, model }));
});
test("image wire validation is not upload or caller authority; the actual route remains closed", () => {
  const qualified = prepareKieKlingWire(wire.image);
  assert.equal(qualified.mode, "image"); assert.deepEqual(qualified.body, wire.image);
  assert.equal(qualified.upstreamCostMicros, null); assert.equal(wire.imageActivation.enabled, false);
  assert.throws(() => prepare(wire.image), /kie_image_binding_required/);
  assert.throws(() => prepareKieKlingWire({ ...wire.image, input: { ...wire.image.input, aspect_ratio: "1:1" } }));
});
test("image wire admits exactly one bounded HTTPS reference and rejects inline or unsafe destinations", () => {
  for (const image_urls of [[], [...wire.image.input.image_urls, ...wire.image.input.image_urls],
    ["http://assets.example/in.png"], ["https://127.0.0.1/in.png"], ["https://user:synthetic@assets.example/in.png"],
    ["https://host.internal/in.png"], ["data:image/png;base64,AAAA"]]) assert.throws(() => prepareKieKlingWire({ ...wire.image, input: { ...wire.image.input, image_urls } }));
  assert.throws(() => prepare({ ...wire.text, input: { ...wire.text.input, image_urls: wire.image.input.image_urls } }));
});
test("known terminal jobs stop even without media or metrics; partial URLs do not settle execution", async () => {
  const context = action => ({ action, requestedVersion: wire.text.model, pathParams: {}, ...(action === "create" ? {} : { expectedId: wire.taskId }) });
  assert.equal((await adapter.read(Response.json(wire.submission), context("create"))).followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.partial), context("retrieve"))).terminal, null);
  const success = await adapter.read(Response.json(wire.completed), context("retrieve"));
  assert.equal(success.terminal, "succeeded"); assert.equal(success.followUp, undefined);
  assert.equal((await adapter.read(Response.json(wire.failed), context("retrieve"))).terminal, "failed");
  assert.equal((await adapter.read(Response.json({ code: 200, data: { taskId: wire.taskId, state: "success" } }), context("retrieve"))).terminal, "succeeded");
  assert.equal(prepareKieKlingWire(wire.text).upstreamCostMicros, null, "observed credits do not invent a dollar rate");
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
});
test("only scoped GET observations exist; no cancellation, remote fetch or automatic create replay is introduced", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper I/O"); });
  const control = adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {});
  assert.equal(control.query.get("taskId"), wire.taskId); assert.equal(adapter.supportsCancel, false);
  assert.throws(() => adapter.control("cancel", { method: "DELETE", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {}));
  assert.throws(() => adapter.identify("retrieve", {}, new URLSearchParams("taskId=a&taskId=b")));
  assert.equal(prepare().requestedVersion, wire.text.model);
});
