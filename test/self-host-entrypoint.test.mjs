import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  localAdminEmail,
  localAuthMode,
  publicOrigin,
  renderSelfHostConfig,
  selfHostVariableNames,
  startContentCleanup,
} from "../deploy/self-host/entrypoint.mjs";

test("self-host preserves the canonical ingress abort compatibility flag", () => {
  const rendered = renderSelfHostConfig(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"));
  assert.match(rendered, /^compatibility_flags = \["enable_request_signal"\]$/m);
});

test("self-host cleanup waits for readiness, never overlaps ticks, and stops with its child", async (t) => {
  const child = new EventEmitter();
  let ready, complete, active = 0, calls = 0, signal;
  const health = new Promise((resolve) => { ready = resolve; });
  const sweep = new Promise((resolve) => { complete = resolve; });
  const stop = startContentCleanup(child, "http://localhost", { intervalMs: 5, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.endsWith("/v1/health")) return health;
    assert.equal(url, "http://localhost/cdn-cgi/local/scheduled?format=json");
    signal = options.signal;
    calls++;
    assert.equal(++active, 1);
    const response = await sweep;
    active--;
    return response;
  } });
  t.after(stop);
  await delay(15);
  assert.equal(calls, 0);
  ready(Response.json({ ok: true }));
  await delay(15);
  assert.equal(calls, 1);
  child.emit("exit", 0);
  assert.equal(signal.aborted, true);
  complete(Response.json({ outcome: "ok" }));
  await delay(15);
  assert.equal(calls, 1);
  assert.equal(child.listenerCount("exit"), 0);
});

test("native cleanup rejects HTTP and outcome failures before a later successful tick", async (t) => {
  const child = new EventEmitter(), errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  let calls = 0;
  const stop = startContentCleanup(child, "http://localhost", { intervalMs: 5, fetchImpl: async (url) => {
    if (url.endsWith("/v1/health")) return Response.json({ ok: true });
    calls++;
    if (calls === 1) return Response.json({ outcome: "ok" }, { status: 500 });
    if (calls === 2) return Response.json({ outcome: "exception", detail: "synthetic private detail" });
    child.emit("exit", 0);
    return Response.json({ outcome: "ok" });
  } });
  t.after(stop);
  const deadline = Date.now() + 1_000;
  while (calls < 3 && Date.now() < deadline) await delay(5);
  assert.equal(calls, 3);
  assert.equal(errors.length, 2);
  assert.doesNotMatch(JSON.stringify(errors), /synthetic private/);
});

test("self-host config removes custom routes and adds local policy KV", () => {
  const rendered = renderSelfHostConfig(`name = "clawrouter"

[build]
command = "pnpm build"

[[routes]]
pattern = "example.com"
custom_domain = true

[vars]
EXAMPLE = "kept"
`);

  assert.doesNotMatch(rendered, /\[\[routes\]\]/);
  assert.doesNotMatch(rendered, /\[build\]/);
  assert.doesNotMatch(rendered, /pnpm build/);
  assert.match(rendered, /\[vars\]\nEXAMPLE = "kept"/);
  assert.match(
    rendered,
    /\[\[kv_namespaces\]\]\nbinding = "POLICY_KV"\nid = "self-host-local"/,
  );
});

test("self-host vars include configured provider and explicit custom bindings", () => {
  const snapshot = {
    providers: [
      { config_keys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
      { config_keys: ["ANTHROPIC_API_KEY"] },
    ],
  };
  const names = selfHostVariableNames(snapshot, {
    OPENAI_API_KEY: "test",
    ANTHROPIC_API_KEY: "",
    CUSTOM_BINDING: "custom",
    CLAWROUTER_SELF_HOST_VARS: "CUSTOM_BINDING",
  });

  assert.deepEqual(names, ["CUSTOM_BINDING", "OPENAI_API_KEY"]);
  assert.throws(
    () =>
      selfHostVariableNames(snapshot, {
        CLAWROUTER_ADMIN_TOKEN: "test",
        CLAWROUTER_SELF_HOST_VARS: "CLAWROUTER_ADMIN_TOKEN",
      }),
    /cannot be passed to the Worker/,
  );
});

test("self-host vars exclude local-auth bindings owned by the entrypoint", () => {
  const names = selfHostVariableNames({ providers: [] }, {
    CLAWROUTER_LOCAL_AUTH: "enabled",
    CLAWROUTER_LOCAL_ADMIN_EMAIL: "ops@example.com",
    CLAWROUTER_PUBLIC_ORIGIN: "https://console.example.com",
    CUSTOM_BINDING: "custom",
    CLAWROUTER_SELF_HOST_VARS: "CUSTOM_BINDING,CLAWROUTER_LOCAL_AUTH,CLAWROUTER_LOCAL_ADMIN_EMAIL,CLAWROUTER_PUBLIC_ORIGIN",
  });
  assert.deepEqual(names, ["CUSTOM_BINDING"]);
});

test("local auth mode defaults to disabled and rejects unknown values", () => {
  assert.equal(localAuthMode({}), "disabled");
  assert.equal(localAuthMode({ CLAWROUTER_LOCAL_AUTH: " Enabled " }), "enabled");
  assert.throws(() => localAuthMode({ CLAWROUTER_LOCAL_AUTH: "maybe" }), /must be "enabled" or "disabled"/);
});

test("local admin email is validated at startup instead of first sign-in", () => {
  assert.equal(localAdminEmail({}), null);
  assert.equal(localAdminEmail({ CLAWROUTER_LOCAL_ADMIN_EMAIL: " ops@example.com " }), "ops@example.com");
  assert.throws(() => localAdminEmail({ CLAWROUTER_LOCAL_ADMIN_EMAIL: "admin local" }), /valid email address/);
  assert.throws(() => localAdminEmail({ CLAWROUTER_LOCAL_ADMIN_EMAIL: "admin@" }), /valid email address/);
});

test("public origin is canonicalized and invalid values fail closed at startup", () => {
  assert.equal(publicOrigin({}), null);
  assert.equal(publicOrigin({ CLAWROUTER_PUBLIC_ORIGIN: " https://Console.Example.com:443/ " }), "https://console.example.com");
  for (const value of ["console.example.com", "ftp://console.example.com", "https://user@example.com", "https://console.example.com/path", "https://console.example.com?query=1", "https://console.example.com/#fragment"]) {
    assert.throws(() => publicOrigin({ CLAWROUTER_PUBLIC_ORIGIN: value }), /absolute HTTP\(S\) origin/);
  }
});
