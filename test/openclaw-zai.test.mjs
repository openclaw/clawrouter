import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { types as nodeTypes } from "node:util";
import { createRequire } from "node:module";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const sdkSource = readFileSync(new URL("./fixtures/openclaw-zai-contract.test.ts", import.meta.url), "utf8");
const supportSource = sdkSource.split("// BEGIN ZAI CONTRACT SUPPORT\n")[1].split("// END ZAI CONTRACT SUPPORT")[0];
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const supportJs = esbuild.transformSync(supportSource + "\nexport { regionalCases, regionalNegativeCases, allFailures, originalLifetime, diagnosticProtocol };", { loader: "ts", format: "esm" }).code;
const { regionalCases, regionalNegativeCases, allFailures, originalLifetime, diagnosticProtocol } = await import("data:text/javascript;base64," + Buffer.from(supportJs).toString("base64"));
const regionalRows = [...regionalCases(), ...regionalNegativeCases()];
const diagnostics = diagnosticProtocol(nodeTypes.isProxy);
const emit = diagnostics.emitter(line => process.stdout.write(line));
function failureRecord(phase, error) { emit({ v: 1, layer: "outer", caseId: "control", phase, category: error === undefined ? "undefined" : error === null ? "null" : "failure" }); }
function ownChildRecords(error) {
  if (!error || typeof error !== "object" || nodeTypes.isProxy(error)) return [];
  const data = Object.getOwnPropertyDescriptors(error);
  return ["stdout", "stderr"].flatMap(key => "value" in (data[key] ?? {}) ? diagnostics.parse(data[key].value) : []);
}
const models = ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5-turbo", "glm-5v-turbo", "glm-5.1"];
const cards = Object.fromEntries(models.flatMap((model, i) => [[`m${i}_stream`, model], [`m${i}_simple`, model]]));
Object.assign(cards, { default53: "glm-5.3", default52: "glm-5.2", legacy_off: "glm-5.1", preserve: "glm-5.1", tool_off: "glm-5.3",
  no_usage: "glm-5.3", http_error: "glm-5.3", embedded_error: "glm-5.3" });
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "foreign_model", "aborted"];
test("registered Z.AI global standard streams preserve original grants, selected identities and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "zai");
  assert.deepEqual(provider.models.map(m => m.upstream), models);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-zai-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf, origin;
  const proofContext = { diagnostic(value) { for (const record of diagnostics.parse(value)) emit(record); } };
  await allFailures(async () => {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id === "foreign_model" ? "not-selected" : cards[id] ?? models[0];
      await kv.put(`policies/zai_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "zai-cn" : "zai"], models: ["zai/" + model],
        grantRouting: { eligibleGrants: { zai: ["zai"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/zai_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `zai_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/zai", JSON.stringify({ providerId: "zai", enabled: true }));
    for (const row of regionalRows) {
      const foreign = row.outcome === "foreign";
      const policy = { enabled: true, generation: "fixture", tenantId: "fixture", providers: [foreign ? "zai" : row.provider],
        models: [`${foreign ? "zai" : row.provider}/${row.model}`], monthlyBudgetMicros: 100, requestCostMicros: row.outcome === "unpriced" ? null : 7,
        grantRouting: { eligibleGrants: row.credential === "environment" ? {} : { [row.provider]: [row.provider] }, environmentFallback: false }, budgetMode: "reserve", retainRequestContent: false };
      await kv.put(`policies/zai_${row.id}`, JSON.stringify(policy));
      await kv.put(`credentials/zai_${row.id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `zai_${row.id}`, policyGeneration: "fixture" }));
      await kv.put(`connections/${row.provider}`, JSON.stringify({ providerId: row.provider, enabled: true }));
    }
    origin = (await mf.unsafeGetDirectURL("router")).origin;
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    try {
      await runOpenClawConsumer(proofContext, { source, sourceHead, fixture: new URL("./fixtures/openclaw-zai-contract.test.ts", import.meta.url), testPath: "extensions/zai/worker-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin, ZAI_API_KEY: "must-not-fallback", ZAI_CODING_GLOBAL_API_KEY: "must-not-fallback" } });
    } catch (error) {
      for (const record of ownChildRecords(error)) emit(record);
      failureRecord("helper", error); throw error;
    }
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    const expectedRegional = regionalRows.reduce((count, row) => count + (row.outcome === "rotation" ? 2 : ["success", "http401", "http403", "http429", "embedded", "no_usage", "cancel"].includes(row.outcome) ? 1 : 0), 0);
    assert.equal(calls.length, dispatched.length + expectedRegional, "denied and pre-aborted requests must have zero egress");
    for (const id of dispatched) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`zai_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching; assert.equal(call.url, "https://api.z.ai/api/paas/v4/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${id}`); assert.equal(call.body.model, cards[id]);
      assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.equal(call.body.tool_stream, id === "tool_off" ? undefined : true, id);
      if (id === "default53") { assert.equal(call.body.reasoning_effort, "max"); assert.equal(call.body.thinking, undefined); }
      else if (["default52", "legacy_off"].includes(id)) assert.deepEqual(call.body.thinking, { type: "disabled" });
      else if (id === "preserve") assert.deepEqual(call.body.thinking, { type: "enabled", clear_thinking: false });
      else if (["glm-5.3", "glm-5.3-flash", "glm-5.2"].includes(cards[id])) {
        assert.equal(call.body.reasoning_effort, "high", id); assert.equal(call.body.thinking, undefined, id);
      }
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"), id);
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"), id);
      assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"), id);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-zai_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, "zai"); assert.equal(event.model, `zai/${cards[id]}`); assert.equal(event.credential_id, `zai_${id}`);
      const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(event.status_code, id === "http_error" ? 401 : 200, id);
      assert.equal(event.status, id === "http_error" ? "client_error" : id === "embedded_error" ? "provider_error" : "success", id);
      assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed"); assert.equal(event.actual_cost_micros, rejected ? 0 : 7);
      assert.equal(usage.budget.spentMicros, rejected ? 0 : 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens],
        rejected || id === "no_usage" ? [null, null, null, null] : [300, 20, 320, 256]);
      assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-prior-thinking|synthetic-tool-result|synthetic-answer/);
    }
    const reservationCounts = await (await fetch(origin + "/fixture/reservations")).json();
    for (const row of regionalRows) {
      await verifyRegional(origin, row, calls);
      const denied = ["foreign", "missing", "disabled", "unpriced", "closed", "revoked", "preabort"].includes(row.outcome);
      assert.equal(reservationCounts[row.id] ?? 0, denied ? 0 : row.outcome === "rotation" ? 2 : 1);
    }
  }, [async () => {
    if (!mf || !origin) return;
    await allFailures(async () => {
      const response = await fetch(origin + "/fixture/retire", { signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      assert.equal(response.status, 200); assert.equal(value.pending, 0); assert.equal(value.rejected, 0);
    }, [async () => {
      const upstream = await mf.getWorker("upstream");
      const response = await upstream.fetch("https://fixture.example/retire", { signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      assert.equal(response.status, 200); assert.equal(value.pending, 0); assert.equal(value.rejected, 0);
    }]);
  }, async () => { try { await mf?.dispose(); } catch (error) { failureRecord("dispose", error); throw error; } },
    async () => { try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failureRecord("remove", error); throw error; } }]);
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const regional = ${JSON.stringify(regionalRows)};
${originalLifetime.toString()}
${reservationObserver.toString()}
const reservations = {};
const ownership = (${workerOwnership.toString()})();
const originalFetch = globalThis.fetch;
globalThis.fetch = function(...args) {
  const original = Reflect.apply(originalFetch, this, args);
  const input = args[0], init = args[1];
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["api.z.ai", "open.bigmodel.cn"].includes(url.hostname)) return original;
  const owner = { input, init, original };
  ownership.track("fetch", original);
  original.then(response => ownership.response(response, owner), error => ownership.failure(error));
  return original;
};
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/reservations") return Response.json(reservations);
  if (new URL(request.url).pathname === "/fixture/retire") {
    try { return Response.json(await ownership.retire()); }
    catch { return Response.json(ownership.summary(), { status: 503 }); }
  }
  if (new URL(request.url).pathname === "/fixture/rotate") {
    const id = await request.text();
    const row = regional.find(row => row.id === id && row.outcome === "rotation");
    if (!row) return new Response(null, { status: 400 });
    await putGrantCredentials(env, "oauth/zai_" + row.id + "/" + row.provider, { provider: row.provider, enabled: true, kind: "api_key", credential: "fixture-upstream-" + row.id + "-rotated" });
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) {
      for (const foreign of ["zai-cn", "zai-coding-global", "zai-coding-cn"]) await putGrantCredentials(env, "oauth/zai_" + id + "/" + foreign, { provider: foreign, enabled: true, kind: "api_key", credential: "fixture-foreign-product" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/zai_" + id + "/zai", { provider: "zai", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    for (const row of regional) {
      for (const foreign of ["zai", "zai-cn", "zai-coding-global", "zai-coding-cn"].filter(id => id !== row.provider))
        await putGrantCredentials(env, "oauth/zai_" + row.id + "/" + foreign, { provider: foreign, enabled: true, kind: "api_key", credential: "fixture-foreign-product" });
      if (row.credential !== "environment" && row.outcome !== "missing") {
        const key = "oauth/zai_" + row.id + "/" + row.provider;
        await putGrantCredentials(env, key, { provider: row.provider, enabled: row.outcome !== "disabled", kind: "api_key", credential: "fixture-upstream-" + row.id });
        if (row.outcome === "revoked") await revokeGrantCredentials(env, key);
      }
    }
    return new Response(null, { status: 204 });
  }
  const row = regional.find(row => request.headers.get("authorization") === "Bearer clawrouter-live-zai_" + row.id + "-fixture-secret");
  const selected = { ...env, ZAI_API_KEY: "must-not-fallback", ZAI_CODING_GLOBAL_API_KEY: "must-not-fallback", ZAI_CN_API_KEY: "must-not-fallback", ZAI_CODING_CN_API_KEY: "must-not-fallback", Z_AI_API_KEY: "must-not-fallback" };
  if (row) selected.BUDGET_LEDGER = reservationObserver(env.BUDGET_LEDGER, () => { reservations[row.id] = (reservations[row.id] ?? 0) + 1; });
  if (row?.credential === "environment") selected[row.binding] = "fixture-upstream-" + row.id;
  return ownership.track("handler", handler.fetch(request, selected, { ...context, waitUntil(original) { ownership.track("waitUntil", original); context.waitUntil(original); } }));
} };`;
}
function upstreamFixture() {
  return `const calls = []; const regional = ${JSON.stringify(regionalRows)}; const ownership = (${workerOwnership.toString()})();
  export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    if (request.url === "https://fixture.example/retire") { try { return Response.json(await ownership.retire()); } catch { return Response.json(ownership.summary(), { status: 503 }); } }
    const body = await request.json(); const call = { url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body }; calls.push(call);
    const id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    const row = regional.find(row => id === row.id || id === row.id + "-rotated"), outcome = row?.outcome;
    if (id === "http_error" || outcome?.startsWith("http")) return Response.json({ error: { message: "synthetic provider rejection" } }, { status: id === "http_error" ? 401 : Number(outcome.slice(4)) });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const usage = id === "no_usage" || outcome === "no_usage" ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } };
    const wire = id === "embedded_error" || outcome === "embedded" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } })
      : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] })
        + (outcome === "cancel" ? "" : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...usage }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, finish, fail, timer, wake, beats = 0;
    const originalCompletion = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); ownership.track("source", originalCompletion);
    const stop = () => { clearTimeout(timer); wake?.(); };
    const abort = () => { call.aborted = true; stop(); };
    request.signal.addEventListener("abort", abort, { once: true });
    const retired = () => { stop(); request.signal.removeEventListener("abort", abort); };
    return new Response(new ReadableStream({ pull(c) {
      if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; return; }
      if (outcome !== "cancel") { c.close(); retired(); finish(); return; }
      const original = new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
        wake = undefined;
        if (++beats > 200) { call.fixtureExpired = true; retired(); const error = new Error("Fixture lifetime expired"); c.error(error); fail(error); }
        else c.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
        resolve();
      }, 50); });
      ownership.track("pull", original); return original;
    }, cancel() { call.cancelled = true; retired(); finish(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}

function workerOwnership() {
  const operations = [], failures = []; let completion;
  const lifetime = typeof originalLifetime === "function" ? originalLifetime() : null;
  function track(kind, original) {
    const record = { kind, original, state: "pending" }; operations.push(record);
    Promise.resolve(original).then(() => { record.state = "fulfilled"; }, error => { record.state = "rejected"; record.error = error; });
    return original;
  }
  function summary() { const body = lifetime?.summary(); return { operations: operations.length + (body?.operations ?? 0), pending: operations.filter(op => op.state === "pending").length + (body?.pending ?? 0), rejected: operations.filter(op => op.state === "rejected").length + failures.length + (body?.rejected ?? 0) }; }
  function retire() {
    return completion ??= (async () => {
      let count = -1;
      while (count !== operations.length) { count = operations.length; await Promise.allSettled(operations.map(op => op.original)); }
      const errors = [...failures, ...operations.filter(op => op.state !== "fulfilled").map(op => op.error)];
      try { await lifetime?.join(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Original Worker work failed");
      return summary();
    })();
  }
  return { track, retire, summary, failure: error => failures.push(error), response(response, owner) { try { lifetime.observeResponse(response, owner); } catch (error) { failures.push(error); } } };
}

function reservationObserver(namespace, onReserve) {
  return new Proxy(namespace, { get(target, key) {
    if (key === "get") return function (...args) {
      const original = Reflect.apply(target.get, target, args);
      return new Proxy(original, { get(stub, method) {
        if (method === "fetch") return function (...operands) {
          const input = operands[0], url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/reserve") onReserve();
          return Reflect.apply(stub.fetch, stub, operands);
        };
        const value = Reflect.get(stub, method, stub); return typeof value === "function" ? value.bind(stub) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function verifyRegional(origin, row, calls) {
  const matching = calls.filter(call => JSON.stringify(call.body.messages).includes(`zai_${row.id}`));
  const denied = ["foreign", "missing", "disabled", "unpriced", "closed", "revoked", "preabort"].includes(row.outcome);
  assert.equal(matching.length, denied ? 0 : row.outcome === "rotation" ? 2 : 1, row.id);
  for (const [index, call] of matching.entries()) {
    assert.equal(call.url, row.base + "/chat/completions"); assert.equal(call.body.model, row.model);
    assert.equal(call.authorization, `Bearer fixture-upstream-${row.id}${index === 1 ? "-rotated" : ""}`);
    assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.stream, true);
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|fixture-foreign/);
    if (row.outcome === "cancel") { assert.equal(call.cancelled, true); assert.notEqual(call.fixtureExpired, true); }
  }
  let usage;
  for (let n = 0; n < 150; n++) {
    usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-zai_${row.id}-fixture-secret` } })).json();
    if (denied || usage.usage.events.length === matching.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (denied) { assert.equal(usage.budget.spentMicros, 0); return; }
  assert.equal(usage.usage.events.length, matching.length);
  const error = row.outcome.startsWith("http") || row.outcome === "embedded", canceled = row.outcome === "cancel";
  for (const event of usage.usage.events) {
    assert.equal(event.provider, row.provider); assert.equal(event.model, `${row.provider}/${row.model}`); assert.equal(event.credential_id, `zai_${row.id}`);
    assert.equal(event.cost_basis, error ? "none" : "policy_fixed"); assert.equal(event.actual_cost_micros, error ? 0 : 7);
    assert.equal(event.status, row.outcome === "embedded" ? "provider_error" : error || canceled ? "client_error" : "success");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], error || canceled || row.outcome === "no_usage" ? [null, null, null, null] : [300, 20, 320, 256]);
  }
  assert.equal(usage.budget.spentMicros, error ? 0 : 7 * matching.length);
  assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|fixture-secret|must-not-fallback|synthetic-answer/);
}

test("regional scenarios keep nine identities, independent policies and 36 native plus nine discovered positives", () => {
  const positives = regionalCases();
  assert.equal(positives.length, 45);
  assert.equal(positives.filter(row => row.route === "native").length, 36);
  assert.equal(positives.filter(row => row.route === "catalog").length, 9);
  assert.equal(new Set(positives.map(row => `${row.provider}/${row.model}`)).size, 9);
  assert.equal(new Set(regionalRows.map(row => row.id)).size, regionalRows.length);
  for (const row of positives) {
    const provider = snapshot.providers.find(provider => provider.id === row.provider);
    assert.ok(provider.models.some(model => model.upstream === row.model));
    assert.equal(provider.models.find(model => model.upstream === row.model).pricing, null);
  }
});

test("original lifetime preserves acquisition, receiver, response, read and release products through EOF", async () => {
  const observer = originalLifetime(), owner = {}, receiver = {};
  const response = new Response("original bytes");
  let releaseReceiver; const released = Promise.resolve();
  const result = { response, release() { releaseReceiver = this; return released; } }, acquired = Promise.resolve(result);
  const actual = observer.acquire(function (operand) { assert.equal(this, receiver); assert.equal(operand, owner); return acquired; }, receiver, [owner], owner);
  assert.equal(actual, acquired); assert.equal(await actual, result); assert.equal(result.response, response);
  const reader = response.body.getReader(), pending = reader.read();
  assert.equal(observer.operations.find(row => row.kind === "read").original, pending);
  assert.equal((await pending).done, false); assert.equal((await reader.read()).done, true);
  reader.releaseLock(); assert.equal(result.release(), released); assert.equal(releaseReceiver, result);
  await observer.join(); assert.equal(response.body.locked, false); observer.restore();
  assert.equal(Object.hasOwn(response.body, "getReader"), false);
});

test("original lifetime waits for actual pending cancellation and release before qualifying", async () => {
  let finishCancel, finishRelease;
  const cancellation = new Promise(resolve => { finishCancel = resolve; }), release = new Promise(resolve => { finishRelease = resolve; });
  const observer = originalLifetime(), response = new Response(new ReadableStream({ cancel() { return cancellation; } }));
  const result = await observer.acquire(() => Promise.resolve({ response, release: () => release }), undefined, [], {});
  const reader = response.body.getReader(), cancel = reader.cancel(); reader.releaseLock();
  assert.equal(result.release(), release); let joined = false;
  const joining = observer.join().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false); finishCancel(); await cancel;
  await Promise.resolve(); assert.equal(joined, false); finishRelease(); await joining; observer.restore();
});

for (const reason of [undefined, null, new Error("synthetic source")]) test(`strict original lifetime retains ${reason === undefined ? "undefined" : reason === null ? "null" : "defined"} source rejection`, async () => {
  const observer = originalLifetime(), response = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
  const result = await observer.acquire(() => Promise.resolve({ response, release: () => Promise.resolve() }), undefined, [], {});
  const reader = response.body.getReader(); await reader.read().catch(error => { assert.equal(error, reason); });
  reader.releaseLock(); await result.release();
  await assert.rejects(observer.join(), error => error instanceof AggregateError && error.errors.includes(reason)); observer.restore();
});

for (const synchronous of [false, true]) test(`original failed release remains failure with synchronous=${synchronous}`, async () => {
  const observer = originalLifetime(), response = new Response(null);
  const result = await observer.acquire(() => Promise.resolve({ response, release() { if (synchronous) throw undefined; return Promise.reject(undefined); } }), undefined, [], {});
  let threw = false; try { await result.release(); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true);
  await assert.rejects(observer.join(), error => error instanceof AggregateError && error.errors.includes(undefined)); observer.restore();
});

test("independent cleanup attempts preserve primary undefined and every cleanup failure", async () => {
  const attempted = [], failure = new Error("synthetic cleanup");
  await assert.rejects(allFailures(() => { throw undefined; }, [() => { attempted.push("dispose"); throw failure; }, () => { attempted.push("remove"); throw undefined; }]),
    error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === undefined && error.errors[1] === failure && error.errors[2] === undefined);
  assert.deepEqual(attempted, ["dispose", "remove"]);
});

test("reservation observation calls the same stub and preserves its original request and promise", async () => {
  let count = 0; const original = Promise.resolve(new Response("{}")), init = { method: "POST", body: "{}" };
  const stub = { fetch(input, options) { assert.equal(this, stub); assert.equal(input, "https://fixture.example/reserve"); assert.equal(options, init); return original; } };
  const namespace = { get(id) { assert.equal(this, namespace); assert.equal(id, "owned"); return stub; } };
  const observed = reservationObserver(namespace, () => count++);
  assert.equal(observed.get("owned").fetch("https://fixture.example/reserve", init), original);
  assert.equal(count, 1); await (await original).arrayBuffer();
});

test("diagnostics reject hostile fields without invoking getters and retain essential owner slots", () => {
  const record = { v: 1, layer: "sdk", caseId: "original", phase: "body", category: "undefined" };
  let touched = 0;
  assert.equal(diagnostics.validate({ ...record, get payload() { touched++; throw undefined; } }), null);
  assert.equal(diagnostics.validate(new Proxy(record, { ownKeys() { touched++; throw undefined; } })), null);
  assert.equal(touched, 0);
  assert.equal(diagnostics.validate({ ...record, caseId: "bad\n::error" }), null);
  assert.equal(diagnostics.validate({ ...record, operations: 4097 }), null);
  assert.equal(diagnostics.validate({ ...record, operations: undefined }), null);
  assert.deepEqual(diagnostics.parse("not a diagnostic\n" + diagnostics.prefix + JSON.stringify(record)), [record]);
  assert.deepEqual(diagnostics.parse(diagnostics.prefix + "x".repeat(769)), []);
  const lines = [], output = diagnostics.emitter(line => lines.push(line));
  for (let i = 0; i < 50; i++) output({ ...record, caseId: regionalRows[i].id });
  output({ ...record, phase: "join" }); output({ ...record, phase: "restore" });
  for (const phase of ["worker", "helper", "receipt", "upstream", "sqlite", "dispose", "remove"]) output({ ...record, layer: "outer", phase });
  assert.equal(lines.length, 10); assert.ok(lines.every(line => line.startsWith("::error ") && Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  assert.ok(lines.some(line => line.includes('"phase":"upstream"'))); assert.ok(lines.some(line => line.includes('"phase":"worker"')));
  assert.equal(diagnostics.emitter(() => { throw undefined; })(record), false);
  assert.deepEqual(ownChildRecords(Object.defineProperty({}, "stdout", { get() { throw undefined; } })), []);
  assert.deepEqual(ownChildRecords({ stdout: diagnostics.prefix + JSON.stringify(record), stderr: "untrusted child text" }), [record]);
});

test("both generated Worker fixtures and the authored SDK file transform under owned frozen tools", async () => {
  esbuild.transformSync(sdkSource, { loader: "ts", format: "esm" });
  for (const [name, contents] of [["router", routerFixture()], ["upstream", upstreamFixture()]]) {
    const result = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}-zai-fixture.ts`, loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
    assert.equal(result.errors.length, 0); assert.ok(result.outputFiles[0].text.length > 0);
  }
});
