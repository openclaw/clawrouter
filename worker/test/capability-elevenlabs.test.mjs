import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const ids = ["elevenlabs"];
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/elevenlabs/speech.json", import.meta.url), "utf8"));
const audio = Buffer.from(wire.response.base64, "base64");
const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...ids.map(id => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));

async function fixture(t) {
  // Integration owns the generated snapshot. Exercise these exact compiled manifests
  // even before the serial snapshot regeneration lands.
  const original = snapshot.providers;
  snapshot.providers = [...original.filter(p => !ids.includes(p.id)), ...compiled.providers];
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ids, models: null, tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = { unmetered: base, fixed: { ...base, monthlyBudgetMicros: 1000000, requestCostMicros: 7 }, reserve: { ...base, monthlyBudgetMicros: 1000000 }, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { ELEVENLABS_API_KEY: "synthetic-api-key", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" } }))));
  await authorityCall(env, "/connections/initialize-all", ids.map(providerId => ({ providerId, enabled: true })));
  const hooks = { reject: false, wrongMime: false, partial: false };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json() });
    if (hooks.partial) {
      let first = true;
      return new Response(new ReadableStream({ pull(controller) {
        if (first) { first = false; controller.enqueue(audio.subarray(0, 4)); }
        else controller.error(new Error("synthetic interrupted audio"));
      } }), { headers: { "content-type": wire.response.contentType } });
    }
    return hooks.reject ? Response.json({ error: { message: "fixture rejection" } }, { status: 422 }) : new Response(audio, { headers: { "content-type": hooks.wrongMime ? "text/plain" : wire.response.contentType } });
  });
  const body = wire.request.body;
  const request = (key = "unmetered", manifest = false) => worker.fetch(new Request(manifest
    ? "https://router.example/v1/proxy/elevenlabs/speech"
    : "https://router.example/v1/native/elevenlabs" + wire.request.path + "?" + new URLSearchParams(wire.request.query), {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json", "xi-api-key": "synthetic-caller-header" },
    body: JSON.stringify(manifest ? { body, pathParams: wire.request.pathParams, query: wire.request.query } : body),
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, hooks, body };
}

test("ElevenLabs forwards native JSON voice settings and xi-api-key with byte-exact audio", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "audio/pcm");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.equal(f.sent[0].url, "https://api.elevenlabs.io/v1/text-to-speech/syntheticVoice1234567?output_format=pcm_16000&optimize_streaming_latency=2");
  assert.equal(f.sent[0].headers.get("xi-api-key"), "synthetic-api-key");
  assert.equal(f.sent[0].headers.get("authorization"), null);
  assert.deepEqual(f.sent[0].body, f.body);
  assert.equal(compiled.providers[0].models.length, 0);
  await Promise.all(f.pending);
  assert.equal(f.events[0].capability, "audio.speech");
  assert.equal(f.events[0].model, null);
  assert.equal(f.events[0].input_tokens, null);
  assert.equal(f.events[0].cost_basis, "flat_fallback");
  assert.equal(f.events[0].actual_cost_micros, 1);
});

test("ElevenLabs rejects forbidden providers and unpriced reserve requests before dispatch", async t => {
  const f = await fixture(t);
  for (const key of ["denied", "reserve"]) {
    const response = await f.request(key);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, key === "reserve" ? "pricing_required" : "provider_not_allowed");
    assert.equal(f.sent.length, 0);
  }
});

test("ElevenLabs fixed policy charge and rejected synthesis have distinct accounting", async t => {
  const f = await fixture(t), success = await f.request("fixed");
  assert.equal(success.status, 200, await success.clone().text());
  await success.arrayBuffer();
  await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, 7);
  f.hooks.reject = true;
  const failed = await f.request("fixed");
  assert.equal(failed.status, 422);
  await failed.text();
  await Promise.all(f.pending);
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
  assert.equal(f.events.at(-1).status, "client_error");
});

test("ElevenLabs wrong-MIME success cannot be recorded as completed speech", async t => {
  const f = await fixture(t);
  f.hooks.wrongMime = true;
  const result = await f.request("fixed");
  await result.arrayBuffer();
  await Promise.all(f.pending);
  assert.equal(f.events.at(-1).status, "provider_error");
  assert.equal(f.events.at(-1).input_tokens, null);
});


test("ElevenLabs interrupted binary delivery retains the fixed reservation without fabricated token usage", async t => {
  const f = await fixture(t);
  f.hooks.partial = true;
  const result = await f.request("fixed");
  assert.equal(result.status, 200);
  await assert.rejects(() => result.arrayBuffer(), /synthetic interrupted audio/);
  await Promise.all(f.pending);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, "provider_error");
  assert.equal(f.events[0].input_tokens, null);
  assert.equal(f.events[0].cost_basis, "policy_fixed");
  assert.equal(f.events[0].actual_cost_micros, 7);
});


test("ElevenLabs manifest route preserves the voice path and native query/body separation", async t => {
  const f = await fixture(t), response = await f.request("fixed", true);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  const url = new URL(f.sent[0].url);
  assert.equal(url.origin, "https://api.elevenlabs.io");
  assert.equal(url.pathname, wire.request.path);
  assert.deepEqual(Object.fromEntries(url.searchParams), wire.request.query);
  assert.deepEqual(f.sent[0].body, wire.request.body);
  assert.equal(f.sent[0].headers.get("xi-api-key"), "synthetic-api-key");
  await Promise.all(f.pending);
  assert.equal(f.events[0].cost_basis, "policy_fixed");
});
