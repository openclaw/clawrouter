import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { configuredUpstream, providerReadinessForState } = await import("../providers.ts");
const { assertOperationConfiguration, providerSecretConfigKey } = await import("../provider-auth.ts");
const { prepareSelected } = await import("../proxy.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const body = { model: "gen4.5", promptText: "Synthetic text", ratio: "1280:720", duration: 5 };

async function setup(t, pooled = false) {
  const f = await fixture(t, { pooled, providerId: "runway", configure(provider) {
    // Canonical auth shape from source-owned PR522 at 0050fe06.
    provider.config_keys = ["RUNWAYML_API_SECRET"]; provider.optional_config_keys = [];
    provider.base_urls = { default: "https://api.dev.runwayml.com" };
    provider.auth.schemes = [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key", required: true }];
    provider.auth.grantTransports = {};
    const endpoint = provider.endpoints[0];
    Object.assign(endpoint, { id: "text_video", path: "/v1/text_to_video", path_params: [], path_param_styles: {},
      method: "POST", methods: ["POST"], request_format: "runway.text_video", response_format: "runway.task",
      headers: {}, query: {}, streaming: null, lifecycle: undefined });
    provider.endpoints = [endpoint]; provider.models = [];
    provider.capabilities = [{ id: "media.predict", endpoint: "text_video", methods: ["POST"] }];
  } });
  f.env.RUNWAYML_API_SECRET = "synthetic-runway-environment";
  Object.assign(f.env, { RUNWAY_API_KEY: "synthetic-alias", OTHER_API_SECRET: "synthetic-foreign" });
  f.selection = { provider: f.provider, endpoint: f.provider.endpoints[0], method: "POST", model: null, capability: "media.predict", body, pathParams: {} };
  t.after(f.drain); return f;
}

test("Runway canonical factory binding masks the configured secret and preserves original selected grants", { timeout: 10_000 }, async t => {
  const f = await setup(t), upstream = configuredUpstream(f.provider, null, f.env);
  assert.equal(upstream.baseUrl, "https://api.dev.runwayml.com"); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-runway-environment");
  assert.equal(upstream.query.size, 0); assert.equal(upstream.grantLane, "environment");
  const grant = { provider: "runway", kind: "api_key", enabled: true, credential: "synthetic-selected" };
  assert.equal(configuredUpstream(f.provider, grant, f.env).headers.get("authorization"), "Bearer synthetic-selected");
  assert.equal(providerSecretConfigKey(f.provider, "RUNWAYML_API_SECRET"), true);
  assert.equal(providerSecretConfigKey(f.provider, "OTHER_API_SECRET"), false);
  const readiness = providerReadinessForState(f.provider, {}, [{ key: grantKey, grant }], { providerId: "runway", enabled: true });
  assert.equal(readiness.configPresent, true); assert.deepEqual(readiness.missingConfig, []);
  assert.doesNotMatch(JSON.stringify(readiness), /synthetic-/);
  const absent = providerReadinessForState(f.provider, {}, [], { providerId: "runway", enabled: true });
  assert.deepEqual(absent.missingConfig, ["RUNWAYML_API_SECRET"]); assert.equal(absent.executable, false);
  assert.equal(f.sent.length, 0);
});

test("Runway secret recognition is restricted to the canonical product and exact Bearer scheme", { timeout: 10_000 }, async t => {
  const f = await setup(t), deny = (provider, env) => assert.throws(() => configuredUpstream(provider, null, env), error => error.code === "provider_not_configured");
  deny(f.provider, { RUNWAY_API_KEY: "synthetic-alias", OTHER_API_SECRET: "synthetic-foreign" });
  for (const provider of [{ ...f.provider, id: "unrelated" }, { ...f.provider, config_keys: [] }, { ...f.provider, config_keys: ["OTHER_API_SECRET"] }]) {
    deny(provider, f.env); assert.equal(providerSecretConfigKey(provider, "OTHER_API_SECRET"), false);
  }
  for (const patch of [{ format: "Key ${secret}" }, { secretKind: "api_token" }, { header: "X-Api-Key" }]) {
    const provider = { ...f.provider, auth: { ...f.provider.auth, schemes: [{ ...f.provider.auth.schemes[0], ...patch }] } };
    deny(provider, f.env); assert.equal(providerSecretConfigKey(provider, "RUNWAYML_API_SECRET"), false);
  }
  const ordinary = { ...f.provider, id: "unrelated", config_keys: ["OTHER_API_KEY"] };
  assert.equal(configuredUpstream(ordinary, null, { OTHER_API_KEY: "synthetic-standard" }).headers.get("authorization"), "Bearer synthetic-standard");
  assert.equal(f.sent.length, 0);
});

test("malformed selected Runway secrets fail before Headers without echo, environment fallback or fetch", { timeout: 10_000 }, async t => {
  const f = await setup(t), logs = []; t.mock.method(console, "error", (...args) => logs.push(args));
  for (const credential of [undefined, "", "synthetic-private\r\ninjection", "synthetic-private\u0000", "synthetic-private\t", "synthetic private", "synthetic-private\u0100"]) {
    const grant = { provider: "runway", kind: "api_key", enabled: true, credential };
    const deny = fn => assert.throws(fn, error => {
      assert.equal(error.code, "provider_not_configured"); assert.doesNotMatch(String(error), /synthetic-private|injection/); return true;
    });
    deny(() => configuredUpstream(f.provider, grant, f.env));
    deny(() => assertOperationConfiguration({ provider: f.provider, endpoint: f.selection.endpoint, mode: "http" }, grant, f.env));
    deny(() => configuredUpstream(f.provider, null, { RUNWAYML_API_SECRET: credential, RUNWAY_API_KEY: "synthetic-alias" }));
  }
  assert.deepEqual(logs, []); assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

for (const pooled of [false, true]) test(`Runway real ${pooled ? "grant" : "environment"} preflight keeps canonical credentials separate from caller headers`, { timeout: 10_000 }, async t => {
  const f = await setup(t, pooled);
  const request = correlateIngressRequest(new Request("https://router.example/v1/native/runway/v1/text_to_video", {
    method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "x-api-key": "synthetic-caller", "content-type": "application/json" }, body: JSON.stringify(body),
  })).request;
  const auth = await authenticateProxyKey(request.headers, f.env, [{ id: "runway", tokenRef: "runway" }]); assert.ok(!(auth instanceof Response));
  const prepared = await prepareSelected(request, f.env, f.selection, {}, auth);
  assert.equal(prepared.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-runway-environment");
  assert.equal(prepared.headers.get("x-api-key"), null); assert.equal(prepared.url.href, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(prepared.requestBody), body); assert.equal(prepared.grantKey, pooled ? grantKey : null);
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
