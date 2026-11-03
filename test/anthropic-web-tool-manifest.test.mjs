import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const original = parse(readFileSync(new URL("../providers/anthropic.provider.yaml", import.meta.url), "utf8"));

test("compiler binds the Claude search tariff only to a Messages generation endpoint", () => {
  function compile(mutate = () => {}) {
    const manifest = structuredClone(original);
    // Isolate hosted-tool endpoint validation from the independent modifier-card
    // guard, which also rejects a changed Messages wire format.
    for (const model of manifest.models.entries) delete model.pricing.anthropicModifiers;
    mutate(manifest);
    return compileProviderSnapshot([manifest]);
  }
  const provider = compile().providers[0];
  assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "messages").toolPricing, original.endpoints.messages.toolPricing);
  assert.equal(provider.endpoints.find(endpoint => endpoint.id === "count_tokens").toolPricing, undefined);
  for (const mutate of [
    manifest => { manifest.endpoints.messages.method = "GET"; },
    manifest => { manifest.endpoints.messages.responseFormat = "openai.responses"; },
    manifest => { manifest.endpoints.count_tokens.toolPricing = manifest.endpoints.messages.toolPricing; delete manifest.endpoints.messages.toolPricing; },
    manifest => { manifest.endpoints.messages.toolPricing.previewMicrosPerCallByModel = { "claude-opus-5-5": 10000 }; },
  ]) {
    assert.throws(() => compile(mutate), /toolPricing|schema validation/);
  }
});
