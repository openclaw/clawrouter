import assert from "node:assert/strict";
import test from "node:test";
import { setup, denied, grantKey, actor, result, originalKey } from "./minimax-search-runtime-fixture.mjs";
const { inspectGrantCredentials, materializeGrantCredentials, revokeGrantCredentials, putGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { miniMaxSearchBinding } = await import("../../shared/minimax-search-binding.ts");
const { routingProjection } = await import("../grant-projection.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const MiB = 1024 * 1024;
for (const region of ["global", "cn"]) for (const manifest of [false, true]) test(`Search ${region}/${manifest ? "manifest" : "native"} exact original key, one POST and one fixed receipt`, async t => {
  const f = await setup(t, { region });
  f.upstream = async request => {
    assert.equal(request.url, miniMaxSearchBinding(region).origin + "/v1/coding_plan/search");
    assert.equal(request.redirect, "manual"); assert.equal(request.headers.get("authorization"), `Bearer ${originalKey}`);
    assert.deepEqual(await request.json(), { q: "synthetic query" }); assert.equal(bodyBudgetCharged(), 72 * MiB);
    return Response.json(result);
  };
  const response = await f.request(manifest), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, result); await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.materializations, 1); assert.equal(bodyBudgetCharged(), 0);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].actual_cost_micros, 700);
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(events[0][name], null);
});
for (const body of [{ q: "" }, { q: "x".repeat(4097) }, { q: "ok", model: "image-01" }, { q: "ok", stream: true },
  { q: "ok", url: "https://foreign.example.invalid" }, { q: "ok", region: "cn" }, { q: "ok", authorization: true }])
  test("Search rejects caller authority or invalid native query " + Object.keys(body).join(","), async t => {
    const f = await setup(t); await denied(f, await f.request(false, body)); assert.equal(f.materializations, 0);
  });
for (const options of [{ environment: true }, { qualify: false }]) test("Search has no environment or unqualified-key fallback " + JSON.stringify(options), async t => {
  const f = await setup(t, options); await denied(f, await f.request()); assert.equal(f.materializations, 0);
});
for (const mutation of [{ kind: "oauth", accessToken: "synthetic-oauth" }, { credential: "synthetic-replacement-key" },
  { accountId: "other-account" }, { provider: "other" }, { expiresAt: "2026-11-10T00:00:00Z" }])
  test("Search changed authority clears attestation " + Object.keys(mutation).join(","), async t => {
    const f = await setup(t); await f.put(mutation); assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxSearchBinding, null);
    await denied(f, await f.request());
  });
test("Search rename preserves; explicit clear, replacement and revoke never resurrect by omission", async t => {
  const f = await setup(t), before = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ label: "renamed" }); const kept = await inspectGrantCredentials(f.env, grantKey);
  assert.deepEqual(kept.minimaxSearchBinding, miniMaxSearchBinding("global")); assert.equal(kept.credentialLineage, before.credentialLineage);
  await f.put({}, null); await f.put({ label: "still cleared" }); assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxSearchBinding, null);
  await f.put({}, miniMaxSearchBinding("global"));
  await revokeGrantCredentials(f.env, grantKey, undefined, actor); await assert.rejects(f.put({ label: "revoked" }), /primary credential/);
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxSearchBinding, null); await denied(f, await f.request());
});
test("Search materialization rejects old generation before repair, adoption or secret return", async t => {
  const f = await setup(t), stale = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ credential: "synthetic-replacement-key" }, miniMaxSearchBinding("global"));
  const before = structuredClone(f.record());
  await assert.rejects(materializeGrantCredentials(f.env, grantKey, stale, "minimax", null, false, undefined, "minimax.search"));
  assert.deepEqual(f.record(), before); assert.equal(f.sent.length, 0);
});
test("Search current SQL role checked after pool ACK; denial cannot install or repair a pending attestation", async t => {
  const f = await setup(t), before = structuredClone(f.record()), get = f.env.ACCESS_CONTROL.get;
  let changed = false, proof;
  f.env.ACCESS_CONTROL.get = name => { const stub = get(name); return { async fetch(url, init) {
    const path = new URL(url).pathname;
    if (path === "/grant-search/authorize") proof = JSON.parse(init.body);
    const reply = await stub.fetch(url, init);
    if (path === "/grant-pools/admit" && !changed) { changed = true; await f.user(true, "user"); }
    return reply;
  } }; };
  await assert.rejects(f.put({ credential: "synthetic-replacement-key" }, miniMaxSearchBinding("global")));
  assert.ok(changed); assert.equal(proof.original.generation, before.generation); assert.equal(proof.original.lineage, before.lineage);
  assert.deepEqual(f.record(), before);
  await assert.rejects(f.put({}, miniMaxSearchBinding("global"))); assert.deepEqual(f.record(), before);
  // Denying this mutation preserves the original valid grant; admin demotion
  // is not a revoke command for an independently authorized proxy principal.
  const response = await f.request(); assert.equal(response.status, 200, await response.clone().text());
  await response.text(); await f.drain(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].headers.get("authorization"), `Bearer ${originalKey}`);
});
test("Search authoritative NULL defeats forged metadata and legacy imports", async t => {
  const f = await setup(t, { environment: true });
  await putGrantCredentials(f.env, grantKey, { provider: "minimax", kind: "api_key", enabled: true, credential: originalKey, minimaxSearchBinding: miniMaxSearchBinding("global") });
  const projection = await inspectGrantCredentials(f.env, grantKey); assert.equal(projection.minimaxSearchBinding, null);
  assert.equal(routingProjection(projection).minimaxSearchBinding, null);
  assert.equal(secretlessGrant({ provider: "minimax", minimaxSearchBinding: miniMaxSearchBinding("global") }).minimaxSearchBinding, null);
  await denied(f, await f.request());
});
for (const change of ["revoke", "rotate", "policy", "region"]) test(`Search fresh post-await ${change} denies BEFORE POST`, async t => {
  const f = await setup(t);
  f.afterBudget(async () => {
    if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, actor);
    if (change === "rotate") await f.put({ credential: "synthetic-replacement-key" }, miniMaxSearchBinding("global"));
    if (change === "region") await f.put({}, miniMaxSearchBinding("cn"));
    if (change === "policy") { f.policy.providers = ["other"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  });
  await denied(f, await f.request());
});
for (const warm of [false, true]) test(`Search unknown hard USD has zero materialization and egress (${warm ? "warm" : "cold"})`, async t => {
  const f = await setup(t, { fixed: null });
  if (warm) { f.policy.requestCostMicros = 700; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); const r = await f.request(); await r.text(); await f.drain(); f.sent.length = 0; f.materializations = 0;
    f.policy.requestCostMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  const r = await f.request(); const body = await r.json(); assert.equal(body.error.code, "pricing_required"); assert.equal(f.materializations, 0); assert.equal(f.sent.length, 0); await f.drain();
});
test("Search unmetered success reports UNKNOWN rather than free or model-token cost", async t => {
  const f = await setup(t, { fixed: null }); delete f.policy.monthlyBudgetMicros;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "minimax", enabled: true, monthlyBudgetMicros: null });
  const r = await f.request(); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "unpriced_usage");
  assert.equal(events[0].reporting_known_cost_micros, null); assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
  assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].estimated_cost_micros ?? null, null); assert.equal(f.sent.length, 1);
});

for (const route of ["/v1/playground/proxy/minimax/search", "/v1/proxy/minimax/search"]) test("Search never resolves Access sessions at " + route, async t => {
  const f = await setup(t); let authorityCalls = 0;
  const get = f.env.ACCESS_CONTROL.get; f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) { authorityCalls++; return stub.fetch(url, init); } }; };
  const r = await f.call(route, { body: { q: "synthetic" } }, { headers: { authorization: "", "cf-access-jwt-assertion": "synthetic-untrusted" } });
  await denied(f, r); assert.equal(authorityCalls, 0); assert.equal(f.materializations, 0);
});
test("Search downstream remains charged before first pull and retires on cancel", async t => {
  const f = await setup(t); const r = await f.request(); assert.equal(r.status, 200); assert.equal(bodyBudgetCharged(), 72 * MiB);
  await r.body.cancel(); await f.drain(); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.sent.length, 1);
});

for (const manifest of [false, true]) for (const field of ["dailyBudgetMicros", "weeklyBudgetMicros", "monthlyBudgetMicros"])
  for (const duringPreparation of [false, true]) test(`Search current principal ${field}/${manifest ? "manifest" : "native"}/during preparation=${duringPreparation} denies700 against500`, async t => {
    const f = await setup(t);
    Object.assign(f.policy, { budgetScope: "principal", monthlyBudgetMicros: 100000 });
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    const principal = "principal@example.invalid";
    const setLimit = limit => f.authority("/users/put", { email: principal, record: { role: "user", enabled: true,
      tenantId: "tenant", groups: [], budgetOverrides: { fixture: { [field]: limit } } } });
    await setLimit(duringPreparation ? 100000 : 500);
    f.env.ACCESS_CONTROL.objects.get("policy-bindings").db.prepare("UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?")
      .run(JSON.stringify({ ...f.credential, principalId: principal }), "fixture");
    if (duringPreparation) {
      const get = f.env.GRANT_CREDENTIALS.get; let changed = false;
      f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { async fetch(url, init) {
        if (new URL(url).pathname === "/materialize" && !changed) { changed = true; await setLimit(500); }
        return stub.fetch(url, init);
      } }; };
    }
    await denied(f, await f.request(manifest)); assert.equal(f.sent.length, 0);
  });
for (const manifest of [false, true]) for (const change of ["revoke", "rotate", "region"])
  test(`Search final policy await then ${change}/${manifest ? "manifest" : "native"} cannot dispatch the old owner`, async t => {
    const f = await setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
    let armed = false, held = false;
    f.afterBudget(async () => { armed = true; });
    const get = f.env.ACCESS_CONTROL.get;
    f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (armed && !held && new URL(url).pathname === "/authorization/snapshot") { held = true; entered.resolve(); await release.promise; }
      return response;
    } }; };
    const pending = f.request(manifest); await entered.promise;
    if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, actor);
    if (change === "rotate") await f.put({ credential: "synthetic-replacement-key" }, miniMaxSearchBinding("global"));
    if (change === "region") await f.put({}, miniMaxSearchBinding("cn"));
    release.resolve(); await denied(f, await pending); assert.equal(held, true);
  });
