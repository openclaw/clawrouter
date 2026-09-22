import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexCatalog } from "../scripts/codex-catalog.mjs";

const descriptor = {
  slug: "fixture-sol", context_window: 272_000, max_context_window: 872_000,
  base_instructions: "Fixture instructions stay byte-identical.\n",
  model_messages: { instructions_template: "Fixture {{ tools }}\n", guardian_v2: { model: "fixture-luna" } },
  supported_reasoning_levels: [{ effort: "high", description: "Fixture effort" }],
  service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }],
  additional_speed_tiers: ["fast", "ultrafast"], default_service_tier: "ultrafast",
  use_responses_lite: true, unknown_future_metadata: { keep: true },
};
const route = { endpoint: "responses", path: "/v1/responses", methods: ["POST"], requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse" };
function catalog(models, overrides = {}) {
  return { providers: [{ id: "fixture", allowed: true, executable: true, nativeBaseUrl: "/v1/native/fixture", routes: [route], models, ...overrides }] };
}
const model = { id: "fixture/sol-alias", upstream: "sol-alias", codexModel: "fixture-sol", capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "default" }, { id: "priority", aliases: ["fast"], maxInputTokens: null }] } };

test("native-provider export preserves complete instructions and internal metadata while narrowing paid tiers", () => {
  const original = structuredClone(descriptor);
  const result = buildCodexCatalog(catalog([model]), { models: [descriptor] }, "fixture");
  assert.equal(result.nativeBasePath, "/v1/native/fixture/v1");
  assert.deepEqual(result.catalog.models[0], { ...descriptor, slug: "sol-alias", service_tiers: [descriptor.service_tiers[0]], additional_speed_tiers: ["fast"], default_service_tier: null });
  assert.deepEqual(descriptor, original);
  assert.deepEqual(result.mappings, [{ route: "fixture/sol-alias", upstream: "sol-alias", descriptor: "fixture-sol" }]);
});

test("export never invents descriptors or extends a published tier beyond its context range", () => {
  const shortOnly = { ...model, pricing: { serviceTiers: [{ id: "priority", maxInputTokens: 272_000 }] } };
  const result = buildCodexCatalog(catalog([shortOnly, { id: "fixture/unknown", upstream: "unknown", capabilities: ["llm.responses"] }]), { models: [descriptor] }, "fixture");
  assert.deepEqual(result.catalog.models[0].service_tiers, []);
  assert.deepEqual(result.catalog.models[0].additional_speed_tiers, []);
  assert.deepEqual(result.skipped, [{ model: "fixture/unknown", reason: "no exact native Codex descriptor" }]);
  assert.throws(() => buildCodexCatalog(catalog([{ ...model, codexModel: undefined }]), { models: [descriptor] }, "fixture"), /no authorized Responses model/);
});

test("only authorized native Responses routes qualify and duplicate upstream rows fail visibly", () => {
  for (const overrides of [{ allowed: false }, { executable: false }, { routes: [{ ...route, requestFormat: "openai.chat_completions" }] }, { routes: [] }]) {
    assert.throws(() => buildCodexCatalog(catalog([model], overrides), { models: [descriptor] }, "fixture"));
  }
  assert.throws(() => buildCodexCatalog(catalog([model, model]), { models: [descriptor] }, "fixture"), /duplicate native model route/);
  assert.throws(() => buildCodexCatalog(catalog([model]), { models: [{ ...descriptor, base_instructions: undefined, model_messages: {} }] }, "fixture"), /no instructions/);
});
