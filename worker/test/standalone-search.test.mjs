import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKeys } from "./http-continuation-fixture.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
const { default: handler } = await import("../index.ts");

const path = "/v1/native/openai/v1/alpha/search";
const wire = '{ "encrypted_output": "fixture-ciphertext", "output": "fixture text 【turn0search0】", "future": {"keep":true} }\n';
async function setup(t, { searchCost = 7, ...options } = {}) {
  const f = await fixture(t, false, { limit: 100_000, ...options });
  if (searchCost !== null) {
    f.policy.requestCostsMicros = { "search.web": searchCost };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.response = () => new Response(wire, { headers: { "content-type": "application/json" } });
  f.search = (body = {}, headers = {}, route = path) => {
    const payload = { model: "gpt-6-astra", id: "session-fixture", commands: { search_query: [{ q: "synthetic query" }] }, ...body };
    return f.request(route.startsWith("/v1/proxy/") ? { body: payload } : payload, headers, route);
  };
  return f;
}
async function expect(f, response, status, code) {
  const text = await f.consume(response);
  assert.equal(response.status, status, text);
  if (code) assert.equal(JSON.parse(text).error.code, code);
  return text;
}
test("native search preserves wire output, namespaces the session, and settles fixed budgets once", async t => {
  const f = await setup(t), settings = { external_web_access: false, filters: { allowed_domains: ["example.com"] } };
  assert.equal(await expect(f, await f.search({ settings }), 200), wire);
  assert.equal(f.sent[0].url, "https://api.openai.com/v1/alpha/search");
  assert.notEqual(f.sent[0].body.id, "session-fixture");
  assert.match(f.sent[0].body.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.sent[0].body.settings, settings);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-environment-key");
  assert.equal(f.events[0].capability, "search.web"); assert.equal(f.events[0].actual_cost_micros, 7); assert.equal(f.events[0].cost_basis, "policy_fixed");
  assert.equal(f.events[0].input_tokens, null);
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations();
    assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 7);
  }
  const rows = f.bindings().flatMap(([, state]) => state.db.prepare("SELECT * FROM http_continuations").all());
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("session-fixture"));
  assert.ok(!JSON.stringify(f.events).includes("synthetic query")); assert.ok(!JSON.stringify(f.events).includes("fixture-ciphertext"));
});
for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) test(`qualified search model preserves routing, admission and fixed billing: ${model}`, async t => {
  const f = await setup(t);
  await expect(f, await f.search({ model }), 200);
  assert.equal(f.sent[0].body.model, model);
  assert.equal(f.events[0].model, `openai/${model}`);
  assert.equal(f.events[0].actual_cost_micros, 7);
  assert.equal(f.events[0].cost_basis, "policy_fixed");
  const response = await handler.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(provider => provider.id === "openai");
  const offer = provider.offers.find(offer => offer.endpoint === "standalone_search" && offer.modelId === `openai/${model}` && offer.routeKind === "native");
  assert.equal(offer?.eligible, true);
  assert.equal(f.sent.length, 1, "discovery makes no paid requests");
});
test("resume and parallel requests retain the same namespace after authority restart", async t => {
  const f = await setup(t);
  await Promise.all([f.search(), f.search()].map(async request => expect(f, await request, 200)));
  for (const [, state] of f.bindings()) state.restart();
  await expect(f, await f.search({ commands: { open: [{ ref_id: "turn0search0" }] } }), 200);
  assert.equal(new Set(f.sent.map(request => request.body.id)).size, 1);
});
test("parallel first calls cannot bind one session to different project owners", async t => {
  const f = await setup(t);
  const responses = await Promise.all([f.search({}, { "OpenAI-Project": "fixture-a" }), f.search({}, { "OpenAI-Project": "fixture-b" })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  await Promise.all(responses.map(response => f.consume(response))); assert.equal(f.sent.length, 1);
});
test("expired local ownership cannot dispatch an old page reference", async t => {
  const f = await setup(t); await expect(f, await f.search(), 200);
  for (const [, state] of f.bindings()) state.db.prepare("UPDATE http_continuations SET expires_at_ms = 0").run();
  await expect(f, await f.search({ commands: { open: [{ ref_id: "turn0search0" }] } }), 409, "search_restart_required");
  assert.equal(f.sent.length, 1);
});
test("callers sharing an upstream account cannot select each other's search namespace", async t => {
  const f = await setup(t);
  await expect(f, await f.search(), 200);
  await f.mutateCredential({ operation: "create", credentialId: "second", credential: f.credential });
  const headers = { authorization: "Bearer clawrouter-live-second-fixture-secret" };
  await expect(f, await f.search({ commands: { open: [{ ref_id: "turn0search0" }] } }, headers), 409, "search_restart_required");
  await expect(f, await f.search({}, headers), 200);
  assert.notEqual(f.sent[0].body.id, f.sent[1].body.id);
});
for (const mutation of ["environment", "project", "policy", "grant"]) test(`search ${mutation} owner change requires a new session`, async t => {
  const f = await setup(t);
  if (mutation === "grant") await putGrantCredentials(f.env, grantKeys[0], { provider: "openai", kind: "api_key", credential: "fixture-original", enabled: true });
  await expect(f, await f.search(), 200);
  const headers = {};
  if (mutation === "environment") f.env.OPENAI_API_KEY = "fixture-replacement";
  if (mutation === "project") headers["OpenAI-Project"] = "fixture-other-project";
  if (mutation === "policy") {
    f.policy.generation = "g2"; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    await f.mutateCredential({ operation: "put", credentialId: "fixture", credential: { ...f.credential, policyGeneration: "g2" } });
  }
  if (mutation === "grant") await putGrantCredentials(f.env, grantKeys[0], { ...f.values.get(grantKeys[0]), credential: "fixture-replacement" }, true);
  await expect(f, await f.search({}, headers), 409, "search_restart_required");
  assert.equal(f.sent.length, 1);
});
test("revoked caller and exhausted budgets cannot dispatch search", async t => {
  const f = await setup(t, { limit: 7 });
  await expect(f, await f.search(), 200);
  await expect(f, await f.search(), 402, "budget_exhausted");
  await f.mutateCredential({ operation: "put", credentialId: "fixture", credential: { ...f.credential, enabled: false } });
  await expect(f, await f.search(), 403, "proxy_key_revoked");
  assert.equal(f.sent.length, 1);
});
for (const fixedCost of [null, 0, 1, 1000]) test(`general request price cannot activate search on uncapped policies (${fixedCost})`, async t => {
  const f = await setup(t, { fixedCost, searchCost: null, limit: null });
  for (const route of [path, "/v1/proxy/openai/standalone_search"]) {
    await expect(f, await f.search({}, {}, route), 400, "pricing_required");
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.bindings().length, 0, "denied search creates no session ownership");
  assert.ok(f.events.every(event => event.actual_cost_micros === 0));
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
  f.response = () => Response.json({ object: "response", id: "resp_legacy", status: "completed", service_tier: "default", output: [], usage: { input_tokens: 10, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
  await expect(f, await f.request({ max_output_tokens: 32 }), 200);
  assert.equal(f.events.at(-1).cost_basis, fixedCost === null ? "manifest_pricing" : "policy_fixed");
  if (fixedCost !== null) assert.equal(f.events.at(-1).actual_cost_micros, fixedCost);
});
for (const searchCost of [null, 0, 7]) test(`catalog and dispatch agree on search-specific opt-in despite a general tariff (${searchCost})`, async t => {
  const f = await setup(t, { fixedCost: 1000, searchCost });
  const response = await handler.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(provider => provider.id === "openai");
  const offer = provider.offers.find(offer => offer.endpoint === "standalone_search" && offer.modelId === "openai/gpt-6-astra" && offer.routeKind === "native");
  assert.equal(offer.eligible, searchCost !== null);
  if (searchCost === null) assert.equal(offer.reasonCode, "pricing_required");
  assert.equal(f.sent.length, 0, "discovery makes no paid calls");
  await expect(f, await f.search(), searchCost === null ? 400 : 200, searchCost === null ? "pricing_required" : undefined);
  if (searchCost !== null) assert.equal(f.events[0].actual_cost_micros, searchCost);
});
test("another capability's explicit price cannot activate standalone search", async t => {
  const f = await setup(t, { fixedCost: 1, searchCost: null });
  f.policy.requestCostsMicros = { "llm.responses": 7 };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await expect(f, await f.search(), 400, "pricing_required");
  assert.equal(f.sent.length, 0);
});
test("removing the search tariff disables existing and new search sessions despite a general price", async t => {
  const f = await setup(t);
  await expect(f, await f.search(), 200);
  f.policy.requestCostsMicros = null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const response = await handler.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil() {} });
  const offers = (await response.json()).providers.find(provider => provider.id === "openai").offers.filter(offer => offer.endpoint === "standalone_search");
  assert.ok(offers.length > 0 && offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  await expect(f, await f.search({ commands: { open: [{ ref_id: "turn0search0" }] } }), 400, "pricing_required");
  await expect(f, await f.search({ id: "new-session" }), 400, "pricing_required");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.events.map(event => event.actual_cost_micros), [7, 0, 0]);
});
test("authority failure prevents dispatch instead of creating unbound search state", async t => {
  const f = await setup(t);
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => { if (new URL(request.url).pathname === "/http-continuations") throw new Error("fixture authority outage"); };
  await expect(f, await f.search(), 503, "search_state_unavailable"); assert.equal(f.sent.length, 0);
});
test("multi-account pools are rejected and HTTP failures never trigger failover", async t => {
  const f = await setup(t);
  for (const key of grantKeys) await putGrantCredentials(f.env, key, { provider: "openai", kind: "api_key", credential: "fixture-account", enabled: true });
  await expect(f, await f.search(), 409, "search_account_unqualified"); assert.equal(f.sent.length, 0);
});
test("a bound single account's HTTP 503 is preserved without retry", async t => {
  const f = await setup(t);
  await putGrantCredentials(f.env, grantKeys[0], { provider: "openai", kind: "api_key", credential: "fixture-account", enabled: true });
  f.response = () => Response.json({ error: { code: "busy" } }, { status: 503 });
  await expect(f, await f.search(), 503, "busy"); assert.equal(f.sent.length, 1);
});
test("tool-level HTTP 200 errors are preserved instead of rewritten as success text", async t => {
  const f = await setup(t); await expect(f, await f.search(), 200);
  f.response = () => Response.json({ encrypted_output: "fixture", output: "Invalid reference: turn0search0" });
  const output = JSON.parse(await expect(f, await f.search({ commands: { find: [{ ref_id: "turn0search0", pattern: "fixture" }] } }), 200));
  assert.match(output.output, /Invalid reference/);
  assert.equal(f.events[1].actual_cost_micros, 7, "a successful HTTP request retains its configured tariff even when the tool reports an error");
});

test("an in-flight search settles its admitted tariff when the policy map changes", async t => {
  const f = await setup(t, { fixedCost: null });
  f.policy.requestCostsMicros = { "search.web": 7 };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.response = async () => { entered.resolve(); await release.promise; return new Response(wire, { headers: { "content-type": "application/json" } }); };
  const pending = f.search(); await entered.promise;
  f.policy.requestCostsMicros = { "search.web": 19 };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  release.resolve(); await expect(f, await pending, 200);
  assert.equal(f.events[0].reserved_cost_micros, 7); assert.equal(f.events[0].actual_cost_micros, 7);
  await expect(f, await f.search(), 200);
  assert.equal(f.events[1].reserved_cost_micros, 19); assert.equal(f.events[1].actual_cost_micros, 19);
});
for (const body of [{ id: "" }, { id: {} }, { commands: {} }, { commands: { screenshot: [{ ref_id: "https://example.com", pageno: 0 }] } }, { commands: { click: [{ ref_id: "turn0search0", id: -1 }] } }, { model: "gpt-5.5" }]) test(`invalid or unqualified search is rejected before dispatch: ${JSON.stringify(body)}`, async t => {
  const f = await setup(t); const response = await f.search(body);
  await expect(f, response, 400); assert.equal(f.sent.length, 0);
});

for (const price of [0, 19]) test(`search-only tariff preserves token inference and exact search budgets (${price})`, async t => {
  const f = await setup(t, { fixedCost: null });
  f.policy.requestCostsMicros = { "search.web": price };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const searchResponse = f.response;
  f.response = () => Response.json({ object: "response", id: "resp_priced", status: "completed", service_tier: "default", output: [], usage: { input_tokens: 10, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
  await expect(f, await f.request({ max_output_tokens: 32 }), 200);
  const inference = f.events[0];
  assert.equal(inference.cost_basis, "manifest_pricing"); assert.ok(inference.actual_cost_micros > 0);
  f.response = searchResponse;
  await expect(f, await f.search(), 200);
  assert.equal(f.events[1].actual_cost_micros, price); assert.equal(f.events[1].reserved_cost_micros, price);
  assert.equal(f.events[1].cost_basis, "policy_fixed");
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations();
    assert.equal(rows.filter(row => row.reserved_micros === price).length, 1);
    assert.ok(rows.every(row => row.settled === 1));
  }
  f.policy.monthlyBudgetMicros = inference.actual_cost_micros + price + Math.max(0, price - 1);
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const catalog = await handler.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil() {} });
  const offer = (await catalog.json()).providers.find(p => p.id === "openai").offers.find(o => o.endpoint === "standalone_search" && o.modelId === "openai/gpt-6-astra");
  assert.equal(offer.eligible, price === 0);
  const sent = f.sent.length;
  await expect(f, await f.search(), price === 0 ? 200 : 402, price === 0 ? undefined : "budget_exhausted");
  assert.equal(f.sent.length, sent + (price === 0 ? 1 : 0));
});
