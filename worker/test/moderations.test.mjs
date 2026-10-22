import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture as authorityFixture } from "./http-continuation-fixture.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { providerById, routeCatalog } from "../providers.ts";
const { default: worker } = await import("../index.ts");

const routes = ["/v1/moderations", "/v1/native/openai/v1/moderations", "/v1/proxy/openai/moderations"];
const model = "openai/omni-moderation-latest", grantKey = "oauth/fixture/moderation";
const result = { id: "modr_fixture", model: "omni-moderation-2024-09-26", results: [{ flagged: false, categories: { violence: false }, category_scores: { violence: 0.001 }, category_applied_input_types: { violence: ["text", "image"] } }] };
const wire = JSON.stringify(result, null, 2) + "\n";
async function fixture(t, options = {}) {
  const f = await authorityFixture(t, false, { limit: 1000, fixedCost: null, ...options });
  f.response = () => new Response(wire, { headers: { "content-type": "application/json" } });
  f.call = async (route, payload, headers = {}) => f.request(route === routes[2] ? { model: undefined, input: undefined, body: payload } : { model: undefined, input: undefined, ...payload }, headers, route);
  f.get = path => worker.fetch(new Request("https://router.example" + path, { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil: () => {} });
  return f;
}
for (const route of routes) for (const input of ["synthetic text", ["one", "two"], [{ type: "text", text: "synthetic text" }, { type: "image_url", image_url: { url: "https://example.com/synthetic.png" } }]]) test("moderations preserves native wire and settles free: " + route + " " + JSON.stringify(input), async t => {
  const f = await fixture(t);
  const response = await f.call(route, { model: route === routes[1] ? "omni-moderation-latest" : model, input });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://api.openai.com/v1/moderations");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-environment-key");
  assert.deepEqual(f.sent[0].body, { model: "omni-moderation-latest", input });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].capability, "llm.moderations");
  assert.equal(f.events[0].model, model); assert.equal(f.events[0].actual_cost_micros, 0); assert.equal(f.events[0].reserved_cost_micros, 0);
  assert.equal(f.events[0].cost_basis, "none"); assert.equal(f.events[0].content_retained, false);
  assert.ok(!JSON.stringify(f.events).includes("synthetic text"));
});
for (const route of routes) test("omitted native moderation model resolves default before policy checking: " + route, async t => {
  const f = await fixture(t, { fixedCost: 99 });
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, models: [model] } });
  const response = await f.call(route, { input: "default model fixture" });
  assert.equal(response.status, 200, await response.clone().text()); await f.consume(response);
  assert.equal(f.sent[0].body.model, "omni-moderation-latest"); assert.equal(f.events[0].actual_cost_micros, 0, "free moderation is not charged a fixed generation tariff");
});
for (const kind of ["subscription", "oauth", "api_key"]) test("moderation accepts only API-key grants: " + kind, async t => {
  const f = await fixture(t);
  await putGrantCredentials(f.env, grantKey, { provider: "openai", kind, enabled: true, ...(kind === "api_key" ? { credential: "synthetic-moderation-key" } : { accessToken: "synthetic-moderation-token", accountId: "fixture-account" }) });
  const response = await f.call(routes[0], { model, input: "fixture" });
  assert.equal(response.status, kind === "api_key" ? 200 : 503, await response.clone().text()); await f.consume(response);
  assert.equal(f.sent.length, kind === "api_key" ? 1 : 0);
  if (kind === "api_key") { assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-moderation-key"); assert.equal(f.events[0].grant_key, grantKey); }
});
for (const mode of ["reserve", "soft"]) test("free moderation remains zero under fixed policy and forged usage: " + mode, async t => {
  const f = await fixture(t, { fixedCost: 99 });
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, budgetMode: mode } });
  f.response = () => Response.json({ ...result, usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
  const response = await f.call(routes[0], { model, input: "fixture" }); assert.equal(response.status, 200); await f.consume(response);
  assert.equal(f.events[0].actual_cost_micros, 0); assert.equal(f.events[0].cost_basis, "none");
});
for (const [kind, status] of [["missing_auth", 401], ["revoked", 403], ["provider_policy", 403], ["model_policy", 403], ["wrong_model", 400], ["unknown_model", 400]]) test("moderation rejects " + kind + " without egress", async t => {
  const f = await fixture(t), headers = {}, payload = { model, input: "fixture" };
  if (kind === "missing_auth") headers.authorization = "";
  if (kind === "revoked") await f.mutateCredential({ operation: "update", credentialId: "fixture", credential: { ...f.credential, enabled: false } });
  if (kind.endsWith("policy")) await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, ...(kind === "provider_policy" ? { providers: ["anthropic"] } : { models: ["openai/gpt-6-astra"] }) } });
  if (kind === "wrong_model") payload.model = "openai/gpt-6-astra";
  if (kind === "unknown_model") payload.model = "openai/not-a-moderation-model";
  const response = await f.call(routes[1], payload, headers);
  assert.equal(response.status, status, await response.clone().text()); await f.consume(response); assert.equal(f.sent.length, 0);
});
for (const status of [400, 429, 500]) test("moderation preserves upstream rejection and zero settlement: " + status, async t => {
  const f = await fixture(t), body = JSON.stringify({ error: { code: "synthetic_upstream_error" } });
  f.response = () => new Response(body, { status, headers: { "content-type": "application/json", "retry-after": "30" } });
  const response = await f.call(routes[0], { model, input: "fixture" });
  assert.equal(response.status, status); assert.equal(response.headers.get("retry-after"), "30"); assert.equal(await f.consume(response), body);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
});
test("moderation rate-limit feedback blocks the next call before egress", async t => {
  const f = await fixture(t);
  await putGrantCredentials(f.env, grantKey, { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-moderation-key" });
  f.response = () => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "60" } });
  await f.consume(await f.call(routes[0], { model, input: "fixture" }));
  const response = await f.call(routes[0], { model, input: "fixture" }); assert.equal(response.status, 429);
  const body = JSON.parse(await f.consume(response)); assert.equal(body.error.code, "upstream_grant_pool_unavailable");
  assert.ok(Number(response.headers.get("retry-after")) > 0); assert.equal(f.sent.length, 1);
});
test("moderation transport failure still records zero exactly once", async t => {
  const f = await fixture(t, { fixedCost: 99 }); f.response = () => { throw new Error("synthetic upstream failure"); };
  const response = await f.call(routes[0], { model, input: "fixture" }); assert.equal(response.status, 502); await f.consume(response);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
});
test("moderation models expose only their native capability and API-key offers", async t => {
  const f = await fixture(t), provider = providerById("openai");
  for (const id of [model, "openai/omni-moderation-2024-09-26"]) {
    const entry = provider.models.find(item => item.id === id); assert.ok(entry); assert.deepEqual(entry.capabilities, ["llm.moderations"]);
    assert.equal(entry.pricing, null, "free operation does not invent a token ceiling");
    assert.deepEqual(entry.nativeCapabilities.endpoints.moderations.input, ["text", "image"]);
  }
  const catalogRoute = routeCatalog().manifestProxy.find(item => item.provider === "openai" && item.endpoint === "moderations");
  assert.deepEqual(catalogRoute.models.map(item => item.id), [model, "openai/omni-moderation-2024-09-26"]);
  const response = await f.get("/v1/catalog"); assert.equal(response.status, 200, await response.clone().text());
  const catalog = (await response.json()).providers.find(item => item.id === "openai");
  const offers = catalog.offers.filter(item => item.endpoint === "moderations"); assert.ok(offers.length); assert.ok(offers.some(item => item.eligible));
  await putGrantCredentials(f.env, grantKey, { provider: "openai", kind: "subscription", enabled: true, accessToken: "synthetic-moderation-token", accountId: "fixture-account" });
  const subscription = (await (await f.get("/v1/catalog")).json()).providers.find(item => item.id === "openai");
  assert.ok(subscription.offers.filter(item => item.endpoint === "moderations").every(item => !item.eligible));
});
