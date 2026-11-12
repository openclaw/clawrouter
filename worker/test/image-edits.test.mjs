import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i0AAAAASUVORK5CYII=";
const model = "openai/gpt-image-2.5-flare";
const routes = ["/v1/images/edits", "/v1/native/openai/v1/images/edits", "/v1/proxy/openai/images_edits"];
const input = { prompt: "Make the uploaded fixture blue", images: [{ image_url: png }], quality: "low" };
const usage = { input_tokens: 112, input_tokens_details: { text_tokens: 12, image_tokens: 100 }, output_tokens: 100, total_tokens: 212 };
function fixture(t, options = {}) {
  const env = usageEnv([], { limit: 20_000_000, fixedCost: 7, ...options });
  env.BUDGET_LEDGER = sqlBudgetNamespace(t);
  env.OPENAI_API_KEY = "fixture-upstream-key";
  const events = [], pending = [], retained = [];
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  env.CONTENT_ARCHIVE = { put: async (_key, value) => retained.push(value) };
  const call = (path = routes[0], body = input, signal) => {
    const value = { model: path.includes("/native/") ? model.slice(7) : model, ...body };
    return handler.fetch(new Request("https://router.example" + path, { method: "POST", signal,
      headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json" },
      body: JSON.stringify(path.includes("/proxy/") ? { body: value } : value) }), env, { waitUntil: promise => pending.push(promise) });
  };
  return { env, events, pending, retained, call };
}
for (const path of routes) test("uploaded PNG reaches OpenAI edits through " + path, async t => {
  const f = fixture(t);
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/images/edits");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("authorization"), "Bearer fixture-upstream-key");
    assert.deepEqual(JSON.parse(init.body), { model: model.slice(7), ...input });
    return Response.json({ data: [{ b64_json: "fixture-output" }], usage });
  });
  const response = await f.call(path);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data[0].b64_json, "fixture-output");
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events[0].actual_cost_micros, 7);
  assert.deepEqual(f.events[0].image_usage, { text_input_tokens: 12, image_input_tokens: 100, image_output_tokens: 100 });
  assert.equal(f.retained.length, 0, "uploaded images are not retained by the edit route");
});

const { providerById, routeCatalog } = await import("../providers.ts");
const { grantSupports } = await import("../provider-auth.ts");
const { shouldFailoverGrant } = await import("../grant-quota.ts");
const { estimateModelCost, actualModelCost, requestPricingGap } = await import("../pricing.ts");
const { extractImageUsageTokens } = await import("../image-generation.ts");
const provider = providerById("openai"), tariff = provider.models.find(value => value.id === model).pricing;
const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];

test("edit catalog and grant contract is exact and separate from generation", () => {
  const endpoint = provider.endpoints.find(value => value.id === "images_edits");
  const route = routeCatalog().manifestProxy.find(value => value.provider === "openai" && value.endpoint === "images_edits");
  assert.equal(route.requestFormat, "openai.images_edits");
  assert.equal(route.responseFormat, "openai.images_generations");
  assert.equal(route.streaming, false);
  assert.equal(route.models.length, 4);
  assert.ok(route.models.every(value => value.capabilities.includes("image.edit")));
  assert.equal(endpoint.timeout_ms, 600000);
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "subscription" }), false);
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "api_key" }), true);
  assert.equal(grantSupports({ provider, endpoint, mode: "websocket" }, { kind: "api_key" }), false);
  for (const status of [401, 403, 429, 500, 503]) assert.equal(shouldFailoverGrant(status, "POST", "image.edit", "fixture-grant", true, true), false);
  assert.equal(requestPricingGap(tariff, input, "openai.images_edits"), "opaque_input_bound");
  assert.equal(estimateModelCost(tariff, input, { request_format: "openai.images_edits" }).pricingAvailable, false);
  assert.equal(estimateModelCost(tariff, input).pricingAvailable, false, "references never reuse generation-only reservation");
  assert.equal(actualModelCost(tariff, extractImageUsageTokens({ usage }), "openai.images_edits"), 3860);
});

for (const path of routes) test("edit validation closes unsupported references/options on " + path, async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("invalid input dispatched"); });
  for (const patch of [
    { images: undefined }, { images: [] }, { images: null }, { images: Array(17).fill(input.images[0]) },
    ...["https://example.com/image.png", "http://127.0.0.1/image.png", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "data:image/gif;base64,R0lGODlh", "data:image/jpeg;base64,iVBORw0KGgo=", "data:image/png;base64,AB==", "data:image/png;base64,not base64"].map(image_url => ({ images: [{ image_url }] })),
    { images: [{ file_id: "file_fixture" }] }, { images: [{ ...input.images[0], file_id: "file_fixture" }] },
    { images: [{ ...input.images[0], detail: "high" }] }, { images: [png] },
    { mask: input.images[0] }, { markup: input.images[0] }, { input_fidelity: "high" },
    { image: png }, { stream: true }, { partial_images: 0 }, { response_format: "url" },
    { output_format: "svg" }, { n: 11 }, { quality: "hd" }, { prompt: "" },
    { images: [{ image_url: "data:image/png;base64," + Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] },
  ]) {
    const response = await f.call(path, { ...input, ...patch });
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).error.code, "invalid_image_edit");
  }
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(f.retained.length, 0);
  for (const owner of owners) assert.equal(f.env.BUDGET_LEDGER.get(owner).reservations().length, 0);
});

for (const scope of ["policy", "provider", "daily", "weekly"]) test("edit " + scope + " hard budget fails closed without a qualified reference bound", async t => {
  const f = fixture(t, { fixedCost: null, limit: null, providerLimit: null,
    ...(scope === "policy" ? { limit: 20_000_000 } : scope === "provider" ? { providerLimit: 20_000_000 } : scope === "daily" ? { dailyLimit: 20_000_000 } : { weeklyLimit: 20_000_000 }) });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("under-reserved edit dispatched"); });
  const response = await f.call();
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "pricing_required");
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(f.retained.length, 0);
});

for (const mode of ["soft", "unmetered"]) for (const terminal of ["measured", "missing", "inconsistent"]) test("edit " + mode + " " + terminal + " reference accounting", async t => {
  const f = fixture(t, { fixedCost: null, ...(mode === "soft" ? { budgetMode: "soft" } : { limit: null, providerLimit: null }) });
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ b64_json: "fixture" }],
    ...(terminal === "missing" ? {} : { usage: terminal === "inconsistent" ? { ...usage, total_tokens: 0 } : usage }) }));
  const response = await f.call(); assert.equal(response.status, 200, await response.clone().text()); await response.text(); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events[0].actual_cost_micros, terminal === "measured" ? 3860 : 0);
  assert.equal(f.events[0].cost_basis, terminal === "measured" ? "manifest_pricing" : "unpriced_usage");
  assert.equal(f.events[0].reserved_input_tokens, null, "no fabricated reference tokens");
  assert.equal(f.events[0].reserved_cost_micros, 0);
  assert.ok(!JSON.stringify(f.events).includes(png)); assert.ok(!JSON.stringify(f.events).includes(input.prompt));
  if (mode === "soft" && terminal === "measured") for (const owner of owners) {
    const [row] = f.env.BUDGET_LEDGER.get(owner).reservations(); assert.equal(row.reserved_micros, 3860); assert.equal(row.settled, 1);
  }
});

for (const patch of [
  { images: Array(16).fill(input.images[0]), n: 10 },
  { images: [{ image_url: "data:image/jpeg;base64,/9j//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAGcAAQEAAAAAAAAAAAAAAAAAAAMHAQEBAQAAAAAAAAAAAAAAAAACBAcQAAICAgIDAQAAAAAAAAAAAAIBAwUGBAARdrQ3BxEAAgICAgEFAQEAAAAAAAAAAwIBBAUGAAcRtXaycyI3NP/AABEIAAIAAgMBEgACEgADEgD/2gAMAwEAAhEDEQA/AKFgFVVz4JiksujpyySUNOckh68RmZlowsiIiBsiJvttvtvj/nfz/EfHqX0IOZD2eYtLsrdqtUj1gA2bPBAALSIIRDyVhUGMaTCIiLEKiLEQsR4iOHtj+p757q2H1Szxrr+ByCxcuYnG27VmIsWbNinXMewYv7IYxSDZyEI8yzu8yzNMzM+eWUf8Vb6BfCOf/9k=" }] },
  { images: [{ image_url: "data:image/webp;base64,UklGRmgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAA/4D//wBWUDggPAAAAPABAJ0BKgIAAgABQCYlkAJ0ugADCPePcAD+68fy0Z8T/GL/+rQ3mHY2QAs0MmFD/FtI6FMh+1MEkZOQAA==" }] },
]) test("bounded reference transport preserves admitted bytes and counts", async t => {
  // Complete 2x2 fixtures from pixverse-image-multipart.test.mjs; transport does not decode pixels.
  const f = fixture(t), body = { ...input, ...patch };
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { model: model.slice(7), ...body });
    return Response.json({ data: [], usage });
  });
  const response = await f.call(routes[0], body); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
});

for (const scenario of ["revoked", "model-policy", "provider-policy", "tier-policy", "exhausted", "fixed-budget"]) test("edit preserves " + scenario + " admission", async t => {
  const f = fixture(t, { ...(scenario === "tier-policy" ? { serviceTiers: { allowed: ["flex"] } } : {}),
    ...(scenario === "exhausted" ? { limit: 0 } : {}), ...(scenario === "fixed-budget" ? { limit: 6 } : {}),
    admissionReply: value => {
      if (scenario === "revoked") value.credential.credential.enabled = false;
      if (scenario === "model-policy") value.policy.policy.models = ["openai/gpt-6-astra"];
      if (scenario === "provider-policy") value.policy.policy.providers = ["anthropic"];
      return value;
    } });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("denied edit dispatched"); });
  const response = await f.call(); assert.ok([400, 401, 402, 403].includes(response.status), await response.clone().text()); await response.text();
  await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0);
});

for (const scenario of ["cancel", "abort", "deadline", "fetch-error", "redirect", "rejection", "rate-limit"]) test("edit lifecycle " + scenario + " never repeats the paid POST", { timeout: 5000 }, async t => {
  const f = fixture(t), caller = new AbortController(); let canceled = 0;
  if (scenario === "deadline") {
    const timer = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => timer(fn, delay === 600000 ? 15 : delay, ...args));
  }
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.redirect, "manual");
    if (scenario === "fetch-error") throw Error("fixture network error");
    if (scenario === "redirect") return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/" } });
    if (["rejection", "rate-limit"].includes(scenario)) return Response.json({ error: "fixture rejection" }, { status: scenario === "rejection" ? 400 : 429 });
    let sent = false;
    return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode('{"data":[')); } }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  });
  const response = await f.call(routes[0], input, caller.signal);
  if (["cancel", "abort", "deadline"].includes(scenario)) {
    const reader = response.body.getReader(); await reader.read();
    if (scenario === "cancel") await reader.cancel();
    else { const pending = reader.read(); if (scenario === "abort") caller.abort(Error("fixture caller canceled")); await assert.rejects(pending); }
  } else await response.text();
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events[0].actual_cost_micros, ["rejection", "rate-limit", "redirect"].includes(scenario) ? 0 : 7);
  if (["cancel", "abort", "deadline"].includes(scenario)) assert.equal(canceled, 1);
  for (const owner of owners) assert.equal(f.env.BUDGET_LEDGER.get(owner).reservations()[0].settled, 1);
});

for (const path of routes) test("edit rejects query and oversized JSON on " + path, async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("unbounded input dispatched"); });
  const queried = await f.call(path + "?n=10"); assert.equal(queried.status, 400); await queried.text();
  const response = await handler.fetch(new Request("https://router.example" + path, { method: "POST",
    headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) }, body: "{}" }), f.env, { waitUntil: promise => f.pending.push(promise) });
  assert.equal(response.status, 413); await response.text(); await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0);
});

for (const fixedCost of [0, 17]) test("edit explicit fixed tariff " + fixedCost + " remains policy pricing", async t => {
  const f = fixture(t, { fixedCost });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [], usage }));
  const response = await f.call(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, fixedCost);
  assert.equal(f.events[0].cost_basis, "policy_fixed");
  assert.equal(f.events[0].image_usage.image_input_tokens, 100);
});

test("combined inline references cannot exceed the actual JSON intake bound without Content-Length", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("oversized aggregate dispatched"); });
  const bytes = Buffer.alloc(4 * 1024 * 1024); Buffer.from(png.split(",")[1], "base64").copy(bytes);
  const image_url = "data:image/png;base64," + bytes.toString("base64");
  const response = await f.call(routes[0], { ...input, images: [{ image_url }, { image_url }] });
  assert.equal(response.status, 413); await response.text(); await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0);
});

test("edit rejects multipart, unknown models, invalid key and manifest query before dispatch", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("invalid edit dispatched"); });
  for (const [path, headers, body] of [
    [routes[0], { "content-type": "multipart/form-data; boundary=fixture" }, "--fixture--"],
    [routes[0], { "content-type": "application/json" }, JSON.stringify({ model: "openai/gpt-image-2.6-flare", ...input })],
    [routes[0], { "content-type": "application/json", authorization: "Bearer invalid" }, JSON.stringify({ model, ...input })],
    [routes[2], { "content-type": "application/json" }, JSON.stringify({ query: { n: 10 }, body: { model, ...input } })],
  ]) {
    const response = await handler.fetch(new Request("https://router.example" + path, { method: "POST", headers: { authorization: "Bearer " + proxyKey(), ...headers }, body }), f.env, { waitUntil: promise => f.pending.push(promise) });
    assert.ok([400, 401, 403, 404].includes(response.status)); await response.text();
  }
  await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0);
});
