import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { xaiVideoProtocol, xaiVideoModels, prepareXaiVideo, prepareXaiVideoControl, readXaiVideo } = await import("../xai-video.ts");
const { responsesControls } = await import("../responses-lifecycle.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/video.json", import.meta.url), "utf8"));
const existing = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
const modes = [["generate", "generations"], ["edit", "edits"], ["extend", "extensions"]];
function fixture() {
  const manifest = structuredClone(existing);
  for (const [mode, path] of modes) {
    manifest.capabilities.push({ id: "media.predict", endpoint: mode, methods: ["POST"] });
    manifest.endpoints[mode] = { path: `/v1/videos/${path}`, requestFormat: `xai.video_${mode}`, responseFormat: "xai.video",
      lifecycle: { protocol: "xai.video", retrieve: "video_get" } };
  }
  manifest.endpoints.video_get = { method: "GET", path: "/v1/videos/${request_id}", pathParams: ["request_id"],
    requestFormat: "xai.video_get", responseFormat: "xai.video" };
  return manifest;
}
const endpoint = (provider, id) => provider.endpoints.find(row => row.id === id);

test("xAI video declarations compose with all published native create modes without changing Chat offers or prices", () => {
  const original = compile(existing), snapshot = compile(fixture()), provider = snapshot.providers[0];
  assert.deepEqual(snapshot.model_index, original.model_index);
  assert.deepEqual(snapshot.capability_index["llm.chat"], original.capability_index["llm.chat"]);
  assert.deepEqual(endpoint(provider, "chat_completions"), endpoint(original.providers[0], "chat_completions"));
  assert.equal(snapshot.capability_index["media.prediction.read"], undefined);
  for (const [mode, body] of [["generate", wire.generate], ["generate", wire.image], ["edit", wire.edit], ["extend", wire.extend]]) {
    const create = endpoint(provider, mode), prepared = prepareXaiVideo(body.model, mode, body, wire.idempotencyKey);
    assert.equal(create.request_format, `xai.video_${mode}`); assert.equal(create.response_format, "xai.video");
    assert.equal(create.method, "POST"); assert.equal(create.path, prepared.path);
    assert.deepEqual(create.lifecycle, { protocol: xaiVideoProtocol, retrieve: "video_get" });
    assert.deepEqual(prepared.body, body); assert.equal(prepared.requestedVersion, body.model);
    assert.equal(prepared.headers.get("x-idempotency-key"), wire.idempotencyKey); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(create.requestPricing, undefined); assert.equal(create.modelPassthrough, undefined);
  }
});

test("three xAI creates retain every original-owner candidate on the single declared retrieve route", () => {
  const provider = compile(fixture()).providers[0], control = endpoint(provider, "video_get");
  assert.deepEqual(responsesControls(provider, control).map(row => [row.create.id, row.action, row.protocol]),
    [["edit", "retrieve", "xai.video"], ["extend", "retrieve", "xai.video"], ["generate", "retrieve", "xai.video"]]);
  assert.equal(provider.capabilities.some(row => row.endpoint === "video_get"), false);
  const target = prepareXaiVideoControl("retrieve", wire.id);
  assert.equal(control.method, target.method);
  assert.equal(control.path.replace("${request_id}", wire.id), target.path);
  assert.equal(target.query.size, 0); assert.equal(target.headers.has("authorization"), false);
  for (const action of ["cancel", "result"]) assert.throws(() => prepareXaiVideoControl(action, wire.id));
  for (const id of ["..", "../other", "%2fother", "id?key=synthetic", "https://example.com/job"]) assert.throws(() => prepareXaiVideoControl("retrieve", id));
  // Candidate preservation is not durable controller/registry execution proof.
});

test("compiled xAI modes preserve bound empty-202, filtered and expired observations without inventing a charge", async () => {
  const provider = compile(fixture()).providers[0];
  for (const [mode] of modes) {
    const create = endpoint(provider, mode), model = prepareXaiVideo(wire[mode].model, mode, wire[mode]).requestedVersion;
    assert.equal(create.lifecycle.protocol, xaiVideoProtocol);
    const read = (response, action = "retrieve") => readXaiVideo(response, action, model, action === "create" ? undefined : wire.id, new AbortController().signal);
    const created = await read(Response.json(wire.created), "create");
    assert.equal(created.id, wire.id); assert.equal(created.followUp, "retrieve");
    const pending = await read(new Response(null, { status: 202 }));
    assert.equal(pending.id, wire.id); assert.equal(pending.terminal, null);
    for (const [body, terminal, delivery] of [[wire.done, "succeeded", "available"], [wire.filtered, "succeeded", "filtered"], [wire.failed, "failed", "unavailable"], [wire.expired, null, "unavailable"]]) {
      const observed = await read(Response.json(body));
      assert.equal(observed.terminal, terminal); assert.equal(observed.delivery, delivery); assert.equal(observed.upstreamCostMicros, null);
      assert.equal(observed.followUp, undefined);
      if (body === wire.expired) assert.equal(observed.observationUnavailable, "expired_or_unknown");
    }
    await assert.rejects(read(Response.json({ ...wire.done, request_id: "foreign" })));
    await assert.rejects(read(Response.json({ ...wire.done, model: wire.image.model })));
  }
});

test("xAI lifecycle declarations reject unbound controls, format aliases and unsupported action or path expansion", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { delete m.endpoints.generate.lifecycle; },
    m => { delete m.endpoints.generate.lifecycle.retrieve; }, m => { m.endpoints.generate.lifecycle.cancel = "video_get"; },
    m => { m.endpoints.generate.lifecycle.result = "video_get"; }, m => { m.endpoints.generate.lifecycle.files = { metadata: "video_get", download: "video_get" }; },
    m => { m.endpoints.generate.lifecycle.retrieve = "constructor"; }, m => { m.endpoints.edit.lifecycle.protocol = "together.video"; },
    m => { m.endpoints.edit.requestFormat = "xai.video_generate"; }, m => { m.endpoints.extend.path += "/more"; },
    m => { m.endpoints.video_get.path = "/v1/videos/${request_id}/cancel"; }, m => { m.endpoints.video_get.method = "POST"; },
    m => { m.endpoints.video_get.pathParamStyles = { request_id: "relative_path" }; }, m => { m.endpoints.video_get.pathParams.push("model"); },
    m => { m.endpoints.orphan = structuredClone(m.endpoints.video_get); },
    m => { m.endpoints.orphan = { path: "/v1/raw", requestFormat: "xai.video_raw", responseFormat: "other" }; },
    m => { m.endpoints.orphan = { path: "/v1/videos/raw", requestFormat: "other", responseFormat: "other" }; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "video_get", methods: ["GET"] }); },
    m => { m.capabilities.find(row => row.endpoint === "generate").methods = ["GET"]; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change)); }
});

test("xAI video links cannot alter original origin, credentials, per-control headers or cost units", () => {
  const changes = [
    m => { m.baseUrls.default = "https://api.x.ai/v1"; }, m => { m.baseUrls.other = "https://api.openrouter.ai"; },
    m => { m.auth.schemes[0].format = "Key ${secret}"; }, m => { m.auth.schemes[0].header = "X-API-Key"; },
    m => { m.auth.schemes[0].secretKind = "oauth"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "Bearer synthetic" } } }; },
    m => { m.adapter.injectHeaders = { Authorization: "Bearer synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["Authorization"]; },
  ];
  for (const id of ["generate", "edit", "extend", "video_get"]) changes.push(
    m => { m.endpoints[id].auth = "none"; }, m => { m.endpoints[id].requestHeaders = ["x-idempotency-key"]; },
    m => { m.endpoints[id].headers = { Authorization: "Bearer synthetic" }; }, m => { m.endpoints[id].query = { request_id: "foreign" }; },
    m => { m.endpoints[id].modelPassthrough = {}; }, m => { m.endpoints[id].streaming = "sse"; },
    m => { m.endpoints[id].nativeProxy = false; }, m => { m.endpoints[id].outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.endpoints[id].requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03",
      source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
      maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" }; });
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change)); }
});

test("finite xAI video cards remain explicitly unpriced and cannot inherit Chat pricing or unqualified aliases", () => {
  const manifest = fixture();
  manifest.models.entries.push(...xaiVideoModels.map(upstream => ({ id: `xai/${upstream}`, upstream, capabilities: ["media.predict"] })));
  const snapshot = compile(manifest);
  for (const upstream of xaiVideoModels) {
    const row = snapshot.model_index[`xai/${upstream}`];
    assert.equal(row.pricing, null); assert.equal(row.pricing_ref, null); assert.deepEqual(row.capabilities, ["media.predict"]);
  }
  for (const change of [
    m => { m.upstream = "grok-imagine-video-1.5-preview"; }, m => { m.upstream = "grok-imagine-video-1.5-2026-05-30"; },
    m => { m.capabilities.push("llm.chat"); }, m => { m.pricingRef = "borrowed-chat-rate"; },
    m => { m.pricing = structuredClone(existing.models.entries[0].pricing); },
    m => { m.endpointPricing = { generate: { pricingRef: "borrowed-chat-rate", pricing: structuredClone(existing.models.entries[0].pricing) } }; },
  ]) { const invalid = structuredClone(manifest); change(invalid.models.entries.at(-1)); assert.throws(() => compile(invalid), /lifecycle|invalid manifest/, String(change)); }
});
