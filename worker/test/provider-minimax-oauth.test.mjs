import assert from "node:assert/strict";
import test from "node:test";
import { createMiniMaxDeviceSession, decodeMiniMaxDeviceAuthorization, decodeMiniMaxTokenResponse, miniMaxPollDelay, miniMaxTokenExpiresAt, prepareMiniMaxAnthropicRequest, prepareMiniMaxDeviceRequest, prepareMiniMaxRefreshRequest, prepareMiniMaxTokenRequest, resolveMiniMaxResource } from "../provider-minimax-oauth.ts";
import { miniMaxFixtureCredential as credential, miniMaxFixtureNow as now, miniMaxFixtureSession as session } from "./fixtures/minimax-oauth.ts";
const owner = session.ownerBinding;
const response = (overrides = {}) => JSON.stringify({ user_code: "FIXTURE-CODE", verification_uri: "https://platform.minimax.io/oauth-authorize?user_code=FIXTURE-CODE", expired_in: now + 30_000, state: session.state, interval: 500, ...overrides });
const token = (overrides = {}) => JSON.stringify({ status: "success", access_token: "synthetic-access-new", refresh_token: "synthetic-refresh-new", expired_in: 3600, resource_url: "https://api.minimax.io/anthropic", ...overrides });
const auth = () => decodeMiniMaxDeviceAuthorization(response(), 200, session, owner, now);
const decode = (text, status = 200, previous) => decodeMiniMaxTokenResponse(text, status, "global", owner, now, previous);

test("device request uses frozen regional account endpoints, scope and PKCE S256", async () => {
  for (const [region, origin] of [["global", "https://account.minimax.io"], ["cn", "https://account.minimaxi.com"]]) {
    const request = await prepareMiniMaxDeviceRequest({ ...session, region }, owner), form = new URLSearchParams(request.init.body);
    assert.equal(request.url, `${origin}/oauth2/device/code`); assert.equal(request.init.method, "POST"); assert.equal(request.init.redirect, "manual");
    assert.equal(form.get("client_id"), "78257093-7e40-4613-99e0-527b14b39113");
    assert.equal(form.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(form.get("code_challenge_method"), "S256"); assert.equal(form.get("scope"), "group_id profile model.completion");
    assert.equal(form.get("state"), session.state); assert.equal(form.has("code_verifier"), false);
    assert.equal(request.init.headers["x-request-id"], session.requestId); assert.equal(request.timeoutMs, 30_000);
  }
});

test("new sessions have distinct cryptographic verifier/state and never perform network work", async () => {
  const first = createMiniMaxDeviceSession("cn", owner), second = createMiniMaxDeviceSession("cn", owner);
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/); assert.match(first.state, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(first.verifier, second.verifier); assert.notEqual(first.state, second.state);
  await assert.rejects(prepareMiniMaxDeviceRequest(first, "different-owner"), /owner_binding/);
  await assert.rejects(prepareMiniMaxDeviceRequest({ ...first, verifier: "short" }, owner), /device_session/);
});

test("authorization deadline is absolute milliseconds and pairing precedes token polling", () => {
  const authorization = auth(), request = prepareMiniMaxTokenRequest(session, authorization, owner, now);
  assert.equal(authorization.expiresAt, now + 30_000); assert.equal(authorization.intervalMs, 500);
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:user_code"); assert.equal(form.get("user_code"), "FIXTURE-CODE");
  assert.equal(form.get("code_verifier"), session.verifier); assert.equal(form.has("device_code"), false);
  assert.equal(miniMaxPollDelay(authorization, now), 500); assert.equal(miniMaxPollDelay(authorization, now, true), 2000);
  assert.equal(miniMaxPollDelay(authorization, now + 29_900, true), 100); assert.equal(miniMaxPollDelay(authorization, now + 30_000), 0);
  assert.throws(() => prepareMiniMaxTokenRequest(session, authorization, owner, now + 30_000), /authorization_binding/);
  assert.throws(() => prepareMiniMaxTokenRequest(session, { ...authorization, region: "cn" }, owner, now), /authorization_binding/);
});

test("authorization rejects mismatched state, malformed deadlines and unqualified verification origins", () => {
  for (const overrides of [{ base_resp: { status_code: 1004 } }, { state: "different" }, { expired_in: 3600 }, { expired_in: 8_700_000_000_000_000 }, { expired_in: String(now + 30_000) }, { verification_uri: "https://platform.minimaxi.com/oauth-authorize" }, { verification_uri: "https://platform.minimax.io.evil.example/" }, { verification_uri: "http://platform.minimax.io/" }, { verification_uri: "https://user:secret@platform.minimax.io/" }, { verification_uri: "https://platform.minimax.io/#fragment" }]) assert.throws(() => decodeMiniMaxDeviceAuthorization(response(overrides), 200, session, owner, now), /invalid_minimax/);
  assert.throws(() => decodeMiniMaxDeviceAuthorization(response(), 403, session, owner, now), /device_response/);
  assert.equal(decodeMiniMaxDeviceAuthorization(response({ interval: Number.MAX_SAFE_INTEGER }), 200, session, owner, now).intervalMs, 2000);
});

test("token expiry supports frozen duration/epoch units without accepting partial numbers or overflow", () => {
  assert.equal(miniMaxTokenExpiresAt(3600, now), now + 3_600_000);
  assert.equal(miniMaxTokenExpiresAt("3600", now), now + 3_600_000);
  assert.equal(miniMaxTokenExpiresAt((now + 3_600_000) / 1000, now), now + 3_600_000);
  assert.equal(miniMaxTokenExpiresAt(now + 3_600_000, now), now + 3_600_000);
  for (const value of ["3600s", " 3600", "3.6e3", null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER, now - 1]) assert.equal(miniMaxTokenExpiresAt(value, now), null);
});

test("token success materializes original owner, regional issuer and qualified resource", () => {
  const result = decode(token()); assert.equal(result.status, "success");
  assert.deepEqual(result.credential, { ...credential, access: "synthetic-access-new", refresh: "synthetic-refresh-new" });
  const cn = decodeMiniMaxTokenResponse(token({ resource_url: "https://api.minimaxi.com/anthropic" }), 200, "cn", owner, now);
  assert.equal(cn.credential.tokenEndpoint, "https://account.minimaxi.com/oauth2/token");
  assert.equal(cn.credential.region, "cn");
});

test("pending, denial, HTTP-200 errors and broken responses never expose provider text or credentials", () => {
  assert.deepEqual(decode(JSON.stringify({ status: "pending" })), { status: "pending" });
  for (const [text, status] of [[token({ error: "private token material" }), 200], [token({ base_resp: { status_code: 1004, status_msg: "private" } }), 200], [token({ status: "error" }), 200], ["not JSON private", 502], [token(), 401], ["x".repeat(8193), 200]]) {
    const result = decode(text, status); assert.equal(result.status, "error");
    assert.equal(JSON.stringify(result).includes("private"), false); assert.equal(JSON.stringify(result).includes("synthetic-access"), false);
  }
  assert.equal(decode(token(), 429).retryable, true); assert.equal(decode(token(), 401).retryable, false);
  for (const overrides of [{ access_token: "" }, { refresh_token: "" }, { expired_in: "bad" }, { resource_url: "https://api.minimaxi.com/anthropic" }, { resource_url: "https://other.example/anthropic" }]) assert.equal(decode(token(overrides)).status, "error");
});

test("refresh stays on the recorded issuer and preserves an unrotated refresh token", () => {
  const before = structuredClone(credential), request = prepareMiniMaxRefreshRequest(credential, owner);
  assert.equal(request.url, credential.tokenEndpoint); assert.equal(request.init.redirect, "manual");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.init.body)), { grant_type: "refresh_token", client_id: "78257093-7e40-4613-99e0-527b14b39113", refresh_token: "synthetic-refresh" });
  const result = decode(token({ refresh_token: undefined }), 200, credential);
  assert.equal(result.credential.refresh, credential.refresh); assert.equal(result.credential.access, "synthetic-access-new");
  assert.deepEqual(credential, before);
  assert.equal(decode(token(), 200, credential).credential.refresh, "synthetic-refresh-new");
});

test("refresh refuses missing issuer, changed owner/region/resource and HTTP-200 refresh errors", () => {
  for (const changed of [{ ...credential, tokenEndpoint: undefined }, { ...credential, tokenEndpoint: "https://account.minimaxi.com/oauth2/token" }, { ...credential, refresh: "" }, { ...credential, ownerBinding: "other-owner" }]) assert.throws(() => prepareMiniMaxRefreshRequest(changed, owner), /invalid_minimax/);
  assert.throws(() => prepareMiniMaxRefreshRequest(credential, owner, "https://api.minimaxi.com/anthropic"), /resource_origin/);
  assert.throws(() => prepareMiniMaxRefreshRequest(credential, owner, "https://api.minimax.io/unqualified"), /resource_origin/);
  assert.throws(() => decodeMiniMaxTokenResponse(token(), 200, "cn", owner, now, credential), /refresh_region/);
  for (const text of [JSON.stringify({ status: "pending" }), token({ base_resp: { status_code: 1004 } }), token({ refresh_token: "" }), token({ resource_url: "https://api.minimaxi.com/anthropic" })]) assert.equal(decode(text, 200, credential).status, "error");
});

test("resource contracts distinguish CN alias, account origin, Anthropic path and query credentials", () => {
  assert.equal(resolveMiniMaxResource("cn", "https://api.minimax.cn").anthropicBaseUrl, "https://api.minimax.cn/anthropic");
  assert.equal(resolveMiniMaxResource("global", "https://api.minimax.io/").anthropicBaseUrl, "https://api.minimax.io/anthropic");
  for (const value of ["https://api.minimax.io:444/anthropic", "https://api.minimax.io/anthropic?key=fixture", "https://api.minimax.io/v1", "https://account.minimax.io/anthropic", "https://api.minimax.cn/anthropic", "https://api.minimax.io.evil.example/anthropic"]) assert.throws(() => resolveMiniMaxResource("global", value), /invalid_minimax/);
});

test("inference binds admitted model and original credential without hot-path refresh", () => {
  const body = { model: "caller-alias", messages: [{ role: "user", content: "fixture" }], thinking: { type: "adaptive" }, output_config: { effort: "max" }, stream: true }, before = structuredClone(body);
  for (const grant of [credential, { kind: "api_key", region: "global", ownerBinding: owner, secret: "synthetic-api-key" }]) {
    const request = prepareMiniMaxAnthropicRequest(body, "MiniMax-M3", grant, owner, now);
    assert.equal(request.url, "https://api.minimax.io/anthropic/v1/messages"); assert.equal(request.redirect, "manual");
    assert.equal(request.body.model, "MiniMax-M3"); assert.deepEqual(request.body.thinking, body.thinking); assert.deepEqual(request.body.output_config, body.output_config);
    assert.equal(request.headers.Authorization, `Bearer ${grant.kind === "oauth" ? grant.access : grant.secret}`);
    assert.equal(request.headers["x-api-key"], undefined);
  }
  assert.deepEqual(body, before);
  assert.throws(() => prepareMiniMaxAnthropicRequest(body, "MiniMax-M3", { ...credential, expiresAt: now + 60_000 }, owner, now), /access_expiry/);
  assert.throws(() => prepareMiniMaxAnthropicRequest(body, "MiniMax-M3", credential, "other-owner", now), /owner_binding/);
  assert.throws(() => prepareMiniMaxAnthropicRequest(body, "MiniMax-M3", { ...credential, resource: resolveMiniMaxResource("cn") }, owner, now), /resource_origin/);
});
