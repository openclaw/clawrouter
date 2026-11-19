import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const routes = JSON.parse(readFileSync(new URL("../../providers/_fixtures/media/managed-routes.json", import.meta.url))).protocols;
const contracts = Object.fromEntries(routes.filter(route => route.protocol !== "replicate.predictions").map(route =>
  [route.protocol, { route, wire: JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${route.fixture}`, import.meta.url))) }]));

async function mediaFixture(t, protocol, options = {}) {
  const { route, wire } = contracts[protocol], native = wire.request ?? wire.submit;
  // Synthetic provider ID deliberately differs from every codec name. Source
  // owners activate YAML; this exercises the same actual Worker/SQLite path.
  const providerId = "media-fixture", prefix = `/v1/native/${providerId}`;
  const f = await fixture(t, { ...options, providerId, configure(provider) {
    const base = structuredClone(provider.endpoints[0]);
    const endpoint = (id, declaration, requestFormat) => ({ ...base, id, ...declaration,
      methods: [declaration.method], native_proxy: true, request_format: requestFormat, response_format: protocol,
      path_params: [...declaration.path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]), path_param_styles: {},
      headers: {}, query: {}, streaming: null });
    const createPath = protocol === "fal.queue" ? "/${owner}/${app}/${variant}" : native.path;
    const create = endpoint("create", { method: "POST", path: createPath }, route.requestFormat);
    create.lifecycle = { protocol, retrieve: "retrieve", ...(route.result ? { result: "result" } : {}), ...(route.cancel ? { cancel: "cancel" } : {}) };
    provider.endpoints = [create, ...["retrieve", "result", "cancel"].filter(action => route[action]).map(action => endpoint(action, route[action], `${protocol}.${action}`))];
    provider.capabilities = [{ id: "media.predict", endpoint: "create" }]; provider.models = [];
  } });
  const id = wire.requestId ?? wire.submission.data?.taskId ?? wire.submission.id;
  const readPath = wire.read?.path ?? wire.controls.status.path;
  const partial = wire.responses?.partial ?? wire.observations.running;
  const terminal = wire.responses?.success ?? wire.responses?.completed ?? wire.observations.completed;
  Object.assign(f, { protocol, wire, route, id, prefix, partial, terminal,
    create(extra = {}, manifest = false) { return f.call(manifest ? "/v1/proxy/media-fixture/create" : prefix + native.path,
      manifest ? { body: native.body, pathParams: route.pathParams } : native.body, extra); },
    read(extra = {}, manifest = false) { return f.call(manifest ? `/v1/proxy/media-fixture/retrieve${protocol === "kie.jobs" ? `?taskId=${id}` : ""}` : prefix + readPath,
      manifest && protocol !== "kie.jobs" ? { body: {}, pathParams: protocol === "fal.queue" ? { owner: route.pathParams.owner, app: route.pathParams.app, request_id: id } : { job_id: id } } : null, extra); },
    controlPath: prefix + readPath,
  });
  f.upstream = request => Response.json(request.method === "POST" ? wire.submission ?? wire.observations.queued : partial);
  return f;
}

for (const protocol of Object.keys(contracts)) {
  test(`${protocol}: native and manifest input bind before delivery; retries survive terminal compaction with one settlement`, { timeout: 10_000 }, async t => {
    const f = await mediaFixture(t, protocol), reached = Promise.withResolvers(), release = Promise.withResolvers();
    f.env.ACCESS_CONTROL.beforeFetch = async (_scope, request) => {
      if (new URL(request.url).pathname === "/responses-background" && (await request.clone().json()).action === "managed_bind") {
        reached.resolve(); await release.promise;
      }
    };
    let delivered = false;
    const pending = f.create({ headers: { "Idempotency-Key": "one-job" } }, true).then(response => { delivered = true; return response; });
    await reached.promise; assert.equal(delivered, false);
    const retry = await f.create({ headers: { "Idempotency-Key": "one-job" } }); assert.equal(retry.status, 202);
    release.resolve(); const response = await pending; assert.equal(response.status, 200, await response.clone().text());
    const state = f.state(response); assert.equal(state.job().managed.upstreamId, f.id); assert.equal(f.sent.length, 1);
    assert.deepEqual(await f.sent[0].clone().json(), (f.wire.request ?? f.wire.submit).body);
    assert.equal(state.job().managed.providerId, "media-fixture");
    assert.equal(JSON.stringify(state.job()).includes("A synthetic blue square"), false);
    assert.equal(state.job().event, null); f.restart();
    f.upstream = request => Response.json(protocol === "fal.queue" && !request.url.endsWith("/status") ? { images: [] } : f.terminal);
    const polled = await f.read({}, true); assert.equal(polled.status, 200, await polled.clone().text());
    assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
    f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.deepEqual(state.job().settlements, ["settled", "settled"]);
    const last = await f.create({ headers: { "Idempotency-Key": "one-job" } });
    assert.equal(last.status, 303); assert.equal(last.headers.get("location"), f.controlPath);
    assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
    assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  });

  test(`${protocol}: unknown create is never replayed; expiry retains the fixed bound`, async t => {
    const f = await mediaFixture(t, protocol); f.upstream = () => { throw new Error("synthetic lost create response"); };
    const response = await f.create({ headers: { "Idempotency-Key": "lost" } }); assert.equal(response.status, 503);
    const state = f.state(response); f.restart();
    assert.equal((await f.create({ headers: { "Idempotency-Key": "lost" } })).status, 202); assert.equal(f.sent.length, 1);
    f.advance(60 * 60_000); await state.alarm(); await f.drain();
    assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().amount, 700);
    assert.equal(state.job().managed.terminal, null); assert.equal(state.job().basis, "policy_fixed");
  });

  test(`${protocol}: hard budgets reject unknown whole-job price before egress`, async t => {
    const f = await mediaFixture(t, protocol, { fixed: null });
    const response = await f.create(); assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).error.code, "pricing_required"); assert.equal(f.sent.length, 0);
  });
}

test("Kie native model is untouched; query identity is exact and cancellation is absent", async t => {
  const f = await mediaFixture(t, "kie.jobs"); await f.create();
  assert.equal((await f.sent[0].clone().json()).model, "kling-2.6/text-to-video");
  const calls = f.sent.length;
  for (const suffix of ["&taskId=other", "&model=other", "&callback=other"]) {
    assert.equal((await f.call(f.controlPath + suffix, null)).status, 400);
  }
  assert.equal((await f.call(f.controlPath, null, { method: "DELETE" })).status, 405);
  assert.equal(f.sent.length, calls); assert.equal(f.provider.endpoints.some(endpoint => endpoint.id === "cancel"), false);
  f.provider.endpoints[0].modelPassthrough = { pricing: null, pricing_ref: null };
  assert.equal((await f.create()).status, 400); assert.equal(f.sent.length, calls);
});

test("fal owner/app and original credential are pinned; result failure is one billable terminal", async t => {
  const f = await mediaFixture(t, "fal.queue", { pooled: true }), response = await f.create(), state = f.state(response);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(); assert.equal(body.status_url, f.controlPath); assert.ok(body.response_url.startsWith(f.prefix));
  assert.equal(f.sent[0].headers.get("X-Fal-No-Retry"), "1");
  const calls = f.sent.length;
  assert.equal((await f.call(f.controlPath.replace("/flux/", "/other/"), null)).status, 409); assert.equal(f.sent.length, calls);
  f.upstream = request => request.url.endsWith("/status") ? Response.json(f.terminal) : Response.json({ detail: "synthetic validation failure" }, { status: 422 });
  assert.equal((await f.read()).status, 200); assert.equal(state.job().managed.terminal, "failed"); assert.equal(state.job().amount, 700);
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
  await putGrantCredentials(f.env, grantKey, { provider: "media-fixture", kind: "api_key", enabled: true, credential: "synthetic-rotated-key" });
  const beforeRotation = f.sent.length, rotated = await f.read();
  assert.equal(rotated.status, 503); assert.equal((await rotated.json()).error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, beforeRotation);
});

test("Vydra DELETE ACK is followed by GET; terminal success wins without repeat cancellation", async t => {
  const f = await mediaFixture(t, "vydra.jobs"), response = await f.create(), state = f.state(response);
  let canceled = false;
  f.upstream = request => {
    if (request.method === "DELETE") { canceled = true; return Response.json(f.wire.cancel.response); }
    return Response.json(canceled ? f.terminal : f.partial);
  };
  const canceledResponse = await f.call(f.controlPath, null, { method: "DELETE" }); assert.equal(canceledResponse.status, 200, await canceledResponse.clone().text());
  assert.deepEqual(await canceledResponse.json(), f.wire.cancel.response);
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "DELETE", "GET"]);
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  assert.equal((await f.call(f.controlPath, null, { method: "DELETE" })).status, 200);
  assert.equal(f.sent.filter(request => request.method === "DELETE").length, 1);
});

test("Kie caller scopes cannot control each other's IDs; disconnected delivery still collects after restart", { timeout: 10_000 }, async t => {
  const f = await mediaFixture(t, "kie.jobs"), reached = Promise.withResolvers(), release = Promise.withResolvers(), abort = new AbortController();
  f.upstream = async () => { reached.resolve(); await release.promise; return Response.json(f.wire.submission); };
  const pending = f.create({ signal: abort.signal }); await reached.promise; abort.abort(); release.resolve();
  const response = await pending; assert.equal(response.status, 200, await response.clone().text());
  const state = f.state(response), calls = f.sent.length;
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential: f.credential });
  const other = await f.read({ headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } });
  assert.equal(other.status, 409); assert.equal(f.sent.length, calls);
  f.restart(); f.upstream = () => Response.json(f.terminal); f.advance(5000); await state.alarm(); await f.drain();
  assert.equal(state.job().phase, "complete"); assert.equal(state.job().managed.terminal, "succeeded");
  assert.equal((await f.events()).length, 1); assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

test("fal PUT cancellation acknowledgement follows only bounded status/result reads", async t => {
  const f = await mediaFixture(t, "fal.queue"), response = await f.create(), state = f.state(response);
  let canceled = false;
  f.upstream = request => {
    if (request.method === "PUT") { canceled = true; const ack = f.wire.cancelAcks.find(ack => ack.httpStatus === 202); return Response.json(ack.body, { status: ack.httpStatus }); }
    return Response.json(request.url.endsWith("/status") ? canceled ? f.terminal : f.partial : { images: [] });
  };
  const canceledResponse = await f.call(f.prefix + f.wire.controls.cancel.path, null, { method: "PUT" });
  assert.equal(canceledResponse.status, 202, await canceledResponse.clone().text());
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "PUT", "GET", "GET"]);
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
});
