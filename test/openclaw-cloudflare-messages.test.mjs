import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { createWorkerOutcomeFixture } from "./helpers/worker-outcome-fixture.mjs";
import { runOpenClawConsumer, consumerTypecheckPlan } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "3ea9ca6e79c1c9a1a7fb1629f9cb88bb6046c291";
const providerId = "cloudflare-ai-gateway", modelId = providerId + "/claude-sonnet-4-6";
const nativePath = "/v1/native/" + providerId + "/anthropic/v1/messages";
const envelopePath = "/v1/proxy/" + providerId + "/messages";
const upstreamUrl = "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages";
const successful = ["stream", "simple", "eof", "seed", "replay", "envelope"];
const charged = [...successful, "error", "cancel"];
const denied = ["invalid", "foreign", "model_denied", "grant_missing", "grant_revoked", "grant_foreign", "budget", "unpriced"];
const denialFacts = {
  invalid: [401, "invalid_proxy_key"], foreign: [403, "provider_not_allowed"], model_denied: [403, "model_not_allowed"],
  grant_missing: [503, "upstream_grant_pool_unavailable"], grant_revoked: [503, "upstream_grant_pool_unavailable"], grant_foreign: [503, "upstream_grant_pool_unavailable"],
  budget: [402, "budget_exhausted"], unpriced: [400, "pricing_required"],
};
const workerBindings = { CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_AI_GATEWAY_ID: "fixture-gateway", ANTHROPIC_API_KEY: "must-not-fallback" };
const catalogOnly = ["selection", "offers_empty", "offers_invalid", "model_missing", "catalog_unpriced", "catalog_foreign"];
const cases = [...charged, ...denied, ...catalogOnly];
const token = id => id === "invalid" ? "clawrouter-live-cf_stream-invalid" : "clawrouter-live-cf_" + id + "-fixture-secret";
const secret = id => "synthetic-gateway-" + id;
const fixtureText = readFileSync(new URL("./fixtures/openclaw-cloudflare-messages-contract.test.ts", import.meta.url), "utf8");
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
let observerSource = donor.slice(donor.indexOf("type OriginalOperation ="), donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS"));
// Reuse exact source, not another provider's execution proof. Only add a passive
// original-read observation used to initiate the case's real caller cancellation.
assert.equal(createHash("sha256").update(observerSource).digest("hex"), "cf00bd435b61c4b49fdad7bd6b95ed683238c4ba469c71f4df18af25655463d1");
for (const [before, after] of [
  ["bodySucceeded: () => boolean; current?", "bodySucceeded: () => boolean; readProgress?: (owner: any, value: any) => void; current?"],
  ["if (value?.done === true) row.eof = true;", "if (value?.done === true) row.eof = true; sdk?.readProgress?.(owner, value);"],
]) { assert.equal(observerSource.split(before).length, 2); observerSource = observerSource.replace(before, after); }
const untypedObserverSource = observerSource;
// CF's owning compiler graph checks this copied observer. The donor stays
// immutable; these annotations must erase to exactly the same runtime code.
function projectCloudflareObserverTypes(source) {
  const runtime = stripTypeScriptTypes(source, { mode: "transform" });
  const guardedRead = `    return cancel.length === 1 && closed.length === 1 && closed[0].pending === row.closed && closed[0].state === "fulfilled"
      && cancel[0].state === "fulfilled" && cancel[0].owner === owner && cancel[0].receiver === row.reader && cancel[0].unlocksAtInvoke === 0
      && op.invoked < cancel[0].invoked && cancel[0].invoked < op.settled! && op.settled! < row.unlockInvocations[0]
      && cancel[0].settled! < row.unlockInvocations[0] && related.filter(item => item.state !== "fulfilled").length === 1;`;
  assert.equal([...guardedRead.matchAll(/\b(?:cancel|closed)\[0\]/g)].length, 9);
  for (const [before, after] of [
    ['patch(body, "cancel", function (...args: any[])', 'patch(body, "cancel", function (this: unknown, ...args: any[])'],
    ['patch(body, "getReader", function (...args: any[])', 'patch(body, "getReader", function (this: unknown, ...args: any[])'],
    ['patch(reader, kind, function (...operands: any[])', 'patch(reader, kind, function (this: unknown, ...operands: any[])'],
    ['patch(reader, "releaseLock", function (...operands: any[])', 'patch(reader, "releaseLock", function (this: unknown, ...operands: any[])'],
    ['patch(result, "release", function (...operands: any[])', 'patch(result, "release", function (this: unknown, ...operands: any[])'],
    ['row.unlockInvocations.every(unlock =>', 'row.unlockInvocations.every((unlock: number) =>'],
    [guardedRead, guardedRead.replace(/\b(cancel|closed)\[0\]/g, "$1[0]!")],
  ]) { assert.equal(source.split(before).length, 2, "exact CF observer type projection"); source = source.replace(before, after); }
  assert.equal(stripTypeScriptTypes(source, { mode: "transform" }), runtime, "CF type projection preserves erased runtime");
  return source;
}
const typedObserverSource = projectCloudflareObserverTypes(observerSource);
const cloneSource = readFileSync(new URL("./helpers/cloudflare-response-clones.ts", import.meta.url), "utf8");
function projectCloudflareCloneObserver(source) {
  for (const [before, after] of [
    ['bodySucceeded: () => boolean; readProgress?', 'bodySucceeded: () => boolean; cloudflareClone?: CloudflareCloneScope; readProgress?'],
    ['  const providerErrors = new Map<any, any>();', '  const cloudflareClones = createCloudflareCloneObserver({ sdk, operations, errors, readers, bodies, guards, safe, patch, invoke, response });\n  const providerErrors = new Map<any, any>();'],
    ['    return value;\n  }\n  function guard(', '    cloudflareClones.observe(value, owner, acquisition);\n    return value;\n  }\n  function guard('],
    ['    const structural: unknown[] = [...errors];', '    const cloudflareParents = cloudflareClones.joinedParents();\n    const structural: unknown[] = [...errors];'],
    ['op.receiver === row.body));\n    const stillOwned', 'op.receiver === row.body) && !cloudflareParents.has(row));\n    const stillOwned'],
    ['const stillOwned = bodies.some(row => row.body.locked)', 'const stillOwned = bodies.some(row => row.body.locked && !cloudflareParents.has(row))'],
    ['  return { operations, errors, readers, bodies, guards, stamp:', '  return { cloneDiagnostic: cloudflareClones.diagnostic, operations, errors, readers, bodies, guards, stamp:'],
  ]) { assert.equal(source.split(before).length, 2, "exact CF clone projection"); source = source.replace(before, after); }
  return cloneSource + "\n" + source;
}
observerSource = projectCloudflareCloneObserver(typedObserverSource);
const observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver, joinCloudflareLifetime } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, joinCloudflareLifetime };")();
const bindingsSource = fixtureText.slice(fixtureText.indexOf("function retainCloudflareClaim"), fixtureText.indexOf("// END CLOUDFLARE BINDINGS"));
const bindingsCode = stripTypeScriptTypes(bindingsSource);
const { createCloudflareBindings, retainCloudflareClaim } = new Function(bindingsCode + "; return { createCloudflareBindings, retainCloudflareClaim };")();
const historySource = fixtureText.slice(fixtureText.indexOf("function cloudflareHistory"), fixtureText.indexOf("// END CLOUDFLARE HISTORY"));
const { cloudflareHistory } = new Function(stripTypeScriptTypes(historySource) + "; return { cloudflareHistory };")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
const assembledFixture = fixtureText.replace(marker, observerSource);
const workerOutcomePins = {"proxy.ts": "8d13dc558be26485c3b64a4dc668639d5daa34dea771ede63b4811b7fe94092b", "proxy-response.ts": "da7664084749cff3c5bb9f9d6b82053e6d04438fc7fdcca1dd9d3025e175e8f3", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
const { bundleWorkerOutcome } = createWorkerOutcomeFixture(workerOutcomePins);

// These mutations model a malformed remote catalog, never a shipping offer.
// Run the real Worker catalog first and only REMOVE eligibility/identity facts.
function rejectCatalog(body, id) {
  const provider = body.providers.find(row => row.id === "cloudflare-ai-gateway");
  assert(provider);
  if (id === "offers_empty") provider.offers = [];
  else if (id === "offers_invalid") for (const offer of provider.offers) offer.eligible = false;
  else if (id === "model_missing") provider.models = [];
  else throw new Error("unknown catalog mutation");
  return body;
}
function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof));
  assert.equal(proof.settled, proof.operations); assert.equal(proof.readers, proof.unlocked);
  assert.equal(proof.rejected, proof.qualifiedReadRejections ?? 0);
}
// Observe the original namespace/stub calls without replacing their promises,
// reading response bodies, or writing ledger state. Every record owns ingress.
function observeCloudflareBudgets(namespace, lifetime, owner, calls) {
  const names = new Map();
  return new Proxy(namespace, { get(target, key) {
    if (key === "idFromName") return function (...args) {
      const id = Reflect.apply(target.idFromName, target, args); names.set(id, args[0]); return id;
    };
    if (key === "get") return function (...args) {
      const stub = Reflect.apply(target.get, target, args), objectName = names.get(args[0]);
      return new Proxy(stub, { get(original, method) {
        if (method === "fetch") return function (...operands) {
          const record = retainCloudflareClaim(lifetime, () => {
            if (typeof objectName !== "string" || typeof operands[0] !== "string") throw new Error("unbound Cloudflare budget call");
            const path = new URL(operands[0]).pathname;
            if (path === "/status") return undefined;
            if (!["/reserve", "/dispatch", "/settle"].includes(path) || operands[1]?.method !== "POST" || typeof operands[1]?.body !== "string") throw new Error("unexpected Cloudflare budget operation");
            const body = JSON.parse(operands[1].body);
            if (typeof body.reservationId !== "string" || !body.reservationId) throw new Error("missing Cloudflare reservation identity");
            const row = { owner, objectName, path, reservationId: body.reservationId, policyId: body.policyId,
              windowKey: body.windowKey, scopeKey: body.scopeKey, costMicros: body.costMicros, dispatched: body.dispatched, actualCostMicros: body.actualCostMicros, status: undefined };
            calls.push(row); return row;
          });
          return lifetime.invoke("budget.fetch", original.fetch, original, operands, owner, response => { if (record) record.status = response.status; });
        };
        const value = Reflect.get(original, method, original); return typeof value === "function" ? value.bind(original) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
function assertCloudflareSettled(event, id, observations, rows) {
  const owner = "cf_" + id, own = observations.filter(row => row.ownerId === owner);
  assert.equal(own.length, 4, id + " original dispatched reserve and settlement on both scopes");
  for (const objectName of ["fixture:cf_" + id, "provider:" + providerId]) {
    const calls = own.filter(row => row.objectName === objectName);
    assert.deepEqual(calls.map(row => row.path), ["/reserve", "/settle"]);
    assert.ok(calls.every(row => row.requestId === event.request_id && typeof row.requestId === "string" && row.requestId.length > 0 && row.status === 200));
    const [reserved, settled] = calls;
    // This shipping proxy path reserves with dispatched:true (proxy.ts). It
    // does not issue a second /dispatch call for an acknowledged reservation.
    assert.equal(reserved.dispatched, true); assert.equal(reserved.costMicros, 7); assert.equal(settled.actualCostMicros, 7);
    assert.equal(settled.reservationId, reserved.reservationId);
    const matching = rows.filter(row => row.objectName === objectName && row.reservation_id === reserved.reservationId);
    assert.equal(matching.length, 1); const [row] = matching;
    assert.equal(row.policy_id, reserved.policyId); assert.equal(row.window_key, reserved.windowKey); assert.equal(row.budget_scope_key, reserved.scopeKey);
    assert.equal(row.reserved_micros, 7); assert.equal(row.dispatch_started, 1); assert.equal(row.settled, 1, id + " original SQLite settlement");
  }
}
function routerFixture() {
  return `import handler, { BudgetLedgerObject as OriginalBudgetLedger } from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
${bindingsCode}
${observeCloudflareBudgets.toString()}
// Fixture-only read surface; all original reserve/dispatch/settle code is inherited.
export class BudgetLedgerObject extends OriginalBudgetLedger {
  constructor(state) { super(state); this.fixtureStorage = state.storage; }
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/fixture/reservations") return Response.json([...this.fixtureStorage.sql.exec("SELECT reservation_id, policy_id, window_key, budget_scope_key, reserved_micros, dispatch_started, settled FROM budget_reservations ORDER BY reservation_id")]);
    return super.fetch(request);
  }
}
const assert = value => { if (!value) throw new Error("Cloudflare catalog fixture identity"); };
${rejectCatalog.toString()}
const ingress = createCloudflareBindings(), outbound = createCloudflareBindings();
let sourceCancellation, acceptedConsumer = false; const budgetCalls = [];
const lifetime = createLifetimeObserver(undefined, { ownerId: "cf_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const id of ${JSON.stringify([...charged, ...denied])}) {
  ingress.expect("cf_" + id, "chat", id === "envelope" ? ${JSON.stringify(envelopePath)} : ${JSON.stringify(nativePath)}, "POST",
    id === "invalid" ? "clawrouter-live-cf_stream-invalid" : "clawrouter-live-cf_" + id + "-fixture-secret", undefined, id === "envelope" ? "authorization" : "x-api-key", id === "envelope" ? "Bearer " : "");
}
for (const id of ${JSON.stringify(charged)}) outbound.expect("cf_" + id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-gateway-" + id, undefined, "cf-aig-authorization");
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  const owner = retainCloudflareClaim(lifetime, () => {
    const owner = outbound.claim(args[0], args[1], "chat");
    owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
    if (!owner.ingress) throw new Error("unbound Cloudflare outbound"); return owner;
  });
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
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const id of ${JSON.stringify(cases.filter(id => !["invalid", "grant_missing"].includes(id)))}) await putGrantCredentials(env, "oauth/cf_" + id + "/gateway", { provider: id === "grant_foreign" ? "anthropic" : "cloudflare-ai-gateway", kind: "api_key", enabled: true, credential: "synthetic-gateway-" + id });
    await revokeGrantCredentials(env, "oauth/cf_grant_revoked/gateway");
    if (await env.POLICY_KV.get("oauth/cf_grant_missing/gateway") !== null) throw new Error("missing grant was populated");
    const foreign = await env.POLICY_KV.get("oauth/cf_grant_foreign/gateway", "json"), revoked = await env.POLICY_KV.get("oauth/cf_grant_revoked/gateway", "json");
    if (foreign?.provider !== "anthropic" || revoked?.enabled !== false) throw new Error("grant negative setup mismatch");
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (path === "/fixture/budgets" && request.method === "GET") return (async () => {
    const names = [${JSON.stringify("provider:" + providerId)}, ...${JSON.stringify(charged)}.map(id => "fixture:cf_" + id)], rows = [];
    for (const objectName of names) {
      const response = await env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(objectName)).fetch("https://fixture.example/fixture/reservations");
      if (response.status !== 200) throw new Error("Cloudflare ledger readback failed");
      rows.push(...(await response.json()).map(row => ({ objectName, ...row })));
    }
    return Response.json({ rows, calls: budgetCalls.map(({ owner, ...row }) => ({ ownerId: owner.id, requestId: owner.requestId, ...row })) });
  })();
  if (path === "/v1/catalog") return (async () => {
    const response = await handler.fetch(request, env, context);
    const id = request.headers.get("authorization")?.match(/^Bearer clawrouter-live-cf_(offers_empty|offers_invalid|model_missing)-fixture-secret$/)?.[1];
    if (!id || response.status !== 200) return response;
    const body = rejectCatalog(await response.json(), id); return Response.json(body);
  })();
  if (![${JSON.stringify(nativePath)}, ${JSON.stringify(envelopePath)}].includes(path)) return handler.fetch(request, env, context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = retainCloudflareClaim(lifetime, () => ingress.claim(request, undefined, "chat")); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  const selected = { ...env, BUDGET_LEDGER: observeCloudflareBudgets(env.BUDGET_LEDGER, lifetime, owner, budgetCalls) };
  return lifetime.invoke("handler", handler.fetch, handler, [request, selected, context], owner, response => { owner.requestId = response.headers.get("x-request-id"); });
} };`;
}
function upstreamFixture() {
  return String.raw`${observerCode}
${bindingsCode}
const lifetime = createLifetimeObserver(), bindings = createCloudflareBindings(), calls = [], owners = new Map();
let released = false;
for (const id of ${JSON.stringify(charged)}) bindings.expect("cf_" + id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-gateway-" + id, undefined, "cf-aig-authorization");
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner), id = owner.id.slice(3);
  const call = { id, url: request.url, headers: Object.fromEntries(request.headers), body, cancelled: false, expired: false, eof: false, wireSent: false };
  calls.push(call); owners.set(owner, call);
  const frame = value => "event: " + value.type + "\n" + "data: " + JSON.stringify(value) + "\n\n";
  const events = [
    { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 0 } } },
    ...(id === "seed" ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic reasoning" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"index":2}' } },
      { type: "content_block_stop", index: 1 },
    ] : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-answer" } },
      { type: "content_block_stop", index: 0 },
    ]),
    ...(id === "error" ? [{ type: "error", error: { type: "api_error", message: "synthetic-upstream-error" } }] : id === "cancel" ? [] : [
      { type: "message_delta", delta: { stop_reason: id === "seed" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]),
  ];
  const bytes = new TextEncoder().encode(events.map(frame).join("")); let offset = 0, timer, wake, expiry, controller;
  let resolveProducer, rejectProducer, complete = false;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(timer); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("Cloudflare fixture source deadline"); finish(true, error); controller?.error(error); }, 10000);
  const streamSource = {
    start(value) { controller = value; },
    pull(value) {
      if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); value.enqueue(bytes.slice(offset, end)); offset = end; return; }
      call.wireSent = true;
      if (id !== "cancel" && (id !== "eof" || released)) { call.eof = true; value.close(); finish(false); return; }
      // Original bounded producer work stays in its request context. Polling
      // cannot manufacture cancellation or turn expiry into completion.
      const pending = new Promise(resolve => { wake = resolve; timer = setTimeout(() => { if (!complete) value.enqueue(new TextEncoder().encode(": fixture wait\n\n")); resolve(); }, 50); });
      return lifetime.watch("source.timer", pending, owner);
    },
    cancel() { call.cancelled = true; finish(false); },
  };
  for (const kind of ["pull", "cancel"]) { const original = streamSource[kind]; lifetime.patch(streamSource, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(streamSource, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
export default { fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/state") { const row = calls.find(row => row.id === "eof"); return Response.json({ wireSent: row?.wireSent === true, eof: row?.eof === true, expired: row?.expired === true }); }
  if (path === "/fixture/release") { if (released || !calls.some(row => row.id === "eof" && row.wireSent && !row.eof && !row.expired)) return new Response(null, { status: 409 }); released = true; return Response.json({ released }); }
  if (path === "/fixture/calls") return Response.json(calls);
  if (path === "/fixture/retire") return (async () => {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    const owner = bindings.bindings.find(row => row.id === "cf_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
    const sourceCancellation = { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true,
      cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: owned.filter(op => op.state === "pending").length,
      failed: owned.filter(op => !["pending", "fulfilled"].includes(op.state)).length };
    return Response.json({ ...lifetime.summary(), accepted, sourceCancellation });
  })();
  const owner = retainCloudflareClaim(lifetime, () => bindings.claim(request, undefined, "chat")); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}
async function setup(mf) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const id of cases.filter(id => id !== "invalid")) {
    await kv.put("policies/cf_" + id, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
      providers: [id === "foreign" || id === "catalog_foreign" ? "anthropic" : providerId], models: [id === "model_denied" ? providerId + "/auto" : modelId],
      grantRouting: { eligibleGrants: { [providerId]: ["gateway"] }, environmentFallback: false },
      monthlyBudgetMicros: id === "budget" ? 0 : 100, budgetMode: "reserve", requestCostMicros: id.endsWith("unpriced") ? null : 7, retainRequestContent: false }));
    await kv.put("credentials/cf_" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: "cf_" + id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/" + providerId, JSON.stringify({ providerId, enabled: true, monthlyBudgetMicros: 10000 }));
  const origin = (await mf.unsafeGetDirectURL("router")).origin;
  assert.equal((await fetch(origin + "/fixture/grants")).status, 204);
  const response = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token("selection") } });
  assert.equal(response.status, 200); const catalog = await response.json(), provider = catalog.providers.find(row => row.id === providerId);
  assert.equal(catalog.scope.credentialId, "cf_selection");
  assert.equal(provider.models.find(row => row.id === modelId).pricing, null);
  const offers = provider.offers.filter(row => row.modelId === modelId && row.routeKind === "native" && row.endpoint === "messages");
  assert.equal(offers.length, 1); assert.equal(offers[0].eligible, true);
  return origin;
}
async function verifyCallsAndUsage(mf, origin, native) {
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/fixture/calls")).json();
  assert.deepEqual(calls.map(call => call.id).sort(), charged.toSorted(), "one upstream dispatch per admitted case, no replay");
  for (const call of calls) {
    assert.equal(call.url, upstreamUrl); assert.equal(call.headers["cf-aig-authorization"], "Bearer " + secret(call.id));
    assert.equal(call.headers.authorization, undefined); assert.equal(call.headers["x-api-key"], undefined);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    assert.equal(call.body.model, "claude-sonnet-4-6"); assert.equal(call.body.max_tokens, 100); assert.equal(call.body.stream, true); assert.equal(call.expired, false);
    if (successful.includes(call.id)) { assert.equal(call.eof, true); assert.equal(call.cancelled, false); }
    if (native && ["seed", "replay"].includes(call.id)) {
      assert.deepEqual(call.body.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(call.body.output_config, { effort: "low" });
    }
    if (native && call.id === "replay") {
      const blocks = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      assert.equal(blocks.filter(block => block.type === "thinking").length, 1);
      assert.equal(blocks.find(block => block.type === "thinking").signature, "synthetic-signature");
      const tool = blocks.find(block => block.type === "tool_use"), result = blocks.find(block => block.type === "tool_result");
      assert.equal(tool.id, "tool_fixture"); assert.deepEqual(tool.input, { index: 2 }); assert.equal(result.tool_use_id, tool.id); assert.equal(result.content, "synthetic-tool-result");
    }
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|clawrouterRoute/);
  }
  const events = new Map();
  for (const id of cases.filter(id => id !== "invalid")) {
    let usage;
    const expected = catalogOnly.includes(id) ? 0 : 1;
    for (let attempt = 0; attempt < 150; attempt++) {
      const response = await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(id) } }); assert.equal(response.status, 200); usage = await response.json();
      if (usage.usage.events.length === expected) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(usage.usage.events.length, expected, id + " exact receipt cardinality");
    const cost = charged.includes(id) ? 7 : 0; assert.equal(usage.budget.spentMicros, cost, id);
    if (!expected) continue;
    const [event] = usage.usage.events;
    events.set(id, event);
    assert.equal(event.credential_id, "cf_" + id); assert.equal(event.policy_id, "cf_" + id); assert.equal(event.actual_cost_micros, cost);
    if (charged.includes(id)) {
      assert.equal(event.provider, providerId); assert.equal(event.model, modelId); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.reserved_cost_micros, 7);
      assert.equal(event.status, id === "error" ? "provider_error" : id === "cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["error", "cancel"].includes(id) ? [null, null, null] : [11, 3, 14]);
    } else {
      assert.equal(event.status_code, denialFacts[id][0], id);
      assert.equal(event.status, denialFacts[id][0] >= 500 ? "provider_error" : id === "unpriced" ? "client_error" : "denied", id);
      assert.equal(event.reserved_cost_micros, 0, id);
    }
    assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|synthetic-gateway|fixture-secret|must-not-fallback/);
  }
  const response = await fetch(origin + "/fixture/budgets"); assert.equal(response.status, 200);
  const proof = await response.json();
  assert.equal(proof.calls.filter(row => charged.some(id => row.ownerId === "cf_" + id)).length, charged.length * 4);
  for (const id of charged) assertCloudflareSettled(events.get(id), id, proof.calls, proof.rows);
}
async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/fixture/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "cf_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}
async function manifestEnvelope(origin) {
  const response = await fetch(origin + envelopePath, { method: "POST", headers: { authorization: "Bearer " + token("envelope"), "content-type": "application/json" },
    body: JSON.stringify({ body: { model: modelId, stream: true, max_tokens: 100, messages: [{ role: "user", content: "Synthetic envelope" }] } }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /message_stop/);
}
async function runNative(t, fixture, origin, controlOrigin, invoke = runOpenClawConsumer) {
  let receipts = 0;
  const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
    return text => { receipts += text.split("\n").filter(line => line.trim() === "CLOUDFLARE_CANCEL_RETIRED cloudflare-messages").length; t.diagnostic(text); }; } });
  await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/clawrouter/worker-contract.test.ts", typecheck: true,
    env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CF_CONTROL_ORIGIN: controlOrigin, CLAWROUTER_CF_CONTRACT: "cloudflare-messages", NO_COLOR: "1" } });
  assert.equal(receipts, 1, "exact original SDK cancellation and cleanup receipt");
}

// Separate loopback control plane, never an inference proxy or transport replacement.
async function controlBridge(upstream) {
  const lifetime = createLifetimeObserver();
  const serve = async (req, res) => {
    if (!["/fixture/state", "/fixture/release"].includes(req.url) || req.method !== "GET") throw new Error("foreign Cloudflare control request");
    const response = await upstream.fetch("https://fixture.example" + req.url);
    const body = await response.text(); assert.ok(Buffer.byteLength(body) <= 1024);
    res.writeHead(response.status, { "content-type": "application/json" }); res.end(body);
  };
  const bridge = createServer((req, res) => {
    const original = lifetime.invoke("control.handler", serve, undefined, [req, res], { request: req });
    void original.catch(error => res.destroy(error instanceof Error ? error : undefined));
  });
  await new Promise((resolve, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolve); });
  return { origin: "http://127.0.0.1:" + bridge.address().port, async close() {
    await preserveFailures(() => lifetime.join(), [() => new Promise((resolve, reject) => bridge.close(error => error ? reject(error) : resolve())), () => lifetime.restore()]);
  } };
}

test("Cloudflare source assembly pins the real SDK and preserves original workflow rows", () => {
  assert.equal(assembledFixture.includes(marker), false); assert.doesNotThrow(() => stripTypeScriptTypes(assembledFixture));
  assert.doesNotThrow(() => new Function(upstreamFixture().replace("export default", "return")));
  const rows = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")).jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "cloudflare-messages"), [{ consumer: "cloudflare-messages", ref: sourceHead, test: "test/openclaw-cloudflare-messages.test.mjs" }]);
  const provider = snapshot.providers.find(row => row.id === providerId);
  assert.equal(nativePath, "/v1/native/" + providerId + provider.endpoints.find(row => row.id === "messages").path);
  assert.equal(provider.models[0].id, providerId + "/auto"); assert.equal(snapshot.model_index[modelId].pricing, null);
  assert.equal(snapshot.model_index[modelId].nativeCapabilities.endpoints.messages.maxOutputTokens, undefined);
  assert.match(assembledFixture, /boundary-aware:anthropic-messages/);
  assert.match(assembledFixture, /withPluginRuntimeGenerationRegistryScope/);
});
test("Cloudflare observer type projection preserves runtime and refuses source drift", () => {
  assert.equal(stripTypeScriptTypes(typedObserverSource, { mode: "transform" }), stripTypeScriptTypes(untypedObserverSource, { mode: "transform" }));
  const needle = 'patch(body, "cancel", function (...args: any[])';
  assert.throws(() => projectCloudflareObserverTypes(untypedObserverSource.replace(needle, 'patch(body, "cancel", function (...changed: any[])')), /exact CF observer type projection/);
  assert.throws(() => projectCloudflareObserverTypes(typedObserverSource), /exact CF observer type projection/);
});
test("Cloudflare binding rejects wrong route, wrong credential, duplicate and missing originals", () => {
  const binds = createCloudflareBindings(); binds.expect("cf_stream", "chat", upstreamUrl, "POST", secret("stream"), undefined, "cf-aig-authorization");
  assert.throws(() => binds.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer " + secret("stream") } }, "chat"));
  assert.throws(() => binds.claim(upstreamUrl.replace("/anthropic", ""), { method: "POST", headers: { "cf-aig-authorization": "Bearer " + secret("stream") } }, "chat"));
  assert.throws(() => binds.verify());
  const init = { method: "POST", headers: { "cf-aig-authorization": "Bearer " + secret("stream") } };
  binds.claim(upstreamUrl, init, "chat"); binds.verify(); assert.throws(() => binds.claim(upstreamUrl, init, "chat"));
});
test("Cloudflare malformed catalog controls remove facts without inventing eligibility", () => {
  const original = { providers: [{ id: providerId, offers: [{ eligible: true }], models: [{ id: modelId }] }] };
  for (const id of ["offers_empty", "offers_invalid", "model_missing"]) {
    const copy = structuredClone(original), result = rejectCatalog(copy, id); assert.equal(result, copy);
    if (id === "offers_empty") assert.deepEqual(copy.providers[0].offers, []);
    if (id === "offers_invalid") assert.equal(copy.providers[0].offers[0].eligible, false);
    if (id === "model_missing") assert.deepEqual(copy.providers[0].models, []);
  }
  assert.throws(() => rejectCatalog(structuredClone(original), "future")); assert.equal(original.providers[0].offers[0].eligible, true);
});
test("Cloudflare replay continues the original assistant turn without fabricating thinking", () => {
  const assistant = Object.freeze({ role: "assistant", content: Object.freeze([]) });
  const seed = cloudflareHistory("seed"), replay = cloudflareHistory("replay", assistant);
  assert.deepEqual(replay.slice(0, 2), seed);
  assert.equal(replay[2], assistant); assert.equal(replay[3].role, "toolResult");
  assert.equal(replay[3].toolCallId, "tool_fixture");
  assert.deepEqual(replay[3].content, [{ type: "text", text: "synthetic-tool-result" }]);
  assert.equal(replay.length, 4); assert.deepEqual(assistant.content, []);
});
test("Cloudflare caught extra and foreign claims remain independently fatal through cleanup", async () => {
  for (const fault of ["extra", "foreign", "undefined"]) {
    const life = createLifetimeObserver(), binds = createCloudflareBindings();
    const expected = binds.expect("cf_stream", "chat", upstreamUrl, "POST", secret("stream"), undefined, "cf-aig-authorization");
    const init = { method: "POST", headers: { "cf-aig-authorization": "Bearer " + secret("stream") } };
    assert.equal(retainCloudflareClaim(life, () => binds.claim(upstreamUrl, init, "chat")), expected);
    let original, escaped, caught = false, restored = false;
    try { retainCloudflareClaim(life, () => {
      try { if (fault === "undefined") throw undefined; binds.claim(fault === "foreign" ? upstreamUrl + "/foreign" : upstreamUrl, init, "chat"); }
      catch (error) { original = error; throw error; }
    }); } catch (error) { caught = true; escaped = error; }
    assert.equal(caught, true); assert.equal(escaped, original); binds.verify();
    assert.equal(life.errors.length, 1); assert.equal(life.errors[0], original);
    await assert.rejects(preserveFailures(() => life.join(), [() => { life.restore(); restored = true; }]), error => error.errors.includes(original));
    assert.equal(restored, true); assert.equal(life.errors[0], original);
  }
});
test("Cloudflare budget observation preserves original receiver, arguments and promise", async () => {
  const life = createLifetimeObserver(), owner = {}, calls = [], id = {}, response = new Response(null), original = Promise.resolve(response);
  const url = "https://fixture.example/reserve", init = { method: "POST", body: JSON.stringify({ reservationId: "reservation", costMicros: 7 }) };
  const stub = { fetch(...args) { assert.equal(this, stub); assert.equal(args[0], url); assert.equal(args[1], init); return original; } };
  const namespace = { idFromName(name) { assert.equal(this, namespace); assert.equal(name, "fixture:cf_stream"); return id; },
    get(value) { assert.equal(this, namespace); assert.equal(value, id); return stub; } };
  const observed = observeCloudflareBudgets(namespace, life, owner, calls), bound = observed.get(observed.idFromName("fixture:cf_stream"));
  assert.equal(bound.fetch(url, init), original); assert.equal(await original, response); await life.join();
  assert.equal(calls.length, 1); assert.equal(calls[0].owner, owner); assert.equal(calls[0].status, 200);
  let caught = false;
  try { bound.fetch(url, { get method() { throw undefined; } }); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); await assert.rejects(life.join(), error => error.errors.includes(undefined)); life.restore();
});
test("Cloudflare settlement requires original request and both exact settled SQLite rows", () => {
  const calls = [], rows = [], event = { request_id: "original-request" };
  for (const objectName of ["fixture:cf_stream", "provider:" + providerId]) {
    const reservationId = objectName + ":reservation", common = { ownerId: "cf_stream", requestId: event.request_id, objectName, reservationId, status: 200 };
    calls.push({ ...common, path: "/reserve", policyId: objectName, windowKey: "window", scopeKey: "scope", costMicros: 7, dispatched: true },
      { ...common, path: "/settle", actualCostMicros: 7 });
    rows.push({ objectName, reservation_id: reservationId, policy_id: objectName, window_key: "window", budget_scope_key: "scope", reserved_micros: 7, dispatch_started: 1, settled: 1 });
  }
  assertCloudflareSettled(event, "stream", calls, rows);
  for (const change of [
    (c, r) => { r[0].settled = 0; }, (c, r) => { r[1].settled = 2; },
    (c, r) => { r[0].reservation_id = "foreign"; }, (c, r) => { r[0].budget_scope_key = "foreign"; },
    (c, r) => { r[0].dispatch_started = 0; }, (c, r) => { r.push(r[0]); },
    c => { c[0].requestId = "foreign"; }, c => { c[1].status = 500; }, c => { c[0].dispatched = false; },
    c => { c[1].reservationId = "foreign"; }, c => { c.pop(); }, c => { c.push(c[0]); },
  ]) { const copied = structuredClone({ calls, rows }); change(copied.calls, copied.rows); assert.throws(() => assertCloudflareSettled(event, "stream", copied.calls, copied.rows)); }
});
test("Cloudflare cleanup preserves falsey primary and independent failures", async () => {
  const seen = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { seen.push(1); throw null; }, () => seen.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(seen, [1, 2]);
  let attempts = 0;
  await assert.rejects(retire({ getWorker: async () => ({ fetch: () => Promise.reject(undefined) }), dispatchFetch() { attempts++; return Promise.reject(null); } }, false), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.equal(attempts, 1);
});
test("Cloudflare original read result and detached release survive observation; independent failures stay fatal", async () => {
  for (const fault of ["none", "observe", "release", "read"]) {
    const life = createLifetimeObserver({ bindings: [], bodySucceeded: () => true, readProgress() { if (fault === "observe") throw undefined; } });
    const owner = {}, receiver = {}, arg = {}, body = new ReadableStream({ start(c) { if (fault === "read") c.error(undefined); else { c.enqueue(new Uint8Array([1])); c.close(); } } });
    const release = () => fault === "release" ? Promise.reject(undefined) : Promise.resolve();
    const result = { response: new Response(body), release }, original = Promise.resolve(result);
    assert.equal(life.guard(function (value) { assert.equal(this, receiver); assert.equal(value, arg); return original; }, receiver, [arg], owner), original);
    const value = await original; assert.equal(value, result); const reader = value.response.body.getReader();
    const reading = reader.read(); await reading.catch(() => {});
    if (fault !== "read") await reader.read(); await reader.closed.catch(() => {}); reader.releaseLock();
    const detached = value.release; await detached().catch(() => {});
    if (fault === "none") await life.join(); else await assert.rejects(life.join(), error => error.errors.includes(undefined));
    life.restore(); assert.equal(value.release, release);
  }
});
async function cloudflareCloneControl({ ownerChange, status = 400, releaseFault, cloneFault, readerFault, stream } = {}) {
  const owner = { id: "unpriced", kind: "chat", method: "POST", url: "http://fixture.example" + nativePath,
    credential: token("unpriced"), header: "x-api-key", prefix: "", claimed: true, ...ownerChange };
  const life = createLifetimeObserver({ bindings: [owner], bodySucceeded: () => true,
    cloudflareClone: { url: "http://fixture.example" + nativePath, credential: token("unpriced") } });
  const response = new Response(stream ?? new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }), { status });
  if (cloneFault) response.clone = () => { throw undefined; };
  if (readerFault) {
    // Inject one synthetic original-method failure before observation. Recovery
    // still consumes the native tee and closes every actual reader we acquired.
    const originalClone = response.clone;
    response.clone = function (...args) {
      const cloned = Reflect.apply(originalClone, this, args), body = this.body, getReader = body.getReader;
      body.getReader = function (...operands) {
        const reader = Reflect.apply(getReader, this, operands), original = reader[readerFault.kind]; let failed = false;
        reader[readerFault.kind] = function (...values) {
          if (!failed) {
            failed = true;
            if (readerFault.mode === "held") return Reflect.apply(original, this, values).then(() => readerFault.gate.promise);
            if (readerFault.mode === "throw") throw undefined;
            return Promise.reject(undefined);
          }
          return Reflect.apply(original, this, values);
        };
        return reader;
      };
      return cloned;
    };
  }
  const clone = response.clone, parent = response.body, releasePromise = releaseFault === "reject" ? Promise.reject(undefined) : Promise.resolve();
  void releasePromise.catch(() => {});
  const release = () => { if (releaseFault === "throw") throw undefined; return releasePromise; };
  const result = { response, release }, original = Promise.resolve(result), receiver = {}, argument = {};
  assert.equal(life.guard(function (value) { assert.equal(this, receiver); assert.equal(value, argument); return original; }, receiver, [argument], owner), original);
  assert.equal(await original, result);
  return { life, owner, result, clone, parent, release, releasePromise };
}
async function consumeCloudflareClone(body) {
  const reader = body.getReader();
  await preserveFailures(async () => { for (;;) if ((await reader.read()).done) break; }, [() => reader.closed, () => reader.releaseLock()]);
}
test("Cloudflare clone observes exact original products and admits only both EOF descendants", async () => {
  const f = await cloudflareCloneControl(), operand = {};
  try {
    const clone = Reflect.apply(f.result.response.clone, f.result.response, [operand]);
    const left = f.result.response.body, right = clone.body, op = f.life.operations.find(row => row.kind === "response.clone");
    assert.equal(op.original, f.clone); assert.equal(op.receiver, f.result.response); assert.equal(op.operands[0], operand); assert.equal(op.operands.length, 1);
    assert.equal(op.value, clone); assert.equal(op.pending, clone); assert.equal(op.state, "fulfilled");
    assert.notEqual(left, f.parent); assert.notEqual(right, f.parent); assert.notEqual(left, right);
    assert.equal(f.life.bodies[0].body, f.parent); assert.equal(f.parent.locked, true);
    assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
    await Promise.all([consumeCloudflareClone(left), consumeCloudflareClone(right)]);
    const detached = f.result.release, returned = detached(); assert.equal(returned, f.releasePromise); await returned;
    await f.life.join(); assert.equal(f.life.cloneDiagnostic().clones[0][6], 1);
    assert.deepEqual(f.life.summary(), { operations: 11, settled: 11, rejected: 0, qualifiedReadRejections: 0, readers: 2, unlocked: 2, releases: 1 });
    assert.equal(f.life.bodies.length, 3); assert.equal(f.life.bodies[0].body, f.parent); assert.equal(f.parent.locked, true);
  } finally { await f.life.restore(); }
  assert.equal(f.result.response.clone, f.clone); assert.equal(f.result.release, f.release);
});
test("Cloudflare clone refuses foreign owner, credential, acquisition and receiver identities", async () => {
  for (const mode of ["id", "credential", "url", "claimed", "status", "acquisition", "receiver"]) {
    const ownerChange = mode === "id" ? { id: "foreign" } : mode === "credential" ? { credential: "foreign" }
      : mode === "url" ? { url: "http://fixture.example/foreign" } : mode === "claimed" ? { claimed: false } : undefined;
    const f = await cloudflareCloneControl({ ownerChange, status: mode === "status" ? 403 : 400 });
    const response = f.result.response, foreign = new Response(new Uint8Array([4]), { status: 400 });
    try {
      if (mode === "acquisition") f.result.response = foreign;
      const receiver = mode === "receiver" ? foreign : response;
      const clone = Reflect.apply(response.clone, receiver, []);
      await Promise.all([consumeCloudflareClone(receiver.body), consumeCloudflareClone(clone.body), ...(receiver !== response ? [consumeCloudflareClone(response.body)] : [])]);
      await f.result.release();
      await assert.rejects(f.life.join()); assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      assert.ok(f.life.errors.length > 0);
    } finally { f.result.response = response; await f.life.restore(); }
  }
});
test("Cloudflare clone joins only exact post-EOF cleanup cancellation", { timeout: 5000 }, async () => {
  for (const mode of ["fulfilled", "argument", "repeated", "foreign", "pending-fulfill", "pending-reject", "throw", "reject"]) {
    const gate = Promise.withResolvers(), held = mode.startsWith("pending-");
    const readerFault = held ? { kind: "cancel", mode: "held", gate } : ["throw", "reject"].includes(mode) ? { kind: "cancel", mode } : undefined;
    const f = await cloudflareCloneControl({ readerFault }), clone = f.result.response.clone();
    const reader = f.result.response.body.getReader();
    try {
      await consumeCloudflareClone(clone.body);
      while (!(await reader.read()).done) {} await reader.closed;
      const foreign = new Response(new Uint8Array([9])).body.getReader();
      while (!(await foreign.read()).done) {} await foreign.closed;
      const originals = []; let threw = false;
      try {
        originals.push(mode === "foreign" ? Reflect.apply(reader.cancel, foreign, []) : mode === "argument" ? reader.cancel(undefined) : reader.cancel());
        if (mode === "repeated") originals.push(reader.cancel());
      } catch (reason) { threw = true; assert.equal(reason, undefined); }
      const results = Promise.allSettled(originals);
      reader.releaseLock(); foreign.releaseLock();
      const release = f.result.release();
      let done = false; const joined = f.life.join(); void joined.then(() => { done = true; }, () => { done = true; });
      if (held) {
        await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
        assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
        if (mode === "pending-reject") gate.reject(undefined); else gate.resolve();
      }
      const outcomes = await results; await release;
      if (mode === "fulfilled" || mode === "pending-fulfill") {
        await joined; assert.equal(f.life.cloneDiagnostic().clones[0][6], 1);
        const op = f.life.operations.find(row => row.kind === "reader.cancel");
        assert.equal(op.pending, originals[0]); assert.equal(op.receiver, reader); assert.equal(op.operands.length, 0);
        assert.ok(op.settled > f.life.readers.find(row => row.reader === reader).unlockInvocations[0]);
      } else {
        await assert.rejects(joined); assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
        if (mode === "throw") assert.equal(threw, true);
        if (mode === "reject" || mode === "pending-reject") assert.deepEqual(outcomes, [{ status: "rejected", reason: undefined }]);
      }
      assert.ok(f.life.readers.every(row => row.eof && row.unlocked === 1 && !row.body.locked));
      assert.equal(f.life.operations.filter(op => op.state === "pending").length, 0);
    } finally { gate.resolve(); await f.life.restore(); }
  }
});
test("Cloudflare clone rejects repeated, nested, aliased and swapped original body topology", async () => {
  for (const mode of ["repeated", "nested", "aliased", "swapped"]) {
    const f = await cloudflareCloneControl(); let clone;
    try {
      clone = f.result.response.clone(); const firstLeft = f.result.response.body, firstRight = clone.body;
      const extra = mode === "repeated" ? f.result.response.clone() : mode === "nested" ? clone.clone() : undefined;
      if (mode === "swapped") {
        Object.defineProperty(f.result.response, "body", { configurable: true, value: firstRight });
        Object.defineProperty(clone, "body", { configurable: true, value: firstLeft });
      }
      if (mode === "aliased") Object.defineProperty(clone, "body", { configurable: true, value: firstLeft });
      await Promise.all([consumeCloudflareClone(f.result.response.body), consumeCloudflareClone(mode === "aliased" ? firstRight : clone.body), ...(extra ? [consumeCloudflareClone(extra.body)] : [])]);
      await f.result.release(); await assert.rejects(f.life.join());
      assert.ok(f.life.cloneDiagnostic().clones.every(row => row[6] === 0));
    } finally {
      if (mode === "swapped") { Reflect.deleteProperty(f.result.response, "body"); Reflect.deleteProperty(clone, "body"); }
      if (mode === "aliased") Reflect.deleteProperty(clone, "body");
      await f.life.restore();
    }
  }
});
test("Cloudflare clone preserves original falsey throws and failed guard release", async () => {
  for (const releaseFault of ["throw", "reject"]) {
    const f = await cloudflareCloneControl({ releaseFault });
    try {
      const clone = f.result.response.clone(); await Promise.all([consumeCloudflareClone(f.result.response.body), consumeCloudflareClone(clone.body)]);
      let caught = false; try { await f.result.release(); } catch (reason) { caught = true; assert.equal(reason, undefined); }
      assert.equal(caught, true); await assert.rejects(f.life.join(), error => error.errors.includes(undefined));
      assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
    } finally { await f.life.restore(); }
  }
  const f = await cloudflareCloneControl();
  try {
    // The brand check is still the original native method's synchronous throw.
    let original; try { Reflect.apply(f.clone, {}, []); } catch (error) { original = error; }
    assert(original instanceof TypeError); let escaped;
    try { Reflect.apply(f.result.response.clone, {}, []); } catch (error) { escaped = error; }
    assert(escaped instanceof TypeError);
    const op = f.life.operations.find(row => row.kind === "response.clone"); assert.equal(op.state, "sync_throw"); assert.equal(op.reason, escaped);
    await consumeCloudflareClone(f.result.response.body); await f.result.release(); await assert.rejects(f.life.join());
  } finally { await f.life.restore(); }
  const falsey = await cloudflareCloneControl({ cloneFault: true });
  try {
    let caught = false; try { falsey.result.response.clone(); } catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true); await consumeCloudflareClone(falsey.result.response.body); await falsey.result.release();
    await assert.rejects(falsey.life.join(), error => error.errors.includes(undefined));
  } finally { await falsey.life.restore(); }
});
test("Cloudflare clone keeps an unread sibling and rejected original reads fatal", async () => {
  for (const mode of ["unread", "read-rejection"]) {
    let controller;
    const stream = mode === "read-rejection" ? new ReadableStream({ start(value) { controller = value; } }) : undefined;
    const f = await cloudflareCloneControl({ stream }); const clone = f.result.response.clone();
    try {
      if (controller) controller.error(undefined);
      await consumeCloudflareClone(f.result.response.body).catch(error => { if (mode !== "read-rejection") throw error; });
      if (mode === "read-rejection") await consumeCloudflareClone(clone.body).catch(() => {});
      await f.result.release(); await assert.rejects(f.life.join()); assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      if (mode === "unread") { await consumeCloudflareClone(clone.body); await f.life.join(); }
      else assert.ok(f.life.operations.some(op => op.kind === "reader.read" && op.state === "rejected" && op.reason === undefined));
    } finally { await f.life.restore(); }
  }
});
test("Cloudflare clone retains falsey read/cancel faults through independent cleanup", async () => {
  for (const kind of ["read", "cancel"]) for (const mode of ["throw", "reject"]) {
    const f = await cloudflareCloneControl({ readerFault: { kind, mode }, releaseFault: "throw" });
    const clone = f.result.response.clone(), reader = f.result.response.body.getReader();
    let caught = false, released = false;
    try {
      try { await reader[kind](); } catch (reason) { caught = true; assert.equal(reason, undefined); }
      assert.equal(caught, true);
      while (!(await reader.read()).done) {} await reader.closed; reader.releaseLock();
      await consumeCloudflareClone(clone.body);
      try { await f.result.release(); } catch (reason) { released = true; assert.equal(reason, undefined); }
      assert.equal(released, true);
      const fault = f.life.operations.find(op => op.kind === "reader." + kind && op.state !== "fulfilled");
      assert.equal(fault.state, mode === "throw" ? "sync_throw" : "rejected"); assert.equal(fault.reason, undefined);
      await assert.rejects(f.life.join(), error => error.errors.filter(reason => reason === undefined).length === 2);
      assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      assert.equal(f.life.readers.length, 2); assert.ok(f.life.readers.every(row => row.eof && row.unlocked === 1 && !row.body.locked));
      assert.equal(f.life.operations.filter(op => op.state === "pending").length, 0);
    } finally { await f.life.restore(); }
  }
});
test("Cloudflare clone cannot substitute a foreign reader or an unfinished sibling", async () => {
  for (const mode of ["foreign-reader", "pending-sibling"]) {
    const f = await cloudflareCloneControl(); const clone = f.result.response.clone();
    try {
      await consumeCloudflareClone(f.result.response.body); await f.result.release();
      const foreign = new Response(new Uint8Array([9]));
      const reader = mode === "foreign-reader" ? Reflect.apply(clone.body.getReader, foreign.body, []) : clone.body.getReader();
      const first = reader.read();
      assert.ok(f.life.operations.some(op => op.kind === "reader.read" && op.pending === first && op.state === "pending"));
      assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      await first;
      if (mode === "foreign-reader") {
        while (!(await reader.read()).done) {} await reader.closed; reader.releaseLock();
        await consumeCloudflareClone(clone.body); await assert.rejects(f.life.join());
        assert.ok(f.life.readers.some(row => row.body !== row.receivedBody));
      } else {
        await assert.rejects(f.life.join());
        while (!(await reader.read()).done) {} await reader.closed; reader.releaseLock();
        await f.life.join();
      }
    } finally { await f.life.restore(); }
  }
});
test("Cloudflare clone never treats byte-limit cancellation or a pending cancel as EOF", { timeout: 5000 }, async () => {
  for (const rejects of [false, true]) {
    const gate = Promise.withResolvers(); let cancelled = 0;
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled++; return gate.promise; } });
    const f = await cloudflareCloneControl({ stream }); const clone = f.result.response.clone();
    const readers = [f.result.response.body.getReader(), clone.body.getReader()];
    try {
      for (const reader of readers) assert.equal((await reader.read()).value.byteLength, 3);
      const cancellations = readers.map(reader => reader.cancel()); const outcomes = Promise.allSettled(cancellations);
      for (const reader of readers) { await reader.closed; reader.releaseLock(); }
      await f.result.release(); let settled = false;
      const joined = f.life.join(); void joined.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(cancelled, 1);
      assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      if (rejects) gate.reject(undefined); else gate.resolve();
      const results = await outcomes; assert.ok(results.every(row => row.status === (rejects ? "rejected" : "fulfilled")));
      if (rejects) for (const row of results) assert.equal(row.reason, undefined);
      await assert.rejects(joined); assert.equal(f.life.cloneDiagnostic().clones[0][6], 0);
      assert.equal(f.life.operations.filter(op => op.state === "pending").length, 0);
    } finally { gate.resolve(); await f.life.restore(); }
  }
});
test("Cloudflare clone diagnostics keep original failures and independent reporting faults", async () => {
  const primary = new Error("synthetic original"), lines = [];
  const life = { join: () => Promise.reject(primary), cloneDiagnostic: () => ({ v: 1, clones: [], bodies: [] }) };
  await assert.rejects(joinCloudflareLifetime(life, line => lines.push(line)), error => error === primary);
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]) <= 4096); assert.deepEqual(JSON.parse(lines[0].slice("CLOUDFLARE_CLONE_STATE ".length)), life.cloneDiagnostic());
  await assert.rejects(joinCloudflareLifetime(life, () => { throw undefined; }), error => error.errors[0] === primary && error.errors[1] === undefined);
  await assert.rejects(joinCloudflareLifetime({ ...life, cloneDiagnostic: () => "x".repeat(4096) }, () => assert.fail("oversized record emitted")), error => error.errors[0] === primary && /bound/.test(error.errors[1].message));
});
test("Cloudflare native receipt cannot borrow another family or duplicate a successful marker", async () => {
  const exact = "CLOUDFLARE_CANCEL_RETIRED cloudflare-messages";
  const invoke = lines => async (context, options) => {
    assert.equal(options.sourceHead, sourceHead); assert.equal(options.testPath, "extensions/clawrouter/worker-contract.test.ts");
    assert.equal(options.typecheck, true);
    assert.equal(options.env.CLAWROUTER_CF_CONTRACT, "cloudflare-messages");
    for (const line of lines) context.diagnostic(line);
  };
  await runNative({ diagnostic() {} }, "/synthetic/cloudflare.test.ts", "http://127.0.0.1:1", "http://127.0.0.1:2", invoke([exact]));
  for (const lines of [[], ["MYTHOS_CANCEL_RETIRED mythos5"], [exact, exact]]) await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/cloudflare.test.ts", "http://127.0.0.1:1", "http://127.0.0.1:2", invoke(lines)));
});
test("Cloudflare typecheck binds only the exact client head and fixture path", () => {
  const path = "extensions/clawrouter/worker-contract.test.ts", plan = consumerTypecheckPlan(sourceHead, path);
  assert.equal(plan.sha256, "b032aa889d4ab5512e57f26871a5839a38ae326b18e765dce2dcec3b4fd80d49");
  assert.deepEqual(plan.args, ["scripts/run-tsgo.mjs", "-p", "test/tsconfig/tsconfig.extensions.test.json", "--noEmit", "--incremental", "false"]);
  assert.throws(() => consumerTypecheckPlan("0".repeat(40), path));
  assert.throws(() => consumerTypecheckPlan("df9f72058439ec5b4d27b5f2eb52a3d076c8f80f", path));
  assert.throws(() => consumerTypecheckPlan(sourceHead, "extensions/clawrouter/foreign.test.ts"));
  assert.throws(() => consumerTypecheckPlan(sourceHead, "extensions/clawrouter/worker-google-continuation-contract.test.ts"));
  assert.throws(() => consumerTypecheckPlan("b6072e63fdf09422ea70ef4bbdc818536d871047", path));
});
test("Cloudflare producer joins real cancellation and retains expiry as failure", { timeout: 15000 }, async () => {
  for (const mode of ["cancel", "expiry"]) {
    const fixture = new Function(upstreamFixture().replace("export default", "return"))(), tails = [];
    const response = await fixture.fetch(new Request(upstreamUrl, { method: "POST", headers: { "cf-aig-authorization": "Bearer " + secret("cancel") }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [], stream: true }) }), {}, { waitUntil(p) { tails.push(p); } });
    assert.equal(tails.length, 1); let settled = false; void tails[0].then(() => { settled = true; }, () => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    const reader = response.body.getReader(); await reader.read();
    if (mode === "cancel") { const original = reader.read(); await reader.cancel(); await original; }
    else await assert.rejects(async () => { for (;;) if ((await reader.read()).done) throw new Error("unexpected success"); }, /Cloudflare fixture source deadline/);
    await reader.closed.catch(() => {}); reader.releaseLock();
    const outcomes = await Promise.allSettled(tails), proof = await (await fixture.fetch(new Request("https://fixture.example/fixture/retire"))).json();
    assert.equal(outcomes[0].status, mode === "cancel" ? "fulfilled" : "rejected"); assert.equal(proof.sourceCancellation.expired, mode === "expiry");
    assert.equal(proof.sourceCancellation.cancelReturned, mode === "cancel" ? 1 : 0); assert.equal(proof.sourceCancellation.pending, 0); assert.equal(proof.accepted, false, "missing other cases cannot qualify");
  }
});

test("Cloudflare real Worker and SQLite locally verify the fixture, independently of SDK acceptance", { timeout: 120000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-cloudflare-worker-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleWorkerOutcome(routerFixture()), upstreamFixture(), { directRouter: true, bindings: workerBindings }); const origin = await setup(mf);
    const upstream = await mf.getWorker("upstream");
    for (const id of [...charged.filter(id => id !== "envelope"), ...denied]) {
      const controller = new AbortController();
      const response = await fetch(origin + nativePath, { method: "POST", signal: controller.signal, headers: { "x-api-key": token(id), "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Synthetic Worker check" }] }) });
      if (denied.includes(id)) {
        const body = await response.json(); assert.deepEqual([response.status, body.error?.code], denialFacts[id], id);
        continue;
      }
      assert.equal(response.status, 200, id + (response.status !== 200 ? ": " + (await response.text()).slice(0, 1024) : ""));
      if (id === "eof") {
        const reading = response.text(); let done = false; void reading.then(() => { done = true; }, () => { done = true; });
        let state;
        for (let i = 0; i < 150; i++) { state = await (await upstream.fetch("https://fixture.example/fixture/state")).json(); if (state.wireSent) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        assert.deepEqual(state, { wireSent: true, eof: false, expired: false }); assert.equal(done, false);
        // The real ledger counts this outstanding reservation as spent. It must
        // not qualify as settlement before the original body reaches true EOF.
        const pendingUsage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(id) } })).json();
        assert.equal(pendingUsage.budget.spentMicros, 7);
        const pending = await (await fetch(origin + "/fixture/budgets")).json();
        const reserved = pending.calls.find(row => row.ownerId === "cf_eof" && row.objectName === "fixture:cf_eof" && row.path === "/reserve"); assert(reserved);
        const row = pending.rows.find(row => row.objectName === reserved.objectName && row.reservation_id === reserved.reservationId); assert(row);
        assert.equal(row.reserved_micros, 7); assert.equal(row.settled, 0); assert.equal(row.dispatch_started, 1);
        assert.throws(() => assertCloudflareSettled({ request_id: response.headers.get("x-request-id") }, id, pending.calls, pending.rows));
        assert.equal((await upstream.fetch("https://fixture.example/fixture/release")).status, 200); await reading;
      } else if (id === "cancel") {
        const reader = response.body.getReader(); let text = "";
        while (!text.includes("synthetic-answer")) { const value = await reader.read(); assert.equal(value.done, false); text += new TextDecoder().decode(value.value); }
        const original = reader.read(); controller.abort();
        const outcomes = await Promise.allSettled([original, reader.closed]); assert.equal(outcomes[0].status, "rejected"); assert.equal(outcomes[1].status, "rejected"); reader.releaseLock();
      } else await response.text();
    }
    await manifestEnvelope(origin); await verifyCallsAndUsage(mf, origin, false); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

test("Cloudflare actual registered client through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-cloudflare-sdk-")); let mf, bridge, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleWorkerOutcome(routerFixture()), upstreamFixture(), { directRouter: true, bindings: workerBindings }); const origin = await setup(mf);
    bridge = await controlBridge(await mf.getWorker("upstream"));
    const fixture = join(temporary, "cloudflare-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    await runNative(t, fixture, origin, bridge.origin); await manifestEnvelope(origin); await verifyCallsAndUsage(mf, origin, true); accepted = true;
  }, [() => mf && retire(mf, accepted), () => bridge?.close(), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
