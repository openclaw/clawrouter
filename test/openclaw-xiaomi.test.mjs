import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { types as nodeTypes } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const sdkSource = readFileSync(new URL("./fixtures/openclaw-xiaomi-contract.test.ts", import.meta.url), "utf8");
const proofCode = stripTypeScriptTypes(sdkSource.slice(sdkSource.indexOf("// BEGIN Xiaomi proof functions."), sdkSource.indexOf("// END Xiaomi proof functions.")));
const { xiaomiPlanCases, xiaomiDiagnostic, xiaomiObserveBody, xiaomiRethrow } = new Function(proofCode + ";return { xiaomiPlanCases, xiaomiDiagnostic, xiaomiObserveBody, xiaomiRethrow };")();
const planRows = xiaomiPlanCases(), diagnostic = xiaomiDiagnostic(nodeTypes.isProxy);
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const cards = { pro_stream: "mimo-v2.6-pro", pro_simple: "mimo-v2.6-pro", flash_stream: "mimo-v2.6-flash", flash_simple: "mimo-v2.6-flash",
  off: "mimo-v2.6-pro", max: "mimo-v2.6-pro", no_usage: "mimo-v2.6-pro", http_error: "mimo-v2.6-pro", embedded_error: "mimo-v2.6-pro" };
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "retired_pro", "retired", "aborted"];
test("registered Xiaomi PAYG streams preserve original grants, retired identities and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "xiaomi");
  assert.deepEqual(provider.models.map(m => m.upstream), ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xiaomi-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf, origin;
  const failures = [], evidence = diagnostic.store(); let helperFulfilled = false, phase = "setup", sdkCount = null;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id === "retired_pro" ? "mimo-v2.5-pro" : id === "retired" ? "mimo-v2.5" : cards[id] ?? "mimo-v2.6-pro";
      await kv.put(`policies/xiaomi_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "xiaomi-token-plan" : "xiaomi"], models: ["xiaomi/" + model],
        grantRouting: { eligibleGrants: { xiaomi: ["xiaomi"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/xiaomi_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `xiaomi_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/xiaomi", JSON.stringify({ providerId: "xiaomi", enabled: true }));
    await provisionPlans(kv);
    origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    phase = "helper";
    await runOpenClawConsumer({ diagnostic() {} }, { source, sourceHead, fixture: new URL("./fixtures/openclaw-xiaomi-contract.test.ts", import.meta.url), testPath: "extensions/xiaomi/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, XIAOMI_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_CN_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_AMS_API_KEY: "must-not-fallback" } });
    helperFulfilled = true;
    phase = "retire"; const retirement = await fetch(origin + "/fixture/retire", { method: "POST" });
    const physical = await retirement.json(); assert.equal(retirement.status, 200); assert.equal(physical.joined, true);
    phase = "wire";
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.filter(call => call.authorization?.startsWith("Bearer fixture-upstream-")).length, dispatched.length, "denied and pre-aborted requests must have zero egress");
    for (const id of dispatched) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`xiaomi_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching; assert.equal(call.url, "https://api.xiaomimimo.com/v1/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${id}`); assert.equal(call.body.model, cards[id]);
      assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.deepEqual(call.body.thinking, { type: id === "off" ? "disabled" : "enabled" });
      assert.equal(call.body.reasoning_effort, id === "off" ? undefined : id === "max" ? "max" : "high");
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
      if (id === "off") assert.ok(call.body.messages.every(m => m.reasoning_content === undefined));
      else assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-xiaomi_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, "xiaomi"); assert.equal(event.model, `xiaomi/${cards[id]}`); assert.equal(event.credential_id, `xiaomi_${id}`);
      const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(event.status_code, id === "http_error" ? 401 : 200, id);
      assert.equal(event.status, id === "http_error" ? "client_error" : id === "embedded_error" ? "provider_error" : "success", id);
      assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed"); assert.equal(event.actual_cost_micros, rejected ? 0 : 7);
      assert.equal(usage.budget.spentMicros, rejected ? 0 : 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens],
        rejected || id === "no_usage" ? [null, null, null, null] : [300, 20, 320, 256]);
      assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-prior-thinking|synthetic-tool-result|synthetic-answer/);
    }
    const arrived = await readDiagnostics(origin);
    assert.equal(arrived.filter(row => row.source === "sdk" && row.caseId === "n_cancel" && row.phase === "sdk_cancel_receipt" && !row.failed && row.checkpoint === 1 && row.count === 1).length, 1);
    phase = "usage"; await assertPlanOracles(origin, calls, physical, (row, checkpoint, error) => evidence.add(diagnostic.record("outer", row.id, "assert", checkpoint, true, error)));
  } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", phase, 0, true, error)); }
  finally {
    if (origin) {
      try { const r = await fetch(origin + "/fixture/retire", { method: "POST" }); await r.arrayBuffer(); if (r.status !== 200) throw new Error("original Worker joins failed"); }
      catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "retire", 0, true, error)); }
      try { const records = await readDiagnostics(origin); sdkCount = records.filter(r => r.source === "sdk").length; for (const row of records) evidence.add(row); }
      catch (error) { failures.push(error); }
    }
    try { await mf?.dispose(); } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "dispose", 0, true, error)); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "remove", 0, true, error)); }
    const helper = diagnostic.record("outer", "none", "helper", helperFulfilled ? 1 : phase === "helper" ? 2 : 0, phase === "helper" && !helperFulfilled, undefined, sdkCount);
    try { diagnostic.emit([helper, ...evidence.values()], failures.length > 0, line => process.stdout.write(line)); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Xiaomi original contract and cleanup failures");
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
${proofCode}
${planRouter.toString()}
const plan = planRouter(handler, putGrantCredentials, revokeGrantCredentials);
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) {
      await putGrantCredentials(env, "oauth/xiaomi_" + id + "/xiaomi-token-plan", { provider: "xiaomi-token-plan", enabled: true, kind: "api_key", credential: "tp-fixture-foreign-plan" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/xiaomi_" + id + "/xiaomi", { provider: "xiaomi", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    await plan.grants(env);
    return new Response(null, { status: 204 });
  }
  const controlled = await plan.control(request, env); if (controlled) return controlled;
  return plan.fetch(request, { ...env, XIAOMI_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_CN_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_AMS_API_KEY: "must-not-fallback" }, context);
} };`;
}
function upstreamFixture() {
  return `${planUpstream.toString()}
const plan = planUpstream((delay, options) => scheduler.wait(delay, options));
const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json([...calls, ...plan.calls]);
    if (request.headers.has("api-key")) return plan.fetch(request);
    const body = await request.json(); calls.push({ url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body });
    const id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    if (id === "http_error") return Response.json({ error: { message: "synthetic provider rejection" } }, { status: 401 });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const usage = id === "no_usage" ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } };
    const wire = id === "embedded_error" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } })
      : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] })
        + frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...usage }) + "data: [DONE]\\n\\n";
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}

async function provisionPlans(kv) {
  for (const row of planRows) {
    const id = `xiaomi_plan_${row.id}`;
    await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: [row.kind === "foreign_policy" ? "xiaomi" : row.provider],
      models: [`${row.provider}/${row.kind === "foreign_model" ? "mimo-v2.6-flash" : row.model}`],
      ...(row.source === "grant" ? { grantRouting: { strategy: "round_robin", eligibleGrants: { [row.provider]: row.kind === "failover" ? [row.provider, "zz-alternate"] : [row.provider] }, environmentFallback: false } } : {}),
      monthlyBudgetMicros: row.kind === "capacity" ? 0 : 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
    await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    await kv.put(`connections/${row.provider}`, JSON.stringify({ providerId: row.provider, enabled: true }));
  }
}
async function readDiagnostics(origin) {
  const response = await fetch(origin + "/fixture/diagnostics"), reader = response.body.getReader(); const chunks = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 64 * 768 + 128) { await reader.cancel(); throw new Error("diagnostic capacity"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const rows = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(Array.isArray(rows) && rows.length <= 64);
  return rows.map(value => { const row = diagnostic.validate(value); assert.ok(row); return row; });
}
async function assertPlanOracles(origin, calls, physical, report) {
  for (const row of planRows) {
    const selected = calls.filter(call => call.planId === row.id), count = row.kind === "rotation" ? 2 : ["success", "http", "embedded", "no_usage", "cancel", "failover"].includes(row.kind) ? 1 : 0;
    let checkpoint = 1; const check = (id, run) => { checkpoint = id; return run(); };
    try {
      check(1, () => assert.equal(selected.length, count));
      for (const call of selected) {
        checkpoint = 2;
        check(2, () => assert.equal(call.url, row.base + "/chat/completions")); check(3, () => assert.equal(call.method, "POST")); check(4, () => assert.equal(call.authorization, null)); check(5, () => assert.equal(call.xApiKey, null));
        check(6, () => assert.equal(call.apiKey, `${row.kind === "rotation" && call.turn === 2 ? "ttp" : row.prefix}-fixture-upstream-${row.id}`));
        checkpoint = 3;
        check(7, () => assert.equal(call.body.model, row.model)); check(8, () => assert.equal(call.body.stream, true)); check(9, () => assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128));
        check(10, () => assert.deepEqual(call.body.thinking, { type: "enabled" })); check(11, () => assert.equal(call.body.reasoning_effort, "high"));
        checkpoint = 4;
        check(12, () => assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-plan-thinking")));
        check(13, () => assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup")));
        check(14, () => assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "planlookup" && m.content === "synthetic-plan-result")));
        check(15, () => assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/));
        checkpoint = 5;
        check(16, () => assert.equal(call.expired, false)); check(17, () => assert.equal(call.sourceJoined, true));
        if (row.kind === "cancel") check(18, () => assert.equal(call.canceled, true));
      }
      checkpoint = 6;
      if (row.kind === "failover") check(32, () => assert.equal(physical.materializations.filter(value => value.id === row.id && value.alternate).length, 1));
      const ledger = physical.budgets.filter(value => value.id === row.id);
      check(19, () => assert.equal(ledger.filter(value => value.path === "/reserve" && value.allowed).length, count));
      check(20, () => assert.equal(ledger.filter(value => value.path === "/reserve" && value.dispatched && value.charged === 7).length, count));
      check(21, () => assert.equal(ledger.filter(value => value.path === "/settle" && value.settled).length, count));
      checkpoint = 7;
      let usage;
      for (let n = 0; n < 150; n++) {
        const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${row.id}-fixture-secret` } });
        usage = await response.json(); if (usage.usage.events.length === count) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      check(22, () => assert.equal(usage.usage.events.length, count));
      for (const event of usage.usage.events) {
        const rejected = ["http", "embedded", "failover"].includes(row.kind), unknown = rejected || ["no_usage", "cancel"].includes(row.kind);
        check(23, () => assert.equal(event.provider, row.provider)); check(24, () => assert.equal(event.model, `${row.provider}/${row.model}`)); check(25, () => assert.equal(event.credential_id, `xiaomi_plan_${row.id}`));
        check(26, () => assert.equal(event.status, row.kind === "http" || row.kind === "cancel" || row.kind === "failover" ? "client_error" : row.kind === "embedded" ? "provider_error" : "success"));
        check(27, () => assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed")); check(28, () => assert.equal(event.actual_cost_micros, rejected ? 0 : 7));
        check(29, () => assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], unknown ? [null, null, null, null] : [300, 20, 320, 256]));
      }
      check(30, () => assert.equal(usage.budget.spentMicros, ["http", "embedded", "failover"].includes(row.kind) ? 0 : count * 7));
      check(31, () => assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-plan-thinking|synthetic-plan-result|synthetic-plan-answer/));
    } catch (error) { try { report(row, checkpoint, error); } catch (reportError) { throw new AggregateError([error, reportError], "oracle and diagnostic failed"); } throw error; }
  }
}

// Embedded only in the fixture Worker. Each record owns its original operations.
function planRouter(handler, putGrantCredentials, revokeGrantCredentials) {
  const rows = xiaomiPlanCases(), diagnostic = xiaomiDiagnostic(), records = diagnostic.store(), inputs = [], requests = [], budgets = [], materializations = [];
  const originalFetch = globalThis.fetch; let retirement;
  const identify = value => rows.find(row => value === `${row.prefix}-fixture-upstream-${row.id}` || row.kind === "rotation" && value === `ttp-fixture-upstream-${row.id}`);
  globalThis.fetch = function(input, init) {
    const headers = new Headers(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
    const row = identify(headers.get("api-key"));
    const returned = Reflect.apply(originalFetch, this, arguments);
    const item = { returned, observations: [], row, errors: [] }; inputs.push(item);
    void returned.then(response => {
      try { if (response.body) item.observations.push(xiaomiObserveBody(response.body, init?.signal ?? (input instanceof Request ? input.signal : undefined),
        (object, name, replacement) => { object[name] = replacement; },
        (phase, checkpoint, failed) => records.add(diagnostic.record("worker", row?.id ?? "payg", phase, checkpoint, failed)))); }
      catch (error) { item.errors.push(error); }
    }, () => {});
    return returned;
  };
  async function retire() {
    const failures = [];
    for (const request of requests) {
      const result = await Promise.allSettled([request.returned]); failures.push(...result.flatMap(v => v.status === "rejected" ? [v.reason] : []));
      let done = 0; while (done < request.pending.length) { const batch = request.pending.slice(done); done += batch.length; failures.push(...(await Promise.allSettled(batch)).flatMap(v => v.status === "rejected" ? [v.reason] : [])); }
    }
    for (const input of inputs) {
      failures.push(...(await Promise.allSettled([input.returned, ...input.observations.map(value => value.join())])).flatMap(v => v.status === "rejected" ? [v.reason] : []), ...input.errors);
    }
    failures.push(...(await Promise.allSettled(budgets.map(row => row.joined))).flatMap(v => v.status === "rejected" ? [v.reason] : []));
    if (failures.length) { records.add(diagnostic.record("worker", "none", "retire", 0, true, undefined, failures.length)); throw new AggregateError(failures, "original Worker retirement failed"); }
    return { joined: true, requests: requests.length, inputs: inputs.length, materializations, budgets: budgets.map(({ id, path, allowed, dispatched, settled, charged }) => ({ id, path, allowed, dispatched, settled, charged })) };
  }
  return {
    async grants(env) {
      for (const row of rows) if (row.source === "grant" && row.kind !== "missing") {
        await putGrantCredentials(env, `oauth/xiaomi_plan_${row.id}/${row.provider}`,
          { provider: row.provider, kind: "api_key", enabled: true, credential: row.kind === "invalid_grant" ? "sk-fixture-wrong-product" : `${row.prefix}-fixture-upstream-${row.id}` });
        if (row.kind === "failover") await putGrantCredentials(env, `oauth/xiaomi_plan_${row.id}/zz-alternate`, { provider: row.provider, kind: "api_key", enabled: true, credential: "sk-fixture-invalid-alternate" });
      }
    },
    async control(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture/diagnostic" && request.method === "POST") {
        const reader = request.body.getReader(); const parts = []; let size = 0;
        try { while (true) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > 768) { await reader.cancel(); return new Response(null, { status: 413 }); } parts.push(value.value); } }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const value of parts) { bytes.set(value, offset); offset += value.length; }
        try { records.add(JSON.parse(new TextDecoder().decode(bytes))); } catch { return new Response(null, { status: 400 }); }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/fixture/diagnostics") return Response.json(records.values());
      if (url.pathname === "/fixture/retire") {
        retirement ??= retire();
        try { return Response.json(await retirement); } catch { return Response.json({ joined: false }, { status: 500 }); }
      }
      if (url.pathname.startsWith("/fixture/plan/")) {
        const [, , , id, action] = url.pathname.split("/"), row = rows.find(value => value.id === id);
        if (!row || row.kind !== "rotation" || !["valid", "invalid", "rotated", "revoked"].includes(action)) return new Response(null, { status: 400 });
        const key = `oauth/xiaomi_plan_${row.id}/${row.provider}`;
        if (action === "revoked") await revokeGrantCredentials(env, key);
        else await putGrantCredentials(env, key, { provider: row.provider, kind: "api_key", enabled: true, credential: action === "invalid" ? "sk-fixture-invalid" : `${action === "rotated" ? "ttp" : "tp"}-fixture-upstream-${row.id}` });
        return new Response(null, { status: 204 });
      }
    },
    fetch(request, env, context) {
      const row = rows.find(value => request.headers.get("authorization") === `Bearer clawrouter-live-xiaomi_plan_${value.id}-fixture-secret`);
      if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/v1/native/")) return handler.fetch(request, env, context);
      const record = { pending: [], row, signal: request.signal }; requests.push(record);
      const bound = row ? { ...env, [row.binding]: row.source === "env" ? `${row.prefix}-fixture-upstream-${row.id}` : "tp-fixture-poison-environment" } : env;
      if (row) {
        const credentials = env.GRANT_CREDENTIALS;
        bound.GRANT_CREDENTIALS = { idFromName: name => credentials.idFromName(name), get(id) {
          const stub = credentials.get(id);
          return { fetch(input, init) {
            if (new URL(input instanceof Request ? input.url : input).pathname === "/materialize" && typeof init?.body === "string") {
              const value = JSON.parse(init.body);
              materializations.push({ id: row.id, selected: value.key === `oauth/xiaomi_plan_${row.id}/${row.provider}`, alternate: value.key === `oauth/xiaomi_plan_${row.id}/zz-alternate` });
            }
            return Reflect.apply(stub.fetch, stub, arguments);
          } };
        } };
        const namespace = env.BUDGET_LEDGER;
        bound.BUDGET_LEDGER = { idFromName: name => namespace.idFromName(name), get(id) {
          const stub = namespace.get(id);
          return { fetch(input, init) {
            const path = new URL(input instanceof Request ? input.url : input).pathname;
            const returned = Reflect.apply(stub.fetch, stub, arguments), observation = { id: row.id, path, allowed: false };
            if (["/reserve", "/dispatch", "/settle"].includes(path)) {
              observation.joined = returned.then(async response => {
                const copy = response.clone(); const value = await copy.json(); observation.allowed = response.ok && value.allowed === true;
                observation.dispatched = value.dispatched === true; observation.settled = value.settled === true;
                observation.charged = Number.isSafeInteger(value.chargedMicros) ? value.chargedMicros : null;
              });
              // This additional fixture response read belongs to the original request,
              // not to a later control request after its I/O context has ended.
              record.pending.push(observation.joined); context.waitUntil(observation.joined); budgets.push(observation);
            }
            return returned;
          } };
        } };
      }
      try { record.returned = handler.fetch(request, bound, { ...context, waitUntil(pending) { record.pending.push(pending); return context.waitUntil(pending); } }); }
      catch (error) { record.returned = Promise.reject(error); void record.returned.catch(() => {}); throw error; }
      return record.returned;
    },
  };
}
function planUpstream(wait) {
  const calls = [];
  return { calls, async fetch(request) {
    const apiKey = request.headers.get("api-key"), planId = apiKey?.replace(/^(?:tp|ttp)-fixture-upstream-/, "");
    const body = await request.json(), turn = calls.filter(call => call.planId === planId).length + 1;
    const call = { planId, turn, url: request.url, method: request.method, authorization: request.headers.get("authorization"), apiKey, xApiKey: request.headers.get("x-api-key"), body, canceled: false, expired: false, sourceJoined: true }; calls.push(call);
    if (planId === "n_http" || planId === "n_failover") return Response.json({ error: { message: "Synthetic rejection" } }, { status: planId === "n_http" ? 401 : 429 });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const first = frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-plan-answer" }, finish_reason: null }] });
    const wire = planId === "n_embedded" ? frame({ error: { code: "synthetic", message: "Synthetic rejection" } }) : first + frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(planId === "n_no_usage" || planId === "n_cancel" ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } }) }) + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(planId === "n_cancel" ? first : wire); let offset = 0;
    let timer, timerObserved, timerController, timerState = "absent", timerReason;
    const joinTimer = async () => {
      if (!timer) return;
      await timerObserved;
      if (!(call.canceled && timerController.signal.aborted && timerState === "rejected" && timerReason !== null && typeof timerReason === "object")) {
        call.expired = timerState === "fulfilled";
        throw timerState === "rejected" ? timerReason : new Error("owned upstream timer expired");
      }
    };
    return new Response(new ReadableStream({
      async pull(c) {
        if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; return; }
        if (planId !== "n_cancel") { c.close(); return; }
        call.sourceJoined = false;
        if (!timer) {
          timerController = new AbortController(); timerState = "pending";
          timer = wait(10000, { signal: timerController.signal });
          timerObserved = timer.then(() => { timerState = "fulfilled"; }, reason => { timerState = "rejected"; timerReason = reason; });
        }
        await joinTimer(); call.sourceJoined = true;
      },
      async cancel() {
        call.canceled = true;
        if (timerState === "pending") timerController.abort(new Error("owned upstream timer canceled"));
        await joinTimer(); call.sourceJoined = true;
      },
    }), { headers: { "content-type": "text/event-stream" } });
  } };
}

const originalMethodInstall = (object, name, replacement) => { object[name] = replacement; };
test("Token Plan matrix owns 48 independent budgets and both public modes across all regions", () => {
  const positive = planRows.filter(row => row.kind === "success");
  assert.equal(positive.length, 48); assert.equal(new Set(planRows.map(row => row.id)).size, planRows.length);
  for (const provider of ["xiaomi-token-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams"]) {
    const actual = snapshot.providers.find(row => row.id === provider); assert.ok(actual);
    assert.deepEqual(actual.models.map(row => row.upstream), ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
    assert.equal(positive.filter(row => row.provider === provider).length, 16);
  }
});
test("original body observer keeps receiver, arguments, original promises and a single joined generation", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  const proof = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {});
  const reader = body.getReader(); const a = reader.read(), b = reader.read();
  assert.equal(proof.readers[0].operations[0].pending, a); assert.equal(proof.readers[0].operations[1].pending, b);
  await Promise.all([a, b]); reader.releaseLock(); const joined = proof.join(); assert.equal(proof.join(), joined); await joined;
});
test("original body observer preserves undefined cancel rejection and unrelated reads after all joins", async () => {
  const foreign = {}, body = new ReadableStream({ cancel() { return Promise.reject(undefined); } });
  const proof = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {}), reader = body.getReader();
  const pending = reader.read(), canceled = reader.cancel(foreign); await Promise.allSettled([pending, canceled]); reader.releaseLock();
  await assert.rejects(proof.join(), error => error instanceof AggregateError && error.errors.some(reason => reason === undefined));
  const errored = new ReadableStream({ start(c) { c.error(foreign); } }), late = new AbortController();
  const other = xiaomiObserveBody(errored, late.signal, originalMethodInstall, () => {}), r = errored.getReader();
  await Promise.allSettled([r.read()]); late.abort(foreign); r.releaseLock();
  await assert.rejects(other.join(), error => error.errors.includes(foreign));
});
test("body observer joins held originals and preserves callback failure without changing original result", async () => {
  let release; const body = new ReadableStream({ cancel() { return new Promise(done => { release = done; }); } });
  const fault = {}, proof = xiaomiObserveBody(body, undefined, originalMethodInstall, () => { throw fault; }), reader = body.getReader();
  const read = reader.read(), cancel = reader.cancel(); await read; reader.releaseLock();
  let settled = false; const joining = proof.join().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); release(); await cancel; await joining;
  const rejected = new ReadableStream({ cancel() { throw undefined; } }), observed = xiaomiObserveBody(rejected, undefined, originalMethodInstall, () => { throw fault; });
  const r = rejected.getReader(); await Promise.allSettled([r.cancel()]); r.releaseLock();
  await assert.rejects(observed.join(), error => error.errors.includes(undefined) && error.errors.includes(fault));
});
test("diagnostic schema refuses getters, proxies, arbitrary data and oversized coordinates", () => {
  let invoked = 0; const error = Object.defineProperty({}, "actual", { get() { invoked++; return "secret"; } });
  const record = diagnostic.record("sdk", "p0", "assert", 1, true, error);
  assert.equal(record.actual, null); assert.equal(invoked, 0);
  assert.equal(diagnostic.validate(new Proxy(record, { ownKeys() { throw new Error("must not run"); } })), null);
  for (const field of [{ message: "private" }, { caseId: "not_a_case" }, { actual: "private" }, { checkpoint: 65536 }, { expected: NaN }]) assert.equal(diagnostic.validate({ ...record, ...field }), null);
});
test("diagnostics retain distinct cases, final helper counts, nine plus overflow and no passing error commands", () => {
  const rows = Array.from({ length: 30 }, (_, i) => diagnostic.record("sdk", `p${i}`, "assert", 1, true, undefined));
  rows.push(diagnostic.record("outer", "none", "helper", 1, false, undefined, 30));
  let text = ""; diagnostic.emit(rows, true, value => { text += value; });
  const lines = text.trim().split("\n"); assert.equal(lines.length, 10); assert.match(lines[0], /"phase":"helper"/); assert.match(lines[9], /"phase":"overflow"/);
  assert.ok(Buffer.byteLength(text) <= 8192); assert.ok(lines.every(line => line.startsWith("::error")));
  diagnostic.emit(rows, false, () => assert.fail("passing evidence must not emit errors"));
  assert.equal(diagnostic.record("sdk", "p0", "assert", 1, true, undefined).kind, "undefined");
});
test("default Node spec reporter leaves fresh bounded annotations at column zero", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "xiaomi-reporter-")), path = join(temporary, "reporter.test.mjs");
  const failures = [];
  try {
    const row = diagnostic.record("outer", "none", "helper", 1, false, undefined, 0);
    await writeFile(path, `import test from 'node:test';${proofCode};test('fixed safe annotation',()=>xiaomiDiagnostic().emit([${JSON.stringify(row)}],true,line=>process.stdout.write(line)));`);
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=spec", path], { env, timeout: 10000, maxBuffer: 32768 });
    assert.equal(stdout.split("\n").filter(line => line.startsWith("::error title=Xiaomi typed contract::")).length, 1);
  } catch (error) { failures.push(error); }
  try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "reporter test and cleanup failed");
});
test("owned held-source timer joins its original timer on cancellation and rejects expiry", async () => {
  let signal, fail, calls = 0;
  const upstream = planUpstream((delay, options) => { calls++; assert.equal(delay, 10000); signal = options.signal; return new Promise((_, reject) => { fail = reject; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); });
  const response = await upstream.fetch(new Request("https://token-plan-sgp.xiaomimimo.com/v1/chat/completions", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) }));
  const reader = response.body.getReader(); while (!calls) await reader.read();
  // The pending source pull is owned by the response; cancellation joins it.
  await reader.cancel(); reader.releaseLock(); assert.equal(signal.aborted, true); assert.equal(upstream.calls[0].sourceJoined, true); assert.equal(upstream.calls[0].expired, false);
  const expired = planUpstream(() => Promise.resolve());
  const r = await expired.fetch(new Request("https://fixture.example", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: "{}" }));
  await assert.rejects(r.text()); assert.equal(expired.calls[0].expired, true);
});
test("actual Worker controls relay safe evidence, activated env/grant rows and real SQLite joins", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "xiaomi-plan-worker-")); const failures = []; let mf;
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture()); const origin = String(await mf.ready).replace(/\/$/, "");
    await provisionPlans(await mf.getKVNamespace("POLICY_KV", "router"));
    let r = await fetch(origin + "/fixture/grants", { method: "POST" }); await r.arrayBuffer(); assert.equal(r.status, 204);
    const row = diagnostic.record("sdk", "p0", "assert", 1, true, undefined);
    r = await fetch(origin + "/fixture/diagnostic", { method: "POST", body: JSON.stringify(row) }); await r.arrayBuffer(); assert.equal(r.status, 204); assert.deepEqual(await readDiagnostics(origin), [row]);
    for (const id of ["p0", "p4", "n_invalid_grant"]) {
      const selected = planRows.find(row => row.id === id);
      r = await fetch(origin + `/v1/native/${selected.provider}/chat/completions`, { method: "POST", headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${id}-fixture-secret`, "content-type": "application/json" }, body: JSON.stringify({ model: selected.model, stream: true, messages: [] }) });
      await r.text(); assert.equal(r.status, id === "n_invalid_grant" ? 503 : 200);
    }
    r = await fetch(origin + "/fixture/retire", { method: "POST" }); const physical = await r.json(); assert.equal(r.status, 200); assert.equal(physical.joined, true);
    assert.equal(physical.budgets.filter(row => row.path === "/reserve" && row.allowed).length, 2);
    assert.equal(physical.budgets.filter(row => row.id === "n_invalid_grant").length, 0);
    const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json(); assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(row => row.apiKey), ["tp-fixture-upstream-p0", "tp-fixture-upstream-p4"]);
  } catch (error) { failures.push(error); }
  try { await mf?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, "Worker control or cleanup failures");
});
test("SDK body reporting retains undefined primary and independent writer errors without a callback-rethrow duplicate", () => {
  for (const primary of [undefined, {}]) {
    const secondary = {};
    assert.throws(() => xiaomiRethrow(primary, () => { throw secondary; }), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === primary && error.errors[1] === secondary);
    let seen = false;
    try { xiaomiRethrow(primary, () => {}); } catch (error) { seen = true; assert.equal(error, primary); }
    assert.equal(seen, true);
  }
});
