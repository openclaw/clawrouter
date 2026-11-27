import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { falSeedanceModels, prepareFalSeedance } from "../fal-seedance.ts";
import { falManagedAdapter } from "../managed-fal.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/seedance.json", import.meta.url)));
const prepare = (i, changes = {}) => prepareFalSeedance(wire.requests[i].model, { ...wire.requests[i].body, ...changes });
test("six frozen Seedance products retain ordered native fields without model or mode rewriting", () => {
  assert.deepEqual(wire.requests.map(item => item.model), [...falSeedanceModels]);
  for (let i = 0; i < 6; i++) {
    const prepared = prepare(i);
    assert.equal(prepared.path, "/" + wire.requests[i].model); assert.deepEqual(prepared.body, wire.requests[i].body);
    assert.notEqual(prepared.body, wire.requests[i].body); assert.equal(prepared.upstreamCostMicros, null);
  }
  assert.equal(prepare(4).inputFiles, 3); assert.equal(prepare(4).inputBytes, 23);
  assert.throws(() => prepareFalSeedance("bytedance/seedance-2.5/text-to-video", wire.requests[0].body));
});
test("duration is a native 4–15 string while omission preserves auto and unknown cost", () => {
  for (const duration of ["4", "15"]) assert.equal(prepare(0, { duration }).requestedDurationSeconds, Number(duration));
  for (const duration of [4, "3", "16", "04", "4.0", "auto", null, ["4"]]) assert.throws(() => prepare(0, { duration }), /duration/);
  assert.equal(prepare(3).requestedDurationSeconds, null); assert.equal(Object.hasOwn(prepare(3).body, "duration"), false);
});
test("Fast resolution differs from standard; unsupported size and non-scalar geometry fail locally", () => {
  for (const i of [0, 1, 4]) for (const resolution of ["1080p", "4k"]) assert.throws(() => prepare(i, { resolution }), /resolution/);
  for (const resolution of ["480p", "720p", "1080p", "4k"]) assert.equal(prepare(2, { resolution }).body.resolution, resolution);
  for (const changes of [{ resolution: "4K" }, { resolution: ["720p"] }, { aspect_ratio: ["16:9"] }, { aspect_ratio: "2:1" },
    { aspect_ratio: "auto" }, { generate_audio: "false" }, { size: "1280x720" }]) assert.throws(() => prepare(0, changes));
});
test("input mode has explicit image/reference rules without remote URL or upload fallback", () => {
  const image = wire.requests[1].body.image_url;
  assert.throws(() => prepare(0, { image_url: image }));
  for (const image_url of [undefined, "https://assets.example/input.png", "data:image/png;base64,AB==", "data:video/mp4;base64,AAAA"]) assert.throws(() => prepare(1, { image_url }));
  assert.throws(() => prepare(1, { image_urls: [image] }));
  const { image_urls, video_urls, ...audioOnly } = wire.requests[4].body;
  assert.throws(() => prepareFalSeedance(wire.requests[4].model, audioOnly), /audio_only_reference/);
});
test("reference limits apply per modality and across 12 total ordered files", () => {
  const image = wire.requests[1].body.image_url, video = wire.requests[4].body.video_urls[0], audio = wire.requests[4].body.audio_urls[0];
  assert.equal(prepare(4, { image_urls: Array(9).fill(image), video_urls: [video], audio_urls: [audio, audio] }).inputFiles, 12);
  for (const changes of [{ image_urls: Array(10).fill(image) }, { video_urls: Array(4).fill(video) }, { audio_urls: Array(4).fill(audio) },
    { image_urls: Array(9).fill(image), video_urls: Array(3).fill(video), audio_urls: [audio] }]) assert.throws(() => prepare(4, changes));
  assert.deepEqual(prepare(5, { image_urls: [image, "data:image/jpeg;base64,/9j/"] }).body.image_urls, [image, "data:image/jpeg;base64,/9j/"]);
});
test("decoded references have per-file and aggregate byte bounds without treating MIME labels as media proof", () => {
  const data = bytes => "data:video/mp4;base64," + Buffer.alloc(bytes).toString("base64");
  assert.throws(() => prepare(4, { video_urls: [data(8 * 1024 * 1024 + 1)] }), /reference_base64/);
  assert.throws(() => prepare(4, { video_urls: Array(3).fill(data(6 * 1024 * 1024)) }), /reference_limit/);
  assert.equal(wire.qualification.inlineBytesAreSynthetic, true);
});
test("known queue completion remains scoped result readiness and never establishes a dollar tariff", async () => {
  const context = action => ({ action, requestedVersion: wire.requests[0].model,
    pathParams: { owner: "bytedance", app: "seedance-2.0", variant: "fast", subvariant: "text-to-video" },
    ...(action === "create" ? {} : { expectedId: wire.requestId }) });
  assert.equal((await falManagedAdapter.read(Response.json(wire.submit, { status: 202 }), context("create"))).followUp, "retrieve");
  assert.equal((await falManagedAdapter.read(Response.json(wire.running), context("retrieve"))).terminal, null);
  const ready = await falManagedAdapter.read(Response.json(wire.completed), context("retrieve"));
  assert.equal(ready.terminal, null); assert.equal(ready.followUp, "result");
  const terminal = await falManagedAdapter.read(Response.json(wire.result), context("result"));
  assert.equal(terminal.terminal, "succeeded"); assert.equal(terminal.followUp, undefined);
  assert.equal(wire.qualification.upstreamCostMicros, null);
  await assert.rejects(falManagedAdapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
});
