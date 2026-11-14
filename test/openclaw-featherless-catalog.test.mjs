import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const manifests = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => parse(readFileSync(`providers/${path}`, "utf8")));
assert.equal(manifests.length, 87);
assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
const provider = snapshot.providers.find(row => row.id === "featherless");
const endpoint = provider.endpoints.find(row => row.id === "catalog");
assert.equal(endpoint.request_format, "featherless.catalog");
assert.equal(endpoint.response_format, "featherless.catalog");
assert.equal(endpoint.native_proxy, false);
assert.deepEqual(endpoint.methods, ["GET"]);
const models = provider.models.map(row => ({ id: row.id, upstream: row.upstream }));
assert.equal(models.length, 2);
const specifications = [
  ["table", 3, 200], ["empty", 1, 200], ["maximum", 50, 200], ["policy", 3, 200],
  ["duplicate", 2, 502], ["totals", 2, 502], ["malformed", 2, 502], ["redirect", 2, 502],
  ["limit", 1, 502], ["revoked", 0, 403], ["rotated_old", 0, 401],
  ["rotated_new", 3, 200], ["grant_revoke", 1, 503], ["grant_rotate", 1, 503], ["abort", 3, 200],
];
const cases = specifications.map(([scenario, count, status]) => ({ id: `featherless_${scenario}`, provider: "featherless", scenario, status,
  endpoint: "catalog", format: "featherless.catalog", native: false, route: "/v1/proxy/featherless/catalog", models,
  expected: ["empty"].includes(scenario) ? [] : scenario === "policy" ? [models[0].upstream] : models.map(row => row.upstream),
  urls: Array.from({ length: count }, (_, i) => `https://api.featherless.ai/v1/models?capabilities=chat&page=${i + 1}&per_page=100`) }));
const key = row => `clawrouter-live-${row.id}-${row.scenario === "rotated_new" ? "rotated-secret" : "fixture-secret"}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function barriers() {
  const states = new Map(cases.filter(row => row.scenario === "abort").map(row => [row.id, { seen: deferred(), response: undefined, released: false }]));
  const server = createServer(async (request, response) => {
    const match = /^\/(hold|seen|release)\/([a-z_]+)$/.exec(request.url ?? "");
    const state = match && states.get(match[2]);
    if (!state || request.headers.authorization || request.method !== (match[1] === "release" ? "POST" : "GET")) {
      response.writeHead(400); response.end(); return;
    }
    if (match[1] === "hold") {
      if (state.response) { response.writeHead(409); response.end(); return; }
      state.response = response; state.seen.resolve();
      if (state.released) response.end("released");
    } else if (match[1] === "seen") {
      await state.seen.promise; response.end("seen");
    } else {
      state.released = true; state.response?.end("released"); response.end("released");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, releaseAll() {
    for (const state of states.values()) { state.released = true; state.response?.end("released"); }
  }, async close() {
    for (const state of states.values()) { state.released = true; state.response?.end("teardown"); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

async function withWorker(run) {
  const failures = []; let gates, temporary, mf, retire;
  try {
    gates = await barriers();
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-featherless-catalog-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(gates.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const command = async (path, method = "GET") => {
      const response = await fetch(origin + path, { method });
      const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
    };
    await command("/__catalog/init", "POST");
    retire = () => command("/__catalog/retire", "POST");
    await run({ origin, control: gates.origin, command, mf });
  } catch (error) { failures.push(error); }
  finally {
    // Even a failed assertion releases the real producer and joins original
    // Worker waitUntil/read/cancel promises before disposal. Cleanup is not proof.
    gates?.releaseAll();
    try { await retire?.(); } catch (error) { failures.push(error); }
    try { await gates?.close(); } catch (error) { failures.push(error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "catalog contract or owned cleanup failed");
}

async function verifyCase(f, row) {
  const joined = await f.command(`/__catalog/join/${row.id}`);
  assert.equal(joined.retired, true, row.id);
  assert.equal(joined.charged, 0, row.id);
  assert.equal(joined.calls, row.urls.length, row.id);
  for (const input of joined.inputs) {
    assert.equal(input.onlyExpectedHeaders, true, row.id);
    assert.equal(input.activeReads, 0, row.id);
    assert.equal(input.unlocked, true, row.id);
    assert.equal(input.sourceLocked, false, row.id);
    assert.equal(input.physicalLocked, false, row.id);
    assert.equal(input.pendingSettled, true, "join original read/cancel promises, not only an unlock flag");
    assert.ok(input.eof || input.canceled || input.readRejected, row.id);
    if (row.status === 200) {
      assert.equal(input.eof, true, row.id); assert.equal(input.canceled, false, row.id); assert.equal(input.readRejected, false, row.id);
    }
  }
  if (row.urls.length > 0) {
    const receipt = await f.command(`/__catalog/usage/${row.id}`);
    assert.equal(receipt.usage.events.length, 1, row.id);
    const [event] = receipt.usage.events;
    assert.equal(event.provider, row.provider); assert.equal(event.credential_id, row.id); assert.equal(event.policy_id, row.id);
    assert.equal(event.capability, "models.list"); assert.equal(event.model, null);
    assert.equal(event.cost_basis, "none"); assert.equal(event.actual_cost_micros, 0);
    assert.equal(receipt.budget.spentMicros, 0);
    assert.doesNotMatch(JSON.stringify(event), /fixture-secret|catalog-owner-|must-not-fallback/);
  }
  return joined;
}

// Real Worker/SQLite preparation, separate from execution of the pinned SDK.
test("compiled Featherless complete scans preserve policy, original credentials and physical joins", { timeout: 120_000 }, async () => {
  await withWorker(async f => {
    const selected = cases.filter(row => row.scenario !== "abort");
    for (const row of selected) {
      await f.command(`/__catalog/activate/${row.id}`, "POST");
      const headers = { authorization: `Bearer ${key(row)}` };
      const catalog = await (await fetch(`${f.origin}/v1/catalog`, { headers })).json();
      const offers = catalog.providers.find(value => value.id === row.provider).offers.filter(value => value.endpoint === row.endpoint);
      assert.deepEqual(offers.map(value => value.route), [row.route]);
      const response = await fetch(f.origin + row.route, { headers });
      const body = await response.json();
      assert.equal(response.status, row.status, `${row.id}: ${JSON.stringify(body)}`);
      if (row.status === 200) {
        assert.deepEqual(body.catalog.map(value => value.id), row.expected);
        assert.equal(body.providerId, "featherless");
        assert.equal(JSON.stringify(body).includes("unlisted/"), false);
      } else {
        assert.equal("catalog" in body, false);
        assert.equal(body.error.code, row.status === 403 ? "proxy_key_revoked" : row.status === 401 ? "invalid_proxy_key" : row.status === 503 ? "model_discovery_owner_unavailable" : "invalid_model_discovery_response");
      }
      await verifyCase(f, row);
    }
    await verifyCalls(f, selected);
  });
});

test("a held later page keeps the original response pending until real producer release and joins", { timeout: 120_000 }, async () => {
  await withWorker(async f => {
    const row = cases.find(value => value.scenario === "abort");
    await f.command(`/__catalog/activate/${row.id}`, "POST");
    let settled = false;
    const original = fetch(f.origin + row.route, { headers: { authorization: `Bearer ${key(row)}` } }).then(async response => {
      const body = await response.json(); assert.equal(response.status, 200); return body;
    }).finally(() => { settled = true; });
    try {
      const seen = await fetch(`${f.control}/seen/${row.id}`); assert.equal(await seen.text(), "seen");
      const before = await f.command(`/__catalog/state/${row.id}`);
      assert.equal(settled, false); assert.equal(before.calls, 2); assert.equal(before.inputs[1].eof, false);
    } finally {
      const released = await fetch(`${f.control}/release/${row.id}`, { method: "POST" }); assert.equal(await released.text(), "released");
      assert.deepEqual((await original).catalog.map(value => value.id), row.expected);
    }
    await verifyCase(f, row); await verifyCalls(f, [row]);
  });
});

test("actual registered Featherless catalog through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  await withWorker(async f => {
    await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL("./fixtures/openclaw-featherless-catalog-contract.test.ts", import.meta.url),
      testPath: "extensions/clawrouter/worker-featherless-catalog-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_CONTROL: f.control,
        CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead, CLAWROUTER_CONTRACT_CATALOG_CASES: JSON.stringify(cases) } });
    for (const row of cases) await verifyCase(f, row);
    await verifyCalls(f, cases);
  });
});

async function verifyCalls(f, selected) {
  const upstream = await f.mf.getWorker("upstream");
  const calls = await (await upstream.fetch("https://fixture.example/state")).json();
  assert.equal(calls.length, selected.reduce((sum, row) => sum + row.urls.length, 0));
  for (const row of selected) assert.deepEqual(calls.filter(call => call.id === row.id), row.urls.map(url => ({
    id: row.id, url, method: "GET", bodyless: true,
    headers: [["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id], ["cf-worker", "router.example.com"]],
  })), row.id);
}

function routerFixture() {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
const cases = CASES, rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const records = new Map(), inputs = new Map(), ingested = new Map(cases.map(row => [row.id, deferred()]));
let active, fixtureEnv;
const policy = row => ({ enabled: true, generation: "fixture", providers: [row.provider], models: row.models.filter((_, i) => row.scenario !== "policy" || i === 0).map(model => model.id), tenantId: "fixture",
  monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
const grant = row => ({ provider: row.provider, kind: "api_key", enabled: true, credential: "catalog-owner-" + row.id });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), row = cases.find(value => value.id === active);
  if (!row || !row.urls.includes(request.url)) throw new Error("unexpected provider egress");
  const list = inputs.get(row.id) ?? []; inputs.set(row.id, list);
  if (list.some(value => value.url === request.url)) throw new Error("repeated provider egress");
  const proof = { url: request.url, onlyExpectedHeaders: JSON.stringify([...request.headers]) === JSON.stringify([["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id]]),
    activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, aborted: false, terminal: deferred(), pending: [] };
  list.push(proof);
  request.signal.addEventListener("abort", () => { proof.aborted = true; }, { once: true });
  let response;
  try {
    response = await rawFetch(request);
    if (list.length === 1 && ["grant_revoke", "grant_rotate"].includes(row.scenario)) {
      await putGrantCredentials(fixtureEnv, "oauth/" + row.id + "/featherless", { ...grant(row),
        ...(row.scenario === "grant_revoke" ? { enabled: false, revokedAt: new Date().toISOString() } : { credential: "changed-owner-" + row.id }) });
    }
  }
  catch (error) { proof.readRejected = true; proof.terminal.resolve(); throw error; }
  const physical = response.body;
  if (!physical) { proof.readRejected = true; proof.terminal.resolve(); throw new Error("missing real public catalog body"); }
  proof.status = response.status; proof.headers = [...response.headers]; proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try {
        const pending = reader.read(); proof.pending.push(pending);
        const next = await pending;
        if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
      } catch (error) { proof.readRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.readRejected) unlock(); }
    },
    async cancel(reason) {
      proof.canceled = true;
      try { const pending = reader.cancel(reason); proof.pending.push(pending); await pending; }
      finally { unlock(); }
    },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
const view = (id, retired = false) => ({ calls: (inputs.get(id) ?? []).length, retired, charged: bodyBudgetCharged(),
  inputs: (inputs.get(id) ?? []).map(p => ({ status: p.status, headers: p.headers, onlyExpectedHeaders: p.onlyExpectedHeaders, activeReads: p.activeReads, eof: p.eof,
    canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked, aborted: p.aborted,
    sourceLocked: p.source?.locked ?? false, physicalLocked: p.physical?.locked ?? false, pendingSettled: p.pendingSettled === true })) });
async function join(id) {
  const original = records.get(id); if (!original?.length) throw new Error("no original client request");
  for (const record of original) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) { const batch = record.pending.slice(cursor); cursor += batch.length; await Promise.all(batch); }
  }
  for (const proof of inputs.get(id) ?? []) {
    await proof.terminal.promise;
    await Promise.allSettled(proof.pending); proof.pendingSettled = true;
  }
  return view(id, true);
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    env = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex("fixture-admin") };
    const admin = async (path, body) => {
      const response = await worker.fetch(new Request("https://fixture.example/v1/admin/" + path, { method: "POST",
        headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, context);
      const result = await response.text(); if (!response.ok) throw new Error("fixture authority mutation failed: " + response.status);
      return result;
    };
    const path = new URL(request.url).pathname;
    if (path === "/__catalog/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", cases.map(row => ({ policyId: row.id, policy: policy(row) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", cases.map(row => ({ credentialId: row.id, credential: { enabled: true, secretSha256, policyId: row.id, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [...new Set(cases.map(row => row.provider))].map(providerId => ({ providerId, enabled: true })));
      for (const row of cases) await putGrantCredentials(env, "oauth/" + row.id + "/" + row.provider, grant(row));
      return Response.json({ ready: true });
    }
    if (path === "/__catalog/retire" && request.method === "POST") {
      const results = await Promise.allSettled([...records.keys()].map(join));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return Response.json({ retired: results.length });
    }
    const control = /^\/__catalog\/(activate|state|join|revoke|usage)\/([a-z_]+)$/.exec(path);
    if (control) {
      const [, action, id] = control, row = cases.find(value => value.id === id);
      if (!row) return new Response(null, { status: 404 });
      if (action === "activate" && request.method === "POST") {
        active = id;
        if (row.scenario === "rotated_new") await admin("credentials/" + id + "/rotate", { secretSha256: await sha256Hex("rotated-secret") });
        const response = await rawFetch("https://fixture.example/activate/" + id, { method: "POST" });
        if (!response.ok) throw new Error("fixture activation failed"); await response.arrayBuffer();
        return Response.json({ activated: id });
      }
      if (action === "state") return Response.json(view(id));
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && request.method === "POST") {
        await putGrantCredentials(env, "oauth/" + id + "/" + row.provider, { ...grant(row), enabled: false, revokedAt: new Date().toISOString() });
        return Response.json({ changed: true });
      }
      if (action === "usage") {
        await ingested.get(id).promise;
        return worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + (row.scenario === "rotated_new" ? "-rotated-secret" : "-fixture-secret") } }), env, context);
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-([a-z_]+)-(?:fixture-secret|rotated-secret)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const row = cases.find(value => value.id === id);
    if (!row || active !== id) return new Response(null, { status: 401 });
    if (!["/v1/catalog", row.route].includes(path) || request.method !== "GET" || new URL(request.url).search || request.body) throw new Error("unexpected client route");
    const list = records.get(id) ?? []; records.set(id, list);
    if (list.some(value => value.path === path)) throw new Error("repeated actual catalog route");
    const record = { path, returned: deferred(), pending: [] }; list.push(record);
    try {
      const response = await worker.fetch(request, env, { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } });
      if (path === "/v1/catalog" && response.ok && row.scenario === "revoked") await admin("credentials/" + id + "/revoke");
      if (path === "/v1/catalog" && response.ok && row.scenario === "rotated_old") await admin("credentials/" + id + "/rotate", { secretSha256: await sha256Hex("rotated-secret") });
      return response;
    }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) { await worker.queue(batch, env); for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve(); },
};
`.replace("CASES", JSON.stringify(cases));
}

function upstreamFixture(controlOrigin) {
  return String.raw`
const cases = CASES, calls = []; let active;
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const activation = /^https:\/\/fixture.example\/activate\/([a-z_]+)$/.exec(request.url);
  if (activation && request.method === "POST" && cases.some(row => row.id === activation[1])) {
    active = activation[1]; return Response.json({ ready: true });
  }
  const row = cases.find(value => value.id === active), url = new URL(request.url);
  calls.push({ id: active, url: request.url, method: request.method, bodyless: request.body === null, headers: [...request.headers] });
  if (!row || !row.urls.includes(request.url) || request.method !== "GET" || request.body || JSON.stringify([...request.headers]) !== JSON.stringify([
    ["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id], ["cf-worker", "router.example.com"]])) return new Response(null, { status: 400 });
  const page = Number(url.searchParams.get("page"));
  if (row.scenario === "redirect" && page === 2) return new Response("no follow", { status: 302, headers: { location: "https://api.featherless.ai/v1/elsewhere" } });
  if (row.scenario === "malformed" && page === 2) return Response.json({ data: {} });
  const total = row.scenario === "empty" ? 0 : row.scenario === "maximum" ? 5000 : row.scenario === "limit" ? 5001 : row.scenario === "totals" && page === 2 ? 202 : 201;
  const pages = Math.ceil(total / 100), last = page === pages;
  let data = row.scenario === "empty" ? [] : Array.from({ length: 100 }, (_, i) => ({ id: "unlisted/" + page + "_" + i, object: "model" }));
  if (page === 2 && row.scenario !== "maximum") data = [];
  if (last) data = [...row.models.map(model => ({ id: model.upstream, object: "model", available_on_current_plan: true })), ...(row.scenario === "maximum" ? data.slice(2) : [])];
  if (row.scenario === "duplicate" && page === 2) data = [{ id: "unlisted/1_0", object: "model" }];
  const body = JSON.stringify({ data, pagination: { current_page: page, per_page: 100, total_items: total, total_pages: pages }, total });
  if (row.scenario !== "abort" || page !== 2) return new Response(body, { headers: { "content-type": "application/json" } });
  let first = true;
  return new Response(new ReadableStream({ async pull(controller) {
    if (!first) return; first = false;
    controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
    const gate = await fetch(CONTROL + "/hold/" + row.id, { signal: request.signal, redirect: "manual" });
    if (!gate.ok || await gate.text() !== "released") throw new Error("producer barrier not released by witness");
    controller.enqueue(new TextEncoder().encode(body.slice(10))); controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
} };
`.replace("CASES", JSON.stringify(cases)).replaceAll("CONTROL", JSON.stringify(controlOrigin));
}
