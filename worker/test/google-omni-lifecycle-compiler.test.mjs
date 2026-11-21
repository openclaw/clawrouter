import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { googleOmniVideoManagedAdapter: adapter } = await import("../managed-google-omni.ts");
const { googleOmniApiBase, googleOmniVideos, prepareGoogleOmniFileControl, readGoogleOmniFileState } = await import("../provider-google-omni-files.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url), "utf8"));
const bundled = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(isolated = false) {
  const manifest = structuredClone(bundled);
  if (isolated) {
    // Provider-wide negative cases must exercise the Omni guard itself.
    const unrelatedCapabilities = ["llm.embeddings", "image.generate", "audio.generate", "audio.speech"];
    const unrelatedEndpoints = new Set(manifest.capabilities.filter(row => unrelatedCapabilities.includes(row.id)).map(row => row.endpoint));
    for (const id of unrelatedEndpoints) delete manifest.endpoints[id];
    manifest.capabilities = manifest.capabilities.filter(row => !unrelatedEndpoints.has(row.endpoint));
    manifest.models.entries = manifest.models.entries.filter(row => !row.capabilities.some(id => unrelatedCapabilities.includes(id)));
  }
  manifest.capabilities.push({ id: "media.predict", endpoint: "video", methods: ["POST"] });
  Object.assign(manifest.endpoints, {
    video: { path: "/v1beta/interactions", requestFormat: "google.omni_video_create", responseFormat: "google.omni_video",
      lifecycle: { protocol: "google.omni_video", retrieve: "interaction", cancel: "cancel", files: { metadata: "file", download: "download" } } },
    interaction: { method: "GET", path: "/v1beta/interactions/${interaction_id}", pathParams: ["interaction_id"], requestFormat: "google.omni_video_get", responseFormat: "google.omni_video" },
    cancel: { method: "POST", path: "/v1beta/interactions/${interaction_id}/cancel", pathParams: ["interaction_id"], requestFormat: "google.omni_video_cancel", responseFormat: "google.omni_video" },
    file: { method: "GET", path: "/v1beta/files/${file_id}", pathParams: ["file_id"], requestFormat: "google.omni_video_file_metadata", responseFormat: "google.omni_video_file" },
    download: { method: "GET", path: "/v1beta/files/${file_id}:download", pathParams: ["file_id"], query: { alt: "media" }, requestFormat: "google.omni_video_file_download", responseFormat: "google.omni_video_bytes" },
  });
  return manifest;
}

test("Omni endpoint links preserve Google's existing origin and require explicit codec prefix translation", () => {
  const manifest = fixture(), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = id => provider.endpoints.find(value => value.id === id);
  assert.deepEqual(endpoint("video").lifecycle, manifest.endpoints.video.lifecycle);
  assert.deepEqual(snapshot.model_index, compile(bundled).model_index);
  for (const original of compile(bundled).providers[0].endpoints) assert.deepEqual(endpoint(original.id), original);
  assert.equal(snapshot.capability_index["media.predict"].length, 1);
  assert.deepEqual(Object.keys(snapshot.capability_index).sort(), [...Object.keys(compile(bundled).capability_index), "media.predict"].sort());
  assert.ok(adapter.requestFormats.includes(endpoint("video").request_format));
  assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, true);
  const prepared = adapter.prepare(wire.requests[2], new Headers(), {}, new URLSearchParams());
  assert.deepEqual(prepared.pathParams, { background: "true", store: "true" });
  for (const [action, id] of [["retrieve", "interaction"], ["cancel", "cancel"]]) {
    const control = endpoint(id);
    // This is a required wrapper translation, not a registered runtime route.
    assert.throws(() => adapter.control(action, control, wire.pending.id, prepared.pathParams), /control_endpoint/);
    const target = adapter.control(action, { ...control, path: control.path.slice("/v1beta".length) }, wire.pending.id, prepared.pathParams);
    assert.equal(`/v1beta${target.path}`, control.path.replace("${interaction_id}", wire.pending.id));
    assert.equal(target.query.size, 0);
    assert.throws(() => adapter.control(action, { ...control, path: control.path.slice(7) }, wire.pending.id, { background: "false", store: "false" }), /control/);
  }
});

test("Omni declarations reject orphan controls, widened paths, file query injection and credential overrides", () => {
  assert.doesNotThrow(() => compile(fixture(true)));
  const changes = [
    m => { m.id = "other"; }, m => { m.endpoints.video.lifecycle.protocol = "google.interactions"; },
    m => { delete m.endpoints.video.lifecycle; }, m => { delete m.endpoints.video.lifecycle.files; },
    m => { delete m.endpoints.video.lifecycle.cancel; }, m => { delete m.endpoints.video.lifecycle.files.download; },
    m => { m.endpoints.video.lifecycle.files.upload = "file"; }, m => { m.endpoints.video.lifecycle.result = "file"; },
    m => { m.endpoints.video.lifecycle.files.download = "file"; }, m => { m.endpoints.video.lifecycle.files.metadata = "constructor"; },
    m => { m.endpoints.video.lifecycle.retrieve = "missing"; }, m => { m.endpoints.video.path = "/interactions"; },
    m => { m.endpoints.video.requestFormat = "openai.responses"; }, m => { m.endpoints.video.responseFormat = "google.generate_content"; },
    m => { m.endpoints.video.streaming = "sse"; }, m => { m.endpoints.video.query = { store: "true" }; },
    m => { m.endpoints.file.pathParams.push("job_id"); }, m => { m.endpoints.file.pathParamStyles = { file_id: "relative_path" }; },
    m => { m.endpoints.file.path = "/v1beta/${file_id}"; }, m => { m.endpoints.file.query = { key: "synthetic" }; },
    m => { m.endpoints.download.query.alt = "json"; }, m => { m.endpoints.download.query.key = "synthetic"; },
    m => { delete m.endpoints.download.query; }, m => { m.endpoints.download.method = "POST"; },
    m => { m.endpoints.download.responseFormat = "openai.responses"; }, m => { m.endpoints.file.requestFormat = "other"; },
    m => { m.endpoints.orphan = structuredClone(m.endpoints.file); },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.file), requestFormat: "other" }; },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.file), requestFormat: "google.omni_video_raw", responseFormat: "other" }; },
    m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.default += "?key=synthetic"; },
  ];
  for (const id of ["video", "interaction", "cancel", "file", "download"]) {
    changes.push(m => { m.endpoints[id].modelPassthrough = {}; }, m => { m.endpoints[id].auth = "none"; },
      m => { m.endpoints[id].headers = { "x-goog-api-key": "synthetic" }; },
      m => { m.endpoints[id].requestHeaders = ["x-goog-api-key"]; }, m => { m.endpoints[id].nativeProxy = false; });
    if (id !== "video") changes.push(m => { m.capabilities.push({ id: "media.file", endpoint: id, methods: ["GET"] }); });
  }
  for (const change of changes) {
    const manifest = fixture(true); change(manifest);
    assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change));
  }
});

test("compiled file paths match native descriptors and require matching ACTIVE state without price inference", async () => {
  const provider = compile(fixture()).providers[0], base = googleOmniApiBase(bundled.baseUrls.default);
  const [asset] = googleOmniVideos(wire.completed, 3);
  const metadata = prepareGoogleOmniFileControl("metadata", asset, base);
  assert.equal(metadata.credential, "original_job"); assert.equal(metadata.redirect, "error");
  const active = await readGoogleOmniFileState(Response.json(wire.active), metadata.fileName);
  for (const [action, id] of [["metadata", "file"], ["download", "download"]]) {
    const endpoint = provider.endpoints.find(value => value.id === id);
    const target = prepareGoogleOmniFileControl(action, asset, base, active), query = new URLSearchParams(endpoint.query).toString();
    assert.equal(target.method, endpoint.method);
    assert.equal(target.url, `${bundled.baseUrls.default}${endpoint.path.replace("${file_id}", metadata.fileName.slice("files/".length))}${query ? `?${query}` : ""}`);
  }
  for (const body of [wire.processing, wire.fileFailed]) {
    const state = await readGoogleOmniFileState(Response.json(body), metadata.fileName);
    assert.throws(() => prepareGoogleOmniFileControl("download", asset, base, state), /file_not_ready/);
    assert.equal(state.terminal, undefined); assert.equal(state.actualCostMicros, undefined);
  }
  assert.throws(() => prepareGoogleOmniFileControl("metadata", asset, "https://other.example/v1beta"), /file_origin/);
  await assert.rejects(readGoogleOmniFileState(Response.json(wire.active), "files/other-job"), /file_identity/);
  assert.equal(googleOmniVideos(wire.retrieved, 3)[0].kind, "inline");
});

test("Omni continuation loss preserves uncertainty and bundled discovery remains inactive", async () => {
  for (const status of ["incomplete", "requires_action", "requires_continuation"]) {
    const observation = await adapter.read(Response.json({ ...wire.pending, status }), { action: "retrieve", expectedId: wire.pending.id, requestedVersion: wire.pending.model, pathParams: { background: "true", store: "true" } });
    assert.equal(observation.nativeStatus, status); assert.equal(observation.observationUnavailable, "expired_or_unknown");
    assert.equal(observation.terminal, null); assert.equal(observation.followUp, undefined);
  }
  assert.ok(!bundled.capabilities.some(capability => capability.id === "media.predict"));
  assert.ok(!bundled.models.entries.some(model => /veo|omni/.test(model.upstream)));
});
