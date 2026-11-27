import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { filterRadiusCatalog } from "../provider-radius.ts";
import { revokeGrantCredentials, putGrantCredentials } from "../grant-credentials.ts";
import { bodyBudgetCharged } from "../body-budget.ts";
const base = "https://radius.pi.dev/v1";
const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const model = { id: "tenant/model", name: "Synthetic Radius", reasoning: true, input: ["text", "image"], contextWindow: 8192, maxTokens: 1024,
  thinkingLevelMap: { off: null, low: "low", high: "high" }, cost: { ...rates, tiers: [{ inputTokensAbove: 4096, ...rates, input: 3 }] } };
const catalog = { baseUrl: base, models: [model, { id: "hidden" }, { id: "disabled", enabled: false }] };
async function setup(t, models = ["radius/tenant/model"]) {
  const f = await fixture(t, { providerId: "radius", compiledProvider: true, pooled: true });
  f.env.RADIUS_API_KEY = "must-not-radius-environment";
  f.policy.grantRouting = { eligibleGrants: { radius: ["replicate"] }, environmentFallback: false };
  f.policy.models = models;
  f.update = async extra => { Object.assign(f.policy, extra); await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); };
  await f.update({});
  f.upstream = () => Response.json(catalog);
  f.request = (manifest, init = {}) => f.call(manifest ? "/v1/proxy/radius/config" : "/v1/native/radius/config", null, init);
  return f;
}
async function consume(f, response) { const value = await response.json(); await f.drain(); assert.equal(bodyBudgetCharged(), 0); return value; }
function noCharge(events) { assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].reserved_cost_micros, 0); assert.equal(events[0].cost_basis, "none"); assert.equal(events[0].capability, "models.list"); }

test("Radius closed projection preserves native tiers and removes unconsumed authority/route fields", () => {
  const secret = { apiKey: "synthetic-private", headers: { authorization: "synthetic-private" }, baseUrl: "https://foreign.example", providers: { secret: true } };
  const input = { ...secret, baseUrl: base, models: [{ ...model, ...secret, thinkingLevelMap: { ...model.thinkingLevelMap, secret: "synthetic-private" }, cost: { ...model.cost, tieredPricing: [{ secret: true }], apiKey: "synthetic-private", tiers: [{ ...model.cost.tiers[0], ...secret }] } }] };
  assert.deepEqual(filterRadiusCatalog(input, base, () => true), { baseUrl: base, models: [model] });
  assert.doesNotMatch(JSON.stringify(filterRadiusCatalog(input, base, () => true)), /synthetic-private|foreign|tieredPricing|headers|providers/);
  for (const mutate of [x => x.models.push(model), x => x.models[0].id = "bad\n", x => x.models[0].input = ["video"], x => x.models[0].cost.input = -1,
    x => x.models[0].cost.tiers.push(x.models[0].cost.tiers[0]), x => x.models[0].cost.tiers[0].inputTokensAbove = Number.MAX_SAFE_INTEGER,
    x => x.models[0].maxTokens = 0, x => x.models[0].thinkingLevelMap.low = {}, x => x.baseUrl = "https://foreign.example/v1"]) {
    const value = structuredClone({ baseUrl: base, models: [model] }); mutate(value); assert.throws(() => filterRadiusCatalog(value, base, () => true));
  }
});

for (const manifest of [false, true]) {
  test(`Radius ${manifest ? "manifest" : "native"} actual config dispatch pins original grant and filters without inference charge`, async t => {
    const f = await setup(t);
    f.upstream = request => {
      assert.equal(request.url, base + "/config"); assert.equal(request.method, "GET"); assert.equal(request.body, null);
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.redirect, "manual");
      return Response.json({ ...catalog, apiKey: "synthetic-hidden" }, { headers: { "etag": "old", "location": "https://foreign.example", "cache-control": "public", "content-length": "9000", "content-encoding": "identity" } });
    };
    const response = await f.request(manifest); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    for (const key of ["etag", "location", "content-length", "content-encoding"]) assert.equal(response.headers.has(key), false);
    assert.deepEqual(await consume(f, response), { baseUrl: base, models: [model] });
    assert.equal(f.sent.length, 1); noCharge(await f.events());
  });
  for (const models of [[], ["radius/hidden"], ["foreign/tenant/model"]]) test(`Radius ${manifest} exact caller model IDs filter all-hidden and foreign policies ${models}`, async t => {
    const f = await setup(t, models), response = await f.request(manifest);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await consume(f, response), { baseUrl: base, models: models.includes("radius/hidden") ? [{ id: "hidden" }] : [] });
    assert.equal(f.sent.length, 1); noCharge(await f.events());
  });
  for (const change of ["revoke", "rotate", "policy", "narrow", "widen", "destination"]) test(`Radius ${manifest} refresh after final body read binds ${change}`, async t => {
    const f = await setup(t); let read = false;
    f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
      read = true;
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
      if (change === "rotate") await putGrantCredentials(f.env, grantKey, { provider: "radius", kind: "api_key", enabled: true, credential: "synthetic-new-key" });
      if (change === "policy") await f.update({ enabled: false });
      if (change === "narrow") await f.update({ models: [] });
      if (change === "widen") await f.update({ models: null });
      if (change === "destination") f.provider.base_urls.default = "https://other.example/v1";
      controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog))); controller.close();
    } }, { highWaterMark: 0 }));
    const response = await f.request(manifest), value = await consume(f, response); assert.equal(read, true); assert.equal(f.sent.length, 1);
    if (["narrow", "widen"].includes(change)) { assert.equal(response.status, 200); assert.deepEqual(value, { baseUrl: base, models: change === "narrow" ? [] : [model] }); }
    else { assert.ok(response.status >= 400); assert.doesNotMatch(JSON.stringify(value), /tenant\/model|synthetic-new-key/); }
    assert.equal((await f.events())[0].actual_cost_micros, 0);
  });
}
for (const fault of ["duplicate", "foreign", "truncated", "utf8", "oversized", "empty-reads", "status"]) test(`Radius bounded config fails closed on ${fault}`, async t => {
  const f = await setup(t); let canceled = 0, reads = 0;
  f.upstream = () => {
    if (fault === "status") return Response.json({ apiKey: "synthetic-secret" }, { status: 401 });
    if (fault === "empty-reads" || fault === "oversized") return new Response(new ReadableStream({ pull(c) { reads++; c.enqueue(new Uint8Array(fault === "oversized" ? 2 * 1024 * 1024 + 1 : 0)); }, cancel() { canceled++; } }, { highWaterMark: 0 }));
    const value = structuredClone(catalog); if (fault === "duplicate") value.models.push(model); if (fault === "foreign") value.baseUrl = "https://foreign.example";
    return new Response(fault === "utf8" ? new Uint8Array([0xff]) : fault === "truncated" ? '{"models":[' : JSON.stringify(value));
  };
  const response = await f.request(false), body = await consume(f, response); assert.equal(response.status, 502); assert.doesNotMatch(JSON.stringify(body), /synthetic-secret|tenant\/model/);
  assert.equal(f.sent.length, 1); assert.equal((await f.events())[0].actual_cost_micros, 0);
  if (["empty-reads", "oversized"].includes(fault)) { assert.equal(canceled, 1); assert.equal(reads, fault === "empty-reads" ? 8192 : 1); }
});
for (const failure of [undefined, new Error("independent source cancel")]) test(`Radius original cancellation rejection stays retained (${failure === undefined ? "undefined" : "Error"})`, async t => {
  const f = await setup(t), caller = new AbortController(); let reached, cancels = 0, unlocked = 0;
  const entered = new Promise(resolve => { reached = resolve; }); let physical;
  f.upstream = () => {
    physical = new ReadableStream({ pull() { reached(); }, cancel() { cancels++; throw failure; } }, { highWaterMark: 0 });
    const acquire = physical.getReader.bind(physical);
    physical.getReader = () => { const reader = acquire(); return { read: () => reader.read(), cancel: reason => reader.cancel(reason), releaseLock() { unlocked++; reader.releaseLock(); } }; };
    return new Response(physical);
  };
  const pending = f.request(false, { signal: caller.signal }); await entered; caller.abort(new Error("synthetic caller"));
  const response = await pending; assert.ok(response.status >= 400); await consume(f, response);
  assert.equal(cancels, 1); assert.equal(unlocked, 1); assert.equal(physical.locked, false); assert.equal(f.sent.length, 1);
  assert.equal((await f.events())[0].actual_cost_micros, 0);
});
