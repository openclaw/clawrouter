import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const row = id => ({ id });
const syntheticRow = id => ({ id, name: id, context_length: 128, input_modalities: ["text"], output_modalities: ["text"], pricing: { prompt: "$0.000001" } });
const page = (ids, has_more = false) => ({ data: ids.map(row), first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null, has_more });

async function fixture(t, format, { restricted = true, timeoutMs = 30000 } = {}) {
  const anthropic = format === "anthropic.models", synthetic = format === "synthetic.models";
  const id = anthropic ? "compatible-anthropic" : synthetic ? "compatible-synthetic" : "compatible-openai";
  const provider = structuredClone(snapshot.providers.find(p => p.id === (anthropic ? "anthropic" : "openai")));
  Object.assign(provider, { id, config_keys: ["DISCOVERY_FIXTURE_API_KEY"], optional_config_keys: [],
    base_urls: { default: `https://${id}.example` }, native_prefixes: [id],
    routing: { nativePrefixes: [id], modelPrefixes: [`${id}/`], baseUrlParam: null, serviceParam: null },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
    models: [{ id: `${id}/allowed`, upstream: "allowed", capabilities: [], pricing: null, pricing_ref: null }],
    capabilities: provider.capabilities.filter(c => c.id.startsWith("models.")),
    endpoints: provider.endpoints.filter(e => synthetic ? e.id === "models_list" : e.id.startsWith("models_")).map(e => ({ ...e, timeout_ms: timeoutMs,
      ...(synthetic ? { request_format: format, response_format: format, upstreamPath: "/openai/v1/models" } : {}) })),
  });
  provider.adapter.injectHeaders = {}; provider.adapter.passthroughHeaders = [];
  snapshot.providers.push(provider); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(provider), 1));
  const values = new Map(), pending = [], sent = [], events = [], responses = [];
  const env = { DISCOVERY_FIXTURE_API_KEY: "synthetic-environment-fallback", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: restricted ? [`${id}/allowed`] : null,
    tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "fixture" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  const grantKey = `oauth/fixture/${id}`;
  await putGrantCredentials(env, grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-original-key" });
  const f = { id, env, sent, events, grantKey,
    reply: () => Response.json(anthropic ? page(["allowed"]) : synthetic ? { data: [syntheticRow("allowed")] } : { object: "list", data: [row("allowed")] }),
    async call(suffix = "", manifest = false) {
      const response = await worker.fetch(new Request(`https://router.example${manifest ? `/v1/proxy/${id}/models_list` : `/v1/native/${id}/v1/models`}${suffix}`,
        { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), env, { waitUntil: promise => pending.push(promise) });
      responses.push(response); return response;
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request, sent.length); });
  t.after(async () => {
    for (const response of responses) if (!response.bodyUsed) await response.body?.cancel();
    await f.drain();
  }, { timeout: 10000 });
  return f;
}

for (const restricted of [true, false]) test(`Synthetic data-only native/manifest discovery preserves its ${restricted ? "restricted" : "unrestricted"} caller and original grant`, { timeout: 10000 }, async t => {
  const f = await fixture(t, "synthetic.models", { restricted });
  f.reply = () => Response.json({ data: [syntheticRow("allowed"), syntheticRow("hidden")] }, { headers: { etag: "private-upstream-tag", location: "/private-upstream" } });
  for (const manifest of [false, true]) {
    const response = await f.call("", manifest), body = await response.json(); assert.equal(response.status, 200);
    assert.deepEqual(body, { data: (restricted ? ["allowed"] : ["allowed", "hidden"]).map(syntheticRow) });
    assert.equal("object" in body, false); assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(response.headers.get("etag"), null); assert.equal(response.headers.get("location"), null);
  }
  await f.drain(); assert.equal(f.sent.length, 2);
  for (const request of f.sent) {
    assert.equal(request.url, `https://${f.id}.example/openai/v1/models`); assert.equal(request.method, "GET"); assert.equal(request.body, null);
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.redirect, "manual");
  }
  const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 2);
  assert.ok(events.every(e => e.actual_cost_micros === 0 && e.reserved_cost_micros === 0));
});

test("Synthetic discovery rejects query remapping and cannot use a revoked grant's environment fallback", { timeout: 10000 }, async t => {
  const f = await fixture(t, "synthetic.models");
  for (const manifest of [false, true]) for (const query of ["?url=https://other.example", "?limit=1", "?model=hidden", "?api_key=fixture"]) {
    const response = await f.call(query, manifest), body = await response.text(); assert.equal(response.status, 400, body);
  }
  assert.equal(f.sent.length, 0); await revokeGrantCredentials(f.env, f.grantKey);
  const response = await f.call(), body = await response.text(); assert.equal(response.status, 503, body); assert.equal(f.sent.length, 0);
});

test("Synthetic native metadata requires complete bounded HTTP-200 JSON without relaxing OpenAI lists", { timeout: 10000 }, async t => {
  const f = await fixture(t, "synthetic.models", { restricted: false }), body = JSON.stringify({ data: [syntheticRow("allowed")] });
  for (const reply of [
    () => new Response(body, { status: 206, headers: { "content-type": "application/json" } }),
    () => new Response(body, { headers: { "content-type": "text/plain" } }),
    () => new Response(body, { headers: { "content-type": "application/json", "content-range": "bytes 0-10/20" } }),
    () => new Response(body, { headers: { "content-type": "application/json", "content-length": String(body.length + 1) } }),
    () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    () => new Response(body.slice(0, -1), { headers: { "content-type": "application/json" } }),
    () => Response.json({ data: [], padding: "x".repeat(2 * 1024 * 1024) }),
    () => Response.json({ data: [syntheticRow("allowed"), syntheticRow("allowed")] }),
    () => Response.json({ object: "foreign", data: [] }),
  ]) {
    f.reply = reply; const response = await f.call(), error = await response.json();
    assert.equal(response.status, 502); assert.equal(error.error.code, "invalid_model_discovery_response");
  }
  const openai = await fixture(t, "openai.models"); openai.reply = () => Response.json({ data: [{ id: "allowed" }] });
  const response = await openai.call(), error = await response.json(); assert.equal(response.status, 502); assert.equal(error.error.code, "invalid_model_discovery_response");
});

test("Synthetic empty native inventory stays empty and never revives a static seed", { timeout: 10000 }, async t => {
  const f = await fixture(t, "synthetic.models"); f.reply = () => Response.json({ data: [] });
  const response = await f.call(), body = await response.json(); assert.equal(response.status, 200); assert.deepEqual(body, { data: [] });
});

test("Synthetic discovery deadline cancels a body that has JSON but no EOF", { timeout: 10000 }, async t => {
  const f = await fixture(t, "synthetic.models", { timeoutMs: 30 }); let canceled = false;
  f.reply = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [syntheticRow("allowed")] }))); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  const response = await f.call(), body = await response.json(); assert.equal(response.status, 502); assert.equal(body.error.code, "invalid_model_discovery_response");
  assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

for (const format of ["openai.models", "anthropic.models"]) {
  test(`${format} alternate provider uses strict native and manifest envelopes with scoped grants`, async t => {
    const f = await fixture(t, format), anthropic = format === "anthropic.models";
    f.reply = () => Response.json(anthropic ? page(["allowed", "hidden"]) : { object: "list", data: [row("allowed"), row("hidden")] });
    for (const manifest of [false, true]) {
      const r = await f.call("", manifest); assert.equal(r.status, 200, await r.clone().text());
      assert.deepEqual(await r.json(), anthropic ? page(["allowed"]) : { object: "list", data: [row("allowed")] });
      assert.match(r.headers.get("cache-control"), /private, no-store/);
    }
    await f.drain();
    assert.equal(f.sent.length, 2);
    for (const request of f.sent) {
      assert.equal(request.url, `https://${f.id}.example/v1/models`);
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
      assert.equal(request.method, "GET"); assert.equal(request.body, null);
    }
    assert.ok(f.events.filter(e => e.type === "clawrouter.usage.v1").every(e => e.actual_cost_micros === 0));
  });

  test(`${format} alternate provider rejects malformed envelopes even without a model allowlist`, async t => {
    const f = await fixture(t, format, { restricted: false });
    const malformed = format === "openai.models"
      ? [{ data: [] }, { object: "wrong", data: [] }, { object: "list", data: [{}] }]
      : [{ data: [] }, { data: [], has_more: "false" }, { data: [{}], has_more: false }];
    for (const body of malformed) {
      f.reply = () => Response.json(body); const r = await f.call();
      assert.equal(r.status, 502, await r.clone().text()); assert.equal((await r.json()).error.code, "invalid_model_discovery_response");
    }
  });
}

for (const reverse of [false, true]) test(`alternate Anthropic ${reverse ? "reverse" : "forward"} pages keep the original grant and hide skipped cursors`, async t => {
  const f = await fixture(t, "anthropic.models");
  f.reply = async (_request, index) => {
    if (index === 1) {
      await putGrantCredentials(f.env, "oauth/fixture/another-catalog-key", { provider: f.id, kind: "api_key", enabled: true, credential: "synthetic-second-key" });
      return Response.json(page(["hidden-cursor"], true));
    }
    return Response.json(page(["allowed", "hidden-tail"]));
  };
  const query = reverse ? "?before_id=allowed&limit=2&lifecycle%5B%5D=active" : "?limit=2&lifecycle%5B%5D=active";
  const r = await f.call(query); assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), page(["allowed"]));
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(r => r.headers.get("authorization")), ["Bearer synthetic-original-key", "Bearer synthetic-original-key"]);
  const next = new URL(f.sent[1].url);
  assert.equal(next.searchParams.get(reverse ? "before_id" : "after_id"), "hidden-cursor");
  assert.equal(next.searchParams.get("limit"), "2"); assert.deepEqual(next.searchParams.getAll("lifecycle[]"), ["active"]);
});

test("alternate formats keep query and cursor admission before egress", async t => {
  const f = await fixture(t, "anthropic.models");
  for (const query of ["?after_id=hidden", "?before_id=hidden", "?limit=0", "?limit=1001", "?lifecycle[]=unknown", "?before_id=allowed&after_id=allowed"]) {
    const r = await f.call(query); assert.ok([400, 403].includes(r.status), await r.text());
  }
  assert.equal(f.sent.length, 0);
});

test("OpenAI-shaped discovery does not acquire Anthropic cursor semantics", async t => {
  const f = await fixture(t, "openai.models");
  for (const query of ["?limit=2", "?after_id=allowed", "?before_id=allowed", "?lifecycle[]=active"]) assert.equal((await f.call(query)).status, 400);
  assert.equal(f.sent.length, 0);
});

test("alternate Anthropic empty, cyclic and 32-page scans stay bounded", async t => {
  const f = await fixture(t, "anthropic.models");
  f.reply = () => Response.json(page(["hidden-terminal"]));
  assert.deepEqual(await (await f.call()).json(), page([]));
  f.reply = () => Response.json(page(["hidden-cycle"], true));
  const cycle = await f.call(); assert.equal(cycle.status, 502); assert.ok(!(await cycle.text()).includes("hidden-cycle"));
  const before = f.sent.length;
  f.reply = (_request, index) => Response.json(page([`hidden-${index}`], true));
  assert.equal((await f.call()).status, 502); assert.equal(f.sent.length - before, 32);
});

test("alternate discovery keeps byte limits and discards stale representation headers", async t => {
  const f = await fixture(t, "openai.models");
  f.reply = () => Response.json({ object: "list", data: [], padding: "x".repeat(2 * 1024 * 1024) });
  assert.equal((await f.call()).status, 502);
  f.reply = () => Response.json({ object: "list", data: [row("allowed"), row("hidden")] }, { headers: { etag: "hidden", location: "/hidden", "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" } });
  const r = await f.call(); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { object: "list", data: [row("allowed")] });
  for (const name of ["etag", "location", "last-modified"]) assert.equal(r.headers.get(name), null);
});

test("alternate discovery revocation cannot fall back to an environment credential", async t => {
  const f = await fixture(t, "openai.models");
  await revokeGrantCredentials(f.env, f.grantKey);
  const r = await f.call(); assert.equal(r.status, 503, await r.clone().text()); assert.equal(f.sent.length, 0);
});

test("alternate discovery deadline cancels a stalled metadata body", { timeout: 2000 }, async t => {
  const f = await fixture(t, "openai.models", { timeoutMs: 30 }); let cancelled = false;
  f.reply = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  const r = await f.call(); assert.equal(r.status, 502, await r.clone().text()); assert.equal((await r.json()).error.code, "provider_unavailable");
  assert.equal(cancelled, true); assert.equal(f.sent.length, 1);
});
