import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const scenarios = ["table", "other", "empty", "malformed", "truncated", "non_success", "too_many", "long_id", "narrow", "revoke", "abort"];
const heldScenarios = ["narrow", "revoke", "abort"];
const table = [
  { id: " MyPolicy ", api: "chat", input_price: "0.25", output_price: 0, supports_reasoning: false, supports_vision: false },
  { id: "MyPolicy", api: "chat", input_price: 99 },
  { id: "vendor/model", api: "chat", context_window: 32000, max_output_tokens: 4096, supports_vision: true },
  { id: "Unknown", api: "chat" },
  { id: "Zero", api: "chat", input_price: 0, output_price: "0", cached_price: "0", caching_price: 0, context_window: 0, max_output_tokens: 0 },
  { id: "StringLimits", api: "chat", context_window: "32000", max_output_tokens: "4096" },
  { id: "MyPolicy@region", api: "chat" },
  { id: "embedding", api: "embeddings" },
];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Explicit producer barriers, not sleeps or polling. Only synthetic case IDs
// cross this control plane; it receives no proxy or upstream credentials.
async function barriers(ids) {
  const states = new Map(ids.map(id => [id, { seen: deferred(), held: undefined, released: false }]));
  const server = createServer(async (request, response) => {
    const match = /^\/(hold|seen|release)\/([a-z_]+)$/.exec(request.url ?? "");
    const state = match && states.get(match[2]);
    if (!state || request.headers.authorization || request.method !== (match[1] === "release" ? "POST" : "GET")) {
      response.writeHead(400); response.end(); return;
    }
    if (match[1] === "hold") {
      if (state.held) { response.writeHead(409); response.end(); return; }
      state.held = response; state.seen.resolve();
      if (state.released) response.end("released");
    } else if (match[1] === "seen") {
      await state.seen.promise; response.end("seen");
    } else {
      // Idempotent failure cleanup may release before a delayed producer arrives.
      if (!state.released) { state.released = true; state.held?.end("released"); }
      response.end("released");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      // Failure cleanup is never counted as a successful retirement witness.
      for (const state of states.values()) state.held?.end("teardown");
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test("actual registered Requesty native discovery through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const requesty = snapshot.providers.find(provider => provider.id === "requesty");
  const endpoint = requesty?.endpoints.find(row => row.id === "models_managed");
  assert.equal(endpoint?.request_format, "requesty.models_managed");
  assert.equal(endpoint.response_format, "requesty.models_managed");
  assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.path, "/models/managed");
  assert.equal(endpoint.method, "GET");
  const ids = scenarios.map(scenario => `rq_native_${scenario}`);
  const failures = [];
  let gates, temporary, mf;
  try {
    gates = await barriers(heldScenarios.map(scenario => `rq_native_${scenario}`));
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-requesty-client-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(ids), upstreamFixture(gates.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const initialized = await fetch(`${origin}/__requesty/init`, { method: "POST" });
    assert.equal(initialized.status, 200, await initialized.text());
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-requesty-catalog-contract.test.ts", import.meta.url),
      testPath: "extensions/clawrouter/worker-requesty-catalog-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CONTROL: gates.origin,
        CLAWROUTER_CONTRACT_DISPATCH: "native", CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, ids.length, "one real managed GET per independent acquisition; no automatic retry or fallback");
    for (const id of ids) {
      const selected = calls.filter(call => call.id === id);
      assert.equal(selected.length, 1, id);
      assert.deepEqual(selected[0], { id, url: "https://router.requesty.ai/v1/models/managed", method: "GET", originalBearer: true, noCredentialOverride: true });
      const joined = await (await fetch(`${origin}/__requesty/join/${id}`)).json();
      assert.equal(joined.calls, 1, id);
      assert.equal(joined.onlyExpectedHeaders, true, id);
      assert.equal(joined.activeReads, 0, id);
      assert.equal(joined.unlocked, true, id);
      assert.equal(joined.sourceLocked, false, id);
      assert.equal(joined.physicalLocked, false, id);
      assert.equal(joined.retired, true, id);
      assert.equal(joined.charged, 0, "real input/retirement join precedes capacity observation and disposal");
      assert.ok(joined.eof || joined.canceled || joined.readRejected, id);
      if (id.endsWith("_non_success")) assert.equal(joined.canceled, true, "real rejected-response cancellation must finish");
      const receipt = await (await fetch(`${origin}/__requesty/usage/${id}`)).json();
      assert.equal(receipt.usage.events.length, 1, id);
      const [event] = receipt.usage.events;
      assert.equal(event.provider, "requesty");
      assert.equal(event.credential_id, id);
      assert.equal(event.policy_id, id);
      assert.equal(event.capability, "models.list");
      assert.equal(event.cost_basis, "none", "metadata disposition is not a free-inference tariff");
      assert.equal(event.actual_cost_micros, 0);
      assert.equal(receipt.budget.spentMicros, 0);
      assert.doesNotMatch(JSON.stringify(event), /fixture-secret|managed-rq_|must-not-fallback/);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    // Every acquired resource gets its cleanup attempt, including failed setup.
    // Keep the original failure and every cleanup failure; teardown is not proof.
    try { await gates?.close(); } catch (error) { failures.push(error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    if (temporary !== undefined) {
      try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Requesty contract or owned-resource cleanup failed");
});

function routerFixture(ids) {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
const ids = IDS;
// This declared model admits Chat transport; metadata never returns it as a seed.
const chatAnchor = "requesty/openai/gpt-6-luna";
const rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = new Map(), catalogs = new Map(), inputs = new Map(), ingested = new Map(ids.map(id => [id, deferred()]));
const policy = id => ({ enabled: true, generation: "fixture", providers: ["requesty"], tenantId: "fixture",
  monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false,
  grantRouting: { environmentFallback: false },
  ...(id.endsWith("_other") ? { models: [chatAnchor, "requesty/OnlyB"] } : {}),
  ...(id.endsWith("_narrow") ? { models: [chatAnchor, "requesty/Keep", "requesty/Remove"] } : {}) });
const grant = id => ({ provider: "requesty", kind: "api_key", enabled: true, credential: "managed-" + id });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== "https://router.requesty.ai/v1/models/managed") throw new Error("unexpected provider egress");
  const id = request.headers.get("authorization")?.replace(/^Bearer managed-/, "");
  if (!ids.includes(id) || inputs.has(id)) throw new Error("unknown owner or repeated provider egress");
  const onlyExpectedHeaders = JSON.stringify([...request.headers]) === JSON.stringify([["accept", "application/json"], ["authorization", "Bearer managed-" + id]]);
  const proof = { calls: 1, onlyExpectedHeaders, activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, aborted: false, terminal: deferred() };
  inputs.set(id, proof);
  request.signal.addEventListener("abort", () => { proof.aborted = true; }, { once: true });
  const response = await rawFetch(request), physical = response.body;
  if (!physical) throw new Error("missing real upstream body");
  proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try {
        const next = await reader.read();
        if (next.done) { proof.eof = true; controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { proof.readRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.readRejected) unlock(); }
    },
    async cancel(reason) { proof.canceled = true; try { await reader.cancel(reason); } finally { unlock(); } },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
const view = (id, retired = false) => { const p = inputs.get(id); return p ? {
  calls: p.calls, onlyExpectedHeaders: p.onlyExpectedHeaders, activeReads: p.activeReads, eof: p.eof, canceled: p.canceled, readRejected: p.readRejected,
  unlocked: p.unlocked, aborted: p.aborted, sourceLocked: p.source?.locked ?? false, physicalLocked: p.physical?.locked ?? false,
  retired, charged: bodyBudgetCharged(),
} : { calls: 0, retired: false }; };
async function join(id) {
  const records = [catalogs.get(id), requests.get(id)].filter(Boolean);
  if (!records.length) throw new Error("no original client request");
  for (const record of records) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) { const batch = record.pending.slice(cursor); cursor += batch.length; await Promise.all(batch); }
  }
  await inputs.get(id)?.terminal.promise;
  return view(id, true);
}
export default {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === "/__requesty/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", ids.map(policyId => ({ policyId, policy: policy(policyId) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", ids.map(credentialId => ({ credentialId, credential: { enabled: true, secretSha256, policyId: credentialId, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [{ providerId: "requesty", enabled: true }]);
      for (const id of ids) await putGrantCredentials(env, "oauth/" + id + "/requesty", grant(id));
      return Response.json({ ready: true });
    }
    const control = /^\/__requesty\/(state|join|narrow|revoke|usage)\/([a-z_]+)$/.exec(path);
    if (control && ids.includes(control[2])) {
      const [, action, id] = control;
      if (action === "state") return Response.json(view(id));
      if (action === "join") return Response.json(await join(id));
      if (action === "narrow" && request.method === "POST") {
        await authorityCall(env, "/policies/put", { policyId: id, policy: { ...policy(id), models: [chatAnchor, "requesty/Keep", "requesty/New"] } });
        return Response.json({ changed: true });
      }
      if (action === "revoke" && request.method === "POST") {
        await putGrantCredentials(env, "oauth/" + id + "/requesty", { ...grant(id), enabled: false, revokedAt: new Date().toISOString() });
        return Response.json({ changed: true });
      }
      if (action === "usage") {
        await ingested.get(id).promise;
        return worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-([a-z_]+)-fixture-secret$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!ids.includes(id)) return new Response(null, { status: 401 });
    const managed = path === "/v1/native/requesty/models/managed";
    if (path !== "/v1/catalog" && !managed) throw new Error("unexpected client route");
    if (managed && requests.has(id)) throw new Error("repeated managed route");
    const record = { pending: [], returned: deferred() };
    if (managed) requests.set(id, record);
    else catalogs.set(id, record);
    const ctx = { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } };
    try {
      return await worker.fetch(request, env, ctx);
    } finally { record.returned.resolve(); }
  },
  async queue(batch, env) {
    await worker.queue(batch, env);
    for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve();
  },
};
`.replace("IDS", JSON.stringify(ids));
}

function upstreamFixture(controlOrigin) {
  return String.raw`
const calls = [], table = TABLE;
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const id = /^Bearer managed-(rq_native_[a-z_]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const noCredentialOverride = request.headers.get("accept") === "application/json" && !["x-api-key", "api-key", "x-goog-api-key"].some(name => request.headers.has(name));
  calls.push({ id, url: request.url, method: request.method, originalBearer: !!id, noCredentialOverride });
  if (!id || request.url !== "https://router.requesty.ai/v1/models/managed" || request.method !== "GET" || !noCredentialOverride) return new Response(null, { status: 400 });
  const scenario = id.replace(/^rq_native_/, "");
  if (["narrow", "revoke", "abort"].includes(scenario)) {
    const body = JSON.stringify({ data: ["Keep", "Remove", "New"].map(id => ({ id, api: "chat" })) });
    let first = true;
    return new Response(new ReadableStream({ async pull(controller) {
      if (!first) return; first = false;
      controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
      const gate = await fetch(CONTROL + "/hold/" + id, { redirect: "manual", signal: request.signal });
      if (!gate.ok || await gate.text() !== "released") throw new Error("producer barrier not released by the witness");
      controller.enqueue(new TextEncoder().encode(body.slice(10))); controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  }
  if (scenario === "truncated") return new Response('{"data":[', { headers: { "content-type": "application/json" } });
  if (scenario === "malformed") return Response.json({ data: {} });
  if (scenario === "non_success") return Response.json({ error: "synthetic rejection" }, { status: 503 });
  if (scenario === "too_many") return Response.json({ data: Array.from({ length: 4097 }, (_, i) => ({ id: "row" + i, api: "chat" })) });
  if (scenario === "long_id") return Response.json({ data: [{ id: "x".repeat(513), api: "chat" }] });
  return Response.json({ data: scenario === "empty" ? [] : scenario === "other" ? [{ id: "OnlyB", api: "chat" }, ...table] : table });
} };
`.replace("TABLE", JSON.stringify(table)).replaceAll("CONTROL", JSON.stringify(controlOrigin));
}
