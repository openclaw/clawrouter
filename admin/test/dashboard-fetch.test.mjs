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

const { playgroundRequest, request } = await import("../src/dashboard-fetch.ts");

test("dashboard JSON request aborts a hung worker with a default timeout and keeps a caller signal", async (context) => {
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
  assert.deepEqual(timeouts, [30_000]);

  const caller = new AbortController();
  await request("https://console.example", "/v1/me", { signal: caller.signal });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1].signal, caller.signal);
  assert.ok(seen[1].signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [30_000, 30_000]);
  caller.abort();
  assert.equal(seen[1].signal.aborted, true);
});

test("playground request uses the 600s endpoint budget instead of the 30s dashboard timeout", async (context) => {
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
