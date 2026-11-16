import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { googleSpeechModels: models, googleSpeechPreviewCutoff } = await import("../google-speech.ts");
const source = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url)));
const interactions = model => models.indexOf(model) >= 3;
const endpointId = model => interactions(model) ? "speech_interactions" : "speech_generate_content";
function input(model) {
  const value = structuredClone(interactions(model) ? wire.interactions.request : wire.generateContent.request);
  if (interactions(model)) value.model = model;
  return value;
}
function payload(model) {
  const value = structuredClone(interactions(model) ? wire.interactions.response : wire.generateContent.response);
  if (interactions(model)) value.model = model;
  return value;
}
const bytes = value => new TextEncoder().encode(JSON.stringify(value));

async function setup(t, options = {}) {
  const manifest = structuredClone(source);
  const endpoints = ["speech_generate_content", "speech_interactions"];
  manifest.capabilities = manifest.capabilities.filter(value => value.id !== "audio.speech" || !endpoints.includes(value.endpoint));
  manifest.models.entries = manifest.models.entries.filter(value => !models.some(model => value.id === `google/${model}`));
  for (const id of endpoints) {
    const native = id === "speech_generate_content";
    manifest.capabilities.push({ id: "audio.speech", endpoint: id, methods: ["POST"] });
    manifest.endpoints[id] = { method: "POST", path: native ? "/v1beta/models/${model}:generateContent" : "/v1beta/interactions",
      pathParams: native ? ["model"] : [], requestFormat: `google.${id}`, responseFormat: `google.${id}`,
      ...(!native ? { nativeProxy: false } : {}) };
  }
  for (const upstream of models) manifest.models.entries.push({ id: `google/${upstream}`, upstream, capabilities: ["audio.speech"] });
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "google-gemini")
    .map(provider => provider.id === "replicate" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "google-gemini", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
    for (const endpoint of provider.endpoints.filter(value => endpoints.includes(value.id))) endpoint.timeout_ms = options.timeout ?? 1000;
    if (options.reverse) provider.endpoints.reverse();
  } });
  f.env.GOOGLE_API_KEY = "synthetic-google-environment";
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { "google-gemini": ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.request = (model = models[0], body = input(model), { manifest = interactions(model), endpoint = endpointId(model), query = "", ...extra } = {}) => f.call(
    (manifest ? `/v1/proxy/google-gemini/${endpoint}` : interactions(model) ? "/v1/native/google-gemini/v1beta/interactions"
      : `/v1/native/google-gemini/v1beta/models/${model}:generateContent`) + query,
    manifest ? { body, ...(!interactions(model) ? { pathParams: { model } } : {}) } : body,
    { ...extra, headers: { "x-goog-api-key": "synthetic-caller-key", ...extra.headers } });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = async request => {
    f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() };
    const body = await request.clone().json();
    const model = body.model ?? /\/models\/([^/]+):generateContent$/.exec(new URL(request.url).pathname)?.[1];
    return options.response ? options.response(request, model) : Response.json(payload(model));
  };
  t.after(f.drain); return f;
}
async function error(response, status) {
  const body = await response.text(); assert.equal(response.status, status, body); return JSON.parse(body).error;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  const event = events[0]; assert.equal(event.actual_cost_micros, cost);
  assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
  assert.ok(f.rows().every(row => row.settled === 1)); assert.equal(bodyBudgetCharged(), 0);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:original-key|caller-key|google-environment|private-thought)/);
  return event;
}

for (const model of models) for (const manifest of interactions(model) ? [true] : [false, true]) for (const pooled of [false, true]) {
  test(`Google speech ${model}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} delivers complete native audio once`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled, reverse: pooled });
    const response = await f.request(model, undefined, { manifest });
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024);
    assert.deepEqual(await response.json(), payload(model));
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://generativelanguage.googleapis.com" + (interactions(model) ? "/v1beta/interactions" : `/v1beta/models/${model}:generateContent`));
    assert.equal(request.redirect, "manual"); assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-goog-api-key"), pooled ? "synthetic-original-key" : "synthetic-google-environment");
    assert.deepEqual(await request.clone().json(), input(model));
    assert.ok(f.dispatch.capacity >= 64 * 1024 * 1024); assert.equal(f.dispatch.rows.length, 2);
    assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0 && row.reserved_micros === 700));
    const event = await settled(f); assert.equal(event.capability, "audio.speech"); assert.equal(event.model, `google/${model}`);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.pricing_ref, null);
  });
}

for (const model of [models[0], models[3]]) for (const budget of ["caller", "provider", "daily", "weekly"]) {
  test(`Google speech ${endpointId(model)} unknown ${budget} dollars deny before egress`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { fixed: null }); f.policy.monthlyBudgetMicros = null;
    if (budget === "caller") f.policy.monthlyBudgetMicros = 10_000;
    if (budget === "daily") f.policy.dailyBudgetMicros = 10_000;
    if (budget === "weekly") f.policy.weeklyBudgetMicros = 10_000;
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    await f.authority("/connections/put", { providerId: "google-gemini", enabled: true, monthlyBudgetMicros: budget === "provider" ? 10_000 : null });
    assert.equal((await error(await f.request(model), 400)).code, "pricing_required");
    assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0); assert.equal(bodyBudgetCharged(), 0);
  });
}

test("Google speech catalog keeps native Interactions closed and exposes only each transport's qualified models", { timeout: 10_000 }, async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const catalog = await response.json(), provider = catalog.providers.find(provider => provider.id === "google-gemini"), offers = provider.offers;
  for (const model of models) {
    const matching = offers.filter(offer => offer.modelId === `google/${model}`);
    assert.ok(matching.length > 0); assert.ok(matching.every(offer => offer.endpoint === endpointId(model) && offer.eligible));
    const route = provider.routes.find(route => route.endpoint === endpointId(model));
    assert.equal(route.requestFormat, `google.${endpointId(model)}`); assert.equal(route.responseFormat, route.requestFormat);
    assert.ok(matching.every(offer => offer.routeKind === (interactions(model) ? "manifest" : "native")));
  }
  const native = await f.request(models[3], undefined, { manifest: false });
  await native.text(); assert.ok(native.status >= 400); assert.equal(f.sent.length, 0);
});

test("Google speech preview cutoff removes offers and denies egress while stateless Interactions stays executable", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.advance(Date.parse(googleSpeechPreviewCutoff) - Date.now());
  for (const model of models.slice(0, 3)) { const response = await f.request(model); await response.text(); assert.ok(response.status >= 400); }
  assert.equal(f.sent.length, 0);
  const response = await f.request(models[3]); assert.equal(response.status, 200); await response.json(); await f.drain();
  assert.equal(f.sent.length, 1); assert.ok((await f.events()).filter(event => event.status_code === 200).every(event => event.actual_cost_micros === 700));
});

for (const scenario of ["query", "stream", "retained", "foreign-origin", "missing-key", "unauthenticated", "wrong-transport", "generic", "sse"]) {
  test(`Google speech ${scenario} cannot bypass the native contract`, { timeout: 10_000 }, async t => {
    const f = await setup(t); const body = input(models[3]), extra = {};
    if (scenario === "query") extra.query = "?key=synthetic";
    if (scenario === "stream") body.stream = true;
    if (scenario === "retained") body.previous_interaction_id = "synthetic-unowned";
    if (scenario === "foreign-origin") f.provider.base_urls.default = "https://unqualified.example";
    if (scenario === "missing-key") delete f.env.GOOGLE_API_KEY;
    if (scenario === "unauthenticated") extra.headers = { authorization: "Bearer synthetic-invalid" };
    let response;
    if (scenario === "wrong-transport") response = await f.request(models[0], undefined, { manifest: true, endpoint: "speech_interactions" });
    else if (scenario === "generic") response = await f.call("/v1/proxy/google-gemini/generate_content", { body: input(models[0]), pathParams: { model: models[0] } });
    else if (scenario === "sse") response = await f.call(`/v1/native/google-gemini/v1beta/models/${models[0]}:streamGenerateContent`, input(models[0]));
    else response = await f.request(models[3], body, extra);
    const text = await response.text(); assert.ok(response.status >= 400 && response.status < 600, text);
    assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0); assert.equal(bodyBudgetCharged(), 0);
  });
}

test("Google speech revoked original grant cannot fall back to a configured environment key", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const first = await f.request(); assert.equal(first.status, 200); await first.json(); await settled(f);
  await revokeGrantCredentials(f.env, "oauth/fixture/replicate");
  const next = await f.request(); await next.text(); assert.ok(next.status >= 400); assert.equal(f.sent.length, 1);
});

for (const failure of ["redirect", "rejected", "missing-mime", "invalid-sibling", "length", "overflow", "interrupt", "deadline"]) {
  test(`Google speech ${failure} retains dispatched uncertainty without partial audio or replay`, { timeout: 10_000 }, async t => {
    let canceled = false;
    const f = await setup(t, { pooled: true, timeout: 50, response: (_request, model) => {
      if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
      if (failure === "rejected") return Response.json({ error: "synthetic private error" }, { status: 422 });
      const body = payload(model), headers = { "content-type": "application/json" };
      if (failure === "missing-mime") delete body.candidates[0].content.parts[0].inlineData.mimeType;
      if (failure === "invalid-sibling") body.candidates.push({ finishReason: "MAX_TOKENS", content: { parts: [] } });
      const data = bytes(body);
      if (failure === "length") headers["content-length"] = String(data.length + 1);
      if (failure === "overflow") headers["content-length"] = String(8 * 1024 * 1024 + 1);
      if (["interrupt", "deadline"].includes(failure)) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(data.subarray(0, 20)); if (failure === "interrupt") controller.error(new Error("synthetic read loss"));
      }, cancel() { canceled = true; } }), { headers });
      return new Response(data, { headers });
    } });
    assert.equal((await error(await f.request(), 502)).code, "provider_unavailable");
    assert.equal((await settled(f)).cost_basis, "policy_fixed"); assert.equal(f.sent.length, 1);
    if (failure === "deadline") assert.equal(canceled, true);
  });
}

test("Google speech waits for EOF, then holds capacity through caller delivery", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(); let stream, published = false;
  const f = await setup(t, { response: (_request, model) => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(bytes(payload(model))); reached.resolve();
  } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(models[3]).then(response => { published = true; return response; });
  await reached.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published, false); assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024); assert.deepEqual(await f.events(), []);
  stream.close(); const response = await pending; assert.equal(response.status, 200);
  await response.body.cancel(); await settled(f); assert.equal(f.sent.length, 1);
});

test("Google speech caller abort cancels the original reader and settles once", { timeout: 10_000 }, async t => {
  const abort = new AbortController(), reached = Promise.withResolvers(); let canceled = false;
  const f = await setup(t, { response: (_request, model) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes(payload(model)).subarray(0, 20)); reached.resolve();
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(models[3], undefined, { signal: abort.signal }); await reached.promise; abort.abort();
  await error(await pending, 502); await settled(f); assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Google speech capacity denial is known-unsent and returns the fixed reservation", { timeout: 10_000 }, async t => {
  const other = new BodyLease(); assert.equal(other.grow(20 * 1024 * 1024), true); const f = await setup(t);
  try { assert.equal((await error(await f.request(), 503)).code, "server_overloaded"); } finally { other.release(); }
  await settled(f, 0); assert.equal(f.sent.length, 0);
});

test("Google speech dispatch acknowledgment failure sends no paid request", { timeout: 10_000 }, async t => {
  const f = await setup(t), ledger = f.env.BUDGET_LEDGER;
  f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") return Response.json({ error: "synthetic lost ACK" }, { status: 503 });
    const response = await ledger.get(name).fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }) };
  assert.equal((await error(await f.request(), 503)).code, "accounting_unavailable");
  await settled(f, 0); assert.equal(f.sent.length, 0);
});
