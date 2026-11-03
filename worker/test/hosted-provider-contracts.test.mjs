import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { configuredUpstream, providerModel, transformRequestBody, upstreamPath } from "../providers.ts";

const contracts = [
  ["moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions", "kimi-k3.1-pro"],
  ["qwen", "QWEN_API_KEY", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", "qwen3.8-max"],
  ["zai", "ZAI_API_KEY", "https://api.z.ai/api/paas/v4/chat/completions", "glm-5.3"],
  ["arcee", "ARCEEAI_API_KEY", "https://api.arcee.ai/api/v1/chat/completions", "trinity-mini"],
  ["chutes", "CHUTES_API_KEY", "https://llm.chutes.ai/v1/chat/completions", "deepseek-ai/DeepSeek-V4-Flash-0731-TEE"],
  ["featherless", "FEATHERLESS_API_KEY", "https://api.featherless.ai/v1/chat/completions", "GalrionSoftworks/Margnum-12B-v1"],
  ["venice", "VENICE_API_KEY", "https://api.venice.ai/api/v1/chat/completions", "zai-org-glm-5-2"],
  ["nvidia", "NVIDIA_API_KEY", "https://integrate.api.nvidia.com/v1/chat/completions", "meta/llama-3.1-8b-instruct"],
  ["cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions", "qwen-3.8-27b"],
  ["deepinfra", "DEEPINFRA_API_KEY", "https://api.deepinfra.com/v1/openai/chat/completions", "Qwen/Qwen3.8-27B"],
  ["baseten", "BASETEN_API_KEY", "https://inference.baseten.co/v1/chat/completions", "zai-org/GLM-5.3"],
  ["gmi", "GMI_API_KEY", "https://api.gmi-serving.com/v1/chat/completions", "deepseek-ai/DeepSeek-V4-Pro"],
  ["novita", "NOVITA_API_KEY", "https://api.novita.ai/openai/v1/chat/completions", "stepfun/step-3.7-flash"],
  ["longcat", "LONGCAT_API_KEY", "https://api.longcat.chat/openai/v1/chat/completions", "LongCat-2.5"],
  ["xiaomi", "XIAOMI_API_KEY", "https://api.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-pro"],
];
const aliases = { gmi: ["gmi-cloud", "gmicloud"], novita: ["novita-ai", "novitaai"] };
const { providers } = compileProviderSnapshot(contracts.map(([id]) =>
  parse(readFileSync(`providers/${id}.provider.yaml`, "utf8"))));

for (const [id, binding, url, upstream] of contracts) {
  const provider = providers.find(provider => provider.id === id);
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");

  test(`${id}: standard endpoint and credential stay isolated from other products`, () => {
    const foreign = Object.fromEntries(contracts.filter(([other]) => other !== id).map(([, key]) => [key, "fixture-foreign"]));
    Object.assign(foreign, {
      DASHSCOPE_API_KEY: "fixture-cn", KIMI_API_KEY: "fixture-code", ZAI_CODING_API_KEY: "fixture-plan",
      CHUTES_OAUTH_TOKEN: "fixture-oauth", OPENROUTER_API_KEY: "fixture-router", HF_TOKEN: "fixture-hf",
      XIAOMI_TOKEN_PLAN_API_KEY: "fixture-plan", OPENAI_API_KEY: "fixture-other",
    });
    assert.throws(() => configuredUpstream(provider, null, foreign), error => error.code === "provider_not_configured");
    const auth = configuredUpstream(provider, null, { ...foreign, [binding]: "fixture-standard" });
    assert.equal(auth.headers.get("authorization"), "Bearer fixture-standard");
    assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, {}, auth), url);
    assert.deepEqual(provider.auth.grantTransports, {});
    assert.deepEqual(provider.routing.nativePrefixes, [`clawrouter-${id}`, id, ...(aliases[id] ?? [])]);
    for (const alias of aliases[id] ?? []) {
      assert.equal(providerModel(provider, `${alias}/${upstream}`, endpoint).upstream, upstream);
      assert.equal(providerModel(provider, `${alias}/tenant-model`, endpoint).upstream, "tenant-model");
    }
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
