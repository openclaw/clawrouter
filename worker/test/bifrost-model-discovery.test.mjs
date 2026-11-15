import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const source = parse(readFileSync(new URL("../../providers/bifrost.provider.yaml", import.meta.url), "utf8"));
const [compiled] = compileProviderSnapshot([source]).providers;
const selected = "tenant/synthetic-allowed", hidden = "tenant/synthetic-hidden";
const catalog = ids => ({ object: "list", data: ids.map(id => ({ id, object: "model" })) });

async function setup(t, { base = "https://gateway.example/openai/v1", pooled = true, timeout = 30000 } = {}) {
  const f = await fixture(t, { providerId: "bifrost", pooled, configure(provider) {
    Object.assign(provider, structuredClone(compiled));
    provider.endpoints.find(endpoint => endpoint.id === "models_list").timeout_ms = timeout;
  } });
  Object.assign(f.env, { BIFROST_BASE_URL: base, BIFROST_API_KEY: "synthetic-environment-key", BIFROST_MODEL: selected });
  f.policy.models = [`bifrost/${selected}`];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json(catalog([selected, hidden]));
  f.request = (manifest = false, suffix = "", extra = {}) => f.call(
    `${manifest ? "/v1/proxy/bifrost/models_list" : "/v1/native/bifrost/models"}${suffix}`, null, extra);
  return f;
}

test("Bifrost discovery preserves the configured Chat/card/auth contract", () => {
  const endpoint = compiled.endpoints.find(value => value.id === "models_list");
  assert.equal(endpoint.method, "GET"); assert.equal(endpoint.path, "/models");
  assert.equal(endpoint.request_format, "openai.models"); assert.equal(endpoint.response_format, "openai.models");
  assert.equal(endpoint.auth, null); assert.equal(endpoint.streaming, null); assert.deepEqual(endpoint.query, {});
  assert.equal(compiled.base_urls.default, "${base_url}");
  assert.deepEqual(compiled.config_keys, ["BIFROST_API_KEY", "BIFROST_BASE_URL", "BIFROST_MODEL"]);
  assert.equal(compiled.endpoints.find(value => value.id === "chat_completions").path, "/chat/completions");
  assert.equal(compiled.models.length, 1); assert.equal(compiled.models[0].id, "bifrost/configured");
  assert.equal(compiled.models[0].upstream, "${model}"); assert.equal(compiled.models[0].pricing, null);
  assert.deepEqual(compiled.models[0].capabilities, ["llm.chat"]);
});

for (const manifest of [false, true]) {
  test(`Bifrost ${manifest ? "manifest" : "native"} discovery uses the original managed key and configured API base`, async t => {
    const f = await setup(t);
    const response = await f.request(manifest, "", { headers: { "x-api-key": "synthetic-caller-key", "x-upstream-url": "https://foreign.example" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), catalog([selected]));
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://gateway.example/openai/v1/models"); assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.has("x-api-key"), false); assert.equal(request.headers.has("x-upstream-url"), false);
    assert.equal(request.body, null); assert.equal(request.redirect, "manual");
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, 0); // Metadata charge, never an inference tariff.
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} discovery rejects every caller query override`, async t => {
    const f = await setup(t);
    for (const suffix of ["?limit=1", "?after_id=hidden", "?model=hidden", "?url=https://foreign.example", "?api_key=synthetic"]) {
      const response = await f.request(manifest, suffix); assert.equal(response.status, 400); await response.text();
    }
    assert.equal(f.sent.length, 0);
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} discovery preserves empty inventory and rejects malformed lists`, async t => {
    const f = await setup(t); f.upstream = () => Response.json(catalog([]));
    const empty = await f.request(manifest); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), catalog([]));
    for (const payload of [{ data: [] }, { object: "wrong", data: [] }, { object: "list", data: [{}] }]) {
      f.upstream = () => Response.json(payload);
      const response = await f.request(manifest); assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "invalid_model_discovery_response");
    }
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} discovery filters with policy tightened during the complete read`, async t => {
    const f = await setup(t);
    f.upstream = () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog([selected, hidden]))));
      f.policy.models = [];
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      controller.close();
    } }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), catalog([])); assert.equal(f.sent.length, 1);
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} discovery withholds a catalog after original-owner revocation during parsing`, async t => {
    const f = await setup(t);
    f.upstream = () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog([selected]))));
      await revokeGrantCredentials(f.env, grantKey); controller.close();
    } }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /tenant\/synthetic-allowed|synthetic-original-key/);
    assert.equal(f.sent.length, 1);
  });

  for (const change of ["revoke", "destination"]) test(`Bifrost ${manifest ? "manifest" : "native"} warm discovery rechecks ${change} before physical fetch`, async t => {
    const f = await setup(t);
    overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
    const warm = await f.request(manifest); assert.equal(warm.status, 200); await warm.json(); await f.drain();
    const namespace = f.env.GRANT_CREDENTIALS; let armed = true, checked = false;
    f.env.GRANT_CREDENTIALS = { ...namespace, get(name) { const owner = namespace.get(name); return { async fetch(url, init) {
      if (new URL(url).pathname === "/inspect" && armed) {
        armed = false; checked = true;
        if (change === "revoke") await revokeGrantCredentials(f.env, grantKey);
        else f.env.BIFROST_BASE_URL = "https://foreign.example/openai/v1";
      }
      return owner.fetch(url, init);
    } }; } };
    const response = await f.request(manifest); assert.ok(response.status >= 400); await response.text(); await f.drain();
    assert.equal(checked, true); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} policy broadening cannot expand the admitted inventory`, async t => {
    const f = await setup(t);
    f.upstream = async () => {
      f.policy.models = null;
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      return Response.json(catalog([selected, hidden]));
    };
    const response = await f.request(manifest); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), catalog([selected])); assert.equal(f.sent.length, 1);
  });

  test(`Bifrost ${manifest ? "manifest" : "native"} revoked owner cannot use explicitly enabled environment fallback`, async t => {
    const f = await setup(t);
    f.policy.grantRouting = { eligibleGrants: { bifrost: ["replicate"] }, environmentFallback: true, failover: true };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    await revokeGrantCredentials(f.env, grantKey);
    const response = await f.request(manifest); assert.ok(response.status >= 400); await response.text();
    assert.equal(f.sent.length, 0);
  });
}

test("Bifrost catalog cannot substitute an environment credential for its managed owner", async t => {
  const f = await setup(t, { pooled: false }); const response = await f.request();
  assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("Bifrost discovery retains the configured base without an implicit version rewrite", async t => {
  const f = await setup(t, { base: "https://gateway.example/custom/openai" });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.equal(f.sent[0].url, "https://gateway.example/custom/openai/models");
});

test("Bifrost discovery deadline cancels an incomplete response without publication", { timeout: 10000 }, async t => {
  const f = await setup(t, { timeout: 20 }); let canceled = false;
  f.upstream = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(catalog([selected]))));
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  const response = await f.request(); assert.equal(response.status, 502); await response.text();
  assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});
