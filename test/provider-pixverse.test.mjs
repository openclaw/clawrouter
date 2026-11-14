import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
const manifest = parse(readFileSync(new URL("../providers/pixverse.provider.yaml", import.meta.url), "utf8"));
const compile = input => compileProviderSnapshot([input]);

test("PixVerse exposes only frozen unpriced text models with native regional server credentials", () => {
  const snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.equal(provider.id, "pixverse"); assert.equal(provider.status, "experimental");
  assert.deepEqual(provider.config_keys, ["PIXVERSE_API_KEY"]);
  assert.deepEqual(provider.base_urls, { default: "https://app-api.pixverse.ai", cn: "https://app-api.pixverseai.cn" });
  assert.equal(provider.auth.schemes[0].header, "API-KEY");
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream, model.pricing]), [["pixverse/v6", "v6", null], ["pixverse/c1", "c1", null]]);
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]);
  assert.equal(provider.endpoints.length, 2);
  assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "text_video").lifecycle, { protocol: "pixverse.video", retrieve: "video" });
  const retrieve = provider.endpoints.find(endpoint => endpoint.id === "video");
  assert.equal(retrieve.method, "GET"); assert.equal(retrieve.path, "/openapi/v2/video/result/${video_id}");
  assert.deepEqual(retrieve.path_params, ["video_id"]); assert.deepEqual(retrieve.headers, {});
});

test("PixVerse declarations cannot bypass original job controls or expose image/upload/cancel routes", () => {
  for (const change of [
    m => { delete m.endpoints.text_video.lifecycle; },
    m => { m.endpoints.text_video.lifecycle.cancel = "video"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "video", methods: ["GET"] }); },
    m => { m.endpoints.image = { ...m.endpoints.text_video, path: "/openapi/v2/video/img/generate", requestFormat: "pixverse.image_video" }; },
    m => { m.endpoints.upload = { path: "/openapi/v2/image/upload", requestFormat: "pixverse.image_upload", responseFormat: "pixverse.image_upload" }; },
    m => { m.endpoints.video.headers = { "Ai-trace-id": "static" }; },
    m => { m.endpoints.video.auth = "none"; },
  ]) { const value = structuredClone(manifest); change(value); assert.throws(() => compile(value)); }
});
