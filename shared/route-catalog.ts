import type { ModelAvailability } from "./model-availability";
import type { ProviderRow, RouteCatalog } from "./contracts.ts";

const googleSpeechPreviewCutoff = Date.parse("2026-11-17T00:00:00Z");
const generateContentSpeechModels = new Set([
  "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
]);
const interactionsSpeechModels = new Set(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);

// Compiled protocol and selected upstream identity are authority; request
// contents, router aliases and a shared capability cannot select a transport.
export function nativeModelEligible(requestFormat: string | null | undefined, selectedUpstreamModel: string | null | undefined, now = Date.now()): boolean {
  if (requestFormat === "google.speech_generate_content") return Number.isFinite(now) && now < googleSpeechPreviewCutoff
    && typeof selectedUpstreamModel === "string" && generateContentSpeechModels.has(selectedUpstreamModel);
  if (requestFormat === "google.speech_interactions") return Number.isFinite(now)
    && typeof selectedUpstreamModel === "string" && interactionsSpeechModels.has(selectedUpstreamModel);
  return true;
}

// Isolate and colo catalog entries cannot carry preview eligibility across the
// qualification boundary even when their normal freshness lease is still live.
export function nativeModelEligibilityRevision(now = Date.now()): string {
  return Number.isFinite(now) && now < googleSpeechPreviewCutoff ? "speech-preview-active-v1" : "speech-preview-expired-v1";
}

export interface CatalogProvider extends Pick<ProviderRow, "id" | "class"> {
  capabilities: Array<{ id: string; endpoint: string }>;
  routing: { modelPrefixes?: string[] };
  models: Array<{ id: string; upstream?: string; availability?: ModelAvailability; capabilities: string[] }>;
  endpoints: Array<{ id: string; methods: string[]; path_params: string[]; request_format?: string | null; response_format?: string | null; streaming?: string | null }>;
}

interface ModelIdentity { id: string; upstream?: string; availability?: ModelAvailability }

// Dispositions apply to this product's selected identity, not other providers
// or the alias target. Missing metadata does not assert live availability.
export function modelExecutable(provider: { models: readonly ModelIdentity[] }, model: ModelIdentity): boolean {
  const availability = model.availability;
  if (availability && (availability.version !== "clawrouter.model-availability.v1"
    || !["deprecated", "upstream_alias"].includes(availability.status))) return false;
  return !provider.models.some(row => row.availability?.status === "stopped"
    && (row.id === model.id || !!row.upstream && row.upstream === model.upstream));
}

export function modelSupportsEndpoint(provider: Pick<CatalogProvider, "capabilities" | "models">, model: CatalogProvider["models"][number], endpoint: { id: string; request_format?: string | null }): boolean {
  return modelExecutable(provider, model) && nativeModelEligible(endpoint.request_format, model.upstream)
    && provider.capabilities.some((capability) => capability.endpoint === endpoint.id && model.capabilities.includes(capability.id));
}

export function createRouteCatalog(providers: CatalogProvider[]): RouteCatalog {
  const openaiCompatible = providers.filter((provider) => provider.class === "openai_compatible").map((provider) => ({
    provider: provider.id,
    models: provider.models.filter(model => modelExecutable(provider, model)).flatMap((model) => {
      const capabilities = model.capabilities.filter(capability => legacyUnifiedCapability(provider, capability));
      if (!capabilities.length && model.capabilities.some(capability => capability === "llm.decisions" || capability === "audio.transcription")) return [];
      return [{
        id: model.id,
        ...(model.availability ? { availability: model.availability } : {}),
        capabilities,
        endpoints: capabilities.map(unifiedPathForCapability).filter(Boolean),
      }];
    }),
    modelPrefixes: provider.routing.modelPrefixes,
    endpoints: provider.capabilities.filter(capability => legacyUnifiedCapability(provider, capability.id))
      .map((capability) => unifiedPathForCapability(capability.id)).filter(Boolean),
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

// Decision and transcription capabilities alone do not establish an OpenAI wire contract. Match
// the same first capability binding used by unified request selection.
function legacyUnifiedCapability(provider: CatalogProvider, capability: string): boolean {
  const format = capability === "llm.decisions" ? "openai.decisions"
    : capability === "audio.transcription" ? "openai.audio_transcriptions" : null;
  if (!format) return true;
  const id = provider.capabilities.find(value => value.id === capability)?.endpoint;
  const endpoint = provider.endpoints.find(value => value.id === id);
  return endpoint?.request_format === format && endpoint.response_format === format
    && endpoint.methods.includes("POST");
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
