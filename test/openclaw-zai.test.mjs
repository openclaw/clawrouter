import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { types as nodeTypes } from "node:util";
import { createRequire, stripTypeScriptTypes } from "node:module";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const sdkSource = readFileSync(new URL("./fixtures/openclaw-zai-contract.test.ts", import.meta.url), "utf8");
const supportSource = sdkSource.split("// BEGIN ZAI CONTRACT SUPPORT\n")[1].split("// END ZAI CONTRACT SUPPORT")[0];
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const supportJs = esbuild.transformSync(supportSource + "\nexport { regionalCases, regionalNegativeCases, nativeControlCases, requirePreabortOutcome, requireNativeControlLifetime, controlReceipt, controlReceiptPrefix, allFailures, originalLifetime, diagnosticProtocol };", { loader: "ts", format: "esm" }).code;
const { regionalCases, regionalNegativeCases, nativeControlCases, requirePreabortOutcome, requireNativeControlLifetime, controlReceipt, controlReceiptPrefix, allFailures, originalLifetime, diagnosticProtocol } = await import("data:text/javascript;base64," + Buffer.from(supportJs).toString("base64"));
const regionalRows = [...regionalCases(), ...regionalNegativeCases(), ...nativeControlCases()];
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
  const { startBundledWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf, origin;
  const controlReceipts = [];
  const proofContext = { diagnostic(value) { for (const record of diagnostics.parse(value)) emit(record); controlReceipts.push(...controlReceipt(value)); } };
  await allFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleZaiOutcome(routerFixture()), upstreamFixture(), { directRouter: true });
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
    assert.equal(createHash("sha256").update(readFileSync(join(source, "packages/ai/src/transports/transport-stream-shared.ts"))).digest("hex"), "d987e6ccdfb3aa106e0c81f1fa67eb52ec22fab45eb783d6904b0adfabdf2cf7");
    try {
      await runOpenClawConsumer(proofContext, { source, sourceHead, fixture: new URL("./fixtures/openclaw-zai-contract.test.ts", import.meta.url), testPath: "extensions/zai/worker-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin, ZAI_API_KEY: "must-not-fallback", ZAI_CODING_GLOBAL_API_KEY: "must-not-fallback" } });
    } catch (error) {
      for (const record of ownChildRecords(error)) emit(record);
      failureRecord("helper", error); throw error;
    }
    assert.equal(controlReceipts.length, 4); assert.deepEqual(controlReceipts.map(row => row.id).sort(), nativeControlCases().map(row => row.id).sort());
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
      try {
        const response = await fetch(origin + "/fixture/retire", { signal: AbortSignal.timeout(15_000) });
        const value = await response.json();
        assert.equal(response.status, 200); assert.equal(value.pending, 0); assert.equal(value.rejected, value.qualifiedReadRejections);
      } catch (error) { failureRecord("worker", error); throw error; }
    }, [async () => {
      try {
        const upstream = await mf.getWorker("upstream");
        const response = await upstream.fetch("https://fixture.example/retire", { signal: AbortSignal.timeout(15_000) });
        const value = await response.json();
        assert.equal(response.status, 200); assert.equal(value.pending, 0); assert.equal(value.rejected, 0);
      } catch (error) { failureRecord("upstream", error); throw error; }
    }]);
  }, async () => { try { await mf?.dispose(); } catch (error) { failureRecord("dispose", error); throw error; } },
    async () => { try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failureRecord("remove", error); throw error; } }]);
});
const workerOutcomePins = {"proxy.ts": "b1a8d68993b406b5660ebff0cd3b94e6d11cd0dccbafb7a22d50ec5bec2d483f", "proxy-response.ts": "b938ae532df851af62d90c5cb0e8dfa68fb88ed2a15e75f384ff3ca336fb1227", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
function workerOutcomeOverlay(text, name = "proxy-response.ts") {
  assert.equal(createHash("sha256").update(text).digest("hex"), workerOutcomePins[name]);
  const edit = (before, after, count = 1) => { assert.equal(text.split(before).length, count + 1, before); text = text.replaceAll(before, after); };
  if (name === "proxy.ts") {
    // Thread the already-held operation to the original source owner; the
    // forwarded/normalized reader is deliberately NOT used as its identity.
    edit('function ownOrdinaryResponse(response: Response, completion: ProxyCompletion): Response {',
      'function ownOrdinaryResponse(response: Response, completion: ProxyCompletion, operation: HttpOperation): Response {');
    edit('ownOrdinaryResponse(response, completion)', 'ownOrdinaryResponse(response, completion, operation)', 2);
    edit('    const reader = response.body!.getReader(), input = inputRetirement(reader);',
      '    const reader = response.body!.getReader(), input = inputRetirement(reader);\n    zaiOutcome.current.bind(operation, response, reader);');
    edit('              const next = await input.read(() => reader.read());',
      '              zaiOutcome.current.readStart(operation, reader);\n              const next = await input.read(() => reader.read());\n              zaiOutcome.current.readDone(operation, reader);');
    edit('            } catch (error) {\n              if (!stopped)',
      '            } catch (error) {\n              zaiOutcome.current.failure(operation, reader, error);\n              if (!stopped)');
  } else {
    assert.equal(name, "proxy-response.ts");
    edit('    resolve({ ...inspection, delivery,', '    zaiOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = zaiOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { zaiOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { zaiOutcome } from "zai-outcome-witness";\n' + text;
}
async function bundleZaiOutcome(contents) {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "zai-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "zai-first-outcome", setup(build) {
      build.onResolve({ filter: /^zai-outcome-witness$/ }, () => ({ path: "witness", namespace: "zai" }));
      build.onLoad({ filter: /.*/, namespace: "zai" }, () => ({ contents: "export const zaiOutcome = { current: undefined };", loader: "js" }));
      build.onLoad({ filter: /[/\\]worker[/\\](?:proxy|proxy-response|http-operation)\.ts$/ }, args => {
        const name = args.path.split(/[/\\]/).at(-1), source = readFileSync(args.path, "utf8");
        assert.equal(createHash("sha256").update(source).digest("hex"), workerOutcomePins[name]);
        return { contents: name !== "http-operation.ts" ? workerOutcomeOverlay(source, name) : source, loader: "ts" };
      });
    } }],
  });
  return bundle.outputFiles[0].text;
}
function createWorkerOutcomeWitness(Operation, root, outgoing) {
  const rows = new Map(), stopped = new Set(), rejections = new Map(), cancels = new Map(), downstream = new Map();
  const status = Object.getOwnPropertyDescriptor(Operation.prototype, "status").get;
  const delivery = Object.getOwnPropertyDescriptor(Operation.prototype, "delivery").get;
  const received = Object.getOwnPropertyDescriptor(Operation.prototype, "receivedRejection").get;
  const own = (object, key) => { const d = Object.getOwnPropertyDescriptor(object, key); return d && Object.hasOwn(d, "value") ? d.value : undefined; };
  const note = (fn, row) => { try { fn(); } catch (error) { root.failure(error); row?.life.failure(error); } };
  const originalCancel = Operation.prototype.cancel, originalStop = Operation.prototype.stop, originalRejection = Operation.prototype.acceptRejection;
  root.patch(Operation.prototype, "acceptRejection", function (...args) {
    note(() => rejections.set(this, (rejections.get(this) ?? 0) + 1), rows.get(this));
    return Reflect.apply(originalRejection, this, args);
  });
  root.patch(Operation.prototype, "cancel", function (...args) {
    const row = rows.get(this); let current, parent;
    note(() => { parent = cancels.get(this); current = { args, entered: row?.life.stamp(), returned: 0, threw: false }; cancels.set(this, current); }, row);
    try { const value = Reflect.apply(originalCancel, this, args); note(() => { current.returned = row?.life.stamp(); }, row); return value; }
    catch (error) { note(() => { current.threw = true; }, row); throw error; }
    finally { note(() => { if (parent) cancels.set(this, parent); else cancels.delete(this); }, row); }
  });
  root.patch(Operation.prototype, "stop", function (...args) {
    const row = rows.get(this); let record;
    note(() => {
      if (stopped.has(this)) return;
      stopped.add(this);
      if (!row) return;
      const cancel = cancels.get(this), incoming = row.owner.ingress;
      const pending = row.reading && row.life.operations.filter(op => op.reader === row.reader && op.kind === "read" && op.invoked > row.readStart);
      record = { args, cancel, entered: row.life.stamp(), returned: 0, threw: false,
        beforeStatus: Reflect.apply(status, this, []), beforeDelivery: Reflect.apply(delivery, this, []),
        received: Reflect.apply(received, this, []), rejectionCount: rejections.get(this) ?? 0,
        pending: pending?.length === 1 && pending[0].state === "pending" ? pending[0] : undefined,
        origin: !!cancel && (incoming.abort > 0 && incoming.abort < cancel.entered && incoming.signal === own(this, "caller")
          || downstream.has(this) && Object.is(downstream.get(this).reason, cancel.args[0])) };
      row.stop = record;
    }, row);
    let value;
    try { value = Reflect.apply(originalStop, this, args); }
    catch (error) { note(() => { if (record) record.threw = true; }, row); throw error; }
    note(() => { if (record) { record.returned = row.life.stamp(); record.status = Reflect.apply(status, this, []); record.delivery = Reflect.apply(delivery, this, []); } }, row);
    return value;
  });
  return {
    bind(operation, response, reader) { note(() => {
      if (rows.has(operation)) throw new Error("Duplicate original Worker operation");
      const owners = outgoing.filter(owner => owner.response === response && owner.signal === own(operation, "signal"));
      if (owners.length !== 1) return;
      const owner = owners[0], life = owner.lifetime, incoming = owner.ingress;
      const row = life.readers.find(row => row.reader === reader && row.body === response.body && row.owner === owner);
      if (!row || !incoming || incoming.id !== owner.id || incoming.signal !== own(operation, "caller")
        || owner.method !== "POST" || incoming.method !== "POST" || !owner.returned || !owner.original
        || stopped.has(operation) || rejections.has(operation) || Reflect.apply(received, operation, [])
        || Reflect.apply(status, operation, []) !== undefined || Reflect.apply(delivery, operation, []) !== undefined) return;
      rows.set(operation, { operation, owner, life, reader: row, body: response.body, bound: life.stamp(), failures: [], reading: false });
    }); },
    readStart(operation, reader) { const row = rows.get(operation); note(() => { if (row?.reader.reader === reader) { if (row.reading) throw new Error("Overlapping original Worker read"); row.reading = true; row.readStart = row.life.stamp(); } }, row); },
    readDone(operation, reader) { const row = rows.get(operation); note(() => { if (row?.reader.reader === reader) row.reading = false; }, row); },
    failure(operation, reader, error) { const row = rows.get(operation); note(() => { if (row?.reader.reader === reader) { row.failures.push({ error, at: row.life.stamp(), reading: row.reading, readStart: row.readStart }); row.reading = false; } }, row); },
    inspection(operation, inspection, delivered) { const row = rows.get(operation); note(() => { if (row) { if (row.inspection) throw new Error("Duplicate Worker outcome"); row.inspection = { outcome: own(inspection, "outcome"), delivered, at: row.life.stamp() }; } }, row); },
    downstreamStart(operation, reason) { let previous; note(() => { previous = downstream.get(operation); downstream.set(operation, { reason }); }, rows.get(operation)); return previous; },
    downstreamEnd(operation, previous) { note(() => { if (previous) downstream.set(operation, previous); else downstream.delete(operation); }, rows.get(operation)); },
    matches(op) {
      const matching = [...rows.values()].filter(row => row.owner === op.owner && row.reader === op.reader);
      if (matching.length !== 1) return false;
      const row = matching[0], stop = row.stop, cancel = stop?.cancel, failure = row.failures.length === 1 ? row.failures[0] : undefined;
      return outgoing.includes(row.owner) && row.owner.lifetime === row.life && row.owner.ingress.id === row.owner.id
        && row.owner.signal === own(row.operation, "signal") && row.owner.ingress.signal === own(row.operation, "caller")
        && Object.getPrototypeOf(row.operation) === Operation.prototype && op.reader.body === row.body && op.receiver === row.reader.reader
        && stop?.pending === op && stop.origin === true && stop.beforeStatus === undefined && stop.beforeDelivery === undefined
        && stop.received === false && stop.rejectionCount === 0 && !rejections.has(row.operation) && stop.args[0] === "caller"
        && stop.status === "client_error" && stop.delivery === "canceled" && !stop.threw && cancel && !cancel.threw
        && cancel.entered < stop.entered && stop.entered < stop.returned && stop.returned < cancel.returned
        && row.bound < failure?.readStart && failure.readStart < op.invoked && op.invoked < stop.entered
        && failure.reading === true && Object.is(failure.error, op.reason) && cancel.returned < failure.at
        && row.inspection?.outcome === null && row.inspection.delivered === "canceled" && row.inspection.at < failure.at;
    },
  };
}

function workerReadDisposition(life, op, source, outcome) {
  if (op.kind !== "read" || op.state !== "rejected" || !outcome.matches(op)) return false;
  const row = op.reader, owner = op.owner;
  if (!source || source.id !== owner.id || source.calls !== 1 || source.cancelCalls !== 1 || source.cancelReturned !== 1
    || source.settled !== true || source.active !== 0 || source.expired !== false || source.failed !== 0
    || !life.readers.includes(row) || row.owner !== owner || row.unlocks !== 1 || row.unlocked !== 1 || row.body.locked) return false;
  const related = life.operations.filter(item => item.reader === row), cancel = related.filter(item => item.kind === "cancel"), closed = related.filter(item => item.kind === "closed");
  return cancel.length === 1 && closed.length === 1 && closed[0].state === "fulfilled"
    && cancel[0].state === "fulfilled" && cancel[0].owner === owner && cancel[0].receiver === row.reader
    && op.invoked < cancel[0].invoked && cancel[0].invoked < op.settled && op.settled < row.unlockInvoke
    && cancel[0].settled < row.unlockInvoke && related.filter(item => item.state !== "fulfilled").length === 1;
}

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { zaiOutcome } from "zai-outcome-witness";
const regional = ${JSON.stringify(regionalRows)};
${originalLifetime.toString()}
${allFailures.toString()}
${reservationObserver.toString()}
${createWorkerOutcomeWitness.toString()}
${workerReadDisposition.toString()}
${retireOwners.toString()}
const reservations = {};
const ownership = (${workerOwnership.toString()})();
const controlOwners = Object.fromEntries(${JSON.stringify(nativeControlCases().map(row => row.id))}.map(id => [id, (${workerOwnership.toString()})()]));
const ingress = {}, requestWaits = new Map(), incoming = new Map(), outgoing = [], sources = new Map();
zaiOutcome.current = createWorkerOutcomeWitness(HttpOperation, ownership.lifetime, outgoing);
for (const owner of [ownership, ...Object.values(controlOwners)]) owner.assess = op => workerReadDisposition(owner.lifetime, op, sources.get(op.owner.id), zaiOutcome.current);
function sourceProof(call, all) { return { ...call.source, id: call.id, calls: all.filter(row => row.id === call.id).length, expired: call.fixtureExpired === true }; }
const requestIds = ${JSON.stringify([...ids, ...regionalRows.map(row => row.id)])};
const callerIds = new Map(requestIds.map(id => ["Bearer clawrouter-live-zai_" + id + "-fixture-secret", id]));
const serverIds = new Map(requestIds.flatMap(id => [["Bearer fixture-upstream-" + id, id], ["Bearer fixture-upstream-" + id + "-rotated", id]]));
const originalFetch = globalThis.fetch;
globalThis.fetch = function(...args) {
  const original = Reflect.apply(originalFetch, this, args);
  const input = args[0], init = args[1];
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["api.z.ai", "open.bigmodel.cn"].includes(url.hostname)) return original;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const id = serverIds.get(headers.get("authorization"));
  const selectedOwner = controlOwners[id] ?? ownership, waitUntil = requestWaits.get(id), owner = { input, init, original, waitUntil, id, ingress: incoming.get(id),
    method: init?.method ?? (input instanceof Request ? input.method : "GET"), signal: init?.signal ?? (input instanceof Request ? input.signal : undefined), lifetime: selectedOwner.lifetime, returned: false };
  outgoing.push(owner);
  if (!waitUntil) selectedOwner.failure(new Error("Missing original request I/O owner"));
  selectedOwner.track("fetch", original);
  original.then(response => { owner.response = response; owner.returned = true; selectedOwner.response(response, owner); }, error => selectedOwner.failure(error));
  return original;
};
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/control") {
    const id = new URL(request.url).searchParams.get("id"), owner = controlOwners[id];
    if (!owner) return new Response(null, { status: 400 });
    let router, upstream, failed = false;
    sources.delete(id);
    try { await allFailures(async () => {
      const response = await Reflect.apply(originalFetch, globalThis, ["https://fixture.example/control?id=" + id]);
      upstream = await response.json();
      if (response.status !== 200) throw new Error("Upstream control retirement failed");
      if (upstream.source) sources.set(id, upstream.source);
    }, [async () => { router = await owner.retire(); }]); }
    catch (error) { ownership.failure(error); router = owner.summary(); failed = true; }
    return Response.json({ router, upstream: upstream?.proof ?? null, calls: upstream?.calls ?? null, expired: upstream?.expired ?? null, ingress: ingress[id] ?? 0 }, { status: failed ? 503 : 200 });
  }
  if (new URL(request.url).pathname === "/fixture/reservations") return Response.json(reservations);
  if (new URL(request.url).pathname === "/fixture/retire") {
    let router;
    sources.clear();
    try { await allFailures(async () => {
      const retired = await Reflect.apply(originalFetch, globalThis, ["https://fixture.example/retire"]);
      if (retired.status !== 200) throw new Error("Upstream source retirement failed");
      const calls = await (await Reflect.apply(originalFetch, globalThis, ["https://fixture.example/state"])).json();
      const captured = calls.map(call => [call.id, sourceProof(call, calls)]);
      for (const [id, proof] of captured) sources.set(id, proof);
    }, [async () => { router = await retireOwners([ownership, ...Object.values(controlOwners)]); }]);
      return Response.json(router);
    }
    catch (error) { ownership.failure(error); return Response.json({ pending: null, rejected: null }, { status: 503 }); }
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
  const selectedOwner = controlOwners[row?.id] ?? ownership;
  const callerId = callerIds.get(request.headers.get("authorization"));
  if (callerId) {
    requestWaits.set(callerId, context.waitUntil.bind(context));
    const owner = { id: callerId, request, method: request.method, signal: request.signal, abort: 0 };
    const aborted = () => { owner.abort = selectedOwner.lifetime.stamp(); };
    request.signal.addEventListener("abort", aborted, { once: true });
    incoming.set(callerId, owner);
    selectedOwner.lifetime.onRestore(() => request.signal.removeEventListener("abort", aborted));
  }
  if (controlOwners[row?.id]) ingress[row.id] = (ingress[row.id] ?? 0) + 1;
  return selectedOwner.track("handler", handler.fetch(request, selected, { ...context, waitUntil(original) { selectedOwner.track("waitUntil", original); context.waitUntil(original); } }));
} };`;
}
function upstreamFixture() {
  return `${retireOwners.toString()}
const calls = []; const regional = ${JSON.stringify(regionalRows)}; const globalOwnership = (${workerOwnership.toString()})();
  const controlOwners = Object.fromEntries(${JSON.stringify(nativeControlCases().map(row => row.id))}.map(id => [id, (${workerOwnership.toString()})()]));
  export default { async fetch(request, env, context) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    if (request.url === "https://fixture.example/retire") { try { return Response.json(await retireOwners([globalOwnership, ...Object.values(controlOwners)])); } catch { return Response.json({ pending: null, rejected: null }, { status: 503 }); } }
    if (new URL(request.url).pathname === "/control") {
      const id = new URL(request.url).searchParams.get("id"), owner = controlOwners[id];
      if (!owner) return new Response(null, { status: 400 });
      const matching = calls.filter(call => call.authorization === "Bearer fixture-upstream-" + id);
      let proof, failed = false; try { proof = await owner.retire(); } catch { proof = owner.summary(); failed = true; }
      return Response.json({ proof, calls: matching.length, expired: matching.some(call => call.fixtureExpired === true),
        source: matching.length === 1 ? { ...matching[0].source, id, calls: 1, expired: matching[0].fixtureExpired === true } : null }, { status: failed ? 503 : 200 });
    }
    const requestId = request.headers.get("authorization")?.replace(/^Bearer fixture-upstream-/, "");
    const ownership = controlOwners[requestId] ?? globalOwnership;
    const body = await ownership.track("request-json", request.json()); const call = { id: requestId, source: { cancelCalls: 0, cancelReturned: 0, settled: false, active: 0, failed: 0 }, url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body }; calls.push(call);
    const id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    const row = regional.find(row => id === row.id || id === row.id + "-rotated"), outcome = row?.outcome;
    if (id === "http_error" || outcome?.startsWith("http")) return Response.json({ error: { message: "synthetic provider rejection" } }, { status: id === "http_error" ? 401 : Number(outcome.slice(4)) });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const usage = id === "no_usage" || outcome === "no_usage" ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } };
    const wire = id === "embedded_error" || outcome === "embedded" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } })
      : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] })
        + (outcome === "cancel" ? "" : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...usage }) + (id === "control_success" ? "" : "data: [DONE]\\n\\n"));
    const bytes = new TextEncoder().encode(wire); let offset = 0, finish, fail, timer, wake, beats = 0;
    const originalCompletion = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); ownership.track("source", originalCompletion);
    context.waitUntil(originalCompletion);
    const sourceObserved = originalCompletion.then(() => { call.source.settled = true; }, () => { call.source.failed++; });
    ownership.track("source-observer", sourceObserved); context.waitUntil(sourceObserved);
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
      call.source.active++;
      ownership.track("pull", original); context.waitUntil(original);
      const observed = original.then(() => { call.source.active--; }, () => { call.source.active--; call.source.failed++; });
      ownership.track("pull-observer", observed); context.waitUntil(observed); return original;
    }, cancel() { call.source.cancelCalls++; call.cancelled = true; retired(); finish(); call.source.cancelReturned++; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}

async function retireOwners(owners) {
  // Start every original completion even if another owner fails or remains pending.
  const settled = await Promise.allSettled(owners.map(owner => { try { return owner.retire(); } catch (error) { return Promise.reject(error); } }));
  const errors = settled.filter(row => row.status === "rejected").map(row => row.reason);
  if (errors.length) throw new AggregateError(errors, "Worker owners failed");
  return settled.reduce((sum, row) => ({ operations: sum.operations + row.value.operations, pending: sum.pending + row.value.pending, rejected: sum.rejected + row.value.rejected, qualifiedReadRejections: sum.qualifiedReadRejections + row.value.qualifiedReadRejections }), { operations: 0, pending: 0, rejected: 0, qualifiedReadRejections: 0 });
}

function workerOwnership() {
  const operations = [], failures = []; let completion, qualifiedReadRejections = 0;
  const lifetime = typeof originalLifetime === "function" ? originalLifetime() : null;
  function track(kind, original) {
    const record = { kind, original, state: "pending" }; operations.push(record);
    Promise.resolve(original).then(() => { record.state = "fulfilled"; }, error => { record.state = "rejected"; record.error = error; });
    return original;
  }
  function summary() { const body = lifetime?.summary(); return { qualifiedReadRejections, operations: operations.length + (body?.operations ?? 0), pending: operations.filter(op => op.state === "pending").length + (body?.pending ?? 0), rejected: operations.filter(op => op.state === "rejected").length + failures.length + (body?.rejected ?? 0) }; }
  function retire() {
    return completion ??= (async () => {
      let count = -1;
      while (count !== operations.length + (lifetime?.operations.length ?? 0)) {
        count = operations.length + (lifetime?.operations.length ?? 0);
        await Promise.allSettled(operations.map(op => op.original)); await lifetime?.settle();
      }
      const errors = [...failures, ...operations.filter(op => op.state !== "fulfilled").map(op => op.error)];
      if (lifetime) {
        const inspected = lifetime.inspect(); errors.push(...inspected.structural);
        let admitted = [];
        try { if (errors.length === 0) admitted = inspected.rejected.filter(op => api.assess?.(op) === true); } catch (error) { errors.push(error); }
        qualifiedReadRejections = admitted.length;
        for (const op of inspected.rejected) if (!admitted.includes(op)) errors.push(op.reason);
      }
      try { lifetime?.restore(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Original Worker work failed");
      return summary();
    })();
  }
  const api = { track, retire, summary, lifetime, assess: undefined, failure: error => failures.push(error), response(response, owner) { try { lifetime.observeResponse(response, owner); } catch (error) { failures.push(error); } } };
  return api;
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
  assert.ok((await bundleZaiOutcome(routerFixture())).length > 0);
  for (const [name, contents] of [["upstream", upstreamFixture()]]) {
    const result = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}-zai-fixture.ts`, loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
    assert.equal(result.errors.length, 0); assert.ok(result.outputFiles[0].text.length > 0);
  }
});

// Classifier-only native-stream comparisons. They do not populate the SDK's
// nativeQualification set or establish any d8 registered-provider result.
async function observedAbort(variant = "matching", qualified = false) {
  const observer = originalLifetime({ sdkQualified: () => qualified });
  const caller = new AbortController(), input = new AbortController();
  const owner = observer.bind({ caseId: "control_cancel", role: "chat", outcome: "cancel", verified: true }, caller.signal);
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }, { highWaterMark: 0 }));
  const release = Promise.resolve(), resource = { response, release() { assert.equal(this, resource); return release; } };
  const acquired = Promise.resolve(resource);
  assert.equal(observer.acquire(() => acquired, undefined, [{ signal: input.signal }], owner), acquired); await acquired;
  const reader = response.body.getReader(), closed = reader.closed;
  const first = reader.read(); controller.enqueue(new Uint8Array([1])); await first;
  const event = Promise.resolve({ done: false, value: { type: variant === "no_partial" ? "other" : "text_delta", delta: "x" } });
  const result = Promise.resolve({ stopReason: "aborted", content: [{ type: "text", text: "x" }] });
  const stream = { [Symbol.asyncIterator]() { return { next() { return event; } }; }, result() { return result; } };
  observer.observeStream(stream, owner); assert.equal(stream[Symbol.asyncIterator]().next(), event); await event;
  const pending = reader.read(), error = variant === "undefined" ? undefined : new Error("original source");
  if (variant === "prior") { controller.error(error); await Promise.allSettled([pending, closed]); }
  if (variant !== "no_caller") caller.abort(new Error("original caller"));
  if (variant !== "late_guard") input.abort(variant === "foreign" ? new Error("original source") : error);
  if (variant !== "prior") controller.error(error);
  const cancel = reader.cancel(); reader.releaseLock(); assert.equal(resource.release(), release); await release;
  if (variant === "late_guard") input.abort(error);
  assert.equal(stream.result(), result); await result;
  await Promise.allSettled([pending, closed, cancel]); await observer.settle();
  if (variant === "wrong_reader") observer.operations.find(op => op.kind === "read" && op.rejected).reader = {};
  if (variant === "wrong_request") observer.readers[0].acquisition = {};
  if (variant === "expired") owner.expired = true;
  return { observer, owner, pending, closed, cancel, release, error };
}

test("SDK disposition stays disabled until native qualification; identical Worker observations remain strict", async () => {
  for (const qualified of [false, true]) {
    const f = await observedAbort("matching", qualified);
    assert.equal(f.observer.inspect().cancelWitnesses.length, 1); assert.equal(f.observer.inspect().candidates.length, 3);
    assert.equal(f.observer.operations.find(op => op.kind === "read" && op.rejected).original, f.pending);
    assert.equal(f.observer.operations.find(op => op.kind === "closed").original, f.closed);
    assert.equal(f.observer.operations.find(op => op.kind === "cancel").original, f.cancel);
    if (qualified) await f.observer.join(); else await assert.rejects(f.observer.join());
    f.observer.restore();
  }
  const worker = originalLifetime(); let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } })); worker.observeResponse(response, {});
  const reader = response.body.getReader(), pending = reader.read(); controller.error(new Error("worker source"));
  await Promise.allSettled([pending, reader.closed, reader.cancel()]); reader.releaseLock();
  await assert.rejects(worker.join()); worker.restore();
});

for (const variant of ["no_partial", "prior", "foreign", "undefined", "no_caller", "late_guard", "wrong_reader", "wrong_request", "expired"]) test("SDK disposition rejects actual observer counterexample " + variant, async () => {
  const f = await observedAbort(variant, true);
  await assert.rejects(f.observer.join(), error => error instanceof AggregateError && error.errors.length > 0);
  f.observer.restore();
});

test("native cancellation control asserts strict originals without enabling their disposition", async () => {
  const f = await observedAbort();
  assert.deepEqual((await requireNativeControlLifetime(f.observer, f.owner, "cancel")).sort(), ["cancel", "closed", "read"]);
  await assert.rejects(f.observer.join()); f.observer.restore();
});

test("zero-acquisition preabort requires the original caller and exact public error with empty content", async () => {
  for (const variant of ["matching", "wrong_error", "content", "not_aborted", "missing_caller"]) {
    const observer = originalLifetime(), caller = new AbortController(), reason = new Error("fixture cancellation");
    if (variant !== "not_aborted") caller.abort(reason);
    const owner = observer.bind({ outcome: "preabort" }, variant === "missing_caller" ? undefined : caller.signal);
    const result = Promise.resolve({ stopReason: "error", errorMessage: variant === "wrong_error" ? "unrelated" : reason.message, content: variant === "content" ? [{ type: "text", text: "x" }] : [] });
    const stream = { result() { return result; } }; observer.observeStream(stream, owner); assert.equal(stream.result(), result); await result;
    if (variant === "matching") { requirePreabortOutcome(observer, owner); await requireNativeControlLifetime(observer, owner, "preabort"); }
    else assert.throws(() => requirePreabortOutcome(observer, owner));
    await observer.join(); observer.restore();
  }
});

test("provider error without caller cannot qualify an iterator abort as caller cancellation", async () => {
  const f = await observedAbort("no_caller");
  f.owner.outcome = "embedded"; f.owner.caller.signal = undefined; f.owner.terminal.stopReason = "error";
  await assert.rejects(requireNativeControlLifetime(f.observer, f.owner, "embedded"), /Provider error is not caller cancellation/);
  await assert.rejects(f.observer.join()); f.observer.restore();
});

test("every original Worker owner starts retirement despite a synchronous failure and a held completion", async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; }), started = [];
  const failure = undefined;
  const completion = retireOwners([{ retire() { started.push(1); throw failure; } }, { retire() { started.push(2); return pending; } }]);
  let settled = false; void completion.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); assert.deepEqual(started, [1, 2]); assert.equal(settled, false);
  finish({ operations: 1, pending: 0, rejected: 0 });
  await assert.rejects(completion, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === undefined);
});

test("native controls are four separate cases and receipts never replace original helper success", async () => {
  assert.deepEqual(nativeControlCases().map(row => row.outcome), ["success", "preabort", "cancel", "embedded"]);
  const lines = nativeControlCases().map(row => controlReceiptPrefix + JSON.stringify({ v: 1, id: row.id, mask: 0 })).join("\n");
  assert.equal(controlReceipt(lines).length, 4);
  assert.throws(() => controlReceipt(controlReceiptPrefix + '{"v":1,"id":"control_success","mask":1}'));
  assert.throws(() => controlReceipt(controlReceiptPrefix + '{"v":1,"id":"control_cancel","mask":8}'));
  const helperFailure = undefined;
  await assert.rejects(allFailures(() => { controlReceipt(lines); throw helperFailure; }, [() => {}]), error => error.errors[0] === undefined);
  assert.match(sdkSource, /nativeQualification\.add\(control\)/);
  assert.ok(sdkSource.indexOf('describe("genuine registered') < sdkSource.indexOf('describe("actual registered'));
  assert.doesNotMatch(sdkSource, /describe\.sequential/);
});


test("cancel invocation signal is captured before the original method can abort it", async () => {
  const observer = originalLifetime({ sdkQualified: () => true }), signal = new AbortController(), owner = {};
  let receiver; const reason = new Error("during original cancel");
  const body = new ReadableStream({ cancel() { signal.abort(reason); return Promise.reject(reason); } });
  const response = new Response(body), resource = { response, release: () => Promise.resolve() };
  await observer.acquire(() => Promise.resolve(resource), undefined, [{ signal: signal.signal }], owner);
  const reader = body.getReader(), originalCancel = reader.cancel, pending = reader.cancel(); receiver = reader;
  await Promise.allSettled([pending, reader.closed]); reader.releaseLock(); await resource.release();
  const op = observer.operations.find(op => op.kind === "cancel");
  assert.equal(op.original, pending); assert.equal(op.receiver, receiver); assert.deepEqual(op.operands, []);
  assert.equal(op.guardInvoke.aborted, false); assert.equal(op.guardReject.aborted, true); assert.equal(op.guardReject.reason, reason);
  await assert.rejects(observer.join()); observer.restore();
});

test("SDK disposition cannot accept failed release, unlock or observer restoration", async () => {
  for (const kind of ["release", "unlock", "restore"]) {
    const f = await observedAbort("matching", true);
    if (kind === "release") f.observer.record("release", Promise.reject(undefined), f.owner, undefined, f.observer.acquisitions[0]);
    else if (kind === "unlock") { let failed = false; try { Reflect.apply(f.observer.readers[0].reader.releaseLock, {}, []); } catch { failed = true; } assert.equal(failed, true); }
    else Object.defineProperty(f.observer.readers[0].reader, "read", { configurable: false, value: f.observer.readers[0].reader.read });
    if (kind === "restore") { await f.observer.join(); assert.throws(() => f.observer.restore(), AggregateError); }
    else { await assert.rejects(f.observer.join()); f.observer.restore(); }
  }
});

test("Worker original completions remain the same success or failure on every retirement call", async () => {
  for (const failed of [false, true]) {
    const owner = workerOwnership(), original = failed ? Promise.reject(undefined) : Promise.resolve();
    assert.equal(owner.track("original", original), original);
    const first = owner.retire(); assert.equal(first, owner.retire());
    if (failed) await assert.rejects(first, error => error.errors.includes(undefined)); else assert.equal((await first).pending, 0);
    assert.equal(first, owner.retire());
  }
});


test("Worker reader observations retain the originating request waitUntil and the original promises", async () => {
  const promises = [], context = { waitUntil(original) { assert.equal(this, context); promises.push(original); } };
  const observer = originalLifetime(), owner = { waitUntil: context.waitUntil.bind(context) }, response = new Response("owned");
  observer.observeResponse(response, owner);
  const reader = response.body.getReader(), closed = reader.closed, read = reader.read(); await read; await reader.read(); reader.releaseLock();
  assert.equal(promises[0], closed); assert.equal(promises[1], read);
  await observer.join(); observer.restore();
});


test("Node default reporter preserves the actual ZAI diagnostic command at column zero", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zai-diagnostic-reporter-"));
  await allFailures(async () => {
    const path = join(directory, "reporter.test.mjs");
    await writeFile(path, 'import test from "node:test";import {types} from "node:util";\n' + supportJs + '\ntest("reporter",()=>{const p=diagnosticProtocol(types.isProxy);p.emitter(line=>process.stdout.write(line))({v:1,layer:"sdk",caseId:"control_cancel",phase:"join",category:"undefined"});});\n');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath, ["--test", path], { env, timeout: 5000 });
    const lines = result.stdout.split("\n").filter(line => line.includes("::error title=ZAI contract diagnostic::"));
    assert.equal(lines.length, 1); assert.ok(lines[0].startsWith("::error title=ZAI contract diagnostic::"));
    assert.ok(Buffer.byteLength(lines[0]) <= 768);
  }, [() => rm(directory, { recursive: true, force: true })]);
});


test("ZAI actual control registration uses supported serial suite options and retains all four gates", () => {
  const code = stripTypeScriptTypes(sdkSource);
  const begin = code.indexOf('describe("genuine registered'), end = code.indexOf('describe("actual registered', begin);
  assert.ok(begin >= 0 && end > begin);
  const suites = [], entries = [], calls = [];
  const describe = (name, options, callback) => { suites.push({ name, options }); callback(); };
  const productIt = (id, body) => entries.push({ id, body });
  const observe = (body, id) => { calls.push({ body, id }); return id; };
  new Function("describe", "productIt", "nativeControlCases", "withSdkObservation", code.slice(begin, end))(describe, productIt, nativeControlCases, observe);
  assert.deepEqual(suites, [{ name: "genuine registered Z.AI native lifetime controls", options: { concurrent: false } }]);
  assert.deepEqual(entries.map(row => row.id), ["control_success", "control_preabort", "control_cancel", "control_embedded"]);
  for (const entry of entries) assert.equal(entry.body(), entry.id);
  assert.deepEqual(calls.map(row => row.id), entries.map(row => row.id));
  assert.ok(calls.every(row => typeof row.body === "function"));
  assert.match(code, /nativeQualification.size === 4 && qualifiedRejectionKinds.has\(kind\)/);
});

test("ZAI actual replay callback owns its captured provider across suspension and restoration", async () => {
  const code = stripTypeScriptTypes(sdkSource), anchor = 'withOpenClawTestState({ label: "zai-worker" }, async state => {';
  const begin = code.indexOf(anchor);
  // Type stripping may change indentation, so use the next context declaration as the boundary.
  const tail = code.indexOf('const context', begin), close = code.lastIndexOf('});', tail);
  assert.ok(begin >= 0 && close > begin);
  const factory = new Function("resolveTranscriptPolicy", "expect", "createEmptyPluginRegistry", "withPluginRuntimeGenerationRegistryScope", "sanitizeSessionHistory", "makeInMemorySessionManager", "makeModelSnapshotEntry", "modelId", "model", "provider", "id", "history", "return async state => {" + code.slice(begin + anchor.length, close) + "};");
  const storage = new AsyncLocalStorage(), registries = [], foreign = { id: "zai" }, outer = { providers: [{ pluginId: "zai", provider: foreign, source: "test" }] };
  for (const failure of [false, true]) for (const reason of [undefined, false, {}]) await storage.run(outer, async () => {
    await Promise.all([0, 1].map(async index => {
      const selected = { id: "zai" }, model = { provider: "zai", api: "openai-completions" }, history = [], result = [], policy = { dropReasoningFromHistory: false };
      let registry, original, calls = 0;
      const invoke = factory(params => { assert.equal(params.runtimeHandle.plugin, selected); assert.equal(params.model, model); return policy; },
        value => ({ toBe: expected => assert.equal(value, expected) }), () => { registry = { providers: [] }; registries.push(registry); return registry; },
        (owned, callback) => { assert.equal(owned, registry); const pending = storage.run(owned, callback); assert.equal(pending, original); return pending; },
        params => {
          calls++; assert.equal(storage.getStore(), registry); assert.deepEqual(registry.providers, [{ pluginId: "zai", provider: selected, source: "test" }]);
          assert.notEqual(selected, foreign); assert.equal(params.policy, policy); assert.equal(params.model, model); assert.equal(params.messages, history);
          assert.equal(params.sessionId, "zai-case" + index); assert.equal(params.workspaceDir, "/fixture/workspace");
          original = Promise.resolve().then(async () => {
            assert.equal(storage.getStore(), registry);
            await storage.run({ providers: [] }, async () => { assert.deepEqual(storage.getStore().providers, []); });
            assert.equal(storage.getStore(), registry); if (failure) throw reason; return result;
          }); return original;
        }, entries => ({ entries }), value => value, models[index], model, selected, "case" + index, history);
      let failed = false, value; try { value = await invoke({ workspaceDir: "/fixture/workspace" }); } catch (error) { failed = true; value = error; }
      assert.equal(failed, failure); assert.equal(value, failure ? reason : result); assert.equal(calls, 1); assert.equal(storage.getStore(), outer);
    }));
    assert.equal(storage.getStore(), outer);
  });
  assert.equal(new Set(registries).size, registries.length); assert.equal(storage.getStore(), undefined);
});

test("ZAI Worker outcome binds original reads and keeps independent failures strict", async () => {
  const proxy = workerOutcomeOverlay(readFileSync(new URL("../worker/proxy.ts", import.meta.url), "utf8"), "proxy.ts");
  const inner = proxy.slice(proxy.indexOf("function ownOrdinaryResponse("), proxy.indexOf("\nasync function proxySelected("));
  const code = await bundleZaiOutcome('import { HttpOperation, InternalHttpAbort } from "./worker/http-operation.ts"; import { inputRetirement } from "./worker/input-retirement.ts"; import { ProxyCompletion } from "./worker/proxy-completion.ts"; import { zaiOutcome } from "zai-outcome-witness"; export { observeUsage } from "./worker/proxy-response.ts"; ' + inner + '; export { HttpOperation, InternalHttpAbort, ProxyCompletion, ownOrdinaryResponse, zaiOutcome };');
  const { HttpOperation, InternalHttpAbort, ProxyCompletion, ownOrdinaryResponse, observeUsage, zaiOutcome } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const modes = ["caller", "downstream", "undefined_read", "false_read", "foreign_reason", "prior_400", "revoked_400", "prior_500", "deadline", "upstream",
    "protocol", "early_read", "foreign_ingress", "foreign_outbound", "foreign_response", "no_handler", "missing_source", "expired_source", "held_source", "failed_source",
    "duplicate_cancel", "cancel_failure", "closed_failure", "unlock_failure", "handler_failure", "waitUntil_failure", "observer_undefined", "restoration_undefined",
    "wrong_source", "missing_cancel", "duplicate_source_cancel", "unreturned_cancel", "unsettled_source", "registration_undefined", "foreign_aggregate"];
  for (const mode of modes) {
    const store = workerOwnership(), life = store.lifetime, caller = new AbortController();
    const incoming = { id: "control_cancel", method: "POST", signal: caller.signal, abort: 0 };
    caller.signal.addEventListener("abort", () => { incoming.abort = life.stamp(); }, { once: true });
    const operation = new HttpOperation(caller.signal);
    const owner = { id: incoming.id, method: "POST", signal: operation.signal, ingress: incoming, lifetime: life, returned: true };
    const outgoing = [owner], witness = createWorkerOutcomeWitness(HttpOperation, life, outgoing); zaiOutcome.current = witness;
    let source = { id: owner.id, calls: 1, cancelCalls: 1, cancelReturned: 1, settled: true, active: 0, expired: false, failed: 0 };
    if (mode === "missing_source") source = undefined;
    if (mode === "expired_source") source.expired = true;
    if (mode === "held_source") source.active = 1;
    if (mode === "failed_source") source.failed = 1;
    if (mode === "wrong_source") source.id = "foreign";
    if (mode === "missing_cancel") source.cancelCalls = 0;
    if (mode === "duplicate_source_cancel") source.cancelCalls = 2;
    if (mode === "unreturned_cancel") source.cancelReturned = 0;
    if (mode === "unsettled_source") source.settled = false;
    store.assess = op => workerReadDisposition(life, op, source, witness);
    if (mode === "no_handler") witness.failure = () => {};
    if (mode === "foreign_ingress") owner.ingress = { ...incoming, signal: new AbortController().signal };
    if (mode === "foreign_outbound") owner.signal = new AbortController().signal;
    const read = deferred(), closed = deferred(), reason = mode === "undefined_read" ? undefined : mode === "false_read" ? false : new Error("secondary read"), abort = new Error("caller intent");
    let reads = 0, cancels = 0, unlocks = 0;
    const reader = { closed: closed.promise,
      read() { if (++reads === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(mode === "protocol" ? 'data: {"error":{"message":"synthetic"}}\n\n' : 'data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}\n\n') }); return read.promise; },
      cancel() { cancels++; read.reject(reason); if (mode === "closed_failure") closed.reject(undefined); else closed.resolve(); return mode === "cancel_failure" ? Promise.reject(undefined) : Promise.resolve(); },
      releaseLock() { unlocks++; if (mode === "unlock_failure") throw undefined; },
    };
    const response = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    Object.defineProperty(response.body, "getReader", { configurable: true, value: () => reader });
    owner.response = mode === "foreign_response" ? new Response() : response; owner.original = Promise.resolve(response);
    store.track("fetch", owner.original); life.observeResponse(response, owner);
    const completion = new ProxyCompletion(), forwarded = ownOrdinaryResponse(response, completion, operation); completion.seal();
    assert.notEqual(forwarded.body, response.body);
    const observed = observeUsage(forwarded, operation), downstream = observed.response.body.getReader();
    await downstream.read(); const pending = downstream.read();
    const settled = Promise.allSettled([pending, observed.retired, observed.result, read.promise, closed.promise, completion.completion]);
    for (let i = 0; i < 10 && reads !== 2; i++) await Promise.resolve(); assert.equal(reads, 2, mode);
    if (["prior_400", "revoked_400", "prior_500"].includes(mode)) operation.acceptRejection(mode === "prior_500" ? 500 : 400);
    if (mode === "revoked_400") operation.revokeRejection();
    if (mode === "early_read") { read.reject(reason); await Promise.allSettled([pending]); }
    if (mode === "deadline") operation.cancel(new InternalHttpAbort("deadline", "synthetic"));
    if (mode === "upstream") operation.stop("upstream", reason);
    if (mode === "observer_undefined") life.failure(undefined);
    if (mode === "registration_undefined") store.failure(undefined);
    if (mode === "foreign_aggregate") store.failure(new AggregateError([reason], "independent original failure"));
    if (mode === "restoration_undefined") life.onRestore(() => { throw undefined; });
    if (mode === "caller") caller.abort(abort); else await Promise.allSettled([downstream.cancel(abort)]);
    if (mode === "duplicate_cancel") await reader.cancel();
    await settled;
    store.track("handler", mode === "handler_failure" ? Promise.reject(undefined) : Promise.resolve());
    store.track("waitUntil", mode === "waitUntil_failure" ? Promise.reject(undefined) : Promise.resolve());
    const positive = ["caller", "downstream", "undefined_read", "false_read", "foreign_reason"].includes(mode);
    if (positive) {
      const proof = await store.retire(); assert.equal(proof.rejected, 1, mode); assert.equal(proof.qualifiedReadRejections, 1, mode);
      assert.equal(operation.status, "client_error", mode); assert.equal((await observed.result).delivery, "canceled", mode); assert.equal(cancels, 1, mode); assert.equal(unlocks, 1, mode);
      const rejected = life.operations.find(op => op.rejected); assert.equal(rejected.original, read.promise); assert.equal(rejected.reason, reason); assert.equal(witness.matches(rejected), true, mode);
    } else await assert.rejects(store.retire(), AggregateError, mode);
    downstream.releaseLock();
  }
});

test("ZAI outcome overlay and original falsey throws fail closed", () => {
  const text = readFileSync(new URL("../worker/proxy.ts", import.meta.url), "utf8");
  assert.throws(() => workerOutcomeOverlay(text + "\n", "proxy.ts"), assert.AssertionError);
  for (const reason of [undefined, false, null]) {
    class Operation { get status() {} get delivery() {} get receivedRejection() { return false; } cancel() { throw reason; } stop() { throw reason; } acceptRejection() { throw reason; } }
    const life = originalLifetime(); createWorkerOutcomeWitness(Operation, life, []);
    for (const method of ["cancel", "stop", "acceptRejection"]) { let caught = false; try { new Operation()[method]("caller", reason); } catch (actual) { caught = true; assert.equal(actual, reason); } assert.equal(caught, true); }
    life.restore();
  }
});

test("actual ZAI Worker cancellation joins source and preserves its rejected read", { timeout: 45_000 }, async () => {
  const { startBundledWorkerdFixture } = await import("./helpers/workerd.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-zai-cancel-")); let mf;
  await allFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleZaiOutcome(routerFixture()), upstreamFixture(), { directRouter: true });
    const id = "control_cancel", kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put("policies/zai_" + id, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: ["zai"], models: ["zai/glm-5.3"],
      grantRouting: { eligibleGrants: { zai: ["zai"] }, environmentFallback: false }, monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
    await kv.put("credentials/zai_" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: "zai_" + id, policyGeneration: "fixture" }));
    await kv.put("connections/zai", JSON.stringify({ providerId: "zai", enabled: true }));
    const origin = (await mf.unsafeGetDirectURL("router")).origin, caller = new AbortController();
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const response = await fetch(origin + "/v1/native/zai/chat/completions", { method: "POST", signal: caller.signal,
      headers: { authorization: "Bearer clawrouter-live-zai_control_cancel-fixture-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "zai_control_cancel" }] }) });
    assert.equal(response.status, 200); const reader = response.body.getReader(); let bytes = 0;
    while (bytes < 180) { const next = await reader.read(); assert.equal(next.done, false); bytes += next.value.length; }
    const reason = new Error("owned local client cancellation"); caller.abort(reason);
    await reader.cancel().catch(error => { assert.equal(error, reason); }); reader.releaseLock();
    const control = await fetch(origin + "/fixture/control?id=" + id, { signal: AbortSignal.timeout(15_000) }), proof = await control.json();
    assert.equal(control.status, 200, JSON.stringify(proof)); assert.equal(proof.router.pending, 0); assert.equal(proof.router.rejected, 1);
    assert.equal(proof.router.qualifiedReadRejections, 1); assert.equal(proof.upstream.rejected, 0); assert.equal(proof.upstream.pending, 0);
    assert.equal(proof.expired, false); assert.equal(proof.calls, 1); assert.equal(proof.ingress, 1);
    const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].source, { cancelCalls: 1, cancelReturned: 1, settled: true, active: 0, failed: 0 });
    await verifyRegional(origin, nativeControlCases().find(row => row.id === id), calls);
    const retired = await fetch(origin + "/fixture/retire", { signal: AbortSignal.timeout(15_000) }); assert.equal(retired.status, 200);
  }, [async () => { await mf?.dispose(); }, () => rm(temporary, { recursive: true, force: true })]);
});

test("ZAI source failure independently retires and restores every router owner", async () => {
  const script = routerFixture();
  const start = script.indexOf('  if (new URL(request.url).pathname === "/fixture/control")');
  const end = script.indexOf('  if (new URL(request.url).pathname === "/fixture/rotate")');
  assert.ok(start >= 0 && end > start);
  const route = new Function("request", "controlOwners", "ownership", "sources", "originalFetch", "allFailures", "retireOwners", "ingress", "sourceProof",
    "return (async () => {" + script.slice(start, end) + "})()");
  for (const path of ["/fixture/control?id=control_cancel", "/fixture/retire"]) for (const mode of ["fetch_undefined", "fetch_false", "json_undefined", "status503"]) {
    const faults = [], attempts = [], sources = new Map([["control_cancel", { stale: true }]]);
    const makeOwner = name => ({ summary: () => ({ operations: 0, pending: 0, rejected: 0, qualifiedReadRejections: 0 }), failure: error => faults.push(error), async retire() {
      attempts.push(name); assert.equal(sources.size, 0, "failed source must never admit a read"); attempts.push(name + "-restore"); throw undefined;
    } });
    const ownership = makeOwner("global"), owner = makeOwner("control"), controlOwners = { control_cancel: owner };
    const originalFetch = async url => {
      if (mode === "fetch_undefined") throw undefined;
      if (mode === "fetch_false") throw false;
      return { status: mode === "status503" ? 503 : 200, async json() { if (mode === "json_undefined") throw undefined; return { proof: {}, calls: 1, source: {} }; } };
    };
    const response = await route(new Request("https://fixture.example" + path), controlOwners, ownership, sources, originalFetch, allFailures, retireOwners, {}, () => { throw new Error("failed source cannot be projected"); });
    assert.equal(response.status, 503, mode); assert.equal(faults.length, 1, mode);
    const error = faults[0]; assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2, mode);
    if (mode === "status503") assert.ok(error.errors[0] instanceof Error); else assert.equal(error.errors[0], mode === "fetch_false" ? false : undefined);
    if (path.startsWith("/fixture/control")) { assert.deepEqual(attempts, ["control", "control-restore"]); assert.equal(error.errors[1], undefined); }
    else { assert.deepEqual(attempts, ["global", "global-restore", "control", "control-restore"]); assert.ok(error.errors[1] instanceof AggregateError); assert.deepEqual(error.errors[1].errors, [undefined, undefined]); }
  }
});

test("ZAI embedded disposition binds exact handler output, request and three original rejections", async () => {
  const modes = ["matching", "disabled", "wrong_owner", "wrong_acquisition", "wrong_reader", "wrong_output", "wrong_error", "wrong_payload", "foreign_reason", "undefined_reason",
    "prior_read", "caller", "duplicate_handler", "duplicate_result", "failed_release", "failed_unlock", "observer_undefined", "restoration_undefined", "accessor_payload", "proxy_error"];
  for (const mode of modes) {
    class ControlledAPIError extends Error { constructor() { super("synthetic provider rejection"); this.status = undefined; this.code = "synthetic_error"; this.error = { message: "synthetic provider rejection", code: "synthetic_error" }; } }
    let active, getters = 0;
    const life = originalLifetime({ providerQualified: () => mode !== "disabled", current: () => active, apiPrototype: ControlledAPIError.prototype, isProxy: nodeTypes.isProxy });
    const owner = life.bind({ caseId: "embedded_error", outcome: "embedded", role: "chat", verified: true }); active = owner;
    if (mode === "caller") owner.caller.signal = new AbortController().signal;
    const input = new AbortController(); let source;
    const body = new ReadableStream({ start(controller) { source = controller; } }, { highWaterMark: 0 });
    const response = new Response(body), release = mode === "failed_release" ? Promise.reject(undefined) : Promise.resolve(); void release.catch(() => {});
    const result = await life.acquire(() => Promise.resolve({ response, release: () => release }), undefined, [{ signal: input.signal }], owner);
    const reader = body.getReader(), reading = reader.read(), closed = reader.closed;
    const reason = mode === "undefined_reason" ? undefined : new Error("private SDK abort"), other = new Error("independent read");
    if (mode === "prior_read") { source.error(reason); await Promise.allSettled([reading, closed]); }
    input.abort(reason);
    if (mode !== "prior_read") source.error(mode === "foreign_reason" ? other : reason);
    const cancellation = reader.cancel(); await Promise.allSettled([reading, closed, cancellation]);
    if (mode === "failed_unlock") assert.throws(() => Reflect.apply(reader.releaseLock, {}, []));
    reader.releaseLock(); await Promise.allSettled([result.release()]);
    let error = new ControlledAPIError();
    if (mode === "wrong_error") error = new Error("synthetic provider rejection");
    if (mode === "wrong_payload") error.error.message = "unrelated";
    if (mode === "accessor_payload") Object.defineProperty(error, "error", { get() { getters++; throw undefined; } });
    if (mode === "proxy_error") error = new Proxy(error, { get() { getters++; throw undefined; } });
    const output = { stopReason: "error", errorMessage: "synthetic provider rejection" }, params = { error, output, signal: owner.caller.signal };
    if (mode === "wrong_owner") active = { ...owner };
    life.providerError(params); if (mode === "duplicate_handler") life.providerError(params);
    owner.terminal = { stopReason: "error" };
    life.providerResult(owner, mode === "wrong_output" ? { ...output } : output); if (mode === "duplicate_result") life.providerResult(owner, output);
    if (mode === "wrong_acquisition") life.readers[0].acquisition = {};
    if (mode === "wrong_reader") life.operations.find(op => op.kind === "read").reader = { ...life.readers[0] };
    if (mode === "observer_undefined") life.failure(undefined);
    if (mode === "restoration_undefined") life.onRestore(() => { throw undefined; });
    if (mode === "matching") {
      await life.join(); assert.deepEqual(life.inspect().providerCandidates.map(op => op.kind).sort(), ["cancel", "closed", "read"]);
      assert.equal(life.summary().rejected, 3); assert.equal(life.operations.find(op => op.kind === "read").original, reading);
      assert.ok(life.inspect().rejected.every(op => op.reason === reason && op.reason !== error));
    } else if (mode !== "restoration_undefined") await assert.rejects(life.join(), AggregateError, mode);
    if (mode === "restoration_undefined") { await life.join(); assert.throws(() => life.restore(), error => error instanceof AggregateError && error.errors[0] === undefined); }
    else life.restore();
    assert.equal(getters, 0, mode);
  }
});

test("ZAI actual failure callback preserves receiver, operands and falsey original throws", () => {
  const start = sdkSource.indexOf('function (...args: Parameters<typeof originalSdkFailure>)');
  const end = sdkSource.indexOf('});', start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes('const hook = ' + sdkSource.slice(start, end + 1) + ';');
  for (const reason of [undefined, false, null]) {
    const life = originalLifetime({ current: () => { throw undefined; } }), receiver = {}, args = [{ error: reason, output: {}, signal: undefined }];
    let calls = 0;
    const original = function (...actual) { calls++; assert.equal(this, receiver); assert.deepEqual(actual, args); throw reason; };
    const callback = new Function('lifetime', 'originalSdkFailure', code + ';return hook;')(life, original);
    let caught = false; try { Reflect.apply(callback, receiver, args); } catch (actual) { caught = true; assert.equal(actual, reason); }
    assert.equal(caught, true); assert.equal(calls, 1); assert.deepEqual(life.inspect().structural, [undefined]); life.restore();
  }
});
