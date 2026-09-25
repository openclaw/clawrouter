import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const endpoint = (path, method = "POST") => ({ path, method, requestFormat: "openai.responses", responseFormat: "openai.responses" });
const manifest = {
  schema: "clawrouter.service-provider.v1", id: "fixture-provider", displayName: "Fixture",
  auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
  baseUrls: { default: "https://provider.example" }, capabilities: [{ id: "llm.responses", endpoint: "generate" }],
  endpoints: {
    generate: { ...endpoint("/responses"), responsesLifecycle: { retrieve: "inspect", cancel: "stop" } },
    inspect: { ...endpoint("/responses/${response_id}", "GET"), pathParams: ["response_id"] },
    stop: { ...endpoint("/responses/${response_id}/cancel"), pathParams: ["response_id"] },
  },
  models: { entries: [{ id: "fixture/model", upstream: "model", capabilities: ["llm.responses"] }] },
};

test("compiler preserves arbitrary lifecycle links without adding model capabilities or metadata to controls", () => {
  withCompiler(compile => {
    const result = compile(manifest), provider = result.providers[0];
    assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "generate").responsesLifecycle, { retrieve: "inspect", cancel: "stop" });
    assert.ok(provider.endpoints.filter(endpoint => endpoint.id !== "generate").every(endpoint => !Object.hasOwn(endpoint, "responsesLifecycle")));
    assert.deepEqual(provider.capabilities, [{ id: "llm.responses", endpoint: "generate", methods: ["POST"] }]);
    assert.deepEqual(provider.models[0].capabilities, ["llm.responses"]);
    assert.deepEqual(result.capability_index, { "llm.responses": [{ provider: "fixture-provider", endpoint: "generate", methods: ["POST"] }] });
    const absent = structuredClone(manifest); delete absent.endpoints.generate.responsesLifecycle;
    assert.ok(compile(absent).providers[0].endpoints.every(endpoint => !Object.hasOwn(endpoint, "responsesLifecycle")));
  });
});

test("compiler rejects ambiguous, dangling and incompatible lifecycle references before normalization", () => {
  withCompiler(compile => {
    for (const change of [
      m => { m.endpoints.generate.responsesLifecycle = {}; },
      m => { m.endpoints.generate.responsesLifecycle = null; },
      m => { m.endpoints.generate.responsesLifecycle.delete = "stop"; },
      m => { m.endpoints.generate.responsesLifecycle.retrieve = "constructor"; },
      m => { m.endpoints.generate.responsesLifecycle.cancel = "missing"; },
      m => { m.endpoints.generate.responsesLifecycle.cancel = "inspect"; },
      m => { m.endpoints.generate.responsesLifecycle.cancel = "generate"; },
      m => { m.endpoints.inspect.responsesLifecycle = { retrieve: "generate", cancel: "stop" }; },
      m => { m.endpoints.other = structuredClone(m.endpoints.generate); },
      m => { m.endpoints.generate.requestFormat = "openai.chat_completions"; },
      m => { m.endpoints.generate.method = "GET"; },
      m => { m.endpoints.inspect.method = "POST"; },
      m => { m.endpoints.stop.method = "GET"; },
      m => { m.endpoints.inspect.responseFormat = "other"; },
      m => { m.endpoints.stop.pathParams = ["model"]; },
      m => { m.endpoints.stop.path = "/static"; },
      m => { m.endpoints.inspect.modelPassthrough = {}; },
      m => { m.capabilities.push({ id: "control", endpoint: "inspect" }); },
    ]) {
      const invalid = structuredClone(manifest); change(invalid);
      assert.throws(() => compile(invalid), /responsesLifecycle/);
    }
  });
});

function withCompiler(run) {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-responses-manifest-"));
  try {
    const path = join(directory, "provider.json");
    run(value => {
      writeFileSync(path, JSON.stringify(value));
      return JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", path], { encoding: "utf8", stdio: "pipe" }));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
