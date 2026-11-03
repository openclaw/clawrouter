import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { configuredUpstream, providerModel, upstreamPath } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
import { prepareRadiusRequest, createRadiusEventInspector, filterRadiusCatalog } from "../provider-radius.ts";

const { providers: [provider] } = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", "providers/radius.provider.yaml"], { encoding: "utf8" }));
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
