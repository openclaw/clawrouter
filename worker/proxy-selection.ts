import { googleAudioRequest } from "./google-audio-classification.ts";
import { prepareNativeBasetenSystemOne } from "./native-baseten-systemone.ts";
import { googleImageRequest } from "./google-image-classification.ts";
import { validateCompactRequest } from "./responses-compact.ts";
import { validateSpeechRequest } from "./speech-request.ts";
import { prepareNativeImage } from "./native-images.ts";
import { prepareNativeGoogleMusic } from "./native-google-music.ts";
import { prepareNativeGradiumSpeech } from "./native-gradium-speech.ts";
import type { NativeResponse } from "./native-response.ts";
import type { NativeQueryBinding } from "./native-query.ts";
import { nativeEmbeddingMode, prepareNativeEmbedding } from "./native-embeddings.ts";
import { selectRequestTariff } from "./request-tariff.ts";
import { prepareRadiusRequest } from "./provider-radius.ts";
import { prepareOllamaChatRequest } from "./provider-ollama.ts";
import { isStandaloneSearch, validateStandaloneSearch } from "./standalone-search.ts";
import { discoveryQuery, isModelDiscovery, prepareModelDiscovery } from "./model-discovery.ts";
import { validateResponsesInputTokens } from "./responses-input-tokens.ts";
import { validateImageGeneration } from "./image-generation.ts";
import { resolveTemplate } from "./provider-templates.ts";
import type { CompiledEndpoint, CompiledModel, CompiledProvider, Env, ProxyRequestBody } from "./types";
import { capabilityForPath, endpointForPath, modelRoute, modelSupportsEndpoint, providerForModel, providerModel, transformRequestBody, unifiedPathForEndpoint } from "./providers";
import { decodePathSegment, errorResponse, HttpError } from "./utils";

export interface ProxySelection {
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
  selection.nativeResponse = prepareNativeEmbedding(selection) ?? prepareNativeImage(selection) ?? prepareNativeBasetenSystemOne(selection) ?? prepareNativeGradiumSpeech(selection) ?? prepareNativeGoogleMusic(selection);
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

export function concreteOpenAiSelection(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number): ProxySelection | ProxySelectionFailure {
  const modelId = typeof body.model === "string" ? body.model : "";
  const capability = capabilityForPath(path);
  const route = modelRoute(modelId, capability ?? undefined);
  if (!route) return selectionFailure(errorResponse("model_not_found", `model ${modelId} is not registered`, 404));
  const endpoint = endpointForPath(route.provider, path);
  if (!capability || !endpoint || !route.model.capabilities.includes(capability)) return selectionFailure(errorResponse("model_capability_unsupported", `model ${modelId} does not support ${path}`, 400));
  if (unifiedPathForEndpoint(route.provider, endpoint) !== path) return selectionFailure(errorResponse("model_capability_unsupported", `model ${modelId} requires its provider-native endpoint`, 400));
  try {
    const upstreamModel = resolvedUpstreamModel(route.provider, route.model, env);
    const transformed = transformRequestBody(route.provider, path, upstreamModel, { ...body, model: upstreamModel }, env);
    return { provider: route.provider, endpoint, model: route.model, capability, body: transformed, pathParams: { model: upstreamModel, deployment: upstreamModel }, method: "POST", timeoutMs };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
    return selectionFailure(errorResponse(failure.code, failure.message, failure.status), {
      provider: route.provider, endpoint, model: route.model, capability, body, pathParams: { model: modelId, deployment: modelId }, method: "POST", timeoutMs,
    });
  }
}

function selectionFailure(response: Response, auditSelection: ProxySelection | null = null): ProxySelectionFailure {
  return { response, auditSelection };
}

export function isSelectionFailure(value: ProxySelection | ProxySelectionFailure): value is ProxySelectionFailure {
  return "response" in value;
}

export function prepareManifestRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, inputBody: unknown, inputPathParams: Record<string, string>, env: Env, native = false): { model: CompiledModel | null; body: ProxyRequestBody; pathParams: Record<string, string> } {
  if (endpoint.request_format === "cloudflare_ai_gateway.universal") {
    if (!Array.isArray(inputBody)) throw new HttpError(400, "invalid_request_body", "universal gateway body must be a JSON array");
    // Entries are ordered upstream fallbacks, not one model request. Keep their
    // native queries intact and do not invent a model or price for the wrapper.
    return { model: null, body: inputBody.map((entry) => requestObject(entry, "universal gateway entry")), pathParams: inputPathParams };
  }
  const body = requestObject(inputBody);
  // Managed job models are native inputs, not inference catalog selectors.
  // The explicit protocol adapter validates them before credential selection.
  if (endpoint.lifecycle) {
    if (endpoint.modelPassthrough) throw new HttpError(400, "invalid_managed_route", "managed lifecycles cannot use model passthrough");
    return { model: null, body, pathParams: inputPathParams };
  }
  if (endpoint.request_format === "openai.moderations" && body.model === undefined) body.model = "omni-moderation-latest";
  if (isModelDiscovery(endpoint)) return prepareModelDiscovery(provider, endpoint, body, inputPathParams);
  const embedding = nativeEmbeddingMode(endpoint.request_format);
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
  const bodyUpstream = bodyModel ? resolvedUpstreamModel(provider, bodyModel, env) : null;
  const pathUpstream = pathModel ? resolvedUpstreamModel(provider, pathModel, env) : null;
  if (bodyUpstream && pathUpstream && bodyUpstream !== pathUpstream) throw new HttpError(400, "model_path_mismatch", "body model and path model must resolve to the same upstream model");

  const model = bodyModel ?? pathModel;
  const upstreamModel = bodyUpstream ?? pathUpstream;
  const pathParams = { ...inputPathParams };
  for (const name of endpoint.path_params.filter((param) => param === "model" || param === "deployment")) {
    if (upstreamModel) pathParams[name] = upstreamModel;
  }
  if (embedding) return { model, body, pathParams };
  const transformedInput = { ...body };
  if (endpoint.path_params.some((name) => name === "model" || name === "deployment")) delete transformedInput.model;
  else if (modelId && upstreamModel) transformedInput.model = upstreamModel;
  return {
    model,
    body: model && upstreamModel ? transformRequestBody(provider, endpoint.path, upstreamModel, transformedInput, env) : transformedInput,
    pathParams,
  };
}

export function prepareNativeRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, body: unknown, path: string, env: Env): { model: CompiledModel | null; body: ProxyRequestBody; pathParams: Record<string, string> } {
  return prepareManifestRequest(provider, endpoint, body, nativeParams(endpoint, path), env, true);
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

export function manifestEnvelope(value: unknown): { method?: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: unknown } {
  const envelope = requestObject(value, "manifest request");
  if (envelope.method !== undefined && typeof envelope.method !== "string") throw new HttpError(400, "invalid_request_body", "manifest method must be a string");
  const pathParams = optionalObject(envelope.pathParams, "manifest pathParams");
  if (Object.values(pathParams).some((item) => typeof item !== "string")) throw new HttpError(400, "invalid_request_body", "manifest pathParams values must be strings");
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

function resolvedUpstreamModel(provider: CompiledProvider, model: CompiledModel, env: Env): string {
  return model.upstream.includes("${") ? resolveTemplate(provider, model.upstream, env) : model.upstream;
}

export function nativeMatch(endpoint: CompiledEndpoint, path: string): boolean {
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
export function nativeParams(endpoint: CompiledEndpoint, path: string): Record<string, string> {
  const names = [...endpoint.path.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "([^/]+)");
  const match = path.match(new RegExp(`^${pattern}$`));
  return Object.fromEntries(names.map((name, index) => [name, decodePathSegment(match?.[index + 1] ?? "")]));
}

// Several native protocols can share one model-qualified path. A registered
// model's declared capability chooses the operation, never YAML order or a
// guessed body shape. Stateful controls retain their original-owner resolver.
export function nativeModelEndpoint(provider: CompiledProvider, matching: CompiledEndpoint[], path: string, method: string): CompiledEndpoint | undefined {
  const candidates = matching.filter(endpoint => endpoint.native_proxy && endpoint.methods.includes(method));
  if (candidates.length < 2 || candidates.some(endpoint => endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket
    || !endpoint.path_params.some(name => name === "model" || name === "deployment"))) return;
  const qualified = candidates.filter(endpoint => {
    const params = nativeParams(endpoint, path), value = params.model ?? params.deployment;
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
