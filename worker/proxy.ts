import { accessIdentity } from "./access";
import { finalizeAccounting, reserveBudget, type BudgetReservation, type EstimatedCost } from "./accounting";
import { resolveCredentials, resolvePolicies, resolveUsers } from "./authority";
import { retainRequestContent } from "./content-retention";
import { correlationMetadata } from "./correlation.ts";
import {
  FUSION_MODEL_ID, buildAggregatorBody, buildFusionReservationProposals, collectFusionProposals,
  fusionMessagesValid,
} from "./fusion";
import { loadFusionConfig } from "./fusion-config";
import { observeGrantQuota, shouldFailoverGrant } from "./grant-quota";
import { grantRoutingPolicy, recordGrantRuntime } from "./grant-selection";
import {
  assertProviderAccess, capabilityForPath, copyRequestHeaders, endpointForPath, modelRoute, providerById,
  resolveTemplate, signSigV4, transformRequestBody, upstreamAuth, upstreamPath,
} from "./providers";
import { actualModelCost, estimateModelCost } from "./pricing";
import { extractUsageTokens, type UsageTokens } from "./token-usage";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledModel, CompiledProvider, CompiledQuotaConfig, Env, UsageEvent } from "./types";
import {
  errorResponse, HttpError, parseProxyKey, randomId, readJson, safeEqual, sha256Hex,
} from "./utils";

type AuthMode = "proxy_key" | "access";

interface ProxySelection {
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

interface PreparedUpstream {
  headers: Headers;
  url: URL;
  requestBody: string | undefined;
  grantKey: string | null;
  grantRevision: string | null;
}

interface ReservedProxyBudget {
  auth: AuthorizedIdentity;
  reservation: BudgetReservation;
  cost: EstimatedCost;
  providerId: string;
  modelId: string | null;
  capability: string;
}

interface CompoundRequestContext {
  id: string;
  stage: "fusion_adviser" | "fusion_synthesizer";
  index: number | null;
  size: number;
  startedAtMs: number;
}

export async function proxyOpenAi(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode): Promise<Response> {
  const preauthenticated = await preauthenticate(request, env, mode);
  if (preauthenticated instanceof Response) return preauthenticated;
  const body = requestObject(await readJson<unknown>(request));
  const modelId = typeof body.model === "string" ? body.model : "";
  if (!modelId) return errorResponse("model_required", "model is required", 400);
  if (modelId === FUSION_MODEL_ID) {
    if (path !== "/v1/chat/completions") return errorResponse("fusion_capability_unsupported", `${FUSION_MODEL_ID} supports only /v1/chat/completions`, 400);
    return proxyFusion(request, env, context, mode, body, preauthenticated);
  }
  return proxyConcreteOpenAi(request, env, context, path, mode, body, preauthenticated);
}

async function proxyConcreteOpenAi(
  request: Request,
  env: Env,
  context: ExecutionContext,
  path: string,
  mode: AuthMode,
  body: Record<string, unknown>,
  preauthenticated: AuthorizedIdentity | null,
  timeoutMs?: number,
  reservedBudget?: ReservedProxyBudget,
  compound?: CompoundRequestContext,
  auditAuth?: AuthorizedIdentity,
): Promise<Response> {
  const result = concreteOpenAiSelection(path, body, env, timeoutMs);
  if (isSelectionFailure(result)) {
    if (compound && result.auditSelection) await auditSelectionFailure(request, env, context, mode, result.auditSelection, preauthenticated, result.response.status, compound, auditAuth);
    return result.response;
  }
  return proxySelected(request, env, context, mode, result, {}, preauthenticated, reservedBudget, compound, auditAuth);
}

function concreteOpenAiSelection(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number): ProxySelection | ProxySelectionFailure {
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

function isSelectionFailure(value: ProxySelection | ProxySelectionFailure): value is ProxySelectionFailure {
  return "response" in value;
}

async function proxyFusion(
  request: Request,
  env: Env,
  context: ExecutionContext,
  mode: AuthMode,
  body: Record<string, unknown>,
  preauthenticated: AuthorizedIdentity | null,
): Promise<Response> {
  const compoundStartedAtMs = Date.now();
  const config = await loadFusionConfig(env);
  if (!config.enabled) return errorResponse("fusion_disabled", `${FUSION_MODEL_ID} is not enabled`, 404);
  if (!fusionMessagesValid(body.messages)) return errorResponse("fusion_messages_invalid", "fusion messages must be an array of objects with string roles", 400);
  const requestId = correlationMetadata(request).requestId;
  const compoundRequestId = randomId("fusion");
  const compoundRequestSize = config.adviserModels.length + 1;
  const fusionHeaders = new Headers(request.headers);
  fusionHeaders.set("x-request-id", requestId);
  // The original body was already parsed. Concrete routes serialize their transformed body separately.
  const fusionRequest = new Request(request.url, { method: request.method, headers: fusionHeaders, signal: request.signal });
  const aggregatorSelection = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), env);
  if (isSelectionFailure(aggregatorSelection)) {
    if (aggregatorSelection.auditSelection) await auditSelectionFailure(fusionRequest, env, context, mode, aggregatorSelection.auditSelection, preauthenticated, aggregatorSelection.response.status, {
      id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
    });
    return aggregatorSelection.response;
  }
  const aggregatorBudget = await reserveSelected(fusionRequest, env, context, mode, aggregatorSelection, preauthenticated, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
  });
  if (aggregatorBudget instanceof Response) return aggregatorBudget;
  const result = await collectFusionProposals(config, body, async (model, adviserBody, timeoutMs, index, signal) => {
    const headers = new Headers(fusionRequest.headers);
    headers.set("x-request-id", randomId(`fusion-adviser-${index + 1}`));
    const adviserRequest = new Request(fusionRequest.url, { method: "POST", headers, signal: AbortSignal.any([fusionRequest.signal, signal]) });
    return proxyConcreteOpenAi(adviserRequest, env, context, "/v1/chat/completions", mode, adviserBody, preauthenticated, timeoutMs, undefined, {
      id: compoundRequestId, stage: "fusion_adviser", index: index + 1, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
    }, aggregatorBudget.auth);
  });
  const aggregatorBody = buildAggregatorBody(body, config, result.proposals);
  const response = await proxyConcreteOpenAi(fusionRequest, env, context, "/v1/chat/completions", mode, aggregatorBody, preauthenticated, undefined, aggregatorBudget, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
  });
  const headers = new Headers(response.headers);
  headers.set("x-clawrouter-fusion", result.proposals.length ? "advisers" : "aggregator-only");
  headers.set("x-clawrouter-fusion-aggregator", config.aggregatorModel);
  headers.set("x-clawrouter-fusion-adviser-count", String(result.proposals.length));
  headers.set("x-clawrouter-fusion-failed-count", String(result.failedModels.length));
  headers.set("x-clawrouter-fusion-latency-ms", String(result.durationMs));
  if (result.proposals.length) headers.set("x-clawrouter-fusion-advisers", result.proposals.map((proposal) => proposal.model).join(","));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function proxyManifest(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode): Promise<Response> {
  const match = path.match(/^\/v1\/(?:playground\/)?proxy\/([^/]+)\/([^/]+)$/);
  if (!match) return errorResponse("route_not_found", "manifest proxy route not found", 404);
  const provider = providerById(decodeURIComponent(match[1]));
  const endpoint = provider?.endpoints.find((candidate) => candidate.id === decodeURIComponent(match[2]));
  if (!provider || !endpoint) return errorResponse("route_not_found", "manifest proxy route not found", 404);
  const preauthenticated = await preauthenticate(request, env, mode, provider.id);
  if (preauthenticated instanceof Response) return preauthenticated;
  const envelope = request.method === "GET" || request.method === "HEAD"
    ? directManifestEnvelope(request, endpoint)
    : manifestEnvelope(await readJson<unknown>(request));
  const method = (envelope.method ?? endpoint.method).toUpperCase();
  if (!endpoint.methods.includes(method)) return errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405);
  const prepared = prepareManifestRequest(provider, endpoint, envelope.body ?? {}, envelope.pathParams ?? {}, env);
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  const response = await proxySelected(request, env, context, mode, { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method }, envelope.query, preauthenticated);
  return response;
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

function directManifestEnvelope(request: Request, endpoint: CompiledEndpoint): { method: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> } {
  const query = new URL(request.url).searchParams;
  const pathParams: Record<string, string> = {};
  for (const name of endpoint.path_params) {
    const value = query.get(name);
    if (value != null) pathParams[name] = value;
    query.delete(name);
  }
  return { method: request.method, pathParams, query: searchParamsRecord(query), body: {} };
}

function manifestEnvelope(value: unknown): { method?: string; pathParams: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> } {
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

function requestObject(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request_body", `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export async function proxyNative(request: Request, env: Env, context: ExecutionContext, path: string): Promise<Response> {
  const match = path.match(/^\/v1\/native\/([^/]+)(\/.*)$/);
  if (!match) return errorResponse("route_not_found", "native proxy route not found", 404);
  const provider = providerById(decodeURIComponent(match[1]));
  if (!provider) return errorResponse("provider_not_found", "provider not found", 404);
  const preauthenticated = await authenticateProxyKey(request.headers, env);
  if (preauthenticated instanceof Response) return preauthenticated;
  const endpoint = provider.endpoints.find((candidate) => nativeMatch(candidate, match[2]));
  if (!endpoint || !endpoint.native_proxy) return errorResponse("route_not_found", "native provider route not found", 404);
  const method = request.method.toUpperCase();
  if (!endpoint.methods.includes(method)) return errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405);
  const body = request.method === "GET" || request.method === "HEAD" ? {} : requestObject(await readJson<unknown>(request));
  const prepared = prepareNativeRequest(provider, endpoint, body, match[2], env);
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  return proxySelected(request, env, context, "proxy_key", { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method }, searchParamsRecord(new URL(request.url).searchParams), preauthenticated);
}

export async function authenticateProxyKey(headers: Headers, env: Env): Promise<AuthorizedIdentity | Response> {
  const candidates = [headers.get("authorization")?.replace(/^Bearer\s+/i, ""), headers.get("x-api-key"), headers.get("x-goog-api-key"), headers.get("api-key")].filter(Boolean) as string[];
  const parsed = candidates.map(parseProxyKey).find(Boolean);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const credentialEntry = (await resolveCredentials(env, [parsed.kid]))[0];
  if (!credentialEntry) return errorResponse("unknown_proxy_key", "proxy key is not registered", 401);
  if (!safeEqual(await sha256Hex(parsed.secret), credentialEntry.credential.secretSha256.toLowerCase())) return errorResponse("invalid_proxy_key", "proxy key secret is invalid", 401);
  const policyEntry = (await resolvePolicies(env, [credentialEntry.credential.policyId]))[0];
  if (!policyEntry) return errorResponse("credential_policy_missing", "proxy credential references an unknown access policy", 403);
  if (!credentialEntry.credential.enabled) return errorResponse("proxy_key_revoked", "proxy key is revoked", 403);
  if (!policyEntry.policy.enabled) return errorResponse("policy_revoked", "access policy is revoked", 403);
  if (credentialEntry.credential.policyGeneration !== policyEntry.policy.generation) return errorResponse("credential_policy_stale", "proxy credential is not bound to the current access policy generation", 403);
  let exempt = false;
  if (credentialEntry.credential.principalId) exempt = (await resolveUsers(env, [credentialEntry.credential.principalId]))[0]?.record.contentRetentionDisabled ?? false;
  return {
    credentialId: parsed.kid,
    principalId: credentialEntry.credential.principalId ?? null,
    authType: "proxy_key",
    policyId: credentialEntry.credential.policyId,
    policy: policyEntry.policy,
    contentRetentionDisabled: exempt,
  };
}

export async function inspectKey(headers: Headers, env: Env): Promise<Response> {
  const candidates = [headers.get("authorization")?.replace(/^Bearer\s+/i, ""), headers.get("x-api-key"), headers.get("x-goog-api-key"), headers.get("api-key")].filter(Boolean) as string[];
  const parsed = candidates.map(parseProxyKey).find(Boolean);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const result = await authenticateProxyKey(headers, env);
  if (result instanceof Response) return result;
  return Response.json({
    kid: parsed.kid, mode: parsed.mode, syntaxValid: true, verified: true, verification: "verified",
    enabled: result.policy.enabled, providers: result.policy.providers, tenantId: result.policy.tenantId ?? null,
    tokenRole: result.policy.tokenRole ?? null, monthlyBudgetMicros: result.policy.monthlyBudgetMicros ?? null,
    requestCostMicros: result.policy.requestCostMicros ?? null, budgetScope: result.policy.budgetScope ?? "policy",
  });
}

async function proxySelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, queryInput: Record<string, unknown> = {}, preauthenticated: AuthorizedIdentity | null = null, reservedBudget?: ReservedProxyBudget, compound?: CompoundRequestContext, auditAuth?: AuthorizedIdentity): Promise<Response> {
  const auth = reservedBudget?.auth ?? await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) {
    if (compound && auditAuth) {
      const requestId = correlationMetadata(request).requestId;
      auditFailure(context, env, auditAuth, selection, request, requestId, Date.now(), estimateCost(selection.model, selection.body, auditAuth.policy.requestCostMicros, selection.capability), auth.status, auth.status === 403 ? "denied" : auth.status < 500 ? "client_error" : "provider_error", compound);
    }
    return auth;
  }
  const requestId = correlationMetadata(request).requestId;
  const started = Date.now();
  const estimatedCost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability);
  const cost = reservedBudget?.cost ?? estimatedCost;
  if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || estimatedCost.reserveMicros > reservedBudget.cost.reserveMicros)) {
    context.waitUntil(finalizeAccounting(env, auth, reservedBudget.reservation, 0, usageEvent(auth, selection, request, requestId, started, 500, null, cost, reservedBudget.reservation, null, "provider_error", 0, compound)));
    return errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
  }
  let prepared: PreparedUpstream;
  try { prepared = await prepareSelected(request, env, selection, queryInput, auth); }
  catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    if (reservedBudget) context.waitUntil(finalizeAccounting(env, auth, reservedBudget.reservation, 0, usageEvent(auth, selection, request, requestId, started, failure.status, null, cost, reservedBudget.reservation, null, status, 0, compound)));
    else auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, status, compound);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  let reservation = reservedBudget?.reservation;
  if (!reservation) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error", compound);
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  let content: string | null;
  try { content = await retainRequestContent(env, auth, selection, requestId); }
  catch {
    context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, 503, null, cost, reservation, null, "provider_error", 0, compound)));
    return errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  const controller = new AbortController();
  const endpointTimeout = selection.endpoint.timeout_ms ?? 120_000;
  const timeout = setTimeout(() => controller.abort(), Math.min(selection.timeoutMs ?? endpointTimeout, endpointTimeout));
  let response: Response;
  let grantFailover = false;
  try {
    response = await fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal: AbortSignal.any([request.signal, controller.signal]) });
    captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response);
    if (shouldFailoverGrant(response.status, selection.method, selection.capability, prepared.grantKey, grantRoutingPolicy(auth.policy.grantRouting).failover)) {
      try {
        const retry = await prepareSelected(request, env, selection, queryInput, auth, new Set([prepared.grantKey!]));
        const retryResponse = await fetch(retry.url, { method: selection.method, headers: retry.headers, body: retry.requestBody, signal: AbortSignal.any([request.signal, controller.signal]) });
        captureGrantRuntime(context, env, retry.grantKey, retry.grantRevision, selection.provider.quota, retryResponse);
        void response.body?.cancel().catch(() => undefined);
        response = retryResponse;
        grantFailover = true;
      } catch {
        // Keep the first provider response when no alternate grant is ready or its request fails.
      }
    }
    response = await normalizePreStreamError(response, selection.body.stream === true);
  } catch (error) {
    clearTimeout(timeout);
    context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, 502, null, cost, reservation, content, error instanceof DOMException && error.name === "AbortError" ? "timeout" : "provider_error", 0, compound)));
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  clearTimeout(timeout);
  const clone = response.clone();
  context.waitUntil(finalizeResponse(clone, env, auth, selection, request, requestId, started, cost, reservation, content, compound));
  const outputHeaders = new Headers(response.headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "trailer", "transfer-encoding", "upgrade"]) outputHeaders.delete(name);
  outputHeaders.set("x-clawrouter-upstream-provider", selection.provider.id);
  outputHeaders.delete("x-clawrouter-grant-failover");
  if (grantFailover) outputHeaders.set("x-clawrouter-grant-failover", "1");
  outputHeaders.set("x-clawrouter-content-retention", auth.policy.retainRequestContent !== false && !auth.contentRetentionDisabled ? "on; retention-days=30" : "off");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
}

export async function normalizePreStreamError(response: Response, streamingRequested: boolean): Promise<Response> {
  if (!streamingRequested) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  if (response.status >= 400) {
    if (eventStream && response.body) return normalizeFirstSseEvent(response, response.status);
    const body = await readLimited(response, 64 * 1024).catch(() => "");
    return mappedUpstreamError(response, upstreamError(body), response.status);
  }
  if (!response.ok || !eventStream || !response.body) return response;
  return normalizeFirstSseEvent(response, null);
}

const FIRST_SSE_EVENT_LIMIT = 8 * 1024;

async function normalizeFirstSseEvent(response: Response, errorStatus: number | null): Promise<Response> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  const sniffed = new Uint8Array(FIRST_SSE_EVENT_LIMIT);
  let sniffedLength = 0;
  let eventStart = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (value?.byteLength) {
      chunks.push(value);
      const copyLength = Math.min(value.byteLength, FIRST_SSE_EVENT_LIMIT - sniffedLength);
      if (copyLength > 0) {
        sniffed.set(value.subarray(0, copyLength), sniffedLength);
        sniffedLength += copyLength;
      }
    }
    while (eventStart < sniffedLength) {
      const boundary = sseEventBoundary(sniffed, eventStart, sniffedLength);
      if (!boundary) break;
      const event = classifySseEvent(sniffed.subarray(eventStart, boundary.start));
      eventStart = boundary.end;
      if (event.kind === "empty") continue;
      if (errorStatus !== null || event.kind === "error") {
        await reader.cancel().catch(() => undefined);
        const upstream = event.upstream;
        const status = errorStatus ?? (typeof upstream.code === "number" && Number.isInteger(upstream.code) && upstream.code >= 400 && upstream.code <= 599 ? upstream.code : 502);
        return mappedUpstreamError(response, upstream, status);
      }
      return replayResponse(response, reader, chunks, done);
    }
    if (done || sniffedLength === FIRST_SSE_EVENT_LIMIT) {
      if (errorStatus === null) return replayResponse(response, reader, chunks, done);
      if (!done) await reader.cancel().catch(() => undefined);
      return mappedUpstreamError(response, {}, errorStatus);
    }
  }
}

function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response {
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex++]);
        return;
      }
      if (readerDone) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function sseEventBoundary(bytes: Uint8Array, start: number, length: number): { start: number; end: number } | null {
  let lineStart = start;
  for (let index = start; index < length; index += 1) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    const next = bytes[index] === 13 && index + 1 < length && bytes[index + 1] === 10 ? index + 2 : index + 1;
    if (index === lineStart) return { start: lineStart, end: next };
    lineStart = next;
    index = next - 1;
  }
  return null;
}

function classifySseEvent(bytes: Uint8Array): { kind: "empty" } | { kind: "healthy" | "error"; upstream: ReturnType<typeof upstreamError> } {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of new TextDecoder().decode(bytes).split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  const data = dataLines.join("\n");
  if (dataLines.length === 0) return { kind: "empty" };
  const upstream = upstreamError(data);
  return eventType === "error" || hasTopLevelError(data) ? { kind: "error", upstream } : { kind: "healthy", upstream };
}

function hasTopLevelError(data: string): boolean {
  try {
    const value: unknown = JSON.parse(data);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "error");
  } catch { return false; }
}

function mappedUpstreamError(response: Response, upstream: ReturnType<typeof upstreamError>, status: number): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json({ error: {
    message: upstream.message ?? (response.ok ? "upstream request failed" : response.statusText || "upstream request failed"),
    type: upstream.type ?? "upstream_error",
    code: upstream.code ?? status,
  } }, { status, statusText: status === response.status ? response.statusText : "", headers });
}

function upstreamError(body: string): { message?: string; type?: string; code?: string | number } {
  let value: unknown;
  try {
    const eventData = firstSseData(body);
    value = JSON.parse(eventData || body);
  } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const error = "error" in value && value.error && typeof value.error === "object" && !Array.isArray(value.error) ? value.error as Record<string, unknown> : value as Record<string, unknown>;
  return {
    message: typeof error.message === "string" ? error.message : undefined,
    type: typeof error.type === "string" ? error.type : undefined,
    code: typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined,
  };
}

function firstSseData(body: string): string | null {
  const dataLines: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (!line) {
      if (dataLines.some((value) => value !== "")) break;
      dataLines.length = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, compound?: CompoundRequestContext): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  const requestId = correlationMetadata(request).requestId;
  const started = Date.now();
  const cost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability);
  try {
    await prepareSelected(request, env, selection, {}, auth, new Set(), false);
  } catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, status, compound);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost);
    return { auth, reservation, cost, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error", compound);
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

async function selectedAuth(request: Request, env: Env, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<AuthorizedIdentity | Response> {
  return preauthenticated ?? (mode === "access" ? accessIdentity(request, env, selection.provider.id) : authenticateProxyKey(request.headers, env));
}

async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: Record<string, unknown>, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true): Promise<PreparedUpstream> {
  try { await assertProviderAccess(selection.provider, auth, env); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider authorization failed"); }
  let upstream;
  const stickyHash = await grantStickyHash(request, auth);
  try { upstream = await upstreamAuth(selection.provider, selection.endpoint, auth, env, excludedGrantKeys, stickyHash, recordSelection); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_not_configured", "provider is not configured"); }
  try {
    const headers = new Headers(upstream.headers);
    copyRequestHeaders(request.headers, selection.provider, selection.endpoint, headers, env);
    const path = upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, upstream);
    const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${path}`);
    upstream.query.forEach((value, name) => url.searchParams.set(name, value));
    for (const [name, value] of Object.entries(selection.endpoint.query)) url.searchParams.set(name, resolveTemplate(selection.provider, value, env));
    for (const [name, value] of Object.entries(queryInput)) if (value != null) url.searchParams.set(name, String(value));
    const requestBody = ["GET", "HEAD"].includes(selection.method) ? undefined : JSON.stringify(selection.body);
    await signSigV4(selection.provider, url, selection.method, requestBody, headers, env, upstream.grant);
    return { headers, url, requestBody, grantKey: upstream.grantKey, grantRevision: upstream.grantRevision };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

function captureGrantRuntime(context: ExecutionContext, env: Env, key: string | null, revision: string | null, quota: CompiledQuotaConfig, response: Response): void {
  if (!key) return;
  const state = observeGrantQuota(response, quota);
  if (state) context.waitUntil(recordGrantRuntime(env, key, { ...state, grantRevision: revision }).catch(() => undefined));
}

async function grantStickyHash(request: Request, auth: AuthorizedIdentity): Promise<string | null> {
  const routing = grantRoutingPolicy(auth.policy.grantRouting);
  if (routing.stickiness === "none") return null;
  const identity = auth.principalId ?? auth.credentialId ?? auth.policyId;
  if (routing.stickiness === "identity") return sha256Hex(`identity:${identity}`);
  const sessionId = correlationMetadata(request).sessionId;
  return sha256Hex(`session:${sessionId ?? identity}`);
}

function selectedFailure(error: unknown): HttpError {
  return error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider request preflight failed");
}

function auditFailure(context: ExecutionContext, env: Env, auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, cost: Cost, statusCode: number, status: UsageEvent["status"], compound?: CompoundRequestContext): void {
  const reservation = { reservationId: null, reservedMicros: 0 };
  context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, statusCode, null, cost, reservation, null, status, 0, compound)));
}

async function auditSelectionFailure(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, statusCode: number, compound: CompoundRequestContext, auditAuth?: AuthorizedIdentity): Promise<void> {
  const selected = await selectedAuth(request, env, mode, selection, preauthenticated);
  const auth = selected instanceof Response ? auditAuth : selected;
  if (!auth) return;
  const requestId = correlationMetadata(request).requestId;
  const status = statusCode === 403 ? "denied" : statusCode < 500 ? "client_error" : "provider_error";
  auditFailure(context, env, auth, selection, request, requestId, Date.now(), estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability), statusCode, status, compound);
}

async function preauthenticate(request: Request, env: Env, mode: AuthMode, providerId?: string): Promise<AuthorizedIdentity | Response | null> {
  if (mode === "proxy_key") return authenticateProxyKey(request.headers, env);
  return providerId ? accessIdentity(request, env, providerId) : null;
}

async function finalizeResponse(response: Response, env: Env, auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, estimated: Cost, reservation: BudgetReservation, content: string | null, compound?: CompoundRequestContext): Promise<void> {
  let tokens: Tokens | null = null;
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) tokens = extractUsageTokens(JSON.parse(await readLimited(response, 2 * 1024 * 1024)));
    else if (contentType.includes("text/event-stream")) tokens = extractSseTokens(await readLimited(response, 2 * 1024 * 1024));
    else await drainResponseBody(response.body);
  } catch { /* usage is best-effort; reservation stays conservative */ }
  const measured = tokens ? actualCost(selection.model, tokens, auth.policy.requestCostMicros) : null;
  const actual = response.ok && measured != null ? measured : response.ok ? estimated.reserveMicros : 0;
  await finalizeAccounting(env, auth, reservation, actual, usageEvent(auth, selection, request, requestId, started, response.status, tokens, estimated, reservation, content, response.ok ? "success" : response.status < 500 ? "client_error" : "provider_error", actual, compound));
}

type Cost = EstimatedCost;
type Tokens = UsageTokens;

export function estimateCost(model: CompiledModel | null, body: Record<string, unknown>, fixed: number | null | undefined, capability: string): Cost {
  if (capability === "llm.count_tokens") return { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 };
  if (fixed != null) return { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  const pricing = model?.pricing;
  if (!pricing) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const estimate = estimateModelCost(pricing, body);
  return { reserveMicros: estimate.reserveMicros, basis: "manifest_pricing", inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens };
}

function actualCost(model: CompiledModel | null, tokens: Tokens, fixed: number | null | undefined): number | null {
  if (fixed != null) return fixed;
  const pricing = model?.pricing;
  if (!pricing) return 1;
  return actualModelCost(pricing, tokens);
}

function usageEvent(auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, statusCode: number, tokens: Tokens | null, cost: Cost, reservation: BudgetReservation, contentRef: string | null, status: UsageEvent["status"], actual = 0, compound?: CompoundRequestContext): UsageEvent {
  const correlation = correlationMetadata(request);
  return {
    id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: auth.policy.tenantId ?? "default",
    policy_id: auth.policyId, credential_id: auth.credentialId, principal_id: auth.principalId, auth_type: auth.authType,
    session_id: correlation.sessionId, agent_id: correlation.agentId, parent_agent_id: correlation.parentAgentId,
    project_id: correlation.projectId, client: correlation.client,
    key_id: auth.credentialId ?? auth.policyId, request_id: requestId,
    trace_id: correlation.traceId, span_id: correlation.spanId,
    compound_request_id: compound?.id ?? null, compound_request_stage: compound?.stage ?? null, compound_request_index: compound?.index ?? null,
    compound_request_size: compound?.size ?? null, compound_request_started_at_ms: compound?.startedAtMs ?? null,
    provider: selection.provider.id, capability: selection.capability,
    model: selection.model?.id ?? null, input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null,
    total_tokens: tokens?.total ?? null, cached_input_tokens: tokens?.cached ?? null, cache_write_input_tokens: tokens?.cacheWrite ?? null,
    reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual, reserved_input_tokens: cost.inputTokens,
    reserved_output_tokens: cost.outputTokens, pricing_ref: selection.model?.pricing_ref ?? null,
    pricing_effective_at: selection.model?.pricing?.effectiveAt ?? null, cost_basis: cost.basis, status_code: statusCode,
    duration_ms: Date.now() - started, content_retained: !!contentRef, content_ref: contentRef, status,
  };
}

function extractSseTokens(text: string): Tokens | null {
  let found: Tokens | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { found = extractUsageTokens(JSON.parse(data)) ?? found; } catch { /* ignore partial SSE events */ }
  }
  return found;
}

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("usage payload exceeds inspection limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { if (size > limit) await reader.cancel(); }
}

export async function drainResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done) { /* discard without buffering the cloned stream */ }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function searchParamsRecord(params: URLSearchParams): Record<string, string> { const result: Record<string, string> = {}; params.forEach((value, key) => { result[key] = value; }); return result; }

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

function nativeMatch(endpoint: CompiledEndpoint, path: string): boolean {
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
function nativeParams(endpoint: CompiledEndpoint, path: string): Record<string, string> {
  const names = [...endpoint.path.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "([^/]+)");
  const match = path.match(new RegExp(`^${pattern}$`));
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match?.[index + 1] ?? "")]));
}
