import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureMusic, musicBody, musicModels, musicWire } from "./openrouter-music-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const nativePath = "/v1/native/openrouter/v1/chat/completions", manifestPath = "/v1/proxy/openrouter/music_generate";
const bytes = value => new TextEncoder().encode(value);

async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(value => value.id === "openrouter")); configureMusic(provider);
  const f = await fixture(t, { pooled: true, ...options, providerId: "openrouter", configure(selected) { Object.assign(selected, provider); } });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-key"; f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.rows = () => [...new Set(f.budgetCalls.map(value => value.name))].flatMap(name => f.budgets.get(name).reservations());
  f.request = (body = musicBody(), { manifest = false, query = "", ...extra } = {}) => f.call((manifest ? manifestPath : nativePath) + query,
    manifest ? { body: { ...body, model: `openrouter/${body.model}` } } : body, extra);
  f.upstream = async request => {
    f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() }; f.upload = await request.json();
    return new Response(musicWire(f.upload.model), { headers: { "content-type": "text/event-stream", "x-private-upstream": "synthetic" } });
  };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); }); return f;
}
async function settled(f, micros) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  const event = events[0]; assert.equal(event.actual_cost_micros, micros);
  assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
  assert.equal(event.grant_key, grantKey); assert.equal(event.capability, "music.generate"); return event;
}

for (const model of musicModels) for (const manifest of [false, true]) test(`OpenRouter music ${model} ${manifest ? "manifest" : "native"} dispatches original key and complete native SSE`, async t => {
  const f = await setup(t), response = await f.request(musicBody(model), { manifest });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), musicWire(model));
  assert.equal(response.headers.get("x-private-upstream"), null); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/chat/completions"); assert.equal(f.sent[0].redirect, "manual");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.deepEqual(f.upload, musicBody(model));
  assert.ok(f.dispatch.capacity >= 64 * 1024 * 1024); assert.equal(f.dispatch.rows.length, 2);
  assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0 && row.reserved_micros === 700));
  assert.equal((await settled(f, 700)).cost_basis, "policy_fixed");
});

for (const mutation of ["unknown-dollar", "fake-text-tariff", "query", "reference-image", "foreign-origin", "nonstream", "generic-chat"]) {
  test(`OpenRouter music ${mutation} denies before paid dispatch`, async t => {
    const f = await setup(t, { fixed: ["unknown-dollar", "fake-text-tariff"].includes(mutation) ? null : 700 });
    const body = musicBody();
    if (mutation === "fake-text-tariff") for (const model of f.provider.models.filter(model => musicModels.includes(model.upstream)))
      model.pricing = structuredClone(snapshot.providers.find(value => value.id === "openai").models.find(value => value.pricing).pricing);
    if (mutation === "reference-image") body.messages[0].content = [{ type: "text", text: "Synthetic instrumental." }, { type: "image_url", image_url: { url: "https://assets.example/private.png" } }];
    if (mutation === "foreign-origin") f.provider.base_urls.default = "https://other.example/api";
    if (mutation === "nonstream") body.stream = false;
    const response = mutation === "generic-chat" ? await f.call("/v1/chat/completions", { ...body, model: `openrouter/${body.model}` })
      : await f.request(body, { query: mutation === "query" ? "?account=other" : "" });
    const value = await response.text(); assert.ok(response.status >= 400, value); assert.equal(f.sent.length, 0);
    if (["unknown-dollar", "fake-text-tariff"].includes(mutation)) assert.equal(JSON.parse(value).error.code, "pricing_required");
    await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });
}

for (const outcome of ["truncated", "paid-error", "foreign-model", "redirect", "non-200", "wrong-mime", "length"]) {
  test(`OpenRouter dispatched ${outcome} is quarantined, charged conservatively and never replayed`, async t => {
    const f = await setup(t); let wire = musicWire(), status = 200, headers = { "content-type": "text/event-stream" };
    if (outcome === "truncated") wire = wire.replace("data: [DONE]\n\n", "");
    if (outcome === "paid-error") wire = 'event: error\ndata: {"error":{"message":"synthetic paid failure"}}\n\n';
    if (outcome === "foreign-model") wire = musicWire("foreign/model");
    if (outcome === "redirect") { status = 302; headers.location = "https://other.example/paid"; }
    if (outcome === "non-200") status = 422;
    if (outcome === "wrong-mime") headers["content-type"] = "application/json";
    if (outcome === "length") headers["content-length"] = String(bytes(wire).length + 1);
    f.upstream = () => new Response(wire, { status, headers });
    const response = await f.request(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /UklG|synthetic paid failure/);
    assert.equal(f.sent.length, 1); assert.equal((await settled(f, 700)).cost_basis, "policy_fixed");
  });
}

test("OpenRouter music cancellation aborts the original fetch, retains its charge and releases capacity", async t => {
  const f = await setup(t), controller = new AbortController(); let signal;
  f.upstream = request => new Promise((resolve, reject) => {
    signal = request.signal; request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); controller.abort();
  });
  const response = await f.request(undefined, { signal: controller.signal }); await response.text();
  assert.ok(response.status >= 400); assert.equal(signal.aborted, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("OpenRouter music pre-dispatch response capacity refusal remains known-unsent", async t => {
  const f = await setup(t), held = new BodyLease(); assert.equal(held.grow(32 * 1024 * 1024), true);
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); await settled(f, 0); }
  finally { held.release(); }
});

test("OpenRouter music selected-grant policy cannot borrow an environment key after revocation", async t => {
  const f = await setup(t); f.policy.grantRouting = { eligibleGrants: { openrouter: ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
  const response = await f.request(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});
