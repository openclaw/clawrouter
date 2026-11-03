import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { googleSpeechModels: models, googleSpeechPreviewCutoff } = await import("../google-speech.ts");
const { modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const source = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const compiled = () => compileProviderSnapshot([source]).providers[0];
const interactions = model => model.startsWith("gemini-3.8-");
const endpointId = model => interactions(model) ? "speech_interactions" : "speech_generate_content";
function nativeBody(model, response = false) {
  const body = structuredClone(wire[interactions(model) ? "interactions" : "generateContent"][response ? "response" : "request"]);
  if (interactions(model)) body.model = model;
  return body;
}
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "google-gemini", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  f.env.GOOGLE_API_KEY = "synthetic-speech-original-key";
  f.upstream = async request => {
    const body = await request.clone().json();
    const model = body.model ?? /\/models\/([^/]+):generateContent$/.exec(new URL(request.url).pathname)?.[1];
    return Response.json(nativeBody(model, true));
  };
  f.speech = (model, manifest = interactions(model)) => f.call(manifest
    ? `/v1/proxy/google-gemini/${endpointId(model)}`
    : `/v1/native/google-gemini/v1beta/models/${model}:generateContent`, manifest
    ? { body: nativeBody(model), ...(!interactions(model) ? { pathParams: { model } } : {}) }
    : nativeBody(model));
  t.after(f.drain); return f;
}

test("bundled Google speech declares only the five frozen unpriced identities with transport-specific provenance", t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-04T00:00:00Z"));
  const provider = compiled(), speech = provider.models.filter(model => model.capabilities.includes("audio.speech"));
  assert.deepEqual(speech.map(model => model.upstream), [...models]);
  for (const model of speech) {
    assert.equal(model.id, `google/${model.upstream}`); assert.deepEqual(model.capabilities, ["audio.speech"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    const eligible = provider.endpoints.filter(endpoint => modelSupportsEndpoint(provider, model, endpoint));
    assert.deepEqual(eligible.map(endpoint => endpoint.id), [endpointId(model.upstream)]);
    const declared = source.models.entries.find(row => row.id === model.id);
    assert.deepEqual(Object.keys(declared.nativeCapabilities.endpoints), [endpointId(model.upstream)]);
    const facts = declared.nativeCapabilities.endpoints[endpointId(model.upstream)];
    assert.deepEqual(facts.input, ["text"]); assert.equal(facts.checkedAt, "2026-11-04");
    assert.ok(facts.sources.includes("https://ai.google.dev/gemini-api/docs/deprecations"));
    assert.equal(facts.contextWindow, undefined); assert.equal(facts.maxOutputTokens, undefined);
    assert.equal(eligible[0].native_proxy, !interactions(model.upstream));
  }
});

test("actual catalog exposes each declared speech transport without an ambiguous native Interactions offer", async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null);
  assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(provider => provider.id === "google-gemini");
  for (const model of models) {
    const offers = provider.offers.filter(offer => offer.modelId === `google/${model}`);
    assert.ok(offers.length > 0);
    assert.ok(offers.every(offer => offer.eligible && offer.endpoint === endpointId(model)
      && offer.routeKind === (interactions(model) ? "manifest" : "native")));
  }
  const ambiguous = await f.call("/v1/native/google-gemini/v1beta/interactions", nativeBody(models[3]));
  await ambiguous.text(); assert.ok(ambiguous.status >= 400); assert.equal(f.sent.length, 0);
});

test("exact bundled speech declarations deliver all five native bodies through the Worker with fixed accounting", async t => {
  const f = await setup(t); let count = 0;
  for (const model of models) for (const manifest of interactions(model) ? [true] : [false, true]) {
    const response = await f.speech(model, manifest);
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.deepEqual(await response.json(), nativeBody(model, true));
    await f.drain(); assert.equal(f.sent.length, ++count);
    const sent = f.sent.at(-1);
    assert.equal(sent.url, "https://generativelanguage.googleapis.com" + (interactions(model)
      ? "/v1beta/interactions" : `/v1beta/models/${model}:generateContent`));
    assert.equal(sent.redirect, "manual"); assert.equal(sent.method, "POST");
    assert.equal(sent.headers.get("x-goog-api-key"), "synthetic-speech-original-key");
    assert.deepEqual(await sent.clone().json(), nativeBody(model));
  }
  const events = await f.events(); assert.equal(events.length, count);
  assert.ok(events.every(event => event.capability === "audio.speech" && event.cost_basis === "policy_fixed"
    && event.actual_cost_micros === 700 && event.input_tokens === null && event.output_tokens === null));
  const rows = [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  assert.equal(rows.length, count * 2); assert.ok(rows.every(row => row.settled === 1));
});

test("declared speech models reject unknown upstream-dollar admission before audio egress", async t => {
  const f = await setup(t, { fixed: null });
  for (const model of models) {
    const response = await f.speech(model);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  }
  assert.equal(f.sent.length, 0);
  const rows = [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  assert.equal(rows.length, 0);
});

test("bundled preview offers and dispatch close at the existing cutoff while both Interactions identities remain", async t => {
  const f = await setup(t); f.advance(Date.parse(googleSpeechPreviewCutoff) - Date.now());
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(provider => provider.id === "google-gemini");
  assert.ok(provider.offers.every(offer => !models.slice(0, 3).some(model => offer.modelId === `google/${model}`)));
  for (const model of models.slice(0, 3)) for (const manifest of [false, true]) {
    const denied = await f.speech(model, manifest); await denied.text(); assert.ok(denied.status >= 400);
  }
  assert.equal(f.sent.length, 0);
  for (const model of models.slice(3)) {
    const audio = await f.speech(model); assert.equal(audio.status, 200); await audio.json();
  }
  await f.drain(); assert.equal(f.sent.length, 2);
});
