import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const ids = ["inworld"];
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
  const env = { INWORLD_API_KEY: "synthetic-base64-credential", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" } }))));
  await authorityCall(env, "/connections/initialize-all", ids.map(providerId => ({ providerId, enabled: true })));
  const hooks = { reject: false };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json() });
    return hooks.reject ? Response.json({ error: { message: "fixture rejection" } }, { status: 422 }) : Response.json({ audioContent: "AQID", usage: { processedCharactersCount: 7, modelId: "inworld-tts-2" } });
  });
  const body = { text: "fixture", modelId: "inworld-tts-2", voiceId: "Ashley", audioConfig: { audioEncoding: "MP3" } };
  const request = (key = "unmetered") => worker.fetch(new Request("https://router.example/v1/native/inworld/tts/v1/voice", {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, hooks, body };
}

test("Inworld keeps native model/voice fields and Basic credential while preserving audio JSON", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { audioContent: "AQID", usage: { processedCharactersCount: 7, modelId: "inworld-tts-2" } });
  assert.equal(f.sent[0].url, "https://api.inworld.ai/tts/v1/voice");
  assert.equal(f.sent[0].headers.get("authorization"), "Basic synthetic-base64-credential");
  assert.deepEqual(f.sent[0].body, f.body);
  assert.equal(compiled.providers[0].models.length, 0);
  await Promise.all(f.pending);
  assert.equal(f.events[0].capability, "audio.speech");
  assert.equal(f.events[0].model, null);
  assert.equal(f.events[0].input_tokens, null, "character usage is not token usage");
  assert.equal(f.events[0].cost_basis, "flat_fallback");
  assert.equal(f.events[0].actual_cost_micros, 1);
});

test("Inworld rejects forbidden providers and unpriced reserve requests before dispatch", async t => {
  const f = await fixture(t);
  for (const key of ["denied", "reserve"]) {
    const response = await f.request(key);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, key === "reserve" ? "pricing_required" : "provider_not_allowed");
    assert.equal(f.sent.length, 0);
  }
});

test("Inworld fixed policy charge and rejected synthesis have distinct accounting", async t => {
  const f = await fixture(t), success = await f.request("fixed");
  assert.equal(success.status, 200, await success.clone().text());
  await success.text();
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
