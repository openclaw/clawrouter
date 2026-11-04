import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");

const contracts = {
  cerebras: { base: "https://api.cerebras.ai/v1", format: "cerebras.public_catalog", urls: ["https://api.cerebras.ai/public/v1/models"] },
  nvidia: { base: "https://integrate.api.nvidia.com/v1", format: "nvidia.public_catalog", urls: ["https://integrate.api.nvidia.com/v1/models", "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json"] },
  chutes: { base: "https://llm.chutes.ai/v1", format: "chutes.models", urls: ["https://llm.chutes.ai/v1/models"] },
  venice: { base: "https://api.venice.ai/api/v1", format: "venice.models", urls: ["https://api.venice.ai/api/v1/models?type=text"] },
};
const ids = ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b"];
const endpointId = id => ["cerebras", "nvidia"].includes(id) ? "public_models" : "models_list";
const modelIds = id => id === "nvidia" ? ids : ["one", "two"];
function payload(id, values = modelIds(id)) {
  return { object: "list", ...(id === "venice" ? { type: "text" } : {}), data: values.map(value => ({ id: value, object: "model",
    ...(id === "venice" ? { type: "text" } : {}), ...(id === "cerebras" ? { limits: { max_context_length: 4096, max_completion_tokens: 512 } } : {}) })) };
}
function rows(id, body) { return ["cerebras", "nvidia"].includes(id) ? body.catalog : body.data; }

async function setup(t, id, { restricted = false, timeout = 10000 } = {}) {
  const contract = contracts[id], original = [...snapshot.providers], template = structuredClone(original.find(provider => provider.id === "openai"));
  const endpoint = { ...template.endpoints.find(value => value.id === "models_list"), id: endpointId(id), method: "GET", methods: ["GET"],
    path: "/models", path_params: [], path_param_styles: {}, query: {}, headers: { "x-static-private": "synthetic-static-value" },
    request_format: contract.format, response_format: contract.format, timeout_ms: timeout,
    // Intentionally malformed for aggregate formats: common gates must still refuse native exposure.
    native_proxy: true };
  const f = await fixture(t, { pooled: true, providerId: id, configure(provider) {
    Object.assign(provider, template, { id, config_keys: ["CATALOG_API_KEY"], optional_config_keys: [], base_urls: { default: contract.base },
      native_prefixes: [id], routing: { nativePrefixes: [id], modelPrefixes: [`${id}/`], baseUrlParam: null, serviceParam: null },
      auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} },
      adapter: { ...template.adapter, injectHeaders: { "x-private-static": "synthetic-static-value" }, injectQuery: {}, passthroughHeaders: ["x-account"] },
      capabilities: [{ id: "models.list", endpoint: endpointId(id), methods: ["GET"] }], endpoints: [endpoint],
      models: modelIds(id).map(upstream => ({ id: `${id}/${upstream}`, upstream, capabilities: [], pricing: null, pricing_ref: null })) });
  } });
  // Discovery projections are keyed by compiled provider object identity.
  const provider = structuredClone(f.provider);
  snapshot.providers = snapshot.providers.map(value => value === f.provider ? provider : value);
  f.provider = provider; t.after(() => { snapshot.providers = original; });
  f.env.CATALOG_API_KEY = "synthetic-environment-must-not-replace-owner";
  f.policy.models = restricted ? [`${id}/${modelIds(id)[0]}`] : null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = request => Response.json(request.url.includes("featured-models.json") ? { "featured-models": [] } : payload(id));
  f.metadata = (native = false, query = "", options = {}) => f.call(`${native ? `/v1/native/${id}/models` : `/v1/proxy/${id}/${endpointId(id)}`}${query}`, native ? null : { method: "GET", body: {}, query: {}, pathParams: {} },
    { ...options, headers: { "x-api-key": "synthetic-caller-key", "x-account": "foreign", ...options.headers } });
  f.disable = () => putGrantCredentials(f.env, grantKey, { provider: id, kind: "api_key", enabled: false, credential: "synthetic-original-key" });
  t.after(f.drain); return f;
}

for (const id of Object.keys(contracts)) {
  test(`${id} real Worker uses fixed public factories, filters original caller IDs and accounts metadata only`, async t => {
    const f = await setup(t, id, { restricted: true });
    const response = await f.metadata(), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(rows(id, body).map(row => row.id), [modelIds(id)[0]]);
    if (["cerebras", "nvidia"].includes(id)) assert.deepEqual(Object.keys(body).sort(), ["catalog", "providerId"]);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.deepEqual(f.sent.map(request => request.url), contracts[id].urls);
    for (const request of f.sent) {
      assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.credentials, "omit");
      assert.deepEqual([...request.headers], [["accept", "application/json"]]); assert.equal(request.redirect, "manual");
    }
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].model, null);
  });

  test(`${id} final publication intersects current policy after complete parsing`, async t => {
    const f = await setup(t, id), bytes = new TextEncoder().encode(JSON.stringify(payload(id))); let sent = false;
    f.upstream = request => request.url.includes("featured-models.json") ? Response.json({ "featured-models": [] }) : new Response(new ReadableStream({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); return; }
        f.policy.models = [`${id}/${modelIds(id)[1]}`, `${id}/never-admitted`];
        await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.metadata(), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(rows(id, body).map(row => row.id), [modelIds(id)[1]]);
    assert.equal(f.sent.length, contracts[id].urls.length);
  });

  test(`${id} caller query and unbound environment authority never reach public metadata`, async t => {
    const f = await setup(t, id);
    const query = await f.metadata(false, "?url=https%3A%2F%2Fother.example%2Fmodels"); assert.equal(query.status, 400);
    assert.equal((await query.json()).error.code, "invalid_model_discovery");
    assert.equal(f.sent.length, 0);
    await f.disable(); const response = await f.metadata(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
  });
}

for (const id of ["cerebras", "nvidia"]) test(`${id} manifest-only aggregate never advertises or accepts an invented native route`, async t => {
  const f = await setup(t, id), denied = await f.metadata(true); assert.equal(denied.status, 404); await denied.text();
  const response = await f.call("/v1/catalog", null), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  const provider = body.providers.find(value => value.id === id); assert.ok(provider);
  const offers = provider.offers.filter(value => value.endpoint === endpointId(id)); assert.ok(offers.length);
  assert.ok(offers.every(offer => offer.routeKind === "manifest" && offer.route === `/v1/proxy/${id}/${endpointId(id)}`));
  assert.equal(provider.routes[0].requestFormat, contracts[id].format); assert.equal(f.sent.length, 0);
});

for (const id of ["chutes", "venice"]) test(`${id} qualified native catalog retains its vendor envelope`, async t => {
  const f = await setup(t, id), response = await f.metadata(true); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload(id)); assert.equal(f.sent.length, 1);
});

test("NVIDIA revocation between its two physical requests stops the second request without environment fallback", async t => {
  const f = await setup(t, "nvidia"); overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  f.upstream = async () => { await f.disable(); return Response.json(payload("nvidia")); };
  const response = await f.metadata(); assert.ok(response.status >= 400); await response.text();
  assert.deepEqual(f.sent.map(request => request.url), [contracts.nvidia.urls[0]]);
});

test("NVIDIA fresh empty inventory is authoritative across requests and still performs exactly two public fetches", async t => {
  const f = await setup(t, "nvidia"), first = await f.metadata(); assert.equal((await first.json()).catalog.length, 2);
  f.upstream = request => Response.json(request.url.includes("featured-models.json") ? { "featured-models": [] } : payload("nvidia", []));
  const second = await f.metadata(); assert.equal(second.status, 200); assert.deepEqual(await second.json(), { providerId: "nvidia", catalog: [] });
  assert.deepEqual(f.sent.map(request => request.url), [...contracts.nvidia.urls, ...contracts.nvidia.urls]);
});

test("public catalog final owner check discards a complete response after original grant revocation", async t => {
  const f = await setup(t, "chutes"), bytes = new TextEncoder().encode(JSON.stringify(payload("chutes"))); let sent = false;
  f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
    if (!sent) { sent = true; controller.enqueue(bytes); return; }
    await f.disable(); controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.metadata(); assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /nemotron|synthetic-original-key/);
  assert.equal(f.sent.length, 1);
});

test("public catalog request cancellation reaches the physical fetch and prevents a second NVIDIA request", async t => {
  const f = await setup(t, "nvidia"), controller = new AbortController(); let observed;
  f.upstream = request => new Promise((resolve, reject) => {
    observed = request.signal; request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); controller.abort();
  });
  const response = await f.metadata(false, "", { signal: controller.signal }); await response.text();
  assert.equal(observed.aborted, true); assert.equal(f.sent.length, 1); assert.ok(response.status >= 400);
});

for (const change of ["origin", "format-pair", "auth", "path-override", "query"]) test(`public catalog denies configured ${change} substitution before fetch`, async t => {
  const f = await setup(t, "chutes"), endpoint = f.provider.endpoints[0];
  if (change === "origin") f.provider.base_urls.default = "https://other.example/v1";
  if (change === "format-pair") endpoint.response_format = "openai.models";
  if (change === "auth") endpoint.auth = "none";
  if (change === "path-override") endpoint.upstreamPath = "/other/models";
  if (change === "query") endpoint.query = { account: "foreign" };
  const response = await f.metadata(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

for (const [name, value] of Object.entries({ headers: { authorization: "Bearer synthetic-caller-key" }, transport: "oauth", url: "https://other.example/models",
  model: "foreign", body: { model: "foreign" }, query: { account: "foreign" }, pathParams: { model_id: "foreign" }, method: "POST" })) {
  test(`public aggregate manifest rejects caller ${name} overrides before fetch`, async t => {
    const f = await setup(t, "cerebras"), response = await f.call("/v1/proxy/cerebras/public_models", { [name]: value });
    assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
  });
}
