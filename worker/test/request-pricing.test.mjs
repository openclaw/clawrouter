import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { policyRequestCost } from "../../shared/request-pricing.ts";
const { estimateCost } = await import("../proxy-accounting.ts");

test("capability tariff precedence includes explicit zero and ignores inherited properties", () => {
  const policy = { requestCostMicros: 7, requestCostsMicros: { "search.web": 0, "llm.responses": 11 } };
  assert.equal(policyRequestCost(policy, "search.web"), 0);
  assert.equal(policyRequestCost(policy, "llm.responses"), 11);
  assert.equal(policyRequestCost(policy, "llm.chat"), 7);
  assert.equal(policyRequestCost({ requestCostsMicros: Object.create({ "search.web": 99 }) }, "search.web"), null);
  for (const [capability, request_format] of [["llm.count_tokens", "anthropic.count_tokens"], ["llm.moderations", "openai.moderations"], ["models.list", "openai.models"]]) {
    const fixed = policyRequestCost({ requestCostsMicros: { [capability]: 42 } }, capability);
    assert.equal(estimateCost(null, {}, fixed, capability, { request_format }).reserveMicros, 0);
  }
});
