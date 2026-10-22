import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const now = Date.parse("2030-01-01T00:00:00Z"), iso = value => new Date(value).toISOString();
const key = id => `oauth/fixture/${id}`;
// Actual Worker admission, SQL pool authority, credential owners, probes and
// dispatch feedback. Only provider egress and time are controlled; no selection
// or quota methods are replaced and no runtime rows are injected.
const router = `
  import worker from "./worker/index.ts";
  export * from "./worker/index.ts";
  import { sha256Hex } from "./worker/utils.ts";
  let clock = ${now}; Date.now = () => clock; const pending = new Set();
  export default { ...worker, async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled";
    env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    env.ANTHROPIC_API_KEY = "fixture-environment";
    const path = new URL(request.url).pathname;
    if (path === "/fixture/settle") { while (pending.size) await Promise.all([...pending]); return new Response("ok"); }
    if (path === "/fixture/clock") { clock = (await request.json()).now; return new Response("ok"); }
    if (path === "/fixture/provider") return fetch("https://fixture/control", request);
    if (path === "/fixture/policy") {
      const routing = await request.json(), owner = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
      for (const [route, body] of [
        ["/policies/put", { policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "fixture", monthlyBudgetMicros: 10000000, retainRequestContent: false, grantRouting: routing } }],
        ["/credentials/initialize-all", ["client", "other"].map(id => ({ credentialId: id, credential: { enabled: true, secretSha256: "", policyId: "fixture", policyGeneration: "g1" } }))],
        ["/connections/initialize-all", [{ providerId: "anthropic", enabled: true, monthlyBudgetMicros: 10000000 }]],
      ]) {
        if (route === "/credentials/initialize-all") for (const row of body) row.credential.secretSha256 = await sha256Hex("fixture-key");
        const response = await owner.fetch("https://authority" + route, { method: "POST", body: JSON.stringify(body) }); if (!response.ok) return response;
      }
      return new Response("ok");
    }
    return worker.fetch(request, env, { waitUntil(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); ctx.waitUntil(promise); }, passThroughOnException: () => ctx.passThroughOnException() });
  }};
`;
const upstream = `
  let config = {}, dispatches = [];
  export default { async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/control") { if (request.method === "POST") config = await request.json(); return Response.json({ dispatches }); }
    if (path.endsWith("/token")) return new Response("fixture-ambiguous-refresh");
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? request.headers.get("x-api-key");
    const id = token?.replace("fixture-", "");
    if (path.endsWith("/usage")) return Response.json(config.usage ?? {});
    if (path.endsWith("/profile")) return Response.json({});
    const selectedGrantKey = id === "environment" ? null : "oauth/fixture/" + id;
    dispatches.push(selectedGrantKey);
    const outcome = config[id] ?? {}, status = outcome.status ?? 200;
    if (status !== 200) return Response.json({ error: { type: "fixture_rejection", message: "synthetic upstream rejection" } }, { status, headers: outcome.headers });
    return Response.json({ id: "msg_fixture_" + dispatches.length, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "synthetic" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, selectedGrantKey }, { headers: outcome.headers });
  }};
`;
const routing = { strategy: "threshold", switchAtUsedPercent: 90, hysteresisPercent: 10, environmentFallback: false, failover: true };
async function fixture(t, policy = routing) {
  const directory = await mkdtemp(join(tmpdir(), "clawrouter-limit-switching-"));
  let mf;
  t.after(async () => { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); });
  mf = await startWorkerdFixture(directory, router, upstream);
  const request = async (path, method = "GET", body, headers = {}) => {
    const response = await mf.dispatchFetch("https://router.example" + path, { method, headers: { authorization: "Bearer fixture-admin", origin: "https://router.example", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Complete delivery, then join the real waitUntil feedback/accounting tasks.
    // No sleeps or assumed race ordering between one response and the next.
    await response.clone().arrayBuffer();
    const settled = await mf.dispatchFetch("https://router.example/fixture/settle");
    assert.equal(settled.status, 200, await settled.text());
    return response;
  };
  const ok = async response => { assert.equal(response.status, 200, await response.clone().text()); return response; };
  const setPolicy = async value => ok(await request("/fixture/policy", "POST", value));
  await setPolicy(policy);
  const base = "/v1/admin/upstream-grants/policies/fixture/";
  for (const id of ["a", "b", "c"]) await ok(await request(base + id, "PUT", { provider: "anthropic", kind: "subscription", accessToken: "fixture-" + id, ...(id === "a" ? { refreshToken: "fixture-refresh-a", expiresAt: iso(now + 7200000) } : {}), maintenance: { keepWarm: false } }));
  const configure = async value => ok(await request("/fixture/provider", "POST", value));
  const proxy = (model = "claude-sonnet-5", session = "session-one", client = "client") => request("/v1/messages", "POST", { model: "anthropic/" + model, max_tokens: 16, messages: [{ role: "user", content: "synthetic fixture" }] }, { authorization: `Bearer clawrouter-live-${client}-fixture-key`, "x-clawrouter-session-id": session });
  const rows = async () => (await (await ok(await request("/v1/admin/upstream-grants"))).json()).grants;
  const observe = async (id, used, window = "5h") => {
    await setPolicy({ ...policy, eligibleGrants: { anthropic: [id] } });
    await configure({ [id]: { headers: { [`anthropic-ratelimit-unified-${window}-utilization`]: String(used / 100), [`anthropic-ratelimit-unified-${window}-reset`]: iso(now + 3600000) } } });
    await selected(await proxy(), id); await configure({}); await setPolicy(policy);
  };
  return { request, base, proxy, configure, setPolicy, observe, rows,
    stats: async () => (await (await request("/fixture/provider")).json()).dispatches,
    clock: async value => ok(await request("/fixture/clock", "POST", { now: value })),
    probe: async usage => { await configure({ usage }); await ok(await request(base + "a/quota-refresh", "POST")); await configure({}); },
    risk: async () => { const response = await request(base + "a/refresh", "POST"); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "grant_refresh_failed"); },
  };
}
async function selected(response, id) { assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).selectedGrantKey, id === null ? null : key(id)); }
async function unavailable(response) { assert.equal(response.status, 503, await response.clone().text()); assert.equal(response.headers.get("x-clawrouter-error-code"), "upstream_grant_pool_unavailable"); await response.text(); }

// A refreshable login and B/C access-only setup tokens exercise the composed
// lifecycle without depending on provider logins or any production state.
test("three-account composition switches at limit, survives cooldown and refresh risk, then readmits reset account", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const grants = await f.rows();
  assert.deepEqual(grants.map(g => [g.tokenRef, g.hasRefreshToken]), [["a", true], ["b", false], ["c", false]]);
  await f.observe("c", 40); await f.observe("b", 20); await f.observe("a", 89);
  await selected(await f.proxy(), "a");
  await f.observe("a", 90); await selected(await f.proxy(), "b");
  await f.configure({ b: { status: 429, headers: { "retry-after": "60" } } });
  const failover = await f.proxy(); assert.equal(failover.headers.get("x-clawrouter-grant-failover"), "1"); await selected(failover, "c");
  assert.deepEqual((await f.stats()).slice(-2), [key("b"), key("c")]);
  assert.equal((await f.rows()).find(g => g.tokenRef === "b").cooldownUntil, iso(now + 60000));
  await f.configure({}); await f.risk();
  assert.equal((await f.rows()).find(g => g.tokenRef === "a").usable, false);
  await selected(await f.proxy(), "c");
  await f.clock(now + 59999); await selected(await f.proxy(), "c");
  await f.clock(now + 60000);
  await f.configure({ c: { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.90", "anthropic-ratelimit-unified-5h-reset": iso(now + 3600000) } } });
  await selected(await f.proxy(), "c"); await f.configure({});
  await selected(await f.proxy(), "b");
  assert.equal((await f.rows()).find(g => g.tokenRef === "b").cooldownUntil, null);
  // Exhaustion keeps B/C out until reset; then authentication rejections leave
  // no known recovery. Timed all-cooling pools intentionally return 429 instead.
  await f.observe("b", 100); await f.observe("c", 100);
  await f.clock(now + 3600000);
  for (const id of ["b", "c"]) {
    await f.setPolicy({ ...routing, eligibleGrants: { anthropic: [id] } });
    await f.configure({ [id]: { status: 403 } }); assert.equal((await f.proxy()).status, 403);
  }
  await f.setPolicy(routing); await f.configure({});
  const before = (await f.stats()).length; await unavailable(await f.proxy()); assert.equal((await f.stats()).length, before);
});

test("threshold 90/10 hysteresis keeps the active account and will not flap to an 81%-used alternate", { timeout: 60000 }, async t => {
  const f = await fixture(t, { ...routing, eligibleGrants: { anthropic: ["a", "b"] } });
  await f.observe("b", 20); await f.observe("a", 89); await selected(await f.proxy(), "a");
  await f.observe("a", 90); await selected(await f.proxy(), "b");
  await f.observe("a", 81); await selected(await f.proxy(), "a"); // forced observation leaves A active
  await f.observe("b", 90); await selected(await f.proxy(), "b"); // 19% vs10% fails the10-point hysteresis
  await f.probe({ five_hour: { utilization: 79, resets_at: iso(now + 3600000) } });
  await selected(await f.proxy(), "a");
  await selected(await f.proxy(), "a");
});

test("most_remaining chooses the highest headroom, not the previous or first grant", { timeout: 60000 }, async t => {
  const f = await fixture(t, { ...routing, strategy: "most_remaining" });
  await f.observe("a", 50); await f.observe("b", 10); await f.observe("c", 30);
  await selected(await f.proxy(), "b");
  await f.observe("b", 80); await selected(await f.proxy(), "c");
});

for (const window of ["five_hour", "seven_day", "fable"]) test(`real provider ${window} exhaustion routes only affected requests elsewhere`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { ...routing, strategy: "priority" });
  const usage = window === "fable" ? { limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100 }] } : { [window]: { utilization: 100 } };
  await f.probe(usage);
  await selected(await f.proxy(window === "fable" ? "claude-fable-5-1" : "claude-sonnet-5"), "b");
  if (window === "fable") await selected(await f.proxy("claude-sonnet-5"), "a");
});

for (const status of [401, 403, 429]) test(`real post-dispatch ${status} retries once on another setup token and avoids the cooled owner next request`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { ...routing, strategy: "priority", eligibleGrants: { anthropic: ["b", "c"] } });
  await f.configure({ b: { status, headers: { "retry-after": "60" } } });
  const response = await f.proxy(); assert.equal(response.headers.get("x-clawrouter-grant-failover"), "1"); await selected(response, "c");
  await selected(await f.proxy(), "c"); assert.deepEqual(await f.stats(), [key("b"), key("c"), key("c")]);
});

test("subscription reserve stops before extra usage even if paid overage is enabled", { timeout: 60000 }, async t => {
  const policy = { ...routing, strategy: "priority", includedQuotaReservePercent: 15 };
  const f = await fixture(t, policy);
  await f.probe({ five_hour: { utilization: 84 }, extra_usage: { is_enabled: true, used_credits: 1, monthly_limit: 100 } });
  await selected(await f.proxy(), "a");
  await f.probe({ five_hour: { utilization: 85 }, extra_usage: { is_enabled: true, used_credits: 1, monthly_limit: 100 } });
  await selected(await f.proxy(), "b");
  await f.setPolicy({ ...policy, includedQuotaReservePercent: 14 }); await selected(await f.proxy(), "a");
  await f.probe({ five_hour: { utilization: 100 }, extra_usage: { is_enabled: true, spend_limit_reached: false } });
  await selected(await f.proxy(), "b");
});

for (const stickiness of ["identity", "session"]) test(`real ${stickiness} stickiness is stable but never overrides eligibility`, { timeout: 60000 }, async t => {
  const policy = { ...routing, strategy: "round_robin", stickiness };
  const f = await fixture(t, policy);
  const response = await f.proxy(); assert.equal(response.status, 200); const chosen = (await response.json()).selectedGrantKey.split("/").at(-1);
  for (let n = 0; n < 3; n++) await selected(await f.proxy("claude-sonnet-5", stickiness === "identity" ? "another-session" : "session-one", stickiness === "session" ? "other" : "client"), chosen);
  const remaining = ["a", "b", "c"].filter(id => id !== chosen);
  await f.setPolicy({ ...policy, eligibleGrants: { anthropic: [remaining[0]] } });
  await selected(await f.proxy(), remaining[0]);
});

test("eligibleGrants scopes every dispatch and environment fallback remains explicit", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.setPolicy({ ...routing, eligibleGrants: { anthropic: ["b"] } }); await selected(await f.proxy(), "b");
  await f.setPolicy({ ...routing, eligibleGrants: { anthropic: [] } }); await unavailable(await f.proxy());
  await f.setPolicy({ ...routing, eligibleGrants: { anthropic: [] }, environmentFallback: true });
  const response = await f.proxy(); assert.equal(response.headers.get("x-clawrouter-grant-lane"), "environment"); await selected(response, null);
  assert.deepEqual(await f.stats(), [key("b"), null]);
});
