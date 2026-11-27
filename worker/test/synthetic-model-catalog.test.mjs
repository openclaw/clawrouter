import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { filterSyntheticModels } = await import("../synthetic-model-catalog.ts");
const id = "hf:openai/gpt-oss-120b", allow = value => value === id;
const row = () => ({ id, name: "Synthetic fixture model", context_length: 131072, max_output_length: 65536,
  input_modalities: ["text"], output_modalities: ["text"], supported_features: ["tools", "reasoning"],
  reasoning_parameters: { efforts: ["none", "low", "high"] }, pricing: { prompt: "0.000001", completion: "$0.000002" } });
const payload = (...data) => ({ data });
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response" && !e.message.includes("synthetic-private");

test("Synthetic accepts its qualified data-only native catalog and preserves explicit facts", () => {
  assert.deepEqual(filterSyntheticModels(payload(row()), allow), payload(row()));
  assert.deepEqual(filterSyntheticModels({ object: "list", data: [row()] }, allow), payload(row()));
});

test("Synthetic discovery applies the original caller's exact model filter", () => {
  assert.deepEqual(filterSyntheticModels(payload(row(), { ...row(), id: "hf:other/hidden" }), allow), payload(row()));
  assert.deepEqual(filterSyntheticModels(payload(row()), () => false), payload());
  assert.deepEqual(filterSyntheticModels(payload(), allow), payload());
});

test("Synthetic invalid envelopes, identities, duplicates and row bounds fail closed", () => {
  for (const value of [null, [], {}, { data: {} }, { object: "other", data: [] }, payload(null), payload({ ...row(), id: "" }),
    payload({ ...row(), id: "bad id" }), payload({ ...row(), id: "x".repeat(513) }), payload(row(), row()),
    payload(...Array(4097).fill(row()))]) assert.throws(() => filterSyntheticModels(value, allow), invalid);
});

test("Synthetic excludes inactive, deprecated, non-text and invalid-limit rows", () => {
  for (const changes of [{ deprecated: true }, { active: false }, { active: "true" }, { deprecated: 0 },
    { context_length: 0 }, { context_length: 1.5 }, { context_length: Number.MAX_SAFE_INTEGER + 1 },
    { input_modalities: ["image"] }, { output_modalities: ["embedding"] }, { input_modalities: [1] }]) {
    assert.deepEqual(filterSyntheticModels(payload({ ...row(), ...changes }), allow), payload());
  }
});

test("Synthetic missing observations do not inherit frozen limits, support or zero prices", () => {
  const value = { ...row() }; delete value.max_output_length; delete value.supported_features; delete value.reasoning_parameters; delete value.pricing;
  const [model] = filterSyntheticModels(payload(value), allow).data;
  for (const key of ["max_output_length", "supported_features", "reasoning_parameters", "pricing"]) assert.equal(key in model, false);
  const empty = filterSyntheticModels(payload({ ...value, supported_features: [], reasoning_parameters: { efforts: [] } }), allow).data[0];
  assert.deepEqual(empty.supported_features, []); assert.deepEqual(empty.reasoning_parameters, { efforts: [] });
});

test("Synthetic current output limits override frozen observations and cannot exceed context", () => {
  const [model] = filterSyntheticModels(payload({ ...row(), max_output_length: 262144 }), allow).data;
  assert.equal(model.max_output_length, 131072);
  for (const value of [0, -1, 1.5, "65536"]) {
    assert.equal("max_output_length" in filterSyntheticModels(payload({ ...row(), max_output_length: value }), allow).data[0], false);
  }
});

test("Synthetic price strings remain observations without numeric, cache or zero defaults", () => {
  const pricing = { prompt: "0", completion: "$0.10", input_cache_reads: "0.000001", input_cache_writes: "$0.0" };
  assert.deepEqual(filterSyntheticModels(payload({ ...row(), pricing }), allow).data[0].pricing, pricing);
  for (const value of [0, -1, "-1", "1e-999", "NaN", "synthetic-private", "1.0000000000000000001"]) {
    const [model] = filterSyntheticModels(payload({ ...row(), pricing: { prompt: value, completion: "0.1" } }), allow).data;
    assert.deepEqual(model.pricing, { completion: "0.1" });
  }
});

test("Synthetic projection drops unqualified properties and isolates returned arrays", () => {
  const input = row(); input.api_key = "synthetic-private"; input.endpoint = "https://untrusted.example";
  const [model] = filterSyntheticModels(payload(input), allow).data;
  assert.doesNotMatch(JSON.stringify(model), /synthetic-private|untrusted/);
  model.input_modalities.push("image"); model.supported_features.push("other");
  assert.deepEqual(input.input_modalities, ["text"]); assert.deepEqual(input.supported_features, ["tools", "reasoning"]);
});

test("Synthetic normalizes bounded names and returns deterministic identity order", () => {
  const other = { ...row(), id: "hf:a/first", name: "bad\nname" };
  const models = filterSyntheticModels(payload(row(), other), () => true).data;
  assert.deepEqual(models.map(m => m.id), [other.id, id]); assert.equal(models[0].name, other.id);
});

test("Synthetic malformed optional feature lists remain unknown", () => {
  for (const features of ["tools", [1], ["bad\nfeature"], Array(33).fill("tools")]) {
    const [model] = filterSyntheticModels(payload({ ...row(), supported_features: features, reasoning_parameters: { efforts: features } }), allow).data;
    assert.equal("supported_features" in model, false); assert.equal("reasoning_parameters" in model, false);
  }
});
