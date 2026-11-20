import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url)));
const titan = wire.cases[0], region = "us-east-1", origin = `https://bedrock-runtime.${region}.amazonaws.com`;

async function setup(t, options = {}) {
  const original = snapshot.providers, source = structuredClone(options.source ?? original.find(provider => provider.id === "aws-bedrock")); assert.ok(source);
  snapshot.providers = original.filter(provider => provider.id !== source.id); t.after(() => { snapshot.providers = original; });
  let embeddingEndpoint;
  const f = await fixture(t, { ...options, providerId: source.id, configure(provider) {
    Object.assign(provider, source);
    // Use the actual declaration when present. The fallback only supplies the
    // candidate route before source-owned YAML/snapshot integration.
    const bindings = provider.capabilities.filter(capability => capability.id === "llm.embeddings");
    assert.ok(bindings.length <= 1, "fixture requires one explicit embedding route");
    if (bindings.length) {
      embeddingEndpoint = provider.endpoints.find(endpoint => endpoint.id === bindings[0].endpoint);
      assert.ok(embeddingEndpoint, "declared embedding endpoint must exist");
    } else {
      embeddingEndpoint = { ...structuredClone(provider.endpoints.find(endpoint => endpoint.id === "invoke_model")), id: "embed", modelPassthrough: undefined,
        streaming: null, request_headers: [] };
      provider.endpoints.push(embeddingEndpoint); provider.capabilities.push({ id: "llm.embeddings", endpoint: embeddingEndpoint.id, methods: ["POST"] });
    }
    if (options.reverse) provider.endpoints.reverse();
    const item = options.item ?? titan, id = `bedrock/${item.model}`;
    const model = provider.models.find(model => model.id === id)
      ?? { ...structuredClone(provider.models[0]), inference: undefined, nativeCapabilities: undefined };
    provider.models = provider.models.filter(model => model.id !== id);
    provider.models.push({ ...structuredClone(model), id, upstream: item.model, capabilities: ["llm.embeddings"], pricing: null });
  } });
  Object.assign(f.env, { AWS_ACCESS_KEY_ID: "synthetic-env-access", AWS_SECRET_ACCESS_KEY: "synthetic-env-secret",
    AWS_SESSION_TOKEN: "synthetic-env-session", AWS_REGION: region });
  if (options.pooled) await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true,
    credentials: { accessKeyId: "synthetic-grant-access", secretAccessKey: "synthetic-grant-secret", sessionToken: "synthetic-grant-session" } });
  f.embeddingEndpoint = embeddingEndpoint.id;
  f.item = options.item ?? titan;
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => { f.dispatch = { rows: f.rows(), capacity: bodyBudgetCharged() };
    return options.response ? options.response(request) : Response.json(f.item.response, { headers: { "x-private-upstream": "synthetic" } }); };
  f.request = ({ manifest = false, model = f.item.model, body = f.item.body, query = "", endpoint = f.embeddingEndpoint, ...extra } = {}) => f.call(
    (manifest ? `/v1/proxy/aws-bedrock/${endpoint}` : `/v1/native/aws-bedrock/model/${encodeURIComponent(model)}/invoke`) + query,
    manifest ? { body, pathParams: { model } } : body, { ...extra, headers: { "x-amz-security-token": "synthetic-caller-session", "x-api-key": "synthetic-caller", ...extra.headers } });
  t.after(f.drain); return f;
}
async function event(f) { await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1); assert.equal(bodyBudgetCharged(), 0); return rows[0]; }
async function denied(f, request = {}) {
  const response = await f.request(request), text = await response.text(); assert.ok(response.status >= 400, text);
  assert.doesNotMatch(text, /synthetic-(?:env|grant|caller)/); assert.equal(f.sent.length, 0); await f.drain();
  assert.ok((await f.events()).every(row => row.actual_cost_micros === 0)); assert.equal(bodyBudgetCharged(), 0); return response;
}

const declaredTextCases = wire.cases.filter(item => item.model !== "amazon.titan-embed-image-v1");
async function compiledSetup(t, { reverse = false, fixed = 700 } = {}) {
  const f = await fixture(t, { providerId: "aws-bedrock", compiledProvider: true, fixed,
    configure(provider) { if (reverse) provider.endpoints.reverse(); } });
  // No card or route insertion: these requests must exercise the shipped snapshot.
  const cards = structuredClone(f.provider.models);
  assert.deepEqual(cards.filter(model => model.capabilities.includes("llm.embeddings")).map(model => model.upstream),
    declaredTextCases.map(item => item.model));
  t.after(() => assert.deepEqual(f.provider.models, cards));
  Object.assign(f.env, { AWS_ACCESS_KEY_ID: "synthetic-env-access", AWS_SECRET_ACCESS_KEY: "synthetic-env-secret",
    AWS_SESSION_TOKEN: "synthetic-env-session", AWS_REGION: region });
  await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true,
    credentials: { accessKeyId: "synthetic-grant-access", secretAccessKey: "synthetic-grant-secret", sessionToken: "synthetic-grant-session" } });
  f.upstream = () => Response.json(titan.response);
  f.request = ({ model = titan.model, body = titan.body, manifest = false, ...extra } = {}) => f.call(
    manifest ? "/v1/proxy/aws-bedrock/embed_text" : `/v1/native/aws-bedrock/model/${encodeURIComponent(model)}/invoke`,
    manifest ? { body, pathParams: { model } } : body,
    { ...extra, headers: { "x-amz-security-token": "synthetic-caller-session", "x-api-key": "synthetic-caller", ...extra.headers } });
  t.after(f.drain); return f;
}
async function signedDispatch(f, model, body) {
  assert.equal(f.sent.length, 1);
  const sent = f.sent[0], raw = await sent.clone().text();
  assert.equal(sent.url, `${origin}/model/${encodeURIComponent(model)}/invoke`);
  assert.equal(sent.method, "POST"); assert.equal(sent.redirect, "manual");
  assert.equal(raw, JSON.stringify(body));
  assert.equal(sent.headers.get("x-amz-content-sha256"), createHash("sha256").update(raw).digest("hex"));
  assert.match(sent.headers.get("authorization"), new RegExp(`^AWS4-HMAC-SHA256 Credential=synthetic-grant-access/\\d{8}/${region}/bedrock/aws4_request,`));
  assert.equal(sent.headers.get("x-amz-security-token"), "synthetic-grant-session"); assert.equal(sent.headers.get("x-api-key"), null);
  const settled = await event(f);
  assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.cost_basis, "policy_fixed");
  assert.doesNotMatch(JSON.stringify(settled), /synthetic-(?:env|grant|caller)/);
  return settled;
}

for (const reverse of [false, true]) test(`compiled Bedrock ordinary unknown Invoke remains signed and paid exactly once: reversed=${reverse}`, { timeout: 10_000 }, async t => {
  const f = await compiledSetup(t, { reverse }), model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
  const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: 8, messages: [{ role: "user", content: "Synthetic ordinary Invoke" }] };
  const output = { content: [{ type: "text", text: "Synthetic result" }], usage: { input_tokens: 3, output_tokens: 2 } };
  assert.equal(f.provider.models.some(card => card.upstream === model), false);
  f.upstream = () => Response.json(output);
  const response = await f.request({ model, body }); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), output);
  const settled = await signedDispatch(f, model, body); assert.equal(settled.capability, "llm.invoke");
});

for (const reverse of [false, true]) for (const manifest of [false, true]) for (const item of declaredTextCases) {
  test(`compiled Bedrock ${item.model} is registered without fixture cards: manifest=${manifest}, reversed=${reverse}`, { timeout: 10_000 }, async t => {
    const f = await compiledSetup(t, { reverse }); f.upstream = () => Response.json(item.response);
    const response = await f.request({ model: item.model, body: item.body, manifest });
    assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), item.response);
    const settled = await signedDispatch(f, item.model, item.body);
    assert.equal(settled.model, `bedrock/${item.model}`); assert.equal(settled.capability, "llm.embeddings");
    assert.equal(settled.input_tokens, item.inputTokens); assert.equal(settled.output_tokens, null); assert.equal(settled.total_tokens, null);
  });
}

for (const model of ["cohere.embed-english-v3", "cohere.embed-multilingual-v3"]) for (const manifest of [false, true]) {
  for (const shape of ["default-array", "explicit-array", "explicit-keyed"]) {
    test(`compiled Bedrock ${model} preserves the complete ${shape} native envelope: manifest=${manifest}`, { timeout: 10_000 }, async t => {
      const f = await compiledSetup(t), item = wire.cases.find(item => item.model === model);
      const body = { ...item.body, ...(shape !== "default-array" ? { embedding_types: ["float"] } : {}) };
      const output = { ...item.response, embeddings: shape === "explicit-keyed" ? { float: item.response.embeddings } : item.response.embeddings,
        response_type: shape === "default-array" ? "embeddings_floats" : "embeddings_by_type" };
      f.upstream = () => Response.json(output);
      const response = await f.request({ model, body, manifest }); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await response.text(), JSON.stringify(output));
      const settled = await signedDispatch(f, model, body);
      assert.equal(settled.input_tokens, null); assert.equal(settled.output_tokens, null); assert.equal(settled.total_tokens, null);
      assert.equal(settled.model, `bedrock/${model}`); assert.equal(settled.capability, "llm.embeddings");
    });
  }

  for (const embedding_types of [["int8"], ["float", "int8"]]) {
    test(`compiled Bedrock ${model} rejects ${embedding_types.join("+")} before dispatch: manifest=${manifest}`, { timeout: 10_000 }, async t => {
      const f = await compiledSetup(t), item = wire.cases.find(item => item.model === model);
      const response = await denied(f, { model, body: { ...item.body, embedding_types }, manifest });
      assert.equal(response.status, 400);
    });
  }

  for (const failure of ["unrequested-keyed", "missing-float", "null-float", "mixed-types", "later-vector", "wrong-count", "native-error", "incomplete-json"]) {
    test(`compiled Bedrock ${model} ${failure} exposes no partial result or retry: manifest=${manifest}`, { timeout: 10_000 }, async t => {
      const f = await compiledSetup(t), item = wire.cases.find(item => item.model === model);
      const body = { ...item.body, texts: [item.body.texts[0], "Synthetic later document"],
        ...(failure === "unrequested-keyed" ? {} : { embedding_types: ["float"] }) };
      const vectors = [item.response.embeddings[0], item.response.embeddings[0]];
      let output = { embeddings: { float: vectors } };
      if (failure === "missing-float") output.embeddings = {};
      if (failure === "null-float") output.embeddings.float = null;
      if (failure === "mixed-types") output.embeddings.int8 = vectors;
      if (failure === "later-vector") output.embeddings.float = [vectors[0], [1]];
      if (failure === "wrong-count") output.embeddings.float = [vectors[0]];
      if (failure === "native-error") output.error = "SyntheticFailure";
      f.upstream = () => failure === "incomplete-json"
        ? new Response(JSON.stringify(output).slice(0, -1), { headers: { "content-type": "application/json" } }) : Response.json(output);
      const response = await f.request({ model, body, manifest }); assert.equal(response.status, 502);
      const deniedBody = await response.json(); assert.equal(deniedBody.error.code, "provider_unavailable");
      assert.equal(deniedBody.embeddings, undefined); assert.doesNotMatch(JSON.stringify(deniedBody), /SyntheticFailure|synthetic-(?:env|grant|caller)/);
      const settled = await signedDispatch(f, model, body);
      assert.equal(settled.input_tokens, null); assert.equal(settled.output_tokens, null); assert.equal(settled.total_tokens, null);
    });
  }
}

for (const reverse of [false, true]) for (const model of ["amazon.titan-embed-image-v1", "us.amazon.titan-embed-text-v2:0:2:8k", "twelvelabs.marengo-embed-2-7-v1:0"]) {
  test(`compiled Bedrock recognized but unregistered embedding cannot use Invoke: ${model}, reversed=${reverse}`, { timeout: 10_000 }, async t => {
    const f = await compiledSetup(t, { reverse });
    assert.equal(f.provider.models.some(card => card.upstream === model), false);
    const response = await f.request({ model }); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "native_embedding_route_required");
    assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.some(call => call.path === "/reserve"), false);
    await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0)); assert.equal(bodyBudgetCharged(), 0);
  });
}

for (const scenario of ["hard-budget", "revoked-policy", "wrong-provider", "incomplete-original-grant", "invalid-proxy-key"]) {
  for (const model of [titan.model, "anthropic.claude-3-5-sonnet-20240620-v1:0"]) {
    test(`compiled Bedrock ${scenario} stays zero-egress after native selection: ${model}`, { timeout: 10_000 }, async t => {
      const f = await compiledSetup(t, { reverse: true, fixed: scenario === "hard-budget" ? null : 700 });
      if (scenario === "revoked-policy" || scenario === "wrong-provider") {
        if (scenario === "revoked-policy") f.policy.enabled = false;
        else f.policy.providers = ["google-gemini"];
        await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      }
      if (scenario === "incomplete-original-grant") await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true,
        credentials: { accessKeyId: "synthetic-grant-access" } });
      const response = await f.request({ model, ...(scenario === "invalid-proxy-key" ? { headers: { authorization: "Bearer synthetic-invalid" } } : {}) });
      const text = await response.text(); assert.ok(response.status >= 400, text);
      const expected = { "hard-budget": "pricing_required", "revoked-policy": "policy_revoked", "wrong-provider": "provider_not_allowed",
        "incomplete-original-grant": "upstream_grant_pool_unavailable", "invalid-proxy-key": "invalid_proxy_key" };
      assert.equal(JSON.parse(text).error.code, expected[scenario]); assert.doesNotMatch(text, /synthetic-(?:env|grant|caller)/);
      assert.equal(f.sent.length, 0); await f.drain();
      assert.ok((await f.events()).every(row => row.actual_cost_micros === 0)); assert.equal(bodyBudgetCharged(), 0);
      if (scenario === "hard-budget") assert.equal(response.status, 400);
    });
  }
}

for (const [index, item] of wire.cases.entries()) test(`Bedrock real signed native memory dispatch preserves ${item.model} and complete vectors`, { timeout: 10_000 }, async t => {
  const pooled = index % 2 === 0, manifest = index % 3 === 0, f = await setup(t, { pooled, item, reverse: pooled });
  const response = await f.request({ manifest }); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  assert.deepEqual(await response.json(), item.response); assert.equal(response.headers.get("x-private-upstream"), null);
  assert.equal(f.sent.length, 1); const sent = f.sent[0], text = await sent.clone().text();
  assert.equal(sent.url, `${origin}/model/${encodeURIComponent(item.model)}/invoke`); assert.equal(sent.method, "POST"); assert.equal(sent.redirect, "manual");
  assert.deepEqual(JSON.parse(text), item.body); assert.equal(sent.headers.get("x-amz-content-sha256"), createHash("sha256").update(text).digest("hex"));
  assert.match(sent.headers.get("authorization"), new RegExp(`^AWS4-HMAC-SHA256 Credential=synthetic-${pooled ? "grant" : "env"}-access/\\d{8}/${region}/bedrock/aws4_request,`));
  assert.equal(sent.headers.get("x-amz-security-token"), `synthetic-${pooled ? "grant" : "env"}-session`); assert.equal(sent.headers.get("x-api-key"), null);
  assert.equal(f.dispatch.capacity, 64 * 1024 * 1024); assert.equal(f.dispatch.rows.length, 2);
  assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
  const settled = await event(f); assert.equal(settled.input_tokens, item.inputTokens); assert.equal(settled.output_tokens, null); assert.equal(settled.total_tokens, null);
  assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.cost_basis, "policy_fixed"); assert.equal(settled.model, `bedrock/${item.model}`);
  assert.ok(f.rows().every(row => row.settled === 1)); assert.doesNotMatch(JSON.stringify(settled), /synthetic-(?:env|grant|caller)/);
});

for (const scenario of ["unpriced", "missing-credential", "missing-region", "foreign-origin", "region-mismatch", "wrong-signing-service", "query", "caller-region", "body-model", "stream", "oversized", "unknown-model"]) {
  test(`Bedrock embedding ${scenario} is denied before egress and never borrows another credential or wire`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { fixed: scenario === "unpriced" ? null : 700 }); const request = {};
    if (scenario === "missing-credential") delete f.env.AWS_SECRET_ACCESS_KEY;
    if (scenario === "missing-region") delete f.env.AWS_REGION;
    if (scenario === "foreign-origin") f.provider.base_urls.default = "https://unqualified.example";
    if (scenario === "region-mismatch") f.provider.base_urls.default = "https://bedrock-runtime.eu-west-1.amazonaws.com";
    if (scenario === "wrong-signing-service") f.provider.auth.schemes[0].service = "s3";
    if (scenario === "query") request.query = "?trace=ENABLED";
    if (scenario === "caller-region") request.query = "?region=eu-west-1";
    if (scenario === "body-model") request.body = { ...titan.body, model: titan.model };
    if (scenario === "stream") request.body = { ...titan.body, stream: true };
    if (scenario === "oversized") request.body = { inputText: "x".repeat(2 * 1024 * 1024) };
    if (scenario === "unknown-model") { request.manifest = true; request.model = "amazon.titan-embed-text-v9"; }
    const response = await denied(f, request); if (scenario === "unpriced") assert.equal(response.status, 400);
  });
}

test("Bedrock original grant signing never falls back to nonselected environment key material", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); delete f.env.AWS_ACCESS_KEY_ID; delete f.env.AWS_SECRET_ACCESS_KEY;
  const response = await f.request(); assert.equal(response.status, 200, response.ok ? undefined : await response.text()); await response.json();
  assert.match(f.sent[0].headers.get("authorization"), /Credential=synthetic-grant-access\//); await event(f);
  await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true, credentials: { accessKeyId: "synthetic-grant-access" } });
  f.env.AWS_ACCESS_KEY_ID = "synthetic-env-access"; f.env.AWS_SECRET_ACCESS_KEY = "synthetic-env-secret";
  const refused = await f.request(); assert.ok(refused.status >= 400); await refused.text(); assert.equal(f.sent.length, 1);
});

for (const scenario of ["redirect", "rejection", "invalid-vector", "partial-json", "compressed"]) test(`Bedrock ${scenario} after dispatch retains conservative cost with no partial vectors or replay`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { response: () => scenario === "redirect" ? new Response(null, { status: 307, headers: { location: "https://unqualified.example" } })
    : scenario === "rejection" ? Response.json({ message: "Synthetic upstream rejection" }, { status: 422 })
    : scenario === "partial-json" ? new Response('{"embedding":[1', { headers: { "content-type": "application/json" } })
    : Response.json(scenario === "invalid-vector" ? { ...titan.response, embedding: [1] } : titan.response,
      { headers: scenario === "compressed" ? { "content-encoding": "gzip" } : {} }) });
  const response = await f.request(); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, "provider_unavailable");
  assert.equal(f.sent.length, 1); const settled = await event(f); assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.total_tokens, null);
});

test("Bedrock capacity exhaustion is known-unsent and releases the original reservations", { timeout: 10_000 }, async t => {
  const f = await setup(t), blocker = new BodyLease(); assert.equal(blocker.grow(20 * 1024 * 1024), true);
  let response; try { response = await f.request(); } finally { blocker.release(); }
  assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); const settled = await event(f); assert.equal(settled.actual_cost_micros, 0);
});

test("Bedrock embedding delivery waits for complete EOF and caller abort retains dispatched uncertainty", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  const f = await setup(t, { response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(titan.response))); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  let delivered = false; const pending = f.request({ signal: abort.signal }).then(response => { delivered = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(delivered, false); abort.abort();
  const response = await pending; assert.equal(response.status, 502); await response.text();
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 700); assert.equal(settled.input_tokens, null); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Bedrock missing dispatch acknowledgment never sends the signed paid request", { timeout: 10_000 }, async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER; let fallback = 0;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") { fallback++; return Response.json({ error: "synthetic lost ACK" }, { status: 503 }); }
    const response = await ledger.get(name).fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }) };
  const response = await f.request(); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "accounting_unavailable");
  const settled = await event(f); assert.equal(settled.actual_cost_micros, 0); assert.equal(f.sent.length, 0); assert.equal(fallback, 2);
});

for (const model of [titan.model, "us.amazon.titan-embed-text-v2:0:2:8k"]) test(`Bedrock unregistered ${model} cannot bypass the qualified embedding route through generic Invoke`, { timeout: 10_000 }, async t => {
  const f = await setup(t); f.provider.models = f.provider.models.filter(model => !model.capabilities.includes("llm.embeddings"));
  f.provider.endpoints = f.provider.endpoints.filter(endpoint => endpoint.id !== f.embeddingEndpoint);
  await denied(f, { model }); assert.equal(f.budgetCalls.some(call => call.path === "/reserve"), false);
});


for (const manifest of [false, true]) test(`Bedrock fixture reuses the declared embed_text route and selected model without duplicating identities: ${manifest}`, async t => {
  const source = structuredClone(snapshot.providers.find(provider => provider.id === "aws-bedrock"));
  const binding = source.capabilities.find(capability => capability.id === "llm.embeddings");
  if (!binding) {
    // Exact published route identity from the nine-row text declaration. This
    // in-memory setup is not a provider declaration or snapshot activation.
    source.capabilities.push({ id: "llm.embeddings", endpoint: "embed_text", methods: ["POST"] });
    source.endpoints.push({ ...structuredClone(source.endpoints.find(endpoint => endpoint.id === "invoke_model")),
      id: "embed_text", modelPassthrough: undefined, streaming: null, request_headers: [] });
  }
  const id = `bedrock/${titan.model}`;
  if (!source.models.some(model => model.id === id)) source.models.push({ ...structuredClone(source.models[0]), id,
    upstream: titan.model, capabilities: ["llm.embeddings"], pricing: null, inference: undefined, nativeCapabilities: undefined });
  const unrelated = structuredClone(source.models.filter(model => model.id !== id));
  const invokes = structuredClone(source.endpoints.filter(endpoint => ["invoke_model", "invoke_model_stream"].includes(endpoint.id)));
  const f = await setup(t, { source, pooled: true, reverse: manifest });
  assert.equal(f.embeddingEndpoint, binding?.endpoint ?? "embed_text");
  assert.equal(f.provider.capabilities.filter(capability => capability.id === "llm.embeddings").length, 1);
  assert.equal(f.provider.models.filter(model => model.id === id).length, 1);
  assert.deepEqual(f.provider.models.filter(model => model.id !== id), unrelated);
  for (const endpoint of invokes) assert.deepEqual(f.provider.endpoints.find(row => row.id === endpoint.id), endpoint);
  const response = await f.request({ manifest }); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  assert.deepEqual(await response.json(), titan.response); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].headers.get("authorization"), /Credential=synthetic-grant-access\//);
  assert.equal((await event(f)).actual_cost_micros, 700);
});
