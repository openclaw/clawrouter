import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { buildCodexCatalog, readCodexCatalog } from "../scripts/codex-catalog.mjs";

const descriptor = {
  slug: "fixture-sol", context_window: 272_000, max_context_window: 872_000,
  base_instructions: "Fixture instructions stay byte-identical.\n",
  model_messages: { instructions_template: "Fixture {{ tools }}\n", guardian_v2: { model: "fixture-luna" } },
  supported_reasoning_levels: [{ effort: "high", description: "Fixture effort" }],
  service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }],
  additional_speed_tiers: ["fast", "ultrafast"], default_service_tier: "ultrafast",
  use_responses_lite: true, unknown_future_metadata: { keep: true },
};
const route = { endpoint: "responses", path: "/v1/responses", methods: ["POST"], requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse", websocket: "openai.responses" };
function offer(modelId, transport = "http", overrides = {}) {
  return { endpoint: "responses", modelId, transport, routeKind: "native", route: "/v1/native/fixture/v1/responses", policyId: "fixture-policy", policyGeneration: "fixture-generation", eligible: true, affordability: "request-dependent", ...overrides };
}
function catalog(models, overrides = {}) {
  return { version: "clawrouter.client-catalog.v1", scope: { authType: "proxy_key", credentialId: "fixture-credential", principalId: null }, providers: [{ id: "fixture", allowed: true, executable: true, nativeBaseUrl: "/v1/native/fixture", policies: ["fixture-policy"], routes: [route], models, offers: models.flatMap((model) => [offer(model.id), offer(model.id, "websocket")]), ...overrides }] };
}
const model = { id: "fixture/sol-alias", upstream: "sol-alias", codexModel: "fixture-sol", capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "default" }, { id: "priority", aliases: ["fast"], maxInputTokens: null }] } };

test("native-provider export preserves complete instructions and internal metadata while narrowing paid tiers", () => {
  const original = structuredClone(descriptor);
  const result = buildCodexCatalog(catalog([model]), { models: [descriptor] }, "fixture");
  assert.equal(result.nativeBasePath, "/v1/native/fixture/v1");
  assert.equal(result.supportsWebsockets, true);
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
  for (const overrides of [{ allowed: false }, { routes: [{ ...route, requestFormat: "openai.chat_completions" }] }, { routes: [] }]) {
    assert.throws(() => buildCodexCatalog(catalog([model], overrides), { models: [descriptor] }, "fixture"));
  }
  assert.throws(() => buildCodexCatalog(catalog([model, model]), { models: [descriptor] }, "fixture"), /duplicate native model route/);
  assert.throws(() => buildCodexCatalog(catalog([model]), { models: [{ ...descriptor, base_instructions: undefined, model_messages: {} }] }, "fixture"), /no instructions/);
});

test("exact operation offers own eligibility, including request-dependent token prices", () => {
  for (const affordability of ["request-dependent", "exact-covered"]) {
    const result = buildCodexCatalog(catalog([model], { executable: false, offers: [offer(model.id, "http", { affordability })] }), { models: [descriptor] }, "fixture");
    assert.equal(result.catalog.models[0].slug, "sol-alias");
    assert.equal(result.supportsWebsockets, false);
  }
});

test("provider readiness, operation forms and other routes cannot qualify native HTTP Responses", () => {
  for (const mismatch of [
    { eligible: false }, { affordability: "exact-blocked" }, { affordability: undefined },
    { modelId: null }, { modelId: model.upstream }, { modelId: "other/model" },
    { endpoint: "chat_completions" }, { route: "/v1/responses" }, { route: "/v1/native/other/v1/responses" },
    { routeKind: "unified" }, { routeKind: "manifest" }, { routeKind: "playground" },
    { transport: "websocket" }, { policyId: "other-policy" }, { policyGeneration: undefined }, { policyGeneration: "" },
  ]) {
    assert.throws(() => buildCodexCatalog(catalog([model], { offers: [offer(model.id, "http", mismatch)] }), { models: [descriptor] }, "fixture"), /eligible native HTTP Responses route/, JSON.stringify(mismatch));
  }
});

test("an eligible sibling never substitutes for an HTTP-ineligible model", () => {
  const sibling = { ...model, id: "fixture/sibling", upstream: "sibling" };
  const result = buildCodexCatalog(catalog([model, sibling], { offers: [offer(model.id, "websocket"), offer(sibling.id), offer(sibling.id, "websocket")] }), { models: [descriptor] }, "fixture");
  assert.deepEqual(result.catalog.models.map((entry) => entry.slug), ["sibling"]);
  assert.deepEqual(result.skipped, [{ model: model.id, reason: "no eligible native HTTP Responses offer" }]);
  assert.equal(result.supportsWebsockets, true);
});

test("WebSockets require a matching offer for every exported model and the selected HTTP policy generation", () => {
  const sibling = { ...model, id: "fixture/sibling", upstream: "sibling" };
  for (const mismatch of [
    { eligible: false }, { affordability: "exact-blocked" }, { modelId: null }, { modelId: "other/model" },
    { endpoint: "other" }, { route: "/v1/responses" }, { routeKind: "unified" },
    { transport: "http" }, { policyId: "other-policy" }, { policyGeneration: "old-generation" },
  ]) {
    const result = buildCodexCatalog(catalog([model, sibling], { offers: [offer(model.id), offer(sibling.id), offer(model.id, "websocket"), offer(sibling.id, "websocket", mismatch)] }), { models: [descriptor] }, "fixture");
    assert.equal(result.catalog.models.length, 2);
    assert.equal(result.supportsWebsockets, false, JSON.stringify(mismatch));
  }
  const noWireFormat = catalog([model], { routes: [{ ...route, websocket: undefined }] });
  assert.equal(buildCodexCatalog(noWireFormat, { models: [descriptor] }, "fixture").supportsWebsockets, false);
});

test("unknown native descriptors neither invent a model nor disable qualified exported WebSockets", () => {
  const unknown = { id: "fixture/unknown", upstream: "unknown", capabilities: ["llm.responses"] };
  const result = buildCodexCatalog(catalog([model, unknown], { offers: [offer(model.id), offer(model.id, "websocket"), offer(unknown.id)] }), { models: [descriptor] }, "fixture");
  assert.equal(result.supportsWebsockets, true);
  assert.deepEqual(result.catalog.models.map((entry) => entry.slug), ["sol-alias"]);
  assert.deepEqual(result.skipped, [{ model: unknown.id, reason: "no exact native Codex descriptor" }]);
});

test("missing offers and non-key scopes fail explicitly without exposing scope identities", () => {
  assert.throws(() => buildCodexCatalog(catalog([model], { offers: undefined }), { models: [descriptor] }, "fixture"), /update the router/);
  for (const scope of [undefined, { authType: "access", credentialId: "fixture-credential" }, { authType: "proxy_key", credentialId: null }]) {
    assert.throws(() => buildCodexCatalog({ ...catalog([model]), scope }, { models: [descriptor] }, "fixture"), /key-scoped operation catalog/);
  }
  for (const overrides of [{ nativeBaseUrl: null }, { nativeBaseUrl: "/v1" }, { policies: [] }, { policies: ["fixture-policy", "other-policy"] }, { policies: [null] }]) {
    assert.throws(() => buildCodexCatalog(catalog([model], overrides), { models: [descriptor] }, "fixture"), /one key-scoped native policy/);
  }
  const scoped = catalog([model]);
  scoped.scope.principalId = "private-fixture-principal";
  const result = JSON.stringify(buildCodexCatalog(scoped, { models: [descriptor] }, "fixture"));
  for (const value of [scoped.scope.credentialId, scoped.scope.principalId, "fixture-policy", "fixture-generation"]) assert.ok(!result.includes(value));
});

test("ambiguous routes or HTTP policy generations fail instead of selecting the first", () => {
  const otherRoute = { ...route, endpoint: "other-responses", path: "/v2/responses" };
  assert.throws(() => buildCodexCatalog(catalog([model], { routes: [route, otherRoute], offers: [offer(model.id), offer(model.id, "http", { endpoint: otherRoute.endpoint, route: `/v1/native/fixture${otherRoute.path}` })] }), { models: [descriptor] }, "fixture"), /one eligible native HTTP Responses route/);
  for (const models of [[model], [model, { ...model, id: "fixture/sibling", upstream: "sibling" }]]) {
    const offers = [offer(model.id), offer(models.at(-1).id, "http", { policyGeneration: "other-generation" })];
    assert.throws(() => buildCodexCatalog(catalog(models, { offers }), { models: [descriptor] }, "fixture"), /disagree on the key policy generation/);
  }
  const onlyOneEligible = catalog([model], { routes: [otherRoute, route] });
  assert.equal(buildCodexCatalog(onlyOneEligible, { models: [descriptor] }, "fixture").nativeBasePath, "/v1/native/fixture/v1");
});

test("catalog fetch keeps per-model transport qualification without exposing scope or prompts", async (t) => {
  const key = "synthetic-catalog-key";
  const scoped = catalog([model], { offers: [offer(model.id)] });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.href, "https://router.example/v1/catalog");
    assert.equal(options.headers.authorization, `Bearer ${key}`);
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(scoped));
  });
  const producer = t.mock.method(childProcess, "execFileSync", (binary, args, options) => {
    assert.equal(binary, "fixture-codex");
    assert.equal(options.env.CLAWROUTER_API_KEY, undefined);
    return args[0] === "debug" ? JSON.stringify({ models: [descriptor] }) : "codex-cli 0.155.0\n";
  });
  syncBuiltinESMExports();
  try {
    const result = await readCodexCatalog({ routerUrl: "https://router.example", providerId: "fixture", codex: "fixture-codex", env: { CLAWROUTER_API_KEY: key } });
    assert.equal(result.supportsWebsockets, false);
    assert.equal(result.baseUrl, "https://router.example/v1/native/fixture/v1");
    assert.equal(producer.mock.callCount(), 2);
    const { catalog: native, nativeBasePath, ...summary } = result;
    for (const value of [key, scoped.scope.credentialId, "fixture-policy", "fixture-generation", descriptor.base_instructions]) assert.ok(!JSON.stringify(summary).includes(value));
    assert.equal(native.models[0].base_instructions, descriptor.base_instructions);
  } finally { producer.mock.restore(); syncBuiltinESMExports(); }
});
