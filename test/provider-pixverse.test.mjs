import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { managedCreateAdapter } from "../worker/managed-lifecycle-adapters.ts";
const manifest = parse(readFileSync(new URL("../providers/pixverse.provider.yaml", import.meta.url), "utf8"));
const compile = input => compileProviderSnapshot([input]);

test("PixVerse preserves frozen unpriced text models and declares their profiled image route", () => {
  const snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.equal(provider.id, "pixverse"); assert.equal(provider.status, "experimental");
  assert.deepEqual(provider.config_keys, ["PIXVERSE_API_KEY"]);
  assert.deepEqual(provider.base_urls, { default: "https://app-api.pixverse.ai", cn: "https://app-api.pixverseai.cn" });
  assert.equal(provider.auth.schemes[0].header, "API-KEY");
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream, model.pricing]), [["pixverse/v6", "v6", null], ["pixverse/c1", "c1", null]]);
  assert.deepEqual(Object.keys(snapshot.capability_index).sort(), ["media.predict", "video.generate"]);
  assert.deepEqual(provider.models.map(model => model.capabilities), [["media.predict", "video.generate"], ["media.predict", "video.generate"]]);
  assert.deepEqual(provider.endpoints.map(endpoint => endpoint.id).sort(), ["image_video", "text_video", "video"]);
  const text = provider.endpoints.find(endpoint => endpoint.id === "text_video");
  assert.equal(text.method, "POST"); assert.equal(text.path, "/openapi/v2/video/text/generate");
  assert.equal(text.request_format, "pixverse.text_video"); assert.equal(text.response_format, "pixverse.video");
  assert.equal(text.inputProfile, undefined);
  assert.deepEqual(text.lifecycle, { protocol: "pixverse.video", retrieve: "video" });
  const image = provider.endpoints.find(endpoint => endpoint.id === "image_video");
  assert.equal(image.method, "POST"); assert.equal(image.path, "/openapi/v2/video/img/generate");
  assert.equal(image.request_format, "pixverse.image_video"); assert.equal(image.response_format, "pixverse.video");
  assert.equal(image.inputProfile, "clawrouter.pixverse-image-input.v1");
  assert.deepEqual(image.path_params, []); assert.deepEqual(image.query, {}); assert.deepEqual(image.headers, {});
  assert.deepEqual(image.lifecycle, { protocol: "pixverse.video", retrieve: "video" });
  const retrieve = provider.endpoints.find(endpoint => endpoint.id === "video");
  assert.equal(retrieve.method, "GET"); assert.equal(retrieve.path, "/openapi/v2/video/result/${video_id}");
  assert.deepEqual(retrieve.path_params, ["video_id"]); assert.deepEqual(retrieve.headers, {});
});

test("PixVerse declarations cannot bypass the image profile or original controls, or expose upload/cancel routes", () => {
  for (const change of [
    m => { delete m.endpoints.text_video.lifecycle; },
    m => { m.endpoints.text_video.lifecycle.cancel = "video"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "video", methods: ["GET"] }); },
    m => { m.endpoints.image = { ...m.endpoints.text_video, path: "/openapi/v2/video/img/generate", requestFormat: "pixverse.image_video" }; },
    m => { delete m.endpoints.image_video.inputProfile; },
    m => { m.endpoints.image_video.inputProfile = "pixverse.image"; },
    m => { m.endpoints.image_video.lifecycle.cancel = "video"; },
    m => { m.endpoints.image_video.auth = "none"; },
    m => { m.capabilities.find(capability => capability.endpoint === "image_video").id = "media.predict"; },
    m => { for (const model of m.models.entries) model.capabilities = ["media.predict"]; },
    m => { m.endpoints.upload = { path: "/openapi/v2/image/upload", requestFormat: "pixverse.image_upload", responseFormat: "pixverse.image_upload" }; },
    m => { m.endpoints.video.headers = { "Ai-trace-id": "static" }; },
    m => { m.endpoints.video.auth = "none"; },
  ]) { const value = structuredClone(manifest); change(value); assert.throws(() => compile(value)); }
});

test("profiled image inventory does not grant generic creation authority from a caller image ID", () => {
  const provider = compile(manifest).providers[0], image = provider.endpoints.find(endpoint => endpoint.id === "image_video");
  const adapter = managedCreateAdapter(image.lifecycle.protocol, image.request_format); assert.ok(adapter);
  for (const model of provider.models) for (const input of [{}, { img_id: 123 }]) {
    const body = { model: model.upstream, prompt: "Synthetic image plan", duration: 5, quality: "720p", ...input };
    assert.throws(() => adapter.prepare(body, new Headers(), {}, new URLSearchParams()), /pixverse_upload_scope_required/);
  }
});
