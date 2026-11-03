import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { minimaxSpeechBinding } from "../../shared/native-media-binding.ts";
import { snapshot } from "../providers.ts";
import { sha256Hex } from "../utils.ts";
import { putGrantCredentials, materializeGrantCredentials, inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } from "../grant-credentials.ts";
import { routingProjection } from "../grant-projection.ts";
import { prepareMiniMaxMediaDispatch } from "../minimax-media-dispatch.ts";
import { configuredUpstream } from "../providers.ts";
import { cachedGrantCredentials } from "../credential-cache.ts";
import { overrideHotCacheConfig, HOT_CACHE_DISABLED } from "../hot-cache.ts";
import { bodyBudgetCharged } from "../body-budget.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/speech.json", import.meta.url), "utf8"));
const nativePath = "/v1/native/minimax/v1/t2a_v2", manifestPath = "/v1/proxy/minimax/speech";
const adminPath = "/v1/admin/upstream-grants/policies/fixture/replicate";
// Same public decoder-verified 32 kHz mono tone used by the source-owned leaf.
const mp3 = Buffer.from("//tYxAAADkBFMnWUgAIIH6WLOxAAASSTkMMUxRzJLMskxwy+bpAA43oj97PnE52zRHLXqbsTa+74YFAIAgGBQKEDE5o0aNHMPqBAEDm1P/v6PP9Hv6Pf0fxOBAQdDAPh/AgY4Pg+D4Pg4CAIAgCAPg+D4PgQEAQBAMA+D4Pg+BAQBA5Hg+foAAAgQQMLRcMWyIHAGMERzL6g0UjlcRjSVPjULxzfAXzWb7jZcxTD0JDCsLCgQGhgITmKgGcDzVwNUOSC4b8LQhSIgqHw/45QuYVsQ0c0ZX/8miLECKJFSKmRe//8mjEul0yLxeRRMf//8yLxeMS6XUi8bCUJf/waEt////7FxUrPFQAACRIAgCAhAGzAPAFUwIgClMA6AsDB//tYxAuCDpAvDR33gAICQeEhv5SgUwgow+Ea0MgpZGjYChpUxGkZqMLvCKDCZwYYwJcA6MAjAATANgCcMAAVNCzQalWWjaYomfddOOac92/xqVatUcqtFPyXdp6jFvrR+/T3oTRcS29bB5P/+/9YX3tUgCoGYoDgsxYIMxHTVjo6VxMFyBEjGwzhY4agKKMH2HKDBswcICgRJKAbDAAqOgAibrVH3A4KPnMyKrktoWjumtU+l39X/oi1elO7et2s3S3b/10uiN32322dbr9ry22pZLqpkv0T7JdHLuqNVmTXW6ZrEq37br//xW/ZffYSmr2qAChCA0eAEiYAwGgF8eArDApwAQwYoC3MeFS/Tl3AHswbwfWMFUCHDAigK028//tYxBaCESYPBq/oqoIUQeDBv4ipwyyMwo4GAVbo7PSG19dlntx+5Uat0v1uKerb9kj0XR143TS51Y6WdG/b71ul3TSySrqnHIpyJfnvZ32pdNVb9d9zJZL701Z00912WyW/r9tV01xa/dLb1hiVyUyWVMBAjBgsxUcMsQTZ54wRQIXMXZmezeDA1swL4XwMN4ByDA7AJUwGEBCMAsAHzAEwAoDAAqdUCyqHabjdMnSlXMmrsv2ufbG/yks1HTq9c90VU6o3/71tsqPS6X9Oy7fk6Xppbbb9/1S6W2o9Wbp7put6N162Sz6b/hb0ult6qLNvrpuqKgAAGB4wDEAfAABoYBgAiGBDAMxgO4IiYJeEQmJIja5iZ8jOZ2oCjGFC//tYxBSAELQtCxX0gAJ8LakDNtABhFhh2AN0YWAETGCeAWQOAzDAOwEcwC0AVDgBNYgBADht6rQG2ha8e3jsV8q1xFsjuW10U6dMe0YlWEEDnkgoRbq3EVLqEfGolCIzGpWA/XYbU/RX68DMobwgihdtRW+UrnZiBAU0wtMcFTJ4QmgzCg9eNJtS910UWI4SARgdwmXHgF7GHGGJo9fJcTAehKEqZF4vfjnHuUxyEoaIl01UXkv8e5fNyULhoS5fWiipJ1o/+bkoXDQvl83LhcNGpaP//y+X0y4XEC+bplxBAv/Xq1///ppmiCBummaCA9II59+ebl5v//////h6QQHpBAekEB7WUUkFRSQVFJBVfDDolCUJR8lASACrCUAE//tYxAeDymQtFDzBgAAAADSAAAAEKVK4+e1mYUDVwlBV1QNB1Z0Sgq4RKBo8s6JQViJQNHlnRKCsRKBo8s6JQ1EUGnrOlXdP//T7un3dPu6et3I9buR63ciqTEFNRTQuMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "base64");
function result() { const value = structuredClone(wire.result); value.data.audio = mp3.toString("hex"); value.extra_info.audio_size = mp3.length; value.extra_info.audio_length = 180; return value; }
const grant = extra => ({ provider: "minimax", kind: "api_key", enabled: true, credential: "synthetic-original-key", ...extra });
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(value => value.id === "minimax"));
  const original = snapshot.providers;
  snapshot.providers = original.filter(value => value.id !== "minimax").map(value => value.id === "replicate" ? structuredClone(value) : value);
  t.after(() => { snapshot.providers = original; });
  const endpoint = { ...provider.endpoints[0], id: "speech", method: "POST", path: "/v1/t2a_v2", path_params: [],
    request_format: "minimax.speech", response_format: "minimax.speech", query: {}, streaming: null, modelPassthrough: undefined, timeout_ms: 1000 };
  provider.endpoints = [endpoint]; provider.capabilities = [{ id: "audio.speech", endpoint: "speech", methods: ["POST"] }];
  // Deliberately retain a tempting Chat price: it must never price native media.
  provider.models = [{ ...provider.models[0], id: "minimax/" + wire.request.model, upstream: wire.request.model, capabilities: ["audio.speech"] }];
  const f = await fixture(t, { ...options, pooled: false, providerId: "minimax", configure(target) { Object.assign(target, provider); } });
  f.env.MINIMAX_API_KEY = "synthetic-environment-key";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  f.bindEnvironment = async () => { f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...minimaxSpeechBinding,
    credentialSource: "MINIMAX_API_KEY", credentialSha256: await sha256Hex(f.env.MINIMAX_API_KEY) }); };
  await f.bindEnvironment();
  f.admin = (body, query = "", headers = {}) => f.call(adminPath + query, body, { method: "PUT", headers: { authorization: "Bearer synthetic-admin", ...headers } });
  f.put = async (body, query = "") => {
    const response = await f.admin(body, query), text = await response.text();
    assert.equal(response.status, 200, text); assert.doesNotMatch(text, /synthetic-(?:original|environment|replacement)-key/); return JSON.parse(text);
  };
  if (options.pooled) {
    await f.put({ ...grant(), nativeMediaAuthorization: "minimax-global-speech" });
    f.policy.grantRouting = { eligibleGrants: { minimax: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.request = (manifest = false, body = structuredClone(wire.request), extra = {}) => f.call(manifest ? manifestPath : nativePath,
    manifest ? { body } : body, { ...extra, headers: { "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.upstream = () => Response.json(result());
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.afterDispatchAck = change => {
    const get = f.env.BUDGET_LEDGER.get; let changed = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/dispatch" && !changed) { changed = true; await change(); }
      return response;
    } }; };
  };
  t.after(f.drain); return f;
}
async function denied(f, response) {
  const text = await response.text(); assert.notEqual(response.status, 200, text);
  assert.doesNotMatch(text, /synthetic-(?:original|environment|replacement)-key/);
  await f.drain(); assert.equal(f.sent.length, 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}
for (const pooled of [false, true]) for (const manifest of [false, true]) test(`MiniMax ${pooled ? "original grant" : "explicit environment"} ${manifest ? "manifest" : "native"} complete dispatch`, async t => {
  const f = await setup(t, { pooled });
  f.upstream = async request => {
    assert.equal(request.url, "https://api.minimax.io/v1/t2a_v2"); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-environment-key");
    assert.equal(request.headers.has("x-api-key"), false); assert.deepEqual(await request.json(), wire.request);
    assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); return Response.json(result());
  };
  const response = await f.request(manifest); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), result()); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].actual_cost_micros, 700);
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(events[0][key], null);
  assert.ok(f.rows().every(row => row.settled === 1));
});

test("MiniMax owner binding requires actual privileged admin intent, never metadata", async t => {
  const f = await setup(t, { pooled: true });
  const unauthorized = await f.admin({ ...grant(), nativeMediaAuthorization: "minimax-global-speech" }, "", { authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  for (const key of ["nativeMediaBinding", "nativeMediaIntent"]) {
    const response = await f.admin({ ...grant(), [key]: minimaxSpeechBinding }); assert.equal(response.status, 400); await response.text();
  }
  await putGrantCredentials(f.env, grantKey, { ...grant(), nativeMediaBinding: minimaxSpeechBinding });
  const owner = await inspectGrantCredentials(f.env, grantKey); assert.equal(owner.nativeMediaBinding, null);
  assert.equal(secretlessGrant({ ...grant(), nativeMediaBinding: minimaxSpeechBinding }).nativeMediaBinding, null);
  await denied(f, await f.request());
});

test("MiniMax omission preserves same owner key; removal, account and key replacement require renewed authorization", async t => {
  const f = await setup(t, { pooled: true }), before = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ label: "renamed" }); const same = await inspectGrantCredentials(f.env, grantKey);
  assert.deepEqual(same.nativeMediaBinding, minimaxSpeechBinding); assert.equal(same.credentialLineage, before.credentialLineage);
  assert.ok(same.credentialGeneration > before.credentialGeneration);
  await f.put({ nativeMediaAuthorization: null }); const removed = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(removed.nativeMediaBinding, null); assert.notEqual(removed.credentialLineage, same.credentialLineage);
  await denied(f, await f.request());
  for (const change of [{ accountId: "synthetic-other-account" }, { credential: "synthetic-replacement-key" }]) {
    await f.put({ nativeMediaAuthorization: "minimax-global-speech" });
    await f.put(change); assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null);
    await denied(f, await f.request());
  }
  await f.put({ ...grant(), nativeMediaAuthorization: "minimax-global-speech" });
  await f.put(grant(), "?mode=replace"); assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null);
});

for (const kind of ["oauth", "subscription", "access-fallback", "bundle", "mixed", "cn", "future", "field", "newline"]) test("MiniMax refuses " + kind + " credential authority", async t => {
  const f = await setup(t, { pooled: true });
  if (kind === "cn" || kind === "future" || kind === "field") {
    const owner = f.env.GRANT_CREDENTIALS.objects.get(grantKey), record = owner.values.get("credential");
    record.nativeMediaBinding = { ...minimaxSpeechBinding, ...(kind === "cn" ? { origin: "https://api.minimaxi.com" }
      : kind === "future" ? { version: "clawrouter.native-media.v2" } : { authority: true }) };
    owner.values.set("credential", record);
  } else {
    const value = kind === "oauth" || kind === "subscription" ? { kind, credential: undefined, accessToken: "synthetic-portal-token" }
      : kind === "access-fallback" ? { credential: undefined, accessToken: "synthetic-fallback-token" }
      : kind === "bundle" ? { credential: undefined, credentials: { arbitrary: "synthetic-bundle-key" } }
      : kind === "newline" ? { credential: "synthetic-invalid-key\n" } : { credentials: { extra: "synthetic-bundle-key" } };
    // Replacement cannot silently inherit the previous product binding.
    await putGrantCredentials(f.env, grantKey, grant(value));
  }
  await denied(f, await f.request());
});

for (const mutation of ["remove", "replace", "disable", "revoke", "unavailable", "failed-publication"]) test("MiniMax final owner check denies " + mutation + " after dispatch accounting awaits", async t => {
  const f = await setup(t, { pooled: true });
  f.afterDispatchAck(async () => {
    if (mutation === "unavailable") {
      const get = f.env.GRANT_CREDENTIALS.get;
      f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) { return new URL(url).pathname === "/inspect" ? new Response("owner unavailable", { status: 503 }) : stub.fetch(url, init); } }; }; return;
    }
    if (mutation === "revoke") { await revokeGrantCredentials(f.env, grantKey); return; }
    if (mutation === "failed-publication") {
      const namespace = f.env.ACCESS_CONTROL, get = namespace.get;
      namespace.get = id => { const stub = get(id); return { fetch(url, init) { return new URL(url).pathname === "/grant-pools/publish" && JSON.parse(init.body).status === "paused" ? new Response("publication unavailable", { status: 503 }) : stub.fetch(url, init); } }; };
      await assert.rejects(() => putGrantCredentials(f.env, grantKey, { enabled: false }, true));
      const committed = f.env.GRANT_CREDENTIALS.objects.get(grantKey).values.get("credential");
      assert.equal(committed.enabled, false); assert.equal(committed.poolSyncPending, true); return;
    }
    await f.put(mutation === "remove" ? { nativeMediaAuthorization: null }
      : mutation === "disable" ? { enabled: false } : { credential: "synthetic-replacement-key", nativeMediaAuthorization: "minimax-global-speech" });
  });
  await denied(f, await f.request()); assert.ok(f.budgetCalls.some(call => call.path === "/dispatch"));
});

for (const mutation of ["key", "binding", "source", "missing", "wrong-fingerprint"]) test("MiniMax environment qualification denies " + mutation + " without borrowing authority", async t => {
  const f = await setup(t);
  const change = async () => {
    if (mutation === "key") { f.env.MINIMAX_API_KEY = "synthetic-replacement-key"; await f.bindEnvironment(); }
    if (mutation === "binding") f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...JSON.parse(f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING), region: "cn" });
    if (mutation === "source") { f.provider.config_keys.unshift("OTHER_API_KEY"); f.env.OTHER_API_KEY = f.env.MINIMAX_API_KEY; }
    if (mutation === "missing") delete f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING;
    if (mutation === "wrong-fingerprint") f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...JSON.parse(f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING), credentialSha256: "0".repeat(64) });
  };
  if (mutation === "missing" || mutation === "wrong-fingerprint") await change(); else f.afterDispatchAck(change);
  await denied(f, await f.request());
});

for (const provenance of [undefined, "clawrouter_oauth"]) test("MiniMax pool/OAuth replacement never inherits authorization " + provenance, async t => {
  const f = await setup(t, { pooled: true });
  await putGrantCredentials(f.env, grantKey, grant(), provenance === "clawrouter_oauth", undefined, provenance);
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null); await denied(f, await f.request());
});

test("MiniMax legacy and forged routing projections cannot authorize original credential dispatch", async t => {
  const f = await setup(t, { pooled: true });
  const owner = f.env.GRANT_CREDENTIALS.objects.get(grantKey), record = owner.values.get("credential");
  record.nativeMediaBinding = undefined; record.metadata.nativeMediaBinding = minimaxSpeechBinding; owner.values.set("credential", record);
  const forged = { ...await inspectGrantCredentials(f.env, grantKey), nativeMediaBinding: minimaxSpeechBinding };
  await f.env.POLICY_KV.put(grantKey, JSON.stringify(forged));
  assert.equal((await materializeGrantCredentials(f.env, grantKey, forged, "minimax", null, false)).nativeMediaBinding, null);
  assert.equal(routingProjection({ ...grant(), nativeMediaBinding: minimaxSpeechBinding }).nativeMediaBinding, null);
  await denied(f, await f.request());
});

test("MiniMax final owner check rejects an old credential cache revision", async t => {
  const f = await setup(t, { pooled: true }); overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 10000 });
  t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const projection = await inspectGrantCredentials(f.env, grantKey), materialize = () => materializeGrantCredentials(f.env, grantKey, projection, "minimax", null, false);
  const selected = await cachedGrantCredentials(f.env, grantKey, projection, materialize);
  const upstream = { ...configuredUpstream(f.provider, selected, f.env), grantKey };
  const check = await prepareMiniMaxMediaDispatch({ provider: f.provider, endpoint: f.provider.endpoints[0] }, f.env, upstream,
    new URL("https://api.minimax.io/v1/t2a_v2"), upstream.headers);
  await putGrantCredentials(f.env, grantKey, { enabled: false }, true);
  const cached = await cachedGrantCredentials(f.env, grantKey, projection, () => { throw new Error("unexpected cache miss"); });
  assert.equal(cached.credential, selected.credential);
  await assert.rejects(() => check(new AbortController().signal), error => error.code === "native_media_authorization_required");
  assert.equal(f.sent.length, 0);
});

for (const manifest of [false, true]) test("MiniMax unknown USD remains closed " + manifest, async t => {
  const f = await setup(t, { pooled: true, fixed: null }); await denied(f, await f.request(manifest));
  assert.equal(f.budgetCalls.some(call => call.path === "/reserve"), false);
});

for (const invalid of ["status", "metadata", "partial", "http", "redirect"]) test("MiniMax dispatched " + invalid + " is conservative with no retry", async t => {
  const f = await setup(t, { pooled: true });
  f.upstream = () => {
    const body = result();
    if (invalid === "status") body.base_resp.status_code = 1;
    if (invalid === "metadata") body.extra_info.audio_sample_rate = 44100;
    if (invalid === "partial") return new Response('{"data":', { headers: { "content-type": "application/json" } });
    return Response.json(body, { status: invalid === "http" ? 422 : invalid === "redirect" ? 302 : 200 });
  };
  const response = await f.request(); assert.equal(response.status, 502); await response.text(); await f.drain();
  assert.equal(f.sent.length, 1); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(bodyBudgetCharged(), 0);
});

for (const layer of ["hit", "colo"]) test("MiniMax real Worker rejects revoked authority behind a warm " + layer + " admission", async t => {
  const f = await setup(t, { pooled: true });
  overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 10000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const entries = new Map(), previous = globalThis.caches; let cacheHits = 0;
  globalThis.caches = { default: {
    async put(url, response) { entries.set(String(url), await response.text()); },
    async match(url) { const body = entries.get(String(url)); if (body) cacheHits++; return body ? new Response(body) : undefined; },
  } }; t.after(() => { globalThis.caches = previous; });
  const warm = await f.request(); assert.equal(warm.status, 200, await warm.clone().text()); await warm.json(); await f.drain();
  assert.equal(f.sent.length, 1); assert.ok(entries.size > 0); assert.doesNotMatch([...entries.values()].join(""), /synthetic-original-key/);
  // Simulate mutation handled by another isolate: direct owner call does not
  // run this isolate's admin handler/cache invalidation.
  await putGrantCredentials(f.env, grantKey, { enabled: false }, true);
  if (layer === "colo") (await import("../hot-cache.ts")).clearHotCaches();
  const response = await f.request(), text = await response.text(); assert.notEqual(response.status, 200, text);
  await f.drain(); assert.equal(f.sent.length, 1, "no second inference or environment fallback");
  if (layer === "colo") assert.ok(cacheHits > 0, "actual shared cache response was read");
  const events = await f.events(); assert.equal(events.filter(event => event.actual_cost_micros === 700).length, 1);
});

test("MiniMax raw legacy import cannot copy metadata product authorization", async t => {
  const f = await setup(t), legacy = { ...grant(), nativeMediaBinding: minimaxSpeechBinding };
  await f.env.POLICY_KV.put(grantKey, JSON.stringify(legacy));
  const materialized = await materializeGrantCredentials(f.env, grantKey, legacy, "minimax", null, false);
  assert.equal(materialized.nativeMediaBinding, null);
  f.policy.grantRouting = { eligibleGrants: { minimax: ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await denied(f, await f.request());
});

test("MiniMax owner check is deadline bounded and never refreshes or falls back", async t => {
  const f = await setup(t, { pooled: true }); f.provider.endpoints[0].timeout_ms = 20;
  const get = f.env.GRANT_CREDENTIALS.get; let inspected = false;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) {
    if (new URL(url).pathname !== "/inspect") return stub.fetch(url, init);
    inspected = true;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } }; };
  await denied(f, await f.request()); assert.equal(inspected, true);
});


test("MiniMax admin distinguishes a paused owner's retained binding from explicit removal", async t => {
  const f = await setup(t, { pooled: true });
  const paused = await f.put({ enabled: false });
  assert.equal(paused.enabled, false); assert.deepEqual(paused.nativeMediaBinding, minimaxSpeechBinding);
  await denied(f, await f.request());
  const removed = await f.put({ enabled: false, nativeMediaAuthorization: null });
  assert.equal(removed.enabled, false); assert.equal(removed.nativeMediaBinding, null);
});
