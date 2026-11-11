import { ownedErrorResponse } from "./http-identity-owner.ts";
import { checkOwnedHttpInitialSelection, admitOwnedHttpErrorText, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { beginPrivateConfiguration, consumePrivateConfiguration, endPrivateConfiguration } from "./provider-templates.ts";

import { prepareMiniMaxSearch } from "./minimax-search.ts";
import { miniMaxSearchRequirement, miniMaxSearchDenied } from "./minimax-search-credential.ts";
import { prepareVeniceChatBinding } from "./venice-chat-binding.ts";
import { prepareVeniceChatResponse } from "./venice-chat-runtime.ts";
import { prepareNativeMiniMaxImage } from "./native-minimax-images.ts";
import { prepareNativeMiniMaxSpeech } from "./native-minimax-speech.ts";
import { prepareNativeMiniMaxMusic } from "./native-minimax-music.ts";
import { miniMaxSpeechModels } from "./minimax-speech.ts";
import { isBedrockEmbeddingModel } from "./provider-bedrock-embeddings.ts";
import { googleAudioRequest } from "./google-audio-classification.ts";
import { prepareNativeBasetenSystemOne } from "./native-baseten-systemone.ts";
import { prepareNativeSage } from "./native-sage.ts";
import { prepareNativeSystemOne } from "./native-systemone.ts";
import { nativeModelEligible } from "../shared/native-model-eligibility.ts";
import { googleImageRequest } from "./google-image-classification.ts";
import { validateCompactRequest } from "./responses-compact.ts";
import { validateSpeechRequest } from "./speech-request.ts";
import { prepareNativeElevenLabsSpeech } from "./native-elevenlabs-speech.ts";
import { prepareNativeImage } from "./native-images.ts";
import { prepareNativeOpenRouterTranscription } from "./native-openrouter-transcription.ts";
import { prepareNativeOpenRouterPcmSpeech } from "./native-openrouter-pcm-speech.ts";
import { prepareNativeOpenRouterSpeech } from "./native-openrouter-speech.ts";
import { prepareNativeOpenRouterMusic } from "./native-openrouter-music.ts";
import { inlineMusicInput } from "./openrouter-music-runtime.ts";
import { publishedMusicInput } from "./published-music-runtime.ts";
import { prepareNativeDeepSeekSearch } from "./native-deepseek-search.ts";
import { prepareNativeGoogleMusic } from "./native-google-music.ts";
import { prepareNativeGoogleSpeech } from "./native-google-speech.ts";
import { prepareNativeGradiumSpeech } from "./native-gradium-speech.ts";
import { prepareNativeGoogleImage } from "./native-google-images.ts";
import type { NativeResponse } from "./native-response.ts";
import type { NativeQueryBinding } from "./native-query.ts";
import { nativeEmbeddingInput, prepareNativeEmbedding } from "./native-embeddings.ts";
import { selectRequestTariff } from "./request-tariff.ts";
import { prepareRadiusRequest } from "./provider-radius.ts";
import { prepareOllamaChatRequest } from "./provider-ollama.ts";
import { isStandaloneSearch, validateStandaloneSearch } from "./standalone-search.ts";
import { discoveryQuery, isModelDiscovery, prepareModelDiscovery } from "./model-discovery.ts";
import { validateResponsesInputTokens } from "./responses-input-tokens.ts";
import { validateImageGeneration } from "./image-generation.ts";
import { resolveTemplate, PreparationAdmission, isPreparationLimit } from "./provider-templates.ts";
import type { CompiledEndpoint, CompiledModel, CompiledProvider, Env, ProxyRequestBody } from "./types";
import { capabilityForPath, endpointForPath, modelRoute, modelSupportsEndpoint, providerForModel, providerModel, transformRequestBody, unifiedPathForEndpoint } from "./providers";
import { decodePathSegment, errorResponse, HttpError } from "./utils";

export interface ProxySelection {
  preparation?: PreparationAdmission;
  provider: CompiledProvider;
  endpoint: CompiledEndpoint;
  model: CompiledModel | null;
  capability: string;
  body: ProxyRequestBody;
  pathParams: Record<string, string>;
  method: string;
  timeoutMs?: number;
  nativeResponse?: NativeResponse;
  nativeQuery?: NativeQueryBinding;
}

export function validateSelectedInput(selection: ProxySelection): void {
  if (selection.endpoint.request_format === "minimax.search") {
    if (selection.model !== null || !miniMaxSearchRequirement({ provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: null })
      || selection.capability !== "search.web" || selection.method !== "POST" || Object.keys(selection.pathParams).length) miniMaxSearchDenied();
    prepareMiniMaxSearch(selection.provider.base_urls.default === "https://api.minimax.io" ? "global" : "cn", selection.body);
    return; // Factory receives its original owner-qualified origin during preparation.
  }
  if (selection.provider.id === "github-copilot")
    throw new HttpError(400, "copilot_public_route_required", "Copilot requires its exact owner-bound native or manifest route");
  if (selection.provider.id === "minimax"
    && ["music-2.6", "music-2.6-free", "music-cover", "music-cover-free"].includes(selection.model?.upstream ?? (!Array.isArray(selection.body) && typeof selection.body.model === "string" ? selection.body.model : ""))
    && (selection.endpoint.request_format !== "minimax.music" || selection.capability !== "music.generate"))
    throw new HttpError(400, "native_music_route_required", "MiniMax music requires its qualified native music route");
  if (selection.provider.id === "minimax" && (selection.model?.upstream === "image-01"
    || !Array.isArray(selection.body) && selection.body.model === "image-01")
    && (selection.endpoint.request_format !== "minimax.images" || selection.capability !== "image.generate"))
    throw new HttpError(400, "native_image_route_required", "MiniMax images require their qualified native image route");
  if (selection.provider.id === "minimax" && miniMaxSpeechModels.some(model => model === (selection.model?.upstream ?? (!Array.isArray(selection.body) ? selection.body.model : undefined)))
    && selection.endpoint.request_format !== "minimax.speech")
    throw new HttpError(400, "native_audio_route_required", "MiniMax speech models require their qualified native media route");
  if (selection.provider.id === "aws-bedrock" && (selection.model?.capabilities.includes("llm.embeddings")
    || isBedrockEmbeddingModel(selection.model?.upstream ?? selection.pathParams?.model ?? ""))
    && selection.capability !== "llm.embeddings")
    throw new HttpError(400, "native_embedding_route_required", "Bedrock embedding models require their qualified native embedding route");
  selection.nativeResponse = inlineMusicInput(selection)?.nativeResponse ?? publishedMusicInput(selection)?.nativeResponse ?? prepareNativeEmbedding(selection) ?? prepareNativeImage(selection)
    ?? prepareNativeBasetenSystemOne(selection) ?? prepareNativeSage(selection) ?? prepareNativeSystemOne(selection)
    ?? prepareNativeGradiumSpeech(selection)
    ?? prepareNativeGoogleImage(selection) ?? prepareNativeGoogleMusic(selection) ?? prepareNativeGoogleSpeech(selection)
    ?? prepareNativeOpenRouterTranscription(selection) ?? prepareNativeOpenRouterMusic(selection) ?? prepareNativeOpenRouterPcmSpeech(selection) ?? prepareNativeOpenRouterSpeech(selection)
    ?? prepareNativeDeepSeekSearch(selection) ?? prepareNativeMiniMaxSpeech(selection) ?? prepareNativeMiniMaxImage(selection) ?? prepareNativeMiniMaxMusic(selection)
    ?? prepareNativeElevenLabsSpeech(selection) ?? prepareVeniceChatResponse(selection);
  if (googleImageRequest(selection.model?.upstream ?? selection.pathParams?.model, selection.body, selection.endpoint.request_format)
    && (selection.endpoint.request_format !== "google.image_generate" || !selection.nativeResponse))
    throw new HttpError(400, "native_image_route_required", "Google image generation requires its qualified nonstream native image route");
  if (googleAudioRequest(selection.model?.upstream ?? selection.pathParams?.model, selection.body, selection.endpoint.request_format)
    && (!["google.music_generate", "google.speech_generate_content", "google.speech_interactions"].includes(selection.endpoint.request_format) || !selection.nativeResponse))
    throw new HttpError(400, "native_audio_route_required", "Google audio output requires its qualified nonstream native audio route");
  if (selection.nativeResponse) return;
  if (selection.endpoint.requestPricing) selectRequestTariff(selection.endpoint, selection.body);
  if (selection.endpoint.request_format === "radius.messages") {
    const body = requestObject(selection.body);
    try { selection.body = { ...prepareRadiusRequest(body, typeof body.model === "string" ? body.model : "") }; }
    catch { throw new HttpError(400, "invalid_radius_request", "native messages require a selected model, Pi context and valid options"); }
    return;
  }
  if (selection.endpoint.request_format === "ollama.chat") {
    const body = requestObject(selection.body);
    try { prepareOllamaChatRequest(body, typeof body.model === "string" ? body.model : ""); }
    catch { throw new HttpError(400, "invalid_ollama_chat_request", "native Chat requires a selected model, native messages and valid tools, thinking, stream and options fields"); }
    return;
  }
  if (isStandaloneSearch(selection.endpoint)) {
    if (!selection.model) throw new HttpError(400, "model_required", "standalone search requires a qualified registered model");
    validateStandaloneSearch(requestObject(selection.body));
    return;
  }
  if (selection.endpoint.request_format === "openai.responses_input_tokens") {
    validateResponsesInputTokens(requestObject(selection.body));
    if (!selection.model) throw new HttpError(400, "model_required", "a registered Responses model is required for input token counting");
    return;
  }
  if (selection.endpoint.request_format === "openai.responses_compact") {
    validateCompactRequest(requestObject(selection.body), selection.model);
    return;
  }
  if (selection.endpoint.request_format === "openai.images_generations") {
    const pricing = selection.model?.pricing;
    if (pricing?.unit !== "image_token") throw new HttpError(400, "image_model_unqualified", "a registered image generation tariff is required");
    validateImageGeneration(requestObject(selection.body), pricing);
    return;
  }
  if (selection.endpoint.request_format !== "openai.audio_speech") return;
  validateSpeechRequest(requestObject(selection.body), selection.model);
}

interface ProxySelectionFailure {
  response: Response;
  auditSelection: ProxySelection | null;
}

export function concreteOpenAiSelection(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number, preparation?: PreparationAdmission): ProxySelection | ProxySelectionFailure {
  return selectConcreteOpenAi(path, body, env, timeoutMs, preparation);
}
export function concreteOwnedOpenAiSelection(http: OwnedHttpRequest, request: Request, body: Record<string, unknown>, env: Env, preparation: PreparationAdmission): ProxySelection | ProxySelectionFailure {
  checkOwnedHttpInitialSelection(http, request, env, body, preparation);
  const nonce = beginPrivateConfiguration(http, preparation);
  try { return selectConcreteOpenAi("/v1/chat/completions", body, env, undefined, preparation, http, nonce); }
  finally { endPrivateConfiguration(preparation, nonce); }
}
function selectConcreteOpenAi(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number, preparation?: PreparationAdmission,
  http?: OwnedHttpRequest, nonce?: object): ProxySelection | ProxySelectionFailure {
  // Standalone selection (including WebSocket selection) begins one operation.
  // Proxy entries supply their existing token; returned selections carry it onward.
  preparation ??= new PreparationAdmission();
  const modelId = typeof body.model === "string" ? body.model : "";
  const capability = capabilityForPath(path);
  const route = modelRoute(modelId, capability ?? undefined);
  if (!route) return selectionFailure(http ? ownedSelectionError(http, 0, modelId, path)
    : errorResponse("model_not_found", `model ${modelId} is not registered`, 404));
  const endpoint = endpointForPath(route.provider, path);
  if (!capability || !endpoint || !route.model.capabilities.includes(capability)) return selectionFailure(http ? ownedSelectionError(http, 1, modelId, path)
    : errorResponse("model_capability_unsupported", `model ${modelId} does not support ${path}`, 400));
  if (unifiedPathForEndpoint(route.provider, endpoint) !== path) return selectionFailure(http ? ownedSelectionError(http, 2, modelId, path)
    : errorResponse("model_capability_unsupported", `model ${modelId} requires its provider-native endpoint`, 400));
  try {
    const upstreamModel = resolvedUpstreamModel(route.provider, route.model, env, preparation);
    const transformed = transformRequestBody(route.provider, path, upstreamModel, { ...body, model: upstreamModel }, env, preparation);
    return { preparation, provider: route.provider, endpoint, model: route.model, capability, body: transformed, pathParams: { model: upstreamModel, deployment: upstreamModel }, method: "POST", timeoutMs };
  } catch (error) {
    if (isPreparationLimit(error)) throw error;
    if (http) {
      const response = consumePrivateConfiguration(preparation!, nonce!, error)
        ? ownedErrorResponse(http, error.code, error.message, error.status)
        : ownedErrorResponse(http, "provider_request_invalid", "provider request configuration is invalid", 503);
      return selectionFailure(response, {
        provider: route.provider, endpoint, model: route.model, capability, body, pathParams: { model: modelId, deployment: modelId }, method: "POST", timeoutMs,
      });
    }
    const failure = error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
    return selectionFailure(errorResponse(failure.code, failure.message, failure.status), {
      provider: route.provider, endpoint, model: route.model, capability, body, pathParams: { model: modelId, deployment: modelId }, method: "POST", timeoutMs,
    });
  }
}

function ownedSelectionError(http: OwnedHttpRequest, kind: 0 | 1 | 2, model: string, path: string): Response {
  // The admission precedes every dynamic interpolation, including missing model.
  const units = 64 + model.length + (kind === 1 ? path.length : 0);
  admitOwnedHttpErrorText(http, units);
  return kind === 0 ? ownedErrorResponse(http, "model_not_found", `model ${model} is not registered`, 404)
    : kind === 1 ? ownedErrorResponse(http, "model_capability_unsupported", `model ${model} does not support ${path}`, 400)
    : ownedErrorResponse(http, "model_capability_unsupported", `model ${model} requires its provider-native endpoint`, 400);
}

function selectionFailure(response: Response, auditSelection: ProxySelection | null = null): ProxySelectionFailure {
  return { response, auditSelection };
}

export function isSelectionFailure(value: ProxySelection | ProxySelectionFailure): value is ProxySelectionFailure {
  return "response" in value;
}

export function prepareManifestRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, inputBody: unknown, inputPathParams: Record<string, string>, env: Env, native = false, preparation?: PreparationAdmission): { preparation: PreparationAdmission; model: CompiledModel | null; body: ProxyRequestBody; pathParams: Record<string, string> } {
  preparation ??= new PreparationAdmission(); // Explicit standalone selection entry.
  preparation.paths(inputPathParams, endpoint.path_param_styles);
  if (endpoint.request_format === "cloudflare_ai_gateway.universal") {
    if (!Array.isArray(inputBody)) throw new HttpError(400, "invalid_request_body", "universal gateway body must be a JSON array");
    // Entries are ordered upstream fallbacks, not one model request. Keep their
    // native queries intact and do not invent a model or price for the wrapper.
    return { preparation, model: null, body: inputBody.map((entry) => requestObject(entry, "universal gateway entry")), pathParams: inputPathParams };
  }
  const body = requestObject(inputBody);
  // Managed job models are native inputs, not inference catalog selectors.
  // The explicit protocol adapter validates them before credential selection.
  if (endpoint.lifecycle) {
    if (endpoint.modelPassthrough) throw new HttpError(400, "invalid_managed_route", "managed lifecycles cannot use model passthrough");
    return { preparation, model: null, body, pathParams: inputPathParams };
  }
  if (endpoint.request_format === "openai.moderations" && body.model === undefined) body.model = "omni-moderation-latest";
  if (isModelDiscovery(endpoint)) return { ...prepareModelDiscovery(provider, endpoint, body, inputPathParams), preparation };
  const embedding = nativeEmbeddingInput(provider, endpoint);
  // Native models/foo is a wire assertion, not a second router selector.
  const modelId = !embedding && typeof body.model === "string" ? body.model : null;
  const pathModelId = inputPathParams.model ?? inputPathParams.deployment ?? null;
  const resolve = (value: string | null) => {
    if (value === null) return null;
    const owner = providerForModel(value);
    if (!native && owner && owner.id !== provider.id) throw new HttpError(400, "model_provider_mismatch", `model ${value} does not belong to provider ${provider.id}`);
    const model = providerModel(provider, value, endpoint, native);
    if (!model || !modelSupportsEndpoint(provider, model, endpoint)) throw new HttpError(400, "model_capability_unsupported", `model ${value} does not support ${endpoint.id}`);
    return model;
  };
  const bodyModel = resolve(modelId), pathModel = resolve(pathModelId);
  const bodyUpstream = bodyModel ? resolvedUpstreamModel(provider, bodyModel, env, preparation) : null;
  const pathUpstream = pathModel ? resolvedUpstreamModel(provider, pathModel, env, preparation) : null;
  if (bodyUpstream && pathUpstream && bodyUpstream !== pathUpstream) throw new HttpError(400, "model_path_mismatch", "body model and path model must resolve to the same upstream model");

  const model = bodyModel ?? pathModel;
  if (!nativeModelEligible(endpoint.request_format, model?.upstream)) throw new HttpError(400, "model_capability_unsupported", "selected model is not qualified for this native protocol");
  const upstreamModel = bodyUpstream ?? pathUpstream;
  if (native && provider.id === "venice" && endpoint.request_format === "openai.chat_completions" && upstreamModel)
    prepareVeniceChatBinding(body, upstreamModel);
  const replacementKeys = endpoint.path_params.filter(param => param === "model" || param === "deployment");
  preparation.paths(inputPathParams, endpoint.path_param_styles, upstreamModel ?? undefined, replacementKeys);
  const pathParams = { ...inputPathParams };
  for (const name of replacementKeys) {
    if (upstreamModel) pathParams[name] = upstreamModel;
  }
  if (embedding) return { preparation, model, body, pathParams };
  const transformedInput = { ...body };
  if (endpoint.path_params.some((name) => name === "model" || name === "deployment")) delete transformedInput.model;
  else if (modelId && upstreamModel) transformedInput.model = upstreamModel;
  return {
    preparation, model,
    body: model && upstreamModel ? transformRequestBody(provider, endpoint.path, upstreamModel, transformedInput, env, preparation) : transformedInput,
    pathParams,
  };
}

export function prepareNativeRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, body: unknown, path: string, env: Env, preparation?: PreparationAdmission): { preparation: PreparationAdmission; model: CompiledModel | null; body: ProxyRequestBody; pathParams: Record<string, string> } {
  preparation ??= new PreparationAdmission(); // Standalone native selection.
  preparation.text(path, 8192);
  return prepareManifestRequest(provider, endpoint, body, nativeParams(endpoint, path, preparation), env, true, preparation);
}

export function directManifestEnvelope(request: Request, endpoint: CompiledEndpoint): { method: string; pathParams: Record<string, string>; query: URLSearchParams | Record<string, unknown>; body: Record<string, unknown> } {
  const query = new URL(request.url).searchParams;
  const pathParams: Record<string, string> = {};
  for (const name of endpoint.path_params) {
    const value = query.get(name);
    if (value != null) pathParams[name] = value;
    query.delete(name);
  }
  return { method: request.method, pathParams, query: isModelDiscovery(endpoint) ? discoveryQuery(query) : query, body: {} };
}

export function manifestEnvelope(value: unknown, preparation?: PreparationAdmission, pathParamStyles?: CompiledEndpoint["path_param_styles"]): { method?: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: unknown } {
  const envelope = requestObject(value, "manifest request");
  if (envelope.method !== undefined && typeof envelope.method !== "string") throw new HttpError(400, "invalid_request_body", "manifest method must be a string");
  const pathParams = optionalObject(envelope.pathParams, "manifest pathParams");
  let parameters = 0;
  for (const name in pathParams) if (Object.hasOwn(pathParams, name)) {
    if (++parameters > 32) preparation?.fail();
    if (typeof pathParams[name] !== "string") throw new HttpError(400, "invalid_request_body", "manifest pathParams values must be strings");
  }
  preparation?.paths(pathParams as Record<string, string>, pathParamStyles);
  return {
    method: envelope.method as string | undefined,
    pathParams: pathParams as Record<string, string>,
    query: optionalObject(envelope.query, "manifest query"),
    body: envelope.body === undefined ? {} : envelope.body,
  };
}

function optionalObject(value: unknown, label: string): Record<string, unknown> {
  return value === undefined ? {} : requestObject(value, label);
}

export function requestObject(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request_body", `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function searchParamsRecord(params: URLSearchParams): Record<string, string> { const result: Record<string, string> = {}; params.forEach((value, key) => { result[key] = value; }); return result; }

function resolvedUpstreamModel(provider: CompiledProvider, model: CompiledModel, env: Env, preparation?: PreparationAdmission): string {
  preparation?.text(model.upstream, 16384);
  return model.upstream.includes("${") ? resolveTemplate(provider, model.upstream, env, preparation) : model.upstream;
}

export function nativeMatch(endpoint: CompiledEndpoint, path: string): boolean {
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
export function nativeParams(endpoint: CompiledEndpoint, path: string, preparation?: PreparationAdmission): Record<string, string> {
  if (preparation) {
    preparation.text(path, 8192); let names = 0;
    for (const _ of endpoint.path.matchAll(/\$\{([^}]+)\}/g)) if (++names > 32) preparation.fail();
  }
  const names = [...endpoint.path.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "([^/]+)");
  const match = path.match(new RegExp(`^${pattern}$`));
  if (preparation) {
    let bytes = 0;
    for (let i = 0; i < names.length; i++) {
      preparation.text(names[i], 256); const raw = match?.[i + 1] ?? "";
      for (let offset = 0; offset < raw.length;) {
        if (raw[offset] === "%" && /^[0-9a-f]{2}$/i.test(raw.slice(offset + 1, offset + 3))) { bytes++; offset += 3; }
        else { const code = raw.codePointAt(offset)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; offset += code > 65535 ? 2 : 1; }
        if (bytes > 4096) preparation.fail();
      }
    }
  }
  return Object.fromEntries(names.map((name, index) => [name, decodePathSegment(match?.[index + 1] ?? "")]));
}

// Several native protocols can share one model-qualified path. A registered
// model's declared capability chooses the operation, never YAML order or a
// guessed body shape. Stateful controls retain their original-owner resolver.
export function nativeModelEndpoint(provider: CompiledProvider, matching: CompiledEndpoint[], path: string, method: string, body?: unknown): CompiledEndpoint | undefined {
  const candidates = matching.filter(endpoint => endpoint.native_proxy && endpoint.methods.includes(method));
  if (candidates.length < 2 || candidates.some(endpoint => endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.inputProfile)) return;
  const pathModel = candidates.every(endpoint => endpoint.path_params.some(name => name === "model" || name === "deployment"));
  // Same-wire Chat operations may declare distinct capabilities for an exact
  // registered body model. This is an identity selector, never content inference.
  const bodyModel = !pathModel && method === "POST" && candidates.every(endpoint => !endpoint.path_params.length
    && endpoint.request_format === "openai.chat_completions" && endpoint.response_format === "openai.chat_completions")
    && body !== null && typeof body === "object" && !Array.isArray(body) && "model" in body && typeof body.model === "string" ? body.model : null;
  if (!pathModel && !bodyModel) return;
  const qualified = candidates.filter(endpoint => {
    const params = nativeParams(endpoint, path), value = bodyModel ?? params.model ?? params.deployment;
    const model = provider.models.find(model => model.upstream === value);
    // A router alias is not an upstream model assertion on an overlapping native
    // path. Manifest routes continue to resolve their explicit router selector.
    if (!model && provider.models.some(model => model.id === value))
      throw new HttpError(400, "native_model_alias_unsupported", "overlapping native routes require the selected upstream model identity");
    return model && modelSupportsEndpoint(provider, model, endpoint);
  });
  if (qualified.length > 1) throw new HttpError(409, "native_route_ambiguous", "native model matches multiple declared operations");
  return qualified[0];
}
