import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { default: worker } = await import("../index.ts");
const { parseCodexModels } = await import("../codex-models.ts");
const { clearHotCaches, setHotCacheClock } = await import("../hot-cache.ts");
const { sha256Hex } = await import("../utils.ts");

const descriptor = { slug: "gpt-6-sol", base_instructions: "Synthetic instructions.\n", context_window: 1000,
  service_tiers: [{ id: "priority", name: "Fast" }, { id: "unpriced", name: "Unpriced" }], additional_speed_tiers: ["fast", "unpriced"],
  default_service_tier: "unpriced", available_access_programs: { cyber: ["standard", "daybreak_blue"] },
  model_messages: { instructions_template: "Synthetic {{ tools }}", future_tool: { keep: true } }, future_metadata: { keep: true } };
const metadata = () => ({ models: [descriptor, { ...descriptor, slug: "unregistered-model" }], future_wrapper: { keep: true } });

async function fixture(t) {
  const secret = "synthetic-codex-catalog-secret";
  const policy = { enabled: true, generation: "fixture-g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: null,
    requestCostMicros: 1, requestCostsMicros: { "search.web": 1000 }, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: policy.generation };
  const connection = { providerId: "openai", enabled: true, monthlyBudgetMicros: null };
  const state = { upstream: [], body: metadata(), status: 200, headers: { "content-type": "application/json" }, pool: [], grant: null, principal: null, kid: "fixture" };
  const env = {
    OPENAI_API_KEY: "synthetic-upstream-not-real",
    POLICY_KV: { get: async (key, type) => {
      const value = item => state.pool.includes(item) ? state.grant : null;
      if (Array.isArray(key)) return new Map(key.map(item => [item, value(item)]));
      const grant = value(key);
      return grant && type === "stream" ? new Response(JSON.stringify(grant)).body : grant;
    } },
    GRANT_CREDENTIALS: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ grant: { ...state.grant, credential: "synthetic-selected-grant-key" } }) }) },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/admission/resolve") return Response.json({ credential: { credentialId: state.kid, credential }, policy: { policyId: "fixture", policy }, owner: state.principal ? { email: state.principal, enabled: true } : null, connections: [connection], pools: { openai: { keys: state.pool, states: Object.fromEntries(state.pool.map(key => [key, { grant: state.grant }])) } } });
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: state.kid, credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: state.pool, states: {} });
      if (path === "/grant-pools/attachment") return Response.json({ attached: false, pending: false });
      throw new Error(`unexpected authority call: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    state.upstream.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect });
    if (state.respond) return state.respond(url, init);
    return new Response(typeof state.body === "string" ? state.body : JSON.stringify(state.body), { status: state.status, headers: state.headers });
  });
  const get = (query = "client_version=0.169.0", headers = {}, signal) => worker.fetch(new Request(`https://router.example/v1/codex/models?${query}`, {
    headers: { authorization: `Bearer clawrouter-live-${state.kid}-${secret}`, ...headers }, signal,
  }), env, { waitUntil() {} });
  return { get, env, state, policy, credential, connection };
}

test("Codex metadata uses inference environment auth, fixed destination and exact client version; preserves programs and filters models/tiers", async t => {
  const f = await fixture(t);
  const response = await f.get();
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("cache-control"), /no-store/);
  const body = await response.json();
  assert.deepEqual(body.models.map(model => model.slug), ["gpt-6-sol"]);
  assert.deepEqual(body.future_wrapper, { keep: true });
  const model = body.models[0];
  for (const field of ["base_instructions", "model_messages", "available_access_programs", "future_metadata"]) assert.deepEqual(model[field], descriptor[field]);
  assert.deepEqual(model.service_tiers.map(tier => tier.id), ["priority"]);
  assert.equal(model.default_service_tier, null);
  assert.deepEqual(model.additional_speed_tiers, ["fast"]);
  assert.deepEqual(f.state.upstream, [{ url: "https://chatgpt.com/backend-api/codex/models?client_version=0.169.0", headers: { authorization: "Bearer synthetic-upstream-not-real", accept: "application/json" }, redirect: "manual" }]);
  assert.ok(!JSON.stringify(body).includes("synthetic-upstream"));
});

test("unauthorized callers, invalid versions and unsupported query parameters never fetch metadata", async t => {
  const f = await fixture(t);
  assert.equal((await f.get("client_version=0.169.0", { authorization: "Bearer invalid" })).status, 401);
  for (const query of ["", "client_version=0.169.0-alpha", "client_version=0.169.0&client_version=0.170.0", "client_version=https://evil.example", "client_version=0.169.0&url=https://evil.example", "client_version=0.169.0&standalone_search=false"]) assert.equal((await f.get(query)).status, 400, query);
  assert.equal(f.state.upstream.length, 0);
});

test("private cache separates client versions and rotated environment credentials; bounded stale fallback never refreshes its age", async t => {
  const f = await fixture(t);
  let now = Date.now(); setHotCacheClock(() => now);
  assert.equal((await f.get()).status, 200);
  assert.equal((await f.get()).status, 200);
  assert.equal(f.state.upstream.length, 1);
  assert.equal((await f.get("client_version=0.170.0")).status, 200);
  f.env.OPENAI_API_KEY = "synthetic-rotated-upstream";
  assert.equal((await f.get()).status, 200);
  assert.equal(f.state.upstream.length, 3);
  assert.equal(f.state.upstream.at(-1).headers.authorization, "Bearer synthetic-rotated-upstream");
  f.state.status = 503;
  now += 11_000;
  assert.equal((await f.get()).status, 200);
  now += 49_001;
  assert.equal((await f.get()).status, 502);
});

test("upstream auth rejection and invalid metadata evict the previous generation, never masking it with stale metadata", async t => {
  for (const failure of [401, 403, 302, "malformed", "duplicate"]) {
    clearHotCaches();
    const f = await fixture(t);
    let now = Date.now(); setHotCacheClock(() => now);
    assert.equal((await f.get()).status, 200);
    now += 11_000;
    if (typeof failure === "number") f.state.status = failure;
    else f.state.body = failure === "malformed" ? "invalid json" : { models: [descriptor, descriptor] };
    const failed = await f.get();
    assert.equal(failed.status, 502, String(failure));
    assert.equal((await failed.json()).error.code, "codex_catalog_unavailable");
    f.state.status = 503;
    assert.equal((await f.get()).status, 502);
    t.mock.restoreAll();
  }
});

test("upstream cache controls and local max age constrain freshness and stale fallback", async t => {
  for (const control of ["no-store", "private, no-cache", "max-age=0", "max-age=60, must-revalidate", "max-age=5"]) {
    clearHotCaches();
    const f = await fixture(t);
    let now = Date.now(); setHotCacheClock(() => now);
    f.state.headers["cache-control"] = control;
    assert.equal((await f.get()).status, 200);
    now += 6000; f.state.status = 503;
    assert.equal((await f.get()).status, 502, control);
    t.mock.restoreAll();
  }
  clearHotCaches();
  const f = await fixture(t); f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = "0";
  assert.equal((await f.get()).status, 200);
  f.state.status = 503;
  assert.equal((await f.get()).status, 502);
});

test("budget, connection, policy and revocation restrictions are reapplied before serving catalog data", async t => {
  for (const mutate of [f => { f.credential.enabled = false; }, f => { f.policy.models = ["openai/other"]; }, f => { f.connection.enabled = false; }, f => { f.policy.providers = ["anthropic"]; }]) {
    clearHotCaches();
    const f = await fixture(t);
    let now = Date.now(); setHotCacheClock(() => now);
    assert.equal((await f.get()).status, 200);
    mutate(f); now += 60_001;
    const response = await f.get();
    assert.ok(response.status >= 400, await response.text());
    t.mock.restoreAll();
  }
});

test("multi-account membership is rejected instead of claiming a selected account's programs apply to a pool", async t => {
  const f = await fixture(t);
  // Membership can change independently of the cached admission. Qualification
  // rereads membership and must reject a previously environment-backed account.
  assert.equal((await f.get()).status, 200);
  f.state.pool = ["other-a", "other-b"];
  const response = await f.get();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "catalog_account_unqualified");
  assert.equal(f.state.upstream.length, 1);
});

test("oversize and stalled bodies are canceled and cannot poison the fallback", async t => {
  const f = await fixture(t);
  let canceled = false;
  f.state.respond = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  assert.equal((await f.get()).status, 502);
  assert.equal(canceled, true);
  canceled = false;
  f.state.respond = () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  const controller = new AbortController();
  const pending = f.get(undefined, {}, controller.signal);
  // Wait until the mocked upstream owns the response before canceling.
  while (f.state.upstream.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(canceled, true);
});

test("descriptor validation rejects bad structure without restricting unknown program fields", () => {
  assert.deepEqual(parseCodexModels(JSON.stringify(metadata())).models[0].available_access_programs, descriptor.available_access_programs);
  for (const body of [{}, { models: [] }, { models: [null] }, { models: [{ ...descriptor, slug: "" }] }, { models: [{ ...descriptor, service_tiers: [{}] }] }, { models: [{ ...descriptor, additional_speed_tiers: [42] }] }, { models: [{ ...descriptor, base_instructions: 42 }] }]) assert.throws(() => parseCodexModels(JSON.stringify(body)));
});

test("separate gateway callers cannot consume one another's metadata cache", async t => {
  const f = await fixture(t);
  assert.equal((await f.get()).status, 200);
  f.state.kid = "second";
  f.state.body.models[0] = { ...descriptor, available_access_programs: { cyber: ["standard"] } };
  const second = await f.get();
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).models[0].available_access_programs, { cyber: ["standard"] });
  assert.equal(f.state.upstream.length, 2);
  f.state.kid = "fixture";
  assert.deepEqual((await (await f.get()).json()).models[0].available_access_programs, descriptor.available_access_programs);
  assert.equal(f.state.upstream.length, 2);
});

test("metadata fetch and body deadlines retire even when the upstream ignores abort", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.state.respond = () => new Promise(() => {});
  const pending = f.get();
  while (!f.state.upstream.length) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15_001);
  assert.equal((await pending).status, 502);
  clearHotCaches();
  let canceled = false;
  f.state.respond = () => new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }), { headers: { "content-type": "application/json" } });
  const bodyPending = f.get();
  while (f.state.upstream.length < 2) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15_001);
  assert.equal((await bodyPending).status, 502);
  assert.equal(canceled, true);
});

test("search-scoped metadata returns only eligible Lite models and never forwards gateway query switches upstream", async t => {
  const f = await fixture(t);
  f.state.body.models[0] = { ...descriptor, use_responses_lite: true };
  const response = await f.get("standalone_search=true&client_version=0.169.0");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).models.map(model => model.slug), ["gpt-6-sol"]);
  assert.equal(new URL(f.state.upstream[0].url).search, "?client_version=0.169.0");
});

test("one configured public API grant supplies metadata auth instead of the environment fallback", async t => {
  const f = await fixture(t);
  f.state.pool = ["oauth/fixture/account"];
  f.state.grant = { provider: "openai", kind: "api_key", enabled: true, hasCredential: true, credentialStore: "durable_object", credentialGeneration: 1, credentialLineage: "synthetic-lineage-fixture" };
  const response = await f.get();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.state.upstream[0].headers.authorization, "Bearer synthetic-selected-grant-key");
  f.policy.grantRouting = { environmentFallback: true }; clearHotCaches();
  const ambiguous = await f.get();
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).error.code, "catalog_account_unqualified");
});
