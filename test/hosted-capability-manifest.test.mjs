import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const original = parse(readFileSync(new URL("../providers/openai.provider.yaml", import.meta.url), "utf8"));
const sol = manifest => manifest.models.entries.find(model => model.id === "openai/gpt-6.1-sol");

test("compiler preserves exact declared hosted tools and rejects unsupported contract values", () => {
  function compile(mutate = () => {}) {
    const manifest = structuredClone(original); mutate(manifest);
    return compileProviderSnapshot([manifest]);
  }
  const provider = compile().providers[0];
  assert.deepEqual(provider.models.filter(model => model.nativeCapabilities?.endpoints.responses?.hostedTools).map(model => model.id).sort(), ["openai/gpt-6-astra", "openai/gpt-6-luna", "openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra"].sort());
  assert.equal(provider.models.find(model => model.id === "openai/gpt-4.1-mini").nativeCapabilities, undefined);
  for (const mutate of [
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.hostedTools = ["future_tool"]; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.hostedTools = "web_search"; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.hostedTools = []; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.hostedTools = ["web_search", "web_search"]; },
    manifest => { sol(manifest).nativeCapabilities.version = "clawrouter.native-capabilities.v2"; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.sources = []; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.checkedAt = "not-a-date"; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.responses.compaction = { version: "v2" }; },
    manifest => { sol(manifest).nativeCapabilities.endpoints.chat_completions.hostedTools = ["web_search"]; },
    manifest => { manifest.endpoints.responses.path = "/v1/not-responses"; },
    manifest => { manifest.endpoints.responses.responseFormat = "openai.chat_completions"; },
    manifest => { manifest.id = "not-openai"; },
    manifest => { sol(manifest).capabilities = sol(manifest).capabilities.filter(id => id !== "llm.responses"); delete sol(manifest).requestParameters.responses; },
  ]) {
    assert.throws(() => compile(mutate), /schema validation|nativeCapabilities/);
  }
  const absent = compile(manifest => { delete sol(manifest).nativeCapabilities.endpoints.responses.hostedTools; });
  assert.equal(absent.providers[0].models.find(model => model.id === "openai/gpt-6.1-sol").nativeCapabilities.endpoints.responses.hostedTools, undefined);
});
