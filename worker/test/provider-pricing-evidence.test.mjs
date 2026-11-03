import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

const compile = manifest => compileProviderSnapshot([structuredClone(manifest)]);

test("Fireworks OSS pricing preserves verification provenance and both published tiers", () => {
  const snapshot = compile(parse(readFileSync("providers/fireworks.provider.yaml", "utf8")));
  const model = snapshot.providers[0].models.find(model => model.id === "fireworks/gpt-oss-120b");
  assert.deepEqual(snapshot.model_index[model.id].pricing, model.pricing);
  assert.equal(model.pricing.checkedAt, "2026-11-03");
  assert.equal(model.pricing.source, "https://docs.fireworks.ai/serverless/pricing");
  assert.equal(model.pricing.maxInputTokens, 131072);
  assert.equal(model.pricing.defaultMaxOutputTokens, 131072);
  assert.deepEqual(model.pricing.serviceTiers.map(tier => [tier.id, tier.inputMicrosPerMillion, tier.cachedInputMicrosPerMillion, tier.outputMicrosPerMillion]), [
    ["default", 150000, 15000, 600000],
    ["priority", 180000, 18000, 720000],
  ]);
  assert.equal(snapshot.providers[0].endpoints[0].modelPassthrough.pricing, null, "a known model card cannot price arbitrary upstream model IDs");
});

test("pricing verification dates are optional, validated, and do not qualify request fees", () => {
  const manifest = parse(readFileSync("providers/perplexity.provider.yaml", "utf8"));
  const pricing = manifest.models.entries[0].pricing;
  pricing.checkedAt = "2026-11-03";
  const compiled = compile(manifest).model_index["perplexity/sonar-pro"].pricing;
  assert.equal(compiled.checkedAt, pricing.checkedAt);
  assert.deepEqual(compiled.unpricedCosts, ["request_fee"]);
  pricing.checkedAt = "not-a-date";
  assert.throws(() => compile(manifest), /invalid manifest/);
  delete pricing.checkedAt;
  assert.equal(Object.hasOwn(compile(manifest).model_index["perplexity/sonar-pro"].pricing, "checkedAt"), false);
});
