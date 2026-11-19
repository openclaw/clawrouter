import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./openclaw-consumer.mjs";
import { startWorkerdFixture } from "./workerd.mjs";

export const memoryModels = ["embedding-v1", "bge-large-zh", "bge-large-en"];
const modes = ["batch16", "batch17", "query", "embedded", "malformed", "eof", "unpriced", "foreign", "missing", "revoked", "budget"];
const cases = memoryModels.flatMap((model, index) => modes.map(mode => ({ model, mode, id: `qmem_${index}_${mode}` })));
const paid = new Set(["batch16", "batch17", "query", "embedded", "malformed", "eof"]);
const token = id => `clawrouter-live-${id}-fixture-secret`;
const secret = id => `synthetic-qianfan-memory-${id}`;

async function allFailures(body, cleanup) {
  const errors = []; let result;
  try { result = await body(); } catch (error) { errors.push(error); }
  for (const fn of cleanup) try { await fn(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Qianfan memory body and cleanup");
  return result;
}

function assertProof(proof) {
  assert.equal(proof.accepted, true); assert.equal(proof.operations, proof.settled);
  assert.equal(proof.rejected, 0); assert.equal(proof.readers, proof.unlocked);
}

export function registerQianfanMemoryTests({ source, sourceHead, observerCode }) {
  test("Qianfan memory declaration has three exact finite models and no invented billing or batch schema", () => {
    const provider = snapshot.providers.find(p => p.id === "qianfan");
    const rows = provider.models.filter(m => m.capabilities.includes("llm.embeddings"));
    assert.deepEqual(rows.map(m => [m.id, m.upstream]), memoryModels.map(id => ["qianfan/" + id, id]));
    const endpoint = provider.endpoints.find(e => e.id === "embeddings");
    assert.equal(endpoint.path, "/embeddings"); assert.equal(endpoint.method, "POST");
    assert.equal(endpoint.request_format, "openai.embeddings"); assert.equal(endpoint.response_format, "openai.embeddings");
    assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.streaming, null);
    for (const model of rows) {
      assert.equal(model.pricing, null); assert.equal(model.nativeCapabilities, undefined);
      assert.equal(model.requestParameters, undefined); assert.equal(model.maxInputsPerRequest, undefined);
    }
  });

  test("Qianfan memory cleanup attempts every independent join including undefined failures", async () => {
    const attempts = [], independent = new Error("synthetic independent cleanup");
    await assert.rejects(allFailures(() => { throw undefined; }, [
      () => { attempts.push(1); throw independent; }, () => { attempts.push(2); },
    ]), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === independent);
    assert.deepEqual(attempts, [1, 2]);
  });

  test("Qianfan memory actual acquisition observer preserves originals and rejects independent cleanup faults", async t => {
    const text = readFileSync(new URL("../fixtures/openclaw-qianfan-memory-contract.test.ts", import.meta.url), "utf8");
    const code = stripTypeScriptTypes(text.slice(text.indexOf("async function observed<"), text.indexOf('describe("registered')));
    for (const mode of ["success", "undefined_release", "wrong_count", "foreign_wrapper", "held_release"]) {
      let releaseHeld; const held = new Promise(resolve => { releaseHeld = resolve; });
      const release = function () { return mode === "undefined_release" ? Promise.reject(undefined) : mode === "held_release" ? held : Promise.resolve(); };
      const result = { response: new Response("synthetic"), release }, original = Promise.resolve(result);
      const guard = { fetchWithSsrFGuard() { return original; } }, originalGuard = guard.fetchWithSsrFGuard;
      const vi = { spyOn(target, key) { return { mockImplementation(fn) { const mock = t.mock.method(target, key, fn); return { mockRestore() { mock.mock.restore(); } }; } }; } };
      const observe = new Function("assert", "guard", "vi", code + "; return observed;")(assert, guard, vi);
      let done = false;
      const pending = observe(mode === "wrong_count" ? 2 : 1, async () => {
        assert.equal(guard.fetchWithSsrFGuard(), original); const actual = await original;
        assert.equal(actual, result); const reader = actual.response.body.getReader();
        assert.equal((await reader.read()).done, false); assert.equal((await reader.read()).done, true); reader.releaseLock();
        await actual.release(); if (mode === "foreign_wrapper") actual.release = () => Promise.resolve();
        return "value";
      });
      if (mode === "held_release") {
        void pending.then(() => { done = true; }, () => { done = true; });
        await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); releaseHeld();
      }
      if (["success", "held_release"].includes(mode)) assert.equal(await pending, "value");
      else await assert.rejects(pending, error => error instanceof AggregateError && (mode !== "undefined_release" || error.errors.includes(undefined)));
      assert.equal(guard.fetchWithSsrFGuard, originalGuard);
      if (mode === "foreign_wrapper") assert.notEqual(result.release, release); else assert.equal(result.release, release);
    }
  });

  for (const native of [false, true]) test(native ? "actual registered Qianfan memory scheduler through workerd and SQLite" : "Qianfan memory real Worker transport and attempt accounting", { skip: native && !source, timeout: 300_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qianfan-memory-"));
    let mf;
    await allFailures(async () => {
      mf = await startWorkerdFixture(temporary, routerScript(observerCode), upstreamScript(observerCode));
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      for (const entry of cases) {
        const policy = { enabled: true, generation: "fixture", providers: [entry.mode === "foreign" ? "openai" : "qianfan"],
          models: ["qianfan/" + entry.model], tenantId: "fixture", monthlyBudgetMicros: entry.mode === "budget" ? 0 : 100,
          requestCostMicros: entry.mode === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false,
          grantRouting: { environmentFallback: false, eligibleGrants: { qianfan: ["qianfan"] } } };
        await kv.put(`policies/${entry.id}`, JSON.stringify(policy));
        await kv.put(`credentials/${entry.id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: entry.id, policyGeneration: "fixture" }));
      }
      await kv.put("connections/qianfan", JSON.stringify({ providerId: "qianfan", enabled: true }));
      const origin = String(await mf.ready).replace(/\/$/, "");
      assert.equal((await fetch(origin + "/fixture/memory/grants", { method: "POST" })).status, 204);
      if (native) await runOpenClawConsumer(t, { source, sourceHead,
        fixture: new URL("../fixtures/openclaw-qianfan-memory-contract.test.ts", import.meta.url),
        testPath: "extensions/qianfan/worker-memory-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin, QIANFAN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } });
      else for (const entry of cases) {
        // Exercise Worker transport locally; only the native branch proves SDK scheduling.
        const sizes = entry.mode === "batch17" ? [16, 1] : [entry.mode === "batch16" ? 16 : 1];
        let offset = 0;
        for (const size of sizes) {
          const response = await fetch(origin + "/v1/native/qianfan/embeddings", { method: "POST",
            headers: { authorization: "Bearer " + token(entry.id), "content-type": "application/json" },
            body: JSON.stringify({ model: entry.model, input: Array.from({ length: size }, (_, i) => entry.id + ":" + (offset + i)) }) });
          if (["batch16", "batch17", "query"].includes(entry.mode)) assert.equal(response.status, 200);
          if (!paid.has(entry.mode)) assert.ok(response.status >= 400, entry.mode);
          await response.arrayBuffer(); offset += size;
        }
      }
      const ingress = await (await fetch(origin + "/fixture/memory/attempts")).json();
      const upstream = await mf.getWorker("upstream");
      const calls = await (await upstream.fetch("https://fixture.example/state")).json();
      assert.equal(calls.length, 21, "three models: 16, 16+1, query and three invalid response attempts; no denied egress/replay");
      for (const entry of cases) {
        const actual = calls.filter(row => row.authorization === "Bearer " + secret(entry.id));
        const counts = entry.mode === "batch17" ? [16, 1] : entry.mode === "batch16" ? [16] : paid.has(entry.mode) ? [1] : [];
        assert.deepEqual(actual.map(row => row.body.input.length), counts, entry.id);
        for (const call of actual) {
          assert.equal(call.url, "https://qianfan.baidubce.com/v2/embeddings"); assert.equal(call.method, "POST");
          assert.equal(call.body.model, entry.model); assert.deepEqual(Object.keys(call.body).sort(), ["input", "model"]);
          assert.ok(call.body.input.every(value => value.startsWith(entry.id + ":")));
        }
        let usage;
        const expectedEvents = entry.mode === "batch17" ? 2 : 1;
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(entry.id) } });
          assert.equal(response.status, 200); usage = await response.json();
          if (usage.usage.events.length >= expectedEvents) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const events = usage.usage.events;
        const attempts = ingress.filter(row => row.id === entry.id);
        assert.deepEqual(events.map(row => row.request_id).sort(), attempts.map(row => row.requestId).sort(), "receipts bind actual original ingress request identities");
        assert.equal(events.length, entry.mode === "batch17" ? 2 : 1, "each authenticated attempt must deliver its own receipt");
        assert.equal(new Set(events.map(event => event.request_id)).size, events.length);
        for (const event of events) {
          assert.equal(event.credential_id, entry.id); assert.equal(event.policy_id, entry.id);
          assert.equal(event.provider, "qianfan"); assert.equal(event.model, "qianfan/" + entry.model);
          assert.equal(event.capability, "llm.embeddings");
          if (["batch16", "batch17", "query"].includes(entry.mode)) {
            assert.equal(event.status, "success"); assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
          } else if (!paid.has(entry.mode)) {
            assert.equal(event.actual_cost_micros, 0); assert.notEqual(event.status, "success");
          } else {
            // The Router accounts the actual response; vector validation belongs
            // to the SDK. A complete JSON data:[] response is billable success at
            // this boundary even though the registered client must reject it.
            assert.equal(event.status, entry.mode === "malformed" ? "success" : "provider_error", entry.id);
            assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
          }
        }
        if (["batch16", "batch17", "query"].includes(entry.mode)) {
          assert.deepEqual(events.map(event => event.input_tokens).sort((a, b) => b - a), counts.map(count => count * 2).sort((a, b) => b - a));
          assert.equal(usage.budget.spentMicros, counts.length * 7);
        } else assert.equal(usage.budget.spentMicros, paid.has(entry.mode) ? 7 : 0);
        assert.doesNotMatch(JSON.stringify(events), /synthetic-qianfan-memory|fixture-secret|qmem_\d+_\w+:\d+/);
      }
    }, [
      async () => { if (mf) assertProof(await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retirement")).json()); },
      async () => { if (mf) assertProof(await (await mf.dispatchFetch("https://fixture.example/fixture/memory/retirement")).json()); },
      async () => { await mf?.dispose(); },
      () => rm(temporary, { recursive: true, force: true }),
    ]);
  });
}

function routerScript(observerCode) {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
${observerCode}
const life = createLifetimeObserver(), attempts = [], originalFetch = globalThis.fetch;
life.patch(globalThis, "fetch", function (...args) { return life.invoke("fetch", originalFetch, this, args, undefined, response => life.response(response)); });
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/memory/attempts") return Response.json(attempts);
  if (path === "/fixture/memory/grants") {
    for (const row of ${JSON.stringify(cases)}) if (row.mode !== "missing") {
      const grant = "oauth/" + row.id + "/qianfan";
      await putGrantCredentials(env, grant, { provider: "qianfan", kind: "api_key", enabled: true, credential: "synthetic-qianfan-memory-" + row.id });
      if (row.mode === "revoked") await revokeGrantCredentials(env, grant);
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/fixture/memory/retirement") {
    let accepted = true;
    await preserveFailures(async () => { try { await life.join(); } catch (error) { accepted = false; throw error; } }, [() => life.restore()]);
    return Response.json({ ...life.summary(), accepted });
  }
  if (!path.startsWith("/v1/native/qianfan/")) return handler.fetch(request, env, context);
  const owner = { request }, ownEnv = { ...env, QIANFAN_API_KEY: "must-not-fallback" };
  const originalWait = context.waitUntil;
  life.patch(context, "waitUntil", function (...args) { life.watch("waitUntil", args[0], owner); return Reflect.apply(originalWait, this, args); });
  return life.invoke("handler", handler.fetch, handler, [request, ownEnv, context], owner, response => {
    const id = request.headers.get("authorization").slice("Bearer clawrouter-live-".length, -"-fixture-secret".length);
    attempts.push({ id, requestId: response.headers.get("x-request-id"), status: response.status });
  });
} };`;
}

function upstreamScript(observerCode) {
  return `${observerCode}
const life = createLifetimeObserver(), calls = [];
export default { async fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retirement") {
    await preserveFailures(() => life.join(), [() => life.restore()]); return Response.json({ ...life.summary(), accepted: true });
  }
  const owner = { request }, body = await life.invoke("request.json", request.json, request, [], owner);
  calls.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), body });
  const mode = String(body.input[0]).split(":")[0].split("_").at(-1);
  if (mode === "embedded") return Response.json({ error: { type: "invalid_request_error", message: "synthetic controlled embedding error" } });
  if (mode === "eof") return new Response('{"data":[', { headers: { "content-type": "application/json" } });
  if (mode === "malformed") return Response.json({ object: "list", data: [], usage: { prompt_tokens: 2, total_tokens: 2 } });
  return Response.json({ object: "list", model: body.model, data: body.input.map((value, index) => {
    const n = Number(value.split(":").at(-1)); return { object: "embedding", index, embedding: [n + 1, n + 2, n + 3] };
  }).reverse(), usage: { prompt_tokens: body.input.length * 2, total_tokens: body.input.length * 2 } });
} };`;
}
