import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { DashboardRequestError, authenticationRequired, localLogin, playgroundRequest, request } = await import("../src/dashboard-fetch.ts");

test("only exact console authentication envelopes invalidate a browser session", async (context) => {
  for (const [path, status, body, expected] of [
    ["/v1/admin/bootstrap", 401, { error: { code: "admin_unauthorized" } }, true],
    ["/v1/admin/credentials/key/rotate", 401, { error: { code: "admin_unauthorized" } }, true],
    ["/v1/session/credentials", 401, { error: { code: "access_session_required" } }, true],
    ["/v1/entitlements", 401, { error: { code: "access_session_required" } }, true],
    ["/v1/admin/bootstrap", 403, { error: { code: "access_admin_required" } }, false],
    ["/v1/admin/credentials", 403, { error: { code: "access_csrf_required" } }, false],
    ["/v1/admin/bootstrap", 503, { error: { code: "admin_unauthorized" } }, false],
    ["/v1/admin/bootstrap", 401, "admin_unauthorized", false],
    ["/v1/session", 401, { message: "access_session_required" }, false],
    ["/v1/session", 401, { error: { code: "admin_unauthorized" } }, false],
    ["/v1/session/login", 401, { error: { code: "login_invalid" } }, false],
    ["/v1/playground/responses", 401, { error: { code: "access_session_required" } }, false],
  ]) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    context.mock.method(globalThis, "fetch", async () => new Response(raw, { status }));
    await assert.rejects(request("https://console.example", path), (error) => {
      assert.equal(error.message, raw);
      assert.equal(authenticationRequired(error, path), expected);
      return true;
    });
  }
});

test("JSON requests distinguish confirmed HTTP rejection from an uncertain transport outcome", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("credential_exists", { status: 409 }));
  await assert.rejects(request("https://console.example", "/v1/session/credentials"), (error) => error instanceof DashboardRequestError && error.status === 409 && error.message === "credential_exists");
  context.mock.method(globalThis, "fetch", async () => { throw new TypeError("network failed"); });
  await assert.rejects(request("https://console.example", "/v1/session/credentials"), (error) => !(error instanceof DashboardRequestError));
});

test("dashboard JSON request leaves headroom for a typed 30s Worker timeout and keeps a caller signal", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  const seen = [];
  context.mock.method(globalThis, "fetch", async (_input, init) => {
    seen.push(init);
    return Response.json({ ok: true });
  });

  await request("https://console.example", "/v1/session");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].credentials, "same-origin");
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(seen[0].signal.aborted, false);
  assert.deepEqual(timeouts, [60_000]);

  const caller = new AbortController();
  await request("https://console.example", "/v1/me", { signal: caller.signal });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1].signal, caller.signal);
  assert.ok(seen[1].signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [60_000, 60_000]);
  caller.abort();
  assert.equal(seen[1].signal.aborted, true);
});

test("playground request uses the 600s endpoint budget instead of the bounded dashboard timeout", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  let init;
  context.mock.method(globalThis, "fetch", async (_input, options) => {
    init = options;
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  });

  const result = await playgroundRequest("https://console.example/", "/v1/chat/completions");
  assert.equal(result.status, 200);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [600_000]);
});

test("local console login attaches the dashboard AbortSignal", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  let loginInit;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), "https://console.example/v1/session/login");
    loginInit = init;
    return Response.json({ ok: true });
  });

  assert.equal(await localLogin("https://console.example", "admin-token"), null);
  assert.equal(loginInit.method, "POST");
  assert.equal(loginInit.credentials, "same-origin");
  assert.equal(loginInit.body, JSON.stringify({ token: "admin-token" }));
  assert.ok(loginInit.signal instanceof AbortSignal);
  assert.equal(loginInit.signal.aborted, false);
  assert.deepEqual(timeouts, [60_000]);
});

test("playground request honors an explicit endpoint timeout", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  context.mock.method(globalThis, "fetch", async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));

  await playgroundRequest("https://console.example/", "/v1/proxy/openai/chat", {}, 180_000);
  assert.deepEqual(timeouts, [180_000]);
});
