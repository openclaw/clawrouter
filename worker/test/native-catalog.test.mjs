import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";

const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot } = await import("../providers.ts");
const networkFetch = globalThis.fetch;
const sol = "openai/gpt-6.1-sol";

async function fixture(t) {
  const policy = { enabled: true, generation: "v1", providers: ["openai"], models: null, tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false,
    serviceTiers: { allowed: ["default", "priority", "flex", "ultrafast"] } };
  const limited = { ...policy, models: [sol], serviceTiers: { allowed: ["priority"], models: { [sol]: ["default", "priority"] } } };
  const secrets = { full: "synthetic-full-catalog", limited: "synthetic-limited-catalog" };
  const credentials = await Promise.all(Object.entries(secrets).map(async ([credentialId, secret]) => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex(secret), policyId: credentialId, policyGeneration: "v1", ...(credentialId === "limited" ? { serviceTiers: ["default", "ultrafast"] } : {}) } })));
  const records = new Map(), calls = [], pending = [];
  const env = { OPENAI_API_KEY: "synthetic-upstream-only", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async () => {} }, BUDGET_LEDGER: { get() { throw new Error("unmetered catalog must not reserve or observe budgets"); } } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch(url, init) { calls.push(new URL(url).pathname); return authority.fetch(url, init); } }) };
  const call = (path, body) => authorityCall(env, path, body);
  await call("/policies/initialize-all", [{ policyId: "full", policy }, { policyId: "limited", policy: limited }]);
  await call("/credentials/initialize-all", credentials);
  await call("/connections/initialize-all", [{ providerId: "openai", enabled: true }]);
  calls.length = 0;
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("catalog must not probe upstream or refresh credentials"); });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const method = incoming.method;
      const response = await worker.fetch(new Request("https://router.example" + incoming.url, { method, headers: incoming.headers, ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }) }), env, { waitUntil: promise => pending.push(promise) });
      const bytes = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(bytes);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all(pending); });
  const get = (key = "full", path = "/v1/catalog") => networkFetch("http://127.0.0.1:" + server.address().port + path, { headers: key ? { authorization: "Bearer clawrouter-live-" + key + "-" + (secrets[key] ?? "incorrect") } : {} });
  const post = (key, path, body) => networkFetch("http://127.0.0.1:" + server.address().port + path, { method: "POST", headers: { authorization: "Bearer clawrouter-live-" + key + "-" + secrets[key], "content-type": "application/json" }, body: JSON.stringify(body) });
  return { env, records, policy, limited, credentials, authority, call, calls, get, post, upstream };
}

async function catalog(f, key = "full") {
  const response = await f.get(key);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.scope.credentialId, key);
  return body.providers.find(provider => provider.id === "openai");
}

test("public same-key HTTP catalog carries authoritative input and context without guessing unknown models", async t => {
  const f = await fixture(t), provider = await catalog(f);
  const model = provider.models.find(model => model.id === sol);
  assert.equal(model.nativeCapabilities.version, "clawrouter.native-capabilities.v1");
  for (const endpoint of ["responses", "chat_completions"]) {
    const facts = model.nativeCapabilities.endpoints[endpoint];
    assert.deepEqual(facts.input, ["text", "image"]);
    assert.equal(facts.contextWindow, 1050000);
    assert.equal(facts.contextTokens, 272000);
    assert.equal(facts.maxOutputTokens, 128000);
    assert.equal(facts.inference.chat, true);
    assert.equal(facts.inference.decision, undefined);
  }
  assert.deepEqual(provider.models.find(model => model.id === "openai/tts-1").nativeCapabilities.endpoints.speech.input, ["text"]);
  assert.equal(provider.models.find(model => model.id === "openai/gpt-4.1-mini").nativeCapabilities, undefined, "undeclared facts stay unknown even for recognizable names");
  assert.equal(model.requestParameters.responses.toolCalling, "supported");
  assert.equal(model.requestParameters.chat_completions.toolCalling, "unsupported");
  assert.equal(model.pricing.maxInputTokens, 922000, "native context must not rewrite the budget envelope");
  assert.ok(provider.offers.filter(offer => offer.modelId === sol).every(offer => offer.eligible));
  assert.ok(f.calls.every(path => path === "/admission/resolve"), "discovery performs no authority mutations");
});

test("catalog tier permission is offer/key scoped, preserves model support, and never survives revoked auth", async t => {
  const f = await fixture(t);
  for (const key of ["full", "limited", "full"]) {
    const provider = await catalog(f, key), model = provider.models.find(model => model.id === sol);
    assert.deepEqual(model.nativeCapabilities.endpoints.responses.supportedServiceTiers, ["default", "priority", "flex", "ultrafast"]);
    const offers = provider.offers.filter(offer => offer.modelId === sol && offer.endpoint === "responses");
    assert.ok(offers.length > 0);
    for (const offer of offers) assert.deepEqual(offer.permittedServiceTiers, key === "full" ? ["default", "priority", "flex", "ultrafast"] : ["default"]);
    if (key === "limited") assert.deepEqual(provider.models.map(model => model.id), [sol]);
    assert.ok(provider.offers.filter(offer => offer.modelId === null).every(offer => offer.permittedServiceTiers === undefined), "unknown passthrough is not declared tier capable");
  }
  assert.equal((await f.get(null)).status, 401);
  assert.equal((await f.get("missing")).status, 401);
  const revoked = await f.call("/credentials/mutate", { operation: "revoke", scope: "admin", credentialId: "full", actor: { auth: "admin_token", role: "admin", email: "admin@example.com" } });
  assert.equal(revoked.outcome, "updated");
  assert.equal((await f.get("full")).status, 403);
});

test("subscription-only endpoint scope does not leak native or request-parameter facts from chat", async t => {
  const f = await fixture(t);
  delete f.env.OPENAI_API_KEY;
  f.records.set("oauth/full/subscription", { provider: "openai", kind: "subscription", enabled: true, accessToken: "synthetic-subscription", accountId: "synthetic-account" });
  f.authority.seedLegacy("oauth/full/subscription", "openai");
  const provider = await catalog(f), model = provider.models.find(model => model.id === sol);
  assert.deepEqual(provider.routes.map(route => route.endpoint), ["responses"]);
  assert.deepEqual(Object.keys(model.nativeCapabilities.endpoints), ["responses"]);
  assert.deepEqual(Object.keys(model.requestParameters), ["responses"]);
  assert.equal(model.pricing.defaultMaxOutputTokens, 128000);
  const denied = provider.offers.filter(offer => offer.endpoint !== "responses" && offer.modelId === sol);
  assert.ok(denied.length > 0, "denied endpoint offers remain inspectable");
  assert.ok(denied.every(offer => !offer.eligible));
  const chat = denied.filter(offer => offer.endpoint === "chat_completions");
  assert.ok(chat.length > 0);
  assert.ok(chat.every(offer => offer.permittedServiceTiers?.length === 0), "known blocked chat tier support stays empty");
  const compact = denied.filter(offer => offer.endpoint === "responses_compact");
  assert.ok(compact.length > 0, "subscription grants cannot use public API compaction");
  assert.ok(compact.every(offer => offer.permittedServiceTiers === undefined && offer.hostedToolAdmission === undefined), "ordinary Responses facts never become compaction evidence");
  assert.equal(model.nativeCapabilities.endpoints.responses_compact, undefined, "undeclared compact native facts remain unknown");
  assert.deepEqual(snapshot.providers.find(provider => provider.id === "openai").models.find(model => model.id === sol).nativeCapabilities.endpoints.chat_completions.input, ["text", "image"], "request projection never mutates the shared compiled source");
});


test("catalog support does not grant a disallowed tier or model at the public dispatch boundary", async t => {
  const f = await fixture(t), view = await catalog(f, "limited");
  assert.deepEqual(view.models[0].nativeCapabilities.endpoints.responses.supportedServiceTiers, ["default", "priority", "flex", "ultrafast"]);
  const deniedTier = await f.post("limited", "/v1/responses", { model: sol, input: "synthetic fixture", service_tier: "priority" });
  assert.equal(deniedTier.status, 400);
  assert.equal((await deniedTier.json()).error.code, "service_tier_not_allowed");
  const deniedModel = await f.post("limited", "/v1/responses", { model: "openai/gpt-6-astra", input: "synthetic fixture" });
  assert.equal(deniedModel.status, 403);
  assert.equal((await deniedModel.json()).error.code, "model_not_allowed");
  assert.equal(f.upstream.mock.callCount(), 0, "unsupported request fails before provider I/O");
  const sent = [];
  f.upstream.mock.mockImplementation(async (url, init) => {
    sent.push({ url: String(url), authorization: init.headers.get("authorization"), body: JSON.parse(init.body) });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "synthetic output" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const accepted = await f.post("limited", "/v1/responses", { model: sol, input: "synthetic fixture", service_tier: "default", reasoning: { effort: "high" } });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await accepted.json()).output[0].content[0].text, "synthetic output");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  assert.equal(sent[0].authorization, "Bearer synthetic-upstream-only", "client proxy key never becomes an upstream credential");
  assert.equal(sent[0].body.model, "gpt-6.1-sol");
  assert.equal(sent[0].body.service_tier, "default");
  assert.equal(sent[0].body.reasoning.effort, "high");
});
