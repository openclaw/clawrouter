import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const now = Date.parse("2030-01-01T00:00:00Z");
const iso = ms => new Date(ms).toISOString();
// Real worker, authority and SQLite credential owners; only clock and provider
// egress are controlled. The synthetic manifest enables the generic OAuth path.
const router = `
  export * from "./worker/index.ts";
  import handler from "./worker/index.ts";
  import { sha256Hex } from "./worker/utils.ts";
  import { providerById } from "./worker/providers.ts";
  Date.now = () => ${now};
  providerById("anthropic").auth.authorization = {
    authorizeUrl: "https://fixture/authorize", tokenUrl: "https://fixture/token", clientId: "fixture-client", grantKind: "subscription",
    scopes: ["inference"], extraAuthorizeParams: {}, extraTokenParams: {}, accountIdJsonPointer: null, subscriptionPlanJsonPointer: null
  };
  export default { async fetch(request, env, ctx) {
    env.CLAWROUTER_LOCAL_AUTH = "enabled";
    env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("fixture-admin");
    if (new URL(request.url).pathname === "/fixture/provider") return fetch("https://fixture/control", request);
    return handler.fetch(request, env, ctx);
  } };
`;
const upstream = `
  let config = {}, rotations = 0;
  export default { async fetch(request) {
    if (new URL(request.url).pathname === "/control") { config = await request.json(); return Response.json({}); }
    const body = request.headers.get("content-type")?.includes("json") ? await request.json() : Object.fromEntries(await request.formData());
    if (!["authorization_code", "refresh_token"].includes(body.grant_type)) return new Response(null, {status: 404});
    rotations++;
    return Response.json({ access_token: "fixture-access-" + rotations, refresh_token: "fixture-refresh-" + rotations, expires_in: 3600, ...config });
  } };
`;
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-expiry-"));
  let mf = await startWorkerdFixture(temporary, router, upstream, { persistencePath: join(temporary, "state") });
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const request = (path, method = "GET", body, headers = {}) => mf.dispatchFetch(`https://router.example${path}`, { method, headers: { authorization: "Bearer fixture-admin", "content-type": "application/json", origin: "https://router.example", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const base = "/v1/admin/upstream-grants/policies/pool/claude";
  const grant = { provider: "anthropic", kind: "subscription", accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: "2099-01-01T00:00:00Z", maintenance: { keepWarm: false } };
  const put = async (fields = {}, replace = false) => {
    const response = await request(base + (replace ? "?mode=replace" : ""), "PUT", { ...grant, ...fields });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const row = async () => {
    const response = await request("/v1/admin/upstream-grants");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /fixture-access|fixture-refresh/);
    return JSON.parse(text).grants.find(grant => grant.tokenRef === "claude");
  };
  const rotate = async payload => {
    await request("/fixture/provider", "POST", payload);
    const response = await request(`${base}/refresh`, "POST");
    assert.equal(response.status, 200, await response.clone().text());
    return row();
  };
  const login = async payload => {
    await request("/fixture/provider", "POST", payload);
    const response = await request("/v1/session/login", "POST", { token: "fixture-admin" });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const started = await request(`${base}/authorize`, "POST", { provider: "anthropic" }, { cookie });
    assert.equal(started.status, 200, await started.clone().text());
    const state = new URL((await started.json()).authorizationUrl).searchParams.get("state");
    const callback = await request(`/v1/oauth/callback?state=${state}&code=fixture-code`, "GET", undefined, { cookie });
    assert.equal(callback.status, 200, await callback.clone().text());
    return row();
  };
  return { put, row, rotate, login, request, base, restart: async () => { await mf.dispose(); mf = await startWorkerdFixture(temporary, router, upstream, { persistencePath: join(temporary, "state") }); } };
}

test("workerd OAuth exchange persists provider refresh expiry and original manual authorization", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const row = await f.login({ refresh_token_expires_in: 86400 });
  assert.equal(row.refreshTokenExpiresAt, iso(now + 86400000));
  assert.equal(row.lastManualAuthorizationAt, iso(now));
  assert.equal(row.refreshExpiryWarning, "warning");
  const refreshed = await f.rotate({});
  assert.equal(refreshed.refreshTokenExpiresAt, row.refreshTokenExpiresAt);
  assert.equal(refreshed.lastManualAuthorizationAt, row.lastManualAuthorizationAt);
});

test("workerd imported expiry survives omitted rotation metadata and restart; explicit lifetime replaces it", { timeout: 60000 }, async t => {
  const f = await fixture(t), expiry = iso(now + 86400000), manual = iso(now - 25 * 86400000);
  await f.put({ refreshTokenExpiresAt: Date.parse(expiry), lastManualAuthorizationAt: manual });
  assert.equal((await f.row()).refreshTokenExpiresAt, expiry);
  assert.equal((await f.rotate({})).refreshTokenExpiresAt, expiry);
  await f.restart();
  assert.equal((await f.row()).refreshTokenExpiresAt, expiry);
  const rotated = await f.rotate({ refresh_token_expires_in: 10 * 86400 });
  assert.equal(rotated.refreshTokenExpiresAt, iso(now + 10 * 86400000));
  assert.equal(rotated.lastManualAuthorizationAt, manual);
});

test("workerd unknown lifetimes remain explicitly unknown without false warnings or invented login dates", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.put();
  const row = await f.rotate({});
  assert.equal(row.refreshTokenExpiresAt, null);
  assert.equal(row.lastManualAuthorizationAt, null);
  assert.equal(row.refreshExpiryWarning, "unknown");
  const login = await f.login({});
  assert.equal(login.refreshTokenExpiresAt, null);
  assert.equal(login.lastManualAuthorizationAt, iso(now));
  assert.equal(login.refreshExpiryWarning, "unknown");
});

for (const [remaining, warning] of [[3 * 86400000 + 1, "none"], [3 * 86400000, "warning"], [12 * 3600000 + 1, "warning"], [12 * 3600000, "critical"], [0, "expired"]]) {
  test(`workerd refresh deadline ${remaining}ms produces ${warning} without revoking the grant`, { timeout: 60000 }, async t => {
    const f = await fixture(t);
    await f.put({ refreshTokenExpiresAt: iso(now + remaining) });
    const row = await f.row();
    assert.equal(row.refreshExpiryWarning, warning);
    assert.equal(row.usable, true);
    assert.equal(row.credentialStatus, "active");
  });
}

test("workerd replacement cannot inherit the prior authorization deadline or login date", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.put({ refreshTokenExpiresAt: iso(now + 1000), lastManualAuthorizationAt: iso(now - 86400000) });
  await f.put({}, true);
  assert.equal((await f.row()).refreshTokenExpiresAt, null);
  assert.equal((await f.row()).lastManualAuthorizationAt, null);
});

for (const lifetime of [-1, 1.5, "86400", 1e20, null]) test(`workerd invalid provider lifetime ${JSON.stringify(lifetime)} never extends a known session`, { timeout: 60000 }, async t => {
  const f = await fixture(t), expiry = iso(now + 86400000);
  await f.put({ refreshTokenExpiresAt: expiry });
  assert.equal((await f.rotate({ refresh_token_expires_in: lifetime })).refreshTokenExpiresAt, expiry);
  // A replacement login has a fresh refresh token; never replay the spent import.
  await f.put({ refreshToken: "fixture-refresh-fresh-login" }, true);
  assert.equal((await f.rotate({ refresh_token_expires_in: lifetime })).refreshTokenExpiresAt, null);
});

test("workerd zero provider lifetime is an expired deadline, not unknown", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.put();
  const row = await f.rotate({ refresh_token_expires_in: 0 });
  assert.equal(row.refreshTokenExpiresAt, iso(now));
  assert.equal(row.refreshExpiryWarning, "expired");
});

test("workerd metadata edit preserves owner dates; replacing credentials clears unspecified dates", { timeout: 60000 }, async t => {
  const f = await fixture(t), expiry = iso(now + 86400000), manual = iso(now - 86400000);
  await f.put({ refreshTokenExpiresAt: expiry, lastManualAuthorizationAt: manual });
  await f.rotate({ refresh_token_expires_in: 7200 });
  const edited = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", label: "Renamed" });
  assert.equal(edited.status, 200);
  assert.equal((await f.row()).refreshTokenExpiresAt, iso(now + 7200000));
  assert.equal((await f.row()).lastManualAuthorizationAt, manual);
  await f.put({ accessToken: "fixture-access-new", refreshToken: "fixture-refresh-new" });
  assert.equal((await f.row()).refreshTokenExpiresAt, null);
  assert.equal((await f.row()).lastManualAuthorizationAt, null);
});

test("workerd fresh OAuth authorization clears the previous login deadline when omitted", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.put({ refreshTokenExpiresAt: iso(now + 1000), lastManualAuthorizationAt: iso(now - 86400000) });
  const row = await f.login({});
  assert.equal(row.refreshTokenExpiresAt, null);
  assert.equal(row.lastManualAuthorizationAt, iso(now));
});

test("workerd ticket imports Claude Code epoch-millisecond expiry without inventing manual authorization", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/admin/policies/pool", "PUT", { enabled: true, providers: ["anthropic"] })).status, 200);
  const issued = await f.request("/v1/admin/pool-submission-tickets", "POST", { scope: "policies", scopeId: "pool", tokenRef: "claude", provider: "anthropic", kind: "subscription", keepWarm: false });
  assert.equal(issued.status, 201);
  const ticket = await issued.json();
  const consumed = await f.request(ticket.submissionUrl, "POST", { accessToken: "fixture-access", refreshToken: "fixture-refresh", refreshTokenExpiresAt: now + 86400000 }, { authorization: `Bearer ${ticket.ticketToken}` });
  assert.equal(consumed.status, 201, await consumed.clone().text());
  const row = await f.row();
  assert.equal(row.refreshTokenExpiresAt, iso(now + 86400000));
  assert.equal(row.lastManualAuthorizationAt, null);
  assert.equal(row.refreshExpiryWarning, "warning");
});

for (const value of ["fixture-refresh", {}, -1, 1e20]) test(`workerd malformed imported date ${JSON.stringify(value)} is rejected without echoing input`, { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const response = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", accessToken: "fixture-access", refreshTokenExpiresAt: value });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /fixture-access|fixture-refresh/);
});

test("workerd access-only admin merge retains the deadline of the unchanged refresh token", { timeout: 60000 }, async t => {
  const f = await fixture(t), expiry = iso(now + 86400000), manual = iso(now - 86400000);
  await f.put({ refreshTokenExpiresAt: expiry, lastManualAuthorizationAt: manual });
  const edited = await f.request(f.base, "PUT", { provider: "anthropic", kind: "subscription", accessToken: "fixture-access-updated" });
  assert.equal(edited.status, 200);
  const row = await f.row();
  assert.equal(row.hasRefreshToken, true);
  assert.equal(row.refreshTokenExpiresAt, expiry);
  assert.equal(row.lastManualAuthorizationAt, manual);
  assert.equal(row.refreshExpiryWarning, "warning");
});
