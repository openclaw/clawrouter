import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot, upstreamPath, configuredUpstream } = await import("../providers.ts");
const { assertOperationConfiguration } = await import("../provider-auth.ts");
const { configuredEndpointPath } = await import("../endpoint-path.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

async function setup(t, options = {}) {
  const id = options.providerId ?? "opencode-go", original = snapshot.providers;
  const source = structuredClone(original.find(provider => provider.id === id)); assert.ok(source);
  snapshot.providers = original.filter(provider => provider.id !== id); t.after(() => { snapshot.providers = original; });
  const path = `/inference${id === "opencode-go" ? "/go" : ""}/openai/v1/responses`;
  const f = await fixture(t, { ...options, providerId: id, configure(provider) {
    Object.assign(provider, source); provider.base_urls.default = "https://opencode.ai";
    const endpoint = { ...structuredClone(provider.endpoints[0]), id: "responses", path: "/v1/responses", upstreamPath: path,
      request_format: "openai.responses", response_format: "openai.responses", streaming: "sse", modelPassthrough: undefined,
      query: {}, headers: { "content-type": "application/json" }, request_headers: [] };
    provider.endpoints.push(endpoint); provider.capabilities.push({ id: "llm.responses", endpoint: "responses", methods: ["POST"] });
    // Synthetic model qualifies path mechanics, not an OpenCode native offer.
    provider.models.push({ ...structuredClone(provider.models[0]), id: `${id}/fixture-responses`, upstream: "fixture-responses", capabilities: ["llm.responses"], pricing: null, pricing_ref: null });
  } });
  f.env[source.config_keys[0]] = "synthetic-mapped-environment"; f.endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "responses");
  f.upstream = request => {
    const response = { id: "resp_fixture", object: "response", status: "completed", model: "fixture-responses", output: [], usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } };
    f.wire = options.stream ? frame({ type: "response.completed", response }) : JSON.stringify(response);
    return new Response(f.wire, { headers: { "content-type": options.stream ? "text/event-stream" : "application/json" } });
  };
  f.request = ({ manifest = options.manifest, query = "", route, model = manifest ? `${id}/fixture-responses` : "fixture-responses", ...extra } = {}) => {
    const body = { model, input: "Synthetic request", max_output_tokens: 16, store: false, stream: !!options.stream };
    return f.call((route ?? (manifest ? `/v1/proxy/${id}/responses` : `/v1/native/${id}/v1/responses`)) + query,
      manifest ? { body } : body, { ...extra, headers: { "x-api-key": "synthetic-caller", ...extra.headers } });
  };
  t.after(f.drain); return f;
}

for (const providerId of ["opencode", "opencode-go"]) for (const manifest of [false, true]) for (const pooled of [false, true]) for (const stream of [false, true]) {
  test(`Responses mapping ${providerId}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"}/${stream ? "SSE" : "JSON"} keeps the original route, model and credential`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { providerId, manifest, pooled, stream }), response = await f.request();
    assert.equal(response.status, 200, response.ok ? undefined : await response.text()); assert.equal(await response.text(), f.wire); await f.drain();
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, `https://opencode.ai${f.endpoint.upstreamPath}`); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-mapped-environment");
    assert.equal(request.headers.get("x-api-key"), null);
    assert.deepEqual(await request.clone().json(), { model: "fixture-responses", input: "Synthetic request", max_output_tokens: 16, store: false, stream });
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].model, `${providerId}/fixture-responses`);
    assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], [11, 3, 14]);
    assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  });
}

test("Responses mapped path grammar is identical at preflight and dispatch", { timeout: 10_000 }, async t => {
  const f = await setup(t), endpoint = f.endpoint, original = endpoint.upstreamPath;
  for (const path of ["https://unqualified.example/v1/responses", "//unqualified.example", "/a/../b", "/a/./b", "/a/%2e%2e/b", "/a%2fb", "/a\\b", "/a//b", "/a/", "/a?x=1", "/a#b", "/${model}", original + "\n", original + "\r", original + "\r\n"]) {
    endpoint.upstreamPath = path;
    assert.throws(() => assertOperationConfiguration({ provider: f.provider, endpoint, mode: "http" }, null, f.env), error => error.code === "provider_request_invalid");
    assert.throws(() => upstreamPath(f.provider, endpoint, {}, f.env, configuredUpstream(f.provider, null, f.env)), error => error.code === "provider_request_invalid");
  }
  endpoint.upstreamPath = original;
  for (const patch of [{ method: "GET", methods: ["GET"] }, { methods: ["POST", "GET"] }, { path: "/responses" }, { path: "/v1/responses\n" },
    { websocket: "openai.responses" }, { query: { x: "1" } }, { path_params: ["model"] }, { response_format: "openai.chat_completions" }, { responsesLifecycle: {} }])
    assert.throws(() => configuredEndpointPath({ ...endpoint, ...patch }), error => error.code === "provider_request_invalid");
  assert.throws(() => configuredEndpointPath(endpoint, "/another/route"), error => error.code === "provider_request_invalid");
  for (const base of ["https://synthetic:secret@opencode.ai", "https://opencode.ai?next=", "https://opencode.ai#next"])
    assert.throws(() => configuredEndpointPath(endpoint, undefined, base), error => error.code === "provider_request_invalid");
  assert.equal(f.sent.length, 0);
});

for (const manifest of [false, true]) test(`Responses ${manifest ? "manifest" : "native"} caller query cannot override mapping or origin`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { manifest });
  for (const query of ["?upstreamPath=/other", "?base_url=https://unqualified.example", "?model=other"]) {
    const response = await f.request({ query }); assert.equal(response.status, 400); await response.text();
  }
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path !== "/reserve"));
});

test("mapped Responses cannot expose its upstream suffix as a new public route or revive a revoked grant", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const hidden = await f.request({ route: `/v1/native/opencode-go${f.endpoint.upstreamPath}` }); assert.equal(hidden.status, 404); await hidden.text(); assert.equal(f.sent.length, 0);
  const first = await f.request(); assert.equal(first.status, 200, first.ok ? undefined : await first.text()); await first.text(); await f.drain();
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await f.request(); assert.equal(denied.status, 503); await denied.text(); assert.equal(f.sent.length, 1);
});
