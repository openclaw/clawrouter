import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { configuredUpstream, providerModel, transformRequestBody, upstreamPath } from "../providers.ts";

const contracts = [
  ["kilocode", "KILOCODE_API_KEY", "https://ai-gateway.kilo.ai/api/v1/chat/completions", "anthropic/claude-sonnet-4.6"],
  ["requesty", "REQUESTY_API_KEY", "https://router.requesty.ai/v1/chat/completions", "openai/gpt-6-luna"],
  ["vercel-ai-gateway", "AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh/v1/chat/completions", "anthropic/claude-sonnet-4.6"],
  ["opencode", "OPENCODE_API_KEY", "https://opencode.ai/inference/openai/v1/chat/completions", "glm-5.3"],
  ["opencode-go", "OPENCODE_GO_API_KEY", "https://opencode.ai/inference/go/openai/v1/chat/completions", "glm-5.3"],
];
const { providers } = JSON.parse(execFileSync(process.execPath, [
  "scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`),
], { encoding: "utf8" }));

for (const [id, binding, url, upstream] of contracts) {
  const provider = providers.find(provider => provider.id === id);
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");

  test(`${id}: standard endpoint and credential stay isolated from other products`, () => {
    const foreign = Object.fromEntries(contracts.filter(([other]) => other !== id).map(([, key]) => [key, "fixture-foreign"]));
    Object.assign(foreign, { OPENAI_API_KEY: "fixture-lab-key", ANTHROPIC_API_KEY: "fixture-lab-key", VERCEL_OIDC_TOKEN: "fixture-oidc", OPENCODE_ZEN_API_KEY: "fixture-unbound-alias" });
    assert.throws(() => configuredUpstream(provider, null, foreign), error => error.code === "provider_not_configured");
    const auth = configuredUpstream(provider, null, { ...foreign, [binding]: "fixture-standard" });
    assert.equal(auth.headers.get("authorization"), "Bearer fixture-standard");
    assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, {}, auth), url);
    assert.deepEqual(provider.auth.grantTransports, {});
    assert.deepEqual(provider.routing.nativePrefixes, [`clawrouter-${id}`, id]);
  });

  test(`${id}: opaque models and tool/reasoning replay do not inherit invented facts`, () => {
    const known = providerModel(provider, `${id}/${upstream}`, endpoint);
    assert.equal(known.upstream, upstream);
    assert.equal(known.pricing, null);
    const dynamic = providerModel(provider, `${id}/tenant-model`, endpoint);
    assert.equal(dynamic.upstream, "tenant-model");
    assert.equal(dynamic.pricing, null);
    assert.equal(dynamic.nativeCapabilities, undefined);
    assert.equal(providerModel(provider, `${id}/opaque`, endpoint, true).upstream, `${id}/opaque`);
    const body = { model: known.upstream, stream: true, stream_options: { include_usage: true },
      messages: [{ role: "assistant", content: null, reasoning_content: "fixture-reasoning",
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "fixture-result" }] };
    assert.deepEqual(transformRequestBody(provider, endpoint.path, upstream, body, {}), body);
  });
}
