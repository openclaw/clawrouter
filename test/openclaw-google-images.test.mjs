import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { runOpenClawConsumer, consumerTypecheckPlan } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d173f1ae09324d1fb94e445fa4235a87fc175373";
const testPath = "extensions/clawrouter/worker-google-images-contract.test.ts";
const models = ["gemini-3.1-flash-image", "gemini-3-pro-image"];
const successes = ["model0_text", "model0_edit", "model1_text", "model1_edit", "tool_edit"];
const charged = [...successes, "incomplete", "malformed", "cancel"];
const denied = ["unpriced", "aborted", "foreign", "stale", "scope", "registry"];
const ids = [...charged, ...denied];
const modelFor = id => id.startsWith("model1") ? models[1] : models[0];
const route = id => "/v1/native/google-gemini/v1beta/models/" + modelFor(id) + ":generateContent";
const upstreamUrl = id => "https://generativelanguage.googleapis.com/v1beta/models/" + modelFor(id) + ":generateContent";
const key = id => "clawrouter-live-gimage_" + id + "-fixture-secret";
const input = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
const output = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=";
const fixtureText = readFileSync(new URL("./fixtures/openclaw-google-images-contract.test.ts", import.meta.url), "utf8");
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
const observerSource = donor.slice(start, end), observerCode = stripTypeScriptTypes(observerSource);
const observerSHA = "cf00bd435b61c4b49fdad7bd6b95ed683238c4ba469c71f4df18af25655463d1";
assert.equal(createHash("sha256").update(observerSource).digest("hex"), observerSHA);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings }; ")();

// d173 image-google.ts finally cancels the already-errored original body.
// The observed read/closed/body.cancel reasons remain rejected; only this
// exact authored host-abort disposition is admitted after complete release.
function imageLifetimeSource(text) {
  const anchor = "  function providerError(params: any) {";
  assert.equal(text.split(anchor).length, 2);
  text = text.replace(anchor, String.raw`  function imageBodyCancelDisposition(op: OriginalOperation) {
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
  return text.replace(verdict, "sdkAbortDisposition(op) || imageBodyCancelDisposition(op) || sdkProviderErrorDisposition(op)");
}
const sdkObserverSource = imageLifetimeSource(observerSource);

// Type annotations preserve the donor's runtime byte-for-byte.
const typedObserver = sdkObserverSource.replaceAll("function (...args: any[])", "function (this: unknown, ...args: any[])")
  .replaceAll("function (...operands: any[])", "function (this: unknown, ...operands: any[])")
  .replaceAll("every(unlock =>", "every((unlock: number) =>")
  .replace(/\b(cancel|closed|rejectedReads|releases)\[0\]\./g, "$1[0]!.")
  .replace(/sdkAbortDisposition\((closed|rejectedReads)\[0\]\)/g, "sdkAbortDisposition($1[0]!)");
assert.equal(stripTypeScriptTypes(typedObserver, { mode: "transform" }), stripTypeScriptTypes(sdkObserverSource, { mode: "transform" }));
assert.equal(fixtureText.split("/* OWNED_LIFETIME_IMPLEMENTATION */").length, 2);
const assembledFixture = fixtureText.replace("/* OWNED_LIFETIME_IMPLEMENTATION */", typedObserver);
const proxyResponseSHA = "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174";
function inspectionOverlay(text) {
  assert.equal(createHash("sha256").update(text).digest("hex"), proxyResponseSHA);
  const anchor = '    resolve({ ...inspection, delivery,'; assert.equal(text.split(anchor).length, 2);
  return 'import { imageInspection } from "image-inspection";\n' + text.replace(anchor, '    imageInspection.current(operation, inspection, delivery, responseFormat);\n' + anchor);
}
async function bundleRouter() {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const result = await build({ stdin: { contents: routerFixture(), resolveDir: process.cwd(), sourcefile: "google-image-fixture.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "image-delivery", setup(build) {
      build.onResolve({ filter: /^image-inspection$/ }, () => ({ path: "witness", namespace: "image" }));
      build.onLoad({ filter: /.*/, namespace: "image" }, () => ({ contents: "export const imageInspection = { current() {} };", loader: "js" }));
      build.onLoad({ filter: /[/\\]worker[/\\]proxy-response\.ts$/ }, args => ({ contents: inspectionOverlay(readFileSync(args.path, "utf8")), loader: "ts" }));
    } }] }); return result.outputFiles[0].text;
}
function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof));
  assert.equal(proof.settled, proof.operations); assert.equal(proof.readers, proof.unlocked); assert.equal(proof.rejected, 0);
}
function googleBindings() {
  const rows = [];
  return { rows,
    expect(id, url, credential) { rows.push({ id, kind: "image", method: "POST", url, credential, claimed: false }); },
    claim(input, init) {
      const request = input instanceof Request ? input : undefined, url = request?.url ?? String(input);
      const method = init?.method ?? request?.method ?? "GET", headers = new Headers(init?.headers ?? request?.headers);
      const matches = rows.filter(row => row.url === url && row.method === method && headers.get("x-goog-api-key") === row.credential);
      assert.equal(headers.get("authorization"), null); assert.equal(matches.length, 1); assert.equal(matches[0].claimed, false);
      matches[0].claimed = true; return matches[0];
    },
    verify() { assert.ok(rows.every(row => row.claimed)); },
  };
}
const googleBindingSource = googleBindings.toString();
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { imageInspection } from "image-inspection";
const assert = { equal(a,b) { if (a !== b) throw new Error("Google image identity mismatch"); }, ok(value) { if (!value) throw new Error("Google image missing observation"); } };
${observerCode}
${googleBindingSource}
const lifetime = createLifetimeObserver(), incoming = createRequestBindings(), outgoing = googleBindings(), deliveries = new Map();
for (const id of ${JSON.stringify(charged)}) {
  incoming.expect(id, "image", ${JSON.stringify(route('').split(models[0])[0])} + (id.startsWith("model1") ? ${JSON.stringify(models[1])} : ${JSON.stringify(models[0])}) + ":generateContent", "POST", "clawrouter-live-gimage_" + id + "-fixture-secret");
  outgoing.expect(id, "https://generativelanguage.googleapis.com/v1beta/models/" + (id.startsWith("model1") ? ${JSON.stringify(models[1])} : ${JSON.stringify(models[0])}) + ":generateContent", "fixture-upstream-" + id);
}
imageInspection.current = (operation, inspection, delivery, format) => {
  try {
    if (format !== "google.image") return;
    const signal = Object.getOwnPropertyDescriptor(operation, "signal")?.value, caller = Object.getOwnPropertyDescriptor(operation, "caller")?.value;
    const owners = outgoing.rows.filter(row => row.signal === signal && row.claimed);
    assert.equal(owners.length, 1); const owner = owners[0]; assert.equal(owner.ingress.signal, caller);
    assert.equal(deliveries.has(owner.id), false); assert.ok(["complete", "canceled", "failed"].includes(delivery));
    deliveries.set(owner.id, { delivery, outcome: inspection.outcome });
  } catch (error) { lifetime.errors.push(error); }
};
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  let owner; try { owner = outgoing.claim(args[0], args[1]); } catch (error) { lifetime.errors.push(error); throw error; }
  owner.ingress = incoming.bindings.find(row => row.id === owner.id && row.claimed); if (!owner.ingress) { const error = new Error("unbound image ingress"); lifetime.errors.push(error); throw error; }
  lifetime.signal(owner, args[1]?.signal ?? args[0]?.signal);
  return lifetime.invoke("fetch", originalFetch, this, args, owner, value => lifetime.response(value, owner));
});
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") { for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/gimage_" + id + "/google-gemini", { provider: "google-gemini", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id }); return new Response(null, { status: 204 }); }
  if (path === "/fixture/requests") return Response.json(lifetime.operations.filter(op => op.kind === "handler").map(op => {
    assert.equal(op.state, "fulfilled"); return { id: op.owner.id, requestId: op.value.headers.get("x-clawrouter-request-id"), status: op.value.status, ...deliveries.get(op.owner.id) };
  }));
  if (path === "/fixture/retire") { let accepted = false; try { await preserveFailures(async () => { await lifetime.join(); incoming.verify(); outgoing.verify(); }, [() => lifetime.restore()]); accepted = true; } catch(error) { lifetime.errors.push(error); }
    return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() }); }
  const configured = { ...env, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback" };
  if (path === "/v1/catalog" && /gimage_(stale|scope)-/.test(request.headers.get("authorization") ?? "")) {
    const response = await handler.fetch(request, configured, context), value = await response.json();
    if ((request.headers.get("authorization") ?? "").includes("gimage_stale-")) value.observedAt = "2000-01-01T00:00:00.000Z";
    else value.scope = { ...value.scope, authType: "anonymous" };
    return Response.json(value, { status: response.status, headers: response.headers });
  }
  if (!path.startsWith("/v1/native/google-gemini/")) return handler.fetch(request, configured, context);
  for (const row of incoming.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  let owner; try { owner = incoming.claim(request, undefined, "image"); } catch(error) { lifetime.errors.push(error); throw error; }
  owner.request = request; lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, configured, context], owner);
} };`;
}
function upstreamFixture() {
  return `const assert = { equal(a,b) { if (a !== b) throw new Error("Google source identity mismatch"); }, ok(value) { if (!value) throw new Error("Google source missing observation"); } };
${observerCode}
${googleBindingSource}
const lifetime = createLifetimeObserver(), bindings = googleBindings(), calls = [];
for (const id of ${JSON.stringify(charged)}) bindings.expect(id, "https://generativelanguage.googleapis.com/v1beta/models/" + (id.startsWith("model1") ? ${JSON.stringify(models[1])} : ${JSON.stringify(models[0])}) + ":generateContent", "fixture-upstream-" + id);
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const call = { id: owner.id, method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body, completed: false, cancelled: false, expired: false }; calls.push(call);
  const payload = { candidates: [{ ...(owner.id === "incomplete" ? {} : { finishReason: "STOP" }), content: { parts: [{ inlineData: { mimeType: "image/png", data: owner.id === "cancel" ? ${JSON.stringify(largePng())} : ${JSON.stringify(output)} } }] } }] };
  const bytes = new TextEncoder().encode(owner.id === "malformed" ? '{"candidates":' : JSON.stringify(payload)); let offset = 0, controller, timer;
  let resolve, reject; const completion = new Promise((yes,no) => { resolve = yes; reject = no; }); lifetime.watch("source.completion", completion, owner); context.waitUntil(completion);
  timer = setTimeout(() => { call.expired = true; const error = new Error("Google image source expiry"); reject(error); controller?.error(error); }, 10000);
  const source = { start(value) { controller = value; }, pull(value) { if (offset === bytes.length) { value.close(); call.completed = true; clearTimeout(timer); resolve(); }
    else { const end = Math.min(offset + (owner.id === "cancel" ? 8192 : 7), bytes.length); value.enqueue(bytes.slice(offset,end)); offset = end; } },
    cancel() { call.cancelled = true; clearTimeout(timer); resolve(); } };
  for (const kind of ["pull", "cancel"]) { const original = source[kind]; lifetime.patch(source, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
}
export default { fetch(request,env,context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => { let accepted = false; try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch(error) { lifetime.errors.push(error); } return Response.json({ ...lifetime.summary(), accepted }); })();
  let owner; try { owner = bindings.claim(request); } catch(error) { lifetime.errors.push(error); throw error; }
  const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request,context,owner], owner);
} };`;
}
function largePng() {
  const chunk = (type, data) => { const content = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4); prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([prefix,content,suffix]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(512,0); header.writeUInt32BE(512,4); header[8]=8; header[9]=6;
  const raw = Buffer.alloc(512*(1+512*4)); let state=1;
  for (let y=0;y<512;y++) for(let x=1;x<=512*4;x++) { state=(Math.imul(state,1664525)+1013904223)>>>0; raw[y*(1+512*4)+x]=state>>>24; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]).toString("base64");
}
async function setup(mf) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const id of ids) {
    await kv.put("policies/gimage_"+id, JSON.stringify({ enabled:true,generation:"fixture",providers:[id==="foreign"?"xai":"google-gemini"],models:["google/"+modelFor(id)],tenantId:"fixture",
      grantRouting:{eligibleGrants:{"google-gemini":["google-gemini"]},environmentFallback:false},monthlyBudgetMicros:100,requestCostMicros:id==="unpriced"?null:7,budgetMode:"reserve",retainRequestContent:false }));
    await kv.put("credentials/gimage_"+id,JSON.stringify({enabled:true,secretSha256:createHash("sha256").update("fixture-secret").digest("hex"),policyId:"gimage_"+id,policyGeneration:"fixture"}));
  }
  await kv.put("connections/google-gemini",JSON.stringify({providerId:"google-gemini",enabled:true}));
  const origin = String(await mf.unsafeGetDirectURL("router")).replace(/\/$/, "");
  const response=await fetch(origin+"/fixture/grants");assert.equal(response.status,204);await response.arrayBuffer();
  const catalog=await(await fetch(origin+"/v1/catalog",{headers:{authorization:"Bearer "+key("model0_text")}})).json();
  assert.equal(catalog.scope.authType,"proxy_key");assert.equal(catalog.scope.credentialId,"gimage_model0_text");assert.ok(Math.abs(Date.now()-Date.parse(catalog.observedAt))<10000);
  const offers=catalog.providers.find(p=>p.id==="google-gemini").offers.filter(o=>o.endpoint==="image_generate"&&o.modelId==="google/"+models[0]);
  assert.equal(offers.length,1);assert.equal(offers[0].eligible,true);assert.equal(offers[0].routeKind,"native");assert.equal(offers[0].route,"/v1/native/google-gemini/v1beta/models/${model}:generateContent");return origin;
}
async function verify(mf,origin,t) {
  const calls=await(await(await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();assert.equal(calls.length,charged.length);
  const receipts=await(await fetch(origin+"/fixture/requests")).json();assert.equal(receipts.length,charged.length);assert.equal(new Set(receipts.map(r=>r.requestId)).size,charged.length);
  for(const id of charged) {
    const matches=calls.filter(c=>c.id===id);assert.equal(matches.length,1,id);const call=matches[0];assert.equal(call.method,"POST");assert.equal(call.url,upstreamUrl(id));
    assert.equal(call.headers["x-goog-api-key"],"fixture-upstream-"+id);assert.equal(call.headers.authorization,undefined);assert.equal(call.completed,true);assert.equal(call.cancelled,false);assert.equal(call.expired,false);
    assert.deepEqual(call.body.generationConfig,{responseModalities:["TEXT","IMAGE"],imageConfig:{aspectRatio:"1:1",imageSize:"1K"}});
    assert.deepEqual(call.body.contents.flatMap(c=>c.parts.filter(p=>p.inlineData)),id.endsWith("edit")?[{inlineData:{mimeType:"image/png",data:input}}]:[]);
    assert.doesNotMatch(JSON.stringify(call.headers),/clawrouter-live-|must-not-fallback/);
    const bound=receipts.find(r=>r.id===id);assert.ok(bound.requestId);let usage;
    for(let attempt=0;attempt<150;attempt++){usage=await(await fetch(origin+"/v1/usage",{headers:{authorization:"Bearer "+key(id)}})).json();if(usage.usage.events.length===1&&usage.budget.spentMicros===7)break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(usage.usage.events.length,1,id);assert.equal(usage.budget.spentMicros,7,id);const event=usage.usage.events[0];assert.equal(event.request_id,bound.requestId);assert.equal(event.credential_id,"gimage_"+id);
    assert.equal(event.model,"google/"+modelFor(id));assert.equal(event.capability,"image.generate");assert.equal(event.actual_cost_micros,7);assert.equal(event.cost_basis,"policy_fixed");
    let status=["incomplete","malformed"].includes(id)?"provider_error":"success";
    if(id==="cancel"){assert.ok(["complete","canceled"].includes(bound.delivery));status=bound.delivery==="complete"?"success":"client_error";}
    assert.equal(event.status,status,id);assert.deepEqual([event.input_tokens,event.output_tokens,event.total_tokens],[null,null,null]);
    t.diagnostic("GOOGLE_IMAGE_ACCOUNTING " + JSON.stringify({ id, delivery: bound.delivery ?? null, status: event.status, cost: event.actual_cost_micros, spent: usage.budget.spentMicros, events: usage.usage.events.length }));
  }
  for(const id of denied){const usage=await(await fetch(origin+"/v1/usage",{headers:{authorization:"Bearer "+key(id)}})).json();assert.equal(usage.usage.events.length,0,id);assert.equal(usage.budget.spentMicros,0,id);}
}
async function retire(mf,t) {
  await preserveFailures(async()=>{const proof=await(await(await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json();t.diagnostic("Google image source "+JSON.stringify(proof));assertProof(proof);},[async()=>{const proof=await(await mf.dispatchFetch("https://fixture.example/fixture/retire")).json();t.diagnostic("Google image Worker "+JSON.stringify(proof));assertProof(proof);}]);
}
test("Google image assembly retains exact client, owning graph, original ledger and source pin",()=>{
  assert.equal(consumerTypecheckPlan(sourceHead,testPath).sha256,"b032aa889d4ab5512e57f26871a5839a38ae326b18e765dce2dcec3b4fd80d49");
  assert.notEqual(input,output);assert.ok(largePng().length>1024*1024);assert.equal(assembledFixture.includes("/* OWNED_LIFETIME_IMPLEMENTATION */"),false);
  inspectionOverlay(readFileSync(new URL("../worker/proxy-response.ts",import.meta.url),"utf8"));
});
test("Google image request binding refuses unknown, duplicate and foreign keys",()=>{
  const run=()=>{const bindings=googleBindings();bindings.expect("owned",upstreamUrl("model0_text"),"synthetic");return bindings;};
  const valid={method:"POST",headers:{"x-goog-api-key":"synthetic"}};run().claim(upstreamUrl("model0_text"),valid);
  for(const init of [{...valid,method:"GET"},{...valid,headers:{authorization:"Bearer synthetic"}},{...valid,headers:{"x-goog-api-key":"foreign"}}])assert.throws(()=>run().claim(upstreamUrl("model0_text"),init));
  const duplicate=run();duplicate.claim(upstreamUrl("model0_text"),valid);assert.throws(()=>duplicate.claim(upstreamUrl("model0_text"),valid));assert.throws(()=>run().verify());
});
test("Google image body cancellation requires the original owned abort and complete independent cleanup", async () => {
  const { createLifetimeObserver: createImageObserver, createRequestBindings: createBindings } = new Function(stripTypeScriptTypes(imageLifetimeSource(observerSource)) + "; return { createLifetimeObserver, createRequestBindings };")();
  async function scenario(mode) {
    const bindings = createBindings(), caller = new AbortController(), reason = new Error("synthetic caller");
    let succeeded = false, controller, releaseHeld, joined = false, released = 0;
    const life = createImageObserver({ bindings: bindings.bindings, bodySucceeded: () => succeeded });
    const owner = bindings.expect(mode === "foreign-owner" ? "foreign" : "cancel", "chat", "https://fixture.example/v1/native/google-gemini/v1beta/models/gemini-3.1-flash-image:generateContent", "POST", "fixture", caller.signal);
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
    } else if (mode === "overlap") {
      const canceling = response.body.cancel(), releasing = acquired.release();
      await Promise.allSettled([canceling, releasing]);
    } else if (mode !== "premature") {
      await response.body.cancel().catch(() => {});
      if (mode === "duplicate") await response.body.cancel().catch(() => {});
    }
    if (mode !== "overlap") await acquired.release().catch(() => {});
    if (mode === "independent" || mode === "independent-undefined") life.watch("waitUntil", Promise.reject(mode === "independent" ? reason : undefined), owner);
    if (mode === "observer-undefined") life.errors.push(undefined);
    if (mode === "held") life.watch("source.completion", new Promise(resolve => { releaseHeld = resolve; }), owner);
    succeeded = true;
    const joining = life.join().then(() => { joined = true; return { accepted: true }; }, error => { joined = true; return { accepted: false, error }; });
    if (mode === "held") { await Promise.resolve(); await Promise.resolve(); assert.equal(joined, false); releaseHeld(); }
    const result = await joining;
    assert.equal(released, 1);
    assert.ok(life.operations.some(op => op.kind === "body.cancel" && op.state === "rejected"), "raw rejected original is preserved");
    assert.equal(result.accepted, mode === "owned" || mode === "held" || mode === "overlap", mode);
    await life.restore();
  }
  for (const mode of ["owned", "held", "overlap", "foreign-body", "foreign-owner", "wrong-reason", "undefined-reason", "preexisting-error", "no-progress", "premature", "duplicate", "release-same", "release-null", "release-undefined", "independent", "independent-undefined", "observer-undefined"]) await scenario(mode);
});
test("Google image cleanup retains independent falsey failures and unknown original work", async () => {
  const attempted = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempted.push(1); throw null; }, () => attempted.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempted, [1, 2]);
  for (const reason of [undefined, new Error("synthetic independent failure")]) {
    const lifetime = createLifetimeObserver(); const pending = Promise.reject(reason);
    assert.strictEqual(lifetime.watch("body.cancel", pending, {}), pending); await pending.catch(() => {});
    await assert.rejects(lifetime.join(), error => error.errors.includes(reason)); lifetime.restore();
  }
});


function parseRetirementRecords(text) {
  const records = [];
  for (const line of text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    if (!line.startsWith("GOOGLE_IMAGE_RETIRED cancel ")) continue;
    const record = JSON.parse(line.slice("GOOGLE_IMAGE_RETIRED cancel ".length));
    assert.deepEqual(Object.keys(record).sort(), ["operations", "qualifiedReadRejections", "readers", "rejected", "releases", "settled", "unlocked"]);
    for (const value of Object.values(record)) assert.ok(Number.isSafeInteger(value) && value >= 0);
    assert.equal(record.operations, record.settled); assert.equal(record.releases, 2);
    assert.equal(record.readers, 2); assert.equal(record.unlocked, 2);
    assert.equal(record.rejected, record.qualifiedReadRejections); records.push(record);
  }
  return records;
}
test("Google image exact retirement marker cannot borrow failure text or another case", () => {
  const valid = { operations: 17, settled: 17, rejected: 3, qualifiedReadRejections: 3, readers: 2, unlocked: 2, releases: 2 };
  const line = "GOOGLE_IMAGE_RETIRED cancel " + JSON.stringify(valid);
  assert.deepEqual(parseRetirementRecords("\u001b[32m" + line + "\u001b[0m\n"), [valid]);
  for (const text of ["prefix " + line, line.replace("cancel ", "tool_edit "), "GOOGLE_IMAGE_FAILURE cancel " + JSON.stringify(valid)]) assert.deepEqual(parseRetirementRecords(text), []);
  for (const patch of [{ settled: 16 }, { releases: 1 }, { unlocked: 1 }, { rejected: 4 }, { operations: -1 }, { extra: true }]) assert.throws(() => parseRetirementRecords("GOOGLE_IMAGE_RETIRED cancel " + JSON.stringify({ ...valid, ...patch })));
});
test("Google image delivery witness rejects foreign operation bindings independently", () => {
  const source = routerFixture(), start = source.indexOf("imageInspection.current ="), end = source.indexOf("const originalFetch", start);
  const install = new Function("imageInspection", "lifetime", "outgoing", "deliveries", "assert", source.slice(start, end));
  const run = mutate => {
    const signal = {}, caller = {}, owner = { id: "owned", signal, claimed: true, ingress: { signal: caller } };
    const operation = { signal, caller }, state = { owner, operation, lifetime: { errors: [] }, outgoing: { rows: [owner] }, deliveries: new Map(), hook: {} };
    mutate?.(state); install(state.hook, state.lifetime, state.outgoing, state.deliveries, assert);
    state.hook.current(operation, { outcome: "success" }, "complete", "google.image"); return state;
  };
  const good = run(); assert.equal(good.lifetime.errors.length, 0); assert.deepEqual(good.deliveries.get("owned"), { delivery: "complete", outcome: "success" });
  good.hook.current(good.operation, {}, "canceled", "google.image"); assert.equal(good.lifetime.errors.length, 1);
  for (const mutate of [state => { state.operation.signal = {}; }, state => { state.operation.caller = {}; }, state => { state.owner.claimed = false; }, state => { state.outgoing.rows = []; }, state => { state.outgoing.rows.push(state.owner); }]) {
    const failed = run(mutate); assert.equal(failed.deliveries.size, 0); assert.equal(failed.lifetime.errors.length, 1);
  }
});
test("actual Google image native consumer through Worker/SQLite",{skip:!source,timeout:300000},async t=>{
  const temporary=await mkdtemp(join(tmpdir(),"clawrouter-google-image-client-"));let mf;
  await preserveFailures(async()=>{
    mf=await startBundledWorkerdFixture(temporary,await bundleRouter(),upstreamFixture(),{directRouter:true});const origin=await setup(mf);
    const fixture=join(temporary,"google-images-contract.test.ts");await writeFile(fixture,assembledFixture,{flag:"wx",mode:0o600});
    const receipts=[];const observed=new Proxy(t,{get(target,property,receiver){if(property!=="diagnostic")return Reflect.get(target,property,receiver);return value=>{receipts.push(...parseRetirementRecords(String(value)));return target.diagnostic(value);};}});
    try{await runOpenClawConsumer(observed,{source,sourceHead,fixture,testPath,typecheck:true,env:{CLAWROUTER_CONTRACT_ORIGIN:origin}});}catch(error){t.diagnostic(String(error.stdout??"")+String(error.stderr??""));throw error;}
    assert.equal(receipts.length, 1); assert.equal(receipts[0].rejected, 3); await verify(mf,origin,t);
  },[()=>mf&&retire(mf,t),()=>mf?.dispose(),()=>rm(temporary,{recursive:true,force:true})]);
});
