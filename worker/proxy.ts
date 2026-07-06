import { accessIdentity } from "./access";
import { finalizeAccounting, reserveBudget, type BudgetReservation, type EstimatedCost } from "./accounting";
import { resolveCredentials, resolvePolicies, resolveUsers } from "./authority";
import { retainRequestContent } from "./content-retention";
import {
  FUSION_MODEL_ID, buildAggregatorBody, buildFusionReservationProposals, collectFusionProposals,
  fusionMessagesValid,
} from "./fusion";
import { loadFusionConfig } from "./fusion-config";
import {
  assertProviderAccess, capabilityForPath, copyRequestHeaders, endpointForPath, modelRoute, providerById,
  resolveTemplate, signSigV4, transformRequestBody, upstreamAuth, upstreamPath,
} from "./providers";
import { actualModelCost, estimateModelCost } from "./pricing";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledModel, CompiledProvider, Env, UsageEvent } from "./types";
import {
  clampAudit, errorResponse, HttpError, parseProxyKey, randomId, readJson, safeEqual, sha256Hex,
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

interface PreparedUpstream {
  headers: Headers;
  url: URL;
  requestBody: string | undefined;
}

interface ReservedProxyBudget {
  auth: AuthorizedIdentity;
  reservation: BudgetReservation;
  cost: EstimatedCost;
  providerId: string;
  modelId: string | null;
  capability: string;
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
): Promise<Response> {
  const selection = concreteOpenAiSelection(path, body, env, timeoutMs);
  return selection instanceof Response ? selection : proxySelected(request, env, context, mode, selection, {}, preauthenticated, reservedBudget);
}

function concreteOpenAiSelection(path: string, body: Record<string, unknown>, env: Env, timeoutMs?: number): ProxySelection | Response {
  const modelId = typeof body.model === "string" ? body.model : "";
  const route = modelRoute(modelId);
  if (!route) return errorResponse("model_not_found", `model ${modelId} is not registered`, 404);
  const capability = capabilityForPath(path);
  const endpoint = endpointForPath(route.provider, path);
  if (!capability || !endpoint || !route.model.capabilities.includes(capability)) return errorResponse("model_capability_unsupported", `model ${modelId} does not support ${path}`, 400);
  try {
    const upstreamModel = resolvedUpstreamModel(route.provider, route.model, env);
    const transformed = transformRequestBody(route.provider, path, upstreamModel, { ...body, model: upstreamModel }, env);
    return { provider: route.provider, endpoint, model: route.model, capability, body: transformed, pathParams: { model: upstreamModel, deployment: upstreamModel }, method: "POST", timeoutMs };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

async function proxyFusion(
  request: Request,
  env: Env,
  context: ExecutionContext,
  mode: AuthMode,
  body: Record<string, unknown>,
  preauthenticated: AuthorizedIdentity | null,
): Promise<Response> {
  const config = await loadFusionConfig(env);
  if (!config.enabled) return errorResponse("fusion_disabled", `${FUSION_MODEL_ID} is not enabled`, 404);
  if (!fusionMessagesValid(body.messages)) return errorResponse("fusion_messages_invalid", "fusion messages must be an array of objects with string roles", 400);
  const aggregatorSelection = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), env);
  if (aggregatorSelection instanceof Response) return aggregatorSelection;
  const aggregatorBudget = await reserveSelected(request, env, context, mode, aggregatorSelection, preauthenticated);
  if (aggregatorBudget instanceof Response) return aggregatorBudget;
  const result = await collectFusionProposals(config, body, async (model, adviserBody, timeoutMs, index, signal) => {
    const headers = new Headers(request.headers);
    headers.set("x-request-id", randomId(`fusion-adviser-${index + 1}`));
    const adviserRequest = new Request(request.url, { method: "POST", headers, signal: AbortSignal.any([request.signal, signal]) });
    return proxyConcreteOpenAi(adviserRequest, env, context, "/v1/chat/completions", mode, adviserBody, preauthenticated, timeoutMs);
  });
  const aggregatorBody = buildAggregatorBody(body, config, result.proposals);
  const response = await proxyConcreteOpenAi(request, env, context, "/v1/chat/completions", mode, aggregatorBody, preauthenticated, undefined, aggregatorBudget);
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
  const body = envelope.body ?? {};
  const modelId = typeof body.model === "string" ? body.model : null;
  const globalModel = modelId ? modelRoute(modelId) : null;
  if (globalModel && globalModel.provider.id !== provider.id) return errorResponse("model_provider_mismatch", `model ${modelId} does not belong to provider ${provider.id}`, 400);
  const resolvedModel = modelId ? providerModelRoute(provider, modelId) : null;
  const model = modelId ? resolvedModel?.model ?? null : provider.models[0] ?? null;
  const upstreamModel = model ? resolvedUpstreamModel(provider, model, env) : null;
  const transformed = model ? transformRequestBody(provider, endpoint.path, upstreamModel!, { ...body, ...(modelId ? { model: upstreamModel } : {}) }, env) : body;
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  const pathParams = normalizeModelPathParams(provider, endpoint, envelope.pathParams ?? {}, resolvedModel, env);
  const response = await proxySelected(request, env, context, mode, { provider, endpoint, model, capability, body: transformed, pathParams, method }, envelope.query, preauthenticated);
  return response;
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
  const modelId = typeof body.model === "string" ? body.model : null;
  const globalModel = modelId ? modelRoute(modelId) : null;
  if (globalModel && globalModel.provider.id !== provider.id) return errorResponse("model_provider_mismatch", `model ${modelId} does not belong to provider ${provider.id}`, 400);
  const resolvedModel = modelId ? providerModelRoute(provider, modelId) : null;
  const model = resolvedModel?.model ?? null;
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  const upstreamModel = model ? resolvedUpstreamModel(provider, model, env) : null;
  const transformed = model ? transformRequestBody(provider, endpoint.path, upstreamModel!, { ...body, model: upstreamModel }, env) : body;
  return proxySelected(request, env, context, "proxy_key", { provider, endpoint, model, capability, body: transformed, pathParams: nativeParams(endpoint, match[2]), method }, searchParamsRecord(new URL(request.url).searchParams), preauthenticated);
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
    requestCostMicros: result.policy.requestCostMicros ?? null,
  });
}

async function proxySelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, queryInput: Record<string, unknown> = {}, preauthenticated: AuthorizedIdentity | null = null, reservedBudget?: ReservedProxyBudget): Promise<Response> {
  const auth = reservedBudget?.auth ?? await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  const requestId = request.headers.get("x-request-id") ?? randomId("req");
  const started = Date.now();
  const estimatedCost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability);
  const cost = reservedBudget?.cost ?? estimatedCost;
  if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || estimatedCost.reserveMicros > reservedBudget.cost.reserveMicros)) {
    context.waitUntil(finalizeAccounting(env, auth, reservedBudget.reservation, 0, usageEvent(auth, selection, request, requestId, started, 500, null, cost, reservedBudget.reservation, null, "provider_error")));
    return errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
  }
  let prepared: PreparedUpstream;
  try { prepared = await prepareSelected(request, env, selection, queryInput, auth); }
  catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    if (reservedBudget) context.waitUntil(finalizeAccounting(env, auth, reservedBudget.reservation, 0, usageEvent(auth, selection, request, requestId, started, failure.status, null, cost, reservedBudget.reservation, null, status)));
    else auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  let reservation = reservedBudget?.reservation;
  if (!reservation) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  let content: string | null;
  try { content = await retainRequestContent(env, auth, selection, requestId); }
  catch {
    context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, 503, null, cost, reservation, null, "provider_error")));
    return errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  const controller = new AbortController();
  const endpointTimeout = selection.endpoint.timeout_ms ?? 120_000;
  const timeout = setTimeout(() => controller.abort(), Math.min(selection.timeoutMs ?? endpointTimeout, endpointTimeout));
  let response: Response;
  try {
    response = await fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal: AbortSignal.any([request.signal, controller.signal]) });
  } catch (error) {
    clearTimeout(timeout);
    context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, 502, null, cost, reservation, content, error instanceof DOMException && error.name === "AbortError" ? "timeout" : "provider_error")));
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  clearTimeout(timeout);
  const clone = response.clone();
  context.waitUntil(finalizeResponse(clone, env, auth, selection, request, requestId, started, cost, reservation, content));
  const outputHeaders = new Headers(response.headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "trailer", "transfer-encoding", "upgrade"]) outputHeaders.delete(name);
  outputHeaders.set("x-clawrouter-upstream-provider", selection.provider.id);
  outputHeaders.set("x-clawrouter-content-retention", auth.policy.retainRequestContent !== false && !auth.contentRetentionDisabled ? "on; retention-days=30" : "off");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  const requestId = request.headers.get("x-request-id") ?? randomId("req");
  const started = Date.now();
  const cost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability);
  try {
    await prepareSelected(request, env, selection, {}, auth);
  } catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost);
    return { auth, reservation, cost, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    auditFailure(context, env, auth, selection, request, requestId, started, cost, failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

async function selectedAuth(request: Request, env: Env, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<AuthorizedIdentity | Response> {
  return preauthenticated ?? (mode === "access" ? accessIdentity(request, env, selection.provider.id) : authenticateProxyKey(request.headers, env));
}

async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: Record<string, unknown>, auth: AuthorizedIdentity): Promise<PreparedUpstream> {
  try { await assertProviderAccess(selection.provider, auth, env); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider authorization failed"); }
  let upstream;
  try { upstream = await upstreamAuth(selection.provider, selection.endpoint, auth, env); }
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
    return { headers, url, requestBody };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

function selectedFailure(error: unknown): HttpError {
  return error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider request preflight failed");
}

function auditFailure(context: ExecutionContext, env: Env, auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, cost: Cost, statusCode: number, status: UsageEvent["status"]): void {
  const reservation = { reservationId: null, reservedMicros: 0 };
  context.waitUntil(finalizeAccounting(env, auth, reservation, 0, usageEvent(auth, selection, request, requestId, started, statusCode, null, cost, reservation, null, status)));
}

async function preauthenticate(request: Request, env: Env, mode: AuthMode, providerId?: string): Promise<AuthorizedIdentity | Response | null> {
  if (mode === "proxy_key") return authenticateProxyKey(request.headers, env);
  return providerId ? accessIdentity(request, env, providerId) : null;
}

async function finalizeResponse(response: Response, env: Env, auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, estimated: Cost, reservation: BudgetReservation, content: string | null): Promise<void> {
  let tokens: Tokens | null = null;
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) tokens = extractTokens(JSON.parse(await readLimited(response, 2 * 1024 * 1024)));
    else if (contentType.includes("text/event-stream")) tokens = extractSseTokens(await readLimited(response, 2 * 1024 * 1024));
  } catch { /* usage is best-effort; reservation stays conservative */ }
  const measured = tokens ? actualCost(selection.model, tokens, auth.policy.requestCostMicros) : null;
  const actual = response.ok && measured != null ? measured : response.ok ? estimated.reserveMicros : 0;
  await finalizeAccounting(env, auth, reservation, actual, usageEvent(auth, selection, request, requestId, started, response.status, tokens, estimated, reservation, content, response.ok ? "success" : response.status < 500 ? "client_error" : "provider_error", actual));
}

type Cost = EstimatedCost;
interface Tokens { input: number | null; output: number | null; total: number | null; cached: number | null; cacheWrite: number | null; cacheWrite5m: number | null; cacheWrite1h: number | null }

function estimateCost(model: CompiledModel | null, body: Record<string, unknown>, fixed: number | null | undefined, capability: string): Cost {
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

function usageEvent(auth: AuthorizedIdentity, selection: ProxySelection, request: Request, requestId: string, started: number, statusCode: number, tokens: Tokens | null, cost: Cost, reservation: BudgetReservation, contentRef: string | null, status: UsageEvent["status"], actual = 0): UsageEvent {
  return {
    id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: auth.policy.tenantId ?? "default",
    policy_id: auth.policyId, credential_id: auth.credentialId, principal_id: auth.principalId, auth_type: auth.authType,
    session_id: clampAudit(request.headers.get("x-clawrouter-session-id") ?? request.headers.get("session-id")),
    agent_id: clampAudit(request.headers.get("x-clawrouter-agent-id")), parent_agent_id: clampAudit(request.headers.get("x-clawrouter-parent-agent-id")),
    project_id: clampAudit(request.headers.get("x-clawrouter-project-id")), client: clampAudit(request.headers.get("x-clawrouter-client")),
    key_id: auth.credentialId ?? auth.policyId, request_id: requestId, provider: selection.provider.id, capability: selection.capability,
    model: selection.model?.id ?? null, input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null,
    total_tokens: tokens?.total ?? null, cached_input_tokens: tokens?.cached ?? null, cache_write_input_tokens: tokens?.cacheWrite ?? null,
    reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual, reserved_input_tokens: cost.inputTokens,
    reserved_output_tokens: cost.outputTokens, pricing_ref: selection.model?.pricing_ref ?? null,
    pricing_effective_at: selection.model?.pricing?.effectiveAt ?? null, cost_basis: cost.basis, status_code: statusCode,
    duration_ms: Date.now() - started, content_retained: !!contentRef, content_ref: contentRef, status,
  };
}

function extractTokens(value: unknown): Tokens | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const usage = (root.usage ?? root.usageMetadata ?? root.meta) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const input = pickNumber(usage, "input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount");
  const output = pickNumber(usage, "output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount");
  const total = pickNumber(usage, "total_tokens", "totalTokens", "totalTokenCount") ?? (input != null || output != null ? (input ?? 0) + (output ?? 0) : null);
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const cached = details ? pickNumber(details, "cached_tokens", "cache_read_input_tokens") : pickNumber(usage, "cache_read_input_tokens");
  const cacheWrite = pickNumber(usage, "cache_creation_input_tokens");
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheWrite5m = cacheCreation ? pickNumber(cacheCreation, "ephemeral_5m_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_5m_input_tokens");
  const cacheWrite1h = cacheCreation ? pickNumber(cacheCreation, "ephemeral_1h_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_1h_input_tokens");
  return { input, output, total, cached, cacheWrite: cacheWrite5m != null || cacheWrite1h != null ? Math.max(0, (cacheWrite ?? 0) - (cacheWrite5m ?? 0) - (cacheWrite1h ?? 0)) : cacheWrite, cacheWrite5m, cacheWrite1h };
}

function extractSseTokens(text: string): Tokens | null {
  let found: Tokens | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { found = extractTokens(JSON.parse(data)) ?? found; } catch { /* ignore partial SSE events */ }
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

function pickNumber(value: Record<string, unknown>, ...keys: string[]): number | null { for (const key of keys) { const number = numeric(value[key]); if (number != null) return number; } return null; }
function numeric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null; }
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
  return model ? { provider, model } : null;
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
