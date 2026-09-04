import { createProxyAccounting, estimateCost, type CompoundRequestContext } from "./proxy-accounting";
import { authenticateProxyKey } from "./proxy-auth";
import {
  concreteOpenAiSelection, directManifestEnvelope, isSelectionFailure, manifestEnvelope, nativeMatch,
  prepareManifestRequest, prepareNativeRequest, requestObject, searchParamsRecord, type ProxySelection,
} from "./proxy-selection";
import { accessIdentity } from "./access";
import { reserveBudget, type BudgetReservation, type EstimatedCost } from "./accounting";
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
  assertProviderAccess, copyRequestHeaders, providerById,
  resolveTemplate, signSigV4, upstreamAuth, upstreamPath,
} from "./providers";
import { applyTransportHeaders, transformTransportBody } from "./provider-auth.ts";
import { normalizePreStreamError, observeUsage } from "./proxy-response";
import type { AuthorizedIdentity, CompiledQuotaConfig, Env, ProviderConnection } from "./types";
import {
  errorResponse, HttpError, randomId, readJson, sha256Hex,
} from "./utils";

type AuthMode = "proxy_key" | "access";

interface PreparedUpstream {
  headers: Headers;
  url: URL;
  requestBody: string | undefined;
  grantKey: string | null;
  grantRevision: string | null;
  connection: ProviderConnection;
}

interface ReservedProxyBudget {
  auth: AuthorizedIdentity;
  reservation: BudgetReservation;
  cost: EstimatedCost;
  providerId: string;
  modelId: string | null;
  capability: string;
  connection: ProviderConnection;
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
  return proxySelected(request, env, context, mode, { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method }, envelope.query, preauthenticated);
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

async function proxySelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, queryInput: Record<string, unknown> = {}, preauthenticated: AuthorizedIdentity | null = null, reservedBudget?: ReservedProxyBudget, compound?: CompoundRequestContext, auditAuth?: AuthorizedIdentity): Promise<Response> {
  const auth = reservedBudget?.auth ?? await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) {
    if (compound && auditAuth) {
      createProxyAccounting({ context, env, auth: auditAuth, selection, request, compound })
        .fail(auth.status, auth.status === 403 ? "denied" : auth.status < 500 ? "client_error" : "provider_error");
    }
    return auth;
  }
  const estimatedCost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability);
  const accounting = createProxyAccounting({ context, env, auth, selection, request, cost: reservedBudget?.cost ?? estimatedCost, compound });
  const { cost, requestId } = accounting;
  if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || estimatedCost.reserveMicros > reservedBudget.cost.reserveMicros)) {
    accounting.fail(500, "provider_error", reservedBudget.reservation);
    return errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
  }
  let prepared: PreparedUpstream;
  try { prepared = await prepareSelected(request, env, selection, queryInput, auth, new Set(), true, reservedBudget?.connection); }
  catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    accounting.fail(failure.status, status, reservedBudget?.reservation);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  let reservation = reservedBudget?.reservation;
  if (!reservation) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  let content: string | null;
  try { content = await retainRequestContent(env, auth, selection, requestId); }
  catch {
    accounting.fail(503, "provider_error", reservation);
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
        const retry = await prepareSelected(request, env, selection, queryInput, auth, new Set([prepared.grantKey!]), true, prepared.connection);
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
    accounting.fail(502, error instanceof DOMException && error.name === "AbortError" ? "timeout" : "provider_error", reservation, content);
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  clearTimeout(timeout);
  const observed = observeUsage(response);
  context.waitUntil(observed.tokens.then(tokens => accounting.complete(response, tokens, reservation, content)));
  response = observed.response;
  const outputHeaders = new Headers(response.headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "trailer", "transfer-encoding", "upgrade"]) outputHeaders.delete(name);
  outputHeaders.set("x-clawrouter-upstream-provider", selection.provider.id);
  outputHeaders.delete("x-clawrouter-grant-failover");
  if (grantFailover) outputHeaders.set("x-clawrouter-grant-failover", "1");
  outputHeaders.set("x-clawrouter-content-retention", auth.policy.retainRequestContent !== false && !auth.contentRetentionDisabled ? "on; retention-days=30" : "off");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, compound?: CompoundRequestContext): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  const accounting = createProxyAccounting({ context, env, auth, selection, request, compound });
  const { cost } = accounting;
  let prepared: PreparedUpstream;
  try {
    prepared = await prepareSelected(request, env, selection, {}, auth, new Set(), false);
  } catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    accounting.fail(failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection);
    return { auth, reservation, cost, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability, connection: prepared.connection };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

async function selectedAuth(request: Request, env: Env, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<AuthorizedIdentity | Response> {
  return preauthenticated ?? (mode === "access" ? accessIdentity(request, env, selection.provider.id) : authenticateProxyKey(request.headers, env));
}

async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: Record<string, unknown>, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection): Promise<PreparedUpstream> {
  let connection: ProviderConnection;
  try { connection = await assertProviderAccess(selection.provider, auth, env, resolvedConnection); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider authorization failed"); }
  let upstream;
  const stickyHash = await grantStickyHash(request, auth);
  try { upstream = await upstreamAuth(selection.provider, selection.endpoint, auth, env, excludedGrantKeys, stickyHash, recordSelection); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_not_configured", "provider is not configured"); }
  try {
    const headers = new Headers(upstream.headers);
    copyRequestHeaders(request.headers, selection.provider, selection.endpoint, headers, env);
    applyTransportHeaders(headers, upstream.transport, upstream.grant);
    const path = upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, upstream);
    const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${path}`);
    upstream.query.forEach((value, name) => url.searchParams.set(name, value));
    for (const [name, value] of Object.entries(selection.endpoint.query)) url.searchParams.set(name, resolveTemplate(selection.provider, value, env));
    for (const [name, value] of Object.entries(queryInput)) if (value != null) url.searchParams.set(name, String(value));
    const requestBody = ["GET", "HEAD"].includes(selection.method) ? undefined : JSON.stringify(transformTransportBody(upstream.transport, selection.body));
    await signSigV4(selection.provider, url, selection.method, requestBody, headers, env, upstream.grant);
    return { headers, url, requestBody, grantKey: upstream.grantKey, grantRevision: upstream.grantRevision, connection };
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

async function auditSelectionFailure(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, statusCode: number, compound: CompoundRequestContext, auditAuth?: AuthorizedIdentity): Promise<void> {
  const selected = await selectedAuth(request, env, mode, selection, preauthenticated);
  const auth = selected instanceof Response ? auditAuth : selected;
  if (!auth) return;
  const status = statusCode === 403 ? "denied" : statusCode < 500 ? "client_error" : "provider_error";
  createProxyAccounting({ context, env, auth, selection, request, compound }).fail(statusCode, status);
}

async function preauthenticate(request: Request, env: Env, mode: AuthMode, providerId?: string): Promise<AuthorizedIdentity | Response | null> {
  if (mode === "proxy_key") return authenticateProxyKey(request.headers, env);
  return providerId ? accessIdentity(request, env, providerId) : null;
}
