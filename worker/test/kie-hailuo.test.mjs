import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { kieHailuoModels, prepareKieHailuoWire } from "../kie-hailuo.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/hailuo-video.json", import.meta.url)));
const adapter = managedCreateAdapter("kie.jobs", "kie.job_create");
const prepare = body => adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
const withInput = (index, input) => ({ ...wire.requests[index], input: { ...wire.requests[index].input, ...input } });

test("both registered Hailuo text routes preserve exact native identity and settings", () => {
  assert.deepEqual(kieHailuoModels, wire.requests.map(body => body.model));
  for (const index of [0, 2]) {
    const result = prepare(wire.requests[index]);
    assert.deepEqual(result.body, wire.requests[index]); assert.notEqual(result.body, wire.requests[index]);
    assert.equal(result.requestedVersion, wire.requests[index].model); assert.equal(result.headers.has("authorization"), false);
  }
  for (const model of ["MiniMax-Hailuo-02", "fal-ai/minimax/hailuo-02/standard/text-to-video", "hailuo/2-4-text-to-video-pro"])
    assert.throws(() => prepareKieHailuoWire({ ...wire.requests[0], model }));
});
test("required string durations and exact resolution combinations cannot be defaulted or rounded", () => {
  for (const index of [0, 1, 4, 5]) {
    for (const duration of ["6", "10"]) {
      const input = { duration, ...(index >= 4 ? { resolution: "768P" } : {}) };
      assert.equal(prepareKieHailuoWire(withInput(index, input)).requestedDurationSeconds, Number(duration));
    }
    for (const duration of [undefined, null, 6, "06", "5", "6.0", ["6"]]) assert.throws(() => prepareKieHailuoWire(withInput(index, { duration })), /duration/);
  }
  for (const index of [1, 4, 5]) {
    for (const resolution of [undefined, null, "768p", "720P", ["768P"]]) assert.throws(() => prepareKieHailuoWire(withInput(index, { resolution })), /resolution/);
  }
  for (const index of [4, 5]) {
    assert.equal(prepareKieHailuoWire(withInput(index, { duration: "6", resolution: "1080P" })).requestedDurationSeconds, 6);
    assert.throws(() => prepareKieHailuoWire(withInput(index, { duration: "10", resolution: "1080P" })), /duration_resolution/);
    assert.throws(() => prepareKieHailuoWire(withInput(index, { resolution: "512P" })), /resolution/);
  }
  assert.throws(() => prepareKieHailuoWire(withInput(1, { resolution: "1080P" })), /resolution/);
});
test("Pro 02 omitted settings do not become caller controls, measured duration or a price", () => {
  for (const index of [2, 3]) {
    const result = prepareKieHailuoWire(wire.requests[index]);
    assert.equal(result.requestedDurationSeconds, null); assert.equal(result.upstreamCostMicros, null);
    assert.equal(Object.hasOwn(result.body.input, "duration"), false); assert.equal(Object.hasOwn(result.body.input, "resolution"), false);
    for (const extra of [{ duration: "6" }, { resolution: "1080P" }]) assert.throws(() => prepareKieHailuoWire(withInput(index, extra)));
  }
});
test("family prompt bounds and frozen settings reject invalid paid requests before dispatch", () => {
  for (let index = 0; index < wire.requests.length; index++) {
    const limit = index >= 4 ? 5000 : 1500;
    assert.equal(prepareKieHailuoWire(withInput(index, { prompt: "🦊".repeat(limit) })).body.input.prompt.length, limit * 2);
    for (const prompt of [" ", "x".repeat(limit + 1), "bad\udfff"]) assert.throws(() => prepareKieHailuoWire(withInput(index, { prompt })));
    for (const extra of [{ prompt_optimizer: true }, { end_image_url: "https://assets.example/end.png" }, { sound: false }, { aspect_ratio: "16:9" }, { seed: 1 }])
      assert.throws(() => prepareKieHailuoWire(withInput(index, extra)));
  }
  assert.throws(() => prepare({ ...wire.requests[0], callBackUrl: "https://sink.example/hook" }), /polling_only/);
  assert.throws(() => prepare({ ...wire.requests[0], token: "synthetic" }));
  assert.throws(() => prepare(withInput(0, { resolution: "768P" })));
});
test("all four image wires stay closed in the real managed preparation path", () => {
  for (const index of [1, 3, 4, 5]) {
    assert.deepEqual(prepareKieHailuoWire(wire.requests[index]).body, wire.requests[index]);
    assert.throws(() => prepare(wire.requests[index]), /kie_image_binding_required/);
    for (const image_url of [undefined, ["https://assets.example/in.png"], "http://assets.example/in.png", "https://127.0.0.1/in.png",
      "https://host.internal/in.png", "https://user:synthetic@assets.example/in.png", "data:image/png;base64,AAAA"])
      assert.throws(() => prepareKieHailuoWire(withInput(index, { image_url })));
  }
  assert.equal(wire.imageActivation.enabled, false);
  assert.throws(() => prepare(withInput(0, { image_url: "https://assets.example/in.png" })));
});
test("partial output, terminal failure without metrics and lost visibility remain distinct", async () => {
  const context = action => ({ action, requestedVersion: wire.requests[0].model, pathParams: {}, ...(action === "create" ? {} : { expectedId: wire.taskId }) });
  assert.equal((await adapter.read(Response.json(wire.submission), context("create"))).followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.partial), context("retrieve"))).terminal, null);
  for (const [native, terminal] of [[wire.completed, "succeeded"], [wire.failed, "failed"]]) {
    const observed = await adapter.read(Response.json(native), context("retrieve"));
    assert.equal(observed.terminal, terminal); assert.equal(observed.followUp, undefined);
  }
  await assert.rejects(adapter.read(Response.json(wire.unavailable), context("retrieve")));
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
  assert.equal(prepareKieHailuoWire(wire.requests[0]).upstreamCostMicros, null);
});
test("Hailuo uses existing scoped retrieval without new cancellation, result fetch or POST replay", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper I/O"); });
  const control = adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {});
  assert.equal(control.query.get("taskId"), wire.taskId); assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  assert.equal(prepare(wire.requests[0]).requestedVersion, wire.requests[0].model);
});
