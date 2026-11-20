import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const seedance = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/seedance.json", import.meta.url)));
const video = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/prompt-video.json", import.meta.url)));
const rows = [...seedance.requests.map(row => ({ ...row, wire: seedance })), ...video.requests.map(row => ({ ...row, wire: video }))];
const prefix = "/v1/native/fal", origin = "https://queue.fal.run";
const parameters = path => [...path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);

function declaration() {
  const endpoints = {};
  for (const [id, path] of [["queue", "/${owner}/${app}/${variant}"], ["queue_four", "/${owner}/${app}/${variant}/${subvariant}"]]) {
    endpoints[id] = { path, pathParams: parameters(path), requestFormat: "fal.queue_submit", responseFormat: "fal.queue_submission",
      lifecycle: { protocol: "fal.queue", retrieve: "status", result: "result", cancel: "cancel" } };
  }
  for (const [id, method, suffix, format] of [["status", "GET", "/status", "fal.queue_status"], ["result", "GET", "", "fal.queue_result"], ["cancel", "PUT", "/cancel", "fal.queue_cancel"]]) {
    const path = "/${owner}/${app}/requests/${request_id}" + suffix;
    endpoints[id] = { method, path, pathParams: parameters(path), requestFormat: format, responseFormat: format };
  }
  // Source-owned schema and adapters are exercised without activating a bundled offer.
  return compileProviderSnapshot([{ schema: "clawrouter.service-provider.v1", id: "fal", displayName: "fal fixture", class: "rest_json",
    service: { platform: "fal", kind: "tool_provider", configKeys: ["FAL_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Key ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: origin },
    capabilities: ["queue", "queue_four"].map(endpoint => ({ id: "media.predict", endpoint, methods: ["POST"] })), endpoints }]).providers[0];
}

async function setup(t, row = rows[0], options = {}) {
  const [owner, app, variant, subvariant] = row.model.split("/");
  const params = { owner, app, variant, ...(subvariant ? { subvariant } : {}) };
  const createId = subvariant ? "queue_four" : "queue", root = `/${owner}/${app}/requests/${row.wire.requestId}`;
  const f = await fixture(t, { pooled: true, ...options, providerId: "fal", configure(provider) { Object.assign(provider, declaration()); } });
  f.env.FAL_KEY = "synthetic-environment-alternative";
  Object.assign(f, { row, params, createId, root,
    create(manifest = false, body = row.body, pathParams = params, key = "one-frozen-job") {
      return f.call(manifest ? `/v1/proxy/fal/${createId}` : prefix + "/" + row.model,
        manifest ? { body, pathParams } : body, { headers: { "Idempotency-Key": key } });
    },
    control(action = "status", manifest = false, extra = {}) {
      const suffix = action === "result" ? "" : "/" + action;
      const query = new URLSearchParams({ owner, app, request_id: row.wire.requestId });
      return f.call(manifest ? `/v1/proxy/fal/${action}?${query}` : prefix + root + suffix, null,
        { method: action === "cancel" ? "PUT" : "GET", ...extra });
    },
  });
  f.upstream = request => Response.json(request.method === "POST" ? row.wire.submit : row.wire.running);
  t.after(f.drain);
  return f;
}

async function json(response, expected = 200) {
  const text = await response.text(); assert.equal(response.status, expected, text); return JSON.parse(text);
}
function owner(state) {
  return JSON.parse(state.state.db.prepare("SELECT owner_json FROM http_continuations WHERE background_job_id = ?").get(state.id).owner_json);
}

for (const row of rows) for (const manifest of [false, true]) test(`${row.model} ${manifest ? "manifest" : "native"}: original create survives restart, shared controls and outbox compaction`, { timeout: 10_000 }, async t => {
  const f = await setup(t, row), created = await f.create(manifest), body = await json(created), state = f.state(created);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, origin + "/" + row.model);
  assert.deepEqual(await f.sent[0].clone().json(), row.body);
  assert.equal(f.sent[0].headers.get("x-fal-no-retry"), "1");
  assert.equal(body.status_url, prefix + f.root + "/status");
  assert.equal(body.response_url, prefix + f.root); assert.equal(body.cancel_url, prefix + f.root + "/cancel");
  assert.equal(owner(state).endpointId, f.createId);
  assert.equal(state.job().managed.requestedVersion, row.model);
  assert.deepEqual(state.job().managed.route.pathParams, f.params);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|synthetic-environment-alternative|paper boat/);

  // Both create declarations share the same native control path. List order
  // cannot replace the original route, even after durable reconstruction.
  f.provider.endpoints.reverse(); f.restart();
  await json(await f.control("status", !manifest));
  assert.equal(state.job().managed.terminal, null);
  f.upstream = request => Response.json(request.url.endsWith("/status") ? row.wire.completed : row.wire.result);
  await json(await f.control("status", manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  assert.deepEqual(f.sent.slice(1).map(request => new URL(request.url).pathname), [f.root + "/status", f.root + "/status", f.root]);
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal(state.job().phase, "complete"); assert.equal(owner(state).endpointId, f.createId);
  assert.equal(state.job().managed.requestedVersion, row.model);
  assert.deepEqual(state.job().managed.route.pathParams, f.params);
  assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  const retry = await f.create(!manifest); await retry.text(); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + f.root + "/status");
  await json(await f.control("result", !manifest)); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, origin); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "Key synthetic-original-key");
  }
});

test("Seedance controls reject raw IDs, other callers, foreign owner/app and a changed original grant", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  await json(await f.control(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.control("status", true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  for (const path of [f.root.replace("/bytedance/", "/foreign/"), f.root.replace("/seedance-2.0/", "/other/")]) {
    const response = await f.call(prefix + path + "/status", null); await response.text();
    assert.ok([400, 409].includes(response.status));
  }
  assert.equal(f.sent.length, 1);
  await putGrantCredentials(f.env, grantKey, { provider: "fal", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  const denied = await f.control(); assert.equal((await json(denied, 503)).error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1);
});

for (const row of [rows[0], rows.at(-1)]) test(`${row.model}: cancellation uses original owner/app and never repeats create or cancel`, { timeout: 10_000 }, async t => {
  const f = await setup(t, row), created = await f.create(), state = f.state(created); await json(created); f.restart();
  let canceled = false;
  f.upstream = request => {
    if (request.method === "PUT") { canceled = true; return Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 }); }
    return Response.json(request.url.endsWith("/status") ? canceled ? row.wire.completed : row.wire.running : row.wire.result);
  };
  await json(await f.control("cancel"), 202);
  assert.deepEqual(f.sent.map(request => [request.method, new URL(request.url).pathname]), [
    ["POST", "/" + row.model], ["GET", f.root + "/status"], ["PUT", f.root + "/cancel"], ["GET", f.root + "/status"], ["GET", f.root],
  ]);
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  await state.alarm(); f.restart(); await json(await f.control("cancel")); await f.drain();
  assert.equal(f.sent.filter(request => request.method === "PUT").length, 1);
  assert.equal((await f.events()).length, 1);
});

test("Seedance uncertain create survives restart without remote replay or a free terminal", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic interrupted create"); };
  const created = await f.create(true), state = f.state(created); await json(created, 503); f.restart();
  await json(await f.create(), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  assert.equal((await f.events()).length, 1);
});

test("all frozen Seedance and prompt-video creates retain zero-egress unknown-dollar admission", { timeout: 10_000 }, async t => {
  const f = await setup(t, rows[0], { fixed: null });
  for (const row of rows) {
    const response = await f.call(prefix + "/" + row.model, row.body);
    assert.equal((await json(response, 400)).error.code, "pricing_required");
  }
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

test("dotted Seedance qualification does not open arbitrary depth, traversal, remote assets or other products", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const patch of [{ owner: ".." }, { app: "." }, { app: "seedance%2f2" }, { owner: "foreign" }, { app: "other.2" }, { subvariant: "unsupported" }]) {
    const response = await f.create(true, f.row.body, { ...f.params, ...patch }); await response.text();
    assert.ok(response.status >= 400 && response.status < 500, `invalid route returned ${response.status}`);
  }
  for (const path of ["/bytedance/seedance-2.0/fast/text-to-video/extra", "/bytedance/seedance-2.0%2ffast/text-to-video", "/bytedance%5cforeign/seedance-2.0/text-to-video"]) {
    const response = await f.call(prefix + path, f.row.body); await response.text(); assert.ok(response.status >= 400 && response.status < 500);
  }
  for (const row of rows.filter(row => row.model.endsWith("/image-to-video") || row.model.endsWith("/reference-to-video"))) {
    const body = { ...row.body, ...(row.model.endsWith("/image-to-video") ? { image_url: "https://assets.example/input.png" } : { image_urls: ["https://assets.example/input.png"] }) };
    const response = await f.call(prefix + "/" + row.model, body); await response.text(); assert.equal(response.status, 400);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});
