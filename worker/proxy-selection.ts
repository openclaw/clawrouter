import type { CompiledEndpoint, CompiledModel, CompiledProvider, Env } from "./types";
import { capabilityForPath, endpointForPath, modelRoute, resolveTemplate, transformRequestBody } from "./providers";
import { errorResponse, HttpError } from "./utils";

export interface ProxySelection {
  provider: CompiledProvider;
  endpoint: CompiledEndpoint;
  model: CompiledModel | null;
  capability: string;
  body: Record<string, unknown>;
  pathParams: Record<string, string>;
  method: string;
  timeoutMs?: number;
}

interface ProxySelectionFailure {
  response: Response;
  auditSelection: ProxySelection | null;
}

export function concreteOpenAiSelection(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number): ProxySelection | ProxySelectionFailure {
  const modelId = typeof body.model === "string" ? body.model : "";
  const route = modelRoute(modelId);
  if (!route) return selectionFailure(errorResponse("model_not_found", `model ${modelId} is not registered`, 404));
  const capability = capabilityForPath(path);
  const endpoint = endpointForPath(route.provider, path);
  if (!capability || !endpoint || !route.model.capabilities.includes(capability)) return selectionFailure(errorResponse("model_capability_unsupported", `model ${modelId} does not support ${path}`, 400));
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

export function prepareManifestRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, body: Record<string, unknown>, inputPathParams: Record<string, string>, env: Env): { model: CompiledModel | null; body: Record<string, unknown>; pathParams: Record<string, string> } {
  const modelId = typeof body.model === "string" ? body.model : null;
  const bodyRoute = modelId ? providerModelRoute(provider, modelId) : null;
  const globalBodyRoute = modelId ? modelRoute(modelId) : null;
  if (globalBodyRoute && globalBodyRoute.provider.id !== provider.id) throw new HttpError(400, "model_provider_mismatch", `model ${modelId} does not belong to provider ${provider.id}`);

  const pathModelId = inputPathParams.model ?? inputPathParams.deployment ?? null;
  const pathRoute = pathModelId ? providerModelRoute(provider, pathModelId) : null;
  const globalPathRoute = pathModelId ? modelRoute(pathModelId) : null;
  if (globalPathRoute && globalPathRoute.provider.id !== provider.id) throw new HttpError(400, "model_provider_mismatch", `model ${pathModelId} does not belong to provider ${provider.id}`);

  const bodyUpstream = bodyRoute ? resolvedUpstreamModel(provider, bodyRoute.model, env) : null;
  const pathUpstream = pathRoute ? resolvedUpstreamModel(provider, pathRoute.model, env) : pathModelId;
  if (bodyUpstream && pathUpstream && bodyUpstream !== pathUpstream) throw new HttpError(400, "model_path_mismatch", "body model and path model must resolve to the same upstream model");

  const model = bodyRoute?.model ?? pathRoute?.model ?? (!modelId && !pathModelId ? provider.models[0] ?? null : null);
  const upstreamModel = bodyUpstream ?? pathUpstream ?? (model && !model.upstream.includes("${") ? model.upstream : null);
  const pathParams = normalizeModelPathParams(provider, endpoint, inputPathParams, bodyRoute, env);
  const transformedInput = { ...body };
  if (endpoint.path_params.some((name) => name === "model" || name === "deployment")) delete transformedInput.model;
  else if (modelId && upstreamModel) transformedInput.model = upstreamModel;
  return {
    model,
    body: model && upstreamModel ? transformRequestBody(provider, endpoint.path, upstreamModel, transformedInput, env) : transformedInput,
    pathParams,
  };
}

export function prepareNativeRequest(provider: CompiledProvider, endpoint: CompiledEndpoint, body: Record<string, unknown>, path: string, env: Env): { model: CompiledModel | null; body: Record<string, unknown>; pathParams: Record<string, string> } {
  return prepareManifestRequest(provider, endpoint, body, nativeParams(endpoint, path), env);
}

export function directManifestEnvelope(request: Request, endpoint: CompiledEndpoint): { method: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> } {
  const query = new URL(request.url).searchParams;
  const pathParams: Record<string, string> = {};
  for (const name of endpoint.path_params) {
    const value = query.get(name);
    if (value != null) pathParams[name] = value;
    query.delete(name);
  }
  return { method: request.method, pathParams, query: searchParamsRecord(query), body: {} };
}

export function manifestEnvelope(value: unknown): { method?: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> } {
  const envelope = requestObject(value, "manifest request");
  if (envelope.method !== undefined && typeof envelope.method !== "string") throw new HttpError(400, "invalid_request_body", "manifest method must be a string");
  const pathParams = optionalObject(envelope.pathParams, "manifest pathParams");
  if (Object.values(pathParams).some((item) => typeof item !== "string")) throw new HttpError(400, "invalid_request_body", "manifest pathParams values must be strings");
  return {
    method: envelope.method as string | undefined,
    pathParams: pathParams as Record<string, string>,
    query: optionalObject(envelope.query, "manifest query"),
    body: optionalObject(envelope.body, "manifest body"),
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

function normalizeModelPathParams(provider: CompiledProvider, endpoint: CompiledEndpoint, input: Record<string, string>, bodyModel: ReturnType<typeof modelRoute>, env: Env): Record<string, string> {
  const output = { ...input };
  for (const name of endpoint.path_params.filter((param) => param === "model" || param === "deployment")) {
    const publicId = output[name];
    const globalRoute = publicId ? modelRoute(publicId) : bodyModel;
    if (globalRoute && globalRoute.provider.id !== provider.id) throw new HttpError(400, "model_provider_mismatch", `model ${publicId} does not belong to provider ${provider.id}`);
    const route = publicId ? providerModelRoute(provider, publicId) : bodyModel;
    if (route) output[name] = resolvedUpstreamModel(provider, route.model, env);
  }
  return output;
}

function providerModelRoute(provider: CompiledProvider, value: string): { provider: CompiledProvider; model: CompiledModel } | null {
  const global = modelRoute(value);
  if (global?.provider.id === provider.id) return global;
  const model = provider.models.find((candidate) => candidate.id === value || candidate.upstream === value);
  if (model) return { provider, model };
  const template = provider.models.find((candidate) => candidate.upstream.includes("${")) ?? provider.models[0];
  if (!template || !value) return null;
  const inheritsTemplatePricing = provider.id === "local-openai";
  return {
    provider,
    model: {
      ...template,
      id: value,
      upstream: value,
      pricing_ref: inheritsTemplatePricing ? template.pricing_ref : null,
      pricing: inheritsTemplatePricing ? template.pricing : null,
    },
  };
}

export function nativeMatch(endpoint: CompiledEndpoint, path: string): boolean {
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
function nativeParams(endpoint: CompiledEndpoint, path: string): Record<string, string> {
  const names = [...endpoint.path.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "([^/]+)");
  const match = path.match(new RegExp(`^${pattern}$`));
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match?.[index + 1] ?? "")]));
}
