import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { configuredUpstream, providerReadinessForState } = await import("../providers.ts");
const { assertOperationConfiguration } = await import("../provider-auth.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/queue-lifecycle.json", import.meta.url)));
const route = JSON.parse(readFileSync(new URL("../../providers/_fixtures/media/managed-routes.json", import.meta.url))).protocols.find(r => r.protocol === "fal.queue");
const native = `/v1/native/fal${wire.submit.path}`, control = `/v1/native/fal${wire.controls.status.path}`;

async function falFixture(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "fal", configure(provider) {
    // Exact canonical auth/lifecycle shape published by the source-owned fal declaration.
    provider.config_keys = ["FAL_KEY"]; provider.optional_config_keys = [];
    provider.base_urls = { default: "https://queue.fal.run" };
    provider.auth.schemes = [{ type: "bearer", header: "Authorization", format: "Key ${secret}", secretKind: "api_key", required: true }];
    provider.auth.grantTransports = {};
    const base = structuredClone(provider.endpoints[0]);
    const endpoint = (id, path, method, format) => ({ ...base, id, path, method, methods: [method],
      request_format: format, response_format: format, native_proxy: true, headers: {}, query: {}, streaming: null,
      path_params: [...path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]), path_param_styles: {} });
    const create = endpoint("queue", "/${owner}/${app}/${variant}", "POST", "fal.queue_submit");
    create.response_format = "fal.queue_submission";
    create.lifecycle = { protocol: "fal.queue", retrieve: "queue_status", result: "queue_result", cancel: "queue_cancel" };
    provider.endpoints = [create, ...["retrieve", "result", "cancel"].map(action => {
      const id = action === "retrieve" ? "status" : action;
      return endpoint(`queue_${id}`, route[action].path, route[action].method, `fal.queue_${id}`);
    })];
    provider.capabilities = [{ id: "media.predict", endpoint: "queue" }]; provider.models = [];
  } });
  f.env.FAL_KEY = "synthetic-env:id";
  Object.assign(f.env, { FAL_API_KEY: "synthetic-alias", OTHER_KEY: "synthetic-foreign" });
  f.upstream = request => Response.json(request.method === "POST" ? wire.observations.queued : wire.observations.running);
  f.create = manifest => f.call(manifest ? "/v1/proxy/fal/queue" : native,
    manifest ? { body: wire.submit.body, pathParams: route.pathParams } : wire.submit.body,
    { headers: { "x-api-key": "synthetic-caller", "Idempotency-Key": "fixture-create" } });
  t.after(f.drain); return f;
}

test("canonical fal binding reaches the real factory and scoped readiness without key disclosure", { timeout: 10_000 }, async t => {
  const f = await falFixture(t), auth = configuredUpstream(f.provider, null, f.env);
  assert.equal(auth.baseUrl, "https://queue.fal.run"); assert.equal(auth.headers.get("authorization"), "Key synthetic-env:id");
  assert.equal(auth.query.size, 0); assert.equal(auth.grantLane, "environment");
  const grant = { provider: "fal", kind: "api_key", enabled: true, credential: "synthetic-selected:id" };
  assert.equal(configuredUpstream(f.provider, grant, f.env).headers.get("authorization"), "Key synthetic-selected:id");
  const readiness = providerReadinessForState(f.provider, {}, [{ key: grantKey, grant }], { providerId: "fal", enabled: true });
  assert.equal(readiness.configPresent, true); assert.deepEqual(readiness.missingConfig, []);
  assert.doesNotMatch(JSON.stringify(readiness), /synthetic-/);
  const absent = providerReadinessForState(f.provider, {}, [], { providerId: "fal", enabled: true });
  assert.deepEqual(absent.missingConfig, ["FAL_KEY"]); assert.equal(absent.executable, false);
});

test("FAL_KEY is exact to the declared fal Key scheme; unrelated key names and products stay denied", { timeout: 10_000 }, async t => {
  const f = await falFixture(t), deny = (provider, env) => assert.throws(() => configuredUpstream(provider, null, env), e => e.code === "provider_not_configured");
  deny(f.provider, { FAL_API_KEY: "synthetic-alias", OTHER_KEY: "synthetic-foreign" });
  deny({ ...f.provider, config_keys: [] }, f.env);
  deny({ ...f.provider, id: "unrelated" }, f.env);
  deny({ ...f.provider, config_keys: ["OTHER_KEY"] }, f.env);
  for (const patch of [{ format: "Bearer ${secret}" }, { secretKind: "api_token" }, { header: "X-Api-Key" }]) {
    deny({ ...f.provider, auth: { ...f.provider.auth, schemes: [{ ...f.provider.auth.schemes[0], ...patch }] } }, f.env);
  }
  // Existing suffix bindings retain their normal credential contract.
  const ordinary = { ...f.provider, id: "unrelated", config_keys: ["OTHER_API_KEY"] };
  assert.equal(configuredUpstream(ordinary, null, { OTHER_API_KEY: "synthetic-standard" }).headers.get("authorization"), "Key synthetic-standard");
  assert.equal(f.sent.length, 0);
});

test("missing and malformed selected fal credentials deny before headers or fetch without fallback or key echo", { timeout: 10_000 }, async t => {
  const f = await falFixture(t), logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  for (const credential of [undefined, "", "synthetic-private\r\ninjection", "synthetic-private\u0000", "synthetic-private\t", "synthetic private", "synthetic-private\u0100"]) {
    const grant = { provider: "fal", kind: "api_key", enabled: true, credential };
    const deny = fn => assert.throws(fn, e => {
      assert.equal(e.code, "provider_not_configured"); assert.doesNotMatch(String(e), /synthetic-private|injection/); return true;
    });
    deny(() => configuredUpstream(f.provider, grant, f.env));
    deny(() => assertOperationConfiguration({ provider: f.provider, endpoint: f.provider.endpoints[0], mode: "http" }, grant, f.env));
    deny(() => configuredUpstream(f.provider, null, { FAL_KEY: credential, FAL_API_KEY: "synthetic-alias" }));
  }
  assert.equal(f.sent.length, 0); assert.deepEqual(logs, []);
});

for (const pooled of [false, true]) for (const manifest of [false, true]) test(`fal ${pooled ? "pooled" : "environment"} ${manifest ? "manifest" : "native"} create/control retains the original Key credential`, { timeout: 10_000 }, async t => {
  const f = await falFixture(t, { pooled });
  const created = await f.create(manifest); assert.equal(created.status, 200, await created.clone().text());
  const state = f.state(created); await created.json(); f.restart();
  const polled = await f.call(control, null); assert.equal(polled.status, 200, await polled.clone().text()); await polled.json();
  assert.equal(f.sent.length, 2);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://queue.fal.run");
    assert.equal(request.headers.get("authorization"), `Key ${pooled ? "synthetic-original-key" : "synthetic-env:id"}`);
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-(?:original-key|env:id|caller|alias)/);
  // Changing the selected original credential cannot authorize a current-key control.
  if (pooled) await putGrantCredentials(f.env, grantKey, { provider: "fal", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  else f.env.FAL_KEY = "synthetic-replacement";
  const denied = await f.call(control, null); assert.ok([409, 503].includes(denied.status));
  assert.doesNotMatch(await denied.text(), /synthetic-/); assert.equal(f.sent.length, 2);
});

for (const scenario of ["missing", "malformed", "unpriced"]) test(`fal ${scenario} admission is zero-egress with no credential disclosure`, { timeout: 10_000 }, async t => {
  const f = await falFixture(t, { fixed: scenario === "unpriced" ? null : 700 });
  if (scenario === "missing") delete f.env.FAL_KEY;
  if (scenario === "malformed") f.env.FAL_KEY = "synthetic-private\r\nmalformed";
  const denied = await f.create(false); assert.equal(denied.status, scenario === "unpriced" ? 400 : 503);
  assert.doesNotMatch(await denied.text(), /synthetic-private|synthetic-alias|synthetic-caller/);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});
