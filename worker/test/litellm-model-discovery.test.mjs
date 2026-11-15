import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const [compiled] = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/litellm.provider.yaml", import.meta.url), "utf8"))]).providers;
const selected = "tenant/synthetic-alias", hidden = "tenant/synthetic-hidden";
const row = { id: selected, object: "model", owned_by: "synthetic-tenant", model_info: { max_input_tokens: 4096, input_cost_per_token: "unqualified-unit" } };
const catalog = { object: "list", data: [row, { id: hidden }] };

async function setup(t, { base = "https://gateway.example/team/v1", pooled = true, timeout = 30000 } = {}) {
  const f = await fixture(t, { providerId: "litellm", pooled, configure(provider) {
    Object.assign(provider, structuredClone(compiled));
    provider.endpoints.find(endpoint => endpoint.id === "models_list").timeout_ms = timeout;
  } });
  Object.assign(f.env, { LITELLM_BASE_URL: base, LITELLM_API_KEY: "synthetic-environment-key", LITELLM_MODEL: selected,
    OPENAI_API_KEY: "synthetic-unrelated-key" });
  f.policy.models = [`litellm/${selected}`];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json(catalog);
  f.request = (manifest = false, suffix = "", extra = {}) => f.call(
    `${manifest ? "/v1/proxy/litellm/models_list" : "/v1/native/litellm/models"}${suffix}`, null, extra);
  return f;
}

test("LiteLLM declaration preserves configured Chat, opaque card and unknown pricing", () => {
  const endpoint = compiled.endpoints.find(value => value.id === "models_list");
  assert.equal(endpoint.method, "GET"); assert.equal(endpoint.path, "/models");
  assert.equal(endpoint.request_format, "openai.models"); assert.equal(endpoint.response_format, "openai.models");
  assert.deepEqual(endpoint.path_params, []); assert.equal(endpoint.auth, null); assert.equal(endpoint.streaming, null);
  assert.deepEqual(endpoint.query, {}); assert.equal(compiled.base_urls.default, "${base_url}");
  assert.deepEqual(compiled.config_keys, ["LITELLM_API_KEY", "LITELLM_BASE_URL", "LITELLM_MODEL"]);
  const chat = compiled.endpoints.find(value => value.id === "chat_completions");
  assert.equal(chat.path, "/chat/completions"); assert.equal(chat.streaming, "sse");
  assert.equal(compiled.models.length, 1); assert.equal(compiled.models[0].id, "litellm/configured");
  assert.equal(compiled.models[0].upstream, "${model}"); assert.equal(compiled.models[0].pricing, null);
  assert.deepEqual(compiled.models[0].capabilities, ["llm.chat"]);
});

for (const manifest of [false, true]) {
  test(`LiteLLM ${manifest ? "manifest" : "native"} list preserves original gateway key, aliases and opaque facts`, async t => {
    const f = await setup(t);
    const response = await f.request(manifest, "", { headers: { "x-api-key": "synthetic-caller-key", "x-upstream-url": "https://foreign.example" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { object: "list", data: [row] });
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://gateway.example/team/v1/models"); assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.has("x-api-key"), false); assert.equal(request.headers.has("x-upstream-url"), false);
    assert.equal(request.redirect, "manual"); assert.equal(request.body, null);
    assert.equal(f.provider.models.length, 1); assert.equal(f.provider.models[0].pricing, null);
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].grant_key, grantKey);
  });

  test(`LiteLLM ${manifest ? "manifest" : "native"} list rejects caller options before fetch`, async t => {
    const f = await setup(t);
    for (const query of ["?limit=1", "?page=2", "?model=hidden", "?url=https://foreign.example", "?api_key=synthetic"]) {
      const response = await f.request(manifest, query); assert.equal(response.status, 400); await response.text();
    }
    assert.equal(f.sent.length, 0);
  });

  test(`LiteLLM ${manifest ? "manifest" : "native"} empty inventory is authoritative and loose envelopes stay unsupported`, async t => {
    const f = await setup(t); f.upstream = () => Response.json({ object: "list", data: [] });
    const empty = await f.request(manifest); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { object: "list", data: [] });
    for (const payload of [{ data: [row] }, [row], { object: "wrong", data: [] }, { object: "list", data: [{}] }]) {
      f.upstream = () => Response.json(payload);
      const response = await f.request(manifest); assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "invalid_model_discovery_response");
    }
  });

  for (const models of [[], null]) test(`LiteLLM ${manifest ? "manifest" : "native"} final policy intersects the admitted inventory (${models === null ? "broaden" : "narrow"})`, async t => {
    const f = await setup(t);
    f.upstream = async () => {
      f.policy.models = models; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      return Response.json(catalog);
    };
    const response = await f.request(manifest); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: "list", data: models === null ? [row] : [] });
  });

  test(`LiteLLM ${manifest ? "manifest" : "native"} owner revocation during parsing withholds the list`, async t => {
    const f = await setup(t);
    f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
      await revokeGrantCredentials(f.env, grantKey);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog))); controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /tenant\/synthetic-alias|synthetic-original-key/); assert.equal(f.sent.length, 1);
  });

  for (const change of ["revoke", "destination"]) test(`LiteLLM ${manifest ? "manifest" : "native"} warm owner ${change} denies before dispatch`, async t => {
    const f = await setup(t); overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
    const warm = await f.request(manifest); assert.equal(warm.status, 200); await warm.json(); await f.drain();
    const namespace = f.env.GRANT_CREDENTIALS; let armed = true, checked = false;
    f.env.GRANT_CREDENTIALS = { ...namespace, get(name) { const owner = namespace.get(name); return { async fetch(url, init) {
      if (new URL(url).pathname === "/inspect" && armed) {
        armed = false; checked = true;
        if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
        else f.env.LITELLM_BASE_URL = "https://foreign.example/v1";
      }
      return owner.fetch(url, init);
    } }; } };
    const response = await f.request(manifest); assert.ok(response.status >= 400); await response.text();
    assert.equal(checked, true); assert.equal(f.sent.length, 1);
  });

  test(`LiteLLM ${manifest ? "manifest" : "native"} missing owner cannot use an environment or unrelated provider key`, async t => {
    const f = await setup(t, { pooled: false });
    f.policy.grantRouting = { environmentFallback: true, failover: true };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    const response = await f.request(manifest); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
  });
}

for (const base of ["https://gateway.example", "https://gateway.example/team", "https://gateway.example/team/v1"]) test(`LiteLLM preserves its explicitly configured API base (${new URL(base).pathname})`, async t => {
  const f = await setup(t, { base }); const response = await f.request(); assert.equal(response.status, 200); await response.json();
  assert.equal(f.sent[0].url, `${base}/models`);
});

for (const failure of ["abort", "deadline"]) test(`LiteLLM ${failure} cancels the incomplete catalog without a retry`, { timeout: 5000 }, async t => {
  const f = await setup(t, { timeout: failure === "deadline" ? 30 : 30000 });
  const controller = new AbortController(); let canceled = false, reached;
  const reading = new Promise(resolve => { reached = resolve; });
  f.upstream = () => new Response(new ReadableStream({ pull(stream) { reached(); }, cancel() { canceled = true; } }, { highWaterMark: 0 }),
    { headers: { "content-type": "application/json" } });
  const pending = f.request(false, "", { signal: controller.signal }); await reading;
  if (failure === "abort") controller.abort();
  const response = await pending; assert.ok(response.status >= 400); await response.text();
  assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});
