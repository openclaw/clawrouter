import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "addccb3274d885d3e06fb4662e0a620e8829523a";
for (const routeKind of ["native", "manifest"]) {
const searchPath = routeKind === "native" ? "/v1/native/perplexity/search" : "/v1/proxy/perplexity/search";
const cases = [
  ...["standard", "fixed", "spurious", "default_count", "utf8", "rotated", "empty", "malformed", "error", "invalid_request", "rate_limit", "oversized", "cancel"].map(id => ({ id })),
  ...["invalid", "foreign", "budget", "revoked", "preabort", "blank", "count", "utf8_over", "retired"].map(id => ({ id, denied: true })),
];
const charged = cases.filter(row => !row.denied), ownerId = id => "psearch_" + id;
const token = id => "clawrouter-live-psearch_" + id + "-fixture-secret";
const secret = id => "synthetic-psearch-" + id + (id === "rotated" ? "-new" : "");
const status = id => id === "error" ? 503 : id === "invalid_request" ? 400 : id === "rate_limit" ? 429 : 200;
const fixtureText = readFileSync(new URL("./fixtures/openclaw-perplexity-search-contract.test.ts", import.meta.url), "utf8");
// One implementation, reused as source. No Qianfan runtime evidence transfers.
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
const observerSource = donor.slice(start, end), observerCode = stripTypeScriptTypes(observerSource);
const observerSHA = "cf00bd435b61c4b49fdad7bd6b95ed683238c4ba469c71f4df18af25655463d1";
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings };")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
function searchLifetimeSource(text) {
  const anchor = "  function providerError(params: any) {";
  assert.equal(text.split(anchor).length, 2);
  text = text.replace(anchor, String.raw`  function searchBodyCancelDisposition(op: OriginalOperation) {
    if (!sdk?.bodySucceeded() || op.kind !== "body.cancel" || op.state !== "rejected" || op.reason === undefined) return false;
    const owner = op.owner, acquisition = op.acquisition, caller = owner?.callerObservation;
    const body = acquisition?.result?.response?.body, reason = op.reason;
    if (!sdk.bindings.includes(owner) || owner.id !== "cancel" || owner.kind !== "chat" || owner.method !== "POST" || !owner.claimed
      || sdk.bindings.filter(item => item.id === "cancel" && item.kind === "chat").length !== 1
      || guards.filter(item => item.owner === owner).length !== 1 || !guards.includes(acquisition)
      || op.receiver !== body || bodyOwners.get(body) !== owner || op.guardSignal !== acquisition.guardSignal
      || !bodies.some(item => item.body === body && item.owner === owner && item.acquisition === acquisition)
      || !Array.isArray(op.operands) || op.operands.length !== 0) return false;
    if (!owner.caller || caller?.signal !== owner.caller || !caller.abort || !owner.caller.aborted
      || caller.abort.reason !== reason || owner.caller.reason !== reason || !owner.partialDelivery
      || !(caller.entered < owner.partialSequence && owner.partialSequence < caller.abort.sequence)
      || !op.signalAtInvoke.aborted || op.signalAtInvoke.reason !== reason) return false;
    const rows = readers.filter(row => row.body === body && row.owner === owner && row.acquisition === acquisition);
    if (rows.length !== 1) return false;
    const row = rows[0], related = operations.filter(item => item.reader === row);
    const closed = related.filter(item => item.kind === "reader.closed"), rejectedReads = related.filter(item => item.kind === "reader.read" && item.state === "rejected");
    const cancels = operations.filter(item => item.kind === "body.cancel" && item.owner === owner && item.acquisition === acquisition);
    const releases = operations.filter(item => item.kind === "release" && item.owner === owner && item.acquisition === acquisition);
    return closed.length === 1 && closed[0].pending === row.closed && closed[0].reason === reason && sdkAbortDisposition(closed[0])
      && rejectedReads.length === 1 && rejectedReads[0].reason === reason && sdkAbortDisposition(rejectedReads[0])
      && closed[0].settled! < op.invoked && rejectedReads[0].settled! < op.invoked
      && row.receivedBody === body && !body.locked && row.unlocks === 1 && row.unlocked === 1
      && row.unlockReturns.length === 1 && row.unlockReturns[0] < op.invoked
      && cancels.length === 1 && cancels[0] === op
      && acquisition.releaseCalls === 1 && releases.length === 1 && releases[0].state === "fulfilled"
      && releases[0].invoked > op.invoked && releases[0].pending && typeof releases[0].pending.then === "function";
  }
` + anchor);
  const verdict = "sdkAbortDisposition(op) || sdkProviderErrorDisposition(op)";
  assert.equal(text.split(verdict).length, 2);
  return text.replace(verdict, "sdkAbortDisposition(op) || searchBodyCancelDisposition(op) || sdkProviderErrorDisposition(op)");
}
const assembledFixture = fixtureText.replace(marker, searchLifetimeSource(observerSource));

const workerOutcomePins = {"proxy.ts": "5afd5b549162f1f2cc722e3fc241807597ee31819d5fc4c21bce40122c2aa9e7", "proxy-response.ts": "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
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
      '    const reader = response.body!.getReader(), input = inputRetirement(reader);\n    qianfanOutcome.current.bind(operation, response, reader);');
    edit('              const next = await input.read(() => reader.read());',
      '              qianfanOutcome.current.readStart(operation, reader);\n              const next = await input.read(() => reader.read());\n              qianfanOutcome.current.readDone(operation, reader);');
    edit('            } catch (error) {\n              if (!stopped)',
      '            } catch (error) {\n              qianfanOutcome.current.failure(operation, reader, error);\n              if (!stopped)');
  } else {
    assert.equal(name, "proxy-response.ts");
    // Search bypasses the ordinary Chat completion wrapper. Its original
    // fetched reader belongs directly to observeUsage, not to a forwarded body.
    edit('  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);',
      '  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);\n  if (responseFormat === "perplexity.search") qianfanOutcome.current.bind(operation, response, reader);');
    edit('        const next = await input.read(() => reader.read());',
      '        if (responseFormat === "perplexity.search") qianfanOutcome.current.readStart(operation, reader);\n        const next = await input.read(() => reader.read());\n        if (responseFormat === "perplexity.search") qianfanOutcome.current.readDone(operation, reader);');
    edit('      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }',
      '      } catch (error) { if (responseFormat === "perplexity.search") qianfanOutcome.current.failure(operation, reader, error); if (!finished) { finish("failed", error); controller.error(error); } }');
    edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    if (responseFormat === "perplexity.search") searchDelivery.current.record(operation, response, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { qianfanOutcome, searchDelivery } from "qianfan-outcome-witness";\n' + text;
}
async function bundleSearchOutcome(contents) {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "qianfan-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "qianfan-first-outcome", setup(build) {
      build.onResolve({ filter: /^qianfan-outcome-witness$/ }, () => ({ path: "witness", namespace: "qianfan" }));
      build.onLoad({ filter: /.*/, namespace: "qianfan" }, () => ({ contents: "export const qianfanOutcome = { current: undefined }, searchDelivery = { current: undefined };", loader: "js" }));
      build.onLoad({ filter: /[/\\]worker[/\\](?:proxy|proxy-response|http-operation)\.ts$/ }, args => {
        const name = args.path.split(/[/\\]/).at(-1), source = readFileSync(args.path, "utf8");
        assert.equal(createHash("sha256").update(source).digest("hex"), workerOutcomePins[name]);
        return { contents: name !== "http-operation.ts" ? workerOutcomeOverlay(source, name) : source, loader: "ts" };
      });
    } }],
  });
  return bundle.outputFiles[0].text;
}


function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof));
  assert.equal(proof.settled, proof.operations); assert.equal(proof.readers, proof.unlocked);
  assert.equal(proof.rejected, proof.qualifiedReadRejections ?? 0);
}

function createSearchDeliveryWitness(lifetime, ingress, outbound, Operation, originalFetch) {
  const records = new Map();
  const own = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Search witness requires an original data property");
    return descriptor.value;
  };
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  return {
    record(operation, response, delivery) {
      try {
        require(Object.getPrototypeOf(operation) === Operation.prototype, "foreign Search operation");
        const signal = own(operation, "signal"), caller = own(operation, "caller");
        const owners = outbound.filter(owner => owner.signal === signal && owner.claimed);
        require(owners.length === 1, "Search delivery requires one outbound owner");
        const owner = owners[0], incoming = owner.ingress;
        require(ingress.includes(incoming) && incoming.claimed && incoming.signal === caller && incoming.request
          && owner.id === incoming.id && owner.kind === "chat" && incoming.kind === "chat"
          && owner.method === "POST" && incoming.method === "POST", "Search ingress/outbound binding changed");
        const fetched = lifetime.operations.filter(op => op.kind === "fetch" && op.owner === owner);
        require(fetched.length === 1 && fetched[0].original === originalFetch && fetched[0].pending
          && fetched[0].state === "fulfilled" && fetched[0].value === response, "Search original response binding changed");
        require(["complete", "canceled", "failed"].includes(delivery), "unknown Search delivery state");
        require(!records.has(owner), "duplicate Search delivery observation");
        records.set(owner, { owner, incoming, operation, response, status: response.status, delivery });
      } catch (error) { lifetime.errors.push(error); }
    },
    snapshot() {
      const requestIds = new Set();
      return [...records.values()].map(row => {
        const handlers = lifetime.operations.filter(op => op.kind === "handler" && op.owner === row.incoming);
        require(handlers.length === 1 && handlers[0].state === "fulfilled" && handlers[0].pending
          && handlers[0].operands[0] === row.incoming.request, "Search original ingress handler incomplete");
        const reply = handlers[0].value, requestId = reply.headers.get("x-clawrouter-request-id");
        require(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128
          && !requestIds.has(requestId) && reply.status === row.status, "Search request ID/status binding changed");
        requestIds.add(requestId);
        return { id: row.owner.id, requestId, status: row.status, delivery: row.delivery };
      });
    },
  };
}

function freeSearchEnvelope(id) {
  assert.ok(["invalid_request", "rate_limit"].includes(id));
  return { error: { message: id === "invalid_request" ? "synthetic invalid request" : "synthetic rate limit", type: id, code: status(id) } };
}

function searchExpectedReceipt(id, delivery) {
  if (["invalid_request", "rate_limit"].includes(id)) {
    assert.ok(delivery && delivery.id === ownerId(id) && delivery.status === status(id), id + " exact free-error delivery binding");
    assert.ok(["complete", "canceled", "failed"].includes(delivery.delivery), id + " known raw delivery");
    return delivery.delivery === "complete" ? { cost: 0, basis: "none" } : { cost: 5000, basis: "manifest_request_reservation" };
  }
  return id === "fixed" ? { cost: 7, basis: "policy_fixed" }
    : { cost: 5000, basis: ["malformed", "error", "cancel", "oversized"].includes(id) ? "manifest_request_reservation" : "manifest_request" };
}

function searchExpectedStatus(id, delivery) {
  if (id === "oversized") {
    assert.ok(delivery && delivery.id === ownerId(id) && delivery.status === 200, "oversized original delivery binding");
    assert.ok(["complete", "canceled"].includes(delivery.delivery), "oversized delivery must complete or cancel without an independent failure");
    // The SDK's 1 MiB read limit and the Worker's 2 MiB inspection limit
    // belong to separate owners. SDK rejection cannot establish Worker cancellation.
    return delivery.delivery === "complete" ? "success" : "client_error";
  }
  return status(id) >= 500 ? "provider_error" : status(id) >= 400 || id === "cancel" ? "client_error" : "success";
}

function validateSearchLimit(record) {
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  assert.deepEqual(Object.keys(record).sort(), ["id", "limitBytes", "readBytes", "readOperations", "readerCount"]);
  assert.equal(record.id, "oversized"); assert.equal(record.limitBytes, 1024 * 1024); assert.equal(record.readerCount, 1);
  assert.ok(Number.isSafeInteger(record.readBytes) && record.readBytes > record.limitBytes);
  assert.ok(Number.isSafeInteger(record.readOperations) && record.readOperations > 0);
  return record;
}


function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome, searchDelivery } from "qianfan-outcome-witness";
${observerCode}
${createSearchDeliveryWitness.toString()}
const cases = ${JSON.stringify(cases)}, ingress = createRequestBindings(), outbound = createRequestBindings();
let sourceCancellation, acceptedConsumer = false;
const lifetime = createLifetimeObserver(undefined, { ownerId: "psearch_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of cases.filter(row => !row.denied)) {
  ingress.expect("psearch_" + row.id, "chat", ${JSON.stringify(searchPath)}, "POST", "clawrouter-live-psearch_" + row.id + "-fixture-secret");
  outbound.expect("psearch_" + row.id, "chat", "https://api.perplexity.ai/search", "POST", "synthetic-psearch-" + row.id + (row.id === "rotated" ? "-new" : ""));
}
const originalFetch = globalThis.fetch;
searchDelivery.current = createSearchDeliveryWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation, originalFetch);
lifetime.patch(globalThis, "fetch", function (...args) {
  const owner = outbound.claim(args[0], args[1], "chat");
  owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
  if (!owner.ingress) throw new Error("unbound Search outbound request");
  lifetime.signal(owner, args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined));
  return lifetime.invoke("fetch", originalFetch, this, args, owner, response => lifetime.response(response, owner));
});
async function retire(request) {
  let accepted = false;
  try { await preserveFailures(async () => {
    const proof = await request.json(); sourceCancellation = proof.sourceCancellation; acceptedConsumer = proof.acceptedConsumer === true;
    await lifetime.join(); ingress.verify(); outbound.verify();
  }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
  return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() });
}
const configured = env => ({ ...env, PERPLEXITY_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" });
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const row of cases) if (row.id !== "invalid") await putGrantCredentials(env, "oauth/psearch_" + row.id + "/perplexity", { provider: "perplexity", kind: "api_key", enabled: true, credential: "synthetic-psearch-" + row.id });
    await putGrantCredentials(env, "oauth/psearch_rotated/perplexity", { provider: "perplexity", kind: "api_key", enabled: true, credential: "synthetic-psearch-rotated-new" });
    await revokeGrantCredentials(env, "oauth/psearch_revoked/perplexity", { provider: "perplexity", kind: "api_key" });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (path === "/fixture/search-deliveries") return Response.json(searchDelivery.current.snapshot());
  if (path !== ${JSON.stringify(searchPath)}) return handler.fetch(request, configured(env), context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = ingress.claim(request, undefined, "chat"); owner.request = request; lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, configured(env), context], owner);
} };`;
}

function upstreamFixture() {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [], owners = new Map();
for (const row of ${JSON.stringify(charged)}) bindings.expect("psearch_" + row.id, "chat", "https://api.perplexity.ai/search", "POST", "synthetic-psearch-" + row.id + (row.id === "rotated" ? "-new" : ""));
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const id = owner.id.slice("psearch_".length), call = { id, url: request.url, authorization: request.headers.get("authorization"), body, cancelled: false, expired: false };
  calls.push(call); owners.set(owner, call);
  const page = { title: "Synthetic result", url: "https://example.com/result", snippet: "Synthetic snippet", date: null, last_updated: null };
  const payload = id === "malformed" ? { id: "synthetic", results: {} }
    : id === "error" ? { error: { message: "synthetic upstream failure", type: "upstream_error", code: 503 } }
    : id === "invalid_request" ? { error: { message: "synthetic invalid request", type: "invalid_request", code: 400 } }
    : id === "rate_limit" ? { error: { message: "synthetic rate limit", type: "rate_limit", code: 429 } }
    : { id: "synthetic-" + id, results: id === "empty" ? [] : id === "oversized" ? [{ ...page, snippet: "x".repeat(2 * 1024 * 1024 + 256) }] : [page, { ...page, url: "javascript:alert(1)" }], server_time: null,
        ...(id === "spurious" ? { usage: { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 } } : {}) };
  const wire = id === "cancel" ? '{"id":"synthetic-cancel","results":[' : JSON.stringify(payload);
  const bytes = new TextEncoder().encode(wire); let offset = 0, heartbeat, wake, expiry, controller, complete = false;
  if (["invalid_request", "rate_limit", "oversized"].includes(id)) call.response = { status: id === "oversized" ? 200 : payload.error.code, bytes: bytes.length,
    sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("") };
  let resolveProducer, rejectProducer;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("Search source deadline"); finish(true, error); controller?.error(error); }, 10000);
  const source = {
    start(value) { controller = value; },
    pull(value) {
      if (offset < bytes.length) { const end = Math.min(offset + (id === "oversized" ? 8192 : 7), bytes.length); value.enqueue(bytes.slice(offset, end)); offset = end; return; }
      if (id !== "cancel") { value.close(); finish(false); return; }
      const pending = new Promise(resolve => { wake = resolve; heartbeat = setTimeout(() => { if (!complete) value.enqueue(new TextEncoder().encode(" ")); resolve(); }, 50); });
      return lifetime.watch("source.heartbeat", pending, owner);
    },
    cancel() { call.cancelled = true; finish(false); },
  };
  for (const kind of ["pull", "cancel"]) { const original = source[kind]; lifetime.patch(source, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { status: id === "error" ? 503 : id === "invalid_request" ? 400 : id === "rate_limit" ? 429 : 200, headers: { "content-type": "application/json" } });
}
export default { fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    const owner = bindings.bindings.find(row => row.id === "psearch_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
    const sourceCancellation = { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true,
      cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: owned.filter(op => op.state === "pending").length,
      failed: owned.filter(op => !["pending", "fulfilled"].includes(op.state)).length };
    return Response.json({ ...lifetime.summary(), accepted, sourceCancellation });
  })();
  const owner = bindings.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}

async function setup(mf) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const row of cases.filter(row => row.id !== "invalid")) {
    const id = ownerId(row.id);
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "google" : "perplexity"],
      grantRouting: { eligibleGrants: { perplexity: ["perplexity"] }, environmentFallback: false },
      tenantId: "fixture", monthlyBudgetMicros: row.id === "budget" ? 0 : 100000,
      budgetMode: "reserve", requestCostMicros: row.id === "fixed" ? 7 : null, retainRequestContent: false }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/perplexity", JSON.stringify({ providerId: "perplexity", enabled: true, monthlyBudgetMicros: 10000000 }));
  const origin = String(await mf.unsafeGetDirectURL("router")).replace(/\/$/, "");
  const response = await fetch(origin + "/fixture/grants"); assert.equal(response.status, 204); await response.arrayBuffer();
  const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token("standard") } });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json(), provider = catalog.providers.find(row => row.id === "perplexity");
  assert.equal(catalog.scope.credentialId, ownerId("standard"));
  const offers = provider.offers.filter(row => row.endpoint === "search" && row.modelId === null && row.eligible);
  assert.ok(offers.some(row => row.routeKind === "native" && row.route === "/v1/native/perplexity/search"));
  assert.equal(offers.some(row => row.routeKind === "manifest"), false, "shipping catalog advertises the native route; direct manifest transport is not SDK offer proof");
  return origin;
}

async function verifyCallsAndUsage(mf, origin, native, sdkLimit) {
  if (native) validateSearchLimit(sdkLimit);
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
  assert.deepEqual(calls.map(call => call.id).sort(), charged.map(row => row.id).sort(), "one original selected dispatch per admitted attempt");
  for (const call of calls) {
    assert.equal(call.url, "https://api.perplexity.ai/search", call.id); assert.equal(call.authorization, "Bearer " + secret(call.id), call.id);
    assert.deepEqual(call.body, { query: call.id === "utf8" ? "界".repeat(2730) + "ab" : "synthetic query", max_results: call.id === "default_count" ? 5 : 2 }, call.id);
    assert.equal(call.expired, false, call.id); assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    if (call.id === "oversized") {
      assert.equal(call.response.status, 200, call.id);
      assert.ok(call.response.bytes > 2 * 1024 * 1024, "oversized original source crosses the Worker inspection bound");
      assert.match(call.response.sha256, /^[a-f0-9]{64}$/);
      if (native) assert.ok(sdkLimit.readBytes <= call.response.bytes, "SDK retained bytes belong to this original oversized body");
    }
    if (["invalid_request", "rate_limit"].includes(call.id)) {
      const bytes = Buffer.from(JSON.stringify(freeSearchEnvelope(call.id)));
      assert.deepEqual(call.response, { status: status(call.id), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, call.id + " original qualified error bytes");
    }
  }
  const observedFree = [];
  for (const row of cases.filter(row => row.id !== "invalid")) {
    let usage, delivery, expected;
    for (let attempt = 0; attempt < 150; attempt++) {
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(row.id) } })).json();
      if (row.denied) break;
      if (usage.usage.events.length === 1) {
        if (!delivery) {
          const response = await fetch(origin + "/fixture/search-deliveries"); assert.equal(response.status, 200, row.id + " delivery witness");
          const matches = (await response.json()).filter(item => item.id === ownerId(row.id));
          assert.equal(matches.length, 1, row.id + " one original delivery"); delivery = matches[0];
          assert.equal(delivery.status, status(row.id), row.id + " original status");
          assert.equal(usage.usage.events[0].request_id, delivery.requestId, row.id + " exact original request ID");
          expected = searchExpectedReceipt(row.id, delivery);
        }
        // The event is already final. Never poll for its cost to change; only
        // the independently settled budget may still be catching up.
        assert.equal(usage.usage.events[0].actual_cost_micros, expected.cost, row.id + " cost for " + delivery.delivery);
        if (usage.budget.spentMicros === expected.cost) break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (row.denied) { assert.equal(usage.usage.events.length, 0, row.id + " has no search attempt"); assert.equal(usage.budget.spentMicros, 0, row.id); continue; }
    assert.equal(usage.usage.events.length, 1, row.id + " attempt-bound receipt");
    const [event] = usage.usage.events;
    assert.equal(event.provider, "perplexity", row.id); assert.equal(event.model, null, row.id); assert.equal(event.capability, "web.search", row.id);
    assert.equal(event.credential_id, ownerId(row.id), row.id); assert.equal(event.policy_id, ownerId(row.id), row.id);
    assert.equal(event.request_id, delivery.requestId, row.id + " receipt request ID");
    assert.equal(event.actual_cost_micros, expected.cost, row.id); assert.equal(usage.budget.spentMicros, expected.cost, row.id + " settled budget");
    assert.equal(event.cost_basis, expected.basis, row.id + " receipt basis");
    assert.equal(event.status, searchExpectedStatus(row.id, delivery), row.id + " status for " + delivery.delivery);
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null], row.id);
    assert.doesNotMatch(JSON.stringify(event), /synthetic query|Synthetic snippet|fixture-secret|synthetic-psearch|must-not-fallback/);
    if (["invalid_request", "rate_limit", "oversized"].includes(row.id)) {
      if (!native) assert.equal(delivery.delivery, "complete", row.id + " direct caller drained the original response");
      observedFree.push({ id: row.id, status: delivery.status, delivery: delivery.delivery, cost: event.actual_cost_micros, basis: event.cost_basis });
    }
  }
  return observedFree;
}

async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "psearch_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}

async function runNative(t, fixture, origin, invoke = runOpenClawConsumer) {
  let receipts = 0; const limits = [];
  const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
    return text => {
      for (const line of text.split("\n").map(line => line.trim())) {
        if (line === "PERPLEXITY_SEARCH_CANCEL_RETIRED " + routeKind) receipts++;
        if (line.startsWith("PERPLEXITY_SEARCH_LIMIT ")) limits.push(validateSearchLimit(JSON.parse(line.slice("PERPLEXITY_SEARCH_LIMIT ".length))));
      }
      t.diagnostic(text);
    };
  } });
  await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/clawrouter/worker-perplexity-search-contract.test.ts",
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_PERPLEXITY_SEARCH_PHASE: routeKind, CLAWROUTER_API_KEY: "must-not-fallback", PERPLEXITY_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", NO_COLOR: "1" } });
  assert.equal(receipts, 1, "one exact native Search cancellation and cleanup receipt");
  assert.equal(limits.length, 1, "one original SDK oversized-reader and cleanup receipt");
  return limits[0];
}

test(routeKind + " Search native assembly binds the actual public client and independent row", () => {
  assert.match(assembledFixture, /createWebSearchTool/); assert.match(assembledFixture, /createOpenClawTestState/);
  assert.doesNotMatch(assembledFixture, /OWNED_LIFETIME_IMPLEMENTATION/);
  assert.equal(createHash("sha256").update(observerSource).digest("hex"), observerSHA);
  const rows = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")).jobs.consumer.strategy.matrix.include;
  assert.deepEqual(rows.filter(row => row.consumer === "perplexity-search"), [{ consumer: "perplexity-search", ref: sourceHead, test: "test/openclaw-perplexity-search.test.mjs" }]);
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.equal(rows.find(row => row.consumer === "provider-responses").ref, "d8bb939408aa4d2be7df0161748edb52ebf3b1fb");
  assert.equal(rows.find(row => row.consumer === "search").ref, "0a5f30f82d33eae69d10c5a5ceecd01bdb9706e7");
});
test(routeKind + " Search runner rejects missing, foreign and duplicated receipts", async () => {
  const origin = "https://fixture.example", receipt = "PERPLEXITY_SEARCH_CANCEL_RETIRED " + routeKind;
  const limit = { id: "oversized", limitBytes: 1048576, readBytes: 1048577, readOperations: 17, readerCount: 1 };
  const limitReceipt = "PERPLEXITY_SEARCH_LIMIT " + JSON.stringify(limit);
  const invoke = lines => async (context, options) => {
    assert.equal(options.sourceHead, sourceHead); assert.equal(options.testPath, "extensions/clawrouter/worker-perplexity-search-contract.test.ts");
    assert.equal(options.env.CLAWROUTER_PERPLEXITY_SEARCH_PHASE, routeKind); assert.equal(options.env.CLAWROUTER_CONTRACT_ORIGIN, origin);
    assert.equal(options.env.PERPLEXITY_API_KEY, "must-not-fallback"); assert.equal(options.env.CLAWROUTER_API_KEY, "must-not-fallback");
    for (const line of lines) context.diagnostic(line);
  };
  assert.deepEqual(await runNative({ diagnostic() {} }, "/synthetic/search.ts", origin, invoke([receipt, limitReceipt])), limit);
  for (const lines of [[], ["RESPONSES_CANCEL_RETIRED perplexity"], [receipt, receipt], ["PERPLEXITY_SEARCH_CANCEL_RETIRED " + (routeKind === "native" ? "manifest" : "native")]])
    await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/search.ts", origin, invoke([...lines, limitReceipt])));
  for (const limits of [[], [limitReceipt, limitReceipt], ["PERPLEXITY_SEARCH_LIMIT {}"], ["PERPLEXITY_SEARCH_LIMIT invalid"]])
    await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/search.ts", origin, invoke([receipt, ...limits])));
});
test(routeKind + " Search observed guard retains wrapped unexpected dispatch and exact rejection identity", async () => {
  const begin = fixtureText.indexOf("function observedGuard("), end = fixtureText.indexOf("async function runCase(", begin);
  assert.ok(begin >= 0 && end > begin);
  const factory = new Function("originalGuard", "origin", stripTypeScriptTypes(fixtureText.slice(begin, end)) + "; return observedGuard;");
  for (const failure of [undefined, null, new Error("unexpected synthetic dispatch")]) {
    const lifetime = createLifetimeObserver(); let called = 0;
    const observed = factory(() => { called++; }, "https://fixture.example")(lifetime, { claim() { throw failure; } });
    // The actual SDK can wrap this exception as an ordinary result. The
    // independent observer must still reject final verification.
    const wrapped = await Promise.resolve().then(() => observed({ url: "https://fixture.example/search", init: {} })).catch(error => ({ error }));
    assert.ok("error" in wrapped); assert.strictEqual(wrapped.error, failure); assert.equal(called, 0);
    await assert.rejects(lifetime.join(), error => error.errors.some(value => Object.is(value, failure)));
  }
  const identityBegin = fixtureText.indexOf("function assertOriginalRejection("), identityEnd = fixtureText.indexOf("async function waitForOriginalRead(", identityBegin);
  const check = new Function("assert", stripTypeScriptTypes(fixtureText.slice(identityBegin, identityEnd)) + "; return assertOriginalRejection;")(assert);
  const reason = new Error("same message"); check({ error: reason }, reason); check({ error: undefined }, undefined);
  assert.throws(() => check({ error: new Error("same message") }, reason));
  assert.throws(() => check({ value: undefined }, undefined));
});
test(routeKind + " Search body cancellation requires the original owned abort and complete independent cleanup", async () => {
  const { createLifetimeObserver: createSearchObserver, createRequestBindings: createBindings } = new Function(stripTypeScriptTypes(searchLifetimeSource(observerSource)) + "; return { createLifetimeObserver, createRequestBindings };")();
  async function scenario(mode) {
    const bindings = createBindings(), caller = new AbortController(), reason = new Error("synthetic caller");
    let succeeded = false, controller, releaseHeld, joined = false, released = 0;
    const life = createSearchObserver({ bindings: bindings.bindings, bodySucceeded: () => succeeded });
    const owner = bindings.expect(mode === "foreign-owner" ? "foreign" : "cancel", "chat", "https://fixture.example/search", "POST", "fixture", caller.signal);
    bindings.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture" } }, "chat");
    owner.callerObservation = {}; life.signal(owner.callerObservation, caller.signal); life.signal(owner, caller.signal);
    const response = new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(new Uint8Array([1])); } }));
    const original = Promise.resolve({ response, release: async () => {
      released++;
      if (mode.startsWith("release-")) throw mode === "release-undefined" ? undefined : mode === "release-null" ? null : reason;
    } });
    assert.strictEqual(life.guard(() => original, undefined, [], owner), original);
    const acquired = await original, reader = response.body.getReader();
    await reader.read(); const pending = reader.read(), closed = reader.closed, settled = Promise.allSettled([pending, closed]);
    if (mode !== "no-progress") life.partial(owner);
    if (mode === "preexisting-error") { controller.error(reason); await settled; caller.abort(reason); }
    else {
      caller.abort(reason);
      controller.error(mode === "wrong-reason" ? new Error("synthetic independent failure") : mode === "undefined-reason" ? undefined : reason);
      await settled;
    }
    if (mode === "premature") await response.body.cancel().catch(() => {});
    reader.releaseLock();
    if (mode === "foreign-body") {
      const other = new ReadableStream({ start(value) { value.error(reason); } });
      await response.body.cancel.call(other).catch(() => {});
    } else if (mode !== "premature") {
      await response.body.cancel().catch(() => {});
      if (mode === "duplicate") await response.body.cancel().catch(() => {});
    }
    await acquired.release().catch(() => {});
    if (mode === "independent" || mode === "independent-undefined") life.watch("waitUntil", Promise.reject(mode === "independent" ? reason : undefined), owner);
    if (mode === "observer-undefined") life.errors.push(undefined);
    if (mode === "held") life.watch("source.completion", new Promise(resolve => { releaseHeld = resolve; }), owner);
    succeeded = true;
    const joining = life.join().then(() => { joined = true; return { accepted: true }; }, error => { joined = true; return { accepted: false, error }; });
    if (mode === "held") { await Promise.resolve(); await Promise.resolve(); assert.equal(joined, false); releaseHeld(); }
    const result = await joining;
    assert.equal(released, 1);
    assert.ok(life.operations.some(op => op.kind === "body.cancel" && op.state === "rejected"), "raw rejected original is preserved");
    assert.equal(result.accepted, mode === "owned" || mode === "held", mode);
    await life.restore();
  }
  for (const mode of ["owned", "held", "foreign-body", "foreign-owner", "wrong-reason", "undefined-reason", "preexisting-error", "no-progress", "premature", "duplicate", "release-same", "release-null", "release-undefined", "independent", "independent-undefined", "observer-undefined"]) await scenario(mode);
});
test(routeKind + " Search cleanup preserves independent falsey failures", async () => {
  const attempted = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempted.push(1); throw null; }, () => attempted.push(2)]),
    error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempted, [1, 2]);
});
test(routeKind + " Search original-operation ledger retains rejection and pending work", async () => {
  for (const reason of [undefined, null, new Error("synthetic independent cleanup")]) {
    const lifetime = createLifetimeObserver(); const original = Promise.reject(reason); original.catch(() => {});
    assert.equal(lifetime.watch("release", original, {}), original);
    await assert.rejects(lifetime.join(), error => error.errors.includes(reason));
  }
  const lifetime = createLifetimeObserver(); let release;
  const original = new Promise(resolve => { release = resolve; }); lifetime.watch("source.completion", original, {});
  let joined = false; const joining = lifetime.join().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false); release(); await joining; assert.equal(joined, true);
});
test(routeKind + " Search delivery witness requires exact operation, ingress, response and request ID", () => {
  const make = () => {
    class Operation { constructor(signal, caller) { this.signal = signal; this.caller = caller; } }
    const signal = {}, caller = {}, request = {}, originalFetch = () => {}, promise = Promise.resolve();
    const incoming = { id: "psearch_invalid_request", kind: "chat", method: "POST", claimed: true, signal: caller, request };
    const owner = { id: incoming.id, kind: "chat", method: "POST", claimed: true, signal, ingress: incoming };
    const response = new Response(null, { status: 400 }), reply = new Response(null, { status: 400, headers: { "x-clawrouter-request-id": "synthetic-request-1" } });
    const fetched = { kind: "fetch", owner, original: originalFetch, pending: promise, state: "fulfilled", value: response };
    const handler = { kind: "handler", owner: incoming, pending: promise, state: "fulfilled", operands: [request], value: reply };
    const lifetime = { operations: [fetched, handler], errors: [] }, operation = new Operation(signal, caller);
    return { witness: createSearchDeliveryWitness(lifetime, [incoming], [owner], Operation, originalFetch), lifetime, operation, response, incoming, owner, fetched, handler, reply };
  };
  for (const delivery of ["complete", "canceled", "failed"]) {
    const row = make(); row.witness.record(row.operation, row.response, delivery);
    assert.deepEqual(row.lifetime.errors, []);
    assert.deepEqual(row.witness.snapshot(), [{ id: "psearch_invalid_request", requestId: "synthetic-request-1", status: 400, delivery }]);
    row.witness.record(row.operation, row.response, delivery); assert.equal(row.lifetime.errors.length, 1);
  }
  for (const alter of [
    row => { row.operation = { ...row.operation }; }, row => { row.operation.signal = {}; }, row => { row.operation.caller = {}; },
    row => { row.owner.ingress = { ...row.incoming }; }, row => { row.incoming.claimed = false; }, row => { row.owner.id = "foreign"; },
    row => { row.incoming.method = "GET"; }, row => { row.fetched.value = new Response(null, { status: 400 }); },
    row => { row.fetched.state = "rejected"; }, row => { row.fetched.pending = undefined; }, row => { row.fetched.original = () => {}; },
  ]) {
    const row = make(); alter(row); row.witness.record(row.operation, row.response, "complete");
    assert.equal(row.lifetime.errors.length, 1); assert.deepEqual(row.witness.snapshot(), []);
  }
  for (const alter of [row => { row.handler.operands = [{}]; }, row => { row.handler.state = "pending"; },
    row => { row.reply.headers.delete("x-clawrouter-request-id"); }, row => { row.handler.value = new Response(null, { status: 429, headers: { "x-clawrouter-request-id": "synthetic-request-1" } }); }]) {
    const row = make(); row.witness.record(row.operation, row.response, "complete"); alter(row); assert.throws(() => row.witness.snapshot());
  }
  const accessor = make(); let reads = 0; Object.defineProperty(accessor.operation, "signal", { get() { reads++; throw undefined; } });
  accessor.witness.record(accessor.operation, accessor.response, "complete"); assert.equal(accessor.lifetime.errors.length, 1); assert.equal(reads, 0);
  const falsey = make(); falsey.operation = new Proxy(falsey.operation, { getPrototypeOf() { throw undefined; } });
  falsey.witness.record(falsey.operation, falsey.response, "complete"); assert.deepEqual(falsey.lifetime.errors, [undefined]);
});
test(routeKind + " Search free-error expectation follows independent delivery, never the usage receipt", () => {
  for (const id of ["invalid_request", "rate_limit"]) {
    const base = { id: ownerId(id), status: status(id) };
    assert.deepEqual(searchExpectedReceipt(id, { ...base, delivery: "complete" }), { cost: 0, basis: "none" });
    for (const delivery of ["canceled", "failed"]) assert.deepEqual(searchExpectedReceipt(id, { ...base, delivery }), { cost: 5000, basis: "manifest_request_reservation" });
    for (const observation of [undefined, { ...base, delivery: "unknown" }, { ...base, id: "foreign", delivery: "complete" }, { ...base, status: 503, delivery: "complete" }]) {
      assert.throws(() => searchExpectedReceipt(id, observation));
    }
  }
});
test(routeKind + " Search oversized outcome requires independent delivery and original SDK byte evidence", () => {
  const delivery = { id: "psearch_oversized", status: 200 };
  for (const [observed, expected] of [["complete", "success"], ["canceled", "client_error"]]) {
    assert.equal(searchExpectedStatus("oversized", { ...delivery, delivery: observed }), expected);
    assert.deepEqual(searchExpectedReceipt("oversized", { ...delivery, delivery: observed }), { cost: 5000, basis: "manifest_request_reservation" });
  }
  for (const row of [undefined, { ...delivery, delivery: "failed" }, { ...delivery, delivery: "unknown" },
    { ...delivery, delivery: "complete", id: "foreign" }, { ...delivery, delivery: "complete", status: 503 }])
    assert.throws(() => searchExpectedStatus("oversized", row));
  const limit = { id: "oversized", limitBytes: 1048576, readBytes: 1048577, readOperations: 17, readerCount: 1 };
  assert.strictEqual(validateSearchLimit(limit), limit);
  for (const patch of [{ id: "foreign" }, { limitBytes: 2097152 }, { readBytes: 1048576 }, { readBytes: Infinity },
    { readOperations: 0 }, { readerCount: 2 }, { extra: true }]) assert.throws(() => validateSearchLimit({ ...limit, ...patch }));

  const begin = fixtureText.indexOf("function searchLimitEvidence("), end = fixtureText.indexOf("async function waitForOriginalRead(", begin);
  assert.ok(begin >= 0 && end > begin);
  const check = new Function("assert", stripTypeScriptTypes(fixtureText.slice(begin, end)) + "; return searchLimitEvidence;")(assert);
  function make() {
    const owner = { id: "oversized", kind: "chat", claimed: true }, body = {}, acquisition = { owner, acquired: true, result: { response: { body } } };
    const reader = { owner, acquisition, body, receivedBody: body, reader: {} };
    const op = { owner, acquisition, reader, receiver: reader.reader, kind: "reader.read", pending: Promise.resolve(), state: "fulfilled", value: { done: false, value: new Uint8Array(1048577) } };
    return { owner, acquisition, reader, op, lifetime: { guards: [acquisition], readers: [reader], operations: [op] }, bindings: { bindings: [owner] } };
  }
  const good = make(); assert.deepEqual(check(good.lifetime, good.bindings), { ...limit, readOperations: 1 });
  for (const alter of [row => { row.owner.claimed = false; }, row => { row.acquisition.owner = {}; }, row => { row.acquisition.acquired = false; },
    row => { row.reader.acquisition = {}; }, row => { row.reader.receivedBody = {}; }, row => { row.reader.body = {}; },
    row => { row.op.owner = {}; }, row => { row.op.acquisition = {}; }, row => { row.op.receiver = {}; }, row => { row.op.pending = undefined; },
    row => { row.op.state = "rejected"; row.op.reason = undefined; }, row => { row.op.value.value = new Uint8Array(1048576); }]) {
    const row = make(); alter(row); assert.throws(() => check(row.lifetime, row.bindings));
  }
});
test(routeKind + " Search actual Worker transport and SQLite request receipts", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-psearch-worker-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleSearchOutcome(routerFixture()), upstreamFixture(), { directRouter: true }); const origin = await setup(mf);
    for (const row of charged) {
      const controller = new AbortController();
      const body = { query: row.id === "utf8" ? "界".repeat(2730) + "ab" : "synthetic query", max_results: row.id === "default_count" ? 5 : 2 };
      const response = await fetch(origin + searchPath, { method: "POST", headers: { authorization: "Bearer " + token(row.id), "content-type": "application/json" },
        body: JSON.stringify(routeKind === "manifest" ? { body } : body), signal: controller.signal });
      assert.equal(response.status, status(row.id));
      if (row.id === "cancel") {
        const reader = response.body.getReader(); const first = await reader.read(); assert.equal(first.done, false);
        const read = reader.read(); const closed = reader.closed; controller.abort(new Error("synthetic Search caller canceled"));
        await Promise.allSettled([read, closed]); reader.releaseLock();
      } else await response.arrayBuffer();
    }
    t.diagnostic("PERPLEXITY_SEARCH_DELIVERY direct-" + routeKind + " " + JSON.stringify(await verifyCallsAndUsage(mf, origin, false))); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
if (routeKind === "native") test(routeKind + " actual registered Search SDK through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-psearch-sdk-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleSearchOutcome(routerFixture()), upstreamFixture(), { directRouter: true }); const origin = await setup(mf);
    const fixture = join(temporary, "search-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    const sdkLimit = await runNative(t, fixture, origin); t.diagnostic("PERPLEXITY_SEARCH_DELIVERY SDK-" + routeKind + " " + JSON.stringify(await verifyCallsAndUsage(mf, origin, true, sdkLimit))); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
}
