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
import { runOpenClawConsumer, consumerTypecheckPlan } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "3206356e0fff73751495ca6a5c8cd4f3e97caf04";
const successes = ["success", "rotated", "count_ignored"];
const failures = ["malformed", "model_mismatch", "incomplete", "error", "oversized", "redirect"];
const charged = [...successes, ...failures, "cancel"];
const denied = ["invalid", "foreign", "budget", "revoked", "preabort", "blank", "count", "retired"];
const cases = [...charged, ...denied].map(id => ({ id, denied: denied.includes(id) }));
const ownerId = id => "xsearch_" + id;
const token = id => "clawrouter-live-" + ownerId(id) + "-fixture-secret";
const secret = id => "synthetic-xsearch-" + id + (id === "rotated" ? "-new" : "");
const requestBody = { model: "grok-4.7", input: [{ role: "user", content: "synthetic query" }], tools: [{ type: "web_search" }], store: false, reasoning: { effort: "low" } };
const fixtureText = readFileSync(new URL("./fixtures/openclaw-xai-search-contract.test.ts", import.meta.url), "utf8");
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
const observerSource = donor.slice(start, end), observerCode = stripTypeScriptTypes(observerSource);
const observerSHA = "cf00bd435b61c4b49fdad7bd6b95ed683238c4ba469c71f4df18af25655463d1";
assert.equal(createHash("sha256").update(observerSource).digest("hex"), observerSHA);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings }; ")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
// Reuse the source-owned Search cancellation contract, not another fixture's runtime proof.
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
const sdkObserverSource = searchLifetimeSource(observerSource);
// Preserve runtime byte equivalence while checking the transplanted observer
// in the original client's stricter extension test graph.
const typedSdkObserverSource = sdkObserverSource
  .replaceAll("function (...args: any[])", "function (this: unknown, ...args: any[])")
  .replaceAll("function (...operands: any[])", "function (this: unknown, ...operands: any[])")
  .replaceAll("every(unlock =>", "every((unlock: number) =>")
  .replace(/\b(cancel|closed|rejectedReads|releases)\[0\]\./g, "$1[0]!.");
assert.equal(stripTypeScriptTypes(typedSdkObserverSource, { mode: "transform" }), stripTypeScriptTypes(sdkObserverSource, { mode: "transform" }));
const assembledFixture = fixtureText.replace(marker, typedSdkObserverSource);

const workerOutcomePins = {"proxy.ts": "0257510ec1373baab447c1bdcad82b36e6341fce55027c8627af3fccf6e794de", "proxy-response.ts": "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
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
    edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { qianfanOutcome } from "qianfan-outcome-witness";\n' + text;
}
async function bundleResponsesOutcome(contents) {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "qianfan-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "qianfan-first-outcome", setup(build) {
      build.onResolve({ filter: /^qianfan-outcome-witness$/ }, () => ({ path: "witness", namespace: "qianfan" }));
      build.onLoad({ filter: /.*/, namespace: "qianfan" }, () => ({ contents: "export const qianfanOutcome = { current: undefined };", loader: "js" }));
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

function routerFixture(phase) {
  const path = phase === "native" ? "/v1/native/xai/v1/responses" : "/v1/proxy/xai/responses";
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { snapshot } from "./worker/provider-catalog.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
const endpoint = snapshot.providers.find(provider => provider.id === "xai").endpoints.find(endpoint => endpoint.id === "responses");
if (${JSON.stringify(phase)} === "manifest") endpoint.native_proxy = false;
const cases = ${JSON.stringify(cases)}, ingress = createRequestBindings(), outbound = createRequestBindings();
let sourceCancellation, acceptedConsumer = false;
const lifetime = createLifetimeObserver(undefined, { ownerId: "xsearch_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
const deliveries = new Map();
const originalBind = qianfanOutcome.current.bind, originalInspection = qianfanOutcome.current.inspection;
lifetime.patch(qianfanOutcome.current, "bind", function (...args) {
  const value = Reflect.apply(originalBind, this, args);
  try {
    const [operation, response, reader] = args, rows = lifetime.readers.filter(row => row.reader === reader && row.body === response.body);
    if (Object.getPrototypeOf(operation) !== HttpOperation.prototype || rows.length !== 1 || deliveries.has(operation)) throw new Error("xAI delivery original reader binding");
    const row = rows[0], owner = row.owner, incoming = owner.ingress;
    const signal = Object.getOwnPropertyDescriptor(operation, "signal"), caller = Object.getOwnPropertyDescriptor(operation, "caller");
    if (!signal || !("value" in signal) || !caller || !("value" in caller) || signal.value !== owner.signal || caller.value !== incoming?.signal
      || !outbound.bindings.includes(owner) || !ingress.bindings.includes(incoming) || !owner.claimed || !incoming.claimed || owner.id !== incoming.id
      || row.receivedBody !== response.body) throw new Error("xAI delivery original request binding");
    const fetched = lifetime.operations.filter(op => op.owner === owner && op.kind === "fetch");
    if (fetched.length !== 1 || fetched[0].state !== "fulfilled" || fetched[0].value !== response || fetched[0].original !== originalFetch) throw new Error("xAI delivery original fetch binding");
    deliveries.set(operation, { incoming, owner, response, reader, delivery: undefined });
  } catch (error) { lifetime.errors.push(error); }
  return value;
});
lifetime.patch(qianfanOutcome.current, "inspection", function (...args) {
  const value = Reflect.apply(originalInspection, this, args);
  try {
    const [operation, , delivery] = args, row = deliveries.get(operation);
    if (!row || row.delivery !== undefined || !["complete", "canceled", "failed"].includes(delivery)) throw new Error("xAI delivery original inspection binding");
    row.delivery = delivery;
  } catch (error) { lifetime.errors.push(error); }
  return value;
});
for (const row of cases.filter(row => !row.denied)) {
  ingress.expect("xsearch_" + row.id, "chat", ${JSON.stringify(path)}, "POST", "clawrouter-live-xsearch_" + row.id + "-fixture-secret");
  outbound.expect("xsearch_" + row.id, "chat", "https://api.x.ai/v1/responses", "POST", "synthetic-xsearch-" + row.id + (row.id === "rotated" ? "-new" : ""));
}
ingress.expect("xsearch_direct_budget", "chat", ${JSON.stringify(path)}, "POST", "clawrouter-live-xsearch_direct_budget-fixture-secret");
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  let owner;
  try { owner = outbound.claim(args[0], args[1], "chat"); }
  catch (error) { lifetime.errors.push(error); throw error; }
  owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
  if (!owner.ingress) { const error = new Error("unbound xAI search outbound"); lifetime.errors.push(error); throw error; }
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
function requests() {
  const rows = lifetime.operations.filter(op => op.kind === "handler"); const ids = new Set();
  return rows.map(op => {
    if (op.state !== "fulfilled" || op.operands[0] !== op.owner.request) throw new Error("unsettled original xAI handler");
    const requestId = op.value.headers.get("x-clawrouter-request-id");
    if (!requestId || ids.has(requestId)) throw new Error("missing or duplicate xAI request ID"); ids.add(requestId);
    const bound = [...deliveries.values()].filter(row => row.incoming === op.owner);
    if (op.owner.id !== "xsearch_direct_budget" && (bound.length !== 1 || op.owner.id !== "xsearch_redirect" && !bound[0].delivery)) throw new Error("missing original xAI delivery");
    return { id: op.owner.id, requestId, status: op.value.status, location: op.value.headers.get("location"), upstreamStatus: bound[0]?.response.status, delivery: bound[0]?.delivery };
  });
}
const configured = env => ({ ...env, XAI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" });
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const row of [...cases, { id: "direct_budget" }]) if (row.id !== "invalid") await putGrantCredentials(env, "oauth/xsearch_" + row.id + "/xai", { provider: "xai", kind: "api_key", enabled: true, credential: "synthetic-xsearch-" + row.id });
    await putGrantCredentials(env, "oauth/xsearch_rotated/xai", { provider: "xai", kind: "api_key", enabled: true, credential: "synthetic-xsearch-rotated-new" });
    await revokeGrantCredentials(env, "oauth/xsearch_revoked/xai", { provider: "xai", kind: "api_key" });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (path === "/fixture/requests") return Response.json(requests());
  if (path !== ${JSON.stringify(path)}) return handler.fetch(request, configured(env), context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  let owner; try { owner = ingress.claim(request, undefined, "chat"); } catch (error) { lifetime.errors.push(error); throw error; }
  owner.request = request; lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, configured(env), context], owner);
} };`;
}

function upstreamFixture() {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [], owners = new Map();
for (const id of ${JSON.stringify(charged)}) bindings.expect("xsearch_" + id, "chat", "https://api.x.ai/v1/responses", "POST", "synthetic-xsearch-" + id + (id === "rotated" ? "-new" : ""));
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const id = owner.id.slice("xsearch_".length), call = { id, method: request.method, url: request.url, authorization: request.headers.get("authorization"), body, cancelled: false, expired: false };
  calls.push(call); owners.set(owner, call);
  const payload = { id: "resp_synthetic_" + id, object: "response", model: id === "model_mismatch" ? "foreign-model" : "grok-4.7",
    status: id === "incomplete" ? "incomplete" : "completed", error: null, incomplete_details: id === "incomplete" ? { reason: "max_output_tokens" } : null,
    output: [{ type: "web_search_call", status: "completed" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic answer.",
      annotations: [{ type: "url_citation", url: "https://example.com/annotation", start_index: 0, end_index: 9 }] }] }],
    citations: ["https://user:password@example.com/private", "javascript:alert(1)", "https://example.com/source"],
    inline_citations: [{ start_index: 0, end_index: 9, url: "https://example.com/source" }],
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, server_side_tool_usage_details: { web_search_calls: 1, x_posts_fetched: 44 } } };
  if (id === "oversized") payload.output[1].content[0].text = "x".repeat(2 * 1024 * 1024 + 256);
  const wire = id === "cancel" ? '{"id":"resp_cancel","output":[' : JSON.stringify(id === "malformed" ? { ...payload, output: {} }
    : id === "error" ? { error: { message: "synthetic upstream failure", type: "server_error" } } : payload);
  const bytes = new TextEncoder().encode(wire); call.responseBytes = bytes.length; let offset = 0, heartbeat, wake, expiry, controller, complete = false;
  let resolveProducer, rejectProducer;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("xAI search source deadline"); finish(true, error); controller?.error(error); }, 10000);
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
  call.status = id === "error" ? 503 : id === "redirect" ? 307 : 200;
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { status: call.status, headers: { "content-type": "application/json", ...(id === "redirect" ? { location: "https://foreign.example/replayed-search" } : {}) } });
}
export default { fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    const owner = bindings.bindings.find(row => row.id === "xsearch_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
    const sourceCancellation = { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true,
      cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: owned.filter(op => op.state === "pending").length,
      failed: owned.filter(op => !["pending", "fulfilled"].includes(op.state)).length };
    return Response.json({ ...lifetime.summary(), accepted, sourceCancellation });
  })();
  let owner; try { owner = bindings.claim(request, undefined, "chat"); } catch (error) { lifetime.errors.push(error); throw error; }
  lifetime.signal(owner, request.signal); const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}

async function setup(mf, phase) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const row of [...cases, { id: "direct_budget" }].filter(row => row.id !== "invalid")) {
    const id = ownerId(row.id);
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "google" : "xai"], models: ["xai/grok-4.7"],
      grantRouting: { eligibleGrants: { xai: ["xai"] }, environmentFallback: false }, tenantId: "fixture", monthlyBudgetMicros: 100,
      budgetMode: "reserve", requestCostMicros: ["budget", "direct_budget"].includes(row.id) ? null : 7, retainRequestContent: false }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/xai", JSON.stringify({ providerId: "xai", enabled: true, monthlyBudgetMicros: 10000000 }));
  const origin = String(await mf.unsafeGetDirectURL("router")).replace(/\/$/, "");
  const response = await fetch(origin + "/fixture/grants"); assert.equal(response.status, 204); await response.arrayBuffer();
  for (const id of ["success", "budget"]) {
    const response = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token(id) } }); assert.equal(response.status, 200);
    const catalog = await response.json(), provider = catalog.providers.find(row => row.id === "xai");
    assert.equal(catalog.scope.credentialId, ownerId(id));
    const model = provider.models.find(row => row.id === "xai/grok-4.7");
    assert.deepEqual(model.nativeCapabilities.endpoints.responses.hostedTools, ["web_search"]);
    assert.ok(model.supportedReasoningEfforts.includes("low"));
    const offers = provider.offers.filter(row => row.modelId === model.id && row.endpoint === "responses" && ["native", "manifest"].includes(row.routeKind));
    assert.equal(offers.length, 1); const [offer] = offers; assert.equal(offer.eligible, true); assert.equal(offer.routeKind, phase);
    assert.equal(offer.route, phase === "native" ? "/v1/native/xai/v1/responses" : "/v1/proxy/xai/responses");
    assert.deepEqual(offer.hostedToolAdmission, { version: "clawrouter.hosted-tool-admission.v1", web_search: id === "budget" ? "pricing_required" : "admitted" });
  }
  return origin;
}

function assertCalls(calls) {
  assert.deepEqual(calls.map(call => call.id).sort(), [...charged].sort(), "one selected upstream request, no fallback or replay");
  for (const call of calls) {
    assert.equal(call.method, "POST", call.id); assert.equal(call.url, "https://api.x.ai/v1/responses", call.id);
    assert.equal(call.authorization, "Bearer " + secret(call.id), call.id); assert.deepEqual(call.body, requestBody, call.id);
    assert.equal(call.status, call.id === "error" ? 503 : call.id === "redirect" ? 307 : 200, call.id);
    assert.equal(call.expired, false, call.id); assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    if (call.id === "cancel") assert.equal(call.cancelled, true, "actual upstream cancel");
  }
}

async function verifyCallsAndUsage(mf, origin, sdkLimit) {
  const upstream = await mf.getWorker("upstream"); let calls;
  for (let attempt = 0; attempt < 150; attempt++) {
    calls = await (await upstream.fetch("https://fixture.example/state")).json();
    const canceled = calls.find(row => row.id === "cancel");
    if (canceled?.cancelled || canceled?.expired) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assertCalls(calls);
  assert.ok(sdkLimit.readBytes <= calls.find(row => row.id === "oversized").responseBytes, "original SDK bytes belong to the selected oversized response");
  const requests = await (await fetch(origin + "/fixture/requests")).json();
  assert.deepEqual(requests.map(row => row.id).sort(), [...charged, "direct_budget"].map(ownerId).sort());
  const requestIds = new Set(requests.map(row => row.requestId)); assert.equal(requestIds.size, requests.length);
  for (const row of [...cases, { id: "direct_budget", denied: true }].filter(row => row.id !== "invalid")) {
    const dispatched = charged.includes(row.id), posted = dispatched || row.id === "direct_budget";
    // This fixed-policy HTTP rejection uses the shipping nonbillable outcome;
    // it is not a qualified vendor hosted-tool tariff or a generic SDK-error rule.
    const cost = dispatched && !["error", "redirect"].includes(row.id) ? 7 : 0;
    let usage;
    for (let attempt = 0; attempt < 150; attempt++) {
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(row.id) } })).json();
      if (usage.usage.events.length === (posted ? 1 : 0) && usage.budget.spentMicros === cost) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(usage.usage.events.length, posted ? 1 : 0, row.id + " exact receipt count");
    assert.equal(usage.budget.spentMicros, cost, row.id + " final budget");
    if (!posted) continue;
    const [event] = usage.usage.events, bound = requests.find(item => item.id === ownerId(row.id));
    assert.equal(event.request_id, bound.requestId, row.id + " original handler request ID");
    assert.equal(event.credential_id, ownerId(row.id), row.id); assert.equal(event.policy_id, ownerId(row.id), row.id);
    assert.equal(event.provider, "xai", row.id); assert.equal(event.model, "xai/grok-4.7", row.id); assert.equal(event.capability, "llm.responses", row.id);
    assert.equal(event.actual_cost_micros, cost, row.id); assert.equal(event.cost_basis, cost ? "policy_fixed" : "none", row.id);
    if (row.id === "error") assert.equal(bound.status, 503);
    if (row.id === "redirect") {
      assert.equal(bound.upstreamStatus, 307); assert.equal(bound.status, 502); assert.equal(bound.location, null);
      assert.equal(event.status_code, 502); assert.equal(bound.delivery, undefined, "redirect refusal precedes delivery inspection");
    }
    if (dispatched) {
      let status = row.id === "cancel" ? "client_error" : ["error", "redirect"].includes(row.id) ? "provider_error" : "success";
      if (row.id === "oversized") { assert.ok(["complete", "canceled"].includes(bound.delivery), "oversized failed/unknown delivery remains fatal"); status = bound.delivery === "complete" ? "success" : "client_error"; }
      assert.equal(event.status, status, row.id);
    }
    assert.doesNotMatch(JSON.stringify(event), /synthetic query|Synthetic answer|fixture-secret|synthetic-xsearch|must-not-fallback/);
  }
}

async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "xsearch_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}

async function runNative(t, fixture, origin, phase, invoke = runOpenClawConsumer) {
  let receipts = 0; const limits = [];
  const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
    return text => { for (const line of text.split("\n").map(line => line.trim())) {
      if (line === "XAI_SEARCH_CANCEL_RETIRED " + phase) receipts++;
      const prefix = "XAI_SEARCH_LIMIT " + phase + " ";
      if (line.startsWith(prefix)) limits.push(validateLimit(JSON.parse(line.slice(prefix.length))));
    } t.diagnostic(text); };
  } });
  await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/clawrouter/worker-xai-search-contract.test.ts", typecheck: true,
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_XAI_SEARCH_PHASE: phase, XAI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", NO_COLOR: "1" } });
  assert.equal(receipts, 1, "one exact phase-bound xAI Search cancellation and cleanup receipt");
  assert.equal(limits.length, 1, "one original SDK limit and cleanup receipt"); return limits[0];
}

function validateLimit(record) {
  assert.deepEqual(Object.keys(record).sort(), ["id", "limitBytes", "readBytes", "readOperations", "readerCount"]);
  assert.equal(record.id, "oversized"); assert.equal(record.limitBytes, 1024 * 1024); assert.equal(record.readerCount, 1);
  assert.ok(Number.isSafeInteger(record.readBytes) && record.readBytes > record.limitBytes && record.readBytes <= 3 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(record.readOperations) && record.readOperations > 0); return record;
}

test("xAI Search native assembly binds the actual client, original ledger and independent row", () => {
  assert.equal(assembledFixture.includes(marker), false); assert.doesNotThrow(() => stripTypeScriptTypes(assembledFixture));
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "xai-search"), [{ consumer: "xai-search", ref: sourceHead, test: "test/openclaw-xai-search.test.mjs" }]);
  assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  const testPath = "extensions/clawrouter/worker-xai-search-contract.test.ts";
  const plan = consumerTypecheckPlan(sourceHead, testPath);
  assert.equal(plan.project, "test/tsconfig/tsconfig.extensions.test.json");
  assert.equal(plan.sha256, "b032aa889d4ab5512e57f26871a5839a38ae326b18e765dce2dcec3b4fd80d49");
  assert.deepEqual(plan.args, ["scripts/run-tsgo.mjs", "-p", plan.project, "--noEmit", "--incremental", "false"]);
  assert.throws(() => consumerTypecheckPlan("0".repeat(40), testPath));
  assert.throws(() => consumerTypecheckPlan(sourceHead, "extensions/clawrouter/worker-google-continuation-contract.test.ts"));
  assert.throws(() => consumerTypecheckPlan("b6072e63fdf09422ea70ef4bbdc818536d871047", testPath));
  for (const [name, hash] of Object.entries(workerOutcomePins)) assert.equal(createHash("sha256").update(readFileSync(new URL("../worker/" + name, import.meta.url))).digest("hex"), hash);
});

test("xAI Search native runner requires its exact phase and receipt", async () => {
  for (const phase of ["native", "manifest"]) {
    const invoke = async (t, options) => {
      assert.equal(options.sourceHead, sourceHead); assert.equal(options.env.CLAWROUTER_XAI_SEARCH_PHASE, phase);
      assert.equal(options.testPath, "extensions/clawrouter/worker-xai-search-contract.test.ts");
      assert.equal(options.typecheck, true);
      assert.equal(options.env.XAI_API_KEY, "must-not-fallback"); t.diagnostic("XAI_SEARCH_CANCEL_RETIRED " + phase);
      t.diagnostic("XAI_SEARCH_LIMIT " + phase + " " + JSON.stringify({ id: "oversized", limitBytes: 1024 * 1024, readBytes: 1024 * 1024 + 1, readOperations: 17, readerCount: 1 }));
    };
    await runNative({ diagnostic() {} }, "/synthetic/xai.ts", "https://router.example", phase, invoke);
    for (const receipt of ["", "PERPLEXITY_SEARCH_CANCEL_RETIRED " + phase, "XAI_SEARCH_CANCEL_RETIRED foreign", ("XAI_SEARCH_CANCEL_RETIRED " + phase + "\n").repeat(2)]) {
      await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/xai.ts", "https://router.example", phase, async t => t.diagnostic(receipt)));
    }
  }
});

test("xAI Search cleanup retains independent falsey failures and unknown original work", async () => {
  const attempted = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempted.push(1); throw null; }, () => attempted.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempted, [1, 2]);
  for (const reason of [undefined, new Error("synthetic independent failure")]) {
    const lifetime = createLifetimeObserver(); const pending = Promise.reject(reason);
    assert.strictEqual(lifetime.watch("body.cancel", pending, {}), pending); await pending.catch(() => {});
    await assert.rejects(lifetime.join(), error => error.errors.includes(reason)); lifetime.restore();
  }
});

test("xAI Search records a rejected ownership claim even when the tool catches its error", () => {
  const start = fixtureText.indexOf("function observedGuard("), end = fixtureText.indexOf("async function runCase(", start);
  assert.ok(start >= 0 && end > start);
  const factory = new Function("originalGuard", "origin", stripTypeScriptTypes(fixtureText.slice(start, end)) + "; return observedGuard;");
  for (const reason of [undefined, null, new Error("foreign request")]) {
    let calls = 0, threw = false;
    const lifetime = { errors: [], guard() { calls++; }, signal() { calls++; } };
    const wrapped = factory(() => { calls++; }, "https://router.example")(lifetime, { claim() { throw reason; } });
    try { wrapped({ url: "https://foreign.example", init: {} }); } catch (error) { threw = true; assert.strictEqual(error, reason); }
    assert.equal(threw, true); assert.equal(calls, 0); assert.equal(lifetime.errors.length, 1); assert.strictEqual(lifetime.errors[0], reason);
  }
});

test("xAI Search rejects extra requests, foreign keys and Perplexity-shaped payloads", () => {
  const calls = charged.map(id => ({ id, method: "POST", url: "https://api.x.ai/v1/responses", authorization: "Bearer " + secret(id), body: structuredClone(requestBody), status: id === "error" ? 503 : id === "redirect" ? 307 : 200, expired: false, cancelled: id === "cancel" }));
  assert.doesNotThrow(() => assertCalls(calls));
  for (const mutate of [rows => rows.push({ ...rows[0] }), rows => { rows[0].method = "GET"; }, rows => { rows[0].authorization = "Bearer foreign"; },
    rows => { rows[0].body.max_results = 2; }, rows => { rows[0].body.store = true; }, rows => { rows[0].body.reasoning.effort = "high"; },
    rows => { rows[0].url = "https://foreign.example/v1/responses"; }, rows => { rows.at(-1).cancelled = false; }, rows => { rows.at(-1).expired = true; }]) {
    const rows = structuredClone(calls); mutate(rows); assert.throws(() => assertCalls(rows));
  }
});

test("xAI Search delivery observation binds original fetch, reader, ingress and operation", () => {
  const source = routerFixture("native"), start = source.indexOf("const deliveries = new Map();"), end = source.indexOf("for (const row of cases.filter", start);
  assert.ok(start >= 0 && end > start);
  const install = new Function("lifetime", "ingress", "outbound", "HttpOperation", "qianfanOutcome", "originalFetch", source.slice(start, end) + "; return deliveries;");
  const fixture = mutate => {
    const response = new Response("synthetic"), reader = {}, signal = {}, caller = {}, originalFetch = () => undefined;
    const incoming = { id: "owned", claimed: true, signal: caller }, owner = { id: "owned", claimed: true, ingress: incoming, signal };
    class Operation { constructor() { this.signal = signal; this.caller = caller; } }
    const operation = new Operation(), row = { owner, reader, body: response.body, receivedBody: response.body };
    const lifetime = { readers: [row], errors: [], operations: [{ owner, kind: "fetch", state: "fulfilled", value: response, original: originalFetch }],
      patch(object, key, value) { object[key] = value; } };
    const returned = {}, calls = [], witness = { bind(...args) { calls.push([this, args]); return returned; }, inspection(...args) { calls.push([this, args]); return returned; } };
    const ingress = { bindings: [incoming] }, outbound = { bindings: [owner] };
    const state = { response, reader, operation, lifetime, owner, incoming, row, ingress, outbound, originalFetch, witness };
    mutate?.(state);
    const observed = install(lifetime, ingress, outbound, Operation, { current: witness }, originalFetch);
    assert.strictEqual(witness.bind(operation, response, reader), returned);
    assert.strictEqual(calls[0][0], witness); assert.deepEqual(calls[0][1], [operation, response, reader]);
    return { ...state, observed, returned };
  };
  const valid = fixture(); assert.equal(valid.lifetime.errors.length, 0);
  assert.strictEqual(valid.witness.inspection(valid.operation, {}, "canceled"), valid.returned);
  assert.equal(valid.observed.get(valid.operation).delivery, "canceled"); assert.equal(valid.lifetime.errors.length, 0);
  valid.witness.inspection(valid.operation, {}, "complete"); assert.equal(valid.lifetime.errors.length, 1, "duplicate observation is fatal");
  for (const mutate of [state => { state.row.receivedBody = {}; }, state => { state.owner.id = "foreign"; }, state => { state.owner.claimed = false; },
    state => { state.operation.signal = {}; }, state => { state.operation.caller = {}; }, state => { state.outbound.bindings = []; },
    state => { state.lifetime.operations[0].value = new Response("foreign"); }, state => { state.lifetime.operations[0].original = () => undefined; },
    state => { state.lifetime.operations[0].state = "rejected"; }, state => { state.lifetime.readers.push({ ...state.row }); }]) {
    const rejected = fixture(mutate); assert.equal(rejected.observed.size, 0); assert.equal(rejected.lifetime.errors.length, 1);
  }
  const failed = fixture(); failed.witness.inspection(failed.operation, {}, "unknown"); assert.equal(failed.lifetime.errors.length, 1);
});

for (const phase of ["native", "manifest"]) test(phase + " registered xAI Search SDK through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xai-search-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture(phase)), upstreamFixture(), { directRouter: true });
    const origin = await setup(mf, phase), path = phase === "native" ? "/v1/native/xai/v1/responses" : "/v1/proxy/xai/responses";
    const denied = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token("direct_budget"), "content-type": "application/json" }, body: JSON.stringify(phase === "manifest" ? { body: requestBody } : requestBody) });
    assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, "pricing_required");
    const fixture = join(temporary, "xai-search-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    const limit = await runNative(t, fixture, origin, phase); await verifyCallsAndUsage(mf, origin, limit); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
