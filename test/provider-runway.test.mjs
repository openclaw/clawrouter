import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
const manifest = parse(readFileSync(new URL("../providers/runway.provider.yaml", import.meta.url), "utf8"));
const compile = value => compileProviderSnapshot([value]);

test("Runway declares finite unpriced models and shared task controls with canonical server auth", () => {
  const snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.equal(provider.id, "runway"); assert.equal(provider.status, "experimental");
  assert.deepEqual(provider.config_keys, ["RUNWAYML_API_SECRET"]);
  assert.deepEqual(provider.base_urls, { default: "https://api.dev.runwayml.com" });
  assert.equal(provider.auth.schemes[0].format, "Bearer ${secret}");
  assert.deepEqual(provider.models.map(model => [model.upstream, model.pricing]), [
    ["gen4.5", null], ["veo3.1", null], ["veo3.1_fast", null],
  ]);
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]);
  assert.equal(provider.endpoints.length, 3);
  assert.deepEqual(provider.capabilities, [{ id: "media.predict", endpoint: "text_video", methods: ["POST"] }]);
  assert.equal(provider.endpoints.some(endpoint => /image|upload|video_to_video/.test(endpoint.id + endpoint.path)), false);
  for (const mode of ["text"]) {
    const endpoint = provider.endpoints.find(value => value.id === mode + "_video");
    assert.equal(endpoint.path, "/v1/" + mode + "_to_video");
    assert.deepEqual(endpoint.lifecycle, { protocol: "runway.tasks", retrieve: mode + "_task", cancel: mode + "_task_cancel" });
  }
  for (const id of ["text_task", "text_task_cancel"]) {
    const endpoint = provider.endpoints.find(value => value.id === id);
    assert.equal(endpoint.path, "/v1/tasks/${id}"); assert.deepEqual(endpoint.headers, {});
    assert.equal(endpoint.method, id.endsWith("_cancel") ? "DELETE" : "GET");
  }
});

test("Runway cannot turn control IDs, version headers or uploads into independent caller authority", () => {
  const changes = [
    m => { m.endpoints.text_video.lifecycle.retrieve = "missing_task"; },
    m => { delete m.endpoints.text_video.lifecycle; },
    m => { m.endpoints.text_video.requestFormat = "runway.image_video"; },
    m => { m.endpoints.text_task_cancel.method = "POST"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "text_task", methods: ["GET"] }); },
    m => { m.endpoints.text_task.headers = { "X-Runway-Version": "caller-version" }; },
    m => { m.endpoints.text_task.auth = "none"; },
    m => { m.endpoints.upload = { path: "/v1/uploads", requestFormat: "runway.upload", responseFormat: "runway.upload" }; },
  ];
  for (const change of changes) { const value = structuredClone(manifest); change(value); assert.throws(() => compile(value)); }
});

