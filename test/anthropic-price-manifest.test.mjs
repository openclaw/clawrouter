import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const original = parse(readFileSync(new URL("../providers/anthropic.provider.yaml", import.meta.url), "utf8"));

test("compiler preserves qualified Claude modifiers and rejects incomplete or invented tariffs", t => {
  const root = mkdtempSync(join(tmpdir(), "clawrouter-claude-modifier-cards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const compile = (mutate = () => {}) => {
    const manifest = structuredClone(original); mutate(manifest);
    const input = join(root, "provider.yaml"); writeFileSync(input, JSON.stringify(manifest));
    return spawnSync(process.execPath, ["scripts/compile-providers.mjs", input], { encoding: "utf8" });
  };
  const valid = compile(); assert.equal(valid.status, 0, valid.stderr);
  const snapshot = JSON.parse(valid.stdout);
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
    const result = compile(manifest => mutate(manifest.models.entries[0].pricing.anthropicModifiers));
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.match(result.stderr, /invalid manifest/);
  }
  for (const mutate of [
    manifest => { manifest.id = "compatible-but-distinct-billing"; },
    manifest => { manifest.endpoints.messages.requestFormat = "openai.responses"; },
  ]) {
    const result = compile(mutate);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.match(result.stderr, /anthropicModifiers requires first-party Anthropic Messages/);
  }
});
