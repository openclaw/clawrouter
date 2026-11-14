import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "ff34cf8e236ca698c7190c63087f2ecd37f94a7e";
const models = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const success = [...models.map((_, i) => `model${i}`), "talk", "unknown", "key_a", "key_b"];
const invalid = ["later", "truncated", "non200", "redirect", "encoding"];
const held = ["abort_headers", "abort_body", "deadline"];
const denied = ["grant", "foreign", "policy", "revoked", "stale_policy", "budget", "key", "voice", "alias", "cutoff0", "cutoff1", "cutoff2"];
const scenarios = [...success, ...invalid, ...held, ...denied];
const modelFor = name => /^model\d$/.test(name) ? models[Number(name.slice(5))] : /^cutoff\d$/.test(name) ? models[Number(name.slice(6))] : models[3];
const text = "Synthetic speech 😀 café";

function compileCatalog() {
  // Same complete, sorted YAML -> compiler path as the 1098 variant helper.
  // Google already declares both real route kinds; no flag variant is needed.
  const dir = new URL("../providers/", import.meta.url);
  const manifests = readdirSync(dir).filter(path => path.endsWith(".provider.yaml")).sort().map(path => parse(readFileSync(new URL(path, dir), "utf8")));
  assert.equal(manifests.length, 87);
  assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
  const provider = snapshot.providers.find(row => row.id === "google-gemini");
  assert.deepEqual(provider.models.filter(row => row.capabilities.includes("audio.speech")).map(row => row.id), models.map(model => `google/${model}`));
  assert.equal(provider.endpoints.find(row => row.id === "speech_generate_content").native_proxy, true);
  assert.equal(provider.endpoints.find(row => row.id === "speech_interactions").native_proxy, false);
  for (const model of provider.models.filter(row => models.includes(row.upstream))) {
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  }
}

test("Google speech uses all 87 compiled manifests and only declared route kinds", compileCatalog);

test("Google speech fixture bundles the unchanged Worker and parses the client fixture", async () => {
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { build, transform } = require("esbuild");
  const bundle = await build({ stdin: { contents: routerFixture(), resolveDir: process.cwd(), loader: "ts" }, write: false,
    bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  assert.ok(bundle.outputFiles[0].text.length > 0);
  await transform(upstreamFixture("http://127.0.0.1:1"), { loader: "js", format: "esm" });
  await transform(readFileSync(new URL("./fixtures/openclaw-google-speech-contract.test.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function barriers() {
  const rows = new Map(held.map(name => [name, { seen: deferred(), closed: deferred(), response: undefined }]));
  const server = createServer(async (request, response) => {
    const match = /^\/(abort_headers|abort_body|deadline)\/(hold|seen|closed)$/.exec(request.url ?? "");
    if (!match || request.method !== "GET" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    const row = rows.get(match[1]);
    if (match[2] === "hold") {
      if (row.response) { response.writeHead(409); response.end(); return; }
      row.response = response; response.once("close", () => row.closed.resolve()); row.seen.resolve();
    } else { await row[match[2]].promise; response.end(match[2]); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const row of rows.values()) row.response?.end("teardown");
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test("published Google TTS and Talk client through real Worker catalog and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  compileCatalog(); // Before Worker module evaluation, never patch the snapshot.
  const failures = []; let barrier, temporary, mf;
  try {
    barrier = await barriers();
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-speech-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(barrier.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const initialized = await fetch(origin + "/__google/init", { method: "POST" });
    assert.equal(initialized.status, 200, await initialized.text());
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-google-speech-contract.test.ts", import.meta.url),
      testPath: "src/agents/tools/worker-clawrouter-google-speech.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CONTROL: barrier.origin, CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead } });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.deepEqual(await (await fetch(origin + "/__google/audit")).json(), []);
    assert.equal(calls.length, success.length + invalid.length + held.length);
    for (const name of scenarios) {
      const id = `gs_${name}`, paid = !denied.includes(name), model = modelFor(name), interactions = model.startsWith("gemini-3.8-");
      const selected = calls.filter(call => call.id === id);
      assert.equal(selected.length, paid ? 1 : 0, name);
      if (paid) {
        assert.deepEqual(selected[0].request, { method: "POST", selectedKey: true, noProxySecret: true,
          url: interactions ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          body: interactions ? { model, store: false, input: [{ type: "user_input", content: [{ type: "text", text }] }],
            generation_config: { speech_config: [{ voice: "Kore" }] }, response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 } }
            : { contents: [{ role: "user", parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } } });
        assert.equal(selected[0].finished, true, name);
      }
      const joined = await (await fetch(`${origin}/__google/join/${id}`)).json();
      assert.equal(joined.calls, paid ? 1 : 0, name); assert.equal(joined.retired, true); assert.equal(joined.charged, 0);
      if (joined.hasBody) {
        assert.equal(joined.activeReads, 0); assert.equal(joined.unlocked, true);
        assert.equal(joined.sourceLocked, false); assert.equal(joined.physicalLocked, false);
        assert.ok(joined.eof || joined.canceled || joined.readRejected);
        assert.equal(joined.readResults.length, joined.readCalls);
        assert.equal(joined.cancelResults.length, joined.cancelCalls);
        assert.ok(joined.cancelResults.every(status => status === "fulfilled"), "join the original cancel promises, not unlock flags");
      }
      const usage = await (await fetch(`${origin}/__google/usage/${id}`)).json();
      if (success.includes(name)) {
        assert.equal(usage.usage.events.length, 1, name);
        const event = usage.usage.events[0];
        assert.equal(event.provider, "google-gemini"); assert.equal(event.model, `google/${model}`);
        assert.equal(event.capability, "audio.speech"); assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.grant_key, `oauth/${id}/google-gemini`);
        assert.equal(event.pricing_ref, null); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
        assert.equal(event.cost_basis, name === "unknown" ? "unpriced_usage" : "policy_fixed");
        // Unknown provider cost is a zero accounting debit, not a free tariff.
        assert.equal(event.actual_cost_micros, name === "unknown" ? 0 : 17);
        assert.equal(event.reporting_known_cost_micros, null);
        if (name !== "unknown") assert.equal(usage.budget.spentMicros, 17);
      } else if (paid) {
        assert.equal(usage.usage.events.length, 1, name);
        const event = usage.usage.events[0], rejected = ["non200", "redirect"].includes(name), debit = rejected ? 0 : 17;
        assert.equal(event.provider, "google-gemini"); assert.equal(event.model, `google/${model}`);
        assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.grant_key, `oauth/${id}/google-gemini`);
        assert.notEqual(event.status, "success", name);
        assert.equal(event.reserved_cost_micros, 17); assert.equal(event.actual_cost_micros, debit);
        assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
        assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
        assert.equal(event.pricing_ref, null); assert.equal(event.reporting_known_cost_micros, null);
        assert.equal(usage.budget.spentMicros, debit, name);
      } else {
        assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
        assert.equal(usage.budget.spentMicros, 0);
      }
      assert.doesNotMatch(JSON.stringify(usage.usage.events), /fixture-secret|managed-gs_|must-not-fallback|Synthetic speech/);
    }
  } catch (error) { failures.push(error); }
  finally {
    try { await barrier?.close(); } catch (error) { failures.push(error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Google client proof or owned cleanup failed");
});

function routerFixture() {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
import { budgetStatus } from "./worker/ledgers.ts";
const ids = IDS;
// Deterministic qualification date only; no fake timers or shortened deadlines.
const NativeDate = Date, fixtureNow = NativeDate.parse("2026-11-15T12:00:00Z");
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [fixtureNow]); },
  apply() { return new NativeDate(fixtureNow).toString(); },
  get(target, key) { return key === "now" ? () => fixtureNow : Reflect.get(target, key); },
});
const rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = new Map(), inputs = new Map(), ingested = new Map(ids.map(id => [id, deferred()])), violations = [];
function refuse(reason) { violations.push(reason); throw new Error(reason); }
let fixtureEnv;
const policy = id => ({ enabled: true, generation: "fixture", providers: id === "gs_policy" ? ["openai"] : ["google-gemini"], tenantId: "fixture",
  models: null, monthlyBudgetMicros: id === "gs_unknown" ? null : 10000,
  requestCostMicros: ["gs_unknown", "gs_budget"].includes(id) ? null : 17,
  budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/(?:interactions|models\/gemini-[a-z0-9.-]+:generateContent)$/.test(request.url) || request.method !== "POST") refuse("unexpected provider egress");
  const id = /^managed-(gs_[a-z_0-9]+)$/.exec(request.headers.get("x-goog-api-key") ?? "")?.[1];
  if (!ids.includes(id) || inputs.has(id)) refuse("unknown owner or repeated provider egress");
  const proof = { activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, terminal: deferred(),
    readCalls: 0, reads: [], cancelCalls: 0, cancels: [], sourceRejected: false,
    reservedBeforeFetch: (await budgetStatus(fixtureEnv, id, policy(id))).spentMicros };
  inputs.set(id, proof);
  let response;
  try { response = await rawFetch(request); } catch (error) { proof.terminal.resolve(); proof.fetchRejected = true; throw error; }
  const physical = response.body;
  if (!physical) throw new Error("missing real upstream body");
  proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try {
        proof.readCalls++;
        const original = reader.read(); proof.reads.push(original);
        let next;
        try { next = await original; } catch (error) { proof.readRejected = true; throw error; }
        if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
      }
      catch (error) { proof.sourceRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.sourceRejected) unlock(); }
    },
    async cancel(reason) {
      proof.canceled = true; proof.cancelCalls++;
      try { const original = reader.cancel(reason); proof.cancels.push(original); await original; }
      finally { unlock(); }
    },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
async function join(id) {
  for (const record of requests.get(id) ?? []) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) { const batch = record.pending.slice(cursor); cursor += batch.length; await Promise.all(batch); }
  }
  const p = inputs.get(id); await p?.terminal.promise;
  // A concurrent pull may unlock before cancel settles. Join the exact native
  // read/cancel promises separately; terminal/unlocked are not cancellation ACKs.
  const [reads, cancels] = await Promise.all([
    Promise.allSettled(p?.reads ?? []), Promise.allSettled(p?.cancels ?? []),
  ]);
  return { hasBody: !!p?.physical, paths: (requests.get(id) ?? []).map(row => row.path), calls: p ? 1 : 0, retired: true, charged: bodyBudgetCharged(), ...(p?.physical ? {
    activeReads: p.activeReads, eof: p.eof, canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked,
    sourceLocked: p.source.locked, physicalLocked: p.physical.locked, reservedBeforeFetch: p.reservedBeforeFetch,
    readCalls: p.readCalls, readResults: reads.map(result => result.status),
    cancelCalls: p.cancelCalls, cancelResults: cancels.map(result => result.status),
  } : {}) };
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    const path = new URL(request.url).pathname;
    if (path === "/__google/audit") return Response.json(violations);
    if (path === "/__google/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", ids.map(policyId => ({ policyId, policy: policy(policyId) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", ids.map(credentialId => ({ credentialId, credential: { enabled: true, secretSha256, policyId: credentialId, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [{ providerId: "google-gemini", enabled: true }]);
      for (const id of ids) if (id !== "gs_grant") await putGrantCredentials(env, "oauth/" + id + "/google-gemini",
        { provider: id === "gs_foreign" ? "openai" : "google-gemini", kind: "api_key", enabled: true, credential: "managed-" + id });
      return Response.json({ ready: true });
    }
    const control = /^\/__google\/(join|usage|revoke|restrict)\/(gs_[a-z_0-9]+)$/.exec(path);
    if (control && ids.includes(control[2])) {
      const [, action, id] = control;
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && id === "gs_revoked" && request.method === "POST") {
        await revokeGrantCredentials(env, "oauth/" + id + "/google-gemini"); return Response.json({ revoked: true });
      }
      if (action === "restrict" && id === "gs_stale_policy" && request.method === "POST") {
        await authorityCall(env, "/policies/put", { policyId: id, policy: { ...policy(id), providers: ["openai"] } });
        return Response.json({ restricted: true });
      }
      if (action === "usage") {
        await join(id); if (inputs.has(id)) await ingested.get(id).promise;
        const response = await worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
        return response;
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-(gs_[a-z_0-9]+)-/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!ids.includes(id)) refuse("unknown client credential");
    if (path !== "/v1/catalog" && path !== "/v1/proxy/google-gemini/speech_interactions" && !/^\/v1\/native\/google-gemini\/v1beta\/models\/gemini-[a-z0-9.-]+:generateContent$/.test(path)) refuse("unexpected client route");
    const records = requests.get(id) ?? []; requests.set(id, records);
    if (records.some(row => row.path === path)) refuse("repeated client route");
    const record = { path, pending: [], returned: deferred() }; records.push(record);
    const ctx = { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } };
    try { return await worker.fetch(request, { ...env, GOOGLE_API_KEY: "must-not-fallback-google" }, ctx); }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) {
    await worker.queue(batch, env);
    for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve();
  },
};
`.replace("IDS", JSON.stringify(scenarios.map(name => `gs_${name}`)));
}

function upstreamFixture(control) {
  return String.raw`
const calls = [];
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const id = /^managed-(gs_[a-z_0-9]+)$/.exec(request.headers.get("x-goog-api-key") ?? "")?.[1];
  const body = await request.json();
  const call = { id, request: { url: request.url, method: request.method, selectedKey: !!id,
    noProxySecret: !request.headers.has("authorization") && !request.headers.has("x-api-key"), body }, finished: false };
  calls.push(call);
  if (!id || request.method !== "POST") return new Response(null, { status: 400 });
  const name = id.slice(3), model = body.model ?? /\/models\/([^/]+):generateContent$/.exec(new URL(request.url).pathname)?.[1];
  const block = { type: "audio", mime_type: "audio/l16;rate=24000", data: "AAD/fw==" };
  const payload = body.model ? { model, status: "completed", steps: [{ type: "model_output", content: [block, { ...block }] }] }
    : { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAD/fw==" } }, { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAD/fw==" } }] } }] };
  const headers = { "content-type": "application/json" };
  if (["abort_headers", "deadline"].includes(name)) {
    try { const held = await fetch(CONTROL + "/" + name + "/hold", { signal: request.signal }); await held.body?.cancel(); throw new Error("held transport ended without original cancellation"); }
    finally { call.finished = true; }
  }
  if (name === "abort_body") {
    let started = false;
    return new Response(new ReadableStream({ async pull(controller) {
      if (started) return; started = true; controller.enqueue(new TextEncoder().encode('{"steps":['));
      try { const held = await fetch(CONTROL + "/abort_body/hold", { signal: request.signal }); await held.body?.cancel(); throw new Error("held body ended without original cancellation"); }
      catch (error) { controller.error(error); }
      finally { call.finished = true; }
    } }, { highWaterMark: 0 }), { headers });
  }
  call.finished = true;
  if (name === "non200") return Response.json({ error: "synthetic unavailable" }, { status: 503 });
  if (name === "redirect") return new Response(null, { status: 307, headers: { ...headers, location: "https://alternate.example/speech" } });
  if (name === "encoding") headers["content-encoding"] = "unsupported";
  if (name === "later") payload.steps[0].content.push({ type: "audio", mime_type: "audio/l16", data: "AAAA" });
  const bytes = new TextEncoder().encode(name === "truncated" ? '{"steps":[' : JSON.stringify(payload));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 17, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers });
} };
`.replaceAll("CONTROL", JSON.stringify(control));
}
