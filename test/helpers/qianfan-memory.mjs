import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./openclaw-consumer.mjs";
import { startBundledWorkerdFixture, startWorkerdFixture } from "./workerd.mjs";

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

export function registerQianfanMemoryTests({ source, sourceHead, observerCode, bundleOutcome }) {
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

  test("Qianfan memory cancellation observer keeps foreign and undefined originals and held/failed releases fatal", async t => {
    const text = readFileSync(new URL("../fixtures/openclaw-qianfan-memory-contract.test.ts", import.meta.url), "utf8");
    const code = stripTypeScriptTypes(text.slice(text.indexOf("async function observed<"), text.indexOf('describe("registered')));
    for (const mode of ["owned", "foreign_reason", "undefined_reason", "release_undefined", "held_release"]) {
      let releaseHeld, signal, controller;
      const held = new Promise(resolve => { releaseHeld = resolve; });
      const foreign = new Error("foreign stream failure"), releaseFault = undefined;
      const guard = { async fetchWithSsrFGuard(input) {
        signal = input.signal;
        const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new Uint8Array([123])); } });
        signal.addEventListener("abort", () => controller.error(mode === "foreign_reason" ? foreign : mode === "undefined_reason" ? undefined : signal.reason), { once: true });
        return { response: new Response(body), release() { return mode === "release_undefined" ? Promise.reject(releaseFault) : mode === "held_release" ? held : Promise.resolve(); } };
      } };
      const vi = { spyOn(target, key) { return { mockImplementation(fn) { const mock = t.mock.method(target, key, fn); return { mockRestore() { mock.mock.restore(); } }; } }; } };
      const cancel = new Function("assert", "guard", "vi", code + ";return observedCancellation;")(assert, guard, vi);
      const pending = cancel(async signal => {
        const result = await guard.fetchWithSsrFGuard({ signal }); const reader = result.response.body.getReader();
        try { for (;;) { const next = await reader.read(); if (next.done) return; } }
        finally { await Promise.allSettled([reader.cancel()]); reader.releaseLock(); await result.release(); }
      });
      if (mode === "held_release") {
        let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
        for (let i = 0; i < 10 && !signal?.aborted; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(signal.aborted, true); assert.equal(finished, false); releaseHeld();
      }
      if (["owned", "held_release"].includes(mode)) assert.equal((await pending).releaseFulfilled, true);
      else await assert.rejects(pending, error => {
        const flatten = value => value instanceof AggregateError ? value.errors.flatMap(flatten) : [value];
        const originals = flatten(error); return error instanceof AggregateError && (mode === "foreign_reason" ? originals.includes(foreign) : originals.includes(undefined));
      });
    }
  });

  test("Qianfan memory real post-header caller cancellation retires each original Worker source", { timeout: 60_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qianfan-memory-cancel-"));
    await allFailures(async () => {
      for (let index = 0; index < memoryModels.length; index++) {
        const fixture = await memoryCancellationFixture(join(temporary, String(index)), index, observerCode, bundleOutcome);
        let qualified = false;
        await allFailures(async () => {
          const caller = new AbortController(), reason = new Error("synthetic original memory caller abort");
          const response = await fetch(fixture.origin + "/v1/native/qianfan/embeddings", { method: "POST", signal: caller.signal,
            headers: { authorization: "Bearer " + token(fixture.id), "content-type": "application/json" },
            body: JSON.stringify({ model: fixture.model, input: [fixture.id + ":0"] }) });
          assert.equal(response.status, 200); const reader = response.body.getReader(), closed = reader.closed;
          void closed.catch(() => {});
          const first = await reader.read(); assert.equal(first.done, false); assert.ok(first.value.length > 0);
          const pending = reader.read(); caller.abort(reason);
          await assert.rejects(pending); await Promise.allSettled([pending, closed]); reader.releaseLock();
          assert.equal(response.body.locked, false); qualified = true;
        }, [async () => t.diagnostic(JSON.stringify({ model: fixture.model, caller: "actual Node fetch", ...await fixture.retire(qualified) })), () => fixture.mf.dispose()]);
      }
    }, [() => rm(temporary, { recursive: true, force: true })]);
  });

  for (const native of [false, true]) test(native ? "actual registered Qianfan memory scheduler through workerd and SQLite" : "Qianfan memory real Worker transport and attempt accounting", { skip: native && !source, timeout: 300_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qianfan-memory-"));
    let mf, cancelQualified = false; const cancellation = [], cancelRecords = [];
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
      if (native) for (let index = 0; index < memoryModels.length; index++) cancellation.push(await memoryCancellationFixture(join(temporary, "cancel-" + index), index, observerCode, bundleOutcome));
      const memoryContext = { diagnostic(text) {
        for (const line of String(text).split("\n")) {
          const at = line.indexOf("QIANFAN_MEMORY_CANCEL ");
          if (at >= 0) cancelRecords.push(JSON.parse(line.slice(at + "QIANFAN_MEMORY_CANCEL ".length).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")));
        }
        t.diagnostic(text);
      } };
      if (native) await runOpenClawConsumer(memoryContext, { source, sourceHead,
        fixture: new URL("../fixtures/openclaw-qianfan-memory-contract.test.ts", import.meta.url),
        testPath: "extensions/qianfan/worker-memory-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_MEMORY_CANCEL_ORIGINS: JSON.stringify(cancellation.map(f => f.origin)), QIANFAN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } });
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
      if (native) {
        assert.equal(cancelRecords.length, 3);
        for (const model of memoryModels) {
          const rows = cancelRecords.filter(row => row.model === model); assert.equal(rows.length, 1);
          const row = rows[0]; assert.deepEqual(Object.keys(row).sort(), ["model", "headers", "firstChunk", "originalPendingRead", "callerAborted", "rejected", "releaseFulfilled", "unlocked"].sort());
          for (const field of ["headers", "firstChunk", "originalPendingRead", "callerAborted", "releaseFulfilled", "unlocked"]) assert.equal(row[field], true);
          assert.ok(row.rejected.includes("read")); assert.ok(row.rejected.every(kind => ["read", "closed", "cancel"].includes(kind)));
        }
        cancelQualified = true;
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
      async () => { await allFailures(() => {}, cancellation.map(fixture => async () => t.diagnostic(JSON.stringify({ model: fixture.model, caller: "registered SDK", ...await fixture.retire(cancelQualified) })))); },
      async () => { await allFailures(() => {}, cancellation.map(fixture => () => fixture.mf.dispose())); },
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

async function memoryCancellationFixture(temporary, index, observerCode, bundleOutcome) {
  const model = memoryModels[index], id = `qmem_${index}_cancel`, ownerId = "qianfan_memory_cancel";
  const router = `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
const incoming = createRequestBindings(), outgoing = createRequestBindings(); let sourceProof, callerQualified = false;
const life = createLifetimeObserver(undefined, { ownerId: ${JSON.stringify(ownerId)}, source: () => callerQualified ? sourceProof : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(life, incoming.bindings, outgoing.bindings, HttpOperation, "memory");
incoming.expect(${JSON.stringify(ownerId)}, "memory", "/v1/native/qianfan/embeddings", "POST", ${JSON.stringify(token(id))});
outgoing.expect(${JSON.stringify(ownerId)}, "memory", "https://qianfan.baidubce.com/v2/embeddings", "POST", ${JSON.stringify(secret(id))});
const originalFetch = globalThis.fetch;
life.patch(globalThis, "fetch", function (...args) {
 const owner = outgoing.claim(args[0], args[1], "memory"), ingress = incoming.bindings[0];
 if (!ingress.claimed) throw new Error("memory egress without ingress"); owner.ingress = ingress;
 life.signal(owner, args[1]?.signal ?? args[0]?.signal);
 return life.invoke("fetch", originalFetch, this, args, owner, response => life.response(response, owner));
});
export default { ...handler, fetch(request, env, context) {
 const url = new URL(request.url);
 if (url.pathname === "/fixture/grant") return putGrantCredentials(env, ${JSON.stringify("oauth/" + id + "/qianfan")}, { provider: "qianfan", kind: "api_key", enabled: true, credential: ${JSON.stringify(secret(id))} }).then(() => new Response(null, { status: 204 }));
 if (url.pathname === "/fixture/retirement") return (async () => {
  const receipt = await request.json(); sourceProof = receipt.sourceCancellation; callerQualified = receipt.callerQualified === true;
  let accepted = false; try { await preserveFailures(async () => { await life.join(); incoming.verify(); outgoing.verify(); }, [() => life.restore()]); accepted = true; } catch (error) { life.errors.push(error); }
  return Response.json({ ...life.summary(), accepted, join: life.joinDiagnostic() });
 })();
 if (url.pathname !== "/v1/native/qianfan/embeddings") return handler.fetch(request, env, context);
 const row = incoming.bindings[0]; if (row.url.startsWith("/")) row.url = url.origin + row.url;
 const owner = incoming.claim(request, undefined, "memory"); life.signal(owner, request.signal);
 const originalWait = context.waitUntil; life.patch(context, "waitUntil", function (...args) { life.watch("waitUntil", args[0], owner); return Reflect.apply(originalWait, this, args); });
 return life.invoke("handler", handler.fetch, handler, [request, { ...env, QIANFAN_API_KEY: "must-not-fallback" }, context], owner);
} };`;
  const upstream = `${observerCode}
const life = createLifetimeObserver(), bindings = createRequestBindings();
const owner = bindings.expect(${JSON.stringify(ownerId)}, "memory", "https://qianfan.baidubce.com/v2/embeddings", "POST", ${JSON.stringify(secret(id))});
const state = { cancelled: false, expired: false }; let requestBody;
export default { fetch(request, env, context) {
 if (request.url === "https://fixture.example/retirement") return (async () => {
  let accepted = false; try { await preserveFailures(async () => { await life.join(); bindings.verify(); }, [() => life.restore()]); accepted = true; } catch (error) { life.errors.push(error); }
  const cancel = life.operations.filter(op => op.kind === "source.cancel" && op.owner === owner);
  return Response.json({ ...life.summary(), accepted, requestBody, sourceCancellation: { ownerId: owner.id, claimed: owner.claimed === true, cancelled: state.cancelled, expired: state.expired,
   cancelCalls: cancel.length, cancelReturned: cancel.filter(op => op.state === "fulfilled").length,
   pending: life.operations.filter(op => op.state === "pending").length, failed: life.operations.filter(op => !["pending", "fulfilled"].includes(op.state)).length } });
 })();
 bindings.claim(request, undefined, "memory");
 return life.invoke("handler", async () => {
  requestBody = await life.invoke("request.json", request.json, request, [], owner);
  let complete, fail, wake, timer, first = true;
  const producer = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  life.watch("source.producer", producer, owner); context.waitUntil(producer);
  const deadline = setTimeout(() => { state.expired = true; clearTimeout(timer); wake?.(); fail(new Error("memory source expiry")); }, 10000);
  const source = { pull(controller) {
   if (state.expired) { controller.error(new Error("memory source expired")); return; }
   if (first) { first = false; controller.enqueue(new TextEncoder().encode('{"object":"list","data":[')); return; }
   return new Promise(resolve => { wake = resolve; timer = setTimeout(() => { if (!state.cancelled && !state.expired) controller.enqueue(new TextEncoder().encode(" ")); resolve(); }, 50); });
  }, cancel() { state.cancelled = true; clearTimeout(deadline); clearTimeout(timer); wake?.(); complete(); } };
  for (const kind of ["pull", "cancel"]) { const original = source[kind]; life.patch(source, kind, function (...args) { return life.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
 }, undefined, [], owner);
} };`;
  await mkdir(temporary);
  const mf = await startBundledWorkerdFixture(temporary, await bundleOutcome(router), upstream, { directRouter: true });
  try {
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["qianfan"], models: ["qianfan/" + model], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false, eligibleGrants: { qianfan: ["qianfan"] } } }));
    await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    await kv.put("connections/qianfan", JSON.stringify({ providerId: "qianfan", enabled: true }));
    const origin = String(await mf.unsafeGetDirectURL("router")).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grant")).status, 204);
    return { mf, origin, id, model, async retire(callerQualified) {
      let proof;
      await allFailures(async () => {
        proof = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retirement")).json();
        assertProof(proof); assert.deepEqual(proof.requestBody, { model, input: [id + ":0"] });
        assert.deepEqual(proof.sourceCancellation, { ownerId, claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
      }, [async () => {
        const routerProof = await (await mf.dispatchFetch("https://fixture.example/fixture/retirement", { method: "POST", body: JSON.stringify({ sourceCancellation: proof?.sourceCancellation, callerQualified }) })).json();
        assert.equal(routerProof.accepted, true, JSON.stringify(routerProof)); assert.equal(routerProof.operations, routerProof.settled); assert.equal(routerProof.readers, routerProof.unlocked);
        assert.equal(routerProof.rejected, routerProof.qualifiedReadRejections ?? 0);
      }]);
      let usage;
      for (let i = 0; i < 100; i++) { usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(id) } })).json(); if (usage.usage.events.length) break; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id); assert.equal(event.model, "qianfan/" + model); assert.equal(event.provider, "qianfan");
      assert.equal(event.status, "client_error"); assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(usage.budget.spentMicros, 7);
      assert.deepEqual([event.input_tokens, event.total_tokens], [null, null]);
      return { source: proof.sourceCancellation, status: event.status, cost: event.actual_cost_micros };
    } };
  } catch (error) { return allFailures(() => { throw error; }, [() => mf.dispose()]); }
}
