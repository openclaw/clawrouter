import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const manifest = parse(readFileSync(new URL("../providers/alibaba.provider.yaml", import.meta.url), "utf8"));
const compile = value => compileProviderSnapshot([value]).providers[0];

test("Alibaba compiles the finite Wan surface with canonical server credentials and scoped controls", () => {
  const provider = compile(manifest);
  assert.equal(provider.id, "alibaba");
  assert.deepEqual(provider.config_keys, ["MODELSTUDIO_API_KEY"]);
  assert.deepEqual(provider.optional_config_keys, []);
  assert.deepEqual(provider.routing.nativePrefixes, ["clawrouter-alibaba", "alibaba"]);
  assert.equal(provider.base_urls.default, "https://dashscope-intl.aliyuncs.com");
  assert.deepEqual(provider.models.map(model => model.upstream), [
    "wan2.6-t2v", "wan2.6-i2v", "wan2.6-r2v", "wan2.6-r2v-flash", "wan2.7-r2v",
  ]);
  assert.ok(provider.models.every(model => model.id === "alibaba/" + model.upstream && model.pricing === null));
  const create = provider.endpoints.find(endpoint => endpoint.id === "video");
  assert.deepEqual(create.lifecycle, { protocol: "dashscope.video", retrieve: "task" });
  assert.equal(create.headers["X-DashScope-Async"], "enable");
  assert.deepEqual(provider.capabilities, [{ id: "media.predict", endpoint: "video", methods: ["POST"] }]);
  assert.equal(provider.endpoints.length, 2);
  assert.equal(provider.endpoints.find(endpoint => endpoint.id === "task").request_format, "dashscope.video_get");
});

test("Alibaba cannot expose orphan task reads, invented cancellation, or another provider's lifecycle", () => {
  for (const change of [
    value => { delete value.endpoints.video.lifecycle; },
    value => { value.endpoints.video.lifecycle.cancel = "task"; },
    value => { value.endpoints.task.method = "DELETE"; },
    value => { value.id = "qwen"; },
    value => { value.capabilities.push({ id: "media.prediction.read", endpoint: "task", methods: ["GET"] }); },
  ]) {
    const invalid = structuredClone(manifest);
    change(invalid);
    assert.throws(() => compile(invalid));
  }
});
