import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { configuredUpstream, providerModel, upstreamPath } from "../providers.ts";
import { resolveTemplate } from "../provider-templates.ts";

const paths = ["providers/bifrost.provider.yaml", "providers/litellm.provider.yaml"].sort();
const { providers } = compileProviderSnapshot(paths.map(path => parse(readFileSync(path, "utf8"))));

for (const provider of providers) {
  const id = provider.id;
  const prefix = id.toUpperCase();
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
  const base = `https://${id}.example.com/${id === "bifrost" ? "openai" : "v1"}`;
  const env = { [`${prefix}_API_KEY`]: "fixture-virtual-key", [`${prefix}_BASE_URL`]: base,
    [`${prefix}_MODEL`]: "tenant/model-alias" };

  test(`${id}: virtual key and endpoint require explicit operator configuration`, () => {
    assert.throws(() => configuredUpstream(provider, null, { OPENAI_API_KEY: "fixture-direct", LOCAL_OPENAI_BASE_URL: base }), error => error.code === "provider_not_configured");
    assert.throws(() => configuredUpstream(provider, null, { [`${prefix}_API_KEY`]: "fixture-key" }), error => error.code === "provider_not_configured");
    const auth = configuredUpstream(provider, null, env);
    assert.equal(auth.headers.get("authorization"), "Bearer fixture-virtual-key");
    assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, env, auth), base + "/chat/completions");
  });

  test(`${id}: configured and opaque aliases never inherit free local pricing`, () => {
    const selected = providerModel(provider, `${id}/configured`, endpoint);
    assert.equal(resolveTemplate(provider, selected.upstream, env), "tenant/model-alias");
    assert.throws(() => resolveTemplate(provider, selected.upstream, {}), error => error.code === "provider_not_configured");
    assert.equal(selected.pricing, null);
    const opaque = providerModel(provider, `${id}/openai/tenant-model`, endpoint);
    assert.equal(opaque.upstream, "openai/tenant-model");
    assert.equal(opaque.pricing, null);
    assert.equal(opaque.nativeCapabilities, undefined);
    assert.equal(providerModel(provider, `${id}/native-id`, endpoint, true).upstream, `${id}/native-id`);
  });
}
