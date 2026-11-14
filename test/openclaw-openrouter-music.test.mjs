import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { musicWave } from "../worker/test/openrouter-music-runtime-fixture.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

// Published canonical manifest-model correction, NOT a qualified client release.
// Actual registered SDK/Worker execution remains unrun.
const sourceHead = "15aeb223287b93cf26917e846f658dd53143eb4d";
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const root = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = resolve(root, "worker/generated/provider-snapshot.json");
const models = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
const target = "https://openrouter.ai/api/v1/chat/completions";
const positives = models.flatMap((model, index) => ["wav", "mp3"].map(format => ({ id: `m${index}_${format}`, model, format, kind: "success" })));
const negativeKinds = ["reference", "options", "preabort", "missing", "foreign", "revoked", "unpriced", "stalegrant",
  "empty", "eof", "json", "utf8", "base64", "ambiguous", "partial", "error", "redirect", "wire", "audio", "transcript", "abort_headers", "abort_body", "deadline_body"];
const cases = [...positives, ...negativeKinds.map(kind => ({ id: kind, kind, model: models[0], format: "wav" }))];
const unsent = new Set(["reference", "options", "preabort", "missing", "foreign", "revoked", "unpriced", "stalegrant"]);
const key = id => `clawrouter-live-orm_${id}-fixture-secret`;
const headers = id => ({ authorization: `Bearer ${key(id)}`, "content-type": "application/json", "accept-encoding": "identity" });
const body = row => ({ model: row.model, messages: [{ role: "user", content: `Synthetic ${row.id}` }], modalities: ["text", "audio"], audio: { format: row.format }, stream: true });

function compiled(route) {
  const inputs = readdirSync(join(root, "providers")).filter(name => name.endsWith(".provider.yaml")).sort()
    .map(name => parse(readFileSync(join(root, "providers", name), "utf8")));
  assert.equal(inputs.length, 87);
  const baseline = compileProviderSnapshot(inputs);
  assert.deepEqual(baseline, JSON.parse(readFileSync(snapshotPath, "utf8")));
  if (route === "native") return baseline;
  assert.equal(route, "manifest");
  const expected = structuredClone(baseline);
  inputs.find(provider => provider.id === "openrouter").endpoints.music_generate.nativeProxy = false;
  expected.providers.find(provider => provider.id === "openrouter").endpoints.find(endpoint => endpoint.id === "music_generate").native_proxy = false;
  const variant = compileProviderSnapshot(inputs);
  assert.deepEqual(variant, expected, "only the schema-validated music native_proxy setting differs");
  return variant;
}

// Serialized into the actual Worker. Observe originals without adding reads,
// cancellation, release, response replacement or a competing cleanup operation.
function observeBody(response, signal, owner) {
  const body = response.body;
  if (!body) throw new Error("original response body missing");
  const rows = [], getReader = body.getReader;
  body.getReader = function(...args) {
    const reader = Reflect.apply(getReader, this, args);
    const row = { reader, closed: reader.closed, operations: [], errors: [], unlocks: 0, returned: 0 };
    rows.push(row);
    void row.closed.catch(() => {});
    for (const kind of ["read", "cancel"]) {
      const original = reader[kind];
      reader[kind] = function(...operands) {
        try {
          const pending = Reflect.apply(original, this, operands);
          row.operations.push({ kind, pending });
          void pending.catch(() => {});
          return pending;
        } catch (reason) { row.errors.push(reason); throw reason; }
      };
    }
    const release = reader.releaseLock;
    reader.releaseLock = function(...args) {
      row.unlocks++;
      try { const result = Reflect.apply(release, this, args); row.returned++; return result; }
      catch (reason) { row.errors.push(reason); throw reason; }
    };
    return reader;
  };
  owner.join = async () => {
    const failures = [];
    if (!rows.length) failures.push(new Error("missing original reader"));
    for (const row of rows) {
      let cursor = 0, closed;
      do {
        const batch = row.operations.slice(cursor); cursor = row.operations.length;
        const results = await Promise.allSettled(batch.map(operation => operation.pending));
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected" && !(batch[index].kind === "read" && signal?.aborted && signal.reason !== undefined && result.reason === signal.reason)) failures.push(result.reason);
        }
        closed = await Promise.allSettled([row.closed]);
      } while (cursor < row.operations.length);
      if (closed[0].status === "rejected") failures.push(closed[0].reason);
      failures.push(...row.errors);
      if (row.unlocks !== 1 || row.returned !== 1 || body.locked) failures.push(new Error("original reader not physically released"));
    }
    if (failures.length) throw new AggregateError(failures, "original Worker body retirement failed");
    return { readers: rows.length, operations: rows.reduce((n, row) => n + row.operations.length, 0), unlocked: !body.locked };
  };
}

// These functions are used unchanged by the Worker and the local oracle tests.
function effectiveFetch(input, init) {
  const request = input instanceof Request ? input : undefined;
  return {
    url: request ? request.url : String(input),
    method: String(init?.method ?? request?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers !== undefined ? init.headers : request?.headers),
    body: init?.body !== undefined ? init.body : request?.body,
    // Null explicitly removes a Request signal; it is not an omitted operand.
    signal: init?.signal !== undefined ? init.signal : request?.signal,
    redirect: init?.redirect ?? request?.redirect ?? "follow",
  };
}
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
function bindAcquisition(effective, ingresses, rows, target) {
  if (effective.url !== target || effective.method !== "POST" || effective.redirect !== "manual" || typeof effective.body !== "string") return;
  const selected = rows.filter(row => effective.headers.get("authorization") === "Bearer fixture-upstream-" + row.id);
  if (selected.length !== 1) return;
  const row = selected[0], matches = ingresses.filter(ingress => ingress.id === row.id);
  if (matches.length !== 1) return;
  const ingress = matches[0];
  let outgoing; try { outgoing = JSON.parse(effective.body); } catch { return; }
  const incoming = ingress.path === "/v1/proxy/openrouter/music_generate" ? ingress.body?.body : ingress.body;
  if (!incoming || incoming.model !== (ingress.path === "/v1/proxy/openrouter/music_generate" ? "openrouter/" + row.model : row.model)
    || !sameJson(outgoing, { ...incoming, model: row.model })) return;
  return { row, ingress };
}
function observeAcquisition(original, receiver, input, init, proof, tick) {
  const signal = proof.effective.signal, ingress = proof.binding?.ingress;
  proof.state = "pending"; proof.response = undefined; proof.observerErrors = [];
  proof.invoke = tick(); proof.effectiveLive = signal?.aborted === false; proof.ingressLive = ingress?.signal.aborted === false;
  const aborted = () => { proof.effectiveAbort ??= tick(); };
  signal?.addEventListener("abort", aborted, { once: true });
  const detach = () => { signal?.removeEventListener("abort", aborted); proof.listenerRemoved = true; };
  try { proof.pending = Reflect.apply(original, receiver, [input, init]); }
  catch (reason) { proof.state = "threw"; proof.reason = reason; detach(); throw reason; }
  proof.observed = proof.pending.then(response => {
    proof.state = "fulfilled"; proof.response = response;
    try { observeBody(response, signal, proof); } catch (error) { proof.observerErrors.push(error); }
  }, reason => {
    proof.state = "rejected"; proof.reason = reason; proof.rejected = tick();
    proof.effectiveAbortedAtReject = signal?.aborted;
    proof.ingressAbortedAtReject = ingress?.signal.aborted;
    proof.ingressAbortAtReject = ingress?.abort;
  }).finally(detach);
  void proof.observed.catch(() => {});
  return proof.pending;
}
function acquisitionSnapshot(proof, inputs, ingresses) {
  const binding = proof.binding;
  return {
    id: binding?.row.id ?? null, state: proof.state, defined: proof.reason !== undefined,
    noResponse: proof.response === undefined, observerClean: proof.observerErrors.length === 0,
    unique: !!binding && ingresses.filter(row => row.id === binding.row.id).length === 1
      && inputs.filter(row => row.effective.headers.get("authorization") === "Bearer fixture-upstream-" + binding.row.id).length === 1,
    ingressLive: proof.ingressLive, effectiveLive: proof.effectiveLive,
    abortedBeforeReject: proof.ingressAbortedAtReject === true && proof.effectiveAbortedAtReject === true
      && Number.isInteger(proof.ingressAbortAtReject) && proof.ingressAbortAtReject > proof.invoke && proof.ingressAbortAtReject < proof.rejected
      && Number.isInteger(proof.effectiveAbort) && proof.effectiveAbort > proof.invoke && proof.effectiveAbort < proof.rejected,
    listenerRemoved: proof.listenerRemoved === true,
  };
}
function provisionalHeaderDisposition(snapshot) {
  return snapshot.id === "abort_headers" && snapshot.state === "rejected" && snapshot.defined === true
    && snapshot.noResponse === true && snapshot.observerClean === true && snapshot.unique === true
    && snapshot.ingressLive === true && snapshot.effectiveLive === true && snapshot.abortedBeforeReject === true
    && snapshot.listenerRemoved === true;
}
// A joined rejection remains rejected and cause-unclassified. Native settlement
// may race within one turn; these observations do not prove unique causality.
function acceptHeaderDisposition(physical, helperState, calls, receipt) {
  const candidates = physical.candidates;
  if (helperState !== "fulfilled" || physical.otherOperations !== "fulfilled" || physical.listenersRemoved !== true
    || !Array.isArray(candidates) || candidates.length !== 1 || !provisionalHeaderDisposition(candidates[0])
    || physical.requests.some(row => row.path === "/fixture/alternate")) throw new Error("unaccepted preheader disposition");
  const matched = calls.filter(call => call.id === "abort_headers"), events = receipt?.usage?.events;
  if (matched.length !== 1) throw new Error("ambiguous preheader upstream");
  const [call] = matched, event = events?.[0];
  if (call.url !== "https://openrouter.ai/api/v1/chat/completions" || call.method !== "POST" || call.redirect !== "manual"
    || call.authorization !== "Bearer fixture-upstream-abort_headers" || call.aborted !== true || call.expired !== false
    || call.waiter !== "fulfilled" || call.waiterListenerRemoved !== true || call.sourceReturnReached !== true
    || events.length !== 1 || event.credential_id !== "orm_abort_headers" || event.policy_id !== "orm_abort_headers"
    || event.model !== "openrouter/google/lyria-3-pro-preview" || event.provider !== "openrouter" || event.capability !== "music.generate"
    || event.status !== "client_error" || event.cost_basis !== "policy_fixed" || event.actual_cost_micros !== 700
    || receipt.budget?.spentMicros !== 700 || event.input_tokens !== null || event.output_tokens !== null || event.total_tokens !== null) {
    throw new Error("preheader source or accounting not accepted");
  }
}
async function waitForSourceAbort(signal, call) {
  call.waiter = "pending";
  let listener;
  const pending = new Promise(resolve => {
    listener = () => { call.aborted = true; resolve(); };
    if (signal.aborted) listener(); else signal.addEventListener("abort", listener, { once: true });
  });
  try { await pending; call.waiter = "fulfilled"; }
  finally { signal.removeEventListener("abort", listener); call.waiterListenerRemoved = true; }
}

function routerScript() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const rows = ${JSON.stringify(cases)}, target = ${JSON.stringify(target)}, inputs = [], requests = [], ingresses = [], tasks = [], failures = [];
const originalFetch = globalThis.fetch;
let sequence = 0; const tick = () => ++sequence;
${[observeBody, effectiveFetch, sameJson, bindAcquisition, observeAcquisition, acquisitionSnapshot, provisionalHeaderDisposition].map(fn => fn.toString()).join("\n")}
globalThis.fetch = function(input, init) {
  const effective = effectiveFetch(input, init);
  if (effective.url !== target) return Reflect.apply(originalFetch, this, [input, init]);
  const proof = { effective, binding: bindAcquisition(effective, ingresses, rows, target) }; inputs.push(proof);
  try { return observeAcquisition(originalFetch, this, input, init, proof, tick); }
  catch (error) { failures.push(error); throw error; }
};
async function retire() {
  const errors = [], joined = [], candidates = [];
  let taskCursor = 0, inputCursor = 0;
  while (taskCursor < tasks.length || inputCursor < inputs.length) {
    const batch = tasks.slice(taskCursor); taskCursor = tasks.length;
    for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") errors.push(result.reason);
    while (inputCursor < inputs.length) {
      const input = inputs[inputCursor++];
      try {
        const [original] = await Promise.allSettled([input.pending]);
        await input.observed;
        errors.push(...input.observerErrors);
        if (original.status === "rejected") {
          const snapshot = acquisitionSnapshot(input, inputs, ingresses);
          if (provisionalHeaderDisposition(snapshot)) candidates.push(snapshot); else errors.push(original.reason);
        } else {
          if (!input.join) throw new Error("acquired input unobserved");
          joined.push(await input.join());
        }
      } catch (error) { errors.push(error); }
    }
  }
  // A later duplicate cannot inherit an earlier provisional unique binding.
  for (const candidate of candidates) if (inputs.filter(input => input.effective.headers.get("authorization") === "Bearer fixture-upstream-" + candidate.id).length !== 1
    || ingresses.filter(ingress => ingress.id === candidate.id).length !== 1) errors.push(new Error("duplicate disposition binding"));
  for (const ingress of ingresses) { ingress.signal.removeEventListener("abort", ingress.listener); ingress.listenerRemoved = true; }
  errors.push(...failures);
  if (errors.length) throw new AggregateError(errors, "original Worker operations failed");
  return { joined, candidates, requests, tasks: tasks.length, otherOperations: "fulfilled", listenersRemoved: ingresses.every(row => row.listenerRemoved) };
}
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") {
    for (const row of rows) if (row.kind !== "missing") await putGrantCredentials(env, "oauth/orm_" + row.id + "/openrouter", { provider: "openrouter", enabled: true, kind: "api_key", credential: "fixture-upstream-" + row.id });
    return new Response(null, { status: 204 });
  }
  if (path === "/fixture/revoke") { const id = new URL(request.url).searchParams.get("id"); if (!rows.some(row => row.id === id)) return new Response(null, { status: 400 }); await revokeGrantCredentials(env, "oauth/orm_" + id + "/openrouter"); return new Response(null, { status: 204 }); }
  if (path === "/fixture/retire") return Response.json(await retire());
  if (path === "/fixture/state") return originalFetch("https://fixture.example/state");
  if (path === "/fixture/started") return originalFetch("https://fixture.example/started?id=" + new URL(request.url).searchParams.get("id"));
  if (path === "/fixture/alternate") { requests.push({ path }); return new Response("unexpected alternate", { status: 500 }); }
  try {
  if (path.startsWith("/v1/") && path !== "/v1/usage") {
    const record = { path, method: request.method, authorization: request.headers.get("authorization"), body: null };
    requests.push(record);
    let ingress;
    if (request.method === "POST" && ["/v1/native/openrouter/v1/chat/completions", "/v1/proxy/openrouter/music_generate"].includes(path)) {
      const matches = rows.filter(row => record.authorization === "Bearer clawrouter-live-orm_" + row.id + "-fixture-secret");
      ingress = { path, id: matches.length === 1 ? matches[0].id : null, signal: request.signal, body: null, abort: request.signal.aborted ? tick() : null };
      ingress.listener = () => { ingress.abort ??= tick(); };
      request.signal.addEventListener("abort", ingress.listener, { once: true }); ingresses.push(ingress);
    }
    if (request.method === "POST") { record.body = await request.clone().json(); if (ingress) ingress.body = record.body; }
  }
  return await handler.fetch(request, { ...env, OPENROUTER_API_KEY: "must-not-fallback" }, { waitUntil(pending) { tasks.push(pending); context.waitUntil(pending); } }); }
  catch (error) { failures.push(error); throw error; }
} };`;
}

function upstreamScript(audio) {
  return `const calls = [], audio = ${JSON.stringify(audio)}, rows = ${JSON.stringify(cases)}, waiting = new Map(), sourceTasks = [];
${waitForSourceAbort.toString()}
const event = value => "data: " + JSON.stringify(value) + "\\n\\n";
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === "fixture.example") {
    if (url.pathname === "/state") {
      let cursor = 0; const errors = [];
      while (cursor < sourceTasks.length) { const batch = sourceTasks.slice(cursor); cursor = sourceTasks.length;
        for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") errors.push(result.reason); }
      if (errors.length) throw new AggregateError(errors, "source waiter failed");
      return Response.json(calls);
    }
    const id = url.searchParams.get("id");
    if (!calls.some(call => call.id === id)) await new Promise(resolve => waiting.set(id, resolve));
    return new Response(null, { status: 204 });
  }
  const row = rows.find(row => request.headers.get("authorization") === "Bearer fixture-upstream-" + row.id);
  if (!row) return new Response("unknown fixture credential", { status: 401 });
  const body = await request.json(), call = { id: row.id, url: request.url, method: request.method, redirect: request.redirect, authorization: request.headers.get("authorization"), body, aborted: request.signal.aborted, canceled: false, expired: false };
  calls.push(call); waiting.get(row.id)?.(); waiting.delete(row.id);
  if (row.kind === "abort_headers") { const pending = waitForSourceAbort(request.signal, call); sourceTasks.push(pending); await pending; call.sourceReturnReached = true; return new Response(null, { status: 499 }); }
  request.signal.addEventListener("abort", () => { call.aborted = true; }, { once: true });
  if (row.kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://alternate.example/paid" } });
  if (row.kind === "error") return Response.json({ error: { message: "synthetic refusal" } }, { status: 429 });
  const frame = delta => ({ model: row.model, choices: [{ index: 0, delta, finish_reason: null }] });
  const encoded = audio[row.format];
  let wire = event(frame({ audio: { data: encoded.slice(0, 3), transcript: "café " } })) + event(frame({ audio: { data: encoded.slice(3), transcript: "synthetic music" } })) + event({ model: row.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + event({ choices: [], usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } }) + "data: [DONE]\\n\\n";
  if (row.kind === "empty") wire = event(frame({ audio: { transcript: "no audio" } })) + "data: [DONE]\\n\\n";
  if (row.kind === "eof") wire = wire.replace("data: [DONE]\\n\\n", "");
  if (row.kind === "json") wire = "data: {broken\\n\\n";
  if (row.kind === "base64") wire = event(frame({ audio: { data: "ZE==" } })) + "data: [DONE]\\n\\n";
  if (row.kind === "ambiguous") wire = event({ choices: [{}, {}] }) + "data: [DONE]\\n\\n";
  if (row.kind === "partial") wire = event({ choices: [{ delta: {}, finish_reason: "length" }] });
  if (row.kind === "wire") wire = ":" + "x".repeat(32 * 1024 * 1024) + "\\n\\n";
  if (row.kind === "audio") wire = event(frame({ audio: { data: "AAAA".repeat(Math.ceil((16 * 1024 * 1024 + 3) / 3)) } })) + "data: [DONE]\\n\\n";
  if (row.kind === "transcript") wire = event(frame({ audio: { data: encoded, transcript: "x".repeat(1024 * 1024 + 1) } })) + "data: [DONE]\\n\\n";
  const held = row.kind === "abort_body" || row.kind === "deadline_body";
  const bytes = row.kind === "utf8" ? new Uint8Array([255, 10]) : new TextEncoder().encode(held ? ": waiting\\n\\n" : wire);
  let offset = 0;
  return new Response(new ReadableStream({ type: "bytes", pull(controller) {
    if (offset < bytes.length) { const chunk = bytes.slice(offset, offset + 16384); offset += chunk.length; controller.enqueue(chunk); }
    else if (!held) controller.close();
  }, cancel() { call.canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
} };`;
}

async function start(route, audio) {
  const snapshot = compiled(route), temporary = await mkdtemp(join(tmpdir(), "clawrouter-openrouter-music-"));
  let mf;
  try {
    const require = createRequire(import.meta.resolve("wrangler/package.json"));
    let replacements = 0;
    const bundle = await require("esbuild").build({ stdin: { contents: routerScript(), resolveDir: root, sourcefile: "openrouter-music-fixture.ts", loader: "ts" },
      write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
      plugins: [{ name: "validated-music-snapshot", setup(build) { build.onLoad({ filter: /provider-snapshot\.json$/ }, args => {
        if (args.path !== snapshotPath) return; replacements++; return { contents: JSON.stringify(snapshot), loader: "json" };
      }); } }] });
    assert.equal(replacements, 1);
    mf = await startBundledWorkerdFixture(temporary, bundle.outputFiles[0].text, upstreamScript(audio), { directRouter: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const row of cases) {
      await kv.put(`policies/orm_${row.id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: row.kind === "foreign" ? ["openai"] : ["openrouter"],
        models: models.map(model => `openrouter/${model}`), tenantId: "fixture", monthlyBudgetMicros: 10000, requestCostMicros: row.kind === "unpriced" ? null : 700,
        grantRouting: { eligibleGrants: { openrouter: ["openrouter"] }, environmentFallback: false }, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/orm_${row.id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `orm_${row.id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/openrouter", JSON.stringify({ providerId: "openrouter", enabled: true }));
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    return { mf, origin, async close() {
      const failures = [];
      try { await mf.dispose(); } catch (error) { failures.push(error); }
      try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "fixture disposal failed");
    } };
  } catch (error) {
    const errors = [error];
    try { await mf?.dispose(); } catch (failure) { errors.push(failure); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (failure) { errors.push(failure); }
    throw errors.length === 1 ? error : new AggregateError(errors, "fixture acquisition and cleanup failed");
  }
}

async function retirement(origin) {
  const response = await fetch(origin + "/fixture/retire", { method: "POST" });
  assert.equal(response.status, 200, "original work must retire before disposal");
  const result = await response.json();
  assert.ok(result.joined.every(row => row.readers > 0 && row.operations > 0 && row.unlocked));
  return result;
}
async function usage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: headers(id) });
  assert.equal(response.status, 200); return response.json();
}
async function cleanup(f, failures) {
  try { await retirement(f.origin); } catch (error) { failures.push(error); }
  try { await f.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "music contract and cleanup failed");
}

test("all real manifests produce native-only shipping music and a single-setting manifest variant", () => {
  const native = compiled("native"), manifest = compiled("manifest");
  assert.equal(native.providers.find(p => p.id === "openrouter").endpoints.find(e => e.id === "music_generate").native_proxy, true);
  assert.equal(manifest.providers.find(p => p.id === "openrouter").endpoints.find(e => e.id === "music_generate").native_proxy, false);
});

for (const route of ["native", "manifest"]) {
  test(`real ${route} catalog, complete music, unknown-budget refusal and SQLite`, { timeout: 60000 }, async () => {
    const wav = Buffer.from(musicWave()).toString("base64"), f = await start(route, { wav, mp3: wav }), failures = [];
    try {
      const catalog = await (await fetch(f.origin + "/v1/catalog", { headers: headers("m0_wav") })).json();
      const offers = catalog.providers.find(p => p.id === "openrouter").offers.filter(offer => offer.endpoint === "music_generate");
      assert.ok(offers.every(offer => offer.routeKind === route));
      assert.deepEqual(offers.filter(offer => offer.modelId !== null).map(offer => offer.modelId).sort(), models.map(model => `openrouter/${model}`).sort());
      assert.ok(offers.filter(offer => offer.modelId !== null).every(offer => offer.eligible));
      if (route === "manifest") {
        // Retain the original wrong-ID regression: the complete index distinguishes
        // Google from OpenRouter. The corrected SDK must send the router ID.
        const refused = await fetch(f.origin + "/v1/proxy/openrouter/music_generate", { method: "POST", headers: headers("m0_mp3"), body: JSON.stringify({ body: body(positives[0]) }) });
        assert.equal(refused.status, 400); assert.equal((await refused.json()).error.code, "model_provider_mismatch");
        assert.deepEqual(await (await fetch(f.origin + "/fixture/state")).json(), []);
      }
      for (const row of positives.filter(row => row.format === "wav")) {
        const path = route === "native" ? "/v1/native/openrouter/v1/chat/completions" : "/v1/proxy/openrouter/music_generate";
        const request = body(row);
        const response = await fetch(f.origin + path, { method: "POST", headers: headers(row.id), body: JSON.stringify(route === "native" ? request : { body: { ...request, model: `openrouter/${row.model}` } }) });
        assert.equal(response.status, 200); const wire = await response.text(); assert.match(wire, /data: \[DONE\]/); assert.match(wire, /café/);
        await retirement(f.origin);
        const receipt = await usage(f.origin, row.id), [event] = receipt.usage.events;
        assert.equal(receipt.usage.events.length, 1); assert.equal(receipt.budget.spentMicros, 700);
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(event.status, "success");
        assert.equal(event.model, `openrouter/${row.model}`); assert.equal(event.capability, "music.generate");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
      }
      const before = await (await fetch(f.origin + "/fixture/state")).json(), request = body(cases.find(row => row.id === "unpriced"));
      const response = await fetch(f.origin + (route === "native" ? "/v1/native/openrouter/v1/chat/completions" : "/v1/proxy/openrouter/music_generate"), {
        method: "POST", headers: headers("unpriced"), body: JSON.stringify(route === "native" ? request : { body: { ...request, model: `openrouter/${request.model}` } }) });
      assert.equal((await response.json()).error.code, "pricing_required");
      assert.deepEqual(await (await fetch(f.origin + "/fixture/state")).json(), before);
      assert.equal((await usage(f.origin, "unpriced")).budget.spentMicros, 0);
    } catch (error) { failures.push(error); }
    await cleanup(f, failures);
  });
}

test("actual registered OpenRouter music client through both real configurations", { skip: !source, timeout: 600000 }, async t => {
  const mp3 = readFileSync(join(source, "test/fixtures/media/lyria-silence.mp3"));
  assert.equal(createHash("sha256").update(mp3).digest("hex"), "94bf451427043b32a9893976aefdea79d784323e5422f1f986fb22548615162b");
  for (const route of ["native", "manifest"]) {
    const audio = { wav: Buffer.from(musicWave()).toString("base64"), mp3: mp3.toString("base64") }, f = await start(route, audio), failures = [];
    let helperState = "pending";
    try {
      await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-openrouter-music-contract.test.ts", import.meta.url),
        testPath: "src/agents/tools/worker-openrouter-music-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_ROUTE: route, CLAWROUTER_CONTRACT_AUDIO: JSON.stringify(audio), CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases) } });
      helperState = "fulfilled";
      const physical = await retirement(f.origin), calls = await (await fetch(f.origin + "/fixture/state")).json();
      assert.equal(physical.requests.filter(row => row.path === "/fixture/alternate").length, 0);
      let headerReceipt;
      for (const row of cases) {
        const matched = calls.filter(call => call.id === row.id), receipt = await usage(f.origin, row.id);
        if (row.id === "abort_headers") headerReceipt = receipt;
        if (unsent.has(row.kind)) { assert.equal(matched.length, 0, row.id); assert.equal(receipt.budget.spentMicros, 0, row.id); continue; }
        assert.equal(matched.length, 1, row.id); const [call] = matched;
        assert.equal(call.url, target); assert.equal(call.method, "POST"); assert.equal(call.redirect, "manual");
        assert.equal(call.authorization, `Bearer fixture-upstream-${row.id}`); assert.equal(call.body.model, row.model);
        assert.equal(call.body.stream, true); assert.equal(call.body.audio.format, row.format);
        if (row.kind.startsWith("abort") || row.kind === "deadline_body") { assert.ok(call.aborted || call.canceled); assert.equal(call.expired, false); }
        assert.equal(receipt.usage.events.length, 1); const [event] = receipt.usage.events;
        assert.equal(event.credential_id, `orm_${row.id}`); assert.equal(event.policy_id, `orm_${row.id}`);
        assert.equal(event.model, `openrouter/${row.model}`); assert.equal(event.provider, "openrouter"); assert.equal(event.capability, "music.generate");
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(receipt.budget.spentMicros, 700);
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
        assert.equal(event.status, row.kind === "success" ? "success" : row.kind.startsWith("abort") || row.kind === "deadline_body" ? "client_error" : "provider_error");
      }
      // Only after every independent source/SQLite oracle. /retire is provisional.
      acceptHeaderDisposition(physical, helperState, calls, headerReceipt);
    } catch (error) { failures.push(error); }
    await cleanup(f, failures);
  }
});

test("reader observer joins the original cancel and rejects cleanup failure including undefined", async () => {
  const cause = new Error("owned cleanup failure");
  for (const reason of [cause, undefined]) {
    const response = new Response(new ReadableStream({ cancel() { return Promise.reject(reason); } }));
    const proof = {};
    observeBody(response, undefined, proof);
    const reader = response.body.getReader();
    const original = reader.cancel(reason);
    await assert.rejects(original, error => error === reason);
    reader.releaseLock();
    await assert.rejects(proof.join(), error => error instanceof AggregateError && error.errors.some(value => value === reason));
  }
});

// Oracle regressions exercise the exact serialized functions. Controlled promises
// here test classification only; they do not supply hosted transport evidence.
async function headerOracle(order = "abort-first", reason, response) {
  if (arguments.length < 2) reason = new Error("unclassified native rejection");
  const row = cases.find(row => row.id === "abort_headers"), ingressController = new AbortController(), effectiveController = new AbortController();
  let sequence = 0; const tick = () => ++sequence;
  const ingress = { id: row.id, path: "/v1/native/openrouter/v1/chat/completions", signal: ingressController.signal, body: body(row), abort: null };
  ingress.signal.addEventListener("abort", () => { ingress.abort = tick(); }, { once: true });
  const init = { method: "POST", headers: { authorization: `Bearer fixture-upstream-${row.id}` }, body: JSON.stringify(body(row)), signal: effectiveController.signal, redirect: "manual" };
  const effective = effectiveFetch(target, init), ingresses = [ingress];
  const proof = { effective, binding: bindAcquisition(effective, ingresses, cases, target) };
  let reject, fulfill;
  const original = new Promise((resolve, fail) => { fulfill = resolve; reject = fail; });
  const receiver = {};
  assert.equal(observeAcquisition(function(input, options) {
    assert.equal(this, receiver); assert.equal(input, target); assert.equal(options, init); return original;
  }, receiver, target, init, proof, tick), original);
  const abort = () => { ingressController.abort(new Error("ingress abort")); effectiveController.abort(new Error("effective abort")); };
  if (order === "abort-first") abort();
  if (response !== undefined) fulfill(response); else reject(reason);
  await proof.observed;
  if (order === "reject-first") abort();
  return { proof, ingresses, init, snapshot: acquisitionSnapshot(proof, [proof], ingresses) };
}
function headerEvidence(snapshot) {
  return {
    physical: { candidates: [snapshot], requests: [], otherOperations: "fulfilled", listenersRemoved: true },
    calls: [{ id: "abort_headers", url: target, method: "POST", redirect: "manual", authorization: "Bearer fixture-upstream-abort_headers",
      aborted: true, expired: false, waiter: "fulfilled", waiterListenerRemoved: true, sourceReturnReached: true }],
    receipt: { budget: { spentMicros: 700 }, usage: { events: [{ credential_id: "orm_abort_headers", policy_id: "orm_abort_headers",
      model: "openrouter/google/lyria-3-pro-preview", provider: "openrouter", capability: "music.generate", status: "client_error",
      cost_basis: "policy_fixed", actual_cost_micros: 700, input_tokens: null, output_tokens: null, total_tokens: null }] } },
    helper: "fulfilled",
  };
}

test("preheader disposition retains original rejection and requires observed abort order", async () => {
  const good = await headerOracle();
  assert.equal(good.proof.state, "rejected"); assert.equal(good.proof.reason.message, "unclassified native rejection");
  assert.equal(provisionalHeaderDisposition(good.snapshot), true);
  for (const order of ["reject-first", "no-abort"]) {
    assert.equal(provisionalHeaderDisposition((await headerOracle(order)).snapshot), false, order);
  }
  const missing = await headerOracle("abort-first", undefined);
  assert.equal(provisionalHeaderDisposition(acquisitionSnapshot(missing.proof, [missing.proof], missing.ingresses)), false);
  const response = new Response(null), observed = await headerOracle("abort-first", new Error("unused"), response);
  assert.equal(observed.proof.response, response); assert.equal(observed.proof.state, "fulfilled");
  assert.equal(observed.proof.observerErrors.length, 1);
  assert.equal(provisionalHeaderDisposition(observed.snapshot), false, "observer error is not native acquisition rejection");
});

test("effective fetch binding uses replacement headers, original body and explicit null signal", async () => {
  const good = await headerOracle(), request = new Request(target, { method: "POST", headers: good.init.headers, body: good.init.body, signal: good.init.signal, redirect: "manual" });
  const replaced = effectiveFetch(request, { headers: { "x-fixture": "replacement" }, body: good.init.body, signal: null });
  assert.equal(replaced.headers.has("authorization"), false); assert.equal(replaced.signal, null);
  assert.equal(bindAcquisition(replaced, good.ingresses, cases, target), undefined);
  const nullSignal = effectiveFetch(request, { ...good.init, signal: null });
  const proof = { effective: nullSignal, binding: bindAcquisition(nullSignal, good.ingresses, cases, target) };
  observeAcquisition(() => Promise.reject(new Error("defined")), null, request, { ...good.init, signal: null }, proof, () => 1);
  await proof.observed;
  assert.equal(provisionalHeaderDisposition(acquisitionSnapshot(proof, [proof], good.ingresses)), false);
  for (const change of [
    { method: "GET" }, { url: "https://alternate.example/paid" }, { redirect: "follow" },
    { headers: new Headers({ authorization: "Bearer foreign-fixture" }) },
    { body: JSON.stringify({ ...JSON.parse(good.init.body), model: "foreign" }) },
    { body: JSON.stringify({ ...JSON.parse(good.init.body), messages: [] }) }, { body: null },
  ]) assert.equal(bindAcquisition({ ...good.proof.effective, ...change }, good.ingresses, cases, target), undefined);
  assert.equal(bindAcquisition(good.proof.effective, [...good.ingresses, good.ingresses[0]], cases, target), undefined);
  assert.equal(provisionalHeaderDisposition(acquisitionSnapshot(good.proof, [good.proof, { effective: good.proof.effective }], good.ingresses)), false);
  const manifest = { ...good.ingresses[0], path: "/v1/proxy/openrouter/music_generate", body: { body: { ...good.ingresses[0].body, model: "openrouter/" + models[0] } } };
  assert.equal(bindAcquisition(good.proof.effective, [manifest], cases, target)?.ingress, manifest);
});

test("preheader oracle preserves synchronous native exceptions including undefined", () => {
  for (const reason of [new Error("sync fixture failure"), undefined]) {
    const controller = new AbortController(), proof = { effective: { signal: controller.signal } };
    let threw = false;
    try { observeAcquisition(() => { throw reason; }, null, target, {}, proof, () => 1); }
    catch (error) { threw = true; assert.equal(error, reason); }
    assert.equal(threw, true); assert.equal(proof.state, "threw"); assert.equal(proof.listenerRemoved, true);
  }
});

test("source waiter completes and removes its original abort listener before evidence", async () => {
  const controller = new AbortController(), call = { aborted: false };
  const pending = waitForSourceAbort(controller.signal, call);
  assert.equal(call.waiter, "pending"); assert.equal(call.waiterListenerRemoved, undefined);
  controller.abort(new Error("owned source abort")); await pending;
  assert.deepEqual(call, { aborted: true, waiter: "fulfilled", waiterListenerRemoved: true });
});

test("final preheader acceptance requires helper, source, one POST, accounting and all cleanup", async () => {
  const { snapshot } = await headerOracle();
  const accept = e => acceptHeaderDisposition(e.physical, e.helper, e.calls, e.receipt);
  assert.doesNotThrow(() => accept(headerEvidence(snapshot)));
  const changes = [
    e => { e.helper = "pending"; }, e => { e.helper = "rejected"; },
    e => { e.physical.otherOperations = "pending"; }, e => { e.physical.otherOperations = "rejected"; },
    e => { e.physical.listenersRemoved = false; }, e => { e.physical.candidates = []; },
    e => { e.physical.candidates.push(e.physical.candidates[0]); },
    e => { e.physical.candidates[0].id = "deadline_body"; }, e => { e.physical.candidates[0].unique = false; },
    e => { e.physical.candidates[0].defined = false; }, e => { e.physical.candidates[0].noResponse = false; },
    e => { e.physical.candidates[0].observerClean = false; }, e => { e.physical.candidates[0].abortedBeforeReject = false; },
    e => { e.physical.candidates[0].ingressLive = false; }, e => { e.physical.candidates[0].effectiveLive = false; },
    e => { e.physical.candidates[0].listenerRemoved = false; },
    e => { e.physical.requests.push({ path: "/fixture/alternate" }); },
    e => { e.calls = []; }, e => { e.calls.push(e.calls[0]); }, e => { e.calls[0].id = "abort_body"; },
    e => { e.calls[0].aborted = false; }, e => { e.calls[0].expired = true; },
    e => { e.calls[0].waiter = "pending"; }, e => { e.calls[0].waiter = "rejected"; },
    e => { e.calls[0].waiterListenerRemoved = false; }, e => { e.calls[0].sourceReturnReached = false; },
    e => { e.calls[0].authorization = "Bearer foreign-fixture"; }, e => { e.calls[0].method = "GET"; },
    e => { e.receipt.usage.events[0].status = "provider_error"; },
    e => { e.receipt.usage.events[0].credential_id = "orm_foreign"; }, e => { e.receipt.usage.events[0].policy_id = "orm_foreign"; },
    e => { e.receipt.usage.events[0].model = "foreign"; }, e => { e.receipt.usage.events[0].cost_basis = "none"; },
    e => { e.receipt.usage.events[0].actual_cost_micros = 0; }, e => { e.receipt.usage.events[0].input_tokens = 0; },
    e => { e.receipt.budget.spentMicros = 0; }, e => { e.receipt.usage.events.push(e.receipt.usage.events[0]); },
  ];
  for (const [index, change] of changes.entries()) {
    const evidence = structuredClone(headerEvidence(snapshot)); change(evidence);
    assert.throws(() => accept(evidence), undefined, `required evidence ${index}`);
  }
});


test("reader join includes an original cancel added while closed is pending", async () => {
  for (const reason of [new Error("late original cancel failure"), undefined]) {
    let rejectCancel;
    const pending = new Promise((_, reject) => { rejectCancel = reject; });
    const response = new Response(new ReadableStream({ cancel() { return pending; } })), proof = {};
    observeBody(response, undefined, proof);
    const reader = response.body.getReader(), joining = proof.join();
    const verdict = joining.then(() => ({ ok: true }), error => ({ ok: false, error }));
    await Promise.resolve(); await Promise.resolve();
    const cancel = reader.cancel(); void cancel.catch(() => {}); reader.releaseLock();
    rejectCancel(reason);
    const result = await verdict;
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof AggregateError && result.error.errors.some(error => error === reason));
    await assert.rejects(cancel, error => error === reason);
  }
});
