import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { browserCatalog, catalogTargets, offerKey, resolveCatalogTarget, targetBlocker, targetForm, targetRequest } = await import("../src/catalog-offers.ts");

const scope = { authType: "access", credentialId: null, principalId: "user@example.com" };
const model = { id: "fixture/model", upstream: "model", capabilities: ["llm.responses"], pricing_ref: null, pricing: null,
  supportedReasoningEfforts: ["none", "high"], requestParameters: { responses: { sources: [], checkedAt: "2026-07-06", temperature: "requires_reasoning_none", defaultReasoningEffort: "high" } } };
const offer = { endpoint: "responses", modelId: model.id, transport: "http", routeKind: "unified", route: "/v1/playground/v1/responses", policyId: "team", policyGeneration: "generation-1", eligible: true, affordability: "request-dependent" };
const provider = { id: "fixture", displayName: "Fixture", allowed: true, policies: ["team"], models: [model], offers: [offer], readiness: { reasons: [], missingConfig: [], executable: false } };
const catalog = { version: "clawrouter.client-catalog.v1", observedAt: "2026-07-06T12:00:00Z", scope, providers: [provider] };
const routes = { openaiCompatible: [], manifestProxy: [{ provider: "fixture", endpoint: "responses", route: "/v1/proxy/fixture/responses", methods: ["POST"], requestFormat: "openai.responses" }] };
const draft = { mode: "model", model: "old/wrong", endpoint: "/v1/chat/completions", system: "instructions", prompt: "retained draft", maxTokens: "32", temperature: "", serviceRoute: "", serviceMethod: "POST", servicePath: "", servicePayload: "{}" };

test("catalog scope remains authoritative for empty, malformed, and key-only projections", () => {
  assert.equal(browserCatalog(catalog, scope.principalId), catalog);
  assert.ok(browserCatalog({ ...catalog, providers: [] }, scope.principalId));
  for (const value of [undefined, {}, { ...catalog, scope: { ...scope, principalId: null }, providers: [] }, { ...catalog, scope: { ...scope, principalId: "other@example.com" } }, { ...catalog, scope: { ...scope, authType: "proxy_key" } }, { ...catalog, providers: [{}] }, { ...catalog, providers: [null] }, { ...catalog, providers: [{ ...provider, models: [null] }] }]) assert.equal(browserCatalog(value, scope.principalId), null);
});

test("every routing, policy generation and principal identity field participates in selection", () => {
  const [selected] = catalogTargets(catalog, routes);
  assert.equal(targetBlocker([selected], selected), null);
  for (const change of [{ endpoint: "chat" }, { modelId: null }, { transport: "websocket" }, { routeKind: "playground" }, { route: "/v1/playground/proxy/fixture/responses" }, { policyId: "other" }, { policyGeneration: "generation-2" }]) {
    assert.notEqual(offerKey(scope, provider.id, { ...offer, ...change }), selected.key);
    const next = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [{ ...offer, ...change }] }] }, routes);
    assert.equal(resolveCatalogTarget(next, selected), null);
  }
  for (const change of [{ principalId: "other@example.com" }, { credentialId: "key-id" }, { authType: "proxy_key" }]) assert.notEqual(offerKey({ ...scope, ...change }, provider.id, offer), selected.key);
  assert.notEqual(offerKey(scope, "other-provider", offer), selected.key);
  const refreshed = catalogTargets({ ...catalog, observedAt: "2026-07-07T12:00:00Z" }, routes);
  assert.equal(resolveCatalogTarget(refreshed, selected).observedAt, "2026-07-07T12:00:00Z");
  assert.match(targetBlocker([], selected), /no longer available/);
  assert.equal(selected.offer.modelId, model.id);
});

test("blocked offers retain their reason even when executable model metadata disappears", () => {
  const [selected] = catalogTargets(catalog, routes);
  const blocked = catalogTargets({ ...catalog, providers: [{ ...provider, models: [], offers: [{ ...offer, eligible: false, affordability: "exact-blocked", reasonCode: "provider_budget_exhausted" }] }] }, routes);
  assert.match(targetBlocker(blocked, selected), /provider_budget_exhausted/);
  assert.equal(resolveCatalogTarget(blocked, selected).model, undefined);
  assert.equal(catalogTargets(null, routes).length, 0);
  assert.equal(catalogTargets({ ...catalog, providers: [{ ...provider, offers: [{ ...offer, eligible: undefined }] }] }, routes).length, 0);
});

test("request-dependent offers stay advisory and static routes cannot add choices", () => {
  const targets = catalogTargets(catalog, { ...routes, openaiCompatible: [{ provider: "phantom", models: [{ id: "phantom/first" }] }] });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].blocker, null);
  assert.equal(targets[0].offer.affordability, "request-dependent");
  assert.equal(catalogTargets({ ...catalog, providers: [{ ...provider, offers: [{ ...offer, transport: "websocket" }] }] }, routes).length, 0);
});

test("canonical payload keeps the chosen model and operation and never drops explicit parameters", () => {
  const [target] = catalogTargets(catalog, routes);
  const blank = targetRequest(target, draft);
  assert.equal(blank.payload.model, model.id);
  assert.equal(blank.payload.input[0].content, draft.prompt);
  assert.equal(Object.hasOwn(blank.payload, "temperature"), false);
  assert.equal(blank.assessment.conflicts.length, 0);
  const supplied = targetRequest(target, { ...draft, temperature: "0.7" });
  assert.equal(supplied.payload.temperature, 0.7);
  assert.match(supplied.assessment.conflicts[0].message, /requires reasoning.effort: none/);
  assert.equal(draft.prompt, "retained draft");
});

test("native forms retain operation-specific models, null-model requests, and parameter facts", () => {
  const nativeOffer = { ...offer, routeKind: "playground", route: "/v1/playground/proxy/fixture/responses" };
  const targets = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [nativeOffer, { ...nativeOffer, modelId: null }] }] }, routes);
  assert.equal(targets.length, 2);
  const form = targetForm(draft, targets[0]);
  assert.equal(JSON.parse(form.servicePayload).model, model.upstream);
  const supplied = { ...form, servicePayload: JSON.stringify({ model: model.upstream, input: "hi", temperature: 0.7, reasoning: { effort: "none" } }) };
  assert.equal(targetRequest(targets[0], supplied).assessment.conflicts.length, 0);
  assert.throws(() => targetRequest(targets[0], { ...form, servicePayload: '{"model":"different"}' }), /differs from the selected offer/);
  assert.equal(targetRequest(targets[1], { ...form, servicePayload: '{"model":"opaque","temperature":0.7}' }).assessment.unknown.length, 1);
});

test("renaming a model does not change endpoint-specific parameter assessment", () => {
  const renamed = { ...model, id: "arbitrary/name", requestParameters: { responses: { sources: [], checkedAt: "2026-07-06", temperature: "unsupported" } } };
  const [target] = catalogTargets({ ...catalog, providers: [{ ...provider, models: [renamed], offers: [{ ...offer, modelId: renamed.id }] }] }, routes);
  assert.match(targetRequest(target, { ...draft, temperature: "0" }).assessment.conflicts[0].message, /field presence is not supported/);
  const [unknown] = catalogTargets({ ...catalog, providers: [{ ...provider, models: [{ ...model, requestParameters: undefined }] }] }, routes);
  assert.equal(targetRequest(unknown, { ...draft, temperature: "0" }).assessment.conflicts.length, 0);
  assert.equal(targetRequest(unknown, { ...draft, temperature: "0" }).assessment.unknown.length, 1);
});

test("custom service forms preserve arrays and methods without inventing model fields", () => {
  const custom = { ...offer, endpoint: "service", modelId: null, routeKind: "playground", route: "/v1/playground/proxy/fixture/service" };
  const descriptor = { provider: "fixture", endpoint: "service", route: "/v1/proxy/fixture/service", methods: ["GET", "POST"], pathParams: ["id"], requestFormat: "service.json" };
  const [target] = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [custom] }] }, { ...routes, manifestProxy: [descriptor] });
  const result = targetRequest(target, { ...draft, serviceMethod: "GET", servicePath: "item", servicePayload: '[{"query":"search"}]' });
  assert.deepEqual(result.payload, { method: "GET", pathParams: { id: "item" }, body: [{ query: "search" }] });
  assert.throws(() => targetRequest(target, { ...draft, servicePayload: "{" }), /JSON/);
  const pathOffer = { ...custom, modelId: model.id };
  const [pathTarget] = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [pathOffer] }] }, { ...routes, manifestProxy: [{ ...descriptor, pathParams: ["model"] }] });
  assert.throws(() => targetRequest(pathTarget, { ...draft, servicePath: "other" }), /differs from the selected offer/);
  assert.equal(targetRequest(pathTarget, { ...draft, servicePath: model.upstream }).payload.pathParams.model, model.upstream);
});

test("unified embeddings use registered qualified models and ignore manifest path controls", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../worker/generated/provider-snapshot.json", import.meta.url), "utf8"));
  for (const id of ["openai", "azure-openai"]) {
    const compiled = snapshot.providers.find((item) => item.id === id);
    const embedding = compiled.models.find((item) => item.capabilities.includes("llm.embeddings"));
    const endpoint = compiled.endpoints.find((item) => item.request_format === "openai.embeddings");
    assert.ok(snapshot.model_index[embedding.id]);
    assert.equal(snapshot.model_index[embedding.upstream], undefined);
    const descriptor = { provider: id, endpoint: endpoint.id, route: `/v1/proxy/${id}/${endpoint.id}`, methods: endpoint.methods, pathParams: endpoint.path_params, requestFormat: endpoint.request_format };
    const entry = { ...provider, id, models: [embedding], offers: [{ ...offer, endpoint: endpoint.id, modelId: embedding.id, route: "/v1/playground/v1/embeddings" }] };
    const [target] = catalogTargets({ ...catalog, providers: [entry] }, { ...routes, manifestProxy: [descriptor] });
    const form = targetForm(draft, target);
    assert.equal(form.servicePath, "");
    assert.equal(form.serviceMethod, "POST");
    assert.deepEqual(JSON.parse(form.servicePayload), { model: embedding.id, input: "OpenClaw" });
    assert.deepEqual(targetRequest(target, { ...form, servicePath: "unrelated", serviceMethod: "DELETE" }).payload, { model: embedding.id, input: "OpenClaw" });
    const changedBody = JSON.stringify({ model: embedding.upstream, input: "keep this draft" });
    const changed = { ...form, servicePayload: changedBody };
    assert.throws(() => targetRequest(target, changed), /differs from the selected offer/);
    assert.equal(changed.servicePayload, changedBody);
  }
});

test("concrete scoped path models validate every supplied carrier without requiring a body model", () => {
  const scoped = { ...offer, routeKind: "playground", route: "/v1/playground/proxy/fixture/responses" };
  const [target] = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [scoped] }] }, { ...routes, manifestProxy: [{ ...routes.manifestProxy[0], pathParams: ["model"] }] });
  const form = { ...targetForm(draft, target), servicePath: model.upstream };
  for (const body of [{ input: "path only" }, { model: model.id }, { model: model.upstream }]) assert.deepEqual(targetRequest(target, { ...form, servicePayload: JSON.stringify(body) }).payload.body, body);
  for (const supplied of ["other/model", null, 42]) assert.throws(() => targetRequest(target, { ...form, servicePayload: JSON.stringify({ model: supplied }) }), /differs from the selected offer/);
  assert.throws(() => targetRequest(target, { ...form, servicePath: "other", servicePayload: JSON.stringify({ model: model.id }) }), /differs from the selected offer/);
});

test("custom requests assess exact qualified Astra IDs without rewriting explicit or blank fields", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../worker/generated/provider-snapshot.json", import.meta.url), "utf8"));
  const astra = snapshot.providers.find((item) => item.id === "openai").models.find((item) => item.id === "openai/gpt-6-astra");
  const entry = { ...provider, id: "openai", models: [astra], offers: [{ ...offer, modelId: null, routeKind: "playground", route: "/v1/playground/proxy/openai/responses" }] };
  const [target] = catalogTargets({ ...catalog, providers: [entry] }, { ...routes, manifestProxy: [{ ...routes.manifestProxy[0], provider: "openai" }] });
  assert.equal(target.providerModels, entry.models);
  const explicit = { model: astra.id, input: "retained", temperature: 0.7 };
  const result = targetRequest(target, { ...draft, servicePayload: JSON.stringify(explicit) });
  assert.match(result.assessment.conflicts[0].message, /temperature field presence is not supported/);
  assert.deepEqual(result.payload.body, explicit);
  const blank = { model: astra.id, input: "retained" };
  const omitted = targetRequest(target, { ...draft, servicePayload: JSON.stringify(blank) });
  assert.equal(omitted.assessment.conflicts.length, 0);
  assert.deepEqual(omitted.payload.body, blank);
});

test("custom path metadata uses exact IDs and keeps opaque body precedence and unequal aliases intact", () => {
  const custom = { ...offer, modelId: null, routeKind: "playground", route: "/v1/playground/proxy/fixture/responses" };
  for (const param of ["model", "deployment"]) {
    const [target] = catalogTargets({ ...catalog, providers: [{ ...provider, offers: [custom] }] }, { ...routes, manifestProxy: [{ ...routes.manifestProxy[0], pathParams: [param] }] });
    const form = { ...draft, servicePath: model.id, servicePayload: '{"temperature":0.7}' };
    assert.match(targetRequest(target, form).assessment.conflicts[0].message, /requires reasoning.effort: none/);
    for (const id of ["opaque", model.upstream, ""]) {
      const body = { model: id, temperature: 0.7 };
      const result = targetRequest(target, { ...form, servicePayload: JSON.stringify(body) });
      assert.equal(result.assessment.conflicts.length, 0);
      assert.equal(result.assessment.unknown.length, 1);
      assert.deepEqual(result.payload, { method: "POST", pathParams: { [param]: model.id }, body });
    }
    const body = { model: model.id, input: "valid unequal carriers" };
    const result = targetRequest(target, { ...form, servicePath: model.upstream, servicePayload: JSON.stringify(body) });
    assert.equal(result.assessment.conflicts.length, 0);
    assert.deepEqual(result.payload, { method: "POST", pathParams: { [param]: model.upstream }, body });
  }
});
