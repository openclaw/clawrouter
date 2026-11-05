import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureMusic, musicBody, musicModel, musicModels, musicResult, musicSse } from "./minimax-music-runtime-fixture.mjs";
import { minimaxMusicBinding, readNativeMediaBinding } from "../../shared/native-media-binding.ts";
import { minimaxSpeechBinding } from "../../shared/native-media-binding.ts";
import { snapshot } from "../providers.ts";
import { grantSupports } from "../provider-auth.ts";
import { sha256Hex } from "../utils.ts";
import { putGrantCredentials, materializeGrantCredentials, inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } from "../grant-credentials.ts";
import { routingProjection } from "../grant-projection.ts";
import { overrideHotCacheConfig, HOT_CACHE_DISABLED } from "../hot-cache.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
const nativePath = "/v1/native/minimax/v1/music_generation", manifestPath = "/v1/proxy/minimax/music";
const adminPath = "/v1/admin/upstream-grants/policies/fixture/replicate";
const originalKey = "synthetic-original-music-key";
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(row => row.id === "minimax")); configureMusic(provider);
  // Compiled discovery projections are immutable per provider object. Give the
  // injected declaration its own identity, preserving production cache semantics.
  const originalProviders = snapshot.providers;
  snapshot.providers = originalProviders.filter(row => row.id !== "minimax").map(row => row.id === "replicate" ? structuredClone(row) : row);
  t.after(() => { snapshot.providers = originalProviders; });
  const f = await fixture(t, { providerId: "minimax", fixed: options.fixed === undefined ? 700 : options.fixed, configure(target) { Object.assign(target, provider); } });
  f.env.MINIMAX_API_KEY = "synthetic-forbidden-environment-key";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  f.admin = (body, query = "", headers = {}) => f.call(adminPath + query, body, { method: "PUT", headers: { authorization: "Bearer synthetic-admin", ...headers } });
  f.put = async (body, query = "") => { const r = await f.admin(body, query), text = await r.text(); assert.equal(r.status, 200, text); assert.doesNotMatch(text, /synthetic-(?:original-music|replacement|forbidden-environment)-key/); return JSON.parse(text); };
  if (!options.environment) await f.put({ provider: "minimax", kind: "api_key", enabled: true, accountId: "synthetic-account", credential: originalKey,
    ...(options.qualify === false ? {} : { nativeMediaAuthorization: "minimax-global-music" }) });
  f.policy.models = [musicModel]; f.policy.grantRouting = { eligibleGrants: options.environment ? {} : { minimax: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (manifest = false, body = musicBody(), extra = {}) => f.call(manifest ? manifestPath : nativePath,
    manifest ? { body } : body, extra);
  f.upstream = () => Response.json(musicResult());
  f.materializations = 0;
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) {
    if (new URL(url).pathname === "/materialize") f.materializations++;
    return stub.fetch(url, init);
  } }; };
  f.afterBudget = change => { const get = f.env.BUDGET_LEDGER.get; let once = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const reply = await stub.fetch(url, init); if (new URL(url).pathname === "/dispatch" && !once) { once = true; await change(); } return reply;
    } }; };
  };
  t.after(f.drain); return f;
}
async function denied(f, response) {
  const text = await response.text(); assert.notEqual(response.status, 200, text);
  assert.doesNotMatch(text, /synthetic-(?:original-music|replacement|forbidden-environment)-key/);
  await f.drain(); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}
for (const manifest of [false, true]) test(`MiniMax music ${manifest ? "manifest" : "native"} uses original owner and one fixed settlement`, async t => {
  const f = await setup(t);
  f.upstream = async request => {
    assert.equal(request.url, "https://api.minimax.io/v1/music_generation"); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), `Bearer ${originalKey}`); assert.equal(request.headers.has("x-api-key"), false);
    assert.deepEqual(await request.json(), musicBody()); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
    return Response.json(musicResult());
  };
  const r = await f.request(manifest); assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), musicResult());
  await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.materializations, 1); assert.equal(bodyBudgetCharged(), 0);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(events[0][name], null);
});
test("MiniMax music admin intent cannot come from caller metadata or non-admin", async t => {
  const f = await setup(t);
  const unauthorized = await f.admin({ nativeMediaAuthorization: "minimax-global-music" }, "", { authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  for (const body of [{ nativeMediaBinding: minimaxMusicBinding }, { nativeMediaIntent: minimaxMusicBinding }, { nativeMediaAuthorization: true }, { nativeMediaAuthorization: "minimax-global-image" }]) {
    const r = await f.admin(body); assert.equal(r.status, 400); await r.text();
  }
  await putGrantCredentials(f.env, grantKey, { provider: "minimax", kind: "api_key", credential: originalKey, nativeMediaBinding: minimaxMusicBinding });
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null);
  assert.equal(secretlessGrant({ provider: "minimax", nativeMediaBinding: minimaxMusicBinding }).nativeMediaBinding, null);
  await denied(f, await f.request());
});
test("MiniMax music same-owner omission preserves; removal and replacement require renewed intent", async t => {
  const f = await setup(t), before = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ label: "synthetic rename" }); const kept = await inspectGrantCredentials(f.env, grantKey);
  assert.deepEqual(kept.nativeMediaBinding, minimaxMusicBinding); assert.equal(kept.credentialLineage, before.credentialLineage);
  for (const mutation of [{ nativeMediaAuthorization: null }, { credential: "synthetic-replacement-key" }, { accountId: "synthetic-other-account" }]) {
    await f.put({ nativeMediaAuthorization: "minimax-global-music" }); await f.put(mutation);
    assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null); await denied(f, await f.request());
  }
  await f.put({ nativeMediaAuthorization: "minimax-global-music" });
  await f.put({ provider: "minimax", kind: "api_key", credential: originalKey }, "?mode=replace");
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null); await denied(f, await f.request());
});
for (const mode of ["legacy", "speech", "oauth", "subscription", "bundle", "access-fallback", "mixed", "cn", "extra", "version", "foreign-model", "revoked"]) test(`MiniMax music refuses ${mode} authority`, async t => {
  const f = await setup(t, { qualify: false });
  if (mode === "speech") await f.put({ nativeMediaAuthorization: "minimax-global-speech" });
  else if (["cn", "extra", "version", "foreign-model"].includes(mode)) {
    const state = f.env.GRANT_CREDENTIALS.objects.get(grantKey), record = state.values.get("credential");
    record.nativeMediaBinding = { ...minimaxMusicBinding, ...(mode === "cn" ? { region: "cn", origin: "https://api.minimaxi.com" }
      : mode === "extra" ? { allow: true } : mode === "version" ? { version: "future" } : { model: "foreign" }) }; state.values.set("credential", record);
  } else if (mode === "revoked") { await f.put({ nativeMediaAuthorization: "minimax-global-music" }); await revokeGrantCredentials(f.env, grantKey); }
  else if (mode !== "legacy") {
    const value = mode === "oauth" || mode === "subscription" ? { kind: mode, accessToken: "synthetic-portal-token" }
      : mode === "bundle" ? { kind: "api_key", credentials: { key: originalKey } }
      : mode === "access-fallback" ? { kind: "api_key", accessToken: originalKey }
      : { kind: "api_key", credential: originalKey, accessToken: "synthetic-other-token" };
    await putGrantCredentials(f.env, grantKey, { provider: "minimax", enabled: true, ...value, nativeMediaBinding: minimaxMusicBinding });
  }
  await denied(f, await f.request()); assert.equal(f.materializations, 0);
});
for (const mutate of ["model", "format", "response", "capability", "origin", "path", "query", "auth", "stream", "transport"]) test(`MiniMax music rejects ${mutate} route mismatch`, async t => {
  const f = await setup(t), p = f.provider, e = p.endpoints[0];
  if (mutate === "model") p.models[0].upstream = "foreign";
  else if (mutate === "format") e.request_format = "openai.chat_completions";
  else if (mutate === "response") e.response_format = "openai.chat_completions";
  else if (mutate === "capability") { p.capabilities[0].id = "llm.chat"; p.models[0].capabilities = ["llm.chat"]; }
  else if (mutate === "origin") p.base_urls.default = "https://api.minimaxi.com";
  else if (mutate === "path") e.upstreamPath = "/v1/chat/completions";
  else if (mutate === "query") e.query = { target: "foreign" };
  else if (mutate === "auth") e.auth = { type: "none" };
  else if (mutate === "stream") e.streaming = "ndjson";
  else p.auth.grantTransports.api_key = { baseUrl: "https://api.minimaxi.com", auth: p.auth.schemes[0], headers: {}, appendHeaders: {}, endpointPaths: {} };
  await denied(f, await f.request()); assert.equal(f.materializations, 0);
});
for (const mutate of ["remove", "rotate", "disable", "revoke", "policy", "model", "caller", "owner-unavailable", "failed-publication"]) test(`MiniMax music fresh final check denies ${mutate} after budget awaits`, async t => {
  const f = await setup(t);
  f.afterBudget(async () => {
    if (mutate === "revoke") return revokeGrantCredentials(f.env, grantKey);
    if (mutate === "policy" || mutate === "model") return f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, ...(mutate === "policy" ? { generation: "g2" } : { models: [] }) } });
    if (mutate === "caller") return f.authority("/credentials/put", { credentialId: "fixture", credential: { ...f.credential, enabled: false } });
    if (mutate === "owner-unavailable") { const get = f.env.GRANT_CREDENTIALS.get; f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) { return new URL(url).pathname === "/inspect" ? new Response(null, { status: 503 }) : stub.fetch(url, init); } }; }; return; }
    if (mutate === "failed-publication") {
      const get = f.env.ACCESS_CONTROL.get; f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) { return new URL(url).pathname === "/grant-pools/publish" && JSON.parse(init.body).status === "paused" ? new Response(null, { status: 503 }) : stub.fetch(url, init); } }; };
      await assert.rejects(() => putGrantCredentials(f.env, grantKey, { enabled: false }, true)); return;
    }
    return f.put(mutate === "remove" ? { nativeMediaAuthorization: null } : mutate === "disable" ? { enabled: false }
      : { credential: "synthetic-replacement-key", nativeMediaAuthorization: "minimax-global-music" });
  });
  await denied(f, await f.request()); assert.equal(f.materializations, 1);
});
test("MiniMax music strict owner materialization rejects rotation between inspect and secret read", async t => {
  const f = await setup(t), old = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ credential: "synthetic-replacement-key", nativeMediaAuthorization: "minimax-global-music" });
  await assert.rejects(() => materializeGrantCredentials(f.env, grantKey, old, "minimax", null, false, undefined, "minimax.music"));
  assert.equal(f.sent.length, 0);
});
for (const warm of [false, true]) test(`MiniMax music unknown USD denies before materialization (${warm ? "warm" : "cold"})`, async t => {
  const f = await setup(t, { fixed: null });
  if (warm) { overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 60000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED)); const r = await f.request(); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, "pricing_required"); await f.drain(); }
  const r = await f.request(); assert.equal(r.status, 400, await r.clone().text()); assert.equal((await r.json()).error.code, "pricing_required"); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.materializations, 0);
});
test("MiniMax music discovery requires exact model and independent music authorization", async t => {
  const f = await setup(t, { qualify: false });
  const requirement = { provider: f.provider, endpoint: f.provider.endpoints[0], mode: "http", model: musicModel };
  assert.equal(grantSupports(requirement, await inspectGrantCredentials(f.env, grantKey)), false);
  const before = await (await f.call("/v1/catalog", null)).json();
  assert.equal(before.providers.find(row => row.id === "minimax").offers.some(row => row.eligible), false);
  await f.put({ nativeMediaAuthorization: "minimax-global-music" }); const grant = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(grantSupports(requirement, grant), true); assert.equal(grantSupports({ ...requirement, model: "foreign" }, grant), false);
  assert.deepEqual(routingProjection(grant).nativeMediaBinding, minimaxMusicBinding);
  const r = await f.call("/v1/catalog", null); assert.equal(r.status, 200); const catalog = await r.text();
  const offered = JSON.parse(catalog).providers.find(row => row.id === "minimax");
  assert.deepEqual(offered.routes.map(row => [row.endpoint, row.requestFormat, row.responseFormat]), [["music", "minimax.music", "minimax.music"]]);
  assert.equal(offered.offers.find(row => row.modelId === musicModel).eligible, true);
  assert.doesNotMatch(catalog, /nativeMediaBinding|credentialSource|synthetic-original-music-key/);
  await revokeGrantCredentials(f.env, grantKey);
  const revoked = await (await f.call("/v1/catalog", null)).json();
  assert.equal(revoked.providers.find(row => row.id === "minimax").offers.some(row => row.eligible), false);
});
test("MiniMax music capacity exhaustion is known-unsent and releases only its own lease", async t => {
  const f = await setup(t), other = new BodyLease(); assert.equal(other.grow(17 * 1024 * 1024), true); t.after(() => other.release());
  const r = await f.request(); assert.notEqual(r.status, 200); await r.text(); await f.drain(); assert.equal(f.sent.length, 0);
  assert.ok(bodyBudgetCharged() > 0); other.release(); assert.equal(bodyBudgetCharged(), 0);
});
for (const kind of ["partial", "bad-hex", "redirect", "provider-error"]) test(`MiniMax music ${kind} retains dispatched charge and never replays`, async t => {
  const f = await setup(t);
  f.upstream = () => kind === "redirect" ? new Response(null, { status: 302, headers: { location: "https://example.test/no-fetch" } })
    : kind === "provider-error" ? new Response(null, { status: 500 })
    : kind === "partial" ? new Response('{"data":', { headers: { "content-type": "application/json" } })
    : Response.json({ ...musicResult(), data: { status: 2, audio: "not hex" } });
  const r = await f.request(); assert.notEqual(r.status, 200); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
});
test("MiniMax music strict reader rejects extra fields without broadening speech authority", () => {
  assert.deepEqual(readNativeMediaBinding(minimaxMusicBinding), minimaxMusicBinding);
  assert.deepEqual(readNativeMediaBinding(minimaxSpeechBinding), minimaxSpeechBinding);
  for (const value of [null, { ...minimaxMusicBinding, extra: true }, { ...minimaxMusicBinding, operation: "minimax.images" }]) assert.equal(readNativeMediaBinding(value), null);
});
test("MiniMax music Worker refuses rotation after fresh inspect before exact materialization", async t => {
  const f = await setup(t), get = f.env.GRANT_CREDENTIALS.get; let once = false;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { async fetch(url, init) {
    const reply = await stub.fetch(url, init);
    if (new URL(url).pathname === "/inspect" && !once) { once = true; await f.put({ credential: "synthetic-replacement-key", nativeMediaAuthorization: "minimax-global-music" }); }
    return reply;
  } }; };
  await denied(f, await f.request()); assert.equal(once, true); assert.equal(f.materializations, 1);
});
test("MiniMax music warm admission cannot borrow replaced original authority or prefetch its secret", async t => {
  const f = await setup(t); overrideHotCacheConfig({ maxAgeMs: 60000, freshMs: 60000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const r = await f.request(); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
  f.sent.length = 0; f.materializations = 0;
  const owner = f.env.GRANT_CREDENTIALS.objects.get(grantKey), record = owner.values.get("credential");
  owner.values.set("credential", { ...record, credential: "synthetic-replacement-key", generation: record.generation + 1, lineage: "synthetic-new-lineage" });
  const deniedResponse = await f.request(); assert.notEqual(deniedResponse.status, 200); await deniedResponse.text(); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.materializations, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const model of musicModels) for (const manifest of [false, true]) for (const stream of [false, true])
  test(`MiniMax music ${model} ${manifest ? "manifest" : "native"} stream=${stream} exact original wire`, async t => {
    const f = await setup(t), upstream = model.slice("minimax/".length), body = musicBody(stream, upstream);
    f.policy.models = musicModels; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    f.upstream = async request => {
      assert.equal(request.url, "https://api.minimax.io/v1/music_generation");
      assert.equal(request.headers.get("authorization"), `Bearer ${originalKey}`);
      assert.deepEqual(await request.json(), body);
      return stream ? new Response(musicSse(upstream), { headers: { "content-type": "text/event-stream" } }) : Response.json(musicResult(upstream));
    };
    const r = await f.request(manifest, manifest ? { ...body, model } : body);
    assert.equal(r.status, 200, await r.clone().text());
    if (stream) { const text = await r.text(); assert.match(text, /"audio":"00ff80"/); assert.ok(text.endsWith("data: [DONE]\n\n")); }
    else assert.deepEqual(await r.json(), musicResult(upstream));
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
    const [event] = await f.events(); assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "policy_fixed");
    assert.equal(event.total_tokens, null);
  });
test("MiniMax music binding never makes speech eligible, and image authority never supplies music", async t => {
  const f = await setup(t), grant = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(grantSupports({ provider: f.provider, endpoint: { ...f.provider.endpoints[0], request_format: "minimax.speech" }, mode: "http" }, grant), false);
  await f.put({ nativeMediaAuthorization: null, minimaxImageAuthorization: "minimax-global-image" });
  await denied(f, await f.request());
});
for (const renewal of [false, true]) test(`MiniMax music explicit environment fingerprint renewal=${renewal}`, async t => {
  const f = await setup(t, { environment: true });
  f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...minimaxMusicBinding, credentialSource: "MINIMAX_API_KEY", credentialSha256: await sha256Hex(f.env.MINIMAX_API_KEY) });
  f.env.MINIMAX_API_KEY = "synthetic-rotated-environment-key";
  if (renewal) f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...minimaxMusicBinding, credentialSource: "MINIMAX_API_KEY", credentialSha256: await sha256Hex(f.env.MINIMAX_API_KEY) });
  const catalog = await (await f.call("/v1/catalog", null)).json();
  assert.equal(catalog.providers.find(row => row.id === "minimax").offers.some(row => row.eligible), renewal);
  const r = await f.request();
  if (!renewal) await denied(f, r);
  else { assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-rotated-environment-key"); }
});
test("MiniMax music selected grant cannot borrow a valid environment binding after revocation", async t => {
  const f = await setup(t);
  f.env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = JSON.stringify({ ...minimaxMusicBinding, credentialSource: "MINIMAX_API_KEY", credentialSha256: await sha256Hex(f.env.MINIMAX_API_KEY) });
  f.afterBudget(() => revokeGrantCredentials(f.env, grantKey));
  await denied(f, await f.request());
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
for (const stream of [false, true]) for (const failedCleanup of [false, true])
  test(`MiniMax music prompt abort joins read and FIRST cleanup stream=${stream} rejected=${failedCleanup}`, async t => {
    const f = await setup(t), reading = deferred(), cleanup = deferred(), entered = deferred(), controller = new AbortController();
    let cancels = 0, pulls = 0, source;
    f.upstream = () => {
      source = new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode(stream ? "data: {" : "{")); } }, { highWaterMark: 0 });
      const getReader = source.getReader.bind(source);
      source.getReader = options => {
        const reader = getReader(options);
        return { async read(...args) { try { return await reader.read(...args); } finally { entered.resolve(); await reading.promise; } },
          async cancel(reason) { cancels++; await reader.cancel(reason); await cleanup.promise; if (failedCleanup) throw new Error("synthetic cleanup rejection"); },
          releaseLock() { reader.releaseLock(); } };
      };
      return new Response(source, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    };
    const request = f.request(false, musicBody(stream), { signal: controller.signal });
    await entered.promise; controller.abort(new DOMException("synthetic cancellation", "AbortError"));
    const r = await request; assert.notEqual(r.status, 200); await r.text(); await turn();
    assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); assert.equal(source.locked, true); assert.equal(cancels, 1);
    const other = new BodyLease(); assert.equal(other.grow(17 * 1024 * 1024), false); other.release();
    cleanup.resolve(); await turn();
    assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); assert.equal(source.locked, true);
    reading.resolve(); await f.drain(); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
    assert.equal(cancels, 1); assert.equal(pulls, 1); assert.equal(f.sent.length, 1);
    const [event] = await f.events(); assert.equal(event.actual_cost_micros, 700);
  });

for (const fixed of [0, 17]) test(`MiniMax music explicit fixed policy ${fixed} never uses a token tariff`, async t => {
  const f = await setup(t, { fixed }); const response = await f.request();
  assert.equal(response.status, 200, await response.clone().text()); await response.text(); await f.drain();
  const [event] = await f.events(); assert.equal(f.sent.length, 1); assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.actual_cost_micros, fixed); assert.equal(event.total_tokens, null);
});
