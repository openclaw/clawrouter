import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse } from "./usage-budget-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { UsageLedgerObject } = await import("../ledgers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const queued = { object: "response", id: "response-fixture", status: "queued", usage: null };
const completed = { ...queued, status: "completed", usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25 } };

async function fixture(t) {
  let now = Date.parse("2026-09-25T00:00:00Z"); t.mock.method(Date, "now", () => now);
  const records = new Map(), env = { OPENAI_API_KEY: "fixture-upstream-key", CLAWROUTER_LOCAL_AUTH: "enabled", POLICY_KV: {
    async get(key, type) { if (Array.isArray(key)) return new Map(key.map(item => [item, records.get(item) ?? null])); const value = records.get(key) ?? null; return value && type === "text" ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list({ prefix }) { return { keys: [...records.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  } };
  const policy = { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 1000, requestCostMicros: 100, budgetScope: "principal", retainRequestContent: false };
  const budgets = sqlBudgetNamespace(t), budgetCalls = [], queue = [], pending = [], sent = [];
  env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ fetch: (url, init) => { budgetCalls.push({ name, path: new URL(url).pathname, body: init?.body ? JSON.parse(init.body) : null }); return budgets.get(name).fetch(url, init); } }) };
  env.USAGE_QUEUE = { send: async message => { queue.push(message); } };
  const usageDb = new DatabaseSync(":memory:"); t.after(() => usageDb.close());
  const usageState = { storage: { sql: { exec(query, ...bindings) { const statement = usageDb.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } }, getAlarm: async () => 1 } };
  let usage = new UsageLedgerObject(usageState);
  env.USAGE_LEDGER = { idFromName: name => name, get: () => ({ fetch: (url, init) => usage.fetch(new Request(url, init)) }) };
  const scopes = continuationAuthority(t, env), authorityCalls = [], hooks = { owner: async (_body, dispatch) => dispatch(), upstream: request => Response.json(request.method === "POST" ? queued : completed) };
  env.ACCESS_CONTROL = { idFromName: name => name, get: name => name.startsWith("http-continuations:") ? { fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    return hooks.owner(body, () => scopes.get(name).fetch(url, init));
  } } : { fetch: (url, init) => { authorityCalls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return scopes.get(name).fetch(url, init); } } };
  attachGrantCredentialNamespace(env, { useExistingAuthority: true });
  const authority = async (path, body) => {
    const response = await scopes.get("policy-bindings").fetch(`https://authority${path}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response;
  };
  const credential = { enabled: true, secretSha256: await sha256Hex("abcdefgh"), policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" };
  await authority("/policies/initialize-all", [{ policyId: "maintainer_access", policy }]);
  await authority("/credentials/initialize-all", [{ credentialId: "maintainer_key", credential }]);
  await authority("/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 1000 }]);
  await authority("/users/initialize-all", [{ email: "owner@example.com", record: { enabled: true, role: "user", tenantId: "tenant", groups: [] } }]);
  await authority("/initialize-all", [{ principalType: "user", principalId: "owner@example.com", policyId: "maintainer_access", priority: 10, enabled: true }]);
  const session = "a".repeat(64);
  records.set(`local/sessions/${await sha256Hex(session)}`, { email: "owner@example.com", role: "user", expiresAtMs: now + 60_000 });
  t.mock.method(globalThis, "fetch", async (input, init) => { const request = new Request(input, init); sent.push(request); return hooks.upstream(request); });
  return { env, hooks, sent, budgets, budgetCalls, queue, scopes, usageDb, authority, authorityCalls, policy, records, credential, cookie: `clawrouter_session=${session}`,
    call(path, body, extra = {}) {
      const headers = { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", ...extra.headers };
      return worker.fetch(new Request(`https://router.example${path}`, { method: body === undefined ? "GET" : "POST", ...extra, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
    },
    state(response) {
      const locator = response.headers.get("x-clawrouter-background-recovery");
      assert.match(locator, /^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/);
      const [scope, id] = locator.split(".");
      const state = scopes.objects.get(`http-continuations:${scope}`);
      return { ...state, id, job: () => JSON.parse(state.db.prepare("SELECT job_json FROM responses_background WHERE job_id = ?").get(id).job_json) };
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    advance(ms) { now += ms; },
    restart() { for (const state of scopes.objects.values()) state.restart(); usage = new UsageLedgerObject(usageState); },
  };
}

for (const carrier of ["unified", "native", "manifest"]) test(`${carrier} queued create and repeated controls retain one original two-ledger charge`, async t => {
  const f = await fixture(t), body = { model: "openai/gpt-6-astra", input: "fixture", background: true, stream: false, store: false };
  const response = await f.call(carrier === "unified" ? "/v1/responses" : carrier === "native" ? "/v1/native/openai/v1/responses" : "/v1/proxy/openai/responses", carrier === "manifest" ? { body } : body);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), queued); await f.drain();
  const state = f.state(response), admitted = state.job();
  assert.equal(admitted.phase, "observing"); assert.equal(admitted.event, null); assert.equal(admitted.responseId, queued.id);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2); assert.deepEqual(f.queue, []);
  f.restart();
  for (const path of [`/v1/responses/${queued.id}`, `/v1/native/openai/v1/responses/${queued.id}`, `/v1/proxy/openai/responses_retrieve?response_id=${queued.id}&include[]=one&include[]=two`]) {
    const result = await f.call(path); assert.equal(result.status, 200); assert.deepEqual(await result.json(), completed);
  }
  await f.scopes.objects.get(`http-continuations:${response.headers.get("x-clawrouter-background-recovery").split(".")[0]}`).object.alarm();
  assert.equal(state.job().phase, "complete"); assert.equal(state.job().amount, 100);
  assert.equal(f.usageDb.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count, 1);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  assert.deepEqual(f.sent.at(-1).url.match(/include%5B%5D=[^&]+/g), ["include%5B%5D=one", "include%5B%5D=two"]);
  for (const leg of admitted.legs) assert.equal(f.budgets.get(leg.intent.objectName).reservations()[0].reserved_micros, 100);
});

test("lost owner dispatch ACK returns a recovery locator, sends no generation and settles original holds to zero", async t => {
  const f = await fixture(t);
  f.hooks.owner = async (body, dispatch) => { const response = await dispatch(); if (body.action === "dispatch") throw new Error("lost dispatch ACK"); return response; };
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true });
  assert.equal(response.status, 503); await response.text(); await f.drain();
  const state = f.state(response); assert.equal(state.job().event.actual_cost_micros, 0); assert.equal(f.sent.length, 0);
  await state.object.alarm(); assert.equal(state.job().phase, "complete");
  for (const call of f.budgetCalls.filter(call => call.path === "/reserve")) assert.equal(f.budgets.get(call.name).reservations()[0].reserved_micros, 0);
});

test("background create query rejection occurs before budget reservation and egress", async t => {
  const f = await fixture(t);
  for (const [path, body] of [["/v1/responses?unexpected=1", { model: "openai/gpt-6-astra", background: true }],
    ["/v1/native/openai/v1/responses?unexpected=1", { model: "gpt-6-astra", background: true }],
    ["/v1/proxy/openai/responses", { query: { unexpected: 1 }, body: { model: "openai/gpt-6-astra", background: true } }]]) {
    const response = await f.call(path, body); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "background_query_unsupported");
  }
  await f.drain(); assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("terminal SSE waits for identity publication before accounting, and a later disconnect preserves it", { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.hooks.owner = async (body, dispatch) => { if (body.action === "register") { entered.resolve(); await release.promise; } return dispatch(); };
  f.hooks.upstream = () => new Response(sse({ type: "response.completed", response: completed }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true, stream: true });
  const state = f.state(response), reader = response.body.getReader(), reading = reader.read();
  await entered.promise; assert.equal(state.job().event, null); assert.equal(state.job().responseId, null);
  assert.equal(f.usageDb.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count, 0);
  release.resolve(); assert.equal((await reading).done, false); await reader.cancel();
  assert.equal(state.job().event.input_tokens, 10); await state.object.alarm(); assert.equal(state.job().amount, 100);
});

test("disconnect after a JSON scalar identity leaves the original job collectible", { timeout: 5000 }, async t => {
  const f = await fixture(t), encoder = new TextEncoder();
  f.hooks.upstream = request => request.method === "POST" ? new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"id":"response-fixture","object":"response",')); } }), { headers: { "content-type": "application/json" } }) : Response.json(completed);
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true }), state = f.state(response), reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(state.job().responseId, queued.id); assert.equal(state.job().event, null);
  f.advance(5000); await state.object.alarm();
  assert.equal(state.job().phase, "complete"); assert.equal(state.job().amount, 100);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1); assert.equal(f.sent.filter(request => request.method === "GET").length, 1);
});

for (const action of ["admit", "dispatch"]) test(`${action} requires its affirmative owner ACK before generation egress`, async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { admitted: false, dispatched: false }, action === "admit" ? { dispatched: true } : { admitted: true }]) {
    f.hooks.owner = async (body, dispatch) => { const response = await dispatch(); return body.action === action ? Response.json(value) : response; };
    const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true });
    assert.equal(response.status, 503); await response.text(); await f.drain();
    const state = f.state(response); assert.equal(f.sent.length, 0); assert.deepEqual(f.queue, []);
    if (action === "dispatch") {
      assert.equal(state.job().event.actual_cost_micros, 0);
      await state.object.alarm(); assert.equal(state.job().phase, "complete");
    } else assert.equal(state.job().event, null, "an uncertain admission ACK remains owned by the durable scope");
  }
});

test("Access background selection skips a subscription-only first policy; controls retain the original policy without pool selection", async t => {
  const f = await fixture(t), headers = { cookie: f.cookie, origin: "https://router.example" };
  await f.authority("/policies/put", { policyId: "subscription", policy: { ...f.policy, generation: "subscription_v1" } });
  const principal = { principalType: "user", principalId: "owner@example.com" };
  await f.authority("/mutate", { seed: { principal, bindings: [] }, binding: { ...principal, policyId: "subscription", priority: 0, enabled: true } });
  await putGrantCredentials(f.env, "oauth/subscription/openai", { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  await putGrantCredentials(f.env, "oauth/maintainer_access/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  const response = await f.call("/v1/playground/v1/responses", { model: "openai/gpt-6-astra", background: true }, { headers });
  assert.equal(response.status, 200); await response.json();
  const state = f.state(response); assert.equal(state.job().owner.grantKey, "oauth/maintainer_access/openai");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer fixture-api");
  f.authorityCalls.length = 0;
  const control = await f.call(`/v1/playground/v1/responses/${queued.id}`, undefined, { headers });
  assert.equal(control.status, 200); await control.json();
  const cancel = await f.call(`/v1/playground/v1/responses/${queued.id}/cancel`, undefined, { method: "POST", headers });
  assert.equal(cancel.status, 200); await cancel.json();
  assert.equal(f.authorityCalls.some(call => call.path.startsWith("/grant-pools/")), false);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  await f.authority("/mutate", { seed: { principal, bindings: [] }, binding: { ...principal, policyId: "maintainer_access", priority: 10, enabled: false } });
  const before = f.sent.length, denied = await f.call(`/v1/playground/v1/responses/${queued.id}`, undefined, { headers });
  assert.equal(denied.status, 409); assert.equal(f.sent.length, before);
});

test("a proxy key cannot background-dispatch through its subscription-only policy or borrow a browser scope", async t => {
  const f = await fixture(t);
  await putGrantCredentials(f.env, "oauth/maintainer_access/openai", { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true }, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "upstream_grant_pool_unavailable"); assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("public controls require the original key scope and unchanged effective organization/project", async t => {
  const f = await fixture(t), headers = { "openai-organization": "org-fixture", "openai-project": "project-fixture" };
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true }, { headers });
  assert.equal(response.status, 200); await response.json();
  for (const extra of [{}, { headers: { ...headers, "openai-project": "different" } }, { headers: { ...headers, authorization: "Bearer invalid", cookie: f.cookie } }]) {
    const control = await f.call(`/v1/responses/${queued.id}`, undefined, extra);
    assert.ok([401, 409].includes(control.status)); assert.equal(f.sent.length, 1);
  }
  const control = await f.call(`/v1/responses/${queued.id}`, undefined, { headers });
  assert.equal(control.status, 200); await control.json(); assert.equal(f.sent.length, 2);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
});

test("the actual admin recovery route requires admin authority and browser same-origin before touching a record", async t => {
  const f = await fixture(t), response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  await response.json(); const locator = response.headers.get("x-clawrouter-background-recovery"), body = { action: "inspect", locator }, path = "/v1/admin/usage/recovery";
  const actions = []; f.hooks.owner = (input, dispatch) => { actions.push(input.action); return dispatch(); };
  assert.equal((await f.call(path, body)).status, 401);
  assert.equal((await f.call(path, body, { headers: { cookie: f.cookie } })).status, 403);
  await f.authority("/users/put", { email: "owner@example.com", record: { enabled: true, role: "admin", tenantId: "tenant", groups: [] } });
  assert.equal((await f.call(path, body, { headers: { cookie: f.cookie, origin: "https://other.example" } })).status, 403);
  assert.deepEqual(actions, []);
  const inspected = await f.call(path, body, { headers: { cookie: f.cookie, origin: "https://router.example" } });
  assert.equal(inspected.status, 200); assert.equal(inspected.headers.get("cache-control"), "no-store");
  const value = await inspected.json(); assert.equal(value.record.id, f.state(response).id);
  assert.equal(JSON.stringify(value).includes(queued.id), false); assert.deepEqual(actions, ["get"]);
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin-token");
  assert.equal((await f.call(path, body, { headers: { authorization: "Bearer fixture-admin-token" } })).status, 200);
  assert.equal((await f.call(path, { ...body, scope: "a".repeat(64) }, { headers: { authorization: "Bearer fixture-admin-token" } })).status, 400);
  assert.deepEqual(actions, ["get", "get"]); assert.equal(f.sent.length, 1);
});

for (const active of [true, false]) test(`actual HTTP admission enforces the ${active ? "16 active" : "64 total unresolved"} scope limit before another reserve or POST`, { timeout: 15_000 }, async t => {
  const f = await fixture(t), limit = active ? 16 : 64;
  await f.authority("/policies/put", { policyId: "maintainer_access", policy: { ...f.policy, monthlyBudgetMicros: 100000 } });
  await f.authority("/connections/put", { providerId: "openai", monthlyBudgetMicros: 100000 });
  f.hooks.upstream = () => Response.json({ ...(active ? queued : completed), id: `response-${f.sent.length}` });
  for (let i = 0; i < limit; i++) {
    const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
    assert.equal(response.status, 200); await response.json();
  }
  const before = f.budgetCalls.length, response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "background_capacity");
  assert.equal(f.sent.length, limit); assert.equal(f.budgetCalls.length, before);
  const state = [...f.scopes.objects.entries()].find(([name]) => name.startsWith("http-continuations:"))[1];
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM responses_background").get().count, limit);
});

for (const stream of [false, true]) test(`closed and evicted summaries preserve original stream=${stream} permission on public retrieval`, { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.hooks.upstream = request => Response.json({ ...completed, id: request.method === "POST" ? `response-${f.sent.length}` : decodeURIComponent(new URL(request.url).pathname.split("/").pop()) });
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true, stream });
  assert.equal(response.status, 200); const original = await response.json(), state = f.state(response);
  await state.object.alarm(); assert.equal(state.job().phase, "complete"); const eventId = state.job().eventId;
  const binding = state.db.prepare("SELECT * FROM http_continuations").get();
  const check = async () => {
    const before = f.sent.length, reserves = f.budgetCalls.length;
    const resumed = await f.call(`/v1/responses/${original.id}?stream=true&starting_after=0`);
    assert.equal(resumed.status, stream ? 200 : 409); if (stream) assert.equal((await resumed.json()).id, original.id);
    assert.equal(f.sent.length, before + Number(stream)); assert.equal(f.budgetCalls.length, reserves);
    const retrieved = await f.call(`/v1/responses/${original.id}`); assert.equal(retrieved.status, 200); assert.equal((await retrieved.json()).id, original.id);
  };
  await check();
  await f.authority("/policies/put", { policyId: "maintainer_access", policy: { ...f.policy, requestCostMicros: 0 } });
  for (let i = 0; i < 64; i++) {
    f.advance(1);
    const next = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
    assert.equal(next.status, 200); await next.json(); await state.object.alarm();
  }
  assert.equal(state.db.prepare("SELECT 1 FROM responses_background WHERE job_id = ?").get(state.id), undefined);
  assert.deepEqual(state.db.prepare("SELECT * FROM http_continuations WHERE binding_key = ?").get(binding.binding_key), binding);
  await check();
  assert.equal(f.usageDb.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE id = ?").get(eventId).count, 1);
});

test("concurrent retrieve and cancel terminal observations freeze one original receipt", async t => {
  const f = await fixture(t), response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  await response.json(); const state = f.state(response), original = state.job();
  f.hooks.upstream = () => Response.json(completed);
  const replies = await Promise.all([f.call(`/v1/responses/${queued.id}`), f.call(`/v1/responses/${queued.id}/cancel`, undefined, { method: "POST" })]);
  assert.ok(replies.every(reply => reply.status === 200)); await Promise.all(replies.map(reply => reply.json()));
  const event = state.job().event; assert.equal(event.id, original.eventId);
  await state.object.alarm(); assert.equal(state.job().phase, "complete");
  assert.equal(f.usageDb.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count, 1);
  assert.equal(f.sent.filter(request => new URL(request.url).pathname === "/v1/responses" && request.method === "POST").length, 1);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
});

test("a lost binding ACK retains the committed collector identity without exposing unacknowledged bytes", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.hooks.owner = async (body, dispatch) => { const response = await dispatch(); if (body.action === "register") throw new Error("lost publication ACK"); return response; };
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  await assert.rejects(response.json()); const state = f.state(response);
  assert.equal(state.job().responseId, queued.id); assert.equal(state.job().event, null);
  f.advance(5000); await state.object.alarm(); assert.equal(state.job().phase, "complete");
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const failure of ["rejected", "unknown"]) test(`${failure} creation delivery preserves the known-unsent versus uncertain-dispatch financial distinction`, async t => {
  const f = await fixture(t);
  f.hooks.upstream = () => { if (failure === "unknown") throw new Error("upstream connection lost"); return Response.json({ error: "fixture rejection" }, { status: 429 }); };
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  assert.equal(response.status, failure === "rejected" ? 429 : 502); await response.text(); await f.drain();
  const state = f.state(response); assert.equal(f.sent.length, 1);
  if (failure === "unknown") { assert.equal(state.job().event, null); f.advance(60 * 60_000); }
  else assert.equal(state.job().event.actual_cost_micros, 0);
  await state.object.alarm(); assert.equal(state.job().phase, "complete"); assert.equal(state.job().amount, failure === "unknown" ? 100 : 0);
  assert.equal(f.sent.length, 1, "financial recovery never repeats the generation");
});

test("fresh catalog offers exclude linked controls while the create operation stays visible", async t => {
  const f = await fixture(t), response = await f.call("/v1/catalog");
  assert.equal(response.status, 200); const catalog = await response.json(), provider = catalog.providers.find(value => value.id === "openai");
  assert.ok(provider.offers.some(offer => offer.endpoint === "responses"));
  assert.equal(provider.offers.some(offer => ["responses_retrieve", "responses_cancel"].includes(offer.endpoint)), false);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.some(call => call.path !== "/status"), false);
});
