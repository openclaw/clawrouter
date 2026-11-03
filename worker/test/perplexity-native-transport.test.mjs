import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/perplexity/native-contracts.json", import.meta.url), "utf8"));
const sse = events => events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");

async function fixture(t, { body = wire.search.response, status = 200, stream = false } = {}) {
  // Candidate endpoint contract only. The manifest owner activates these routes;
  // this test does not change or certify the shipped provider catalog.
  const original = snapshot.providers;
  const provider = structuredClone(original.find(provider => provider.id === "perplexity"));
  provider.models = [];
  const template = provider.endpoints[0];
  provider.endpoints = ["search", "agent"].map(kind => {
    const contract = wire.transport[kind];
    const endpoint = { ...template, id: contract.id, path: contract.path, request_format: contract.requestFormat,
      response_format: contract.responseFormat, streaming: contract.streaming };
    if (kind === "search") delete endpoint.modelPassthrough;
    return endpoint;
  });
  provider.capabilities = ["search", "agent"].map(kind => ({ id: wire.transport[kind].capability, endpoint: kind, methods: ["POST"] }));
  snapshot.providers = original.map(row => row.id === provider.id ? provider : row);
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ["perplexity"], models: null, tenantId: "fixture",
    monthlyBudgetMicros: 1000000, requestCostMicros: null, retainRequestContent: false };
  const policies = { fixed: { ...base, requestCostMicros: wire.billing.policyFixedMicros },
    reserve: base, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { PERPLEXITY_API_KEY: "synthetic-upstream-key", POLICY_KV: {
    async get(key, type) {
      const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null;
      return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value);
    },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({
    credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" },
  }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "perplexity", enabled: true }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json() });
    if (!stream) return Response.json(body, { status });
    const bytes = new TextEncoder().encode(body); let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), { status, headers: { "content-type": "text/event-stream" } });
  });
  const request = (kind, input, key = "fixed", native = true) => worker.fetch(new Request(
    native ? `https://router.example/v1/native/perplexity${wire.transport[kind].path}`
      : `https://router.example/v1/proxy/perplexity/${kind}`, {
      method: "POST", headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json" },
      body: JSON.stringify(native ? input : { body: input }),
    }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending };
}

test("Perplexity candidate Search preserves native filters and result bytes on native and internal routes", async t => {
  const f = await fixture(t);
  for (const native of [true, false]) {
    const response = await f.request("search", wire.search.request, "fixed", native);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), wire.search.response);
    assert.deepEqual(f.sent.at(-1).body, wire.search.request);
    assert.equal(f.sent.at(-1).url, wire.transport.origin + wire.transport.search.path);
    assert.equal(f.sent.at(-1).headers.get("authorization"), "Bearer synthetic-upstream-key");
  }
  await Promise.all(f.pending);
  assert.equal(f.events.length, 2);
  for (const event of f.events) {
    assert.equal(event.capability, "web.search");
    assert.equal(event.model, null);
    assert.equal(event.actual_cost_micros, wire.billing.policyFixedMicros);
    assert.equal(event.cost_basis, "policy_fixed");
  }
});

test("Perplexity candidate Agent supports effort-only and explicit model requests without Sonar conversion", async t => {
  const f = await fixture(t, { body: wire.agent.response });
  for (const input of [wire.agent.request, wire.agent.explicitModelRequest]) {
    const response = await f.request("agent", input);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), wire.agent.response);
    assert.deepEqual(f.sent.at(-1).body, input);
    assert.equal(f.sent.at(-1).url, wire.transport.origin + wire.transport.agent.path);
  }
  await Promise.all(f.pending);
  for (const event of f.events) {
    assert.equal(event.actual_cost_micros, wire.billing.policyFixedMicros);
    assert.equal(event.cost_basis, "policy_fixed");
    assert.notEqual(event.actual_cost_micros, wire.billing.agentReportedCostMicros);
  }
});

test("Perplexity candidate Agent preserves typed search-result/text/completion SSE including split UTF-8", async t => {
  const bytes = sse(wire.agent.streamEvents);
  const f = await fixture(t, { body: bytes, stream: true });
  const input = { ...wire.agent.request, stream: true };
  const response = await f.request("agent", input);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), bytes);
  assert.deepEqual(f.sent[0].body, input);
  await Promise.all(f.pending);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, wire.billing.policyFixedMicros);
});

test("Perplexity candidate Agent keeps HTTP-200 stream failure visible after partial output", async t => {
  const bytes = sse(wire.agent.failureEvents);
  const f = await fixture(t, { body: bytes, stream: true });
  const response = await f.request("agent", { ...wire.agent.request, stream: true });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), bytes);
  await Promise.all(f.pending);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].outcome, "provider_error");
});

test("Perplexity candidate Agent and Search fail closed before egress without qualified hard-budget prices", async t => {
  const f = await fixture(t);
  for (const kind of ["search", "agent"]) for (const key of ["reserve", "denied"]) {
    const response = await f.request(kind, wire[kind].request, key);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, key === "reserve" ? "pricing_required" : "provider_not_allowed");
  }
  assert.equal(f.sent.length, 0);
});
