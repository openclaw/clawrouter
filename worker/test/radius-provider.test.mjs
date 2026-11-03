import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { configuredUpstream, providerModel, upstreamPath } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
import { prepareRadiusRequest, createRadiusEventInspector, filterRadiusCatalog } from "../provider-radius.ts";

const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", "providers/radius.provider.yaml"], { encoding: "utf8" }));
const { providers: [provider] } = compiled;
const env = { RADIUS_API_KEY: "synthetic-radius", RADIUS_MODEL: "tenant/model" };
const endpoint = provider.endpoints.find(row => row.id === "messages");

test("Radius declaration retains native Pi formats and its own credential/model contract", () => {
  assert.equal(provider.class, "custom_adapter");
  assert.equal(endpoint.request_format, "radius.messages");
  assert.equal(endpoint.streaming, "sse");
  assert.throws(() => configuredUpstream(provider, null, { OPENROUTER_API_KEY: "synthetic-foreign", GITHUB_TOKEN: "synthetic-foreign" }), error => error.code === "provider_not_configured");
  const auth = configuredUpstream(provider, null, env);
  assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, env, auth), "https://radius.pi.dev/v1/messages");
  assert.equal(auth.headers.get("authorization"), "Bearer synthetic-radius");
  const selected = providerModel(provider, "radius/configured", endpoint);
  assert.equal(selected.upstream, "${model}");
  assert.equal(selected.pricing, null);
  assert.equal(selected.nativeCapabilities, undefined);
});

test("Radius selected native request preserves context tool results and reasoning", () => {
  const input = { model: "radius/configured", context: { messages: [{ role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic result" }], isError: false, timestamp: 0 }] }, options: { reasoning: "high", maxTokens: 32 } };
  const { body } = prepareManifestRequest(provider, endpoint, input, {}, env);
  const native = prepareRadiusRequest(body, body.model);
  assert.equal(native.model, "tenant/model");
  assert.deepEqual(native.context, input.context);
  assert.deepEqual(native.options, input.options);
});

test("Radius config remains a scoped native model envelope and cannot redirect the credential", () => {
  const config = provider.endpoints.find(row => row.id === "config"), auth = configuredUpstream(provider, null, env);
  assert.equal(config.request_format, "radius.config");
  assert.equal(config.method, "GET");
  assert.equal(auth.baseUrl + upstreamPath(provider, config, {}, env, auth), "https://radius.pi.dev/v1/config");
  const visible = { id: "tenant/model", reasoning: true, input: ["text"], contextWindow: 8192 };
  const metadata = { baseUrl: auth.baseUrl, models: [visible, { id: "private-model" }, { id: "disabled-model", enabled: false }] };
  assert.deepEqual(filterRadiusCatalog(metadata, auth.baseUrl, id => id === "tenant/model"), { baseUrl: auth.baseUrl, models: [visible] });
  assert.throws(() => filterRadiusCatalog({ ...metadata, baseUrl: "https://untrusted.example/v1" }, auth.baseUrl, () => true), /catalog_origin/);
});

test("Radius terminal counters include cache buckets but never promote native costs to a tariff", () => {
  const inspect = createRadiusEventInspector();
  inspect.accept({ type: "done", reason: "stop", usage: { input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } } });
  const result = inspect.result();
  assert.equal(result.outcome, "success");
  assert.deepEqual([result.tokens.input, result.tokens.output, result.tokens.total, result.tokens.cached, result.tokens.cacheWrite], [64, 12, 76, 10, 4]);
  assert.equal(provider.models[0].pricing, null);
  assert.equal(endpoint.modelPassthrough.pricing, null);
});

const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { usageEnv, proxyKey } = await import("./usage-budget-fixture.mjs");
const { sqlBudgetNamespace } = await import("./sql-budget-namespace.mjs");
function runtimeFixture(t, { fixed = 7, models } = {}) {
  const priorProviders = snapshot.providers, priorIndex = snapshot.model_index;
  snapshot.providers = [...priorProviders.filter(row => row.id !== "radius"), structuredClone(provider)];
  snapshot.model_index = { ...priorIndex, ...compiled.model_index };
  t.after(() => { snapshot.providers = priorProviders; snapshot.model_index = priorIndex; });
  const pending = [], recorded = [], sent = [], names = [], ledger = sqlBudgetNamespace(t);
  const runtime = usageEnv([], { provider: "radius", fixedCost: fixed, retainContent: false });
  Object.assign(runtime, env);
  if (models) {
    const get = runtime.ACCESS_CONTROL.get;
    runtime.ACCESS_CONTROL.get = (...args) => {
      const object = get(...args);
      return { fetch: async (...args) => { const response = await object.fetch(...args), value = await response.json();
        if (value.policy) value.policy.policy.models = models;
        if (value.policies) for (const row of value.policies) row.policy.models = models;
        return Response.json(value);
      } };
    };
  }
  runtime.BUDGET_LEDGER = { idFromName: name => name, get(name) { if (!names.includes(name)) names.push(name); return ledger.get(name); } };
  runtime.USAGE_QUEUE = { send: async value => recorded.push(value) };
  const f = { sent, recorded, names, ledger, reply: () => new Response(""),
    call(path, body) { return worker.fetch(new Request(`https://router.example${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), runtime, { waitUntil: promise => pending.push(promise) }); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  return f;
}
const nativeInput = { model: "radius/configured", context: { messages: [{ role: "user", content: "fixture" }] }, options: { reasoning: "off", maxTokens: 32 } };
const nativeUsage = { input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };

for (const manifest of [false, true]) test(`Radius declared ${manifest ? "manifest" : "native"} route selects its configured model and settles SQL once`, async t => {
  const f = runtimeFixture(t), wire = `data: ${JSON.stringify({ type: "done", reason: "stop", usage: nativeUsage })}\n\n`;
  f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const response = await f.call(manifest ? "/v1/proxy/radius/messages" : "/v1/native/radius/messages", manifest ? { body: nativeInput } : nativeInput);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://radius.pi.dev/v1/messages");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-radius");
  assert.deepEqual(await f.sent[0].json(), { ...nativeInput, model: "tenant/model", options: { maxTokens: 32 } });
  assert.equal(f.recorded.length, 1);
  assert.deepEqual([f.recorded[0].provider, f.recorded[0].input_tokens, f.recorded[0].output_tokens, f.recorded[0].total_tokens, f.recorded[0].actual_cost_micros, f.recorded[0].cost_basis], ["radius", 64, 12, 76, 7, "policy_fixed"]);
  for (const name of f.names) { const rows = f.ledger.get(name).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); }
});

test("Radius declared metadata route filters native config and never charges inference", async t => {
  const f = runtimeFixture(t, { models: ["radius/tenant/model"] }), allowed = { id: "tenant/model", reasoning: true };
  f.reply = () => Response.json({ baseUrl: "https://radius.pi.dev/v1", models: [allowed, { id: "hidden/model" }] });
  const response = await f.call("/v1/native/radius/config");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { baseUrl: "https://radius.pi.dev/v1", models: [allowed] });
  await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://radius.pi.dev/v1/config");
  assert.equal(f.recorded[0].actual_cost_micros, 0); assert.equal(f.recorded[0].cost_basis, "none");
});

test("Radius native declaration refuses unknown-dollar hard budgets before dispatch", async t => {
  const f = runtimeFixture(t, { fixed: null });
  const response = await f.call("/v1/native/radius/messages", nativeInput);
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  await f.drain(); assert.equal(f.sent.length, 0);
});
