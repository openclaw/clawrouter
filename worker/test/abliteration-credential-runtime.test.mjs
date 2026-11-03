import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot, configuredUpstream, providerReadinessForState } = await import("../providers.ts");
const { assertOperationConfiguration, providerSecretConfigKey } = await import("../provider-auth.ts");
const canonical = "synthetic-canonical", legacy = "synthetic-legacy";
const names = ["ABLIT_KEY", "ABLITERATION_API_KEY"];
const connection = { providerId: "abliteration", enabled: true };

async function setup(t, options = {}) {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === "abliteration"));
  assert.ok(source); snapshot.providers = original.filter(provider => provider.id !== source.id); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: source.id, configure(provider) {
    Object.assign(provider, source); provider.config_keys = options.keys ?? names; provider.optional_config_keys = [];
  } });
  f.model = f.provider.models.find(model => model.capabilities.includes("llm.chat")); assert.ok(f.model);
  f.endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "chat_completions"); assert.ok(f.endpoint);
  Object.assign(f.env, { ABLIT_KEY: canonical, ABLITERATION_API_KEY: legacy, OTHER_KEY: "synthetic-other" });
  f.upstream = () => Response.json({ id: "synthetic-chat", model: f.model.upstream, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  f.request = manifest => f.call(manifest ? "/v1/proxy/abliteration/chat_completions" : `/v1/native/abliteration${f.endpoint.path}`,
    manifest ? { body: { model: f.model.id, messages: [{ role: "user", content: "Synthetic fixture" }], max_tokens: 16 } }
      : { model: f.model.upstream, messages: [{ role: "user", content: "Synthetic fixture" }], max_tokens: 16 },
    { headers: { "x-api-key": "synthetic-caller" } });
  t.after(f.drain); return f;
}

for (const keys of [[names[0]], [names[1]], [...names].reverse()]) for (const configured of ["canonical", "legacy", "both"]) {
  test(`Abliteration ${keys.join("+")} declaration accepts ${configured} server configuration with stable readiness and precedence`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { keys });
    if (configured === "canonical") delete f.env.ABLITERATION_API_KEY;
    if (configured === "legacy") delete f.env.ABLIT_KEY;
    const upstream = configuredUpstream(f.provider, null, f.env);
    assert.equal(upstream.headers.get("authorization"), `Bearer ${configured === "legacy" ? legacy : canonical}`);
    assert.equal(upstream.baseUrl, "https://api.abliteration.ai/v1"); assert.equal(upstream.query.size, 0);
    const ready = providerReadinessForState(f.provider, f.env, [], connection);
    assert.equal(ready.configPresent, true); assert.equal(ready.executable, true); assert.deepEqual(ready.missingConfig, []);
    assert.doesNotMatch(JSON.stringify(ready), /synthetic-/);
    assert.equal(providerSecretConfigKey(f.provider, "ABLIT_KEY"), true); assert.equal(providerSecretConfigKey(f.provider, "OTHER_KEY"), false);
    assert.equal(f.sent.length, 0);
  });
}

for (const pooled of [false, true]) for (const manifest of [false, true]) for (const configured of ["canonical", "legacy", "both"]) {
  test(`Abliteration ${pooled ? "original grant" : configured}/${manifest ? "manifest" : "native"}/${configured} dispatch preserves the selected credential and native bytes`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled });
    if (configured === "canonical") delete f.env.ABLITERATION_API_KEY;
    if (configured === "legacy") delete f.env.ABLIT_KEY;
    const response = await f.request(manifest); assert.equal(response.status, 200, response.ok ? undefined : await response.text()); await response.json(); await f.drain();
    assert.equal(f.sent.length, 1); const sent = f.sent[0];
    assert.equal(sent.url, "https://api.abliteration.ai/v1/chat/completions"); assert.equal(sent.redirect, "manual");
    assert.equal(sent.headers.get("authorization"), `Bearer ${pooled ? "synthetic-original-key" : configured === "legacy" ? legacy : canonical}`);
    assert.equal(sent.headers.get("x-api-key"), null); assert.equal((await sent.clone().json()).model, f.model.upstream);
    const rows = await f.events(); assert.equal(rows.length, 1); assert.equal(rows[0].actual_cost_micros, 700);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:original-key|canonical|legacy|caller)/);
  });
}

test("Abliteration selected grants remain authoritative even when nonselected environment values are malformed", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); f.env.ABLIT_KEY = "synthetic-private\r\ninvalid"; f.env.ABLITERATION_API_KEY = "synthetic-private\u0000";
  const response = await f.request(false); assert.equal(response.status, 200, response.ok ? undefined : await response.text()); await response.json();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  const grant = { provider: "abliteration", kind: "api_key", enabled: true, credential: "synthetic-selected" };
  const ready = providerReadinessForState(f.provider, {}, [{ key: grantKey, grant }], connection);
  assert.equal(ready.configPresent, true); assert.deepEqual(ready.missingConfig, []);
});

test("missing or malformed selected Abliteration credentials deny without echo or fallback", { timeout: 10_000 }, async t => {
  const f = await setup(t), logs = []; t.mock.method(console, "error", (...args) => logs.push(args));
  for (const credential of [undefined, "", "synthetic-private\r\ninjection", "synthetic-private\u0000", "synthetic-private\t", "synthetic private", "synthetic-private\u0100"]) {
    const grant = { provider: "abliteration", kind: "api_key", enabled: true, credential };
    const deny = fn => assert.throws(fn, error => { assert.equal(error.code, "provider_not_configured"); assert.doesNotMatch(String(error), /synthetic-private|injection/); return true; });
    deny(() => configuredUpstream(f.provider, grant, f.env));
    deny(() => assertOperationConfiguration({ provider: f.provider, endpoint: f.endpoint, mode: "http" }, grant, f.env));
    if (credential) {
      const env = { ABLIT_KEY: credential, ABLITERATION_API_KEY: legacy };
      deny(() => configuredUpstream(f.provider, null, env));
      assert.equal(providerReadinessForState(f.provider, env, [], connection).configPresent, false);
    }
  }
  assert.deepEqual(logs, []); assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

for (const scenario of ["missing", "malformed", "foreign-grant"]) test(`Abliteration ${scenario} runtime admission is zero-egress with no key echo`, { timeout: 10_000 }, async t => {
  const f = await setup(t); delete f.env.ABLIT_KEY; delete f.env.ABLITERATION_API_KEY;
  if (scenario === "malformed") { f.env.ABLIT_KEY = "synthetic-private\r\ninvalid"; f.env.ABLITERATION_API_KEY = legacy; }
  if (scenario === "foreign-grant") {
    const grant = { provider: "unrelated", kind: "api_key", enabled: true, credential: "synthetic-foreign" };
    await f.env.POLICY_KV.put("oauth/fixture/unrelated", JSON.stringify(grant));
    assert.equal(providerReadinessForState(f.provider, {}, [{ key: "oauth/fixture/unrelated", grant }], connection).configPresent, false);
  }
  const response = await f.request(false); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /synthetic-/);
  assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
});

test("canonical Abliteration aliasing does not extend to another product, destination, auth scheme or undeclared credential", { timeout: 10_000 }, async t => {
  const f = await setup(t), env = { ABLIT_KEY: canonical };
  const providers = [{ ...f.provider, id: "unrelated" }, { ...f.provider, base_urls: { default: "https://unqualified.example/v1" } },
    { ...f.provider, config_keys: [] }, { ...f.provider, config_keys: ["OTHER_KEY"] },
    ...[{ format: "Key ${secret}" }, { secretKind: "api_token" }, { header: "X-Api-Key" }].map(patch => ({ ...f.provider, auth: { ...f.provider.auth, schemes: [{ ...f.provider.auth.schemes[0], ...patch }] } }))];
  for (const provider of providers) assert.throws(() => configuredUpstream(provider, null, env), error => error.code === "provider_not_configured");
  assert.equal(f.sent.length, 0);
});
