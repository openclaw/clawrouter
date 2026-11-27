import assert from "node:assert/strict";
import test from "node:test";
import { fusionAdviserModels, fusionStrategy } from "../../shared/fusion-strategy.ts";
import { buildAggregatorBody, buildFusionReservationProposals, collectFusionProposals, normalizeFusionConfig } from "../fusion.ts";

test("legacy Fusion profiles keep ensemble behavior; unknown strategies fail closed", () => {
  assert.equal(normalizeFusionConfig({}).strategy, "ensemble");
  assert.equal(fusionStrategy({}), "ensemble");
  assert.throws(() => normalizeFusionConfig({ strategy: "auto" }), /strategy must be/);
  assert.throws(() => normalizeFusionConfig({ strategy: null }), /strategy must be/);
  assert.throws(() => normalizeFusionConfig({ enabled: true, adviserModels: [] }), /at least one adviser/);
});

test("single Fusion preserves dormant advisers without calling or reserving them", async () => {
  const config = normalizeFusionConfig({ strategy: "single", enabled: true, adviserModels: ["retired/adviser"], aggregatorModel: "local/final" });
  assert.deepEqual(config.adviserModels, ["retired/adviser"]);
  assert.deepEqual(fusionAdviserModels(config), []);
  assert.deepEqual(buildFusionReservationProposals(config), []);
  let calls = 0;
  const result = await collectFusionProposals(config, { messages: [] }, async () => { calls++; throw new Error("must not call adviser"); });
  assert.equal(calls, 0);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.failedModels, []);
  const original = { model: "clawrouter/fusion", messages: [{ role: "user", content: "hello" }], stream: true, tools: [{ type: "function" }], temperature: 0.5 };
  assert.deepEqual(buildAggregatorBody(original, config, result.proposals), { ...original, model: "local/final" });
  assert.equal(normalizeFusionConfig({ strategy: "single", enabled: true, adviserModels: [] }).enabled, true);
});

test("switching a profile back to ensemble restores exactly its adviser pool", () => {
  const config = normalizeFusionConfig({ strategy: "single", adviserModels: ["local/one", "local/two"] });
  const ensemble = normalizeFusionConfig({ ...config, strategy: "ensemble" });
  assert.deepEqual(fusionAdviserModels(ensemble), config.adviserModels);
  assert.equal(buildFusionReservationProposals(ensemble).length, 2);
});
