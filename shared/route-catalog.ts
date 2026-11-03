import { modelExecutable, type ModelAvailability } from "./model-availability.ts";
import type { ProviderRow, RouteCatalog } from "./contracts.ts";

export interface CatalogProvider extends Pick<ProviderRow, "id" | "class"> {
  capabilities: Array<{ id: string; endpoint: string }>;
  routing: { modelPrefixes?: string[] };
  models: Array<{ id: string; upstream?: string; availability?: ModelAvailability; capabilities: string[] }>;
  endpoints: Array<{ id: string; methods: string[]; path_params: string[]; request_format?: string | null; response_format?: string | null; streaming?: string | null }>;
}

export function modelSupportsEndpoint(provider: Pick<CatalogProvider, "capabilities" | "models">, model: CatalogProvider["models"][number], endpoint: { id: string }): boolean {
  return modelExecutable(provider, model) && provider.capabilities.some((capability) => capability.endpoint === endpoint.id && model.capabilities.includes(capability.id));
}

export function createRouteCatalog(providers: CatalogProvider[]): RouteCatalog {
  const openaiCompatible = providers.filter((provider) => provider.class === "openai_compatible").map((provider) => ({
    provider: provider.id,
    models: provider.models.filter(model => modelExecutable(provider, model)).map((model) => ({
      id: model.id,
      ...(model.availability ? { availability: model.availability } : {}),
      capabilities: model.capabilities,
      endpoints: model.capabilities.map(unifiedPathForCapability).filter(Boolean),
    })),
    modelPrefixes: provider.routing.modelPrefixes,
    endpoints: provider.capabilities.map((capability) => unifiedPathForCapability(capability.id)).filter(Boolean),
  }));
  const manifestProxy = providers.flatMap((provider) => provider.endpoints.map((endpoint) => ({
    provider: provider.id,
    endpoint: endpoint.id,
    route: `/v1/proxy/${provider.id}/${endpoint.id}`,
    methods: endpoint.methods,
    pathParams: endpoint.path_params,
    requestFormat: endpoint.request_format,
    responseFormat: endpoint.response_format,
    sampleModel: provider.models.find((model) => modelSupportsEndpoint(provider, model, endpoint))?.id ?? null,
    models: provider.models.filter((model) => modelSupportsEndpoint(provider, model, endpoint)).map((model) => ({ id: model.id, ...(model.availability ? { availability: model.availability } : {}), capabilities: model.capabilities })),
    streaming: endpoint.streaming != null,
  })));
  return { openaiCompatible, manifestProxy };
}

const unifiedProtocols = [
  ["llm.chat", "/v1/chat/completions", "openai.chat_completions"],
  ["llm.responses", "/v1/responses", "openai.responses"],
  ["llm.decisions", "/v1/decisions", "openai.decisions"],
  ["llm.responses.compact", "/v1/responses/compact", "openai.responses_compact"],
  ["llm.count_tokens", "/v1/responses/input_tokens", "openai.responses_input_tokens"],
  ["llm.moderations", "/v1/moderations", "openai.moderations"],
  ["llm.embeddings", "/v1/embeddings", "openai.embeddings"],
  ["audio.speech", "/v1/audio/speech", "openai.audio_speech"],
  ["audio.transcription", "/v1/audio/transcriptions", "openai.audio_transcriptions"],
  ["image.generation", "/v1/images/generations", "openai.images_generations"],
] as const;

const pathsByCapability = new Map<string, string>(unifiedProtocols.map(([capability, path]) => [capability, path]));
const capabilitiesByPath = new Map<string, string>(unifiedProtocols.map(([capability, path]) => [path, capability]));
const pathsByFormat = new Map<string, string>(unifiedProtocols.map(([, path, format]) => [format, path]));

function unifiedPathForCapability(capability: string): string { return pathsByCapability.get(capability) ?? ""; }
export function capabilityForPath(path: string): string | null { return capabilitiesByPath.get(path) ?? null; }
export function unifiedPathForRequestFormat(format: string): string | null { return pathsByFormat.get(format) ?? null; }
