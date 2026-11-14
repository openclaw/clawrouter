import assert from "node:assert/strict";
import test from "node:test";
import { copilotAccountRequest } from "../provider-copilot.ts";
import { prepareCopilotDeviceRequest, decodeCopilotDeviceAuthorization, prepareCopilotDevicePollRequest, decodeCopilotDevicePoll } from "../provider-copilot-device.ts";

const owner = "fixture-owner:generation-3";
const context = Object.freeze({ githubDomain: "github.com", ownerBinding: owner });
const wire = { device_code: "synthetic-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900 };
const authorize = (patch = {}, selected = context) => decodeCopilotDeviceAuthorization(JSON.stringify({ ...wire, ...patch }), 200, selected, owner);
const poll = (payload, interval = 5000, status = 200) => decodeCopilotDevicePoll(JSON.stringify(payload), status, authorize(), owner, interval);

test("device preparse preserves overwritten deep values and final scalar authorization", () => {
  const expected = authorize();
  for (const deep of ["[".repeat(1500) + "0" + "]".repeat(1500), '{"x":'.repeat(500) + "0" + "}".repeat(500)]) {
    const text = '{"expires_in":' + deep + ',' + JSON.stringify(wire).slice(1);
    assert.ok(Buffer.byteLength(text) < 8192);
    assert.deepEqual(decodeCopilotDeviceAuthorization(text, 200, context, owner), expected);
    const token = '{"access_token":' + deep + ',"access_token":"synthetic-original"}';
    assert.deepEqual(decodeCopilotDevicePoll(token, 200, expected, owner, 5000), { status: "authorized", githubDomain: "github.com", ownerBinding: owner, accessToken: "synthetic-original" });
    const pending = '{"error":' + deep + ',"error":"authorization_pending"}';
    assert.deepEqual(decodeCopilotDevicePoll(pending, 200, expected, owner, 5000), { status: "pending", reason: "authorization_pending", intervalMs: 5000 });
  }
  assert.throws(() => decodeCopilotDeviceAuthorization(JSON.stringify(wire).slice(0, -1) + ',"expires_in":[]}', 200, context, owner), { message: "invalid_copilot_device_duration" });
});

test("device guard preserves status, resource, malformed-JSON and parsed-body error contracts", () => {
  const authorization = authorize();
  assert.throws(() => decodeCopilotDeviceAuthorization("null", 200, context, owner), { message: "invalid_copilot_device_response_body" });
  const original = JSON.parse; let calls = 0;
  JSON.parse = (...args) => { calls++; return original(...args); };
  try {
    for (const text of ["{", '{"device_code":"synthetic-private"} trailing']) {
      assert.throws(() => decodeCopilotDeviceAuthorization(text, 200, context, owner), { message: "invalid_copilot_device_response_json" });
      assert.throws(() => decodeCopilotDeviceAuthorization(text, 403, context, owner), { message: "invalid_copilot_device_http_status" });
      assert.deepEqual(decodeCopilotDevicePoll(text, 200, authorization, owner, 5000), { status: "error", code: "invalid_response" });
      assert.deepEqual(decodeCopilotDevicePoll(text, 403, authorization, owner, 5000), { status: "error", code: "http_error" });
    }
    const oversized = "é".repeat(4097);
    assert.throws(() => decodeCopilotDeviceAuthorization(oversized, 403, context, owner), { message: "invalid_copilot_device_response_limit" });
    assert.deepEqual(decodeCopilotDevicePoll(oversized, 403, authorization, owner, 5000), { status: "error", code: "invalid_response" });
    assert.equal(calls, 0);
  } finally { JSON.parse = original; }
});

for (const domain of ["github.com", "fixture.ghe.com"]) {
  test(`device forms bind both requests to the selected ${domain} owner`, () => {
    const selected = { ...context, githubDomain: domain };
    const initial = prepareCopilotDeviceRequest(selected, owner);
    assert.equal(initial.url, `https://${domain}/login/device/code`);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(initial.init.body)), { client_id: "Iv1.b507a08c87ecfe98", scope: "read:user" });
    const authorization = authorize({ verification_uri: `https://${domain}/login/device?untrusted=discard#discard`, user_code: " ABCD-EFGH " }, selected);
    assert.deepEqual(authorization, { githubDomain: domain, ownerBinding: owner, deviceCode: wire.device_code, userCode: wire.user_code, verificationUrl: `https://${domain}/login/device`, expiresInMs: 900000, intervalMs: 5000 });
    const next = prepareCopilotDevicePollRequest(authorization, owner);
    assert.equal(next.url, `https://${domain}/login/oauth/access_token`);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(next.init.body)), { client_id: "Iv1.b507a08c87ecfe98", device_code: wire.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    for (const request of [initial, next]) {
      assert.equal(request.init.method, "POST");
      assert.equal(request.init.redirect, "manual");
      assert.equal(request.timeoutMs, 30000);
      assert.deepEqual(request.init.headers, { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
      assert.deepEqual(Object.keys(request).sort(), ["init", "timeoutMs", "url"]);
      assert.equal(Object.isFrozen(request.init.headers) && Object.isFrozen(request.init) && Object.isFrozen(request), true);
    }
    assert.equal(Object.isFrozen(authorization), true);
  });
}

test("every export rejects a changed original owner before preparing or decoding data", () => {
  const authorization = authorize();
  for (const changed of ["other-owner", "", "x".repeat(513), undefined]) {
    for (const invoke of [
      () => prepareCopilotDeviceRequest(context, changed),
      () => decodeCopilotDeviceAuthorization("not json", 200, context, changed),
      () => prepareCopilotDevicePollRequest(authorization, changed),
      () => decodeCopilotDevicePoll("not json", 200, authorization, changed, 5000),
    ]) assert.throws(invoke, { message: "invalid_copilot_device_owner_binding" });
  }
});

test("closed contexts have no default public domain, URL override, credentials or header bag", () => {
  for (const selected of [undefined, null, [], {}, Object.create(context), { ...context, headers: {} }, { ...context, token: "synthetic" }, { ...context, [Symbol("override")]: "value" }, ...["", "https://github.com", "other.example", "foreign.ghe.com.evil.example", "a.b.ghe.com", "-tenant.ghe.com", "github.com/path", "github.com:443"].map(githubDomain => ({ ...context, githubDomain }))]) {
    assert.throws(() => prepareCopilotDeviceRequest(selected, owner), /invalid_copilot_device_/);
    assert.throws(() => decodeCopilotDeviceAuthorization(JSON.stringify(wire), 200, selected, owner), /invalid_copilot_device_/);
  }
  assert.equal(prepareCopilotDeviceRequest({ ...context, githubDomain: " GitHub.COM " }, owner).url, "https://github.com/login/device/code");
});

test("verification cannot switch public/enterprise accounts or embed a foreign destination", () => {
  for (const verification_uri of ["http://github.com/login/device", "https://other.ghe.com/login/device", "https://github.com.evil.example/login/device", "https://api.github.com/login/device", "https://github.com/login/device/extra", "https://user:synthetic@github.com/login/device", "https://github.com:8443/login/device", "https://github.com/login/%64evice", "not a URL", "", null]) {
    assert.throws(() => authorize({ verification_uri }), { message: "invalid_copilot_device_verification_url" });
  }
  assert.throws(() => authorize({}, { ...context, githubDomain: "fixture.ghe.com" }), /verification_url/);
  const changed = { ...authorize(), githubDomain: "other.ghe.com" };
  assert.throws(() => prepareCopilotDevicePollRequest(changed, owner), /verification_url/);
  assert.throws(() => decodeCopilotDevicePoll("{}", 200, changed, owner, 5000), /verification_url/);
});

test("poll descriptors revalidate the complete retained authorization instead of accepting extra state", () => {
  const original = authorize();
  for (const changed of [
    { ...original, accessToken: "synthetic" }, { ...original, expiresAt: 900000 },
    { ...original, deviceCode: "bad\r\ncode" }, { ...original, deviceCode: "é".repeat(4097) },
    { ...original, userCode: " padded " }, { ...original, userCode: "x".repeat(65) },
    { ...original, verificationUrl: `${original.verificationUrl}?untrusted=yes` },
    ...[0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(expiresInMs => ({ ...original, expiresInMs })),
    ...[0, 999, Infinity, 1000.5].map(intervalMs => ({ ...original, intervalMs })),
  ]) {
    assert.throws(() => prepareCopilotDevicePollRequest(changed, owner), /invalid_copilot_device_/);
    assert.throws(() => decodeCopilotDevicePoll("{}", 200, changed, owner, 5000), /invalid_copilot_device_/);
  }
});

test("device codes are form encoded without adding query or authorization fields", () => {
  const code = "synthetic+/=& ?é";
  const request = prepareCopilotDevicePollRequest(authorize({ device_code: code }), owner);
  assert.equal(new URLSearchParams(request.init.body).get("device_code"), code);
  assert.equal(new URL(request.url).search, "");
  assert.equal("Authorization" in request.init.headers, false);
});

test("expiry is a required positive safe duration, never an invented absolute lifetime", () => {
  for (const expires_in of [1, " +2 ", 900]) assert.equal(authorize({ expires_in }).expiresInMs, Number(expires_in) * 1000);
  for (const expires_in of [undefined, null, false, 0, -1, 0.1, "", "1.5", "1e3", "900x", Number.MAX_SAFE_INTEGER, "9007199254741"]) assert.throws(() => authorize({ expires_in }), /duration/);
  assert.equal(authorize({ expires_in: 9007199254740 }).expiresInMs, 9007199254740000);
  const result = authorize();
  for (const field of ["expiresAt", "refreshToken", "accessToken", "nextPollAt"]) assert.equal(field in result, false);
});

test("initial poll timing always supplies a wait: absent 5 seconds, explicit zero floored to 1", () => {
  assert.equal(authorize().intervalMs, 5000);
  assert.equal(authorize({ interval: 0 }).intervalMs, 1000);
  assert.equal(authorize({ interval: " +2 " }).intervalMs, 2000);
  for (const interval of [null, false, -1, 0.5, "", "1e2", "invalid", Number.MAX_SAFE_INTEGER]) assert.throws(() => authorize({ interval }), /duration/);
  // The pure result describes the FIRST wait. Only the durable owner can enforce
  // elapsed time, absolute expiry and cancellation before each physical poll.
});

test("pending preserves current spacing; slow_down adds five seconds cumulatively and may only raise it", () => {
  const pending = { error: "authorization_pending" };
  assert.deepEqual(poll(pending), { status: "pending", reason: "authorization_pending", intervalMs: 5000 });
  assert.equal(poll({ ...pending, interval: 99 }).intervalMs, 5000);
  const first = poll({ error: "slow_down", interval: 7 });
  assert.deepEqual(first, { status: "pending", reason: "slow_down", intervalMs: 10000 });
  const second = poll({ error: "slow_down", interval: 1 }, first.intervalMs);
  assert.equal(second.intervalMs, 15000);
  assert.equal(poll(pending, second.intervalMs).intervalMs, 15000);
  assert.equal(poll({ error: "slow_down", interval: "30" }, second.intervalMs).intervalMs, 30000);
  assert.equal(poll({ error: "slow_down", interval: 0 }).intervalMs, 10000);
  assert.equal(poll({ error: "slow_down" }, Number.MAX_SAFE_INTEGER - 1).intervalMs, Number.MAX_SAFE_INTEGER);
});

test("current polling interval cannot undercut initial spacing or use unsafe values", () => {
  for (const interval of [0, 4999, 5000.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "5000"]) assert.throws(() => poll({ error: "authorization_pending" }, interval), /poll_interval/);
});

for (const [error, status] of [["expired_token", "expired"], ["access_denied", "access_denied"]]) {
  test(`${error} is terminal and never retries`, () => {
    assert.deepEqual(poll({ error, error_description: "synthetic private detail", error_uri: "https://example.invalid/private" }), { status });
  });
}

test("successful polling preserves the ORIGINAL GitHub token for account discovery", () => {
  for (const domain of ["github.com", "fixture.ghe.com"]) {
    const authorization = authorize({ verification_uri: `https://${domain}/login/device` }, { ...context, githubDomain: domain });
    const access_token = "synthetic-original-GitHub-token_1";
    for (const payload of [{ access_token }, { access_token, token_type: "bearer", scope: "read:user" }]) {
      const result = decodeCopilotDevicePoll(JSON.stringify(payload), 200, authorization, owner, 5000);
      assert.deepEqual(result, { status: "authorized", githubDomain: domain, ownerBinding: owner, accessToken: access_token });
      assert.equal(Object.isFrozen(result), true);
      const request = copilotAccountRequest(result.githubDomain, result.accessToken);
      assert.equal(request.url, `https://api.${domain}/copilot_internal/user`);
      assert.equal(request.headers.get("authorization"), `Bearer ${access_token}`);
      for (const field of ["refreshToken", "expiresAt", "expiresInMs", "scope", "entitled"]) assert.equal(field in result, false);
    }
  }
});

test("malformed and contradictory token envelopes cannot authorize or stay pending", () => {
  for (const payload of [
    { access_token: "synthetic", error: "authorization_pending" }, { access_token: "synthetic", refresh_token: "synthetic" },
    { access_token: "synthetic", expires_in: 900 }, { access_token: "synthetic", interval: 5 },
    { access_token: "synthetic", token_type: "mac" }, { access_token: "synthetic", scope: [] },
    ...[null, 0, "", " padded ", "injected\r\nvalue", "é"].map(access_token => ({ access_token })),
    { error: "authorization_pending", token_type: "bearer" }, { error: "authorization_pending", error_description: {} },
    { error: "slow_down", interval: -1 }, { error: "authorization_pending", interval: null }, { error: "slow_down", interval: Number.MAX_SAFE_INTEGER },
    {}, [], null, { error: "" }, { error: 123 }, { unexpected: "private detail" },
  ]) assert.deepEqual(poll(payload), { status: "error", code: "invalid_response" });
});

test("unknown provider errors and all non-2xx responses are terminal content-free results", () => {
  assert.deepEqual(poll({ error: "unknown_private_error", error_description: "synthetic-secret-detail" }), { status: "error", code: "provider_error" });
  for (const status of [0, 199, 300, 301, 307, 400, 401, 403, 429, 500, 200.5]) {
    assert.deepEqual(poll({ error: "authorization_pending" }, 5000, status), { status: "error", code: "http_error" });
    assert.deepEqual(poll({ access_token: "synthetic" }, 5000, status), { status: "error", code: "http_error" });
    assert.throws(() => decodeCopilotDeviceAuthorization(JSON.stringify(wire), status, context, owner), { message: "invalid_copilot_device_http_status" });
  }
});

test("malformed authorization and poll JSON never echo upstream contents", () => {
  for (const text of ["synthetic-private-detail", "{", "null", "[]", "true", '"synthetic-private-detail"']) {
    assert.throws(() => decodeCopilotDeviceAuthorization(text, 200, context, owner), error => /^invalid_copilot_device_/.test(error.message) && !error.message.includes("private-detail"));
    assert.deepEqual(decodeCopilotDevicePoll(text, 200, authorize(), owner, 5000), { status: "error", code: "invalid_response" });
  }
  for (const patch of [{ error: "authorization_pending" }, { access_token: "synthetic" }, { future_field: true }, { user_code: "x".repeat(65) }, { user_code: "  " }, { device_code: "bad\0code" }]) assert.throws(() => authorize(patch), /invalid_copilot_device_/);
});

test("both text decoders enforce 8 KiB of UTF-8 before JSON parsing, not a character limit", () => {
  const base = JSON.stringify({ ...wire, device_code: "" });
  const exact = JSON.stringify({ ...wire, device_code: "x".repeat(8192 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), 8192);
  assert.equal(decodeCopilotDeviceAuthorization(exact, 200, context, owner).deviceCode.length, 8192 - Buffer.byteLength(base));
  assert.throws(() => decodeCopilotDeviceAuthorization(exact + " ", 200, context, owner), /response_limit/);
  const multibyte = JSON.stringify({ ...wire, device_code: "é".repeat(4096) });
  assert.ok(multibyte.length < 8192 && Buffer.byteLength(multibyte) > 8192);
  for (const text of [multibyte, "é".repeat(4097)]) assert.throws(() => decodeCopilotDeviceAuthorization(text, 200, context, owner), /response_limit/);
  const tokenBase = JSON.stringify({ access_token: "synthetic", scope: "" });
  const tokenExact = JSON.stringify({ access_token: "synthetic", scope: "x".repeat(8192 - Buffer.byteLength(tokenBase)) });
  assert.equal(Buffer.byteLength(tokenExact), 8192);
  assert.equal(decodeCopilotDevicePoll(tokenExact, 200, authorize(), owner, 5000).status, "authorized");
  for (const text of [tokenExact + " ", JSON.stringify({ access_token: "synthetic", scope: "é".repeat(4096) }), "é".repeat(4097)]) assert.deepEqual(decodeCopilotDevicePoll(text, 200, authorize(), owner, 5000), { status: "error", code: "invalid_response" });
});
