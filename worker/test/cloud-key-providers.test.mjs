import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { configuredUpstream, providerModel, upstreamPath } from "../providers.ts";
import { resolveTemplate } from "../provider-templates.ts";

const contracts = [
  ["amazon-bedrock-mantle", "BEDROCK_MANTLE_API_KEY", "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", "openai.gpt-oss-120b"],
  ["microsoft-foundry", "MICROSOFT_FOUNDRY_API_KEY", "https://fixture.services.ai.azure.com/openai/v1/chat/completions", "deployment"],
  ["kimi", "KIMI_CODING_API_KEY", "https://api.kimi.ai/coding/v1/chat/completions", "k3.1-pro"],
];
const { providers } = JSON.parse(execFileSync(process.execPath, [
  "scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`),
], { encoding: "utf8" }));
const configuration = {
  MICROSOFT_FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com",
  MICROSOFT_FOUNDRY_DEPLOYMENT: "tenant-chat-deployment",
};

for (const [id, binding, url, model] of contracts) {
  const provider = providers.find(provider => provider.id === id);
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
  test(`${id}: API-key auth does not consume lab keys or identity tokens`, () => {
    const foreign = { ...configuration, OPENAI_API_KEY: "fixture-lab", ANTHROPIC_API_KEY: "fixture-lab",
      MOONSHOT_API_KEY: "fixture-moonshot", KIMI_API_KEY: "fixture-ambiguous", AWS_BEARER_TOKEN_BEDROCK: "fixture-unbound",
      AZURE_OPENAI_API_KEY: "fixture-other-resource", AZURE_ACCESS_TOKEN: "fixture-entra" };
    assert.throws(() => configuredUpstream(provider, null, foreign), error => error.code === "provider_not_configured");
    const auth = configuredUpstream(provider, null, { ...foreign, [binding]: "fixture-selected" });
    const foundry = id === "microsoft-foundry";
    assert.equal(auth.headers.get(foundry ? "api-key" : "authorization"), foundry ? "fixture-selected" : "Bearer fixture-selected");
    assert.equal(auth.headers.get(foundry ? "authorization" : "api-key"), null);
    assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, configuration, auth), url);
    assert.deepEqual(provider.auth.grantTransports, {});
  });
  test(`${id}: configured and opaque model names remain unpriced`, () => {
    const known = providerModel(provider, `${id}/${model}`, endpoint);
    assert.equal(resolveTemplate(provider, known.upstream, configuration), id === "microsoft-foundry" ? "tenant-chat-deployment" : model);
    assert.equal(known.pricing, null);
    const dynamic = providerModel(provider, `${id}/tenant-specific`, endpoint);
    assert.equal(dynamic.upstream, "tenant-specific");
    assert.equal(dynamic.pricing, null);
    assert.equal(dynamic.nativeCapabilities, undefined);
  });
}

test("Foundry fails closed without its explicit resource and deployment bindings", () => {
  const provider = providers.find(provider => provider.id === "microsoft-foundry");
  assert.throws(() => configuredUpstream(provider, null, { MICROSOFT_FOUNDRY_API_KEY: "fixture-selected" }), error => error.code === "provider_not_configured");
  assert.throws(() => resolveTemplate(provider, provider.models[0].upstream, {}), error => error.code === "provider_not_configured");
});
