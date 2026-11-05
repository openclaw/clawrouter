import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/wan/lifecycle.json", import.meta.url)));
const prefix = "/v1/native/alibaba", id = wire.create.response.output.task_id;
const readPath = wire.retrieve.path.replace("${task_id}", id);

// The shipped declaration runs through the real Worker and SQLite owners.
// Actual OpenClaw video consumers and input-asset modes remain separate proof.
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "alibaba", compiledProvider: true });
  f.env.MODELSTUDIO_API_KEY = "synthetic-standard-key";
  f.env.QWEN_API_KEY = "must-not-borrow";
  f.env.DASHSCOPE_API_KEY = "must-not-borrow";
  f.upstream = request => Response.json(request.method === "POST" ? wire.create.response : observation(0));
  f.create = (manifest = false, body = wire.create.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/alibaba/video" : prefix + wire.create.path, manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-wan-job", "x-api-key": "must-not-forward", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/alibaba/task?task_id=${id}` : prefix + readPath, null, extra);
  t.after(f.drain); return f;
}
const observation = index => ({ output: { task_id: id, ...wire.observations[index].native } });
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: catalog to original task survives restart and settles once`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null));
  const provider = catalog.providers.find(provider => provider.id === "alibaba");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider);
  assert.deepEqual(provider.models.map(model => model.id), ["alibaba/wan2.6-t2v"]);
  assert.ok(provider.offers.some(offer => offer.endpoint === "video" && offer.eligible));
  assert.equal(f.sent.length, 0);
  const response = await f.create(manifest); await json(response); const state = f.state(response);
  assert.equal(f.sent[0].url, "https://dashscope-intl.aliyuncs.com" + wire.create.path);
  assert.equal(f.sent[0].headers.get("x-dashscope-async"), "enable");
  assert.deepEqual(await f.sent[0].clone().json(), wire.create.body);
  assert.equal(state.job().managed.requestedVersion, "wan2.6-t2v");
  assert.equal(state.job().managed.upstreamId, id); assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|Synthetic quiet landscape|media\.example/);
  await json(await f.create(!manifest, { ...wire.create.body, input: { prompt: "changed" } }), 409);
  assert.equal(f.sent.length, 1); f.restart();
  await json(await f.read(!manifest)); assert.equal(state.job().managed.terminal, null);
  f.upstream = () => Response.json(observation(1)); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://dashscope-intl.aliyuncs.com");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).pathname === readPath));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].provider, "alibaba"); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  assert.equal(state.job().phase, "complete"); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + readPath); await retry.text();
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: unknown tariffs reject hard-dollar admission with zero egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  assert.equal((await json(await f.create(manifest), 400)).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: UNKNOWN freezes observation loss without refund, polling or replay`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), response = await f.create(manifest); await json(response); const state = f.state(response);
  f.upstream = () => Response.json(observation(4));
  assert.equal((await json(await f.read(!manifest), 410)).error.code, "prediction_observation_unavailable");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.observationUnavailable, "expired_or_unknown");
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(state.job().phase, "complete");
  await json(await f.read(), 410); await json(await f.create(), 410);
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 2);
});

test("compiled Wan raw task IDs, foreign callers and rotated original grants cannot authorize reads", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "alibaba", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  assert.equal((await json(await f.read(), 503)).error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1);
});

test("compiled Wan rejects Coding Plan credentials and unbound input assets before dispatch", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.env.MODELSTUDIO_API_KEY = "sk-sp-synthetic-plan";
  assert.equal((await json(await f.create(), 503)).error.code, "managed_dispatch_unavailable");
  assert.equal(f.sent.length, 0); f.env.MODELSTUDIO_API_KEY = "synthetic-standard-key";
  for (const manifest of [false, true]) {
    const body = { model: "wan2.6-i2v", input: { prompt: "synthetic", img_url: "data:image/png;base64,AAAA" } };
    const response = await f.create(manifest, body, { headers: { "Idempotency-Key": "asset-" + manifest } });
    assert.ok([400, 403].includes(response.status), await response.text());
  }
  assert.equal(f.sent.length, 0);
});

test("compiled Wan uncertain creation is never replayed and cannot imply a free request", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost create reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});

for (const change of ["generation", "lineage"]) test(`Wan ${change} mismatch cannot adopt, publish, repair or fail over to the environment`, async t => {
  const f = await setup(t, { pooled: true });
  f.policy.grantRouting = { failover: true, environmentFallback: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  let materializations = 0, repairs = 0, expected;
  const owner = f.env.GRANT_CREDENTIALS.objects.get(grantKey), get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = key => { const stub = get(key); return { async fetch(url, init) {
    const path = new URL(url).pathname;
    if (path === "/reconcile") repairs++;
    if (path === "/materialize") {
      materializations++;
      const record = structuredClone(owner.values.get("credential"));
      if (change === "generation") record.generation++; else record.lineage = "synthetic-replacement-lineage";
      record.poolSyncPending = true; owner.values.set("credential", record); expected = structuredClone(record);
    }
    return stub.fetch(url, init);
  } }; };
  const response = await f.create(); await json(response, 503); await f.drain();
  assert.equal(materializations, 1); assert.equal(repairs, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(owner.values.get("credential"), expected);
  assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const boundary of ["revoke-after-ack", "deadline-after-ack", "lost-dispatch-ack"]) test(`Wan ${boundary}: dispatch admission is distinct from provider POST`, async t => {
  const f = await setup(t, { pooled: true }), actions = [];
  const namespace = f.env.ACCESS_CONTROL, get = namespace.get;
  if (boundary === "deadline-after-ack") t.mock.timers.enable({ apis: ["setTimeout"] });
  namespace.get = name => { const stub = get(name); return { async fetch(url, init) {
    const path = new URL(url).pathname, request = JSON.parse(init.body);
    if (path === "/responses-background") actions.push(request.action);
    const response = await stub.fetch(url, init);
    if (path === "/responses-background" && request.action === "dispatch") {
      if (boundary === "lost-dispatch-ack") { await response.body.cancel(); throw new Error("synthetic lost dispatch ACK"); }
      if (boundary === "revoke-after-ack") await f.authority("/credentials/mutate", {
        scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
        operation: "revoke", credentialId: "fixture" });
    }
    return response;
  } }; };
  if (boundary === "deadline-after-ack") {
    const credentials = f.env.GRANT_CREDENTIALS, getCredential = credentials.get;
    credentials.get = key => { const stub = getCredential(key); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/inspect" && actions.includes("dispatch")) t.mock.timers.tick(120001);
      return response;
    } }; };
  }
  const response = await f.create(), state = f.state(response), value = await json(response, 503); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(actions.filter(action => action === "dispatch").length, 1);
  if (boundary === "lost-dispatch-ack") {
    assert.equal(actions.filter(action => action === "freeze").length, 0);
    assert.equal(value.error.code, "prediction_submission_unknown");
    assert.equal(state.job().managed.submission, "submission_unknown");
  } else {
    assert.equal(actions.filter(action => action === "freeze").length, 1);
    assert.equal(value.error.code, "prediction_submission_unsent");
    assert.equal(state.job().event.actual_cost_micros, 0);
  }
});

test("Wan scope resolution counts every candidate and denies the whole over-budget scan", async t => {
  const { resolveResponseControlOwner } = await import("../response-controls.ts");
  const { WanManagedOperation } = await import("../managed-media-json.ts");
  const { HttpOperation } = await import("../http-operation.ts");
  const { authenticateProxyKey } = await import("../proxy-auth.ts");
  const f = await setup(t, { pooled: true });
  const auth = await authenticateProxyKey(new Headers({ authorization: "Bearer clawrouter-live-fixture-fixture-secret" }), f.env,
    [{ id: "alibaba", tokenRef: "alibaba" }]);
  let lookups = 0;
  f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => { if (new URL(request.url).pathname === "/http-continuations") lookups++; };
  const operation = new HttpOperation(), owner = new WanManagedOperation("poll");
  try {
    await assert.rejects(resolveResponseControlOwner(f.env, [auth, auth, auth, auth, auth], "0".repeat(64), operation, "alibaba", "video", owner));
    assert.equal(lookups, 0);
    // Even duplicate candidate scopes are not silently narrowed to a first match.
    await assert.rejects(resolveResponseControlOwner(f.env, [auth, auth, auth, auth], "0".repeat(64), operation, "alibaba", "video", owner));
    assert.equal(lookups, 4);
    owner.beginControl(false)(); owner.beginControl(false)(); owner.beginControl(false)();
    assert.throws(() => owner.beginControl(false));
  } finally { operation.stop("complete"); await owner.finish(); }
});

test("Wan environment poll counts both fresh connections, authority, native GET and one observation", async t => {
  const f = await setup(t); await json(await f.create());
  const calls = [], before = f.sent.length;
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    const path = new URL(request.url).pathname;
    if (path === "/http-continuations" || path === "/connections/resolve" || path === "/authorization/snapshot") calls.push(path);
    if (path === "/responses-background") calls.push((await request.clone().json()).action);
  };
  f.upstream = () => Response.json(observation(1)); await json(await f.read()); await f.drain();
  assert.equal(calls.filter(value => value === "/http-continuations").length, 1);
  assert.equal(calls.filter(value => value === "/connections/resolve").length, 2);
  assert.equal(calls.filter(value => value === "/authorization/snapshot").length, 1);
  assert.equal(calls.filter(value => value === "get").length, 1);
  assert.equal(calls.filter(value => value === "managed_observe").length, 1);
  assert.equal(f.sent.length - before, 1); assert.equal(f.sent.at(-1).method, "GET");
});
