import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { openRouterVideoProtocol, prepareOpenRouterVideo, prepareOpenRouterVideoControl,
  observeOpenRouterVideo, prepareOpenRouterVideoContent, readOpenRouterVideoContent } = await import("../openrouter-video.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/video.json", import.meta.url), "utf8"));
const bundled = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
const endpoint = (provider, id) => provider.endpoints.find(row => row.id === id);
function fixture() {
  const manifest = structuredClone(bundled);
  manifest.capabilities.push({ id: "media.predict", endpoint: "video", methods: ["POST"] });
  Object.assign(manifest.endpoints, {
    video: { path: "/v1/videos", requestFormat: "openrouter.video_create", responseFormat: "openrouter.video",
      lifecycle: { protocol: "openrouter.video", retrieve: "video_get", files: { mode: "download_only", download: "video_content" } } },
    video_get: { method: "GET", path: "/v1/videos/${video_id}", pathParams: ["video_id"],
      requestFormat: "openrouter.video_get", responseFormat: "openrouter.video" },
    video_content: { method: "GET", path: "/v1/videos/${video_id}/content", pathParams: ["video_id"], query: { index: "0" },
      requestFormat: "openrouter.video_content", responseFormat: "openrouter.video_content" },
  });
  return manifest;
}

test("OpenRouter compiled links match native create, original-job polling and distinct download-only content", () => {
  const source = fixture(), snapshot = compile(source), provider = snapshot.providers[0], baseline = compile(bundled);
  assert.deepEqual(snapshot.model_index, baseline.model_index);
  for (const original of baseline.providers[0].endpoints) assert.deepEqual(endpoint(provider, original.id), original);
  for (const capability of ["llm.chat", "llm.responses"]) assert.deepEqual(snapshot.capability_index[capability], baseline.capability_index[capability]);
  const create = endpoint(provider, "video"), get = endpoint(provider, "video_get"), content = endpoint(provider, "video_content");
  assert.equal(create.lifecycle.protocol, openRouterVideoProtocol);
  assert.deepEqual(create.lifecycle.files, { mode: "download_only", download: "video_content" });
  assert.equal(create.lifecycle.files.metadata, undefined);
  assert.equal(create.lifecycle.cancel, undefined); assert.equal(create.lifecycle.result, undefined);
  const prepared = prepareOpenRouterVideo(wire.create.model, wire.create, { retentionAllowed: true });
  assert.equal(`${provider.base_urls.default}${create.path}`, `https://openrouter.ai${prepared.path}`);
  assert.deepEqual(prepared.body, wire.create); assert.equal(prepared.requestedVersion, wire.create.model);
  assert.equal(prepared.headers.has("authorization"), false);
  const poll = prepareOpenRouterVideoControl("retrieve", wire.id);
  assert.equal(`${provider.base_urls.default}${get.path.replace("${video_id}", wire.id)}`, `https://openrouter.ai${poll.path}`);
  const observed = observeOpenRouterVideo(wire.completed, "retrieve", wire.create.model, wire.id);
  const target = prepareOpenRouterVideoContent(observed, wire.id);
  assert.equal(`${provider.base_urls.default}${content.path.replace("${video_id}", wire.id)}`, `https://openrouter.ai${target.path}`);
  assert.deepEqual([...new URLSearchParams(content.query)], [...target.query]);
  assert.deepEqual([...target.query], [["index", "0"]]);
  assert.ok(!provider.capabilities.some(row => [get.id, content.id].includes(row.endpoint)));
  assert.equal(content.request_format, "openrouter.video_content"); assert.equal(content.response_format, "openrouter.video_content");
  assert.equal(content.requestPricing, undefined); assert.equal(create.modelPassthrough, undefined);
});

test("OpenRouter content preparation requires its succeeded original observation, never a returned URL or free expiry", async () => {
  const model = wire.create.model, completed = observeOpenRouterVideo(wire.completed, "retrieve", model, wire.id);
  assert.equal(completed.terminal, "succeeded"); assert.equal(completed.upstreamCostMicros, null);
  assert.throws(() => prepareOpenRouterVideoContent(completed, "other-job"));
  for (const body of [wire.accepted, wire.running, wire.failed, wire.cancelled, wire.expired]) {
    const observed = observeOpenRouterVideo(body, "retrieve", model, wire.id);
    assert.throws(() => prepareOpenRouterVideoContent(observed, wire.id));
    assert.equal(observed.upstreamCostMicros, null);
    if (body === wire.expired) { assert.equal(observed.terminal, null); assert.equal(observed.observationUnavailable, "expired_or_unknown"); }
  }
  const withoutUrl = { ...wire.completed }; delete withoutUrl.unsigned_urls;
  assert.deepEqual(prepareOpenRouterVideoContent(observeOpenRouterVideo(withoutUrl, "retrieve", model, wire.id), wire.id),
    prepareOpenRouterVideoContent(completed, wire.id));
  assert.throws(() => observeOpenRouterVideo({ ...wire.completed, unsigned_urls: ["https://other.example/content"] }, "retrieve", model, wire.id));
  assert.throws(() => prepareOpenRouterVideoControl("cancel", wire.id));
  for (const id of ["..", "../foreign", "%2Fforeign", "id?index=1", "https://example.com/video"]) assert.throws(() => prepareOpenRouterVideoControl("retrieve", id));
  const bytes = Buffer.from(wire.content.base64, "base64");
  const content = await readOpenRouterVideoContent(new Response(bytes, { headers: { "content-type": wire.content.mimeType,
    "content-length": String(bytes.length) } }), new AbortController().signal);
  assert.deepEqual(content.video, new Uint8Array(bytes)); assert.equal(content.mimeType, wire.content.mimeType);
  assert.equal(content.upstreamCostMicros, null);
  await assert.rejects(readOpenRouterVideoContent(new Response(bytes, { headers: { "content-type": wire.content.mimeType,
    "content-length": String(bytes.length + 1) } }), new AbortController().signal));
  // Codec composition is not a registered wrapper or durable delivery proof.
});

test("OpenRouter rejects missing download mode, fake metadata, unsupported controls and unbound content routes", () => {
  const changes = [
    m => { m.id = "other"; }, m => { delete m.endpoints.video.lifecycle; },
    m => { delete m.endpoints.video.lifecycle.files; }, m => { delete m.endpoints.video.lifecycle.files.mode; },
    m => { m.endpoints.video.lifecycle.files.mode = "metadata"; }, m => { m.endpoints.video.lifecycle.files.metadata = "video_get"; },
    m => { m.endpoints.video.lifecycle.files.maxBytes = 64 * 1024 * 1024; }, m => { m.endpoints.video.lifecycle.files.mimeType = "video/mp4"; },
    m => { m.endpoints.video.lifecycle.files.download = "video_get"; }, m => { m.endpoints.video.lifecycle.retrieve = "video_content"; },
    m => { m.endpoints.video.lifecycle.cancel = "video_get"; }, m => { m.endpoints.video.lifecycle.result = "video_content"; },
    m => { delete m.endpoints.video_content; }, m => { m.endpoints.video_content.query.index = "1"; },
    m => { m.endpoints.video_content.query.url = "https://other.example/content"; }, m => { delete m.endpoints.video_content.query; },
    m => { m.endpoints.video_content.path = "/v1/videos/${video_id}/content?index=0"; },
    m => { m.endpoints.video_content.pathParamStyles = { video_id: "relative_path" }; },
    m => { m.endpoints.video_content.pathParams = ["request_id"]; }, m => { m.endpoints.video_content.method = "POST"; },
    m => { m.endpoints.video_get.query = { index: "0" }; }, m => { m.endpoints.video.path = "/api/v1/videos"; },
    m => { m.endpoints.video.query = { store: "true" }; }, m => { m.endpoints.orphan = { ...m.endpoints.video_content }; },
    m => { m.endpoints.orphan = { path: "/v1/videos/raw", requestFormat: "openai.responses", responseFormat: "openai.responses" }; },
    m => { m.endpoints.orphan = { path: "/other", requestFormat: "openrouter.video_raw", responseFormat: "other" }; },
  ];
  for (const id of ["video", "video_get", "video_content"]) {
    changes.push(m => { m.endpoints[id].responseFormat = "openai.responses"; }, m => { m.endpoints[id].modelPassthrough = {}; },
      m => { m.endpoints[id].nativeProxy = false; }, m => { m.endpoints[id].streaming = "sse"; },
      m => { m.endpoints[id].upstreamPath = "/v1/other"; });
    if (id !== "video") changes.push(m => { m.capabilities.push({ id: "media.file", endpoint: id, methods: ["GET"] }); });
  }
  for (const change of changes) { const m = fixture(); change(m); assert.throws(() => compile(m), /lifecycle|invalid manifest|upstreamPath/, String(change)); }
});

test("OpenRouter video links keep the selected canonical origin and original Bearer credentials", () => {
  const changes = [
    m => { m.baseUrls.default = "https://other.example/api"; }, m => { m.baseUrls.default += "/v1"; },
    m => { m.routing.baseUrlParam = "caller_base"; }, m => { m.routing.serviceParam = "caller_service"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].format = "Key ${secret}"; },
    m => { m.auth.grantTransports = { api_key: { paths: { video: "/other" } } }; },
    m => { m.adapter.injectHeaders.Authorization = "synthetic"; }, m => { m.adapter.injectHeaders["HTTP-Referer"] = "${secret}"; },
    m => { m.adapter.injectQuery = { key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["Authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "prompt", to: "other" }] }; },
  ];
  for (const id of ["video", "video_get", "video_content"]) changes.push(
    m => { m.endpoints[id].auth = "none"; }, m => { m.endpoints[id].requestHeaders = ["Authorization"]; },
    m => { m.endpoints[id].headers = { Authorization: "synthetic" }; }, m => { m.endpoints[id].outputTokenLimit = { field: "max_tokens", max: 1 }; });
  for (const change of changes) { const m = fixture(); change(m); assert.throws(() => compile(m), /lifecycle|invalid manifest/, String(change)); }
});

test("only the frozen OpenRouter video identity can acquire an unpriced media card without inheriting Chat accounting", () => {
  const manifest = fixture();
  manifest.models.entries.push({ id: "openrouter/google/veo-3.1-fast", upstream: wire.create.model, capabilities: ["media.predict"] });
  const card = compile(manifest).model_index["openrouter/google/veo-3.1-fast"];
  assert.equal(card.pricing, null); assert.equal(card.pricing_ref, null);
  for (const change of [m => { m.models.entries.at(-1).upstream = "google/veo-3.1-generate-preview"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.chat"); }, m => { m.models.entries.at(-1).pricingRef = "openrouter-auto"; }]) {
    const m = structuredClone(manifest); change(m); assert.throws(() => compile(m), /lifecycle/);
  }
  assert.ok(!bundled.capabilities.some(capability => capability.id === "media.predict"));
});

test("existing Omni file declarations preserve metadata-first links without default injection or download-only coercion", () => {
  const manifest = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
  manifest.capabilities.push({ id: "media.predict", endpoint: "video", methods: ["POST"] });
  Object.assign(manifest.endpoints, {
    video: { path: "/v1beta/interactions", requestFormat: "google.omni_video_create", responseFormat: "google.omni_video",
      lifecycle: { protocol: "google.omni_video", retrieve: "get", cancel: "cancel", files: { metadata: "file", download: "download" } } },
    get: { method: "GET", path: "/v1beta/interactions/${interaction_id}", pathParams: ["interaction_id"], requestFormat: "google.omni_video_get", responseFormat: "google.omni_video" },
    cancel: { method: "POST", path: "/v1beta/interactions/${interaction_id}/cancel", pathParams: ["interaction_id"], requestFormat: "google.omni_video_cancel", responseFormat: "google.omni_video" },
    file: { method: "GET", path: "/v1beta/files/${file_id}", pathParams: ["file_id"], requestFormat: "google.omni_video_file_metadata", responseFormat: "google.omni_video_file" },
    download: { method: "GET", path: "/v1beta/files/${file_id}:download", pathParams: ["file_id"], query: { alt: "media" }, requestFormat: "google.omni_video_file_download", responseFormat: "google.omni_video_bytes" },
  });
  const files = () => endpoint(compile(manifest).providers[0], "video").lifecycle.files;
  assert.deepEqual(files(), { metadata: "file", download: "download" });
  manifest.endpoints.video.lifecycle.files.mode = "metadata";
  assert.deepEqual(files(), { mode: "metadata", metadata: "file", download: "download" });
  manifest.endpoints.video.lifecycle.files.mode = "download_only";
  assert.throws(files, /invalid manifest/);
  delete manifest.endpoints.video.lifecycle.files.metadata;
  assert.throws(files, /invalid manifest/);
});
