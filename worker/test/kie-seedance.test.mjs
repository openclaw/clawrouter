import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KIE_SEEDANCE_FROZEN_MODEL, prepareKieSeedanceFrozenWire } from "../kie-seedance.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/seedance-frozen-video.json", import.meta.url)));
const adapter = managedCreateAdapter("kie.jobs", "kie.job_create");
const input = (extra, image = false) => { const body = image ? wire.image : wire.text; return { ...body, input: { ...body.input, ...extra } }; };
test("frozen compatibility keeps exact Kie identity and independent native numeric/boolean fields", () => {
  for (const body of [wire.text, wire.image]) {
    const prepared = prepareKieSeedanceFrozenWire(body);
    assert.deepEqual(prepared.body, body); assert.notEqual(prepared.body, body);
    assert.equal(prepared.model, KIE_SEEDANCE_FROZEN_MODEL); assert.equal(prepared.upstreamCostMicros, null);
  }
  for (let duration = 4; duration <= 12; duration++) assert.equal(prepareKieSeedanceFrozenWire(input({ duration })).requestedDurationSeconds, duration);
  for (const duration of [undefined, "4", 3, 13, 4.5, NaN, null]) assert.throws(() => prepareKieSeedanceFrozenWire(input({ duration })), /duration/);
  for (const generate_audio of [undefined, 0, "false", null]) assert.throws(() => prepareKieSeedanceFrozenWire(input({ generate_audio })), /generate_audio/);
});
test("frozen geometry and prompt bounds do not inherit newer product capabilities", () => {
  for (const aspect_ratio of ["16:9", "1:1", "4:3", "3:4", "9:16", "21:9"]) assert.equal(prepareKieSeedanceFrozenWire(input({ aspect_ratio })).body.input.aspect_ratio, aspect_ratio);
  for (const resolution of ["480p", "720p", "1080p"]) assert.equal(prepareKieSeedanceFrozenWire(input({ resolution })).body.input.resolution, resolution);
  for (const extra of [{ aspect_ratio: "adaptive" }, { resolution: "4k" }, { resolution: "720P" }, { fixed_lens: false }, { return_last_frame: true }]) assert.throws(() => prepareKieSeedanceFrozenWire(input(extra)));
  assert.equal(prepareKieSeedanceFrozenWire(input({ prompt: "🦊".repeat(10000) })).body.input.prompt.length, 20000);
  for (const prompt of ["hi", "  a  ", "x".repeat(20001), "bad\ud800"]) assert.throws(() => prepareKieSeedanceFrozenWire(input({ prompt })));
  for (const model of ["bytedance/seedance-2-5", "bytedance/seedance-2.0", "fal-ai/bytedance/seedance-1.5-pro/text-to-video"]) assert.throws(() => prepareKieSeedanceFrozenWire({ ...wire.text, model }));
});
test("only the frozen single image reference is represented, without asset authority", () => {
  assert.equal(prepareKieSeedanceFrozenWire(wire.image).mode, "image"); assert.equal(prepareKieSeedanceFrozenWire(wire.text).mode, "text");
  for (const input_urls of [[], [...wire.image.input.input_urls, ...wire.image.input.input_urls], "https://assets.example/in.png", ["http://assets.example/in.png"], ["https://host.internal/in.png"], ["https://user:synthetic@assets.example/in.png"], ["data:image/png;base64,AAAA"]]) assert.throws(() => prepareKieSeedanceFrozenWire(input({ input_urls }, true)));
});
test("actual managed preparation denies both creates without rewriting the selected model or attempting I/O", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected egress"); });
  for (const body of [wire.text, wire.image]) {
    const original = structuredClone(body);
    assert.throws(() => adapter.prepare(body, new Headers(), {}, new URLSearchParams()), /kie_seedance_native_contract_unqualified/);
    assert.deepEqual(body, original);
  }
  assert.equal(wire.qualification.retirementEstablished, false); assert.equal(wire.qualification.aliasEstablished, false);
});
test("create qualification cannot strand an original scoped job or turn absent metrics into free generation", async () => {
  const context = { action: "retrieve", requestedVersion: KIE_SEEDANCE_FROZEN_MODEL, expectedId: wire.taskId, pathParams: {} };
  const control = adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/recordInfo" }, wire.taskId, {});
  assert.equal(control.query.get("taskId"), wire.taskId);
  assert.equal((await adapter.read(Response.json(wire.pending), context)).terminal, null);
  assert.equal((await adapter.read(Response.json(wire.completed), context)).terminal, "succeeded");
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context, expectedId: "foreign_job" }));
  assert.equal(prepareKieSeedanceFrozenWire(wire.text).upstreamCostMicros, null);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
});
