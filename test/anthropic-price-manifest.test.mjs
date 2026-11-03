import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const original = parse(readFileSync(new URL("../providers/anthropic.provider.yaml", import.meta.url), "utf8"));

test("compiler preserves qualified Claude modifiers and rejects incomplete or invented tariffs", () => {
  const compile = (mutate = () => {}) => {
    const manifest = structuredClone(original); mutate(manifest);
    return compileProviderSnapshot([manifest]);
  };
  const snapshot = compile();
  for (const slug of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const source = original.models.entries.find(model => model.upstream === slug);
    const model = snapshot.providers[0].models.find(model => model.upstream === slug);
    assert.deepEqual(model.pricing.anthropicModifiers, source.pricing.anthropicModifiers);
    assert.deepEqual(snapshot.model_index[model.id].pricing, model.pricing);
    assert.equal(model.pricing.anthropicModifiers.fastMultiplier, null);
    assert.equal(model.pricing.anthropicModifiers.usMultiplier, 1.1);
    assert.deepEqual(model.pricing.anthropicModifiers.serviceTiers, ["standard"]);
  }
  for (const mutate of [
    card => { delete card.sources; }, card => { card.sources = []; },
    card => { card.sources = ["http://example.test"]; }, card => { card.checkedAt = "2026-02-29"; },
    card => { delete card.fastMultiplier; }, card => { delete card.usMultiplier; },
    card => { card.fastMultiplier = 1; }, card => { card.fastMultiplier = "2"; },
    card => { card.usMultiplier = 0; }, card => { card.usMultiplier = 1.2; },
    card => { card.serviceTiers = ["priority"]; }, card => { card.serviceTiers = []; },
    card => { card.unknownMultiplier = 3; },
  ]) {
    assert.throws(() => compile(manifest => mutate(manifest.models.entries[0].pricing.anthropicModifiers)), /invalid manifest/);
  }
  for (const mutate of [
    manifest => { manifest.id = "compatible-but-distinct-billing"; },
    manifest => { manifest.endpoints.messages.requestFormat = "openai.responses"; },
  ]) {
    assert.throws(() => compile(mutate), /anthropicModifiers requires first-party Anthropic Messages/);
  }
});
