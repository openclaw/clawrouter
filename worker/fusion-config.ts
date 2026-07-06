import type { FusionConfig } from "../shared/contracts";
import { DEFAULT_FUSION_CONFIG, FUSION_MODEL_ID, normalizeFusionConfig } from "./fusion";
import { endpointForPath, modelRoute } from "./providers";
import type { Env } from "./types";
import { HttpError } from "./utils";

const FUSION_CONFIG_KEY = "config/fusion";

export async function loadFusionConfig(env: Env): Promise<FusionConfig> {
  const stored = await env.POLICY_KV.get<Partial<FusionConfig>>(FUSION_CONFIG_KEY, "json");
  try {
    const config = normalizeFusionConfig(stored ?? DEFAULT_FUSION_CONFIG);
    assertFusionModels(config);
    return config;
  } catch {
    return { ...DEFAULT_FUSION_CONFIG, enabled: false };
  }
}

export async function storeFusionConfig(env: Env, input: unknown): Promise<FusionConfig> {
  const config = normalizeFusionConfig(input);
  assertFusionModels(config);
  await env.POLICY_KV.put(FUSION_CONFIG_KEY, JSON.stringify(config));
  return config;
}

export function assertFusionModels(config: FusionConfig): void {
  for (const model of [...config.adviserModels, config.aggregatorModel]) {
    if (model === FUSION_MODEL_ID) throw new HttpError(400, "fusion_recursive_model", "fusion cannot use itself as an adviser or aggregator");
    const route = modelRoute(model);
    if (!route) throw new HttpError(400, "fusion_model_not_found", `fusion model ${model} is not registered`);
    if (!route.model.capabilities.includes("llm.chat")) throw new HttpError(400, "fusion_model_incompatible", `fusion model ${model} does not support chat completions`);
    const endpoint = endpointForPath(route.provider, "/v1/chat/completions");
    if (endpoint?.request_format !== "openai.chat_completions" || endpoint.response_format !== "openai.chat_completions") {
      throw new HttpError(400, "fusion_model_incompatible", `fusion model ${model} is not OpenAI chat-completions compatible`);
    }
  }
}
