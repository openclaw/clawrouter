import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot } = await import("../providers.ts");
const networkFetch = globalThis.fetch;
const sol = "openai/gpt-6.1-sol";
const requestBody = { model: sol, input: "synthetic search", service_tier: "default", tools: [{ type: "web_search" }], max_output_tokens: 32 };

async function fixture(t) {
  const base = { enabled: true, generation: "v1", providers: ["openai"], models: [sol], tenantId: "fixture", monthlyBudgetMicros: 10000000, requestCostMicros: null, retainRequestContent: false };
  const policies = { soft: { ...base, budgetMode: "soft" }, reserve: base, unmetered: { ...base, monthlyBudgetMicros: null }, fixed: { ...base, requestCostMicros: 7 }, denied: { ...base, grantRouting: { eligibleGrants: { openai: [] } } }, other: { ...base, models: ["openai/tts-1"] } };
  const records = new Map(), events = [], pending = [], ledgerCalls = [], sent = [];
  const hooks = { streaming: false, closed: Promise.withResolvers() };
  const ledger = sqlBudgetNamespace(t);
  const env = { OPENAI_API_KEY: "synthetic-upstream-only", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: { ...ledger, get: name => ({ fetch(url, init) { ledgerCalls.push(new URL(url).pathname); return ledger.get(name).fetch(url, init); } }) } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  const call = (path, body) => authorityCall(env, path, body);
  await call("/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await call("/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" } }))));
  await call("/connections/initialize-all", [{ providerId: "openai", enabled: true }]);
  const upstreamServer = createServer(async (incoming, outgoing) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    sent.push({ path: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (hooks.streaming) {
      outgoing.on("close", () => hooks.closed.resolve());
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"synthetic partial"}\n\n');
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "synthetic result" }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  upstreamServer.listen(0, "127.0.0.1"); await once(upstreamServer, "listening");
  const upstream = t.mock.method(globalThis, "fetch", (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    return networkFetch("http://127.0.0.1:" + upstreamServer.address().port + "/v1/responses", init);
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const response = await worker.fetch(new Request("https://router.example" + incoming.url, { method: incoming.method, headers: incoming.headers, ...(incoming.method === "GET" ? {} : { body: Buffer.concat(chunks) }) }), env, { waitUntil: promise => pending.push(promise) });
      const bytes = Buffer.from(await response.arrayBuffer()); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(bytes);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const s of [server, upstreamServer]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } await Promise.all(pending); });
  const headers = key => key ? { authorization: "Bearer clawrouter-live-" + key + "-synthetic-" + key } : {};
  const get = key => networkFetch("http://127.0.0.1:" + server.address().port + "/v1/catalog", { headers: headers(key) });
  const post = (key, body = requestBody) => networkFetch("http://127.0.0.1:" + server.address().port + "/v1/responses", { method: "POST", headers: { ...headers(key), "content-type": "application/json" }, body: JSON.stringify(body) });
  const handlerPost = (key, body) => worker.fetch(new Request("https://router.example/v1/responses", { method: "POST", headers: { ...headers(key), "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: promise => pending.push(promise) });
  return { env, call, get, post, handlerPost, hooks, sent, upstream, ledgerCalls, events, pending };
}

async function catalog(f, key) {
  const response = await f.get(key);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.equal(body.scope.credentialId, key);
  return body.providers.find(provider => provider.id === "openai");
}
const offer = provider => provider.offers.find(row => row.modelId === sol && row.endpoint === "responses" && row.transport === "http" && row.routeKind === "unified" && row.route === "/v1/responses");

// Native W-N1 consumes both facts, never support by itself.
function nativeConsumerFixture(provider) {
  const model = provider.models.find(row => row.id === sol), route = offer(provider);
  return provider.id === "openai" && model?.nativeCapabilities?.version === "clawrouter.native-capabilities.v1"
    && model.nativeCapabilities.endpoints.responses?.hostedTools?.includes("web_search") === true
    && route?.eligible === true && route.hostedToolAdmission?.version === "clawrouter.hosted-tool-admission.v1" && route.hostedToolAdmission.web_search === "admitted";
}

test("authenticated HTTP catalog and dispatch agree for soft, reserve, unmetered and fixed keys without cache bleed", async t => {
  const f = await fixture(t);
  for (const key of ["soft", "reserve", "soft", "unmetered", "fixed", "reserve"]) {
    const provider = await catalog(f, key), row = offer(provider);
    assert.deepEqual(provider.models.find(model => model.id === sol).nativeCapabilities.endpoints.responses.hostedTools, ["web_search"]);
    assert.equal(row.eligible, true);
    assert.deepEqual(row.hostedToolAdmission, { version: "clawrouter.hosted-tool-admission.v1", web_search: key === "reserve" ? "pricing_required" : "admitted" });
    assert.equal(nativeConsumerFixture(provider), key !== "reserve");
    const before = f.sent.length, reserves = f.ledgerCalls.filter(path => path === "/reserve").length;
    const response = await f.post(key);
    assert.equal(response.status, key === "reserve" ? 400 : 200, await response.clone().text());
    if (key === "reserve") {
      assert.equal((await response.json()).error.code, "pricing_required");
      assert.equal(f.sent.length, before); assert.equal(f.ledgerCalls.filter(path => path === "/reserve").length, reserves);
    } else {
      assert.equal((await response.json()).output[0].content[0].text, "synthetic result");
      assert.equal(f.sent.length, before + 1);
      assert.deepEqual(f.sent.at(-1), { path: "/v1/responses", authorization: "Bearer synthetic-upstream-only", body: { ...requestBody, model: "gpt-6.1-sol" } });
    }
    assert.ok(provider.offers.filter(other => other !== row).every(other => other.hostedToolAdmission === undefined), "no native, websocket, model-less or other-endpoint admission");
  }
  await Promise.all(f.pending);
  assert.equal(f.events.find(event => event.policy_id === "fixed").actual_cost_micros, 7);
  assert.equal(f.events.find(event => event.policy_id === "unmetered").cost_basis, "unpriced_usage");
});

test("support never authorizes an ineligible grant, model or revoked key", async t => {
  const f = await fixture(t);
  for (const key of ["denied", "other"]) {
    const provider = await catalog(f, key);
    assert.ok(provider.offers.every(row => row.hostedToolAdmission === undefined));
    assert.equal(nativeConsumerFixture(provider), false);
    const response = await f.post(key);
    assert.equal(response.status, key === "denied" ? 503 : 403);
    assert.equal((await response.json()).error.code, key === "denied" ? "upstream_grant_pool_unavailable" : "model_not_allowed");
  }
  assert.equal(nativeConsumerFixture(await catalog(f, "soft")), true);
  await f.call("/credentials/mutate", { operation: "revoke", scope: "admin", credentialId: "soft", actor: { auth: "admin_token", role: "admin", email: "admin@example.com" } });
  assert.equal((await f.get("soft")).status, 403);
  assert.equal((await f.post("soft")).status, 403);
  assert.equal((await f.get(null)).status, 401);
  assert.equal(f.sent.length, 0);
});

test("unknown, future, malformed and endpoint-mismatched hosted support stays absent in public HTTP catalog", async t => {
  const f = await fixture(t), model = snapshot.providers.find(provider => provider.id === "openai").models.find(model => model.id === sol);
  const original = model.nativeCapabilities; t.after(() => { model.nativeCapabilities = original; });
  for (const mutate of [
    facts => { delete facts.endpoints.responses.hostedTools; },
    facts => { facts.version = "clawrouter.native-capabilities.v2"; },
    facts => { facts.endpoints.responses.hostedTools = "web_search"; },
    facts => { facts.endpoints.responses.hostedTools = ["future_tool"]; },
    facts => { facts.endpoints.responses.sources = []; },
    facts => { facts.endpoints.chat_completions.hostedTools = ["web_search"]; delete facts.endpoints.responses.hostedTools; },
  ]) {
    model.nativeCapabilities = structuredClone(original); mutate(model.nativeCapabilities);
    const provider = await catalog(f, "soft");
    assert.equal(nativeConsumerFixture(provider), false);
    assert.ok(provider.offers.every(row => row.hostedToolAdmission === undefined));
    for (const facts of Object.values(provider.models[0].nativeCapabilities.endpoints)) assert.equal(facts.hostedTools, undefined);
  }
  assert.equal(f.sent.length, 0, "catalog never probes provider");
});

// The catalog fact does not bypass normal streaming cancellation or fabricate usage.
test("admitted hosted search preserves cancellation at the real handler/upstream HTTP boundary", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal(nativeConsumerFixture(await catalog(f, "unmetered")), true);
  f.hooks.streaming = true;
  const response = await f.handlerPost("unmetered", { ...requestBody, stream: true });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read(); assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /synthetic partial/);
  await reader.cancel();
  await f.hooks.closed.promise; await Promise.all(f.pending);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].authorization, "Bearer synthetic-upstream-only");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, "client_error");
  assert.equal(f.events[0].input_tokens, null); assert.equal(f.events[0].output_tokens, null);
  assert.equal(f.events[0].actual_cost_micros, 0);
});
