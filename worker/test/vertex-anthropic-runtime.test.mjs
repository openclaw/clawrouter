import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureVertex, vertexAuthorization, vertexBody, vertexJson, vertexSse, vertexModel, vertexModelId } from "./vertex-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { inspectGrantCredentials, putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const native = "/v1/native/anthropic-vertex/v1/messages", manifest = "/v1/proxy/anthropic-vertex/messages";
async function setup(t, { location = "us-east5", qualify = true, fixed = 700, expiry = 3600000 } = {}) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "anthropic")); configureVertex(provider);
  const f = await fixture(t, { providerId: "anthropic-vertex", fixed, configure(target) { Object.assign(target, provider); } });
  f.env.GOOGLE_API_KEY = "synthetic-forbidden-environment"; f.env.ANTHROPIC_API_KEY = "synthetic-forbidden-anthropic";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin"); f.binding = vertexAuthorization(location);
  f.admin = (body, headers = {}) => f.call("/v1/admin/upstream-grants/policies/fixture/replicate", body,
    { method: "PUT", headers: { authorization: "Bearer synthetic-admin", ...headers } });
  f.put = async body => { const response = await f.admin(body), text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text); };
  await f.put({ provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "synthetic-vertex-access",
    expiresAt: new Date(Date.now() + expiry).toISOString(), ...(qualify ? { vertexAnthropicAuthorization: f.binding } : {}) });
  f.policy.models = [vertexModelId]; f.policy.grantRouting = { eligibleGrants: { "anthropic-vertex": ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (envelope = false, body = {}, extra = {}) => f.call(envelope ? manifest : native,
    envelope ? { body: { ...vertexBody(), model: vertexModelId, ...body } } : { ...vertexBody(), ...body }, extra);
  f.upstream = async request => {
    const body = await request.clone().json();
    return body.stream ? new Response(vertexSse(), { headers: { "content-type": "text/event-stream" } }) : Response.json(vertexJson());
  };
  f.afterDispatchAck = change => {
    const get = f.env.BUDGET_LEDGER.get; let changed = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/dispatch" && !changed) { changed = true; await change(); }
      return response;
    } }; };
  };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); }); return f;
}
async function denied(f, response) {
  const text = await response.text(); assert.notEqual(response.status, 200, text);
  assert.doesNotMatch(text, /synthetic-(?:vertex-access|forbidden|replacement)/); await f.drain(); assert.equal(f.sent.length, 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}
for (const location of ["global", "us", "eu", "us-east5"]) for (const envelope of [false, true]) for (const stream of [false, true])
  test(`Vertex ${location} ${envelope ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} uses original resource and token`, async t => {
    const f = await setup(t, { location });
    const response = await f.request(envelope, { stream }, { headers: { "x-goog-user-project": "foreign-project", "x-api-key": "synthetic-forbidden-anthropic" } });
    assert.equal(response.status, 200, await response.clone().text()); const text = await response.text();
    assert.equal(text, stream ? vertexSse() : JSON.stringify(vertexJson())); await f.drain(); assert.equal(f.sent.length, 1);
    const sent = f.sent[0], host = location === "global" ? "aiplatform.googleapis.com" : ["us", "eu"].includes(location) ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;
    assert.equal(sent.url, `https://${host}/v1/projects/fixture-project/locations/${location}/publishers/anthropic/models/${encodeURIComponent(vertexModel)}:${stream ? "streamRawPredict" : "rawPredict"}`);
    assert.equal(sent.redirect, "manual"); assert.equal(sent.headers.get("authorization"), "Bearer synthetic-vertex-access");
    for (const header of ["x-api-key", "anthropic-version", "x-goog-user-project"]) assert.equal(sent.headers.has(header), false);
    const wire = await sent.json(); assert.equal(wire.model, undefined); assert.equal(wire.anthropic_version, "vertex-2023-10-16");
    assert.deepEqual(wire.messages, vertexBody().messages);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].input_tokens, 4); assert.equal(events[0].output_tokens, 2);
  });
for (const mutation of ["disable", "revoke", "replace", "remove", "project", "region", "expiry", "policy", "caller", "unavailable", "failed-publication"])
  test(`Vertex final owner/policy check denies ${mutation} after budget awaits`, async t => {
    const f = await setup(t);
    f.afterDispatchAck(async () => {
      if (mutation === "disable") await f.put({ enabled: false });
      else if (mutation === "revoke") await revokeGrantCredentials(f.env, grantKey);
      else if (mutation === "replace") await f.put({ accessToken: "synthetic-replacement-token", vertexAnthropicAuthorization: f.binding });
      else if (mutation === "remove") await f.put({ vertexAnthropicAuthorization: null });
      else if (mutation === "project") await f.put({ vertexAnthropicAuthorization: vertexAuthorization("us-east5", "other-project") });
      else if (mutation === "region") await f.put({ vertexAnthropicAuthorization: vertexAuthorization("eu") });
      else if (mutation === "expiry") f.advance(3550000);
      else if (mutation === "policy") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, models: [] } });
      else if (mutation === "caller") await f.authority("/credentials/put", { credentialId: "fixture", credential: { ...f.credential, enabled: false } });
      else if (mutation === "unavailable") f.env.GRANT_CREDENTIALS.get = () => ({ async fetch() { return new Response(null, { status: 503 }); } });
      else {
        const get = f.env.ACCESS_CONTROL.get;
        f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) { return new URL(url).pathname === "/grant-pools/publish" && JSON.parse(init.body).status === "paused" ? Promise.resolve(new Response(null, { status: 503 })) : stub.fetch(url, init); } }; };
        await assert.rejects(() => putGrantCredentials(f.env, grantKey, { enabled: false }, true));
      }
    });
    await denied(f, await f.request());
  });
for (const envelope of [false, true]) test(`Vertex warm credentials cannot adopt replacement ${envelope}`, async t => {
  const f = await setup(t); overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 60000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const warm = await f.request(envelope); assert.equal(warm.status, 200); await warm.text(); await f.drain();
  await f.put({ accessToken: "synthetic-replacement-token" }); const response = await f.request(envelope);
  assert.notEqual(response.status, 200); await response.text(); assert.equal(f.sent.length, 1);
});
for (const expiry of [60000, 1000, -1000]) test(`Vertex expiry ${expiry} never implies refresh capability`, async t => {
  const f = await setup(t, { expiry }); await denied(f, await f.request());
});
test("Vertex unknown USD rejects before credential materialization", async t => {
  const f = await setup(t, { fixed: null }); delete f.policy.requestCostMicros;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const get = f.env.GRANT_CREDENTIALS.get; let materializations = 0;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) { if (new URL(url).pathname === "/materialize") materializations++; return stub.fetch(url, init); } }; };
  await denied(f, await f.request()); assert.equal(materializations, 0);
});
for (const body of [{ project: "foreign" }, { location: "eu" }, { resource: "https://foreign.invalid" }, { model: "undeclared-model" }, { anthropic_version: "2026-10-21" }])
  test(`Vertex rejects caller resource/version/model override ${Object.keys(body)[0]}`, async t => { const f = await setup(t); await denied(f, await f.request(false, body)); });
test("Vertex rejects route/query overrides and forged or missing owner bindings", async t => {
  const f = await setup(t, { qualify: false }); await denied(f, await f.request());
  await putGrantCredentials(f.env, grantKey, { provider: "anthropic-vertex", kind: "oauth", tokenType: "Bearer", accessToken: "synthetic-vertex-access", expiresAt: new Date(Date.now() + 3600000).toISOString(), vertexAnthropicBinding: f.binding });
  await denied(f, await f.request(true));
  await f.put({ vertexAnthropicAuthorization: f.binding });
  await denied(f, await f.call(native + "?location=eu", vertexBody()));
  f.provider.endpoints[0].upstreamPath = "/v1/foreign"; await denied(f, await f.request());
});
for (const status of [400, 401, 429, 500]) test(`Vertex dispatched HTTP${status} retains explicit charge and never retries`, async t => {
  const f = await setup(t); f.upstream = () => Response.json({ error: { type: "synthetic_error" } }, { status });
  const response = await f.request(); await response.text(); await f.drain(); assert.equal(f.sent.length, 1);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].input_tokens, null);
});
test("Vertex dispatched transport failure retains charge without token or key substitution", async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic network failure"); };
  const response = await f.request(); assert.equal(response.status, 502); await response.text(); await f.drain(); assert.equal(f.sent.length, 1);
  assert.equal((await f.events())[0].actual_cost_micros, 700);
});
test("Vertex admin intent cannot be supplied by a proxy caller or as a private projection", async t => {
  const f = await setup(t);
  for (const field of ["vertexAnthropicBinding", "vertexAnthropicIntent"]) {
    const response = await f.admin({ [field]: f.binding }); assert.equal(response.status, 400); await response.text();
  }
  const response = await f.admin({ vertexAnthropicAuthorization: f.binding }, { authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
  assert.equal(response.status, 401); await response.text();
  const catalog = await (await f.call('/v1/catalog', null)).text(); assert.doesNotMatch(catalog, /fixture-project|vertexAnthropicBinding|synthetic-vertex-access/);
});
test("Vertex downstream cancellation retains dispatched charge and cancels the original response", async t => {
  const f = await setup(t); let cancelled = 0;
  f.upstream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}\n\n')); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await f.request(false, { stream: true }); assert.equal(response.status, 200);
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel(); await f.drain();
  assert.equal(cancelled, 1); assert.equal(f.sent.length, 1); assert.equal((await f.events())[0].actual_cost_micros, 700);
});
test("Vertex SSE error before output is uncertain paid work, not a free retry", async t => {
  const f = await setup(t); f.upstream = () => new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"synthetic"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const response = await f.request(false, { stream: true }); await response.text(); await f.drain();
  assert.equal(f.sent.length, 1); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
});
