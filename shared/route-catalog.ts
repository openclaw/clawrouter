import type { ProviderRow, RouteCatalog } from "./contracts.ts";

export interface CatalogProvider extends ProviderRow {
  capabilities: Array<{ id: string; endpoint: string }>;
  routing: { modelPrefixes?: string[] };
  models: Array<{ id: string; capabilities: string[] }>;
  endpoints: Array<{ id: string; methods: string[]; path_params: string[]; request_format?: string | null; response_format?: string | null; streaming?: string | null }>;
}

export function modelSupportsEndpoint(provider: Pick<CatalogProvider, "capabilities">, model: { capabilities: string[] }, endpoint: { id: string }): boolean {
  return provider.capabilities.some((capability) => capability.endpoint === endpoint.id && model.capabilities.includes(capability.id));
}

export function createRouteCatalog(providers: CatalogProvider[]): RouteCatalog {
  const openaiCompatible = providers.filter((provider) => provider.class === "openai_compatible").map((provider) => ({
    provider: provider.id,
    models: provider.models.map((model) => ({
      id: model.id,
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
    models: provider.models.filter((model) => modelSupportsEndpoint(provider, model, endpoint)).map((model) => ({ id: model.id, capabilities: model.capabilities })),
    streaming: endpoint.streaming != null,
  })));
  return { openaiCompatible, manifestProxy };
}

function unifiedPathForCapability(capability: string): string { return capability === "llm.chat" ? "/v1/chat/completions" : capability === "llm.responses" ? "/v1/responses" : capability === "llm.decisions" ? "/v1/decisions" : capability === "llm.responses.compact" ? "/v1/responses/compact" : capability === "llm.count_tokens" ? "/v1/responses/input_tokens" : capability === "llm.moderations" ? "/v1/moderations" : capability === "llm.embeddings" ? "/v1/embeddings" : capability === "audio.speech" ? "/v1/audio/speech" : capability === "audio.transcription" ? "/v1/audio/transcriptions" : capability === "image.generation" ? "/v1/images/generations" : ""; }
