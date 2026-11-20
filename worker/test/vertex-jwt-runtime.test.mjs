import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureVertex, vertexBody, vertexJson, vertexSse, vertexModelId } from "./vertex-runtime-fixture.mjs";
import { syntheticVertexKey, signingBinding, tokenBody } from "./vertex-jwt-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { inspectGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const signing = await syntheticVertexKey();
async function setup(t, fixed = 700) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "anthropic")); configureVertex(provider);
  const f = await fixture(t, { providerId: "anthropic-vertex", fixed, configure(target) { Object.assign(target, provider); } });
  f.env.GOOGLE_API_KEY = "synthetic-forbidden-environment"; f.env.ANTHROPIC_API_KEY = "synthetic-forbidden-anthropic";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  f.admin = (body, headers = {}) => f.call("/v1/admin/upstream-grants/policies/fixture/replicate", body,
    { method: "PUT", headers: { authorization: "Bearer synthetic-admin", ...headers } });
  f.put = async body => { const response = await f.admin(body), text = await response.text(); assert.equal(response.status, 200, text); assert.doesNotMatch(text, /PRIVATE KEY|vertexPrivateKey/); return JSON.parse(text); };
  await f.put({ provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer", vertexAnthropicAuthorization: signingBinding(), vertexServiceAccountPrivateKey: signing.pem });
  f.policy.models = [vertexModelId]; f.policy.grantRouting = { eligibleGrants: { "anthropic-vertex": ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (manifest = false, stream = false) => f.call(manifest ? "/v1/proxy/anthropic-vertex/messages" : "/v1/native/anthropic-vertex/v1/messages",
    manifest ? { body: { ...vertexBody(stream), model: vertexModelId } } : vertexBody(stream));
  f.upstream = async request => {
    if (request.url === "https://oauth2.googleapis.com/token") return Response.json(tokenBody());
    const body = await request.clone().json();
    return body.stream ? new Response(vertexSse(), { headers: { "content-type": "text/event-stream" } }) : Response.json(vertexJson());
  };
  f.afterDispatch = change => { const get = f.env.BUDGET_LEDGER.get; let changed = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init); if (new URL(url).pathname === "/dispatch" && !changed) { changed = true; await change(); } return response;
    } }; }; };
  f.inference = () => f.sent.filter(r => r.url !== "https://oauth2.googleapis.com/token");
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); }); return f;
}
for (const manifest of [false, true]) for (const stream of [false, true])
  test(`Vertex JWT actual Worker ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} refreshes and settles once`, async t => {
    const f = await setup(t), response = await f.request(manifest, stream);
    assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), stream ? vertexSse() : JSON.stringify(vertexJson()));
    await f.drain(); assert.equal(f.sent.length, 2); assert.equal(f.inference().length, 1);
    const wire = f.inference()[0]; assert.equal(wire.headers.get("authorization"), "Bearer synthetic-jwt-access");
    assert.equal((await wire.clone().json()).model, undefined);
    assert.match(wire.url, /^https:\/\/us-east5-aiplatform\.googleapis\.com\/v1\/projects\/fixture-project\/locations\/us-east5\/publishers\/anthropic\/models\//);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
    assert.equal((await inspectGrantCredentials(f.env, grantKey)).hasRefreshToken, false);
  });
for (const mutation of ["revoke", "binding", "generation", "policy"])
  test(`Vertex JWT fresh original authority after budget wait denies ${mutation}`, async t => {
    const f = await setup(t);
    f.afterDispatch(async () => {
      if (mutation === "revoke") await revokeGrantCredentials(f.env, grantKey);
      else if (mutation === "binding") await f.put({ vertexAnthropicAuthorization: signingBinding({ location: "eu" }), vertexServiceAccountPrivateKey: signing.pem });
      else if (mutation === "generation") await f.put({ label: "changed" });
      else await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, models: [] } });
    });
    const response = await f.request(); assert.notEqual(response.status, 200); await response.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.inference().length, 0);
    for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
  });
test("Vertex JWT warm admission cannot prefetch exchange before unknown-dollar denial", async t => {
  const f = await setup(t); overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 60000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const warm = await f.request(); assert.equal(warm.status, 200); await warm.text(); await f.drain();
  f.advance(3600000); delete f.policy.requestCostMicros;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const before = f.sent.length, denied = await f.request(); assert.notEqual(denied.status, 200); await denied.text(); await f.drain();
  assert.equal(f.sent.length, before);
});
test("Vertex key-only unknown USD denies before any exchange or paid inference", async t => {
  const f = await setup(t, null); delete f.policy.requestCostMicros; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const response = await f.request(); assert.notEqual(response.status, 200); await response.text(); await f.drain(); assert.equal(f.sent.length, 0);
});
for (const edit of [{ vertexServiceAccountPrivateKey: signing.pem }, { vertexPrivateKey: signing.pem },
  { vertexAnthropicAuthorization: { ...signingBinding(), tokenUrl: "https://foreign.invalid/token" }, vertexServiceAccountPrivateKey: signing.pem }])
  test(`Vertex admin rejects non-explicit signing source ${Object.keys(edit)[0]}`, async t => {
    const f = await setup(t), response = await f.admin(edit); assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /PRIVATE KEY|synthetic-jwt-access/); assert.equal(f.sent.length, 0);
  });
test("Vertex proxy caller cannot mutate signing authority", async t => {
  const f = await setup(t); const response = await f.admin({ vertexAnthropicAuthorization: signingBinding(), vertexServiceAccountPrivateKey: signing.pem },
    { authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
  assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /PRIVATE KEY/); assert.equal(f.sent.length, 0);
});
