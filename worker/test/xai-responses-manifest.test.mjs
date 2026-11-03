import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const manifest = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([manifest]).providers[0];
const input = { model: "grok-4.7", input: "synthetic fixture", max_output_tokens: 1, reasoning: { effort: "low" } };
const receipt = { id: "resp_synthetic", object: "response", model: "grok-4.7", status: "completed", output: [],
  usage: { input_tokens: 3, output_tokens: 2, cost_in_usd_ticks: 158500 } };

async function fixture(t, fixed) {
  const original = snapshot.providers;
  snapshot.providers = original.map(row => row.id === provider.id ? structuredClone(provider) : row);
  t.after(() => { snapshot.providers = original; });
  const policy = { enabled: true, generation: "v1", providers: ["xai"], models: ["xai/grok-4.7"], tenantId: "fixture",
    monthlyBudgetMicros: 20000000, requestCostMicros: fixed ?? null, retainRequestContent: false };
  const records = new Map(), events = [], pending = [], sent = [], ledgerNames = new Set(), budgets = sqlBudgetNamespace(t);
  const rows = () => [...ledgerNames].flatMap(name => budgets.get(name).reservations());
  const env = { XAI_API_KEY: "synthetic-upstream-key", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); }, async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => events.push(event) }, BUDGET_LEDGER: {
    idFromName: name => name, get(name) { ledgerNames.add(name); return budgets.get(name); },
  } };
  const authority = createGrantAuthority(undefined, env), continuations = continuationAuthority(t, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: name => name.startsWith("http-continuations:") ? continuations.get(name) : authority };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "tariff", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "tariff", credential: {
    enabled: true, secretSha256: await sha256Hex("synthetic-tariff"), policyId: "tariff", policyGeneration: "v1",
  } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "xai", enabled: true }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(rows().some(row => fixed === undefined ? row.reserved_micros > 50000 : row.reserved_micros === fixed), "original tariff reservation precedes egress");
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json(), redirect: init.redirect });
    return Response.json(receipt);
  });
  const request = (body = input, proxy = false) => worker.fetch(new Request(
    `https://router.example${proxy ? "/v1/proxy/xai/responses" : "/v1/native/xai/v1/responses"}`, {
      method: "POST", headers: { authorization: "Bearer clawrouter-live-tariff-synthetic-tariff", "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
      body: JSON.stringify(proxy ? { body } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, rows };
}

for (const proxy of [false, true]) test(`declared xAI ${proxy ? "manifest" : "native"} Responses binds inference plus outcome charge and settles the complete bill once`, async t => {
  const f = await fixture(t), response = await f.request(input, proxy);
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), receipt);
  await Promise.all(f.pending); assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].body, input);
  assert.equal(f.sent[0].url, "https://api.x.ai/v1/responses"); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-upstream-key");
  assert.equal(f.sent[0].headers.get("x-api-key"), null); assert.equal(f.sent[0].redirect, "manual");
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 16); assert.equal(f.events[0].cost_basis, "provider_reported");
  assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros > 50000));
});

test("declared xAI hosted tools stay zero-egress under hard-dollar budgets independently of the outcome tariff", async t => {
  const f = await fixture(t);
  for (const type of ["web_search", "x_search", "code_execution", "attachment_search", "collections_search", "view_image", "view_x_video"]) {
    const response = await f.request({ ...input, tools: [{ type }], max_turns: 1, max_tool_calls: 1 });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  }
  assert.equal(f.sent.length, 0);
});

test("declared xAI client functions named x_search remain ordinary inference", async t => {
  const f = await fixture(t), body = { ...input, tools: [{ type: "function", name: "x_search", parameters: { type: "object", properties: {} } }] };
  const response = await f.request(body); assert.equal(response.status, 200); await response.text();
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].body.tools, body.tools);
});

test("declared xAI explicit policy-fixed hosted search preserves its distinct accounting label", async t => {
  const f = await fixture(t, 17), response = await f.request({ ...input, tools: [{ type: "web_search" }] });
  assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 17); assert.equal(f.events[0].cost_basis, "policy_fixed");
});

test("xAI hosted-tool support cannot declare admission or escape its qualified model and outcome contract", () => {
  const changes = [
    m => { m.models.entries.find(model => model.id === "xai/grok-4.7").upstream = "grok-4.3"; },
    m => { m.models.entries.find(model => model.id === "xai/grok-4.7").supportedReasoningEfforts = ["high"]; },
    m => { m.models.entries.find(model => model.id === "xai/grok-4.7").requestParameters.responses.toolCalling = "unsupported"; },
    m => { delete m.endpoints.responses.requestPricing; },
    m => { delete m.models.entries.find(model => model.id === "xai/grok-4.7").pricing.unpricedCosts; },
    m => { m.models.entries.find(model => model.id === "xai/grok-4.7").nativeCapabilities.endpoints.responses.hostedToolAdmission = { version: "clawrouter.hosted-tool-admission.v1", web_search: "admitted" }; },
    m => { m.models.entries.find(model => model.id === "xai/grok-4.7").nativeCapabilities.endpoints.responses.hostedTools = ["x_search"]; },
  ];
  for (const change of changes) { const candidate = structuredClone(manifest); change(candidate); assert.throws(() => compileProviderSnapshot([candidate]), /hosted tools|invalid manifest/, String(change)); }
});
