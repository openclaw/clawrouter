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
const { xiaomiPlanCases, xiaomiNativeControls, xiaomiInvocationOwnership, xiaomiInstallProperty, xiaomiStopReason, xiaomiState, xiaomiReaderWitnesses, xiaomiSignal, xiaomiSdkReaderDisposition, xiaomiSdkPreabortDisposition, xiaomiPublicAbortResult, xiaomiNativeControlQualified, xiaomiDiagnostic, xiaomiObserveBody, xiaomiSealReaderObservations, xiaomiRethrow, xiaomiConsumeControlWitness, xiaomiControlQualification } = new Function(proofCode + ";return { xiaomiPlanCases, xiaomiNativeControls, xiaomiInvocationOwnership, xiaomiInstallProperty, xiaomiStopReason, xiaomiState, xiaomiReaderWitnesses, xiaomiSignal, xiaomiSdkReaderDisposition, xiaomiSdkPreabortDisposition, xiaomiPublicAbortResult, xiaomiNativeControlQualified, xiaomiDiagnostic, xiaomiObserveBody, xiaomiSealReaderObservations, xiaomiRethrow, xiaomiConsumeControlWitness, xiaomiControlQualification };")();
const planRows = xiaomiPlanCases(), allPlanRows = [...xiaomiNativeControls(), ...planRows], diagnostic = xiaomiDiagnostic(nodeTypes.isProxy);
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
function xiaomiRunnerReport() {
  let reported = false, summary;
  const options = {
    expectedInvocations: 1,
    fixtureSha256: "fac698a1a299b210cdbae25b1035d291babd96550f958bad53ed7bff42ed937d",
    reporterSha256: "88a9021f87d47b62c0e120cc6c02bf9c96248ac20bd549595b981d6ef20f0b67",
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
async function assertPlanOracles(origin, calls, physical, report) {
  const failures = [];
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
    } catch (error) { failures.push(error); try { report(row, checkpoint, error); } catch (reportError) { failures.push(reportError); } }
  }
  if (failures.length) throw new AggregateError(failures, "independent Xiaomi oracle failures");
}

// Embedded only in the fixture Worker. Each record owns its original operations.
function planRouter(handler, putGrantCredentials, revokeGrantCredentials) {
  const rows = [...xiaomiNativeControls(), ...xiaomiPlanCases()], diagnostic = xiaomiDiagnostic(), records = diagnostic.store(), inputs = [], requests = [], budgets = [], materializations = [];
  const originalFetch = globalThis.fetch; let retirement, sequence = 0; const tick = () => ++sequence;
  const identify = value => rows.find(row => value === `${row.prefix}-fixture-upstream-${row.id}` || row.kind === "rotation" && value === `ttp-fixture-upstream-${row.id}`);
  globalThis.fetch = function(input, init) {
    const headers = new Headers(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
    const row = identify(headers.get("api-key"));
    const item = { ordinal: inputs.length + 1, observations: [], row, errors: [], state: "invoke", invoked: tick() }; inputs.push(item);
    let returned;
    try { returned = Reflect.apply(originalFetch, this, arguments); item.returned = returned; }
    catch (error) { item.state = "sync_throw"; item.settled = tick(); item.errors.push(error); throw error; }
    void returned.then(response => {
      item.state = "fulfilled"; item.settled = tick();
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
  async function retire() {
    const failures = [];
    for (const request of requests) {
      const result = await Promise.allSettled([request.returned]); failures.push(...result.flatMap(v => v.status === "rejected" ? [v.reason] : []));
      let done = 0; while (done < request.pending.length) { const batch = request.pending.slice(done); done += batch.length; failures.push(...(await Promise.allSettled(batch)).flatMap(v => v.status === "rejected" ? [v.reason] : [])); }
    }
    for (const input of inputs) {
      failures.push(...(await Promise.allSettled([input.returned, ...input.observations.map(value => value.join())])).flatMap(v => v.status === "rejected" ? [v.reason] : []), ...input.errors);
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
        retirement ??= retire();
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
          for (const owned of matchingInputs) {
            failures.push(...(await Promise.allSettled([owned.returned, ...owned.observations.map(value => value.join())])).flatMap(value => value.status === "rejected" ? [value.reason] : []), ...owned.errors);
            snapshotInput(owned, failures);
          }
          // Control I/O is deliberately outside the observed inference fetch. It
          // consumes its actual response before returning only fixed safe facts.
          let calls = [];
          try { const response = await Reflect.apply(originalFetch, globalThis, ["https://fixture.example/state"]); calls = (await response.json()).filter(value => value.planId === id); }
          catch (error) { failures.push(error); }
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
    const call = { planId, turn, url: request.url, method: request.method, authorization: request.headers.get("authorization"), apiKey, xApiKey: request.headers.get("x-api-key"), body, canceled: false, expired: false, sourceJoined: true, completed: false }; calls.push(call);
    if (planId === "n_http" || planId === "n_failover") return Response.json({ error: { message: "Synthetic rejection" } }, { status: planId === "n_http" ? 401 : 429 });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const first = frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-plan-answer" }, finish_reason: null }] });
    const wire = ["n_embedded", "c_provider_error"].includes(planId) ? frame({ error: { code: "synthetic", message: "Synthetic rejection" } }) : first + frame({ id: "chat_plan", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(planId === "n_no_usage" || ["n_cancel", "c_cancel"].includes(planId) ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } }) }) + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(["n_cancel", "c_cancel"].includes(planId) ? first : wire); let offset = 0;
    let timer, timerObserved, timerController, timerState = "absent", timerReason;
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
      async pull(c) {
        if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; return; }
        if (!["n_cancel", "c_cancel"].includes(planId)) { c.close(); call.completed = true; call.sourceJoined = true; return; }
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
      xiaomiSealReaderObservations, qualifiedNativeControls: () => false, xiaomiSdkPreabortDisposition: () => false, xiaomiNativeControlQualified: () => false,
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
      xiaomiControlQualification, async xiaomiSealReaderObservations() { sealed++; },
      planRemember() {}, AbortController: class { signal = {}; }, setTimeout: () => 1, clearTimeout() {}, origin: "https://fixture.invalid",
      async controlFetch() { relays++; throw reporting; },
    };
    const callback = new Function(...Object.keys(bindings), "return (" + callbackSource + ");")(...Object.values(bindings));
    await assert.rejects(callback(), error => error instanceof AggregateError && error.errors.some(e => Object.is(e, original))
      && error.errors.includes(restoration) && error.errors.includes(reporting));
    assert.equal(reads, 1); assert.equal(restored, 3); assert.equal(sealed, 1); assert.equal(relays, 1);
    const control = records.values().find(row => row.v === 2);
    assert.ok(control); assert.equal(control.failed, true); assert.equal(control.control.state, 3);
    assert.equal(control.control.witness, null); assert.equal(invocation.witness, undefined);
    assert.equal(bindings.qualifiedControls.size, 0);
  }
});
// END Xiaomi consumed control witness inert tests.

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
