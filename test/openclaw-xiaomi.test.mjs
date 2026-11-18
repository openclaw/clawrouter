import { AsyncLocalStorage } from "node:async_hooks";
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
const { xiaomiPlanCases, xiaomiNativeControls, xiaomiInvocationOwnership, xiaomiInstallProperty, xiaomiStopReason, xiaomiState, xiaomiReaderWitnesses, xiaomiSignal, xiaomiSdkReaderDisposition, xiaomiWorkerReaderDisposition, xiaomiSdkErrorWitness, xiaomiSdkProviderErrorDisposition, xiaomiSdkPreabortDisposition, xiaomiPublicAbortResult, xiaomiNativeControlQualified, xiaomiDiagnostic, xiaomiObserveBody, xiaomiSealReaderObservations, xiaomiRethrow, xiaomiConsumeControlWitness, xiaomiControlQualification, xiaomiPostludeFailures } = new Function(proofCode + ";return { xiaomiPlanCases, xiaomiNativeControls, xiaomiInvocationOwnership, xiaomiInstallProperty, xiaomiStopReason, xiaomiState, xiaomiReaderWitnesses, xiaomiSignal, xiaomiSdkReaderDisposition, xiaomiWorkerReaderDisposition, xiaomiSdkErrorWitness, xiaomiSdkProviderErrorDisposition, xiaomiSdkPreabortDisposition, xiaomiPublicAbortResult, xiaomiNativeControlQualified, xiaomiDiagnostic, xiaomiObserveBody, xiaomiSealReaderObservations, xiaomiRethrow, xiaomiConsumeControlWitness, xiaomiControlQualification, xiaomiPostludeFailures };")();
const planRows = xiaomiPlanCases(), allPlanRows = [...xiaomiNativeControls(), ...planRows], diagnostic = xiaomiDiagnostic(nodeTypes.isProxy);
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
function xiaomiRunnerReport() {
  let reported = false, summary;
  const options = {
    expectedInvocations: 1,
    fixtureSha256: "8c93b0bde95c42d7e16d0724387d9fc9b3b18a590e777cb2c9bd839112461e14",
    reporterSha256: "9c39bb702834528918c1e2f69509cea9de1e557d20ecf8205a9c36cb53f2a478",
    onReport(packet) {
      summary = undefined;
      assert.equal(reported, false, "duplicate Xiaomi runner report"); reported = true;
      // Only the canonical helper's complete, invocation-bound packet supplies facts.
      const row = { v: 1, kind: "native_runner_startup", state: packet.reporter === "absent" ? "absent" : "incomplete",
        phases: null, counts: null, reason: null, first: null, bytes: null, sha256: null };
      if (packet.complete) {
        const binding = packet.records[0].binding;
        assert.equal(binding.pin, sourceHead); assert.equal(binding.target, "extensions/xiaomi/worker-contract.test.ts");
        assert.equal(binding.fixtureSha256, options.fixtureSha256); assert.equal(binding.reporterSha256, options.reporterSha256);
        const end = packet.records.at(-1), first = packet.records.find(value => value.kind === "error");
        row.state = "complete";
        row.phases = ["run_start", "module_queued", "module_collected", "module_start", "module_end"]
          .map(phase => packet.records.find(value => value.kind === "phase" && value.phase === phase)?.count ?? null);
        row.counts = [end.ready, end.results, end.errors, end.omitted]; row.reason = end.reason;
        row.first = first ? [first.surface, first.error.received, first.error.name.presence, first.error.name.value,
          first.error.code.presence, first.error.code.value] : null;
        row.bytes = packet.bytes; row.sha256 = packet.sha256;
      }
      const text = JSON.stringify(row);
      assert.ok(Buffer.byteLength(text) <= 768, "Xiaomi runner summary capacity");
      summary = text;
    },
  };
  return { options, emit(rows, failed, sdkCount, write) {
    diagnostic.emit(rows, failed, text => {
      // Never displace an SDK record or claim absence after a failed diagnostic read.
      // A full existing packet leaves the supplementary runner report unknown.
      if (sdkCount === 0 && !rows.some(row => row.source === "sdk") && summary !== undefined && text.split("\n").length - 1 < 9) {
        const extra = `::error title=Xiaomi native runner::${summary.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`;
        if (Buffer.byteLength(extra) <= 768 && Buffer.byteLength(text + extra) <= 8192) text += extra;
      }
      write(text);
    });
  } };
}
const cards = { pro_stream: "mimo-v2.6-pro", pro_simple: "mimo-v2.6-pro", flash_stream: "mimo-v2.6-flash", flash_simple: "mimo-v2.6-flash",
  off: "mimo-v2.6-pro", max: "mimo-v2.6-pro", no_usage: "mimo-v2.6-pro", http_error: "mimo-v2.6-pro", embedded_error: "mimo-v2.6-pro" };
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "retired_pro", "retired", "aborted"];
test("registered Xiaomi PAYG streams preserve original grants, retired identities and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "xiaomi");
  assert.deepEqual(provider.models.map(m => m.upstream), ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xiaomi-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf, origin;
  const failures = [], evidence = diagnostic.store(), runner = xiaomiRunnerReport(); let helperFulfilled = false, phase = "setup", sdkCount = null;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true, requestContext: true });
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
    origin = (await mf.unsafeGetDirectURL("router")).origin;
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    phase = "helper";
    await runOpenClawConsumer({ diagnostic() {} }, { source, sourceHead, fixture: new URL("./fixtures/openclaw-xiaomi-contract.test.ts", import.meta.url), testPath: "extensions/xiaomi/worker-contract.test.ts",
      runnerReport: runner.options,
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
    for (const control of xiaomiNativeControls()) assert.equal(arrived.filter(row => row.source === "sdk" && row.caseId === control.id && row.phase === "control" && !row.failed).length, 1);
    assert.equal(arrived.filter(row => row.source === "sdk" && row.caseId === "n_cancel" && row.phase === "sdk_cancel_receipt" && !row.failed && row.checkpoint === 1 && row.count === 1).length, 1);
    phase = "usage"; await assertPlanOracles(origin, calls, physical, (row, checkpoint, error) => evidence.add(diagnostic.record("outer", row.id, "assert", checkpoint, true, error)));
  } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", phase, 0, true, error)); }
  finally {
    if (origin) {
      try { const r = await fetch(origin + "/fixture/retire?seal=1", { method: "POST" }); await r.arrayBuffer(); if (r.status !== 200) throw new Error("original Worker joins failed"); }
      catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "retire", 0, true, error)); }
      try { const records = await readDiagnostics(origin); sdkCount = records.filter(r => r.source === "sdk").length; for (const row of records) evidence.add(row); }
      catch (error) { failures.push(error); }
    }
    try { await mf?.dispose(); } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "dispose", 0, true, error)); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); evidence.add(diagnostic.record("outer", "none", "remove", 0, true, error)); }
    const helper = diagnostic.record("outer", "none", "helper", helperFulfilled ? 1 : phase === "helper" ? 2 : 0, phase === "helper" && !helperFulfilled, undefined, sdkCount);
    try { runner.emit([helper, ...evidence.values()], failures.length > 0, sdkCount, line => process.stdout.write(line)); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Xiaomi original contract and cleanup failures");
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { usageSnapshot, budgetStatus } from "./worker/ledgers.ts";
import { AsyncLocalStorage } from "node:async_hooks";
${proofCode}
${planRouter.toString()}
const plan = planRouter(handler, putGrantCredentials, revokeGrantCredentials, new AsyncLocalStorage(), usageSnapshot, budgetStatus);
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
const calls = []; export default { async fetch(request, env, context) {
    if (request.url === "https://fixture.example/state") { const failures = await plan.join(); return Response.json([...calls, ...plan.calls], { status: failures.length ? 500 : 200 }); }
    if (request.headers.has("api-key")) return plan.fetch(request, context);
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
  for (const row of allPlanRows) {
    const id = `xiaomi_plan_${row.id}`;
    await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: [row.kind === "foreign_policy" ? "xiaomi" : row.provider],
      models: [`${row.provider}/${row.kind === "foreign_model" ? "mimo-v2.6-flash" : row.model}`],
      ...(row.source === "grant" ? { grantRouting: { strategy: "round_robin", eligibleGrants: { [row.provider]: row.kind === "failover" ? [row.provider, "zz-alternate"] : [row.provider] }, environmentFallback: false } } : {}),
      monthlyBudgetMicros: row.kind === "capacity" ? 0 : 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
    await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    await kv.put(`connections/${row.provider}`, JSON.stringify({ providerId: row.provider, enabled: true }));
  }
}
async function readDiagnostics(origin, controlFetch = fetch) {
  const response = await controlFetch(origin + "/fixture/diagnostics"), reader = response.body.getReader(); const chunks = [], failures = []; let size = 0;
  try { while (true) {
    const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 64 * 768 + 128) { failures.push(new Error("diagnostic capacity")); try { await reader.cancel(); } catch (error) { failures.push(error); } break; }
    chunks.push(part.value);
  } } catch (error) { failures.push(error); }
  try { reader.releaseLock(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, "diagnostic read and cleanup failed");
  const rows = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(Array.isArray(rows) && rows.length <= 64);
  return rows.map(value => { const row = diagnostic.validate(value); assert.ok(row); return row; });
}
async function assertPlanOracles(origin, calls, physical, report, rows = planRows) {
  const failures = [];
  for (const row of rows) {
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
      const denialStatus = ["foreign_policy", "foreign_model", "capacity"].includes(row.kind) ? "denied"
        : ["missing", "invalid_grant"].includes(row.kind) ? "provider_error" : null;
      const eventCount = row.kind === "rotation" ? 4 : denialStatus ? 1 : count;
      const dispatchedStatus = ["http", "cancel", "failover"].includes(row.kind) ? "client_error" : row.kind === "embedded" ? "provider_error" : "success";
      const statuses = row.kind === "rotation" ? ["success", "provider_error", "success", "provider_error"] : Array(eventCount).fill(denialStatus ?? dispatchedStatus);
      let usage;
      for (let n = 0; n < 150; n++) {
        const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${row.id}-fixture-secret` } });
        usage = await response.json(); if (usage.usage.events.length === eventCount) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      check(22, () => { assert.equal(usage.usage.events.length, eventCount); assert.deepEqual(usage.usage.events.map(event => event.status).sort(), statuses.sort()); });
      for (const event of usage.usage.events) {
        const denied = denialStatus !== null || row.kind === "rotation" && event.status === "provider_error";
        const rejected = denied || ["http", "embedded", "failover"].includes(row.kind), unknown = rejected || ["no_usage", "cancel"].includes(row.kind);
        check(23, () => assert.equal(event.provider, row.provider)); check(24, () => assert.equal(event.model, `${row.provider}/${row.model}`)); check(25, () => assert.equal(event.credential_id, `xiaomi_plan_${row.id}`));
        check(26, () => { assert.equal(event.status, denied ? denialStatus ?? "provider_error" : dispatchedStatus); if (denied) assert.equal(event.reserved_cost_micros, 0); });
        check(27, () => assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed")); check(28, () => assert.equal(event.actual_cost_micros, rejected ? 0 : 7));
        check(29, () => assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], unknown ? [null, null, null, null] : [300, 20, 320, 256]));
      }
      check(30, () => assert.equal(usage.budget.spentMicros, ["http", "embedded", "failover"].includes(row.kind) ? 0 : count * 7));
      check(31, () => assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-plan-thinking|synthetic-plan-result|synthetic-plan-answer/));
    } catch (error) { failures.push(error); try { report(row, checkpoint, error); } catch (reportError) { failures.push(reportError); } }
  }
  if (failures.length) throw new AggregateError(failures, "independent Xiaomi oracle failures");
}

// Embedded only in the fixture Worker. Each record owns its original operations.
function planRouter(handler, putGrantCredentials, revokeGrantCredentials, requestContext, usageSnapshot, budgetStatus) {
  const rows = [...xiaomiNativeControls(), ...xiaomiPlanCases()], diagnostic = xiaomiDiagnostic(), records = diagnostic.store(), inputs = [], requests = [], budgets = [], materializations = [];
  const originalFetch = globalThis.fetch, generation = {}; let retirement, sequence = 0; const tick = () => ++sequence;
  const identify = value => rows.find(row => value === `${row.prefix}-fixture-upstream-${row.id}` || row.kind === "rotation" && value === `ttp-fixture-upstream-${row.id}`);
  globalThis.fetch = function(input, init) {
    const headers = new Headers(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
    const row = identify(headers.get("api-key"));
    const item = { owner: requestContext?.getStore(), generation, ordinal: inputs.length + 1, observations: [], row, errors: [], state: "invoke", invoked: tick() }; inputs.push(item);
    let returned;
    try { returned = Reflect.apply(originalFetch, this, arguments); item.returned = returned; }
    catch (error) { item.state = "sync_throw"; item.settled = tick(); item.errors.push(error); throw error; }
    void returned.then(response => {
      item.state = "fulfilled"; item.response = response; item.settled = tick();
      try { if (response.body) item.observations.push(xiaomiObserveBody(response.body, init?.signal ?? (input instanceof Request ? input.signal : undefined),
        (object, name, replacement) => { object[name] = replacement; },
        (phase, checkpoint, failed, error) => records.add(diagnostic.record("worker", row?.id ?? "payg", phase, checkpoint, failed, error)), tick)); }
      catch (error) { item.errors.push(error); }
    }, () => { item.state = "rejected"; item.settled = tick(); });
    return returned;
  };
  function snapshotInput(input, failures) {
    if (!["c_cancel", "n_cancel"].includes(input.row?.id)) return;
    try {
      for (const observation of input.observations) for (const value of xiaomiReaderWitnesses(diagnostic, "worker", input.row.id, input.ordinal, observation)) records.add(value);
    } catch (error) { failures.push(error); }
  }
  async function sourceCalls(id) {
    const response = await Reflect.apply(originalFetch, globalThis, ["https://fixture.example/state"]);
    const calls = (await response.json()).filter(value => value.planId === id);
    return { calls, ok: response.ok };
  }
  async function joinInput(input, env, calls) {
    await input.returned;
    await Promise.all(input.observations.map(value => value.settle()));
    if (!input.selection && ["c_cancel", "n_cancel"].includes(input.row?.id) && requestContext && usageSnapshot && budgetStatus) {
      if (calls === undefined) {
        const source = await sourceCalls(input.row.id); calls = source.calls;
        if (!source.ok) throw new Error("owned upstream source join failed");
      }
      if (calls.length !== 1) throw new Error("ambiguous original source owner");
      const policyId = `xiaomi_plan_${input.row.id}`;
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await usageSnapshot(env, "fixture", policyId, { kind: "credential", id: policyId });
        if (usage.events.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const budget = await budgetStatus(env, policyId, { tenantId: "fixture", monthlyBudgetMicros: 100 });
      input.selection = { worker: { generation, input, requests, inputs, source: calls[0], usage, budget } };
    }
    await Promise.all(input.observations.map(value => value.join(input.selection)));
  }
  async function retire(env) {
    const failures = [];
    for (const request of requests) {
      const result = await Promise.allSettled([request.returned]); failures.push(...result.flatMap(v => v.status === "rejected" ? [v.reason] : []));
      let done = 0; while (done < request.pending.length) { const batch = request.pending.slice(done); done += batch.length; failures.push(...(await Promise.allSettled(batch)).flatMap(v => v.status === "rejected" ? [v.reason] : [])); }
    }
    for (const input of inputs) {
      failures.push(...(await Promise.allSettled([joinInput(input, env)])).flatMap(v => v.status === "rejected" ? [v.reason] : []), ...input.errors);
      snapshotInput(input, failures);
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
        retirement ??= retire(env);
        const failures = []; let result;
        try { result = await retirement; } catch (error) { failures.push(error); }
        // Only the existing final postlude seals, after control/accounting work.
        if (url.searchParams.get("seal") === "1") {
          try { await xiaomiSealReaderObservations(inputs.flatMap(input => input.observations)); } catch (error) { failures.push(error); }
          if (failures.length) records.add(diagnostic.record("worker", "none", "retire", 0, true, undefined, failures.length));
        }
        return Response.json(failures.length ? { joined: false } : result, { status: failures.length ? 500 : 200 });
      }
      if (url.pathname.startsWith("/fixture/plan/")) {
        const [, , , id, action] = url.pathname.split("/"), row = rows.find(value => value.id === id);
        if (row && action === "witness" && request.method === "GET") {
          const failures = [], matchingRequests = requests.filter(value => value.row?.id === id), matchingInputs = inputs.filter(value => value.row?.id === id);
          for (const owned of matchingRequests) {
            failures.push(...(await Promise.allSettled([owned.returned])).flatMap(value => value.status === "rejected" ? [value.reason] : []));
            let done = 0; while (done < owned.pending.length) { const batch = owned.pending.slice(done); done += batch.length;
              failures.push(...(await Promise.allSettled(batch)).flatMap(value => value.status === "rejected" ? [value.reason] : [])); }
          }
          // Control I/O is deliberately outside the observed inference fetch. It
          // consumes its actual response before returning only fixed safe facts.
          let calls = [];
          try { const source = await sourceCalls(id); calls = source.calls;
            if (!source.ok) throw new Error("owned upstream source join failed"); }
          catch (error) { failures.push(error); }
          for (const owned of matchingInputs) {
            failures.push(...(await Promise.allSettled([joinInput(owned, env, calls)])).flatMap(value => value.status === "rejected" ? [value.reason] : []), ...owned.errors);
            snapshotInput(owned, failures);
          }
          const witness = { caseId: id, joined: failures.length === 0, requests: matchingRequests.length, inputs: matchingInputs.length, calls: calls.length,
            reserves: budgets.filter(value => value.id === id && value.path === "/reserve" && value.allowed).length,
            canceled: calls.some(value => value.canceled), expired: calls.some(value => value.expired), sourceJoined: calls.every(value => value.sourceJoined), completed: calls.length > 0 && calls.every(value => value.completed === true) };
          if (failures.length) records.add(diagnostic.record("worker", id, "control", 1, true, undefined, failures.length));
          return Response.json(witness, { status: failures.length ? 500 : 200 });
        }
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
      const record = { pending: [], generation, row, signal: request.signal }; requests.push(record);
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
      try {
        const invoke = () => handler.fetch(request, bound, { ...context, waitUntil(pending) { record.pending.push(pending); return context.waitUntil(pending); } });
        record.returned = requestContext ? requestContext.run(record, invoke) : invoke();
        const observed = record.returned.then(response => { record.status = response.status; });
        record.pending.push(observed); context.waitUntil(observed);
      }
      catch (error) { record.returned = Promise.reject(error); void record.returned.catch(() => {}); throw error; }
      return record.returned;
    },
  };
}
function planUpstream(wait) {
  const calls = [], sources = [];
  return { calls, async join() {
    const results = await Promise.all(sources.map(source => source.joined));
    return results.flat();
  }, async fetch(request, context) {
    const apiKey = request.headers.get("api-key"), planId = apiKey?.replace(/^(?:tp|ttp)-fixture-upstream-/, "");
    const body = await request.json(), turn = calls.filter(call => call.planId === planId).length + 1;
    const call = { planId, turn, url: request.url, method: request.method, authorization: request.headers.get("authorization"), apiKey, xApiKey: request.headers.get("x-api-key"), body, canceled: false, expired: false, sourceJoined: true, completed: false }; calls.push(call);
    if (planId === "n_http" || planId === "n_failover") return Response.json({ error: { message: "Synthetic rejection" } }, { status: planId === "n_http" ? 401 : 429 });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const first = frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-plan-answer" }, finish_reason: null }] });
    const wire = ["n_embedded", "c_provider_error"].includes(planId) ? frame({ error: { code: "synthetic", message: "Synthetic rejection" } }) : first + frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(planId === "n_no_usage" || ["n_cancel", "c_cancel"].includes(planId) ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } }) }) + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(["n_cancel", "c_cancel"].includes(planId) ? first : wire); let offset = 0;
    let timer, timerObserved, timerController, timerState = "absent", timerReason;
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    const source = { operations: [], joined: undefined }; sources.push(source);
    Object.assign(call, { active: 0, settled: false, cancelCalls: 0, cancelReturned: 0 });
    const track = (kind, body) => {
      call.active++;
      const operation = { kind, pending: undefined, observed: undefined, state: "pending", reason: undefined };
      source.operations.push(operation);
      try { operation.pending = body(); } catch (error) { operation.pending = Promise.reject(error); }
      operation.observed = operation.pending.then(() => {
        operation.state = "fulfilled"; call.active--;
        if (kind === "cancel") { call.cancelReturned++; finish(); }
      }, error => {
        operation.state = "rejected"; operation.reason = error; call.active--; finish();
      });
      return operation.pending;
    };
    source.joined = (async () => {
      await terminal;
      let done = 0;
      while (done < source.operations.length) { const batch = source.operations.slice(done); done += batch.length;
        await Promise.all(batch.map(operation => operation.observed)); }
      const failures = source.operations.filter(operation => operation.state === "rejected").map(operation => operation.reason);
      call.settled = call.active === 0;
      call.sourceJoined = call.settled && failures.length === 0 && (!call.canceled || call.cancelCalls === 1 && call.cancelReturned === 1);
      return failures;
    })();
    // This request owns the source callbacks, even when a later control joins them.
    context?.waitUntil(source.joined);
    const joinTimer = async () => {
      if (!timer) return;
      await timerObserved;
      if (!(call.canceled && timerController.signal.aborted && timerState === "rejected" && timerReason !== null && typeof timerReason === "object")) {
        call.expired = timerState === "fulfilled";
        throw timerState === "rejected" ? timerReason : new Error("owned upstream timer expired");
      }
    };
    call.sourceJoined = false;
    return new Response(new ReadableStream({
      pull(c) { return track("pull", async () => {
        if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; return; }
        if (!["n_cancel", "c_cancel"].includes(planId)) { c.close(); call.completed = true; finish(); return; }
        call.sourceJoined = false;
        if (!timer) {
          timerController = new AbortController(); timerState = "pending";
          timer = wait(10000, { signal: timerController.signal });
          timerObserved = timer.then(() => { timerState = "fulfilled"; }, reason => { timerState = "rejected"; timerReason = reason; });
          track("producer", async () => {
            try { await joinTimer(); }
            catch (error) {
              try { c.error(error); } catch (independent) { throw new AggregateError([error, independent], "source failure and stream error failed"); }
              throw error;
            }
          });
        }
        // A held pull can prevent cross-service cancellation from reaching the
        // source. Yield bounded SSE comments; the original timer still owns expiry.
        await wait(20);
        if (timerState === "pending" && !call.canceled) c.enqueue(new TextEncoder().encode(": fixture heartbeat\n\n"));
      }); },
      cancel() { return track("cancel", async () => {
        call.canceled = true; call.cancelCalls++;
        if (timerState === "pending") timerController.abort(new Error("owned upstream timer canceled"));
        await joinTimer();
      }); },
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
// BEGIN Xiaomi reader join inert tests. No native streams or transport objects.
function xiaomiInertReader(options = {}) {
  const calls = [], subscriptions = new Map();
  const count = pending => {
    if (subscriptions.has(pending)) return pending;
    subscriptions.set(pending, 0); const then = pending.then;
    pending.then = function(...args) { subscriptions.set(pending, subscriptions.get(pending) + 1); return Reflect.apply(then, this, args); };
    return pending;
  };
  const reader = {
    closed: count(options.closed ?? Promise.resolve()),
    read(...args) { calls.push({ kind: "read", receiver: this, args }); return count(options.read?.(...args) ?? Promise.resolve({ done: true })); },
    cancel(...args) { calls.push({ kind: "cancel", receiver: this, args }); return count(options.cancel?.(...args) ?? Promise.resolve()); },
    releaseLock(...args) { calls.push({ kind: "unlock", receiver: this, args }); body.locked = false; return options.unlock?.(...args); },
  };
  const body = { locked: false, getReader(...args) { calls.push({ kind: "reader", receiver: this, args }); body.locked = true; return reader; } };
  if (options.observe === false) return { body, reader, calls, subscriptions };
  const proof = xiaomiObserveBody(body, undefined, (object, key, value) => { object[key] = value; }, options.report ?? (() => {}));
  return { body, reader: body.getReader(), proof, calls, subscriptions };
}
const xiaomiInertTurns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
for (const sealed of [false, true]) for (const reason of [undefined, { late: true }]) test(`reader join invalidates ${sealed ? "sealed" : "open"} late cancellation defined=${reason !== undefined}`, async () => {
  const f = xiaomiInertReader({ cancel: () => Promise.reject(reason) });
  await f.reader.read(); f.reader.releaseLock(); await f.proof.join();
  if (sealed) await f.proof.seal();
  const pending = f.reader.cancel(undefined); assert.equal(f.proof.readers[0].operations.at(-1).pending, pending);
  assert.notEqual(f.proof.joinAccepted, true);
  await Promise.allSettled([pending]);
  for (let n = 0; n < 2; n++) await assert.rejects(f.proof.join(), error => error.errors.includes(reason));
  assert.equal(f.proof.joinAccepted, false); assert.equal(f.proof.readers[0].operations.at(-1).reasonPresent, true);
});
test("reader join shares only inflight work and does not resubscribe to unchanged originals", async () => {
  const read = Promise.withResolvers(), cancel = Promise.withResolvers();
  const f = xiaomiInertReader({ read: () => read.promise, cancel: () => cancel.promise });
  const operand = {}, original = f.reader.read(operand); assert.equal(original, read.promise);
  const first = f.proof.join(); assert.equal(f.proof.join(), first);
  read.resolve({ done: true }); f.reader.releaseLock(); await first;
  const before = new Map(f.subscriptions); await f.proof.join();
  for (const [pending, count] of before) assert.equal(f.subscriptions.get(pending), count);
  const originalCancel = f.reader.cancel(undefined); assert.equal(originalCancel, cancel.promise); assert.equal(f.proof.joinAccepted, null);
  let done = false; const second = f.proof.join(); assert.notEqual(second, first); assert.equal(f.proof.join(), second);
  const observed = second.then(() => { done = true; }); await xiaomiInertTurns(); assert.equal(done, false);
  cancel.resolve(); await observed; await xiaomiSealReaderObservations([f.proof]); assert.equal(f.proof.sealed, true); assert.equal(f.proof.joinAccepted, true);
  assert.deepEqual(f.calls.find(row => row.kind === "read").args, [operand]);
  assert.deepEqual(f.calls.find(row => row.kind === "cancel").args, [undefined]);
  assert.ok(f.calls.filter(row => row.kind !== "reader").every(row => row.receiver === f.reader));
  assert.equal(f.subscriptions.get(read.promise), 2); assert.equal(f.subscriptions.get(cancel.promise), 2);
});
test("reader join follows an original observer tail without joining itself", async () => {
  const read = Promise.withResolvers(), tail = Promise.withResolvers(); let f, appended = false;
  f = xiaomiInertReader({ read: () => read.promise, cancel: () => tail.promise });
  f.reader.read(); let done = false;
  const joined = f.proof.join(), observed = joined.then(() => { done = true; });
  read.resolve({ get done() { if (!appended) { appended = true; f.reader.cancel(); } return true; } });
  await xiaomiInertTurns(); assert.equal(appended, true); assert.equal(done, false);
  tail.resolve(); f.reader.releaseLock(); await observed; assert.equal(f.proof.joinAccepted, true);
});
for (const reason of [undefined, { observer: true }]) test(`reader join retains observer callback failure defined=${reason !== undefined}`, async () => {
  const f = xiaomiInertReader({ read: () => Promise.resolve({ get done() { throw reason; } }) });
  const original = f.reader.read(); await original; f.reader.releaseLock();
  await assert.rejects(f.proof.join(), error => error.errors.includes(reason));
  assert.equal(f.proof.readers[0].operations[0].state, "fulfilled");
  assert.throws(() => f.proof.seal()); assert.equal(f.proof.joinAccepted, false);
});
test("reader join retains an original when observer registration throws undefined", async () => {
  const held = Promise.withResolvers(), nativeThen = held.promise.then; let calls = 0;
  held.promise.then = function(...args) { if (++calls === 1) throw undefined; return Reflect.apply(nativeThen, this, args); };
  const f = xiaomiInertReader({ read: () => held.promise });
  assert.equal(f.reader.read(), held.promise); f.reader.releaseLock();
  let done = false; const joined = f.proof.join(); const observed = joined.then(() => { done = true; }, () => { done = true; });
  await xiaomiInertTurns(); assert.equal(done, false);
  const originalFailure = { original: true }; held.reject(originalFailure);
  await assert.rejects(joined, error => error.errors.includes(undefined) && error.errors.includes(originalFailure)); await observed;
});
for (const kind of ["reader", "read", "cancel", "unlock"]) test(`reader join rejects foreign ${kind} binding without changing original forwarding`, async () => {
  const f = xiaomiInertReader(), foreign = {};
  if (kind === "reader") f.body.getReader.call(foreign);
  else if (kind === "unlock") f.reader.releaseLock.call(foreign);
  else await f.reader[kind].call(foreign, undefined);
  if (kind !== "unlock") f.reader.releaseLock();
  await assert.rejects(f.proof.join()); assert.equal(f.proof.joinAccepted, false);
  assert.ok(f.calls.some(row => row.kind === kind && row.receiver === foreign));
});
test("sealed reader attempts still forward once but cannot regain acceptance", async () => {
  const f = xiaomiInertReader(); await f.reader.read(); f.reader.releaseLock(); await xiaomiSealReaderObservations([f.proof]);
  const before = f.calls.length, pending = f.reader.cancel(); await pending;
  assert.equal(f.calls.length, before + 1); assert.equal(f.proof.joinAccepted, false);
  await assert.rejects(xiaomiSealReaderObservations([f.proof])); await assert.rejects(f.proof.join());
});
test("final reader postlude joins cross-body tails before sealing any body", async () => {
  const tail = Promise.withResolvers(), trigger = Promise.withResolvers(); let appended = false;
  const first = xiaomiInertReader({ cancel: () => tail.promise });
  await first.reader.read(); first.reader.releaseLock(); await first.proof.join();
  const second = xiaomiInertReader({ read: () => trigger.promise }); second.reader.read(); second.reader.releaseLock();
  const joined = xiaomiSealReaderObservations([first.proof, second.proof]); let done = false;
  const observed = joined.then(() => { done = true; });
  trigger.resolve({ get done() { if (!appended) { appended = true; first.reader.cancel(); } return true; } });
  await xiaomiInertTurns(); assert.equal(appended, true); assert.equal(done, false);
  assert.equal(first.proof.sealed, false); assert.equal(second.proof.sealed, false);
  tail.resolve(); await observed; assert.equal(first.proof.sealed, true); assert.equal(second.proof.sealed, true);
});
test("reader observer refuses duplicate reader identity and an unsettled seal", async () => {
  const f = xiaomiInertReader(); f.body.getReader(); f.reader.releaseLock();
  await assert.rejects(f.proof.join()); assert.equal(f.proof.readers.length, 1);
  const held = Promise.withResolvers(), pending = xiaomiInertReader({ read: () => held.promise }); pending.reader.read();
  assert.throws(() => pending.proof.seal(), /before stable joins/); assert.equal(pending.proof.sealed, false);
  held.resolve({ done: true }); pending.reader.releaseLock(); await assert.rejects(xiaomiSealReaderObservations([pending.proof]));
});
test("actual SDK postlude preserves restoration and report failures while sealing owned readers", async () => {
  const start = sdkSource.indexOf("afterEach(async () => {"), end = sdkSource.indexOf("\n});\nasync function planControl", start);
  assert.ok(start >= 0 && end > start);
  const callbackSource = stripTypeScriptTypes(sdkSource.slice(start + "afterEach(".length, end + 2));
  for (const restorationReason of [undefined, { restore: true }]) {
    const reportReason = { report: true }, f = xiaomiInertReader(); await f.reader.read(); f.reader.releaseLock();
    let restorationCalls = 0, reportCalls = 0;
    const bindings = {
      planContext: { id: "p0", phase: "assert", checkpoint: 1 }, planInvocations: [], planBodyPassed: true,
      planAcquisitions: [{ state: "fulfilled", bound: true, observation: f.proof, returned: Promise.resolve(), released: Promise.resolve(),
        releases: [{ state: "fulfilled", pending: Promise.resolve() }], context: { id: "p0" }, guard: { detach() {} } }],
      planOwnership: { async join() { return []; }, restore() { restorationCalls++; throw restorationReason; } },
      restorePlanRuntime() { restorationCalls++; }, vi: { restoreAllMocks() { restorationCalls++; } }, planObserverFaults: [],
      xiaomiPostludeFailures, xiaomiSealReaderObservations, qualifiedNativeControls: () => false, xiaomiSdkPreabortDisposition: () => false, xiaomiNativeControlQualified: () => false,
      planRemember() {}, planRecords: { values: () => [{}] }, planDiagnostic: {}, qualifiedControls: new Set(),
      AbortController: class { signal = {}; }, setTimeout: () => 1, clearTimeout() {}, origin: "https://fixture.example",
      async controlFetch() { reportCalls++; throw reportReason; },
    };
    const callback = new Function(...Object.keys(bindings), "return (" + callbackSource + ");")(...Object.values(bindings));
    await assert.rejects(callback(), error => error.errors.includes(restorationReason) && error.errors.includes(reportReason));
    assert.equal(restorationCalls, 3); assert.equal(reportCalls, 1); assert.equal(f.proof.sealed, true);
  }
});
test("actual Worker final retirement seals after its open drain and preserves late failures", async () => {
  for (const outcome of ["fulfilled", "undefined", "defined"]) {
    const reason = outcome === "undefined" ? undefined : { original: true };
    const f = xiaomiInertReader({ observe: false, cancel: () => outcome === "fulfilled" ? Promise.resolve() : Promise.reject(reason) });
    let fetches = 0;
    const ownedGlobal = { fetch: () => { fetches++; return Promise.resolve({ body: f.body }); } };
    const handler = { fetch: () => ownedGlobal.fetch("https://fixture.example/chat", { headers: { "api-key": "tp-fixture-upstream-p0" } }) };
    const FakeHeaders = class { constructor(value) { this.value = value ?? {}; } get(key) { return this.value[key] ?? null; } };
    const FakeResponse = class { static json(value, { status = 200 } = {}) { return { value, status }; } };
    const plan = new Function("globalThis", "Headers", "Response", "Request", "URL", "handler",
      proofCode + "\n" + planRouter.toString() + ";return planRouter(handler,()=>{},()=>{});")
      (ownedGlobal, FakeHeaders, FakeResponse, class {}, URL, handler);
    const request = { url: "https://fixture.example/v1/native/xiaomi-token-plan/chat/completions", method: "POST",
      headers: new FakeHeaders({ authorization: "Bearer clawrouter-live-xiaomi_plan_p0-fixture-secret" }) };
    const response = await plan.fetch(request, {}, { waitUntil() {} });
    const reader = response.body.getReader(); await reader.read(); reader.releaseLock();
    const control = final => plan.control({ url: "https://fixture.example/fixture/retire" + (final ? "?seal=1" : ""), method: "POST" }, {});
    assert.equal((await control(false)).status, 200);
    await Promise.allSettled([reader.cancel(undefined)]);
    const final = await control(true); assert.equal(final.status, outcome === "fulfilled" ? 200 : 500);
    if (outcome === "fulfilled") {
      await reader.cancel(); assert.equal((await control(true)).status, 500);
    }
    assert.equal(fetches, 1);
  }
});
// END Xiaomi reader join inert tests.

// BEGIN Xiaomi first failed reader snapshot inert tests. No native streams or transport.
function xiaomiReaderSnapshotOwner(f, id = "c_provider_error") {
  const invocation = { id, ordinal: 1, control: true, acquisitions: [] };
  const acquisition = { ordinal: 1, invocation, state: "fulfilled", bound: true, accepted: true, observation: f.proof,
    releases: [{ state: "fulfilled", invoked: 90, settled: 91 }] };
  invocation.acquisitions.push(acquisition);
  return { invocation, acquisition, qualified: false, control: true };
}
function xiaomiReaderControlRecord(snapshot, id = "c_provider_error") {
  return diagnostic.controlRecord(diagnostic.record("sdk", id, "control", 1, true, undefined, 1),
    { state: 1, status: 200, witness: [true, 1, 1, 1, 1, false, false, true, true] },
    [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, true, false, false, null], [1, 7, true, 2, 192, 0, false], snapshot);
}
test("first reader snapshot distinguishes original read, cancel, closed and observer failures without inspecting reasons", async () => {
  let inspected = 0;
  const opaque = new Proxy({}, { get() { inspected++; throw new Error("reason inspected"); }, getOwnPropertyDescriptor() { inspected++; throw new Error("reason inspected"); }, ownKeys() { inspected++; throw new Error("reason inspected"); } });
  for (const reason of [undefined, opaque]) for (const kind of ["read", "cancel", "closed", "observer"]) {
    const closed = Promise.withResolvers(), options = { closed: closed.promise };
    if (kind === "read" || kind === "cancel") options[kind] = () => Promise.reject(reason);
    if (kind === "observer") options.read = () => Promise.resolve({ get done() { throw reason; } });
    const f = xiaomiInertReader(options), selection = xiaomiReaderSnapshotOwner(f), operand = {};
    const original = f.reader.read(operand), canceled = f.reader.cancel(undefined);
    if (kind === "closed") closed.reject(reason); else closed.resolve();
    await Promise.allSettled([original, canceled]); f.reader.releaseLock();
    const trace = f.calls.slice(), subscriptions = new Map(f.subscriptions); let originalError;
    await assert.rejects(f.proof.join(selection), error => { originalError = error; return error.errors.includes(reason); });
    const snapshot = f.proof.failureSnapshot(); assert.equal(snapshot.errorPresent, false);
    const v = snapshot.value, expected = { read: [2, 1], cancel: [2, 2], closed: [8, 3], observer: [64, 4] }[kind];
    assert.equal(v[8], expected[0]); assert.equal(v[15][0], expected[1]); assert.equal(v[15][2], reason === undefined ? 1 : 2);
    assert.deepEqual(v.slice(1, 5), [1, 1, 1, 1]); assert.equal(v[6], 1); assert.deepEqual(v[17], [0, null, 1, false]);
    if (reason === undefined) assert.deepEqual(v[15].slice(3), [null, null, null, null, null]);
    assert.equal(xiaomiReaderControlRecord(v).v, 4);
    await assert.rejects(f.proof.join(), error => error === originalError); await assert.rejects(xiaomiSealReaderObservations([f.proof]));
    assert.equal(f.proof.failureSnapshot(), snapshot); assert.deepEqual(f.calls, trace);
    for (const [pending, count] of subscriptions) assert.equal(f.subscriptions.get(pending), count + 1);
    assert.equal(f.calls.find(row => row.kind === "read").args[0], operand); assert.deepEqual(f.calls.find(row => row.kind === "cancel").args, [undefined]);
  }
  assert.equal(inspected, 0);
});
test("snapshot retains existing locked evaluation once, including throw and unreached disposition operands", async () => {
  for (const reason of [undefined, {}]) {
    const f = xiaomiInertReader(), selection = xiaomiReaderSnapshotOwner(f);
    await f.reader.read(); f.reader.releaseLock(); let gets = 0;
    Object.defineProperty(f.body, "locked", { get() { gets++; throw reason; } });
    await assert.rejects(f.proof.join(selection), error => error.errors.includes(reason));
    const value = f.proof.failureSnapshot().value;
    assert.equal(gets, 1); assert.deepEqual(value[17], [0, null, 2, null]); assert.equal(value[8], 64);
    xiaomiReaderControlRecord(value); assert.equal(gets, 1);
  }
  const f = xiaomiInertReader({ read: () => Promise.reject(undefined) }), selection = xiaomiReaderSnapshotOwner(f, "c_cancel");
  selection.control = false; await Promise.allSettled([f.reader.read()]); f.reader.releaseLock();
  await assert.rejects(f.proof.join(selection)); assert.equal(f.proof.failureSnapshot().value[5], 0);
  assert.deepEqual(f.proof.failureSnapshot().value[17], [0, null, 1, false]);
});
test("reader snapshot keeps missing originals diagnostic and missing closed result does not invent a failure", async () => {
  const f = xiaomiInertReader(), selection = xiaomiReaderSnapshotOwner(f);
  await f.reader.read(); f.reader.releaseLock(); await f.proof.settle();
  f.proof.readers[0].originalClosed = undefined;
  await f.proof.join(selection); assert.equal(f.proof.failureSnapshot(), undefined);
  const g = xiaomiInertReader(), owner = xiaomiReaderSnapshotOwner(g);
  await g.reader.read(); g.reader.releaseLock(); await g.proof.settle(); g.proof.readers[0].operations[0].original = undefined;
  await assert.rejects(g.proof.join(owner)); const value = g.proof.failureSnapshot().value;
  assert.equal(value[8], 4); assert.deepEqual(value[10], [1, 0, 0, 0, 1]); assert.deepEqual(value[15].slice(0, 3), [0, null, 0]);
  const foreign = xiaomiInertReader({ cancel: () => Promise.reject(undefined) }), bad = xiaomiReaderSnapshotOwner(foreign);
  bad.acquisition.observation = { readers: foreign.proof.readers.slice() };
  await Promise.allSettled([foreign.reader.cancel()]); foreign.reader.releaseLock(); await assert.rejects(foreign.proof.join(bad));
  assert.deepEqual(foreign.proof.failureSnapshot().value, [0]);
});
test("snapshot reporting preserves original undefined failures and independent postlude errors", async () => {
  for (const original of [undefined, {}]) for (const reporting of [undefined, {}]) {
    const f = xiaomiPostludeInertCase(new Map([[7, original]]));
    f.bindings.planAcquisitions[0].observation.failureSnapshot = () => { throw reporting; };
    await assert.rejects(f.callback(), error => {
      assert.equal(error.errors[0], original); assert.equal(error.errors[1], reporting); return true;
    });
    const record = f.records.values().find(row => row.v === 3);
    assert.ok(record.postlude[reporting === undefined ? 5 : 4] & (1 << 8));
    assert.equal(f.events.at(-1), "seal");
    const g = xiaomiInertReader({ read: () => Promise.reject(original) }), owner = xiaomiReaderSnapshotOwner(g);
    Object.defineProperty(owner.acquisition, "releases", { get() { throw reporting; } });
    await Promise.allSettled([g.reader.read()]); g.reader.releaseLock();
    await assert.rejects(g.proof.join(owner), error => error.errors[0] === original);
    assert.equal(g.proof.failureSnapshot().errorPresent, true); assert.equal(g.proof.failureSnapshot().error, reporting);
  }
});
test("the actual cancel disposition reads each reached locked operand once and preserves its thrown reason", async () => {
  for (const throwing of [false, true]) {
    let tick = 0, gets = 0; const reason = {}, signal = { aborted: false, reason: undefined };
    const f = xiaomiInertReader({ observe: false, read: () => Promise.resolve({ done: false, value: new Uint8Array([1]) }) });
    f.proof = xiaomiObserveBody(f.body, signal, (object, key, value) => { object[key] = value; }, () => {}, () => ++tick);
    f.reader = f.body.getReader(); await f.reader.read();
    const owner = xiaomiReaderSnapshotOwner(f, "c_cancel"), inv = owner.invocation, acq = owner.acquisition;
    Object.assign(inv, { bodyPassed: true, resultAborted: true, partialReader: f.proof.readers[0], partial: ++tick });
    inv.caller = { observed: true, initial: false, event: ++tick, reasonPresent: true, reason };
    acq.guard = { signal, observed: true, initial: false, event: ++tick, reasonPresent: true, reason };
    signal.aborted = true; signal.reason = reason; await f.reader.cancel();
    acq.releases = [{ state: "fulfilled", invoked: ++tick, settled: ++tick }]; f.reader.releaseLock();
    Object.defineProperty(f.body, "locked", { get() { gets++; if (throwing) throw undefined; return false; } });
    if (throwing) {
      await assert.rejects(f.proof.join(owner), error => error.errors.length === 2 && error.errors.every(value => value === undefined));
      const snapshot = f.proof.failureSnapshot().value;
      assert.equal(snapshot[6], 3); assert.deepEqual(snapshot[17], [2, null, 2, null]); assert.equal(snapshot[8], 64);
    } else {
      await f.proof.join(owner); assert.equal(f.proof.failureSnapshot(), undefined); assert.equal(f.proof.joinAccepted, true);
    }
    assert.equal(gets, 2);
  }
});
test("held original observer tails and concurrent joins complete before the immutable first failure snapshot", async () => {
  const held = Promise.withResolvers(), failed = Promise.withResolvers(), observer = Promise.withResolvers(); let appended = false, f, attached = 0;
  const then = failed.promise.then;
  failed.promise.then = function(...args) {
    const result = Reflect.apply(then, this, args);
    return ++attached === 1 ? result.finally(() => observer.promise) : result;
  };
  f = xiaomiInertReader({ read: () => failed.promise, cancel: () => held.promise });
  const owner = xiaomiReaderSnapshotOwner(f); f.reader.read();
  const first = f.proof.join(owner); assert.equal(f.proof.join(owner), first);
  failed.resolve({ get done() { if (!appended) { appended = true; f.reader.cancel(); } throw undefined; } });
  let settled = false; const observed = first.catch(() => { settled = true; }); await xiaomiInertTurns();
  assert.equal(settled, false); assert.equal(f.proof.failureSnapshot(), undefined); held.reject(undefined); f.reader.releaseLock();
  await xiaomiInertTurns(); assert.equal(settled, false); assert.equal(f.proof.failureSnapshot(), undefined); observer.resolve();
  await observed; assert.equal(f.proof.joinAccepted, false);
  const snapshot = f.proof.failureSnapshot(); assert.equal(snapshot.value[8], 2 | 64);
  await Promise.allSettled([f.reader.cancel()]); await assert.rejects(f.proof.join());
  assert.equal(f.proof.failureSnapshot(), snapshot); assert.equal(snapshot.value[11][0], 1);
});
test("v4 control tuples stay closed, opaque and bounded in both formatter orders while v1-v3 bytes stay exact", async () => {
  const f = xiaomiInertReader({ cancel: () => Promise.reject(undefined) }), owner = xiaomiReaderSnapshotOwner(f);
  await Promise.allSettled([f.reader.cancel()]); f.reader.releaseLock(); await assert.rejects(f.proof.join(owner));
  const value = f.proof.failureSnapshot().value, row = xiaomiReaderControlRecord(value);
  const legacy = xiaomiReaderControlRecord(); assert.equal(legacy.v, 3);
  const { reader, ...base } = row; assert.equal(JSON.stringify({ ...base, v: 3 }), JSON.stringify(legacy));
  assert.equal(diagnostic.validate({ ...row, failed: false, postlude: [1, 0, null, 0, 0, 0, false] }), null);
  const invalid = [];
  for (const [i, v] of [[0, 2], [3, 2], [4, 2], [5, 4], [6, 0], [7, 0], [8, 256], [9, 0]]) { const t = structuredClone(value); t[i] = v; invalid.push(t); }
  for (const i of [10, 11, 12, 13, 14, 15, 16, 17]) { const t = structuredClone(value); t[i].push(0); invalid.push(t); }
  const unknown = structuredClone(value); unknown[15][2] = 1; unknown[15][3] = true; invalid.push(unknown);
  const skipped = structuredClone(value); skipped[17] = [0, true, 1, false]; invalid.push(skipped);
  for (const reader of invalid) assert.equal(diagnostic.validate({ ...row, reader }), null);
  let gets = 0; const accessor = value.slice(); Object.defineProperty(accessor, "8", { get() { gets++; return 2; } });
  assert.equal(diagnostic.validate({ ...row, reader: accessor }), null); assert.equal(gets, 0);
  assert.equal(diagnostic.validate({ ...row, reader: new Proxy(value, { ownKeys() { throw undefined; } }) }), null);
  const parent = new Function(proofCode + ";return xiaomiDiagnostic;")()(nodeTypes.isProxy);
  for (const [producer, consumer] of [[diagnostic, parent], [parent, diagnostic]]) {
    const control = producer.controlRecord(row, row.control, row.control.qualification, row.postlude, value);
    const cancel = { ...control, caseId: "c_cancel" }, store = producer.store();
    for (let i = 0; i < 63; i++) store.add(producer.record("sdk", "p0", "read", i, true, undefined));
    store.add(control); store.add(cancel); assert.throws(() => store.add(control));
    let text; producer.emit(store.values(), true, value => { text = value; });
    const commands = text.trimEnd().split("\n"); assert.ok(commands.length <= 10); assert.ok(Buffer.byteLength(text) <= 8192);
    const rows = commands.map(command => { assert.ok(Buffer.byteLength(command + "\n") <= 768); return consumer.validate(JSON.parse(command.split("::").at(-1))); });
    assert.ok(rows.every(Boolean)); assert.ok(rows.some(value => value.v === 4 && value.caseId === "c_cancel")); assert.ok(rows.some(value => value.v === 4 && value.caseId === "c_provider_error"));
  }
  // Include the command prefix and newline in the unchanged 768-byte limit.
  const wide = structuredClone(row);
  wide.reader[1] = wide.reader[2] = 1_000_000;
  wide.reader[10] = wide.reader[11] = [1_000_000, 250000, 250000, 250000, 250000];
  wide.reader[13] = wide.reader[14] = [1_000_000, 1_000_000]; wide.reader[16].fill(1_000_000);
  wide.control.qualification = [1, 1, 1, 1, ...Array(6).fill(1_000_000), false, false, false, false];
  wide.control.witness = [false, 1000, 1000, 1000, 1000, false, false, false, false];
  wide.postlude = [1, 12, false, 1_000_000, 4095, 4095, false];
  wide.reader[15] = [2, 1_000_000, 2, false, false, false, false, false];
  wide.actual = wide.expected = -1.2345678901234567e-100;
  wide.count = 1_000_000; wide.checkpoint = 65535; assert.ok(diagnostic.validate(wide));
  let maximum; diagnostic.emit([wide], true, value => { maximum = value; });
  assert.equal(Buffer.byteLength(maximum), 747); assert.ok(Buffer.byteLength(maximum) <= 768);
  const oversized = { ...wide, reader: [...wide.reader, "x".repeat(768)] };
  let writes = 0; assert.equal(diagnostic.validate(oversized), null);
  assert.throws(() => diagnostic.emit([oversized], true, () => { writes++; })); assert.equal(writes, 0);
});
// BEGIN Xiaomi original reader reason display regressions. Builtins and inert readers only.
const xiaomiReaderReasonProjector = new Function(proofCode + ";return xiaomiReaderReasonProjector;")();
const reasonCodes = ["ABORT_ERR", "UND_ERR_ABORTED", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT", "ECONNRESET",
  "ECONNREFUSED", "EPIPE", "ERR_INVALID_STATE", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"];
const reasonConstructors = [Error, TypeError, SyntaxError, ReferenceError, RangeError, URIError, EvalError, AggregateError];
const reasonError = Ctor => Ctor === AggregateError ? new AggregateError([]) : new Ctor();
test("original reason display matches immediate prototypes and one own-data cause, never own names", () => {
  const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError);
  const original = new TypeError(), cause = Object.assign(new Error(), { code: "ECONNRESET" });
  assert.equal(Object.hasOwn(original, "name"), false);
  Object.defineProperties(original, { name: { value: "ForgedClass" }, code: { value: "UND_ERR_SOCKET" }, cause: { value: cause } });
  const wrapper = new AggregateError([original]), members = wrapper.errors;
  assert.equal(project(wrapper, original, true, 1, null, true),
    "readerReason=v1;source=read;kind=native;protoMatch=TypeError;code=UND_ERR_SOCKET;cause=native/Error/ECONNRESET;abortEq=ut;origin=unknown");
  assert.equal(wrapper.errors, members); assert.equal(wrapper.errors[0], original); assert.equal(original.cause, cause);
  for (const [field, expected] of [[null, "absent"], [{ get() { throw undefined; } }, "accessor"],
    [{ value: undefined }, "undefined"], [{ value: 1 }, "wrongtype"], [{ value: "PRIVATE_UNKNOWN" }, "unknown"]]) {
    const value = new Error(); if (field) Object.defineProperty(value, "code", field);
    assert.ok(project(new AggregateError([value]), value, true, 1, false, null).includes(`;code=${expected};`));
  }
});
test("reason display never invokes getters, proxy traps, returned prototypes or stack preparation", () => {
  const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError);
  let touched = 0;
  const touch = () => { touched++; throw undefined; };
  const opaque = new Proxy({}, { get: touch, getPrototypeOf: touch, getOwnPropertyDescriptor: touch, ownKeys: touch });
  const revoked = Proxy.revocable(new Error(), {}); revoked.revoke();
  const value = new TypeError();
  for (const key of ["name", "message", "stack", "constructor", "errors", Symbol.toStringTag])
    Object.defineProperty(value, key, { get: touch, configurable: true });
  Object.defineProperties(value, { code: { get: touch }, cause: { get: touch } });
  const returnedPrototype = new TypeError(); Object.setPrototypeOf(returnedPrototype, opaque);
  const prepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  try {
    Object.defineProperty(Error, "prepareStackTrace", { value: touch, configurable: true });
    assert.ok(project(new AggregateError([]), value, true, 1, null, null).includes("protoMatch=TypeError;code=accessor;cause=accessor"));
    for (const proxy of [opaque, revoked.proxy]) assert.ok(project(new AggregateError([]), proxy, true, 1, null, null).includes(";kind=proxy;"));
    assert.ok(project(new AggregateError([]), returnedPrototype, true, 1, null, null).includes("protoMatch=unknown;"));
    assert.ok(project(new AggregateError([]), Object.create(TypeError.prototype), true, 1, null, null).includes(";kind=foreign;"));
  } finally {
    if (prepare) Object.defineProperty(Error, "prepareStackTrace", prepare); else delete Error.prepareStackTrace;
  }
  assert.equal(touched, 0);
});
test("reason projector captures intrinsics before mocks and reflects each admitted error only once", () => {
  const descriptor = Object.getOwnPropertyDescriptor, define = Object.defineProperty, proto = Object.getPrototypeOf, own = Object.hasOwn;
  const saved = ["getPrototypeOf", "getOwnPropertyDescriptor", "hasOwn", "defineProperty"].map(key => [key, descriptor(Object, key)]);
  const native = ["isProxy", "isNativeError"].map(key => [key, descriptor(nodeTypes, key)]);
  const seen = [], branded = [], proxyChecks = [];
  const original = Object.assign(new TypeError(), { code: "UND_ERR_SOCKET", cause: Object.assign(new Error(), { code: "ECONNRESET" }) });
  const wrapper = new AggregateError([original]), denied = Proxy.revocable(new Error(), {}); denied.revoke();
  let project, text;
  try {
    define(Object, "getPrototypeOf", { value: value => { seen.push(["prototype", value]); return proto(value); }, configurable: true });
    define(Object, "getOwnPropertyDescriptor", { value: (value, key) => { seen.push([key, value]); return descriptor(value, key); }, configurable: true });
    const proxy = nodeTypes.isProxy, brand = nodeTypes.isNativeError;
    project = xiaomiReaderReasonProjector(value => { proxyChecks.push(value); return proxy(value); },
      value => { branded.push(value); return brand(value); });
    for (const [key, prior] of saved) define(Object, key, { ...prior, value() { throw undefined; } });
    for (const [key, prior] of native) define(nodeTypes, key, { ...prior, value() { throw undefined; } });
    text = project(wrapper, original, true, 1, null, true);
    project(new AggregateError([]), denied.proxy, true, 1, null, null);
  } finally {
    for (const [key, prior] of saved) define(Object, key, prior);
    for (const [key, prior] of native) define(nodeTypes, key, prior);
  }
  assert.ok(text.includes("protoMatch=TypeError;code=UND_ERR_SOCKET;cause=native/Error/ECONNRESET"));
  assert.deepEqual(seen, [["prototype", original], ["code", original], ["cause", original], ["prototype", original.cause], ["code", original.cause]]);
  assert.deepEqual(proxyChecks, [original, original.cause, denied.proxy]); assert.deepEqual(branded, [original, original.cause]);
  assert.equal(own(original, "name"), false);
});
test("reason display preserves falsey presence and stops at one cause, including aggregate cycles", () => {
  const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError);
  for (const reason of [undefined, null, false, 0, "", NaN, 0n, Symbol()]) {
    const wrapper = new AggregateError([reason]);
    const received = reason === null ? "null" : typeof reason;
    assert.ok(project(wrapper, reason, true, 1, null, null).includes(`;kind=${received};`));
    assert.equal(wrapper.errors.length, 1); assert.ok(Object.is(wrapper.errors[0], reason));
    assert.ok(project(wrapper, reason, false, 0, null, null).includes(";kind=missing;"));
  }
  let touched = 0;
  const root = new AggregateError([]), child = new AggregateError([root]);
  root.errors.push(root); Object.defineProperty(root, "cause", { value: root, configurable: true });
  assert.ok(project(new AggregateError([root]), root, true, 1, null, null).includes(";cause=self;"));
  Object.defineProperty(root, "cause", { value: child });
  Object.defineProperties(child, { cause: { get() { touched++; throw undefined; } }, errors: { get() { touched++; throw undefined; } } });
  assert.ok(project(new AggregateError([root]), root, true, 1, null, null).includes(";cause=native/AggregateError/absent;"));
  Object.defineProperty(root, "cause", { value: undefined });
  assert.ok(project(new AggregateError([root]), root, true, 1, null, null).includes(";cause=undefined;"));
  assert.equal(root.errors[0], root); assert.equal(touched, 0);
});
test("every allowed code and prototype fits the unchanged 192-byte ASCII display limit", () => {
  const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError), texts = [];
  for (const Ctor of reasonConstructors) for (const code of reasonCodes) {
    const value = Object.assign(reasonError(Ctor), { code });
    const text = project(new AggregateError([value]), value, true, 4, null, null);
    assert.ok(text.includes(`protoMatch=${Ctor.name};code=${code};`)); texts.push(text);
    const root = Object.assign(new ReferenceError(), { code: "UND_ERR_HEADERS_TIMEOUT", cause: value });
    texts.push(project(new AggregateError([root]), root, true, 4, null, null));
  }
  for (const state of ["absent", "accessor", "undefined", "wrongtype", "unknown", ...reasonCodes])
    assert.ok(state.length <= "UND_ERR_HEADERS_TIMEOUT".length);
  for (const Ctor of reasonConstructors) assert.ok(Ctor.name.length <= "ReferenceError".length);
  for (const kind of ["missing", "undefined", "null", "boolean", "number", "string", "bigint", "symbol", "proxy", "foreign", "native"])
    assert.ok(kind.length <= "undefined".length);
  const root = Object.assign(new ReferenceError(), { code: "UND_ERR_HEADERS_TIMEOUT",
    cause: Object.assign(new ReferenceError(), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
  for (const kind of [0, 1, 2, 3, 4]) for (const a of [null, false, true]) for (const b of [null, false, true])
    texts.push(project(new AggregateError([root]), root, true, kind, a, b));
  for (const text of texts) { assert.match(text, /^[A-Za-z0-9_=/;]+$/); assert.ok(Buffer.byteLength(text) <= 192); }
  assert.equal(Math.max(...texts.map(text => Buffer.byteLength(text))), 176);
});
async function xiaomiReasonDisplayCase(project, reason, kind = "read", associated = true) {
  let ticks = 0;
  const closed = Promise.withResolvers(), options = { observe: false, closed: closed.promise };
  if (kind === "read" || kind === "cancel") options[kind] = () => Promise.reject(reason);
  if (kind === "observer") options.read = () => Promise.resolve({ get done() { throw reason; } });
  const f = xiaomiInertReader(options), reports = [];
  f.proof = xiaomiObserveBody(f.body, undefined, (object, key, value) => { object[key] = value; },
    (...args) => reports.push(args), () => ++ticks, project);
  f.reader = f.body.getReader();
  const owner = xiaomiReaderSnapshotOwner(f), operand = {};
  const pending = f.reader.read(operand), cancel = f.reader.cancel(undefined);
  assert.equal(f.proof.readers[0].operations[0].pending, pending);
  if (kind === "closed") closed.reject(reason); else closed.resolve();
  await Promise.allSettled([pending, cancel]); f.reader.releaseLock();
  let error;
  try { await f.proof.join(associated ? owner : undefined); } catch (caught) { error = caught; }
  const snapshot = f.proof.failureSnapshot(), before = ticks;
  if (error) await assert.rejects(f.proof.join(), caught => caught === error); else await f.proof.join();
  assert.equal(ticks, before); assert.equal(f.proof.failureSnapshot(), snapshot);
  return { f, error, snapshot, trace: { ticks, reports, subscriptions: [...f.subscriptions.values()],
    calls: f.calls.map(row => [row.kind, row.receiver === (row.kind === "reader" ? f.body : f.reader), row.args.length, row.args[0] === operand]) } };
}
test("first associated reason display preserves real observation traces and is absent on success and Worker joins", async () => {
  const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError), reason = new TypeError();
  for (const kind of ["read", "cancel", "closed", "observer"]) {
    const baseline = await xiaomiReasonDisplayCase(undefined, reason, kind); let count = 0;
    const shown = await xiaomiReasonDisplayCase((...args) => { count++; return project(...args); }, reason, kind);
    assert.equal(count, 1); assert.ok(shown.error.message.includes(`;source=${kind};`));
    assert.equal(shown.error.errors[0], reason); assert.deepEqual(shown.trace, baseline.trace);
    assert.deepEqual(shown.snapshot.value, baseline.snapshot.value);
    let left, right; diagnostic.emit([xiaomiReaderControlRecord(baseline.snapshot.value)], true, text => { left = text; });
    diagnostic.emit([xiaomiReaderControlRecord(shown.snapshot.value)], true, text => { right = text; }); assert.equal(left, right);
  }
  let unexpected = 0; const denied = () => { unexpected++; throw undefined; };
  await xiaomiReasonDisplayCase(denied, reason, "read", false);
  const success = await xiaomiReasonDisplayCase(denied, reason, "success");
  assert.equal(success.error, undefined); assert.equal(success.snapshot, undefined); assert.equal(unexpected, 0);
});
test("projection and wrapper-write faults retain the original aggregate before an independent undefined report fault", async () => {
  for (const reason of [undefined, false, null, 0, ""]) for (const updateFailure of [false, true]) {
    let calls = 0, wrapper;
    const project = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError);
    const shown = await xiaomiReasonDisplayCase((...args) => {
      calls++; wrapper = args[0];
      if (!updateFailure) throw undefined;
      Object.freeze(wrapper); return project(...args);
    }, reason);
    assert.equal(calls, 1); assert.equal(shown.error, wrapper); assert.ok(Object.is(wrapper.errors[0], reason));
    assert.equal(shown.snapshot.errorPresent, true);
    if (!updateFailure) assert.equal(shown.snapshot.error, undefined);
    const post = xiaomiPostludeInertCase(new Map([[7, wrapper]]));
    post.bindings.planAcquisitions[0].observation.failureSnapshot = () => shown.snapshot;
    await assert.rejects(post.callback(), error => error.errors[0] === wrapper && Object.is(error.errors[1], shown.snapshot.error));
    assert.equal(post.events.at(-1), "seal"); assert.equal(post.bindings.qualifiedControls.size, 0);
  }
});
// END Xiaomi original reader reason display regressions.

// BEGIN Xiaomi reader first-accounted gate regression.
test("first reader failure follows accounting order rather than the lowest failed bit", async () => {
  const same = {}, packets = [], parent = new Function(proofCode + ";return xiaomiDiagnostic;")()(nodeTypes.isProxy);
  const cases = [
    ...[undefined, same].flatMap(read => [undefined, same].map(cancel => ({ read, cancel, missing: false }))),
    { read: undefined, cancel: undefined, missing: true },
  ];
  for (const item of cases) {
    const f = xiaomiInertReader({ read: () => item.missing ? Promise.resolve({ done: true }) : Promise.reject(item.read),
      cancel: () => { if (item.missing) return Promise.reject(item.cancel); throw item.cancel; } });
    const owner = xiaomiReaderSnapshotOwner(f), operand = {}, pending = f.reader.read(operand);
    if (item.missing) await Promise.allSettled([f.reader.cancel(operand)]);
    else assert.throws(() => f.reader.cancel(operand), error => error === item.cancel);
    await Promise.allSettled([pending]); f.reader.releaseLock(); await f.proof.settle();
    if (item.missing) f.proof.readers[0].operations[0].original = undefined;
    const calls = f.calls.slice(), subscriptions = [...f.subscriptions.values()]; let original;
    await assert.rejects(f.proof.join(owner), error => {
      original = error; assert.equal(error.errors.length, 2); assert.equal(error.errors[1], item.cancel);
      if (item.missing) assert.equal(error.errors[0].message, "original reader operation not joined");
      else assert.equal(error.errors[0], item.read);
      return true;
    });
    const value = f.proof.failureSnapshot().value;
    assert.equal(value[8], item.missing ? 6 : 3); assert.equal(value[9], item.missing ? 3 : 2);
    assert.equal(value[15][2], item.missing ? 0 : item.read === undefined ? 1 : 2);
    assert.equal(f.proof.readers[0].operations[0].pending, pending);
    await assert.rejects(f.proof.join(), error => error === original);
    assert.deepEqual(f.calls, calls); assert.deepEqual([...f.subscriptions.values()], subscriptions);
    assert.equal(calls.find(row => row.kind === "read").args[0], operand);
    assert.equal(calls.find(row => row.kind === "cancel").args[0], operand);
    const row = xiaomiReaderControlRecord(value);
    for (const [producer, consumer] of [[diagnostic, parent], [parent, diagnostic]]) {
      let text; producer.emit([row, { ...row, caseId: "c_cancel" }], true, output => { text = output; });
      assert.ok(Buffer.byteLength(text) <= 8192);
      packets.push(text.trimEnd().split("\n").map(command => {
        assert.ok(Buffer.byteLength(command + "\n") <= 768);
        const message = command.slice("::error title=Xiaomi typed contract::".length), value = JSON.parse(message);
        assert.deepEqual(consumer.validate(value), value);
        return { title: "Xiaomi typed contract", annotation_level: "failure", message };
      }));
      for (const first of [0, 9, -1, 1.5, "2", true, false, null, undefined, NaN, 2 ** 53, item.missing ? 1 : 3]) {
        const reader = value.slice(); reader[9] = first;
        assert.equal(consumer.validate({ ...row, reader }), null);
      }
    }
  }
  return packets;
});
// END Xiaomi reader first-accounted gate regression.
// END Xiaomi first failed reader snapshot inert tests.

// BEGIN Xiaomi consumed control witness inert tests.
function xiaomiInertControlInvocation() {
  return { id: "c_cancel", caller: { observed: true, initial: false, reasonPresent: true, reason: {} },
    acquisitions: [{ bound: true, accepted: true, state: "fulfilled", releases: [{ state: "fulfilled", reasonPresent: false }] }] };
}
function xiaomiInertControlValue() {
  return { caseId: "c_cancel", joined: false, requests: 1, inputs: 1, calls: 1, reserves: 1,
    canceled: false, expired: true, sourceJoined: false, completed: false };
}
test("consumed control response retains the failed producer witness before strict rejection", () => {
  for (const status of [500, 200]) {
    const invocation = xiaomiInertControlInvocation(), value = xiaomiInertControlValue(), order = [];
    let observed, result, failure;
    try { result = xiaomiConsumeControlWitness(invocation.id, JSON.stringify(value), () => { order.push("status"); return status; }, diagnostic,
      record => { order.push("retained"); observed = record; }); } catch (error) { failure = error; }
    assert.deepEqual(order, ["status", "retained"]);
    assert.equal(observed.state, 1); assert.equal(observed.status, status);
    assert.deepEqual(observed.witness, [false, 1, 1, 1, 1, false, true, false, false]);
    assert.equal(!!failure, status === 500); if (status === 200) assert.deepEqual(result, value);
    // Returning a schema-valid 200 never invents joined=true or native eligibility.
    assert.equal(xiaomiNativeControlQualified({ ...invocation, control: true, bodyPassed: true, witness: value }), false);
  }
});
test("control missing and foreign fields remain unknown and independent undefined faults remain fatal", () => {
  for (const value of [null, { ...xiaomiInertControlValue(), caseId: "c_eof" }, { ...xiaomiInertControlValue(), requests: true },
    { ...xiaomiInertControlValue(), joined: undefined }, { ...xiaomiInertControlValue(), extra: "not emitted" }]) {
    let observation;
    assert.throws(() => xiaomiConsumeControlWitness("c_cancel", JSON.stringify(value), () => 200, diagnostic, v => { observation = v; }));
    assert.equal(observation.state, 2); assert.equal(observation.witness, null);
  }
  for (const primary of [undefined, { primary: true }]) for (const secondary of [undefined, { report: true }]) {
    assert.throws(() => xiaomiConsumeControlWitness("c_cancel", JSON.stringify(xiaomiInertControlValue()), () => { throw primary; }, diagnostic,
      () => { throw secondary; }), error => error instanceof AggregateError && error.errors.length === 2
        && Object.is(error.errors[0], primary) && Object.is(error.errors[1], secondary));
    assert.throws(() => xiaomiConsumeControlWitness("c_cancel", JSON.stringify(xiaomiInertControlValue()), () => 500, diagnostic,
      () => { throw secondary; }), error => error instanceof AggregateError && error.errors[0] instanceof Error && Object.is(error.errors[1], secondary));
  }
  let observation, statusReads = 0;
  assert.throws(() => xiaomiConsumeControlWitness("c_cancel", "{", () => { statusReads++; return 200; }, diagnostic, v => { observation = v; }));
  assert.equal(statusReads, 0); assert.deepEqual(observation, { state: 3, status: null, witness: null });
});
test("control record is closed, bounded and retained through the actual parent emitter and decoder in either order", () => {
  const observation = diagnostic.controlObservation("c_cancel", 500, xiaomiInertControlValue(), true);
  const qualification = xiaomiControlQualification(xiaomiInertControlInvocation());
  assert.deepEqual(qualification, [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, true, false, true, true]);
  const record = diagnostic.controlRecord(diagnostic.record("sdk", "c_cancel", "control", 1, true, undefined, 1), observation, qualification);
  let getters = 0;
  for (const bad of [{ ...record, control: { ...record.control, extra: true } }, { ...record, source: "worker" },
    { ...record, v: 3 }, { ...record, control: { ...record.control, state: 0 } },
    { ...record, control: { ...record.control, qualification: [...qualification, false] } }]) assert.equal(diagnostic.validate(bad), null);
  const getter = Object.defineProperty({ ...record }, "control", { get() { getters++; return record.control; } });
  assert.equal(diagnostic.validate(getter), null); assert.equal(getters, 0);
  assert.equal(diagnostic.validate(new Proxy(record, { ownKeys() { throw undefined; } })), null);
  for (const reverse of [false, true]) {
    const store = diagnostic.store(); for (let i = 0; i < 63; i++) store.add(diagnostic.record("sdk", `p${i % 48}`, "assert", i, true, undefined));
    store.add(record); assert.ok(store.values().some(row => row.v === 2));
    assert.throws(() => store.add(record), /duplicate/);
    const helper = diagnostic.record("outer", "none", "helper", 2, true, undefined, 1_000_000);
    const rows = [...store.values(), helper]; if (reverse) rows.reverse();
    let packet; diagnostic.emit(rows, true, text => { packet = text; });
    const lines = packet.trim().split("\n"), prefix = "::error title=Xiaomi typed contract::";
    const decoded = lines.map(line => diagnostic.validate(JSON.parse(line.slice(prefix.length).replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%"))));
    assert.ok(decoded.every(Boolean)); assert.equal(lines.length, 10); assert.equal(decoded[0].phase, "helper");
    assert.equal(decoded[1].v, 2); assert.deepEqual(decoded[1].control, record.control);
    assert.ok(lines.every(line => Buffer.byteLength(line + "\n") <= 768)); assert.ok(Buffer.byteLength(packet) <= 8192);
    for (const failure of [undefined, {}]) { let called = 0, caught = false;
      try { diagnostic.emit(rows, true, () => { called++; throw failure; }); } catch (error) { caught = true; assert.equal(error, failure); }
      assert.equal(caught, true); assert.equal(called, 1);
    }
  }
  const widest = diagnostic.controlRecord(diagnostic.record("sdk", "c_cancel", "control", 65535, true, undefined, 1_000_000),
    { state: 1, status: 500, witness: [false, 1000, 1000, 1000, 1000, false, false, false, false] },
    [...Array(10).fill(1_000_000), false, false, false, false]);
  let packet; diagnostic.emit([widest, ...Array.from({ length: 12 }, (_, i) => diagnostic.record("sdk", `p${i}`, "assert", 65535, true, undefined, 1_000_000))], true, value => { packet = value; });
  assert.ok(packet.split("\n").filter(Boolean).every(line => Buffer.byteLength(line + "\n") <= 768)); assert.ok(Buffer.byteLength(packet) <= 8192);
});
test("actual planWitness consumes once and preserves status failure while retaining private diagnostics", async () => {
  const start = sdkSource.indexOf("async function planWitness("), end = sdkSource.indexOf("\nafterEach", start);
  const actual = stripTypeScriptTypes(sdkSource.slice(start, end));
  for (const status of [500, 200]) {
    let calls = 0, bodies = 0; const invocation = xiaomiInertControlInvocation();
    const fn = new Function("controlFetch", "origin", "xiaomiConsumeControlWitness", "planDiagnostic", actual + ";return planWitness;")
      (async () => { calls++; return { status, async text() { bodies++; return JSON.stringify(xiaomiInertControlValue()); } }; },
        "https://fixture.invalid", xiaomiConsumeControlWitness, diagnostic);
    if (status === 500) await assert.rejects(fn(invocation)); else await fn(invocation);
    assert.equal(calls, 1); assert.equal(bodies, 1); assert.equal(invocation.controlObservation.state, 1);
    assert.equal(invocation.witness, undefined);
  }
});
test("actual cleanup callback retains consumed failure, restoration and reporting failures independently", async () => {
  const start = sdkSource.indexOf("afterEach(async () => {"), end = sdkSource.indexOf("\n});\nasync function planControl", start);
  const callbackSource = stripTypeScriptTypes(sdkSource.slice(start + "afterEach(".length, end + 2));
  for (const original of [undefined, { primary: true }]) {
    const restoration = {}, reporting = {}, invocation = xiaomiInertControlInvocation(); invocation.acquisitions = [];
    invocation.control = true; invocation.caller.detach = () => {}; invocation.bodyPassed = true; invocation.ordinal = 1;
    const records = diagnostic.store(); let restored = 0, sealed = 0, reads = 0, relays = 0;
    const bindings = {
      planContext: { id: "c_cancel", phase: "assert", checkpoint: 3 }, planInvocations: [invocation], planBodyPassed: true,
      planAcquisitions: [], planObserverFaults: [], qualifiedControls: new Set(), planRecords: records, planDiagnostic: diagnostic,
      planOwnership: { async join() { return []; }, restore() { restored++; throw restoration; } },
      restorePlanRuntime() { restored++; }, vi: { restoreAllMocks() { restored++; } },
      async planWitness(inv) { reads++; return xiaomiConsumeControlWitness(inv.id, JSON.stringify(xiaomiInertControlValue()), () => { throw original; }, diagnostic, value => { inv.controlObservation = value; }); },
      qualifiedNativeControls: () => false, xiaomiSdkPreabortDisposition: () => false, xiaomiNativeControlQualified,
      xiaomiControlQualification, xiaomiPostludeFailures, async xiaomiSealReaderObservations() { sealed++; },
      planRemember() {}, AbortController: class { signal = {}; }, setTimeout: () => 1, clearTimeout() {}, origin: "https://fixture.invalid",
      async controlFetch() { relays++; throw reporting; },
    };
    const callback = new Function(...Object.keys(bindings), "return (" + callbackSource + ");")(...Object.values(bindings));
    await assert.rejects(callback(), error => error instanceof AggregateError && error.errors.some(e => Object.is(e, original))
      && error.errors.includes(restoration) && error.errors.includes(reporting));
    assert.equal(reads, 1); assert.equal(restored, 3); assert.equal(sealed, 1); assert.equal(relays, 1);
    const control = records.values().find(row => row.v === 3);
    assert.ok(control); assert.equal(control.failed, true); assert.equal(control.control.state, 3);
    assert.equal(control.control.witness, null); assert.equal(invocation.witness, undefined);
    assert.equal(bindings.qualifiedControls.size, 0);
  }
});
// END Xiaomi consumed control witness inert tests.

// BEGIN Xiaomi direct ingress and postlude site inert tests.
test("native Xiaomi setup selects the existing direct router socket without another request", async () => {
  const text = readFileSync(new URL(import.meta.url), "utf8");
  const start = text.indexOf("mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture()");
  const end = text.indexOf("\n", start), originStart = text.indexOf("origin = ", end), originEnd = text.indexOf("\n", originStart);
  assert.ok(start > 0 && end > start && originStart > end);
  const setup = text.slice(start, end) + "\n" + text.slice(originStart, originEnd);
  let starts = 0, direct = 0, proxy = 0;
  const actual = new Function("startWorkerdFixture", "temporary", "routerFixture", "upstreamFixture",
    "return (async () => { let mf, origin; " + setup + "; return origin; })();");
  const origin = await actual(async (...args) => {
    starts++; assert.deepEqual(args, ["owned", "router", "upstream", { directRouter: true, requestContext: true }]);
    return { get ready() { proxy++; throw new Error("proxy origin is not direct ingress"); },
      async unsafeGetDirectURL(name) { direct++; assert.equal(name, "router"); return { origin: "https://direct.fixture.invalid" }; } };
  }, "owned", () => "router", () => "upstream");
  assert.equal(origin, "https://direct.fixture.invalid"); assert.deepEqual([starts, direct, proxy], [1, 1, 0]);
});
test("postlude summaries preserve undefined and independent originals without inspecting reasons", () => {
  const originals = [], summary = xiaomiPostludeFailures(originals); let inspected = 0;
  const reason = new Proxy({}, { get() { inspected++; throw undefined; }, getOwnPropertyDescriptor() { inspected++; throw undefined; } });
  summary.add(7, undefined, reason); summary.add(11, reason); summary.add(12, undefined);
  assert.deepEqual(summary.snapshot(), [1, 7, false, 4, (1 << 6) | (1 << 10), (1 << 6) | (1 << 11), false]);
  assert.equal(originals.length, 4); assert.equal(originals[0], undefined); assert.equal(originals[1], reason); assert.equal(originals[2], reason); assert.equal(originals[3], undefined);
  assert.equal(inspected, 0);
});
function xiaomiPostludeInertCase(failures = new Map(), controlStatus = 200) {
  const records = diagnostic.store(), events = [], reason = site => failures.get(site), has = site => failures.has(site);
  const trip = site => { if (has(site)) throw reason(site); };
  const reader = { closedState: "fulfilled", unlockCalls: 1, unlockReturns: 1, body: { locked: false }, faults: [], operations: [{ state: "fulfilled" }] };
  const observation = { readers: [reader], revision: 0, settle() { events.push("settle"); return has(3) ? Promise.reject(reason(3)) : Promise.resolve(); },
    async join() { events.push("reader"); trip(7); }, seal() {} };
  const invocation = { id: "c_provider_error", control: true, caller: { observed: true, initial: false, reasonPresent: false, signal: { aborted: false }, detach() {} }, acquisitions: [] };
  const row = { invocation, state: "fulfilled", bound: !has(6), accepted: true, context: { id: invocation.id }, returned: Promise.resolve(),
    get released() { return has(2) ? Promise.reject(reason(2)) : Promise.resolve(); },
    releases: [{ state: "fulfilled", pending: Promise.resolve() }], observation, guard: { detach() { events.push("detach"); trip(10); } } };
  invocation.acquisitions.push(row);
  const value = { caseId: invocation.id, joined: true, requests: 1, inputs: 1, calls: 1, reserves: 1, canceled: false, expired: false, sourceJoined: true, completed: true };
  const start = sdkSource.indexOf("afterEach(async () => {"), end = sdkSource.indexOf("\n});\nasync function planControl", start);
  assert.ok(start > 0 && end > start);
  const callbackSource = stripTypeScriptTypes(sdkSource.slice(start + "afterEach(".length, end + 2));
  const bindings = {
    planContext: { id: invocation.id, phase: "assert", checkpoint: 1 }, planInvocations: [invocation], planBodyPassed: true,
    planAcquisitions: [row], planObserverFaults: has(4) ? [reason(4)] : [], qualifiedControls: new Set(), planRecords: records, planDiagnostic: diagnostic,
    planOwnership: { async join() { events.push("ownership"); return has(1) ? [reason(1)] : []; }, restore() { events.push("restore-owner"); trip(11); } },
    restorePlanRuntime() { events.push("restore-runtime"); }, vi: { restoreAllMocks() { events.push("restore-mocks"); } },
    async planWitness(inv) { events.push("control"); trip(5);
      return xiaomiConsumeControlWitness(inv.id, JSON.stringify(value), () => controlStatus, diagnostic, data => { inv.controlObservation = data; }); },
    qualifiedNativeControls: () => false, xiaomiSdkPreabortDisposition: () => false,
    xiaomiNativeControlQualified(inv) { return !has(8) && xiaomiNativeControlQualified(inv); },
    xiaomiControlQualification, xiaomiPostludeFailures, async xiaomiSealReaderObservations() { events.push("seal"); trip(14); },
    planRemember() { trip(12); }, AbortController: class { signal = {}; },
    setTimeout() { events.push("timer"); return 1; }, clearTimeout() { events.push("clear"); }, origin: "https://fixture.invalid",
    async controlFetch() { events.push("relay"); trip(13); return { status: 204, async arrayBuffer() { events.push("consume"); } }; },
  };
  return { records, events, bindings, callback: new Function(...Object.keys(bindings), "return (" + callbackSource + ");")(...Object.values(bindings)) };
}
test("actual postlude classifies first sites and preserves subsequent failures and final cleanup", async () => {
  const clean = xiaomiPostludeInertCase(); await clean.callback();
  assert.deepEqual(clean.records.values()[0].postlude, [1, 0, null, 0, 0, 0, false]);
  assert.deepEqual(clean.events, ["ownership", "settle", "control", "reader", "detach", "restore-runtime", "restore-owner", "restore-mocks", "timer", "relay", "consume", "clear", "seal"]);
  const denied = xiaomiPostludeInertCase(new Map(), 500); await assert.rejects(denied.callback());
  const deniedRecord = denied.records.values().find(row => row.v === 3);
  assert.equal(deniedRecord.control.status, 500); assert.equal(deniedRecord.postlude[1], 5);
  assert.ok(deniedRecord.postlude[4] & (1 << 7)); assert.equal(denied.bindings.planInvocations[0].witness, undefined);
  for (const site of [1, 2, 3, 4, 5, 7, 10, 11]) for (const original of [undefined, {}]) {
    const f = xiaomiPostludeInertCase(new Map([[site, original]]));
    await assert.rejects(f.callback(), error => error instanceof AggregateError && error.errors.some(value => Object.is(value, original)));
    const row = f.records.values().find(value => value.v === 3); assert.ok(row);
    assert.equal(row.postlude[1], site); assert.equal(row.postlude[2], original !== undefined); assert.equal(row.failed, true);
    assert.ok(row.postlude[original === undefined ? 5 : 4] & (1 << (site - 1)));
    assert.equal(f.events.at(-1), "seal"); assert.equal(f.bindings.qualifiedControls.size, 0);
  }
  for (const site of [6, 8]) {
    const f = xiaomiPostludeInertCase(new Map([[site, true]])); await assert.rejects(f.callback());
    assert.equal(f.records.values().find(row => row.v === 3).postlude[1], site);
  }
  const original = {}, restoration = {}, reporting = {};
  const combined = xiaomiPostludeInertCase(new Map([[7, original], [11, restoration], [12, reporting], [13, undefined], [14, undefined]]));
  await assert.rejects(combined.callback(), error => {
    assert.deepEqual(error.errors, [original, restoration, reporting, reporting, undefined, undefined]); return true;
  });
  const row = combined.records.values().find(value => value.v === 3);
  assert.deepEqual(row.postlude, [1, 7, true, 4, (1 << 6) | (1 << 10) | (1 << 11), 0, false]);
  assert.equal(combined.events.at(-1), "seal");
  for (const site of [13, 14]) {
    const f = xiaomiPostludeInertCase(new Map([[site, undefined]]));
    await assert.rejects(f.callback(), error => error.errors.includes(undefined));
    // The earlier serialized observation never claims coverage of relay/final seal.
    assert.deepEqual(f.records.values().find(value => value.v === 3).postlude, [1, 0, null, 0, 0, 0, false]);
    assert.equal(f.bindings.qualifiedControls.size, 0);
  }
});
test("v3 postlude records stay closed and keep both controls under the existing packet quota", () => {
  const make = (id, summary) => diagnostic.controlRecord(diagnostic.record("sdk", id, "control", 1, summary[3] > 0, undefined, 1),
    { state: 1, status: 500, witness: [false, 1000, 1000, 1000, 1000, false, true, false, false] },
    [...Array(10).fill(1_000_000), true, false, true, true], summary);
  const summary = [1, 12, false, 1_000_000, 4095, 4095, true], cancel = make("c_cancel", summary), provider = make("c_provider_error", summary);
  assert.equal(diagnostic.validate(cancel).v, 3);
  for (const postlude of [[0, ...summary.slice(1)], [1, 13, false, 1, 0, 4096, false], [1, 7, false, 1, 64, 0, false],
    [1, 0, null, 1, 0, 0, false], [1, 0, null, 0, 0, 0, true], [1, 1, true, 1, 3, 0, false], [...summary, 0]]) {
    assert.equal(diagnostic.validate({ ...cancel, postlude }), null);
  }
  let reads = 0; const getter = [...summary]; Object.defineProperty(getter, "1", { get() { reads++; return 12; } });
  assert.equal(diagnostic.validate({ ...cancel, postlude: getter }), null); assert.equal(reads, 0);
  assert.equal(diagnostic.validate({ ...cancel, postlude: new Proxy(summary, { ownKeys() { throw undefined; } }) }), null);
  for (const bad of [{ ...cancel, failed: false }, { ...cancel, source: "worker" }, { ...cancel, extra: true }, { ...cancel, v: 2 }]) assert.equal(diagnostic.validate(bad), null);
  for (const reversed of [false, true]) {
    const store = diagnostic.store();
    for (let i = 0; i < 63; i++) store.add(diagnostic.record("sdk", `p${i % 48}`, "join", i, true, undefined));
    for (const row of reversed ? [provider, cancel] : [cancel, provider]) store.add(row);
    const values = store.values(); assert.equal(values.find(row => row.phase === "overflow").count, 2);
    assert.throws(() => store.add(cancel), /duplicate/);
    const rows = [diagnostic.record("outer", "none", "helper", 2, true, undefined, 1_000_000), ...values]; if (reversed) rows.reverse();
    let text; diagnostic.emit(rows, true, value => { text = value; });
    const lines = text.trim().split("\n"), prefix = "::error title=Xiaomi typed contract::";
    const decoded = lines.map(line => diagnostic.validate(JSON.parse(line.slice(prefix.length))));
    assert.ok(decoded.every(Boolean)); assert.equal(lines.length, 10);
    assert.deepEqual(decoded.slice(1, 3), [cancel, provider]);
    assert.equal(decoded.at(-1).phase, "overflow"); assert.ok(decoded.at(-1).count > 0);
    assert.ok(lines.every(line => Buffer.byteLength(line + "\n") <= 768)); assert.ok(Buffer.byteLength(text) <= 8192);
    for (const error of [undefined, {}]) { let calls = 0;
      assert.throws(() => diagnostic.emit(rows, true, () => { calls++; throw error; }), value => Object.is(value, error)); assert.equal(calls, 1);
    }
  }
});
// END Xiaomi direct ingress and postlude site inert tests.


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
  const upstream = planUpstream((delay, options) => { if (delay === 20) return Promise.resolve(); calls++; assert.equal(delay, 10000); signal = options.signal; return new Promise((_, reject) => { fail = reject; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); });
  const response = await upstream.fetch(new Request("https://token-plan-sgp.xiaomimimo.com/v1/chat/completions", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: JSON.stringify({ model: "mimo-v2.6-pro" }) }));
  const reader = response.body.getReader(); while (!calls) await reader.read();
  // The pending source pull is owned by the response; cancellation joins it.
  await reader.cancel(); reader.releaseLock(); assert.deepEqual(await upstream.join(), []);
  assert.equal(signal.aborted, true); assert.equal(upstream.calls[0].sourceJoined, true); assert.equal(upstream.calls[0].expired, false);
  assert.deepEqual([upstream.calls[0].cancelCalls, upstream.calls[0].cancelReturned, upstream.calls[0].active, upstream.calls[0].settled], [1, 1, 0, true]);
  const expired = planUpstream(() => Promise.resolve());
  const r = await expired.fetch(new Request("https://fixture.example", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: "{}" }));
  await assert.rejects(r.text()); assert.equal(expired.calls[0].expired, true);
  assert.equal((await expired.join()).length, 1); assert.equal(expired.calls[0].sourceJoined, false);
});
test("source callback retirement preserves held work, foreign controls and falsey original failures", async () => {
  const request = () => new Request("https://fixture.example", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: "{}" });
  for (const reason of [undefined, false]) {
    let reject, started = false; const retained = [];
    const upstream = planUpstream(delay => { if (delay === 20) return Promise.resolve(); started = true; return new Promise((_, fail) => { reject = fail; }); });
    const response = await upstream.fetch(request(), { waitUntil(pending) { retained.push(pending); } });
    const reader = response.body.getReader(); while (!started) await reader.read();
    const read = reader.read(), cancel = reader.cancel();
    let joined = false; const join = upstream.join().then(result => { joined = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(joined, false); assert.equal(upstream.calls[0].sourceJoined, false);
    assert.equal(upstream.calls[0].cancelReturned, 0); assert.ok(upstream.calls[0].active >= 2);
    assert.deepEqual(await planUpstream(() => Promise.resolve()).join(), []);
    assert.equal(joined, false, "a foreign control cannot retire this source");
    reject(reason);
    const results = await Promise.allSettled([read, cancel]);
    assert.equal(results[1].status, "rejected"); assert.equal(results[1].reason, reason);
    const failures = await join; assert.equal(failures.length, 2); assert.ok(failures.every(value => value === reason));
    await Promise.all(retained); reader.releaseLock();
    assert.equal(upstream.calls[0].sourceJoined, false); assert.equal(upstream.calls[0].settled, true);
    assert.equal(upstream.calls[0].active, 0); assert.equal(upstream.calls[0].cancelReturned, 0);
  }
  const early = planUpstream(() => { throw new Error("timer must not start before held pull"); });
  const response = await early.fetch(request()); await response.body.cancel();
  assert.deepEqual(await early.join(), []);
  assert.deepEqual([early.calls[0].cancelCalls, early.calls[0].cancelReturned, early.calls[0].active, early.calls[0].settled, early.calls[0].sourceJoined], [1, 1, 0, true, true]);
  const original = new Error("independent source failure");
  const failed = planUpstream(delay => delay === 20 ? Promise.resolve() : Promise.reject(original));
  const failedResponse = await failed.fetch(request());
  await assert.rejects(failedResponse.text(), error => error === original);
  assert.deepEqual(await failed.join(), [original]); assert.equal(failed.calls[0].sourceJoined, false);
  for (const reason of [undefined, false, original]) {
    let reject, started = false;
    const actual = new Function("AbortController", "return (" + planUpstream.toString() + ");")(class {
      signal = { aborted: false };
      abort() { throw reason; }
    });
    const upstream = actual(delay => { if (delay === 20) return Promise.resolve(); started = true; return new Promise((_, fail) => { reject = fail; }); });
    const response = await upstream.fetch(request()); const reader = response.body.getReader();
    while (!started) await reader.read();
    const cancel = reader.cancel(); const result = await Promise.allSettled([cancel]);
    assert.equal(result[0].status, "rejected"); assert.equal(result[0].reason, reason);
    let joined = false; const pending = upstream.join().then(value => { joined = true; return value; });
    await Promise.resolve(); assert.equal(joined, false, "failed cancel does not retire the held pull");
    reject(original); const failures = await pending;
    assert.equal(failures.length, 2); assert.equal(failures[0], original); assert.equal(failures[1], reason);
    assert.equal(upstream.calls[0].sourceJoined, false); assert.equal(upstream.calls[0].cancelReturned, 0); reader.releaseLock();
  }
});
test("source callback retirement joins real Workerd cancellation and rejects uncanceled expiry", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "xiaomi-source-retirement-")); let mf; const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const router = `export * from "./worker/index.ts"; export default { fetch(request) {
      if (new URL(request.url).pathname === "/early-cancel") return fetch("https://fixture.example/early-cancel");
      if (new URL(request.url).pathname === "/state") return fetch("https://fixture.example/state");
      return fetch("https://fixture.example", { method: "POST", headers: { "api-key": "tp-fixture-upstream-c_cancel" }, body: "{}" });
    } };`;
    const upstream = upstreamFixture()
      .replace("(delay, options) => scheduler.wait(delay, options)", "(delay, options) => { timerStarts++; return scheduler.wait(delay, options); }")
      .replace("const calls = []; export default { async fetch(request, env, context) {", `let timerStarts = 0; const calls = []; export default { async fetch(request, env, context) {
        if (request.url === "https://fixture.example/early-cancel") {
          const response = await plan.fetch(new Request("https://fixture.example", { method: "POST", headers: { "api-key": "tp-fixture-upstream-n_cancel" }, body: "{}" }), context);
          await response.body.cancel(); const failures = await plan.join();
          return Response.json({ failures: failures.length, timerStarts, call: plan.calls[0] });
        }`);
    mf = await startWorkerdFixture(temporary, router, upstream, { directRouter: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const early = await (await fetch(origin + "/early-cancel")).json();
    assert.equal(early.failures, 0); assert.equal(early.timerStarts, 0);
    assert.deepEqual([early.call.cancelCalls, early.call.cancelReturned, early.call.active, early.call.settled, early.call.sourceJoined], [1, 1, 0, true, true]);
    const response = await fetch(origin); const reader = response.body.getReader(); await reader.read();
    const pending = reader.read(); const canceled = reader.cancel(); await Promise.allSettled([pending, canceled]); reader.releaseLock();
    const state = await fetch(origin + "/state"); const calls = await state.json();
    assert.equal(state.status, 200, "source cancellation must retire before control success: " + JSON.stringify(calls.map(({ canceled, expired, active, settled, cancelCalls, cancelReturned }) => ({ canceled, expired, active, settled, cancelCalls, cancelReturned }))));
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[1].canceled, calls[1].cancelCalls, calls[1].cancelReturned, calls[1].settled, calls[1].active, calls[1].expired, calls[1].sourceJoined], [true, 1, 1, true, 0, false, true]);
    const uncanceled = await fetch(origin); await assert.rejects(uncanceled.text());
    const expired = await fetch(origin + "/state"); const after = await expired.json();
    assert.equal(expired.status, 500); assert.equal(after.length, 3);
    assert.equal(after[2].expired, true); assert.equal(after[2].sourceJoined, false);
  } catch (error) { failures.push(error); }
  try { await mf?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, "source retirement or cleanup failed");
});
test("actual Worker controls relay safe evidence, activated env/grant rows and real SQLite joins", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "xiaomi-plan-worker-")); const failures = []; let mf;
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { requestContext: true }); const origin = String(await mf.ready).replace(/\/$/, "");
    await provisionPlans(await mf.getKVNamespace("POLICY_KV", "router"));
    let r = await fetch(origin + "/fixture/grants", { method: "POST" }); await r.arrayBuffer(); assert.equal(r.status, 204);
    const row = diagnostic.record("sdk", "p0", "assert", 1, true, undefined);
    r = await fetch(origin + "/fixture/diagnostic", { method: "POST", body: JSON.stringify(row) }); await r.arrayBuffer(); assert.equal(r.status, 204); assert.deepEqual(await readDiagnostics(origin), [row]);
    for (const id of ["p0", "p4", "n_invalid_grant"]) {
      const selected = planRows.find(row => row.id === id);
      r = await fetch(origin + `/v1/native/${selected.provider}/chat/completions`, { method: "POST", headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${id}-fixture-secret`, "content-type": "application/json" }, body: JSON.stringify({ model: selected.model, stream: true, messages: [] }) });
      await r.text(); assert.equal(r.status, id === "n_invalid_grant" ? 503 : 200);
    }
    r = await fetch(origin + "/fixture/plan/p0/witness");
    assert.deepEqual(await r.json(), { caseId: "p0", joined: true, requests: 1, inputs: 1, calls: 1, reserves: 1, canceled: false, expired: false, sourceJoined: true, completed: true });
    r = await fetch(origin + "/fixture/plan/c_preabort/witness");
    assert.deepEqual(await r.json(), { caseId: "c_preabort", joined: true, requests: 0, inputs: 0, calls: 0, reserves: 0, canceled: false, expired: false, sourceJoined: true, completed: false });
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
test("actual Xiaomi router cancellation retires the original cross-service producer", { timeout: 45000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "xiaomi-router-source-")); const failures = []; let mf;
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true, requestContext: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    await provisionPlans(await mf.getKVNamespace("POLICY_KV", "router"));
    const grants = await fetch(origin + "/fixture/grants", { method: "POST" }); await grants.arrayBuffer(); assert.equal(grants.status, 204);
    const controller = new AbortController();
    const response = await fetch(origin + "/v1/native/xiaomi-token-plan/chat/completions", { method: "POST", signal: controller.signal,
      headers: { authorization: "Bearer clawrouter-live-xiaomi_plan_c_cancel-fixture-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "mimo-v2.6-pro", stream: true, messages: [] }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); let text = "";
    while (!text.includes("synthetic-plan-answer")) { const part = await reader.read(); assert.equal(part.done, false); text += new TextDecoder().decode(part.value); assert.ok(text.length < 8192); }
    const pending = reader.read(); controller.abort(new Error("owned local client cancellation"));
    await Promise.allSettled([pending, reader.closed]); reader.releaseLock();
    const upstream = await mf.getWorker("upstream"); const state = await upstream.fetch("https://fixture.example/state"); const calls = await state.json();
    assert.equal(state.status, 200); assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].planId, calls[0].canceled, calls[0].cancelCalls, calls[0].cancelReturned, calls[0].settled, calls[0].active, calls[0].expired, calls[0].sourceJoined],
      ["c_cancel", true, 1, 1, true, 0, false, true]);
    // The owned reader outcome also requires the actual source and accounting joins.
    const control = await fetch(origin + "/fixture/plan/c_cancel/witness"); const witness = await control.json();
    assert.equal(witness.caseId, "c_cancel"); assert.equal(witness.calls, 1);
    assert.equal(witness.canceled, true); assert.equal(witness.expired, false); assert.equal(witness.sourceJoined, true);
    assert.equal(control.status, 200); assert.equal(witness.joined, true);
    const records = await readDiagnostics(origin);
    t.diagnostic(JSON.stringify({ sourceJoined: witness.sourceJoined, controlStatus: control.status, workerJoined: witness.joined,
      readers: records.filter(row => row.source === "worker" && row.caseId === "c_cancel" && row.phase === "reader_witness").map(row => row.facts),
      rejected: records.filter(row => row.source === "worker" && row.caseId === "c_cancel" && row.phase === "operation_witness" && row.facts.state === 3).map(row => row.facts) }));
  } catch (error) { failures.push(error); }
  try { await mf?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, "router source or cleanup failed");
});
// These controls execute the actual observer and disposition, preserving rejected originals.
async function xiaomiWorkerOutcomeFixture(reason, change = () => {}) {
  const pending = Promise.withResolvers(); let count = 0;
  const f = xiaomiInertReader({ read: () => ++count === 1 ? Promise.resolve({ done: false, value: new Uint8Array([1]) }) : pending.promise });
  await f.reader.read(); const original = f.reader.read(); const canceled = f.reader.cancel();
  pending.reject(reason); await Promise.allSettled([original, canceled]); f.reader.releaseLock(); await f.proof.settle();
  const row = xiaomiNativeControls().find(value => value.id === "c_cancel"), generation = {}, controller = new AbortController(); controller.abort();
  const owner = { row, generation, status: 200, signal: controller.signal };
  const input = { row, generation, owner, state: "fulfilled", observations: [f.proof], response: { body: f.body }, returned: Promise.resolve(), errors: [] };
  const source = { planId: row.id, sourceJoined: true, canceled: true, cancelCalls: 1, cancelReturned: 1, settled: true, active: 0, expired: false, completed: false };
  const event = { status: "client_error", credential_id: `xiaomi_plan_${row.id}`, provider: row.provider, model: `${row.provider}/${row.model}`,
    actual_cost_micros: 7, cost_basis: "policy_fixed", input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null };
  const worker = { generation, input, requests: [owner], inputs: [input], source, usage: { events: [event] }, budget: { ledger: "durable_object", limitMicros: 100, spentMicros: 7 } };
  const selection = { worker }, reader = f.proof.readers[0];
  change({ f, worker, input, owner, source, event, reader });
  return { ...f, selection, original, reason, record: reader };
}
test("Worker owned cancellation admits a joined read outcome without rewriting distinct or undefined reasons", async () => {
  for (const ingressAborted of [false, true]) for (const reason of [{ distinct: true }, undefined]) {
    const f = await xiaomiWorkerOutcomeFixture(reason, ({ owner }) => { if (!ingressAborted) owner.signal = new AbortController().signal; }); await f.proof.join(f.selection); await xiaomiSealReaderObservations([f.proof]);
    const read = f.record.operations.find(operation => operation.state === "rejected");
    assert.equal(read.pending, f.original); assert.equal(read.reason, reason); assert.equal(read.reasonPresent, true);
    assert.equal(read.original.result.reason, reason); assert.equal(f.proof.joinAccepted, true); assert.equal(f.proof.sealed, true);
  }
});
test("Worker cancellation refuses foreign ownership, incomplete source, accounting and independent reader faults", async () => {
  const changes = [
    ({ input }) => { input.owner = { ...input.owner }; }, ({ owner }) => { owner.generation = {}; },
    ({ input }) => { input.generation = {}; }, ({ worker }) => { worker.inputs.push(worker.input); },
    ({ worker }) => { worker.requests.push(worker.input.owner); }, ({ input }) => { input.response = { body: {} }; },
    ({ input }) => { input.errors.push(undefined); },
    ({ owner }) => { owner.status = 500; }, ({ event }) => { event.status = "provider_error"; },
    ({ event }) => { event.credential_id = "foreign"; }, ({ event }) => { event.total_tokens = 1; },
    ({ event }) => { event.actual_cost_micros = 0; }, ({ worker }) => { worker.budget.spentMicros = 0; },
    ...[["sourceJoined",false],["canceled",false],["cancelCalls",2],["cancelReturned",0],["settled",false],["active",1],["expired",true],["completed",true],["planId","foreign"]]
      .map(([key,value]) => ({ source }) => { source[key] = value; }),
    ({ reader }) => { reader.faults.push(undefined); }, ({ reader }) => { reader.unlockReturns = 0; },
    ({ reader }) => { reader.closedState = "rejected"; }, ({ reader }) => { reader.closedState = "pending"; },
    ({ reader }) => { reader.operations[1].settled = reader.operations[2].invoked - 1; },
    ({ reader }) => { reader.operations[1].original = { ...reader.operations[1].original, pending: Promise.resolve() }; },
    ({ reader }) => { reader.operations[2].state = "rejected"; }, ({ reader }) => { reader.operations[2].state = "pending"; },
    ({ reader }) => { reader.operations.push({ ...reader.operations[2] }); },
    ({ reader }) => { reader.operations[0].state = "rejected"; },
    ({ reader }) => { reader.operations[1].settled = reader.unlockInvoked + 1; },
  ];
  for (const [index, change] of changes.entries()) {
    const f = await xiaomiWorkerOutcomeFixture(undefined, change);
    assert.equal(xiaomiWorkerReaderDisposition(f.selection, f.record), false, `counterfactual ${index}`);
    await assert.rejects(f.proof.join(f.selection), error => error instanceof AggregateError && error.errors.includes(undefined));
  }
});
async function xiaomiProviderErrorFixture(change = () => {}, id = "c_provider_error") {
  class ControlledAPIError extends Error {
    constructor() { super("Synthetic rejection"); this.status = undefined; this.code = "synthetic"; this.error = { code: "synthetic", message: "Synthetic rejection" }; }
  }
  const caller = new AbortController(), sdk = new AbortController(), reason = {}, faults = [], read = Promise.withResolvers(), closed = Promise.withResolvers();
  const invocation = { id, control: id === "c_provider_error", bodyPassed: true, resultErrorEmpty: true, caller: xiaomiSignal(caller.signal, () => 1), acquisitions: [] };
  let current = invocation;
  const errors = xiaomiSdkErrorWitness(() => current, nodeTypes.isProxy, ControlledAPIError.prototype,
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get, Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason").get, error => faults.push(error));
  invocation.sdkErrors = errors;
  const f = xiaomiInertReader({ closed: closed.promise, read: () => read.promise, cancel: () => Promise.reject(reason) });
  const reader = f.proof.readers[0], acquisition = { invocation, bound: true, accepted: true, state: "fulfilled", guard: { signal: reader.signal },
    guardInput: { signal: sdk.signal }, observation: f.proof, releases: [{ state: "fulfilled" }] };
  invocation.acquisitions.push(acquisition);
  const output = { stopReason: "error", errorMessage: "Synthetic rejection" }, error = new ControlledAPIError();
  const context = { f, reader, invocation, acquisition, errors, output, error, sdk, reason, faults, caller, params: { error, output, signal: caller.signal }, current: value => { current = value; } };
  change(context, "input"); errors.input(acquisition);
  const original = f.reader.read(); sdk.abort(reason); closed.reject(reason); read.reject(reason);
  const cancel = f.reader.cancel(); await Promise.allSettled([original, cancel, closed.promise]); f.reader.releaseLock(); await f.proof.settle();
  change(context, "failure"); errors.failure(context.params); errors.result(invocation, output); change(context, "result");
  return { ...context, selection: { acquisition, control: invocation.control, qualified: !invocation.control } };
}
test("actual SDK failure observer preserves receiver, arguments, original return and falsey failure", () => {
  const start = sdkSource.indexOf('vi.spyOn(transportStream, "failTransportStream").mockImplementation(');
  const begin = sdkSource.indexOf("function", start), end = sdkSource.indexOf("\n  });", begin);
  assert.ok(start > 0 && end > begin);
  const callback = stripTypeScriptTypes("(" + sdkSource.slice(begin, end) + "\n  })");
  for (const throws of [false, true]) {
    const faults = [], returned = Promise.resolve(), receiver = {}, params = {}, args = [params, {}]; let calls = 0;
    const errors = xiaomiSdkErrorWitness(() => { throw undefined; }, nodeTypes.isProxy, Error.prototype, () => false, () => undefined, error => faults.push(error));
    const original = function(...actual) { calls++; assert.equal(this, receiver); assert.deepEqual(actual, args); if (throws) throw undefined; return returned; };
    const invoke = new Function("planSdkErrors", "originalSdkFailure", "return (" + callback + ");")(errors, original);
    if (throws) { let caught = false; try { invoke.apply(receiver, args); } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true); }
    else assert.equal(invoke.apply(receiver, args), returned);
    assert.equal(calls, 1); assert.deepEqual(faults, [undefined]);
  }
});
test("SDK controlled provider error binds its original output, acquisition signal and three rejected originals", async () => {
  for (const id of ["c_provider_error", "n_embedded"]) {
    const f = await xiaomiProviderErrorFixture(() => {}, id);
    assert.equal(xiaomiSdkProviderErrorDisposition(f.selection, f.reader), true);
    await f.f.proof.join(f.selection); await xiaomiSealReaderObservations([f.f.proof]);
    assert.equal(f.reader.closedState, "rejected"); assert.equal(f.reader.closedReason, f.reason);
    assert.deepEqual(f.reader.operations.map(row => row.state), ["rejected", "rejected"]);
    assert.deepEqual(f.faults, []);
  }
});
test("SDK provider-error witness refuses arbitrary errors, foreign signals, changed outputs and independent failures", async () => {
  const changes = [
    ["input", f => { Object.defineProperty(f.acquisition.guardInput, "signal", { get() { throw new Error("must not read"); } }); }],
    ["input", f => { f.acquisition.guardInput = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("must not inspect"); } }); }],
    ["input", f => { f.acquisition.guardInput.signal = {}; }],
    ["failure", f => { f.acquisition.guardInput.signal = new AbortController().signal; }],
    ["failure", f => { f.current({ id: "foreign" }); }],
    ["failure", f => { f.params.signal = new AbortController().signal; }],
    ["failure", f => { f.params.error = new Error("Synthetic rejection"); }],
    ["failure", f => { f.error.code = "unrelated"; }], ["failure", f => { f.error.message = "unrelated"; }],
    ["failure", f => { f.error.error.extra = true; }],
    ["failure", f => { Object.defineProperty(f.error, "code", { get() { throw new Error("must not read"); } }); }],
    ["failure", f => { f.params.output = { ...f.output }; }],
    ["result", f => { f.errors.result(f.invocation, f.output); }], ["result", f => { f.errors.failure(f.params); }],
    ["result", f => { f.caller.abort(f.reason); }], ["result", f => { f.output.errorMessage = "unrelated"; }],
    ["result", f => { f.acquisition.releases[0].state = "rejected"; }],
    ["result", f => { f.acquisition.bound = false; }], ["result", f => { f.invocation.acquisitions.push(f.acquisition); }],
    ["result", f => { f.reader.faults.push(undefined); }], ["result", f => { f.reader.unlockReturns = 0; }],
    ["result", f => { f.reader.operations[0].reason = undefined; }],
    ["result", f => { f.reader.operations[1].operandDefined = true; f.reader.operations[1].operands = [{}]; }],
    ["result", f => { f.reader.originalClosed = { pending: Promise.resolve(), result: { status: "rejected", reason: f.reason } }; }],
  ];
  for (const [index, [phase, mutate]] of changes.entries()) {
    const f = await xiaomiProviderErrorFixture((value, at) => { if (at === phase) mutate(value); });
    assert.equal(xiaomiSdkProviderErrorDisposition(f.selection, f.reader), false, `counterfactual ${index}`);
    await assert.rejects(f.f.proof.join(f.selection), error => error instanceof AggregateError && error.errors.includes(f.reason));
  }
});
test("actual Xiaomi denial and rotation attempts retain zero-cost usage without upstream dispatch", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xiaomi-denial-accounting-")); let mf; const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { requestContext: true });
    const origin = String(await mf.ready).replace(/\/$/, "");
    await provisionPlans(await mf.getKVNamespace("POLICY_KV", "router"));
    const grants = await fetch(origin + "/fixture/grants", { method: "POST" }); await grants.arrayBuffer(); assert.equal(grants.status, 204);
    const cases = [["invalid_proxy",401,null],["foreign_policy",403,"denied"],["foreign_model",403,"denied"],
      ["retired_pro",400,null],["retired",400,null],["missing",503,"provider_error"],["invalid_grant",503,"provider_error"],["capacity",402,"denied"]];
    const observed = [];
    const send = async row => {
      const response = await fetch(origin + `/v1/native/${row.provider}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${row.id}-${row.kind === "invalid_proxy" ? "invalid" : "fixture-secret"}`, "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, stream: true, max_tokens: 128, thinking: { type: "enabled" }, reasoning_effort: "high",
          messages: [{ role: "assistant", reasoning_content: "synthetic-plan-thinking", tool_calls: [{ id: "planlookup", type: "function", function: { name: "lookup", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "planlookup", content: "synthetic-plan-result" }] }) });
      await response.arrayBuffer(); return response.status;
    };
    const usage = async (row, expected) => {
      let value;
      for (let attempt = 0; attempt < 150; attempt++) {
        const response = await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-xiaomi_plan_${row.id}-fixture-secret` } });
        assert.equal(response.status, 200); value = await response.json(); if (value.usage.events.length === expected) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return value;
    };
    for (const [kind, status, outcome] of cases) {
      const row = planRows.find(value => value.kind === kind); assert.equal(await send(row), status, kind);
      const actual = await usage(row, outcome === null ? 0 : 1); assert.equal(actual.usage.events.length, outcome === null ? 0 : 1, kind);
      assert.equal(actual.budget.spentMicros, 0, kind);
      for (const event of actual.usage.events) {
        assert.equal(event.status, outcome, kind); assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0); assert.equal(event.cost_basis, "none");
        assert.equal(event.credential_id, `xiaomi_plan_${row.id}`); assert.equal(event.provider, row.provider); assert.equal(event.model, `${row.provider}/${row.model}`);
        assert.deepEqual([event.input_tokens,event.output_tokens,event.total_tokens,event.cached_input_tokens],[null,null,null,null]);
      }
      observed.push({ id: row.id, status, events: actual.usage.events.length, outcome, spent: actual.budget.spentMicros });
    }
    const row = planRows.find(value => value.kind === "rotation");
    for (const [index, [action, status]] of [["valid",200],["invalid",503],["rotated",200],["revoked",503]].entries()) {
      const control = await fetch(origin + `/fixture/plan/${row.id}/${action}`, { method: "POST" }); await control.arrayBuffer(); assert.equal(control.status,204);
      assert.equal(await send(row), status, action); const actual = await usage(row, index + 1);
      assert.equal(actual.usage.events.length,index+1); assert.equal(actual.budget.spentMicros,index < 2 ? 7 : 14);
      const success = actual.usage.events.filter(event=>event.status === "success"), denied = actual.usage.events.filter(event=>event.status === "provider_error");
      assert.equal(success.length,index < 2 ? 1 : 2); assert.equal(denied.length,index===0?0:index<3?1:2);
      for (const event of denied) { assert.equal(event.actual_cost_micros,0); assert.equal(event.reserved_cost_micros,0); assert.equal(event.cost_basis,"none"); }
      observed.push({ id: row.id, action, status, events: actual.usage.events.length, denied: denied.length, spent: actual.budget.spentMicros });
    }
    const upstream = await mf.getWorker("upstream"), state = await upstream.fetch("https://fixture.example/state"), calls = await state.json();
    assert.equal(state.status,200); assert.equal(calls.length,2); assert.ok(calls.every(call=>call.planId===row.id&&call.sourceJoined));
    const retired = await fetch(origin+"/fixture/retire?seal=1",{method:"POST"}); const physical = await retired.json(); assert.equal(retired.status,200);
    await assertPlanOracles(origin, calls, physical, () => {}, [...cases.map(([kind]) => planRows.find(value => value.kind === kind)), row]);
    t.diagnostic(JSON.stringify(observed));
  } catch (error) { failures.push(error); }
  try { await mf?.dispose(); } catch (error) { failures.push(error); }
  try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length===1) throw failures[0]; if (failures.length) throw new AggregateError(failures,"Xiaomi denial accounting or cleanup failed");
});
test("actual Xiaomi usage oracle rejects missing denial events, unexpected status and nonzero billing", async () => {
  const row = planRows.find(value => value.kind === "missing");
  const evaluate = new Function("assert", "fetch", "planRows", "return " + assertPlanOracles.toString());
  for (const mutate of [null, value => { value.usage.events = []; }, value => { value.usage.events.push({ ...value.usage.events[0] }); },
    value => { value.usage.events[0].status = "success"; }, value => { value.usage.events[0].actual_cost_micros = 7; },
    value => { value.usage.events[0].reserved_cost_micros = 7; }, value => { value.usage.events[0].cost_basis = "policy_fixed"; },
    value => { value.usage.events[0].input_tokens = 1; }, value => { value.budget.spentMicros = 1; }]) {
    const value = { usage: { events: [{ provider: row.provider, model: `${row.provider}/${row.model}`, credential_id: `xiaomi_plan_${row.id}`,
      status: "provider_error", actual_cost_micros: 0, reserved_cost_micros: 0, cost_basis: "none", input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null }] }, budget: { spentMicros: 0 } };
    mutate?.(value);
    const actual = evaluate(assert, async () => ({ json: async () => value }), [row]);
    const pending = actual("https://fixture.example", [], { budgets: [], materializations: [] }, () => {});
    if (mutate) await assert.rejects(pending, AggregateError); else await pending;
  }
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

// Synthetic controls exercise the actual observer/classifier only. They never
// set the SDK fixture's genuine-native qualification set.
async function sdkDispositionFixture(variant = "stored") {
  let sequence = 0; const tick = () => ++sequence, caller = new AbortController(), guard = new AbortController();
  const reason = new Error("synthetic owned abort"), foreign = new Error("synthetic owned abort");
  if (variant === "initial_abort") { caller.abort(reason); guard.abort(reason); }
  let source; const body = new ReadableStream({ start(controller) { source = controller; controller.enqueue(new Uint8Array([1])); },
    cancel() { if (variant === "underlying_cancel") return Promise.reject(foreign); } });
  const invocation = { id: "c_cancel", control: true, bodyPassed: true, resultAborted: true, caller: xiaomiSignal(caller.signal, tick), acquisitions: [] };
  const acquisition = { invocation, bound: true, accepted: true, state: "fulfilled", guard: xiaomiSignal(guard.signal, tick), releases: [] };
  invocation.acquisitions.push(acquisition);
  const observation = xiaomiObserveBody(body, guard.signal, originalMethodInstall, () => {}, tick); acquisition.observation = observation;
  const reader = body.getReader(); await reader.read(); invocation.partialReader = observation.readers[0]; invocation.partial = tick();
  const pending = reader.read(); void pending.catch(() => {});
  if (variant === "prior_error") { source.error(foreign); await Promise.allSettled([pending]); }
  if (variant !== "late_caller") caller.abort(reason);
  if (variant !== "late_guard") guard.abort(reason);
  if (!["underlying_cancel", "fulfilled", "prior_error"].includes(variant)) source.error(variant === "undefined" ? undefined : variant === "foreign" ? foreign : reason);
  if (variant === "late_guard" || variant === "late_caller") await Promise.allSettled([pending]);
  if (variant === "late_guard") guard.abort(reason);
  if (variant === "late_caller") caller.abort(reason);
  const canceled = reader.cancel(reason); if (variant !== "callbacks_after_unlock") await Promise.allSettled([pending, canceled]);
  const release = { invoked: tick(), state: "pending" }; acquisition.releases.push(release);
  const originalRelease = variant === "release_error" ? Promise.reject(undefined) : Promise.resolve();
  await originalRelease.then(() => { release.state = "fulfilled"; }, error => { release.state = "rejected"; release.reason = error; });
  if (variant === "unlock_error") assert.throws(() => reader.releaseLock.call({}));
  reader.releaseLock(); await Promise.allSettled([pending, canceled]); await observation.settle();
  if (variant === "wrong_reader") invocation.partialReader = {};
  if (variant === "wrong_signal") acquisition.guard.signal = new AbortController().signal;
  if (variant === "wrong_request") acquisition.bound = false;
  if (variant === "duplicate_request") invocation.acquisitions.push({});
  const selection = { acquisition, control: true };
  return { invocation, acquisition, observation, reader, selection, reason, foreign, detach() { invocation.caller.detach(); acquisition.guard.detach(); } };
}
test("SDK disposition remains disabled by default and preserves original stored-error identities after unlock", async () => {
  const state = await sdkDispositionFixture();
  try {
    assert.equal(xiaomiSdkReaderDisposition(undefined, state.observation.readers[0]), false);
    assert.equal(xiaomiSdkReaderDisposition({ acquisition: state.acquisition, qualified: false }, state.observation.readers[0]), false);
    assert.equal(xiaomiSdkReaderDisposition(state.selection, state.observation.readers[0]), true);
    assert.equal(state.observation.readers[0].closedReason, state.reason);
    assert.ok(state.observation.readers[0].operations.filter(op => op.state === "rejected").every(op => op.reason === state.reason));
    await state.observation.join(state.selection);
  } finally { state.detach(); }
  const delayed = await sdkDispositionFixture("callbacks_after_unlock");
  try { assert.equal(xiaomiSdkReaderDisposition(delayed.selection, delayed.observation.readers[0]), true); await delayed.observation.join(delayed.selection); } finally { delayed.detach(); }
  const strict = await sdkDispositionFixture();
  try { await assert.rejects(strict.observation.join(), error => error.errors.includes(strict.reason)); } finally { strict.detach(); }
});
for (const variant of ["prior_error", "foreign", "undefined", "wrong_reader", "wrong_request", "wrong_signal", "duplicate_request", "initial_abort", "late_guard", "late_caller", "underlying_cancel", "release_error", "unlock_error"]) {
  test(`SDK disposition rejects ${variant} using the actual original reader observer`, async () => {
    const state = await sdkDispositionFixture(variant);
    try {
      assert.equal(xiaomiSdkReaderDisposition(state.selection, state.observation.readers[0]), false);
      await assert.rejects(state.observation.join(state.selection));
    } finally { state.detach(); }
  });
}
test("fulfilled SDK cancellation stays fulfilled and native qualification rejects expiry or missing ownership", async () => {
  const state = await sdkDispositionFixture("fulfilled");
  try {
    assert.equal(xiaomiSdkReaderDisposition(state.selection, state.observation.readers[0]), true); await state.observation.join(state.selection);
    state.invocation.witness = { joined: true, expired: false, sourceJoined: true, requests: 1, inputs: 1, calls: 1, reserves: 1, canceled: true };
    assert.equal(xiaomiNativeControlQualified(state.invocation), true);
    state.invocation.witness.expired = true; assert.equal(xiaomiNativeControlQualified(state.invocation), false);
    state.invocation.witness.expired = false; state.invocation.witness.calls = 2; assert.equal(xiaomiNativeControlQualified(state.invocation), false);
    state.invocation.witness.calls = 1; state.invocation.bodyPassed = false; assert.equal(xiaomiNativeControlQualified(state.invocation), false);
  } finally { state.detach(); }
});
test("failed acquisition owes no returned-resource release but requires source-qualified pre-abort evidence", () => {
  let sequence = 0; const tick = () => ++sequence, caller = new AbortController(), reason = new Error("synthetic public abort"); caller.abort(reason);
  const invocation = { id: "c_preabort", control: true, bodyPassed: true, resultErrorEmpty: true, publicAbortMatched: xiaomiPublicAbortResult({ stopReason: "error", content: [], errorMessage: reason.message }, reason, nodeTypes.isProxy), caller: xiaomiSignal(caller.signal, tick), acquisitions: [],
    witness: { joined: true, requests: 0, inputs: 0, calls: 0, reserves: 0, expired: false, sourceJoined: true } };
  const acquisition = { invocation, bound: true, state: "rejected", reasonPresent: true, reason, guard: xiaomiSignal(caller.signal, tick) }; invocation.acquisitions.push(acquisition);
  const selected = { invocation, control: true };
  try {
    assert.equal(xiaomiSdkPreabortDisposition(selected, acquisition), true); assert.equal(xiaomiNativeControlQualified(invocation), true);
    assert.equal(xiaomiSdkPreabortDisposition({ invocation, qualified: false }, acquisition), false);
    for (const value of [undefined, {}]) { acquisition.reason = value; assert.equal(xiaomiSdkPreabortDisposition(selected, acquisition), false); }
    acquisition.reason = reason; acquisition.state = "sync_throw"; assert.equal(xiaomiSdkPreabortDisposition(selected, acquisition), false);
    acquisition.state = "rejected"; invocation.witness.inputs = 1; assert.equal(xiaomiSdkPreabortDisposition(selected, acquisition), false);
    invocation.witness.inputs = 0; invocation.resultErrorEmpty = false; assert.equal(xiaomiSdkPreabortDisposition(selected, acquisition), false);
  } finally { invocation.caller.detach(); acquisition.guard.detach(); }
});
test("pending original SDK read keeps physical join pending without a passing deadline or forced unlock", async () => {
  let source; const body = new ReadableStream({ start(controller) { source = controller; } });
  const observer = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {}), reader = body.getReader();
  const read = reader.read(); let settled = false; const physical = observer.settle().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  source.close(); await read; reader.releaseLock(); await physical; await observer.join();
});

test("bounded control reads preserve overflow plus original undefined cancellation failure", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64 * 768 + 129)); }, cancel() { return Promise.reject(undefined); } });
  await assert.rejects(readDiagnostics("https://fixture.example", async () => new Response(body)), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] instanceof Error && error.errors[1] === undefined);
  assert.equal(body.locked, false);
});

test("public pre-abort requires the original error even when no guard resource exists", () => {
  const reason = new Error("owned pre-abort"), caller = new AbortController(); caller.abort(reason);
  const result = { stopReason: "error", content: [], errorMessage: reason.message };
  assert.equal(xiaomiPublicAbortResult(result, reason, nodeTypes.isProxy), true);
  let called = 0; const getter = Object.defineProperty({}, "message", { get() { called++; return reason.message; } });
  for (const invalid of [{ ...result, errorMessage: "foreign" }, { ...result, content: ["partial"] }, { ...result, stopReason: "stop" }]) assert.equal(xiaomiPublicAbortResult(invalid, reason, nodeTypes.isProxy), false);
  assert.equal(xiaomiPublicAbortResult(result, getter, nodeTypes.isProxy), false); assert.equal(called, 0);
  assert.equal(xiaomiPublicAbortResult(result, new Proxy(reason, { getOwnPropertyDescriptor() { throw undefined; } }), nodeTypes.isProxy), false);
  assert.equal(xiaomiPublicAbortResult(result, undefined, nodeTypes.isProxy), false);
  const invocation = { id: "n_preabort", bodyPassed: true, resultErrorEmpty: true, publicAbortMatched: false, caller: xiaomiSignal(caller.signal, () => 1), acquisitions: [],
    witness: { joined: true, requests: 0, inputs: 0, calls: 0, reserves: 0 } };
  try { assert.equal(xiaomiSdkPreabortDisposition({ invocation, qualified: true }), false); invocation.publicAbortMatched = true; assert.equal(xiaomiSdkPreabortDisposition({ invocation, qualified: true }), true); }
  finally { invocation.caller.detach(); }
});
test("original synchronous cancel throw is preserved and cannot qualify as a rejected cancellation promise", async () => {
  let source; const body = new ReadableStream({ start(controller) { source = controller; } });
  const originalGetReader = body.getReader;
  body.getReader = function(...args) { const reader = Reflect.apply(originalGetReader, this, args); reader.cancel = function() { throw undefined; }; return reader; };
  const observed = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {}), reader = body.getReader();
  let threw = false; try { reader.cancel(); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true); source.close(); reader.releaseLock();
  await assert.rejects(observed.join(), error => error.errors.includes(undefined));
  assert.equal(observed.readers[0].operations[0].state, "sync_throw"); assert.equal(observed.readers[0].operations[0].pending, undefined);
});

test("passive witnesses whitelist public stop reasons without invoking getters or proxies", () => {
  for (const [index, stopReason] of ["stop", "length", "toolUse", "error", "aborted"].entries()) assert.equal(xiaomiStopReason({ stopReason }, nodeTypes.isProxy), index + 1);
  let invoked = 0;
  const getter = Object.defineProperty({}, "stopReason", { get() { invoked++; throw undefined; } });
  for (const value of [undefined, null, {}, { stopReason: "private marker" }, getter, new Proxy({}, { getOwnPropertyDescriptor() { invoked++; throw undefined; } })]) assert.equal(xiaomiStopReason(value, nodeTypes.isProxy), 0);
  assert.equal(invoked, 0);
});
test("passive original witnesses retain foreign and undefined failures without identity from absence", async () => {
  for (const variant of ["foreign", "undefined", "callbacks_after_unlock", "release_error", "unlock_error"]) {
    const state = await sdkDispositionFixture(variant);
    try {
      await assert.rejects(state.observation.join());
      const rows = xiaomiReaderWitnesses(diagnostic, "sdk", "c_cancel", 1, state.observation, state.acquisition.releases);
      assert.equal(rows.length, 3); assert.ok(rows.every(row => diagnostic.validate(row)));
      const read = rows.find(row => row.facts.operationKind === 1), cancel = rows.find(row => row.facts.operationKind === 2), physical = rows.find(row => row.phase === "reader_witness");
      assert.equal(read.facts.state, 3); assert.equal(cancel.facts.state, 3);
      assert.equal(physical.facts.joinAccepted, false); assert.equal(physical.facts.bodyLocked, false);
      assert.equal(physical.facts.operations, physical.facts.settledOperations);
      if (variant === "undefined") {
        assert.equal(read.facts.reasonPresent, true); assert.equal(read.facts.reasonDefined, false);
        for (const key of ["sameInvokeReason", "sameRejectReason", "sameClosed", "sameRead", "sameOperand"]) assert.equal(cancel.facts[key], null);
      }
      if (variant === "foreign") assert.equal(cancel.facts.sameInvokeReason, false);
      if (variant === "release_error") assert.equal(physical.facts.allReleasesFulfilled, false);
      if (variant === "unlock_error") assert.equal(physical.facts.unlockCalls, 2);
    } finally { state.detach(); }
  }
});
test("passive witness snapshots do not settle originals, unlock readers, or make pending joins accepted", async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const observer = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {}), reader = body.getReader();
  const pending = reader.read();
  const before = xiaomiReaderWitnesses(diagnostic, "worker", "c_cancel", 26, observer);
  assert.equal(before.length, 1); assert.equal(before[0].facts.closedState, 5); assert.equal(before[0].facts.joinAccepted, null);
  assert.equal(before[0].facts.settledOperations, 0); assert.equal(before[0].facts.bodyLocked, true); assert.equal(before[0].facts.releaseCalls, null);
  assert.equal(observer.readers[0].operations[0].pending, pending);
  controller.close(); await pending; reader.releaseLock(); await observer.join();
  const after = xiaomiReaderWitnesses(diagnostic, "worker", "c_cancel", 26, observer)[0];
  assert.equal(after.facts.closedState, 2); assert.equal(after.facts.joinAccepted, true); assert.equal(after.facts.bodyLocked, false);
});
test("passive synchronous throw witness preserves original receiver, operands and undefined", async () => {
  let controller, receiver, args;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const originalGetReader = body.getReader;
  body.getReader = function(...operands) {
    const reader = Reflect.apply(originalGetReader, this, operands);
    reader.cancel = function(...values) { receiver = this; args = values; throw undefined; };
    return reader;
  };
  const observed = xiaomiObserveBody(body, undefined, originalMethodInstall, () => {}), reader = body.getReader(), operand = {};
  let threw = false; try { reader.cancel(operand); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true); assert.equal(receiver, reader); assert.equal(args[0], operand);
  controller.close(); reader.releaseLock(); await assert.rejects(observed.join(), error => error.errors.includes(undefined));
  const cancel = xiaomiReaderWitnesses(diagnostic, "worker", "c_cancel", 1, observed)[0];
  assert.equal(cancel.facts.state, 4); assert.equal(cancel.facts.reasonPresent, true); assert.equal(cancel.facts.reasonDefined, false); assert.equal(cancel.facts.sameOperand, null);
});
test("passive witness schema is closed and refuses nested getters, proxies and arbitrary fields", async () => {
  const state = await sdkDispositionFixture("fulfilled");
  try {
    await state.observation.join(state.selection);
    const row = xiaomiReaderWitnesses(diagnostic, "sdk", "c_cancel", 1, state.observation, state.acquisition.releases)[0];
    let invoked = 0;
    const getter = { ...row.facts }; Object.defineProperty(getter, "state", { get() { invoked++; return 1; } });
    for (const facts of [{ ...row.facts, secret: "private marker" }, { ...row.facts, state: "fulfilled" }, { ...row.facts, state: -1 }, getter,
      new Proxy(row.facts, { ownKeys() { invoked++; throw undefined; } })]) assert.equal(diagnostic.validate({ ...row, facts }), null);
    assert.equal(invoked, 0);
    let bytes = ""; diagnostic.emit([row], true, text => { bytes += text; });
    assert.doesNotMatch(bytes, /private marker|synthetic owned abort/); assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 768);
  } finally { state.detach(); }
});
test("passive witness emission keeps case and original-operation identities, final snapshots and nine-plus-one bounds", async () => {
  const state = await sdkDispositionFixture("fulfilled");
  try {
    const before = xiaomiReaderWitnesses(diagnostic, "sdk", "c_cancel", 1, state.observation, state.acquisition.releases);
    await state.observation.join(state.selection);
    const after = xiaomiReaderWitnesses(diagnostic, "sdk", "c_cancel", 1, state.observation, state.acquisition.releases);
    const other = after.map(row => ({ ...row, caseId: "n_cancel" }));
    let text = ""; diagnostic.emit([...before, ...other, ...after], true, value => { text += value; });
    const records = text.trim().split("\n").map(line => JSON.parse(line.split("::").at(-1)));
    assert.equal(records.length, 4); assert.equal(records.filter(row => row.caseId === "c_cancel").length, 2);
    assert.equal(records.find(row => row.caseId === "c_cancel" && row.phase === "reader_witness").facts.joinAccepted, true);
    const extra = Array.from({ length: 20 }, (_, i) => ({ ...after[0], facts: { ...after[0].facts, acquisition: i + 2 } }));
    text = ""; diagnostic.emit([...after, ...extra, diagnostic.record("outer", "none", "helper", 2, true, undefined, 0)], true, value => { text += value; });
    const lines = text.trim().split("\n"); assert.equal(lines.length, 10); assert.match(lines[0], /"phase":"helper"/); assert.match(lines[9], /"phase":"overflow"/); assert.ok(Buffer.byteLength(text) <= 8192);
    diagnostic.emit(after, false, () => assert.fail("passing snapshots are not errors"));
    let empty = null; diagnostic.emit([], true, value => { empty = value; }); assert.equal(empty, "");
    const primary = {}, writer = {};
    assert.throws(() => xiaomiRethrow(primary, () => diagnostic.emit(after, true, () => { throw writer; })), error => error.errors[0] === primary && error.errors[1] === writer);
  } finally { state.detach(); }
});

test("passive Worker control relay retains strict original rejection and completed physical witnesses", async () => {
  // This is an in-memory fixture-function regression, not a hosted SDK/workerd receipt.
  const prior = globalThis.fetch, reason = {}, calls = []; let controller;
  const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new Uint8Array([1])); } });
  globalThis.fetch = function(input, init) {
    if (String(input) === "https://fixture.example/state") return Promise.resolve(Response.json([{ planId: "c_cancel", canceled: true, expired: false, sourceJoined: true }]));
    calls.push({ receiver: this, input, init }); return Promise.resolve(new Response(body));
  };
  try {
    const handler = { async fetch() {
      const input = "https://fixture.example/upstream", init = { method: "POST", headers: { "api-key": "tp-fixture-upstream-c_cancel" } };
      const response = await globalThis.fetch(input, init), reader = response.body.getReader();
      await reader.read(); const pending = reader.read(); void pending.catch(() => {}); controller.error(reason);
      const cancel = reader.cancel(); await Promise.allSettled([pending, cancel]); reader.releaseLock();
      assert.equal(calls[0].input, input); assert.equal(calls[0].init, init); assert.equal(calls[0].receiver, globalThis);
      return new Response(null, { status: 200 });
    } };
    const plan = planRouter(handler, () => {}, () => {});
    const ingress = new Request("https://fixture.example/v1/native/xiaomi-token-plan/chat/completions", { method: "POST", headers: { authorization: "Bearer clawrouter-live-xiaomi_plan_c_cancel-fixture-secret" } });
    const response = await plan.fetch(ingress, { GRANT_CREDENTIALS: {}, BUDGET_LEDGER: {} }, { waitUntil() {} }); await response.arrayBuffer();
    const witness = await plan.control(new Request("https://fixture.example/fixture/plan/c_cancel/witness"), {});
    assert.equal(witness.status, 500); assert.equal((await witness.json()).joined, false);
    const records = await (await plan.control(new Request("https://fixture.example/fixture/diagnostics"), {})).json();
    assert.ok(records.every(row => diagnostic.validate(row)));
    const read = records.find(row => row.phase === "operation_witness" && row.facts.operationKind === 1);
    const cancel = records.find(row => row.phase === "operation_witness" && row.facts.operationKind === 2);
    const physical = records.find(row => row.phase === "reader_witness");
    assert.equal(read.facts.reasonDefined, true); assert.equal(cancel.facts.sameRead, true);
    assert.equal(physical.facts.bodyLocked, false); assert.equal(physical.facts.joinAccepted, false);
    assert.equal(physical.facts.operations, physical.facts.settledOperations);
    assert.ok(records.filter(row => ["read", "cancel"].includes(row.phase)).every(row => row.kind === "unknown"));
  } finally { globalThis.fetch = prior; }
});

test("lineage tokens keep concurrent public calls distinct with reused or absent signals and exact original returns", async () => {
  for (const signal of [undefined, new AbortController().signal]) {
    const storage = new AsyncLocalStorage(), owner = xiaomiInvocationOwnership(storage);
    const receiver = {}, guardReceiver = {}, fetchReceiver = {}, rows = [], calls = []; let sequence = 0;
    const pending = [Promise.withResolvers(), Promise.withResolvers()];
    for (let i = 0; i < 2; i++) {
      const invocation = { caller: { signal } }, options = { signal }, args = [{}, {}, options];
      let publicReturn, guardReturn;
      function publicCall(...received) {
        assert.equal(this, receiver); received.forEach((value, index) => assert.equal(value, args[index]));
        publicReturn = Promise.resolve().then(() => {
          assert.equal(owner.currentInvocation(), invocation);
          const acquisition = { invocation, context: { id: "c_cancel" } }; rows.push(acquisition);
          const guardArgs = [{}];
          function guard(...receivedGuard) {
            assert.equal(this, guardReceiver); assert.equal(receivedGuard[0], guardArgs[0]);
            const fetchArgs = ["https://fixture.example/same", { method: "POST", signal }];
            function originalFetch(...receivedFetch) {
              assert.equal(this, fetchReceiver); receivedFetch.forEach((value, index) => assert.equal(value, fetchArgs[index]));
              calls.push(i); return pending[i].promise;
            }
            const original = owner.fetch(originalFetch, fetchReceiver, fetchArgs, signal, () => ++sequence);
            assert.equal(original, pending[i].promise);
            guardReturn = original.then(response => ({ response, release: () => Promise.resolve() })); return guardReturn;
          }
          const returned = owner.guard(guard, guardReceiver, guardArgs, acquisition);
          assert.equal(returned, guardReturn);
          return returned.then(result => { assert.equal(owner.attach(acquisition, result), true); return result; });
        });
        return publicReturn;
      }
      const returned = owner.invoke(invocation, publicCall, receiver, args);
      assert.equal(returned, publicReturn); invocation.returned = returned; rows.push(invocation);
    }
    await Promise.resolve(); assert.deepEqual(calls, [0, 1]); assert.equal(owner.currentInvocation(), undefined);
    pending[1].resolve(new Response("second")); pending[0].resolve(new Response("first"));
    const invocations = rows.filter(row => row.caller), acquisitions = rows.filter(row => row.invocation);
    const results = await Promise.all(invocations.map(row => row.returned));
    assert.notEqual(invocations[0].token, invocations[1].token);
    for (const row of acquisitions) { assert.equal(row.context.id, "c_cancel"); assert.equal(owner.bound(row), true); }
    for (const result of results) {
      const originalBody = result.response.body, reader = originalBody.getReader();
      await reader.read(); await reader.read(); reader.releaseLock(); await result.release();
      assert.equal(result.response.body, originalBody); assert.equal(originalBody.locked, false);
    }
    assert.deepEqual(await owner.join(), []); owner.restore(); assert.equal(owner.bound(acquisitions[0]), false);
  }
});

test("lineage missing or detached guard context never borrows a concurrent matching request", async () => {
  for (const detached of [false, true]) {
    const storage = new AsyncLocalStorage(), owner = xiaomiInvocationOwnership(storage), invocation = { caller: { signal: undefined } };
    const row = { invocation }; let sequence = 0, original;
    function fetch() { original = Promise.resolve(new Response(null)); return original; }
    function guard() {
      const call = () => owner.fetch(fetch, undefined, ["https://fixture.example/same", { method: "POST" }], undefined, () => ++sequence);
      const result = detached ? storage.exit(call) : call(); assert.equal(result, original); return result.then(response => ({ response }));
    }
    const actual = detached
      ? owner.invoke(invocation, () => owner.guard(guard, undefined, [], row), undefined, [{}, {}, {}])
      : owner.guard(guard, undefined, [], row);
    const result = await actual;
    assert.equal(owner.attach(row, result), false); assert.equal(owner.bound(row), false);
    assert.ok((await owner.join()).length > 0); owner.restore();
  }
});

test("lineage rejects ambiguous original responses, changed bodies and missing runtime-hook observations", async () => {
  for (const variant of ["shared-response", "shared-body", "changed-response", "missing-fetch"]) {
    const owner = xiaomiInvocationOwnership(new AsyncLocalStorage()); let sequence = 0;
    const original = new Response(null), body = new ReadableStream({ start(c) { c.close(); } }), rows = [];
    for (let i = 0; i < 2; i++) {
      const invocation = { caller: { signal: undefined } }, row = { invocation }; rows.push(row);
      const actual = await owner.invoke(invocation, () => owner.guard(() => {
        const response = variant === "shared-body" ? new Response(body) : original;
        const returned = variant === "missing-fetch" ? Promise.resolve(response)
          : owner.fetch(() => Promise.resolve(response), undefined, [], undefined, () => ++sequence);
        return returned.then(value => ({ response: variant === "changed-response" ? new Response(null) : value }));
      }, undefined, [], row), undefined, [{}, {}, {}]);
      owner.attach(row, actual);
    }
    assert.ok(rows.every(row => !owner.bound(row))); assert.ok((await owner.join()).length > 0); owner.restore();
  }
});

test("lineage original pending fetch keeps its join pending and preserves undefined throws and rejections", async () => {
  for (const state of ["pending", "sync_throw", "rejected"]) {
    const owner = xiaomiInvocationOwnership(new AsyncLocalStorage()), invocation = { caller: { signal: undefined } }, row = { invocation };
    const deferred = Promise.withResolvers(); let sequence = 0, nativeReturn;
    const call = () => owner.invoke(invocation, () => owner.guard(() => {
      function fetch() { if (state === "sync_throw") throw undefined; nativeReturn = deferred.promise; return nativeReturn; }
      const returned = owner.fetch(fetch, undefined, [], undefined, () => ++sequence); assert.equal(returned, nativeReturn); return returned;
    }, undefined, [], row), undefined, [{}, {}, {}]);
    if (state === "sync_throw") {
      let thrown = false; try { call(); } catch (error) { thrown = true; assert.equal(error, undefined); }
      assert.equal(thrown, true); assert.deepEqual(await owner.join(), [undefined]);
    } else {
      const returned = call(); let settled = false;
      const joined = owner.join().then(value => { settled = true; return value; });
      await Promise.resolve(); assert.equal(settled, false); assert.equal(returned, deferred.promise);
      if (state === "rejected") { deferred.reject(undefined); await assert.rejects(returned, error => error === undefined); assert.deepEqual(await joined, [undefined]); }
      else { deferred.resolve(new Response(null)); const response = await returned; assert.equal(owner.attach(row, { response }), true); assert.deepEqual(await joined, []); }
    }
    owner.restore();
  }
});

test("lineage observer failure does not replace the original fetch promise or synchronous public throw", async () => {
  const owner = xiaomiInvocationOwnership(new AsyncLocalStorage()), invocation = { caller: { signal: undefined } }, row = { invocation };
  const fault = {}, response = Object.defineProperty({}, "body", { get() { throw fault; } });
  const original = Promise.resolve(response); let sequence = 0;
  const returned = owner.invoke(invocation, () => owner.guard(() => owner.fetch(() => original, undefined, [], undefined, () => ++sequence), undefined, [], row), undefined, [{}, {}, {}]);
  assert.equal(returned, original); assert.equal(await returned, response); assert.deepEqual(await owner.join(), [fault]); owner.restore();
  for (const stage of ["public", "guard"]) {
    const next = xiaomiInvocationOwnership(new AsyncLocalStorage()), call = { caller: { signal: undefined } }; let thrown = false;
    try { next.invoke(call, () => { if (stage === "public") throw undefined; return next.guard(() => { throw undefined; }, undefined, [], { invocation: call }); }, undefined, [{}, {}, {}]); }
    catch (error) { thrown = true; assert.equal(error, undefined); }
    assert.equal(thrown, true); next.restore();
  }
});

test("lineage refuses reused invocation tokens and foreign acquisition ownership without changing dispatch", async () => {
  const owner = xiaomiInvocationOwnership(new AsyncLocalStorage()), first = { caller: { signal: undefined } }, foreign = { caller: { signal: undefined } };
  let calls = 0;
  const fn = () => { calls++; return calls; };
  assert.equal(owner.invoke(first, fn, undefined, [{}, {}, {}]), 1);
  assert.equal(owner.invoke(first, fn, undefined, [{}, {}, {}]), 2);
  assert.equal(owner.invoke(foreign, () => owner.guard(fn, undefined, [], { invocation: first }), undefined, [{}, {}, {}]), 3);
  assert.equal(calls, 3); assert.equal((await owner.join()).length, 2); owner.restore();
});

test("lineage runtime-hook restoration preserves exact prior descriptors and refuses foreign replacement", () => {
  let getterCalls = 0; const object = {}, previous = { configurable: true, enumerable: true, get() { getterCalls++; return {}; } };
  Object.defineProperty(object, "runtime", previous); const before = Object.getOwnPropertyDescriptor(object, "runtime"), ours = {};
  const restore = xiaomiInstallProperty(object, "runtime", ours); assert.equal(object.runtime, ours); restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(object, "runtime"), before); assert.equal(getterCalls, 0); assert.throws(restore);
  const absent = {}, undo = xiaomiInstallProperty(absent, "runtime", ours); undo(); assert.equal(Object.hasOwn(absent, "runtime"), false);
  const guarded = {}, finish = xiaomiInstallProperty(guarded, "runtime", ours), other = {};
  guarded.runtime = other; assert.throws(finish); assert.equal(guarded.runtime, other);
  const fixed = Object.defineProperty({}, "runtime", { value: ours, configurable: false });
  assert.throws(() => xiaomiInstallProperty(fixed, "runtime", other)); assert.equal(fixed.runtime, ours);
});

test("lineage observes separate caller, guard-input and fetch-input controllers without inferring propagation", async () => {
  const owner = xiaomiInvocationOwnership(new AsyncLocalStorage()), caller = new AbortController(), guard = new AbortController(), fetch = new AbortController();
  let sequence = 0; const tick = () => ++sequence;
  const invocation = { caller: xiaomiSignal(caller.signal, tick) }, row = { invocation, guard: xiaomiSignal(guard.signal, tick) };
  const result = await owner.invoke(invocation, () => owner.guard(() => owner.fetch(() => Promise.resolve(new Response(null)), undefined, [], fetch.signal, tick).then(response => ({ response })), undefined, [], row), undefined, [{}, {}, { signal: caller.signal }]);
  assert.equal(owner.attach(row, result), true);
  caller.abort({}); assert.equal(guard.signal.aborted, false); assert.equal(fetch.signal.aborted, false);
  guard.abort({}); fetch.abort({});
  assert.ok(invocation.caller.event < row.guard.event); assert.ok(row.guard.event < row.transport.signalTrace.event);
  assert.notEqual(row.transport.signalTrace.reason, row.guard.reason); assert.notEqual(row.guard.reason, invocation.caller.reason);
  assert.equal(owner.bound(row), true); assert.deepEqual(await owner.join(), []);
  invocation.caller.detach(); row.guard.detach(); owner.restore();
});


// Exact pinned generation scope; the frame seam is inert and the ALS is native.
const xiaomiGenerationScopeSource = "// Keep retained registry reads independent of metadata discovery and plugin loading.\nimport {\n  getPluginExecutionFrame,\n  runWithPluginExecutionFrame,\n} from \"../plugin-instance-invocation.js\";\nimport type { PluginRegistry } from \"../registry-types.js\";\nimport { getPluginRuntimeExecutionFrame, PluginRuntimeExecutionFrame } from \"./execution-frame.js\";\n\nexport function withPluginRuntimeGenerationRegistryScope<T>(\n  registry: PluginRegistry,\n  run: () => T,\n): T {\n  const current = getPluginExecutionFrame();\n  return runWithPluginExecutionFrame(\n    new PluginRuntimeExecutionFrame(\n      current ?? {},\n      getPluginRuntimeExecutionFrame(current)?.gatewayScope,\n      registry,\n    ),\n    run,\n  );\n}\n\n/** Exact registry owned by the prepared generation, including empty selections. */\nexport function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {\n  return getPluginRuntimeExecutionFrame()?.generationRegistry;\n}\n\nexport function runOutsidePluginRuntimeGenerationRegistryScope<T>(run: () => T): T {\n  const current = getPluginExecutionFrame();\n  return runWithPluginExecutionFrame(\n    new PluginRuntimeExecutionFrame(\n      current ?? {},\n      getPluginRuntimeExecutionFrame(current)?.gatewayScope,\n      undefined,\n    ),\n    run,\n  );\n}\n";
test("Xiaomi actual replay callbacks retain PAYG and token-plan providers across regional routing", async () => {
  assert.equal(createHash("sha256").update(xiaomiGenerationScopeSource).digest("hex"), "dd545702892c9c350b6717ebcf3e6df3596b96ff37e0014f01838ecd4442a2a4");
  const storage = new AsyncLocalStorage();
  class Frame {
    constructor(scopes, gatewayScope, generationRegistry) { Object.assign(this, scopes); this.gatewayScope = gatewayScope; this.generationRegistry = generationRegistry; }
  }
  const code = stripTypeScriptTypes(xiaomiGenerationScopeSource);
  const scope = new Function("getPluginExecutionFrame", "runWithPluginExecutionFrame", "getPluginRuntimeExecutionFrame", "PluginRuntimeExecutionFrame",
    code.slice(code.indexOf("export function withPluginRuntimeGenerationRegistryScope")).replaceAll("export ", "") +
    "; return { withPluginRuntimeGenerationRegistryScope, getPluginRuntimeGenerationRegistry };")(
    () => storage.getStore(), (frame, run) => storage.run(frame, run),
    (frame = storage.getStore()) => frame instanceof Frame ? frame : undefined, Frame);
  const transformed = stripTypeScriptTypes(sdkSource);
  const callbacks = new Map();
  for (const label of ["xiaomi-worker", "xiaomi-plan-worker"]) {
    const anchor = `withOpenClawTestState({ label: "${label}" }, async state => {`;
    const start = transformed.indexOf(anchor), end = transformed.indexOf("\n  });", start);
    assert.ok(start >= 0 && end > start);
    const body = transformed.slice(start + anchor.length, end);
    callbacks.set(label, new Function("resolveTranscriptPolicy", "expect", "createEmptyPluginRegistry", "withPluginRuntimeGenerationRegistryScope",
      "sanitizeSessionHistory", "makeInMemorySessionManager", "makeModelSnapshotEntry", "selected", "modelId", "row", "id", "provider", "history",
      "return async state => {" + body + "};"));
  }
  assert.match(sdkSource, /const provider = requireRegisteredProvider\(providers, "xiaomi"\)/);
  assert.match(sdkSource, /const provider = requireRegisteredProvider\(registered.providers, "xiaomi-token-plan"\)/);
  const owned = [];
  const globalProvider = { id: "xiaomi-token-plan", foreign: true };
  const root = new Frame({}, { pluginId: "caller" }, { providers: [{ pluginId: "xiaomi", provider: globalProvider, source: "test" }] });
  for (const failure of [false, true]) for (const reason of [undefined, false, new Error("synthetic")]) {
    await storage.run(root, async () => {
      await Promise.all(["xiaomi", "xiaomi-token-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams"].map(async (route, ordinal) => {
        const provider = { id: route === "xiaomi" ? "xiaomi" : "xiaomi-token-plan" };
        const selected = { provider: provider.id, api: "openai-completions" };
        const row = { id: "case-" + ordinal, provider: route, model: "synthetic-model" };
        const history = [], policy = { dropReasoningFromHistory: false }, result = [];
        let registry, sanitizerCalls = 0;
        const factory = callbacks.get(route === "xiaomi" ? "xiaomi-worker" : "xiaomi-plan-worker");
        const invoke = factory(params => {
          assert.equal(params.runtimeHandle.plugin, provider); assert.equal(params.provider, provider.id); return policy;
        }, value => ({ toBe: expected => assert.equal(value, expected) }),
        () => { registry = { providers: [] }; owned.push(registry); return registry; },
        scope.withPluginRuntimeGenerationRegistryScope, params => {
          sanitizerCalls++;
          assert.equal(scope.getPluginRuntimeGenerationRegistry(), registry);
          assert.deepEqual(registry.providers, [{ pluginId: "xiaomi", provider, source: "test" }]);
          assert.notEqual(registry.providers[0].provider, globalProvider);
          assert.equal(params.provider, provider.id); assert.equal(params.policy, policy); assert.equal(params.messages, history);
          assert.equal(params.model, selected); assert.equal(params.workspaceDir, "/fixture/workspace");
          return Promise.resolve().then(async () => {
            assert.equal(scope.getPluginRuntimeGenerationRegistry(), registry);
            const nested = { providers: [] };
            await scope.withPluginRuntimeGenerationRegistryScope(nested, async () => {
              await Promise.resolve(); assert.equal(scope.getPluginRuntimeGenerationRegistry(), nested);
              assert.deepEqual(scope.getPluginRuntimeGenerationRegistry().providers, [], "empty owned generation cannot borrow the caller's provider");
            });
            assert.equal(scope.getPluginRuntimeGenerationRegistry(), registry);
            if (failure) throw reason;
            return result;
          });
        }, entries => ({ entries }), value => value, selected, row.model, row, row.id, provider, history);
        let caught = false, actual;
        try { actual = await invoke({ workspaceDir: "/fixture/workspace" }); } catch (error) { caught = true; actual = error; }
        assert.equal(caught, failure); assert.equal(actual, failure ? reason : result); assert.equal(sanitizerCalls, 1);
        assert.equal(storage.getStore(), root);
      }));
      for (const providers of [[], [{ pluginId: "foreign", provider: { id: "foreign" }, source: "test" }]]) {
        await scope.withPluginRuntimeGenerationRegistryScope({ providers }, async () => {
          await Promise.resolve();
          assert.equal(scope.getPluginRuntimeGenerationRegistry().providers, providers);
          assert.equal(providers.find(row => row.provider.id === globalProvider.id), undefined);
        });
        assert.equal(storage.getStore(), root);
      }
    });
  }
  assert.equal(new Set(owned).size, owned.length); assert.equal(storage.getStore(), undefined);
});
