import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareVydraModel, observeVydraModel, readVydraModel } from "../vydra-models.ts";
import { vydraModelVideoAdapter as adapter } from "../managed-vydra-models.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/vydra/models.json", import.meta.url)));
const prepare = name => prepareVydraModel(wire.requests[name].model, wire.requests[name].body);
const video = prepare("video"), image = prepare("image"), speech = prepare("speech");
const observe = value => observeVydraModel(value, video, "retrieve", wire.completed.id);
const context = { action: "retrieve", expectedId: wire.completed.id, requestedVersion: "veo3", pathParams: { model: "veo3" } };

test("four frozen Models routes preserve native fields and keep speech separate from direct ElevenLabs", () => {
  for (const name of Object.keys(wire.requests)) {
    const prepared = prepare(name);
    assert.equal(prepared.path, "/api/v1/models/" + wire.requests[name].model);
    assert.deepEqual(prepared.body, wire.requests[name].body); assert.notEqual(prepared.body, wire.requests[name].body);
    assert.equal(prepared.headers.has("authorization"), false);
  }
  assert.equal(speech.kind, "audio"); assert.equal(image.kind, "image");
  assert.throws(() => prepareVydraModel("new-model", {}));
  assert.throws(() => prepareVydraModel("grok-imagine", { prompt: "fixture", model: "text-to-video" }));
});

test("bounded request validation rejects callbacks, unrelated options, broken Unicode and the legacy Kling image-as-video mismatch", () => {
  for (const body of [{ ...video.body, webhookUrl: "https://sink.example/hook" }, { prompt: "x".repeat(2001) }, { prompt: "\ud800" }, { prompt: " " }, { ...video.body, duration: "10" }]) {
    assert.throws(() => prepareVydraModel("veo3", body));
  }
  const kling = wire.requests.kling.body;
  assert.throws(() => prepareVydraModel("kling", { ...kling, video_url: kling.image_url }), /motion_reference/);
  for (const image_url of ["http://assets.example/image.png", "https://127.0.0.1/a", "https://user:secret@assets.example/a", "https://assets.example/a#secret"]) {
    assert.throws(() => prepareVydraModel("kling", { ...kling, image_url }));
  }
  assert.throws(() => prepareVydraModel("elevenlabs/tts", { ...speech.body, text: "x".repeat(10001) }));
});

test("202 native jobId is bounded, not confused with externalJobId or an authorization grant", async () => {
  const observed = await readVydraModel(Response.json(wire.submitted, { status: 202 }), video, "create", new AbortController().signal);
  assert.equal(observed.id, wire.completed.id); assert.equal(observed.terminal, null); assert.equal(observed.upstreamCostMicros, null);
  for (const body of [{ ...wire.submitted, id: "another" }, { ...wire.submitted, jobId: "../foreign" }, { status: "pending", externalJobId: "fixture" }]) {
    assert.throws(() => observeVydraModel(body, video, "create"));
  }
  assert.throws(() => observe({ ...wire.completed, id: "foreign" }), /identity/);
  assert.throws(() => observe({ ...wire.completed, model: "kling" }), /model/);
});

test("partial URLs do not terminate polling; completed, failed and cancelled jobs stop without inventing free usage", () => {
  assert.equal(observe(wire.partial).terminal, null); assert.deepEqual(observe(wire.partial).assets, []);
  for (const [key, terminal] of [["completed", "succeeded"], ["failed", "failed"], ["canceled", "canceled"]]) {
    const result = observe(wire[key]);
    assert.equal(result.terminal, terminal); assert.equal(result.upstreamCostMicros, null);
  }
  assert.equal(observe(wire.failed).chargedLedgerUnits, null); assert.equal(observe(wire.failed).refundedLedgerUnits, 50);
  assert.equal(observe(wire.canceled).refundedLedgerUnits, null);
  assert.equal(observe({ id: wire.completed.id, status: "completed" }).terminal, "succeeded");
  for (const status of ["unknown", "error", "COMPLETED", 1]) assert.throws(() => observe({ ...wire.completed, status }));
});

test("synchronous image and speech results need no invented job, deduplicate URLs and expose no provider headers", () => {
  const result = observeVydraModel(wire.image, image, "create");
  assert.equal(result.assets.length, 1); assert.equal(result.terminal, "succeeded");
  const audio = observeVydraModel(wire.speech, speech, "create");
  assert.equal(audio.id, undefined); assert.equal(audio.assets[0].kind, "audio");
  assert.equal(audio.assets[0].headers, undefined); assert.equal(audio.upstreamCostMicros, null);
  assert.throws(() => observeVydraModel({ status: "completed" }, image, "create"), /missing_output/);
  assert.throws(() => observeVydraModel({ ...wire.speech, status: "pending" }, speech, "create"), /job_id/);
});

test("output scanning is bounded and result URLs never become arbitrary authenticated fetches", () => {
  for (const url of ["http://assets.example/a", "https://127.0.0.1/a", "https://host.internal/a", "https://user:secret@assets.example/a", "file:///tmp/a"]) {
    assert.throws(() => observeVydraModel({ imageUrl: url }, image, "create"));
  }
  assert.throws(() => observeVydraModel({ resultUrls: Array.from({ length: 9 }, (_, i) => "https://assets.example/" + i) }, image, "create"), /output_limit/);
  let nested = { imageUrl: "https://assets.example/image.png" };
  for (let i = 0; i < 7; i++) nested = { data: nested };
  assert.throws(() => observeVydraModel(nested, image, "create"), /output_limit/);
  assert.throws(() => observeVydraModel({ _links: { self: "https://assets.example/authority" } }, image, "create"), /missing_output/);
});

test("native ledger evidence remains independent from unknown dollar costs and fixed-policy charges", () => {
  for (const creditsCharged of [-1, 0.5, "50", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => observe({ ...wire.completed, creditsCharged }));
  const zero = observe({ ...wire.completed, creditsCharged: 0 });
  assert.equal(zero.chargedLedgerUnits, 0); assert.equal(zero.upstreamCostMicros, null);
  assert.equal(zero.policyFixedCostMicros, undefined);
});

test("strict transport rejects truncation, partial response, redirects, invalid MIME and canceled delivery", async () => {
  const text = JSON.stringify(wire.completed);
  for (const response of [
    new Response(text, { status: 206, headers: { "content-type": "application/json" } }),
    Response.json(wire.completed, { headers: { "content-range": "bytes 0-1/3" } }),
    Response.json(wire.completed, { headers: { "content-length": "9999" } }),
    new Response(text), new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
  ]) await assert.rejects(readVydraModel(response, video, "retrieve", new AbortController().signal, wire.completed.id));
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(readVydraModel(Response.json(wire.completed), video, "retrieve", cancel.signal, wire.completed.id));
  await assert.rejects(readVydraModel(Response.json(wire.image, { status: 202 }), image, "create", new AbortController().signal));
});

test("actual managed wrapper prepares the original Models route and only its bound GET control", async () => {
  const prepared = adapter.prepare(video.body, new Headers({ authorization: "Bearer synthetic-caller" }), { model: "veo3" }, new URLSearchParams());
  assert.equal(prepared.requestedVersion, "veo3"); assert.equal(prepared.headers.has("authorization"), false);
  assert.equal(adapter.protocol, "vydra.jobs"); assert.equal(adapter.supportsCancel, false);
  assert.deepEqual(adapter.control("retrieve", { method: "GET", path: "/api/v1/jobs/${job_id}" }, wire.completed.id, prepared.pathParams),
    { path: wire.wire.retrievePath, query: new URLSearchParams() });
  const observed = await adapter.read(Response.json(wire.completed), context);
  assert.equal(observed.terminal, "succeeded"); assert.equal(observed.actualCostMicros, undefined);
  const body = adapter.rewrite({ ...observed, body: { ...observed.body, _links: { cancel: "https://other.example" } } }, { retrieve: "/v1/native/vydra/api/v1/jobs/fixture_video_1" });
  assert.equal(body._links, undefined); assert.equal(body.output.videoUrl, wire.completed.output.videoUrl);
});

test("managed wrapper rejects model/route rebinding, unsupported cancellation and invalid original-grant dispatch", async () => {
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context, requestedVersion: "kling" }), /original_model/);
  assert.throws(() => adapter.control("cancel", { method: "DELETE", path: "/api/v1/jobs/${job_id}" }, wire.completed.id, context.pathParams));
  assert.throws(() => adapter.identify("retrieve", { job_id: wire.completed.id }, new URLSearchParams("key=synthetic")));
  assert.throws(() => adapter.rewrite({ body: wire.completed }, {}));
  const request = (url, method = "GET", auth = "Bearer synthetic-original") => new Request(url, { method, headers: { authorization: auth, "content-type": "application/json" } });
  adapter.assertDispatch(request("https://www.vydra.ai" + video.path, "POST"));
  adapter.assertDispatch(request("https://www.vydra.ai" + wire.wire.retrievePath));
  for (const req of [
    request("https://other.example" + video.path, "POST"), request("https://www.vydra.ai/api/v1/jobs", "POST"),
    request("https://www.vydra.ai" + wire.wire.retrievePath, "DELETE"),
    request("https://www.vydra.ai" + wire.wire.retrievePath + "?key=synthetic"),
    request("https://www.vydra.ai" + wire.wire.retrievePath, "GET", "Basic synthetic"),
  ]) assert.throws(() => adapter.assertDispatch(req));
});
