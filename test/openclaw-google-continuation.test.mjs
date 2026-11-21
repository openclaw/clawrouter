import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "yaml";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer, consumerTypecheckPlan } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "b6072e63fdf09422ea70ef4bbdc818536d871047";
const sha = value => createHash("sha256").update(value).digest("hex");
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
assert.equal(sha(donor), "ab514fc2ea8ff572684381413230590e118f7b49826dc1a282736d2e885f6075");
const observerSource = donor.slice(donor.indexOf("type OriginalOperation ="), donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS"));
// The source-pinned observer originally ran through native transpilation. Add
// only erased annotations for the stricter transplanted extension test graph.
const typedObserverSource = observerSource
  .replaceAll("function (...args: any[])", "function (this: unknown, ...args: any[])")
  .replaceAll("function (...operands: any[])", "function (this: unknown, ...operands: any[])")
  .replaceAll("every(unlock =>", "every((unlock: number) =>")
  .replace(/\b(cancel|closed)\[0\]\./g, "$1[0]!.");
assert.equal(stripTypeScriptTypes(typedObserverSource, { mode: "transform" }), stripTypeScriptTypes(observerSource, { mode: "transform" }), "observer runtime changed during type annotation");
const observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver };")();
const responseHarness = readFileSync(new URL("./openclaw-provider-responses.test.mjs", import.meta.url), "utf8");
const outcomeSource = responseHarness.slice(responseHarness.indexOf("const workerOutcomePins ="), responseHarness.indexOf("function assertProof("));
assert.equal(sha(outcomeSource), "2f8c481b8f13174b2c8fdaee756044239fefa1f2e0cc9e584fbc235731e6dbf7");
const { bundleResponsesOutcome } = new Function("assert", "createHash", "createRequire", "readFileSync", "importMetaResolve", outcomeSource.replaceAll("import.meta.resolve", "importMetaResolve") + "; return { bundleResponsesOutcome };")(assert, createHash, createRequire, readFileSync, specifier => import.meta.resolve(specifier));
const fixtureText = readFileSync(new URL("./fixtures/openclaw-google-continuation-contract.test.ts", import.meta.url), "utf8");
const provider = snapshot.providers.find(row => row.id === "google-gemini");
const model = provider.models.find(row => row.upstream === "gemini-3.5-flash");
const nativePath = "/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse";
const upstreamUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse";
const localDenials = ["body", "policy", "key", "profile", "session", "origin"];
const workerDenials = ["grant_revoke", "grant_change", "policy_generation", "caller_budget", "provider_budget"];
const invalidTails = ["late_sse", "late_json", "truncated", "done_before_eof"];
const ids = ["complete", ...localDenials, ...workerDenials, ...invalidTails, "cancel"];
const expected = ids.flatMap(id => [{ id, hop: 0 }, ...(["complete", ...workerDenials].includes(id) ? [{ id, hop: 1, denied: id !== "complete" }] : [])]);
const key = id => "clawrouter-live-gcont_" + id + "-fixture-secret";
const contract = { provider: provider.id, model: model.id, nativePath };

const bindingSource = fixtureText.slice(fixtureText.indexOf("// BEGIN GOOGLE BINDINGS"), fixtureText.indexOf("// END GOOGLE BINDINGS"));
const bindingCode = stripTypeScriptTypes(bindingSource);
const { createGoogleBindings } = new Function(bindingCode + "; return { createGoogleBindings };")();
assert.equal(fixtureText.split("/* OWNED_LIFETIME_IMPLEMENTATION */").length, 2);
const assembled = fixtureText.replace("/* OWNED_LIFETIME_IMPLEMENTATION */", typedObserverSource);

function wireFor(id, hop) {
  const frame = value => "data: " + JSON.stringify(value) + "\n\n";
  const usageMetadata = { promptTokenCount: hop ? 1000 : 12, candidatesTokenCount: hop ? 5 : 3, thoughtsTokenCount: 2, totalTokenCount: hop ? 1007 : 17, serviceTier: "standard" };
  if (hop) return { prefix: frame({ candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "synthetic-second" }] } }], usageMetadata }), tail: "" };
  const checkpoint = frame({ candidates: [{ index: 0, continuationToken: "synthetic-checkpoint-" + id, content: { role: "model", parts: [{ text: "checkpoint " }] } }] });
  if (id === "cancel") return { prefix: checkpoint, tail: "" };
  const final = frame({ candidates: [{ index: 0, finishReason: "CONTINUATION", continuationToken: "synthetic-continuation-" + id, content: { role: "model", parts: [{ text: "final" }] } }], usageMetadata });
  const tails = { late_sse: "event: error\n\n", late_json: JSON.stringify({ error: { code: 503, message: "synthetic-terminal-failure" } }), truncated: 'data: {"candidates":[', done_before_eof: frame({ error: { code: 503, message: "synthetic-after-done" } }) };
  return { prefix: checkpoint + final + (id === "done_before_eof" ? "data: [DONE]\n\n" : ""), tail: tails[id] ?? "" };
}

function routerFixture(rows = expected) {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
${bindingCode}
const rows = ${JSON.stringify(rows)}, ids = [...new Set(rows.map(row => row.id))], ingress = createGoogleBindings(), outbound = createGoogleBindings(), receipts = [];
let acceptedConsumer = false, sourceCancellation;
const lifetime = createLifetimeObserver(undefined, { ownerId: "gcont_cancel_0", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of rows) { const id = "gcont_" + row.id + "_" + row.hop;
 ingress.expect(id, "chat", ${JSON.stringify(nativePath)}, "POST", "clawrouter-live-gcont_" + row.id + "-fixture-secret");
 if (!row.denied) outbound.expect(id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-google-" + row.id, undefined, "x-goog-api-key"); }
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) { const owner = outbound.claim(args[0], args[1], "chat"); owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed); if (!owner.ingress) throw new Error("unbound Google outbound"); lifetime.signal(owner, args[1]?.signal ?? args[0]?.signal); return lifetime.invoke("fetch", originalFetch, this, args, owner, response => lifetime.response(response, owner)); });
async function authority(env, path, body) { const response = await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings")).fetch("https://authority" + path, { method: "POST", body: JSON.stringify(body) }); if (!response.ok) throw new Error("Google authority mutation failed: " + response.status); const text = await response.text(); if (path === "/credentials/mutate" && JSON.parse(text).outcome !== "updated") throw new Error("Google credential mutation failed"); }
export default { ...handler, fetch(request, env, context) {
 const url = new URL(request.url), id = url.searchParams.get("id");
 if (url.pathname === "/fixture/grants") return (async () => { for (const id of ids) await putGrantCredentials(env, "oauth/gcont_" + id + "/google", { provider: "google-gemini", kind: "api_key", enabled: true, credential: "synthetic-google-" + id }); return new Response(null, { status: 204 }); })();
 if (url.pathname === "/fixture/receipts") return Response.json(receipts);
 if (url.pathname === "/fixture/mutate") return (async () => {
  if (!ids.includes(id)) throw new Error("foreign fixture mutation");
  if (id === "grant_revoke" || id === "grant_change") await putGrantCredentials(env, "oauth/gcont_" + id + "/google", { provider: "google-gemini", kind: "api_key", enabled: id !== "grant_revoke", credential: id === "grant_change" ? "synthetic-replaced-google" : "synthetic-google-" + id });
  else if (id === "policy_generation" || id === "caller_budget") { const policy = await env.POLICY_KV.get("policies/gcont_" + id, "json"); if (id === "policy_generation") policy.generation = "changed"; else policy.monthlyBudgetMicros = 10000; await authority(env, "/policies/put", { policyId: "gcont_" + id, policy });
   if (id === "policy_generation") { const credential = await env.POLICY_KV.get("credentials/gcont_" + id, "json"); await authority(env, "/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "put", credentialId: "gcont_" + id, credential }); } }
  else if (id === "provider_budget") await authority(env, "/connections/put", { providerId: "google-gemini", enabled: true, monthlyBudgetMicros: 10000 });
  else throw new Error("unknown mutation"); return Response.json({ applied: true }); })();
 if (url.pathname === "/fixture/retire") return (async () => { let accepted = false; try { await preserveFailures(async () => { const proof = await request.json(); acceptedConsumer = proof.acceptedConsumer === true; sourceCancellation = proof.sourceCancellation; await lifetime.join(); ingress.verify(); outbound.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); } return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() }); })();
 const poisoned = { ...env, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" };
 if (url.pathname !== ${JSON.stringify(nativePath.split("?")[0])}) return handler.fetch(request, poisoned, context);
 for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = url.origin + row.url;
 const owner = ingress.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
 const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
 return lifetime.invoke("handler", handler.fetch, handler, [request, poisoned, context], owner, response => { const requestId = response.headers.get("x-clawrouter-request-id"); if (!requestId || receipts.some(row => row.requestId === requestId)) throw new Error("missing/duplicate Google request identity"); receipts.push({ id: owner.id, requestId, status: response.status }); });
} };`;
}

function upstreamFixture(rows = expected.filter(row => !row.denied)) {
  return `${observerCode}
${bindingCode}
const rows = ${JSON.stringify(rows)}, lifetime = createLifetimeObserver(), bindings = createGoogleBindings(), calls = [], owners = new Map(), wireFor = ${wireFor.toString()};
for (const row of rows) bindings.expect("gcont_" + row.id + "_" + row.hop, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-google-" + row.id, undefined, "x-goog-api-key");
async function serve(request, context, owner) {
 const row = rows.find(row => owner.id === "gcont_" + row.id + "_" + row.hop); if (!row) throw new Error("foreign Google source");
 const body = await lifetime.invoke("request.json", request.json, request, [], owner);
 if (!JSON.stringify(body).includes("Synthetic continuation " + row.id)) throw new Error("Google wire case binding changed");
 if ((row.hop === 0 && Object.hasOwn(body, "continuationToken")) || (row.hop === 1 && body.continuationToken !== "synthetic-continuation-" + row.id)) throw new Error("Google hop binding changed");
 const call = { id: row.id, hop: row.hop, body, method: request.method, url: request.url, key: request.headers.get("x-goog-api-key"), authorization: request.headers.get("authorization"), eof: false, released: row.hop === 1, cancelled: false, expired: false };
 calls.push(call); owners.set(owner, call);
 const wire = wireFor(row.id, row.hop), prefix = new TextEncoder().encode(wire.prefix), tail = new TextEncoder().encode(wire.tail); let offset = 0, tailOffset = 0, complete = false, timer, heartbeat, wake, controller, resolveProducer, rejectProducer;
 const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; }); lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
 const finish = (failed, reason) => { if (complete) return; complete = true; clearTimeout(timer); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(reason); else resolveProducer(); };
 timer = setTimeout(() => { call.expired = true; const error = new Error("Google source deadline"); finish(true, error); controller?.error(error); }, 10000);
 const source = { start(c) { controller = c; }, pull(c) {
  if (offset < prefix.length) { const end = Math.min(offset + 7, prefix.length); c.enqueue(prefix.slice(offset, end)); offset = end; return; }
  if (!call.released || row.id === "cancel") return lifetime.watch("source.heartbeat", new Promise(resolve => { wake = resolve; heartbeat = setTimeout(() => { if (!complete) c.enqueue(new TextEncoder().encode(": heartbeat\\n\\n")); resolve(); }, 25); }), owner);
  if (tailOffset < tail.length) { c.enqueue(tail.slice(tailOffset)); tailOffset = tail.length; return; }
  call.eof = true; c.close(); finish(false);
 }, cancel() { call.cancelled = true; finish(false); } };
 for (const kind of ["pull", "cancel"]) { const original = source[kind]; lifetime.patch(source, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
 return new Response(new ReadableStream(source, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
export default { fetch(request, env, context) {
 const url = new URL(request.url), id = url.searchParams.get("id");
 if (url.origin === "https://fixture.example" && url.pathname === "/calls") return Response.json(calls);
 if (url.origin === "https://fixture.example" && ["/state", "/release"].includes(url.pathname)) { const selected = calls.filter(call => call.id === id), call = selected[0]; if (!call) return new Response("no original source", { status: 404 }); if (url.pathname === "/release") { if (call.released) throw new Error("duplicate EOF release"); call.released = true; } return Response.json({ calls: selected.length, eof: call.eof, released: call.released, expired: call.expired }); }
 if (url.href === "https://fixture.example/retire") return (async () => { let accepted = false; try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); } const owner = bindings.bindings.find(row => row.id === "gcont_cancel_0"), call = owners.get(owner), ops = lifetime.operations.filter(op => op.owner === owner), cancels = ops.filter(op => op.kind === "source.cancel"); return Response.json({ ...lifetime.summary(), accepted, sourceCancellation: { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true, cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: ops.filter(op => op.state === "pending").length, failed: ops.filter(op => !["pending", "fulfilled"].includes(op.state)).length } }); })();
 const owner = bindings.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal); const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); }); return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}

async function setup(mf, selected = ids) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const id of selected) {
    const policyId = "gcont_" + id;
    await kv.put("policies/" + policyId, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: [provider.id], models: [model.id], grantRouting: { eligibleGrants: { [provider.id]: ["google"] }, environmentFallback: false }, monthlyBudgetMicros: 10000000, budgetMode: "reserve", requestCostMicros: null, retainRequestContent: false }));
    await kv.put("credentials/" + policyId, JSON.stringify({ enabled: true, secretSha256: sha("fixture-secret"), policyId, policyGeneration: "fixture" }));
  }
  await kv.put("connections/" + provider.id, JSON.stringify({ providerId: provider.id, enabled: true, monthlyBudgetMicros: 100000000 }));
  const origin = (await mf.unsafeGetDirectURL("router")).origin;
  assert.equal((await fetch(origin + "/fixture/grants")).status, 204);
  return origin;
}
function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof)); assert.equal(proof.operations, proof.settled);
  assert.equal(proof.readers, proof.unlocked); assert.equal(proof.rejected, proof.qualifiedReadRejections ?? 0);
}
function googleCaseReceipts(receipts, rows, id) {
  const expectedIds = rows.filter(row => row.id === id).map(row => "gcont_" + row.id + "_" + row.hop);
  const owned = receipts.filter(row => expectedIds.includes(row.id));
  assert.deepEqual(owned.map(row => row.id).sort(), [...expectedIds].sort(), id + " exact case/hop receipts");
  return owned;
}
async function verify(mf, origin, rows = expected) {
  const selectedIds = [...new Set(rows.map(row => row.id))];
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/calls")).json();
  assert.deepEqual(calls.map(row => row.id + "_" + row.hop).sort(), rows.filter(row => !row.denied).map(row => row.id + "_" + row.hop).sort());
  for (const call of calls) {
    assert.equal(call.method, "POST"); assert.equal(call.url, upstreamUrl); assert.equal(call.key, "synthetic-google-" + call.id);
    assert.equal(call.authorization, null); assert.equal(call.expired, false);
    assert.equal(call.body.generationConfig.temperature, 0.25); assert.equal(call.body.generationConfig.maxOutputTokens, 128);
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
  }
  const first = calls.find(row => row.id === "complete" && row.hop === 0), second = calls.find(row => row.id === "complete" && row.hop === 1);
  const { continuationToken, ...same } = second.body; assert.equal(continuationToken, "synthetic-continuation-complete"); assert.deepEqual(same, first.body);
  const receipts = await (await fetch(origin + "/fixture/receipts")).json();
  assert.deepEqual(receipts.map(row => row.id).sort(), rows.map(row => "gcont_" + row.id + "_" + row.hop).sort());
  assert.equal(new Set(receipts.map(row => row.requestId)).size, receipts.length);
  for (const id of selectedIds) {
    const owned = googleCaseReceipts(receipts, rows, id); let usage;
    for (let attempt = 0; attempt < 150; attempt++) {
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + key(id) } })).json();
      if (usage.usage?.events.length === owned.length && usage.budget.spentMicros === usage.usage.events.reduce((n, event) => n + event.actual_cost_micros, 0)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(usage.usage.events.length, owned.length, id + " bound receipt presence");
    for (const receipt of owned) {
      const event = usage.usage.events.find(event => event.request_id === receipt.requestId); assert.ok(event, id + " original request ID");
      assert.equal(event.provider, provider.id); assert.equal(event.model, model.id); assert.equal(event.credential_id, "gcont_" + id);
      assert.equal(event.policy_id, "gcont_" + id);
      if (receipt.status !== 200) { assert.equal(event.actual_cost_micros, 0, id); assert.equal(event.cost_basis, "none", id); continue; }
      if (id === "cancel") {
        assert.equal(event.status, "client_error"); assert.equal(event.cost_basis, "manifest_reservation");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
        assert.ok(event.reserved_cost_micros > 0); assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
        assert.equal(calls.find(call => call.id === id).cancelled, true); continue;
      }
      // The controlled late failure may reach the Worker before or after the
      // client ends delivery. It never establishes a free inference. Exact
      // observed-usage tariff proof belongs to the completed hops below.
      if (invalidTails.includes(id)) { assert.ok(event.actual_cost_micros > 0, id + " dispatched uncertainty remains charged"); continue; }
      const hop = receipt.id.endsWith("_1"), tokens = hop ? { input: 1000, output: 7, total: 1007 } : { input: 12, output: 5, total: 17 };
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [tokens.input, tokens.output, tokens.total], id);
      assert.equal(event.actual_cost_micros, hop ? 1563 : 63, id); assert.equal(event.cost_basis, "manifest_pricing");
      if (hop) assert.ok(event.reserved_cost_micros >= 1572864, "continuation reserves restored full input independently");
    }
    assert.equal(usage.budget.spentMicros, usage.usage.events.reduce((n, event) => n + event.actual_cost_micros, 0), id + " final budget settlement");
  }
}

async function startControlBridge(upstream) {
  const lifetime = createLifetimeObserver();
  const serve = async (req, res) => {
    const url = new URL(req.url, "https://fixture.example");
    if (!["/fixture/state", "/fixture/release"].includes(url.pathname) || req.method !== "GET") throw new Error("foreign Google control request");
    const response = await upstream.fetch("https://fixture.example" + url.pathname.slice("/fixture".length) + url.search);
    const body = await response.text(); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body);
  };
  const bridge = createServer((req, res) => {
    const original = lifetime.invoke("control.handler", serve, undefined, [req, res], { request: req });
    // The original rejected Promise remains in the ledger even when the socket
    // error is reported to the caller. Falsey reasons cannot disappear here.
    original.catch(error => res.destroy(error instanceof Error ? error : undefined));
  });
  await new Promise((resolve, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolve); });
  return { origin: "http://127.0.0.1:" + bridge.address().port, async close() {
    await preserveFailures(() => lifetime.join(), [() => new Promise((resolve, reject) => bridge.close(error => error ? reject(error) : resolve())), () => lifetime.restore()]);
  } };
}

async function retainGoogleFailureChannels(t, run) {
  try { return await run(); } catch (error) {
    await preserveFailures(() => { throw error; }, [() => {
      for (const failure of error instanceof AggregateError ? error.errors : [error]) {
        if (!failure || typeof failure !== "object") continue;
        for (const channel of ["stdout", "stderr"]) {
          const descriptor = Object.getOwnPropertyDescriptor(failure, channel);
          if (descriptor && typeof descriptor.value === "string") {
            const text = descriptor.value;
            t.diagnostic(`Google original failed process ${channel} ${Buffer.byteLength(text)}B/${sha(text)}\n${text}`);
          }
        }
      }
    }]);
  }
}

test("actual registered Google continuation through Worker and SQLite", { skip: !source, timeout: 540000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-continuation-")); let mf, acceptedConsumer = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture()), upstreamFixture(), { directRouter: true, preventEviction: true });
    const origin = await setup(mf), upstream = await mf.getWorker("upstream");
    // Test controls do not replace transport. They only release the real EOF
    // barrier or observe its original source; source cancellation stays passive.
    const bridge = await startControlBridge(upstream);
    // The SDK receives a separate explicit control origin; provider traffic stays
    // on the direct Router socket and is observed by the original guard.
    await preserveFailures(async () => {
      const fixture = join(temporary, "google-continuation-contract.test.ts"); await writeFile(fixture, assembled);
      let receipts = 0, cancellations = 0;
      const observed = new Proxy(t, { get(target, name, receiver) { if (name !== "diagnostic") return Reflect.get(target, name, receiver); return text => { const lines = text.split("\n").map(line => line.trim()); receipts += lines.filter(line => line === "GOOGLE_CONTINUATION_TWO_HOPS_RETIRED").length; cancellations += lines.filter(line => line === "GOOGLE_CONTINUATION_CANCEL_RETIRED").length; t.diagnostic(text); }; } });
      await retainGoogleFailureChannels(observed, () => runOpenClawConsumer(observed, { source, sourceHead, fixture: pathToFileURL(fixture), typecheck: true, testPath: "extensions/clawrouter/worker-google-continuation-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_GOOGLE_CONTROL_ORIGIN: bridge.origin, CLAWROUTER_GOOGLE_CONTINUATION_CONTRACT: JSON.stringify(contract), CLAWROUTER_API_KEY: "", GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", NO_COLOR: "1" } }));
      assert.equal(receipts, 1); assert.equal(cancellations, 1); await verify(mf, origin); acceptedConsumer = true;
    }, [() => bridge.close()]);
  }, [async () => {
    if (!mf) return; let upstream;
    await preserveFailures(async () => { upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream); assert.deepEqual(upstream.sourceCancellation, { ownerId: "gcont_cancel_0", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 }); }, [async () => assertProof(await (await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) })).json())]);
  }, () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

test("Google receipt ownership separates overlapping case names and exact hops", () => {
  const rows = [{ id: "policy", hop: 0 }, { id: "policy_generation", hop: 0 }, { id: "policy_generation", hop: 1 }];
  const receipts = rows.map(row => ({ id: "gcont_" + row.id + "_" + row.hop, requestId: {} }));
  assert.deepEqual(googleCaseReceipts(receipts, rows, "policy"), [receipts[0]]);
  assert.deepEqual(googleCaseReceipts(receipts, rows, "policy_generation"), receipts.slice(1));
  assert.throws(() => googleCaseReceipts(receipts.slice(1), rows, "policy"));
  assert.throws(() => googleCaseReceipts([...receipts, receipts[0]], rows, "policy"));
  assert.throws(() => googleCaseReceipts([{ ...receipts[0], id: "gcont_policy_1" }], rows, "policy"));
});
test("Google continuation bindings retain original input and reject missing, duplicate and foreign requests", () => {
  for (const mode of ["good", "foreign", "method", "duplicate", "missing"]) {
    const bindings = createGoogleBindings(), row = bindings.expect("one", "chat", "https://fixture.example/path", "POST", "synthetic-key");
    const init = { method: mode === "method" ? "GET" : "POST", headers: { authorization: "Bearer " + (mode === "foreign" ? "foreign" : "synthetic-key") } };
    if (mode === "missing") { assert.throws(() => bindings.verify()); continue; }
    if (["foreign", "method"].includes(mode)) { assert.throws(() => bindings.claim("https://fixture.example/path", init, "chat")); assert.equal(row.claimed, false); continue; }
    assert.equal(bindings.claim("https://fixture.example/path", init, "chat"), row); assert.equal(row.input, init); bindings.verify();
    if (mode === "duplicate") assert.throws(() => bindings.claim("https://fixture.example/path", init, "chat"));
  }
});
test("Google native runner binds the exact pin, provider, controls and post-join receipts", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8"));
  const matrix = workflow.jobs.consumer.strategy.matrix.include;
  assert.deepEqual(matrix.filter(row => row.consumer === "google-continuation"), [{ consumer: "google-continuation", ref: sourceHead, test: "test/openclaw-google-continuation.test.mjs" }]);
  assert.equal(new Set(matrix.map(row => row.consumer)).size, matrix.length);
  assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  assert.equal(contract.provider, "google-gemini"); assert.equal(contract.model, "google/gemini-3.5-flash");
  assert.equal(assembled.includes("/* OWNED_LIFETIME_IMPLEMENTATION */"), false);
  assert.match(assembled, /CLAWROUTER_GOOGLE_CONTROL_ORIGIN/);
  assert.match(fixtureText, /GoogleContinuationOptions/);
  assert.match(fixtureText, /registerProviderPlugins\(plugin, googlePlugin\)/);
  assert.match(fixtureText, /withPluginRuntimeGenerationRegistryScope\(registry/);
  assert.match(fixtureText, /selected\.strategy\)\.toBe\("boundary-aware:google-generative-ai"\)/);
  const runCase = fixtureText.slice(fixtureText.indexOf("async function runCase"), fixtureText.indexOf("const it ="));
  for (const marker of ["GOOGLE_CONTINUATION_TWO_HOPS_RETIRED", "GOOGLE_CONTINUATION_CANCEL_RETIRED"]) {
    assert.ok(runCase.indexOf(marker) > runCase.indexOf("lifetime.join()"));
    assert.equal(fixtureText.split(marker).length, 2);
  }
  const path = "extensions/clawrouter/worker-google-continuation-contract.test.ts";
  const plan = consumerTypecheckPlan(sourceHead, path);
  assert.equal(plan.project, "test/tsconfig/tsconfig.extensions.test.json");
  assert.throws(() => consumerTypecheckPlan("0".repeat(40), path));
  assert.throws(() => consumerTypecheckPlan(sourceHead, "test/foreign.test.ts"));
});
test("Google claims cannot credit a foreign invocation or hide a falsey observer fault", () => {
  const claimSource = stripTypeScriptTypes(fixtureText.slice(fixtureText.indexOf("// BEGIN GOOGLE CLAIM"), fixtureText.indexOf("// END GOOGLE CLAIM")));
  for (const reason of [undefined, false, null]) {
    const lifetime = { errors: [] }, bindings = { claim() { throw reason; } };
    const claim = new Function("lifetime", "bindings", "invocation", claimSource + ";return claimOwned;")(lifetime, bindings, { getStore() {} });
    let caught = false; try { claim("url", {}, "chat"); } catch (error) { caught = true; assert.equal(error, reason); }
    assert.equal(caught, true); assert.deepEqual(lifetime.errors, [reason]);
  }
  const lifetime = { errors: [] }, owner = {}, foreign = {};
  const claim = new Function("lifetime", "bindings", "invocation", claimSource + ";return claimOwned;")(lifetime, { claim: () => owner }, { getStore: () => foreign });
  assert.throws(() => claim("url", {}, "chat"), /foreign Google invocation/); assert.equal(lifetime.errors.length, 1);
});
test("Google original operation and independent falsey cleanup failures survive", async () => {
  for (const reason of [undefined, false, null, new Error("synthetic")]) {
    const life = createLifetimeObserver(), original = Promise.reject(reason), receiver = {}, input = {};
    assert.equal(life.invoke("source.pull", function (arg) { assert.equal(this, receiver); assert.equal(arg, input); return original; }, receiver, [input], {}), original);
    await assert.rejects(life.join(), error => error instanceof AggregateError && error.errors.includes(reason));
    const seen = []; await assert.rejects(preserveFailures(() => { throw reason; }, [() => { seen.push(1); throw undefined; }, () => seen.push(2)]), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === reason);
    assert.deepEqual(seen, [1, 2]);
  }
});
test("Google failure reporting retains original falsey errors after every independent restoration", async () => {
  const source = stripTypeScriptTypes(fixtureText.slice(fixtureText.indexOf("async function runCase"), fixtureText.indexOf("const it =")));
  const calls = [], context = { preserveFailures, bodySucceeded: false,
    lifetime: { join: () => calls.push("join"), restore: () => calls.push("lifetime"), guards: [], summary: () => ({}), joinDiagnostic: () => null },
    bindings: { bindings: [], verify: () => calls.push("bindings") }, vi: { restoreAllMocks: () => calls.push("spies") },
    console: { log() { throw false; } } };
  runInNewContext(source + ";globalThis.runCase = runCase;", context);
  await assert.rejects(context.runCase(() => { throw undefined; }), error => error.errors?.length === 2 && error.errors[0] === undefined && error.errors[1] === false);
  assert.deepEqual(calls, ["join", "bindings", "lifetime", "spies"]);
});

test("Google failed native channels remain complete without replacing original or falsey faults", async () => {
  const error = Object.assign(new Error("synthetic native failure"), { stdout: "complete stdout\n", stderr: "complete stderr\n" }), records = [];
  await assert.rejects(retainGoogleFailureChannels({ diagnostic: text => records.push(text) }, () => { throw error; }), value => value === error);
  assert.equal(records.length, 2);
  assert.ok(records[0].endsWith(error.stdout)); assert.ok(records[1].endsWith(error.stderr));
  assert.match(records[0], new RegExp(sha(error.stdout))); assert.match(records[1], new RegExp(sha(error.stderr)));
  await assert.rejects(retainGoogleFailureChannels({ diagnostic() { throw undefined; } }, () => { throw error; }), value => value instanceof AggregateError && value.errors[0] === error && value.errors[1] === undefined);
  let caught = false;
  try { await retainGoogleFailureChannels({ diagnostic() { throw new Error("unexpected output"); } }, () => { throw undefined; }); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
});

test("Google final and intermediate wire evidence remains separate", () => {
  const wire = wireFor("complete", 0); assert.match(wire.prefix, /synthetic-checkpoint-complete/); assert.match(wire.prefix, /CONTINUATION/); assert.equal(wire.tail, "");
  assert.match(wireFor("done_before_eof", 0).prefix, /\[DONE\]/); assert.match(wireFor("done_before_eof", 0).tail, /synthetic-after-done/);
  for (const id of invalidTails) assert.notEqual(wireFor(id, 0).tail, "");
});

test("Google control bridge retains falsey failures independently of the caller", async () => {
  for (const reason of [undefined, false, null]) {
    const bridge = await startControlBridge({ fetch: () => Promise.reject(reason) });
    await assert.rejects(fetch(bridge.origin + "/fixture/state?id=one"));
    await assert.rejects(bridge.close(), error => error instanceof AggregateError && error.errors.includes(reason));
  }
});

test("Google real Worker binds EOF authority, both budgets and original grant across two HTTP hops", { timeout: 60000 }, async () => {
  const rows = expected.filter(row => ["complete", ...workerDenials].includes(row.id)).flatMap(row => row.id === "complete" && row.hop === 0 ? [row, { id: "complete", hop: 9, denied: true }] : [row]);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-authority-")); let mf;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture(rows)), upstreamFixture(rows.filter(row => !row.denied)), { directRouter: true, preventEviction: true });
    const origin = await setup(mf, [...new Set(rows.map(row => row.id))]), upstream = await mf.getWorker("upstream");
    for (const id of ["complete", ...workerDenials]) {
      const body = { systemInstruction: { parts: [{ text: "Synthetic continuation " + id }] }, contents: [{ role: "user", parts: [{ text: "Synthetic unchanged original input" }] }], generationConfig: { temperature: 0.25, maxOutputTokens: 128 } };
      const request = payload => fetch(origin + nativePath, { method: "POST", headers: { authorization: "Bearer " + key(id), "content-type": "application/json" }, body: JSON.stringify(payload) });
      const initial = await request(body); assert.equal(initial.status, 200, await (initial.status === 200 ? Promise.resolve("") : initial.text()));
      const reader = initial.body.getReader(); let text = "", eof = false;
      await preserveFailures(async () => {
        while (!text.includes('"final"')) { const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value); }
        assert.deepEqual(await (await upstream.fetch("https://fixture.example/state?id=" + id)).json(), { calls: 1, eof: false, released: false, expired: false });
        if (id === "complete") {
          const premature = await request({ ...body, continuationToken: "synthetic-continuation-" + id });
          assert.equal(premature.status, 409, await premature.text());
          assert.equal((await (await upstream.fetch("https://fixture.example/state?id=" + id)).json()).calls, 1);
        }
        assert.equal((await (await upstream.fetch("https://fixture.example/release?id=" + id)).json()).released, true);
        while (!eof) { const next = await reader.read(); eof = next.done; if (!eof) text += new TextDecoder().decode(next.value); }
      }, [async () => { if (!eof) await reader.cancel(); reader.releaseLock(); }]);
      assert.match(text, /CONTINUATION/);
      if (id !== "complete") { const changed = await fetch(origin + "/fixture/mutate?id=" + id); assert.equal(changed.status, 200, await changed.text()); }
      const second = await request({ ...body, continuationToken: "synthetic-continuation-" + id });
      const wire = await second.text(); assert.equal(second.status, id === "complete" ? 200 : ["caller_budget", "provider_budget"].includes(id) ? 402 : 409, id + ": " + wire);
      if (id === "complete") assert.match(wire, /synthetic-second/);
    }
    await verify(mf, origin, rows);
  }, [async () => {
    if (!mf) return;
    await preserveFailures(async () => assertProof(await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json()), [async () => assertProof(await (await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ acceptedConsumer: true }) })).json())]);
  }, () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
