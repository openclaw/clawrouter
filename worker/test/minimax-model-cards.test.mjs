import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { estimateModelCost } from "../pricing.ts";

const manifest = parse(readFileSync(new URL("../../providers/minimax.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]);
const flash = snapshot.model_index["minimax/MiniMax-M3.1-Flash"];

test("MiniMax M3.1 Flash keeps its sourced reasoning and modality facts separate from older models", () => {
  assert.equal(flash.upstream, "MiniMax-M3.1-Flash");
  assert.deepEqual(flash.capabilities, ["llm.chat"]);
  assert.deepEqual(flash.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  const parameters = flash.requestParameters.chat_completions;
  assert.equal(parameters.defaultReasoningEffort, "max");
  assert.equal(parameters.temperature, "unsupported");
  assert.equal(parameters.topP, "unsupported");
  const facts = flash.nativeCapabilities.endpoints.chat_completions;
  assert.equal(facts.checkedAt, "2026-11-03");
  assert.deepEqual(facts.input, ["text", "image", "video"]);
  assert.equal(facts.contextWindow, 1000000);
  assert.equal(facts.maxOutputTokens, undefined);
  assert.equal(facts.supportedServiceTiers, undefined);
  assert.equal(flash.pricing.serviceTiers, undefined);
  assert.equal(snapshot.model_index["minimax/MiniMax-M2.7"].requestParameters, undefined);
  assert.equal(snapshot.providers[0].endpoints[0].modelPassthrough.pricing, null);
});

test("MiniMax Flash prices media using the full input bound and reserves thinking within output limits", () => {
  assert.deepEqual([flash.pricing.inputMicrosPerMillion, flash.pricing.cachedInputMicrosPerMillion, flash.pricing.outputMicrosPerMillion], [150000, 15000, 600000]);
  const endpoint = snapshot.providers[0].endpoints[0];
  for (const part of [
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    { type: "video_url", video_url: { url: "https://example.com/video.mp4" } },
  ]) {
    const body = { messages: [{ role: "user", content: [part] }] };
    const bounded = estimateModelCost(flash.pricing, { ...body, max_completion_tokens: 16 }, endpoint);
    assert.equal(bounded.inputTokens, 1000000);
    assert.equal(bounded.outputTokens, 16);
    assert.equal(bounded.reserveMicros, 150010);
    const unspecified = estimateModelCost(flash.pricing, body, endpoint);
    assert.equal(unspecified.outputTokens, 1000000);
    assert.equal(unspecified.reserveMicros, 750000);
  }
});
