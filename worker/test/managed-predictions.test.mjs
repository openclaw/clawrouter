import assert from "node:assert/strict";
import test from "node:test";
import { fixture, contract, path, control, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");

// Explicit undefined must remain GET rather than invoking a default body.
const get = (f, route = control, extra = {}) => f.call(route, null, { ...extra, method: "GET" });

test("native submit binds before exposing ID, canonical concurrent retries reuse one reservation and caller URLs", async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), release = Promise.withResolvers();
  const catalogResponse = await get(f, "/v1/catalog");
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.scope.credentialId, "fixture");
  const offered = catalog.providers.find(provider => provider.id === "replicate");
  const create = offered.offers.find(offer => offer.endpoint === "predictions" && offer.routeKind === "native" && offer.transport === "http" && offer.eligible && offer.modelId === null);
  assert.ok(create, "versioned job submission must offer a model-less native operation");
  assert.equal(create.route, path);
  assert.equal(f.sent.length, 0, "catalog discovery never submits a prediction");
  f.env.ACCESS_CONTROL.beforeFetch = async (_scope, request) => {
    if (new URL(request.url).pathname !== "/responses-background") return;
    const input = await request.clone().json();
    if (input.action === "managed_bind") { reached.resolve(); await release.promise; }
  };
  let delivered = false;
  const first = f.call(create.route, contract.request.body, { headers: { "Idempotency-Key": "same-key", Prefer: "wait", "Cancel-After": "2h" } }).then(response => { delivered = true; return response; });
  await reached.promise; assert.equal(delivered, false);
  const pending = await f.call(path, { input: contract.request.body.input, version: contract.request.body.version }, { headers: { "Idempotency-Key": "same-key", "Cancel-After": "600s" } });
  assert.equal(pending.status, 202); assert.equal((await pending.json()).submission, "submission_unknown");
  release.resolve(); const response = await first;
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(), state = f.state(response);
  assert.deepEqual(body.urls, { get: control, cancel: `${control}/cancel` });
  assert.equal(state.job().managed.submission, "bound"); assert.equal(state.job().event, null);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("Prefer"), null); assert.equal(f.sent[0].headers.get("Idempotency-Key"), null); assert.equal(f.sent[0].headers.get("Cancel-After"), "600s");
  assert.deepEqual(await f.sent[0].json(), contract.request.body);
  const duplicate = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "same-key" } });
  assert.equal(duplicate.status, 303); assert.equal(duplicate.headers.get("location"), control);
  assert.equal(duplicate.headers.get("x-clawrouter-background-recovery"), response.headers.get("x-clawrouter-background-recovery"));
  const conflict = await f.call(path, { ...contract.request.body, input: { prompt: "different" } }, { headers: { "Idempotency-Key": "same-key" } });
  assert.equal(conflict.status, 409); assert.equal(f.sent.length, 1);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  assert.equal(JSON.stringify(state.job()).includes(contract.request.body.input.prompt), false);
});

test("lost create response stays unknown across retry and restart, then conservatively settles once", async t => {
  const f = await fixture(t); f.upstream = () => { throw new Error("synthetic lost create response"); };
  const response = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "lost-create" } });
  assert.equal(response.status, 503); const state = f.state(response); assert.equal(state.job().managed.submission, "submission_unknown");
  f.restart(); const retry = await f.call(path, contract.request.body, { headers: { "Idempotency-Key": "lost-create" } });
  assert.equal(retry.status, 202); assert.equal(f.sent.length, 1); assert.equal(state.job().event, null);
  f.advance(3_600_000); await state.alarm();
  const final = state.job(); assert.equal(final.amount, 700); assert.equal(final.basis, "policy_fixed"); assert.equal(final.managed.terminal, null);
  assert.equal(final.phase, "complete"); assert.equal(f.sent.length, 1); assert.equal((await f.events()).length, 1);
});

test("poll and cancel observe the original job, with GET before cancel and partial output remaining open", async t => {
  const f = await fixture(t), response = await f.call(), state = f.state(response);
  assert.equal((await get(f)).status, 200); assert.equal(state.job().event, null);
  const before = f.budgetCalls.length;
  const canceled = await f.call(`${control}/cancel`, null, { method: "POST" });
  assert.equal(canceled.status, 200); assert.deepEqual(f.sent.slice(-2).map(request => request.method), ["GET", "POST"]);
  assert.equal(state.job().event, null, "HTTP success and partial output do not prove generation completion");
  f.upstream = () => Response.json(contract.responses.succeeded);
  const raced = await f.call(`${control}/cancel`, null, { method: "POST" });
  assert.equal(raced.status, 200); assert.equal(f.sent.at(-1).method, "GET");
  assert.equal(f.sent.filter(request => request.url.endsWith("/cancel")).length, 1);
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(f.budgetCalls.length, before);
});

for (const status of ["succeeded", "failed", "canceled", "aborted"]) test(`immediate ${status} without metrics freezes policy-fixed settlement and never polls`, async t => {
  const f = await fixture(t); f.upstream = () => Response.json({ ...contract.responses.created, status });
  const response = await f.call(), state = f.state(response);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(state.job().managed.terminal, status);
  assert.equal(state.job().event.actual_cost_micros, 700); assert.equal(state.job().event.cost_basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); assert.equal(state.job().phase, "outbox");
  const event = state.job().event; assert.equal((await f.events()).length, 1);
  f.restart(); f.advance(60_000); await state.alarm();
  assert.equal(state.job().phase, "complete"); assert.equal(state.job().usage, "duplicate");
  assert.deepEqual(await f.events(), [event]); assert.equal(f.sent.length, 1);
});

test("unknown and other-caller IDs make zero egress; original grant rotation fails closed", async t => {
  const f = await fixture(t, { pooled: true }), response = await f.call(); assert.equal(response.status, 200, await response.clone().text());
  const calls = f.sent.length;
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential: f.credential });
  const other = await get(f, control, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } });
  assert.equal(other.status, 409); assert.equal((await get(f, `${path}/unknown`)).status, 409); assert.equal(f.sent.length, calls);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, tenantId: "other-tenant" } });
  assert.equal((await get(f)).status, 409); assert.equal(f.sent.length, calls);
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await putGrantCredentials(f.env, grantKey, { provider: "replicate", kind: "api_key", enabled: true, credential: "synthetic-rotated-key" });
  assert.notEqual((await get(f)).status, 200); assert.equal(f.sent.length, calls);
});

test("unknown price, malformed IDs, query overrides and webhook creation fail before upstream", async t => {
  const f = await fixture(t, { fixed: null });
  const denied = await f.call(); assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, providers: ["openai"] } });
  assert.equal((await f.call()).status, 403, "provider policy denial precedes protocol validation");
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, requestCostMicros: 700 } });
  for (const route of [`${path}/invalid%3Fid`, `${control}?token=other`, `${path}?version=other`]) {
    const response = route.includes("/prediction_fixture") || route.includes("invalid") ? await get(f, route) : await f.call(route);
    assert.ok(response.status >= 400);
  }
  assert.equal((await f.call(path, { ...contract.request.body, webhook: "https://callback.example" })).status, 400);
  assert.equal(f.sent.length, 0);
});

test("disconnect ends delivery ownership but in-flight creation still binds and remains collectible", async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(), abort = new AbortController();
  f.upstream = async () => { entered.resolve(); await release.promise; return Response.json(contract.responses.created); };
  const pending = f.call(path, contract.request.body, { signal: abort.signal });
  await entered.promise; abort.abort(); release.resolve(); const response = await pending; await f.drain();
  const state = f.state(response); assert.equal(state.job().managed.submission, "bound");
  f.upstream = () => Response.json(contract.responses.succeeded); f.advance(5000); await state.alarm();
  assert.equal(state.job().phase, "complete"); assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET"]);
});

test("poll 404 and mismatched identities cannot refund or replace the original ID; restart can collect", async t => {
  const f = await fixture(t), response = await f.call(), state = f.state(response);
  f.upstream = () => new Response("expired upstream content", { status: 404 }); f.advance(5000); await state.alarm();
  assert.equal(state.job().event, null); assert.equal(state.job().managed.upstreamId, contract.responses.created.id);
  f.upstream = () => Response.json({ ...contract.responses.succeeded, id: "other" });
  assert.equal((await get(f)).status, 503); assert.equal(state.job().event, null);
  f.restart(); f.upstream = () => Response.json(contract.responses.succeeded); f.advance(30_000); await state.alarm();
  assert.equal(state.job().phase, "complete"); assert.equal(state.job().amount, 700);
});

test("manifest controls use the same binding and undeclared prediction endpoints cannot fall through", async t => {
  const f = await fixture(t), response = await f.call("/v1/proxy/replicate/predictions", { body: contract.request.body });
  assert.equal(response.status, 200, await response.clone().text());
  const polled = await get(f, `/v1/proxy/replicate/prediction?prediction_id=${contract.responses.created.id}`); assert.equal(polled.status, 200);
  const canceled = await f.call("/v1/proxy/replicate/prediction_cancel", { body: {}, pathParams: { prediction_id: contract.responses.created.id } }); assert.equal(canceled.status, 200, await canceled.clone().text());
  const count = f.sent.length; delete f.provider.endpoints.find(endpoint => endpoint.id === "predictions").lifecycle;
  assert.ok((await f.call()).status >= 400); assert.ok((await get(f)).status >= 400); assert.equal(f.sent.length, count);
});
