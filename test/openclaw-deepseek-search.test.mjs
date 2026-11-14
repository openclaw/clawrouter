import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "82dd065e23b678e61ad497f9d57fbb4c3da10eae";
const successful = ["default", "one", "ten", "empty", "fixed"];
const uncertain = ["malformed", "truncated", "oversized", "non_success", "redirect", "unsafe", "encoding", "abort"];
const denied = ["grant", "foreign", "policy", "revoked", "budget", "key", "long_query", "surrogate", "content", "country", "zero", "eleven", "fraction"];
const scenarios = [...successful, ...uncertain, ...denied];
const query = "site:example.com synthetic search";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// One actual upstream is held open. Only its original request cancellation or
// deadline may close it during the witness; disposal is never a join oracle.
async function abortBarrier() {
  const seen = deferred(), closed = deferred();
  let held;
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    if (request.url === "/hold") {
      if (held) { response.writeHead(409); response.end(); return; }
      held = response;
      response.once("close", () => closed.resolve());
      seen.resolve();
    } else if (request.url === "/seen") {
      await seen.promise; response.end("seen");
    } else if (request.url === "/closed") {
      await closed.promise; response.end("closed");
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      held?.end("teardown");
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("actual OpenClaw DeepSeek native Search through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(row => row.id === "deepseek");
  const endpoint = provider?.endpoints.find(row => row.id === "search");
  assert.equal(provider.base_urls.default, "https://api.deepseek.com");
  assert.equal(endpoint.request_format, "deepseek.search");
  assert.equal(endpoint.response_format, "deepseek.search");
  assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.path, "/v1/tools/search");
  assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.requestPricing.successfulNonemptyRequestMicros, 750);
  assert.equal(endpoint.requestPricing.emptyRequestMicros, 0);
  const ids = scenarios.map(name => `ds_${name}`), failures = [];
  let barrier, temporary, mf;
  try {
    barrier = await abortBarrier();
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-deepseek-client-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(ids), upstreamFixture(barrier.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const initialized = await fetch(`${origin}/__deepseek/init`, { method: "POST" });
    assert.equal(initialized.status, 200, await initialized.text());
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-deepseek-search-contract.test.ts", import.meta.url),
      testPath: "src/agents/tools/worker-clawrouter-deepseek-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CONTROL: barrier.origin, CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.deepEqual(await (await fetch(`${origin}/__deepseek/audit`)).json(), [], "blocked egress/route attempts are failures too");
    assert.equal(calls.length, successful.length + uncertain.length, "no alternate URL, provider, retry or paid denial");
    for (const name of scenarios) {
      const id = `ds_${name}`, paid = !denied.includes(name);
      const selected = calls.filter(call => call.id === id);
      assert.equal(selected.length, paid ? 1 : 0, name);
      if (paid) {
        assert.deepEqual(selected[0].request, {
          url: "https://api.deepseek.com/v1/tools/search", method: "POST", originalBearer: true, noCredentialOverride: true,
          body: { query, count: name === "one" ? 1 : name === "ten" ? 10 : 5, need_content: false },
        });
      }
      const joined = await (await fetch(`${origin}/__deepseek/join/${id}`)).json();
      assert.equal(joined.calls, paid ? 1 : 0, name);
      assert.equal(joined.retired, true, name);
      assert.equal(joined.charged, 0, "actual original waitUntil/reader joins precede disposal");
      if (paid) {
        assert.equal(joined.activeReads, 0, name);
        assert.equal(joined.unlocked, true, name);
        assert.equal(joined.sourceLocked, false, name);
        assert.equal(joined.physicalLocked, false, name);
        assert.ok(joined.eof || joined.canceled || joined.readRejected, name);
        assert.equal(joined.reservedBeforeFetch, name === "fixed" ? 17 : 750, name);
      }
      const receipt = await (await fetch(`${origin}/__deepseek/usage/${id}`)).json();
      if (paid) {
        assert.equal(receipt.usage.events.length, 1, name);
        const [event] = receipt.usage.events;
        const cost = name === "empty" ? 0 : name === "fixed" ? 17 : 750;
        assert.equal(event.provider, "deepseek");
        assert.equal(event.model, null, "Search never borrows Chat model authority");
        assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.capability, "search.web");
        assert.equal(event.reserved_cost_micros, name === "fixed" ? 17 : 750);
        assert.equal(event.cost_basis, name === "fixed" ? "policy_fixed" : uncertain.includes(name) ? "manifest_request_reservation" : "manifest_request");
        assert.equal(event.actual_cost_micros, cost);
        assert.equal(event.pricing_ref, name === "fixed" ? null : "deepseek-search-2026-11-01");
        assert.equal(receipt.budget.spentMicros, cost);
        assert.equal(event.grant_key, `oauth/${id}/deepseek`);
      } else {
        assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0), name);
        assert.equal(receipt.budget.spentMicros, 0, name);
      }
      assert.doesNotMatch(JSON.stringify(receipt.usage.events), /fixture-secret|managed-ds_|must-not-fallback|synthetic search|Synthetic summary/);
    }
    assert.equal(calls.find(call => call.id === "ds_abort").finished, true, "held upstream really ended before teardown");
  } catch (error) { failures.push(error); }
  finally {
    try { await barrier?.close(); } catch (error) { failures.push(error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "DeepSeek contract or owned cleanup failed");
});

function routerFixture(ids) {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
import { budgetStatus } from "./worker/ledgers.ts";
const ids = IDS, rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = new Map(), inputs = new Map(), ingested = new Map(ids.map(id => [id, deferred()])), violations = [];
function refuse(reason) { violations.push(reason); throw new Error(reason); }
let fixtureEnv;
const policy = id => ({ enabled: true, generation: "fixture", providers: id === "ds_policy" ? ["openai"] : ["deepseek"], tenantId: "fixture",
  monthlyBudgetMicros: id === "ds_budget" ? 749 : 10000, requestCostMicros: id === "ds_fixed" ? 17 : null,
  budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== "https://api.deepseek.com/v1/tools/search" || request.method !== "POST") refuse("unexpected provider egress");
  const id = /^Bearer managed-(ds_[a-z_]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!ids.includes(id) || inputs.has(id)) refuse("unknown owner or repeated provider egress");
  const proof = { activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, terminal: deferred(),
    reservedBeforeFetch: (await budgetStatus(fixtureEnv, id, policy(id))).spentMicros };
  inputs.set(id, proof);
  const response = await rawFetch(request), physical = response.body;
  if (!physical) throw new Error("missing real upstream body");
  proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try { const next = await reader.read(); if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value); }
      catch (error) { proof.readRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.readRejected) unlock(); }
    },
    async cancel(reason) { proof.canceled = true; try { await reader.cancel(reason); } finally { unlock(); } },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
async function join(id) {
  for (const record of requests.get(id) ?? []) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) { const batch = record.pending.slice(cursor); cursor += batch.length; await Promise.all(batch); }
  }
  const p = inputs.get(id); await p?.terminal.promise;
  return { paths: (requests.get(id) ?? []).map(row => row.path), calls: p ? 1 : 0, retired: true, charged: bodyBudgetCharged(), ...(p ? {
    activeReads: p.activeReads, eof: p.eof, canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked,
    sourceLocked: p.source.locked, physicalLocked: p.physical.locked, reservedBeforeFetch: p.reservedBeforeFetch,
  } : {}) };
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    const path = new URL(request.url).pathname;
    if (path === "/__deepseek/audit") return Response.json(violations);
    if (path === "/__deepseek/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", ids.map(policyId => ({ policyId, policy: policy(policyId) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", ids.map(credentialId => ({ credentialId, credential: { enabled: true, secretSha256, policyId: credentialId, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [{ providerId: "deepseek", enabled: true }]);
      for (const id of ids) if (id !== "ds_grant") await putGrantCredentials(env, "oauth/" + id + "/deepseek",
        { provider: id === "ds_foreign" ? "openai" : "deepseek", kind: "api_key", enabled: true, credential: "managed-" + id });
      return Response.json({ ready: true });
    }
    const control = /^\/__deepseek\/(join|usage|revoke)\/(ds_[a-z_]+)$/.exec(path);
    if (control && ids.includes(control[2])) {
      const [, action, id] = control;
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && id === "ds_revoked" && request.method === "POST") {
        await revokeGrantCredentials(env, "oauth/" + id + "/deepseek"); return Response.json({ revoked: true });
      }
      if (action === "usage") {
        await join(id); if (inputs.has(id)) await ingested.get(id).promise;
        const response = await worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
        return response;
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-(ds_[a-z_]+)-/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!ids.includes(id)) refuse("unknown client credential");
    if (!["/v1/catalog", "/v1/native/deepseek/v1/tools/search"].includes(path)) refuse("unexpected client route");
    const records = requests.get(id) ?? []; requests.set(id, records);
    if (records.some(row => row.path === path)) refuse("repeated client route");
    const record = { path, pending: [], returned: deferred() }; records.push(record);
    const ctx = { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } };
    try { return await worker.fetch(request, { ...env, DEEPSEEK_API_KEY: "must-not-fallback-deepseek" }, ctx); }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) {
    await worker.queue(batch, env);
    for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve();
  },
};
`.replace("IDS", JSON.stringify(ids));
}

function upstreamFixture(control) {
  return String.raw`
const calls = [];
const result = { title: "Synthetic result", url: "https://example.com/result", summary: "Synthetic summary", snippet: "Lower-priority snippet",
  date: "2026-11-01T00:00:00Z", site_name: "Example" };
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const id = /^Bearer managed-(ds_[a-z_]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const noCredentialOverride = !["x-api-key", "x-deepseek-api-key", "api-key"].some(name => request.headers.has(name));
  const call = { id, request: { url: request.url, method: request.method, originalBearer: !!id, noCredentialOverride, body: await request.json() }, finished: false };
  calls.push(call);
  if (!id || request.url !== "https://api.deepseek.com/v1/tools/search" || request.method !== "POST" || !noCredentialOverride) return new Response(null, { status: 400 });
  const scenario = id.slice(3), headers = { "content-type": "application/json" };
  if (scenario === "abort") {
    let started = false;
    return new Response(new ReadableStream({ async pull(controller) {
      if (started) return; started = true; controller.enqueue(new TextEncoder().encode('{"results":['));
      try {
        const held = await fetch(CONTROL + "/hold", { signal: request.signal });
        await held.body?.cancel(); throw new Error("held response ended without original cancellation");
      } catch (error) { controller.error(error); }
      finally { call.finished = true; }
    } }, { highWaterMark: 0 }), { headers });
  }
  call.finished = true;
  if (scenario === "truncated") return new Response('{"results":[', { headers });
  if (scenario === "malformed") return Response.json({ results: {} });
  if (scenario === "oversized") return Response.json({ results: [{ ...result, summary: "x".repeat(1024 * 1024 + 1) }] });
  if (scenario === "non_success") return Response.json({ error: "synthetic rejection" }, { status: 503 });
  if (scenario === "redirect") return new Response("redirect refused", { status: 307, headers: { ...headers, location: "https://alternate.example/search" } });
  if (scenario === "unsafe") return Response.json({ results: [{ ...result, url: "javascript:void(0)" }] });
  if (scenario === "encoding") return Response.json({ results: [] }, { headers: { "content-encoding": "unsupported-encoding" } });
  return Response.json({ results: ["empty", "fixed"].includes(scenario) ? [] : [result] });
} };
`.replace("CONTROL", JSON.stringify(control));
}
