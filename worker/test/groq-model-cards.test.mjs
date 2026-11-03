import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { requestPricingGap } from "../pricing.ts";

const manifest = parse(readFileSync(new URL("../../providers/groq.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]);

test("Groq OSS20B exposes the sourced Chat limits and conservative cache tariff", () => {
  const model = snapshot.model_index["groq/gpt-oss-20b"];
  assert.equal(model.upstream, "openai/gpt-oss-20b");
  assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high"]);
  const facts = model.nativeCapabilities.endpoints.chat_completions;
  assert.deepEqual(facts.input, ["text"]);
  assert.equal(facts.contextWindow, 131072);
  assert.equal(facts.maxOutputTokens, 65536);
  assert.equal(facts.checkedAt, "2026-11-03");
  assert.deepEqual([model.pricing.inputMicrosPerMillion, model.pricing.cachedInputMicrosPerMillion, model.pricing.outputMicrosPerMillion], [75000, 37500, 300000]);
  assert.equal(model.pricing.settlementBasis, "published_upper_bound");
  assert.equal(snapshot.providers[0].endpoints[0].modelPassthrough.pricing, null);
});

test("Groq token cards cannot hide unqualified hosted-tool or service-tier charges", () => {
  for (const id of ["groq/gpt-oss-20b", "groq/gpt-oss-120b"]) {
    const pricing = snapshot.model_index[id].pricing;
    assert.deepEqual(pricing.unpricedCosts, ["request_fee"]);
    for (const body of [
      {},
      { tools: [{ type: "browser_search" }] },
      { tools: [{ type: "code_interpreter" }] },
      { service_tier: "performance" },
    ]) assert.equal(requestPricingGap(pricing, body, "openai.chat_completions", "token_only"), "model_request_fee");
  }
});
