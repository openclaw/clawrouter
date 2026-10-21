import { softBudget } from "./soft-budget.ts";
import { assertCompactAccount } from "./responses-compact.ts";
import { assertServiceTier } from "./service-tiers.ts";
import { grantStickyInput } from "./grant-sticky.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { resolveTemplate } from "./provider-templates.ts";
import { assessModelRequest } from "../shared/model-request-parameters.ts";
import { createProxyAccounting, estimateCost, type CompoundRequestContext } from "./proxy-accounting";
import { authenticateProxyKey, proxySessionHash } from "./proxy-auth";
import { admissionDuration } from "./admission-timing.ts";
import {
  concreteOpenAiSelection, directManifestEnvelope, isSelectionFailure, manifestEnvelope, nativeMatch, nativeParams,
  prepareManifestRequest, prepareNativeRequest, requestObject, searchParamsRecord, validateSelectedInput, type ProxySelection,
} from "./proxy-selection";
import { accessIdentity, accessSessionIdentity, verifiedAccessSession } from "./access";
import { markBudgetDispatched, reserveBudget, validateBudgetReservation, type BudgetReservation, type EstimatedCost } from "./accounting";
import { retainRequestContent, retentionRequired } from "./content-retention";
import { correlationMetadata } from "./correlation.ts";
import {
  FUSION_MODEL_ID, buildAggregatorBody, buildFusionReservationProposals, collectFusionProposals,
  fusionMessagesValid, prepareAdviserBody,
} from "./fusion";
import { loadFusionConfig } from "./fusion-config";
import { observeGrantQuota, shouldFailoverGrant } from "./grant-quota";
import { grantRoutingPolicy, recordGrantRuntime, type PinnedGrant } from "./grant-selection";
import type { ContinuationOwner } from "./continuation-store.ts";
import { HttpContinuation } from "./http-continuation.ts";
import { HttpBackground } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { backgroundResponse, requireEmptyResponseControlBody, responsesControl } from "./responses-lifecycle.ts";
import { proxyResponseControl } from "./response-controls.ts";
import { responseRouteDigest } from "./responses-control-dispatch.ts";
import {
  assertProviderAccess, capabilityForPath, copyRequestHeaders, modelRoute, providerById,
  signSigV4, upstreamAuth, upstreamPath,
} from "./providers";
import { applyTransportHeaders, assertOperationConfiguration, grantSupports, transformTransportBody } from "./provider-auth.ts";
import { normalizePreStreamError, observeUsage, proxyResponseHeaders } from "./proxy-response";
import type { AuthorizedIdentity, CompiledQuotaConfig, Env, ProviderConnection } from "./types";
import {
  decodePathSegment,
  errorResponse, HttpError, randomId, readJson,
} from "./utils";

type AuthMode = "proxy_key" | "access";

interface PreparedUpstream {
  headers: Headers;
  url: URL;
  requestBody: string | undefined;
  grantKey: string | null;
  grantLane: import("./types").GrantLane;
  grantRevision: string | null;
  connection: ProviderConnection;
  websocket: boolean;
  backgroundRecovery: boolean;
  continuation?: ContinuationOwner;
  revalidateCompactAccount?: () => Promise<void>;
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
  let body: Record<string, unknown>;
  try { body = requestObject(await readJson<unknown>(request)); }
  catch (error) {
    const auth = await preauthenticate(request, env, mode);
    if (auth instanceof Response) return auth;
    throw error;
  }
  const modelId = typeof body.model === "string" ? body.model : "";
  const earlySelection = concreteOpenAiSelection(path, body, env);
  const preauthenticated = await preauthenticate(request, env, mode, mode === "proxy_key" ? modelRoute(modelId, capabilityForPath(path) ?? undefined)?.provider.id : undefined, undefined, isSelectionFailure(earlySelection) ? undefined : earlySelection);
  if (preauthenticated instanceof Response) return preauthenticated;
  if (!modelId) return errorResponse("model_required", "model is required", 400);
  if (modelId === FUSION_MODEL_ID) {
    if (path !== "/v1/chat/completions") return errorResponse("fusion_capability_unsupported", `${FUSION_MODEL_ID} supports only /v1/chat/completions`, 400);
    return proxyFusion(request, env, context, mode, body, preauthenticated);
  }
  if (!isSelectionFailure(earlySelection)) return proxySelected(request, env, context, mode, earlySelection, {}, preauthenticated);
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
  const parameters = assessModelRequest(aggregatorSelection.model, aggregatorSelection.endpoint, aggregatorSelection.body as Record<string, unknown>);
  if (parameters.conflicts.length) {
    await auditSelectionFailure(fusionRequest, env, context, mode, aggregatorSelection, preauthenticated, 400, {
      id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
    });
    return errorResponse("model_parameter_unsupported", parameters.conflicts.map(({ message }) => message).join(" "), 400);
  }
  const aggregatorBudget = await reserveSelected(fusionRequest, env, context, mode, aggregatorSelection, preauthenticated, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
  });
  if (aggregatorBudget instanceof Response) return aggregatorBudget;
  const result = await collectFusionProposals(config, body, async (_model, adviserBody, timeoutMs, index, signal) => {
    const headers = new Headers(fusionRequest.headers);
    headers.set("x-request-id", randomId(`fusion-adviser-${index + 1}`));
    const adviserRequest = new Request(fusionRequest.url, { method: "POST", headers, signal: AbortSignal.any([fusionRequest.signal, signal]) });
    const compound: CompoundRequestContext = {
      id: compoundRequestId, stage: "fusion_adviser", index: index + 1, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
    };
    const selection = concreteOpenAiSelection("/v1/chat/completions", adviserBody, env, timeoutMs);
    if (isSelectionFailure(selection)) {
      if (selection.auditSelection) await auditSelectionFailure(adviserRequest, env, context, mode, selection.auditSelection, preauthenticated, selection.response.status, compound, aggregatorBudget.auth);
      return selection.response;
    }
    selection.body = prepareAdviserBody(selection.body as Record<string, unknown>, selection.model, selection.endpoint, config.temperature);
    return proxySelected(adviserRequest, env, context, mode, selection, {}, preauthenticated, undefined, compound, aggregatorBudget.auth);
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
  const provider = providerById(decodePathSegment(match[1]));
  const endpoint = provider?.endpoints.find((candidate) => candidate.id === decodePathSegment(match[2]));
  if (!provider || !endpoint) return errorResponse("route_not_found", "manifest proxy route not found", 404);
  const session = mode === "access" ? await verifiedAccessSession(request, env) : null;
  if (mode === "access" && !session) return errorResponse("access_session_required", "a verified session is required", 401);
  let preauthenticated: AuthorizedIdentity | Response | null = null;
  const control = responsesControl(provider, endpoint);
  if (control) {
    preauthenticated = await preauthenticate(request, env, mode, provider.id, { provider, endpoint, mode: "http" });
    if (preauthenticated instanceof Response) return preauthenticated;
    if (request.method === "GET") {
      if (endpoint.method !== "GET") return errorResponse("method_not_allowed", "control method is not allowed", 405);
      await requireEmptyResponseControlBody(request);
      const query = new URL(request.url).searchParams, ids = query.getAll("response_id");
      if (ids.length !== 1) throw new HttpError(400, "response_id_required", "one response_id path parameter is required");
      query.delete("response_id");
      return proxyResponseControl(request, env, control.action, ids[0], query, mode, provider.id, control.create.id, preauthenticated ?? undefined, session ?? undefined);
    }
    if (request.method !== "POST") return errorResponse("method_not_allowed", "control method is not allowed", 405);
    const envelope = manifestEnvelope(await readJson<unknown>(request));
    if ((envelope.method ?? endpoint.method).toUpperCase() !== endpoint.method || Object.keys(requestObject(envelope.body)).length || new URL(request.url).search) throw new HttpError(400, "invalid_response_control", "manifest controls accept a bodyless declared method and envelope query only");
    return proxyResponseControl(request, env, control.action, envelope.pathParams.response_id, envelope.query, mode, provider.id, control.create.id, preauthenticated ?? undefined, session ?? undefined);
  }
  // Controls resolve their original owner; creation keeps ordinary policy
  // selection, including transports that cannot provide durable recovery.
  let envelope, prepared;
  try {
    envelope = request.method === "GET" || request.method === "HEAD" ? directManifestEnvelope(request, endpoint) : manifestEnvelope(await readJson<unknown>(request));
    prepared = prepareManifestRequest(provider, endpoint, envelope.body, envelope.pathParams, env);
  } catch (error) {
    const auth = await preauthenticate(request, env, mode, provider.id);
    if (auth instanceof Response) return auth;
    throw error;
  }
  const method = (envelope.method ?? endpoint.method).toUpperCase();
  if (!endpoint.methods.includes(method)) { const auth = await preauthenticate(request, env, mode, provider.id); return auth instanceof Response ? auth : errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405); }
  if (!session) preauthenticated = await preauthenticate(request, env, mode, provider.id, undefined, { provider, endpoint, model: prepared.model, capability: provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id, body: prepared.body, pathParams: prepared.pathParams, method });
  if (session) preauthenticated = await accessSessionIdentity(session, env, provider.id, { provider, endpoint, mode: "http", model: prepared.model?.id });
  if (preauthenticated instanceof Response) return preauthenticated;
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  return proxySelected(request, env, context, mode, { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method }, envelope.query, preauthenticated);
}

export async function proxyNative(request: Request, env: Env, context: ExecutionContext, path: string): Promise<Response> {
  const match = path.match(/^\/v1\/native\/([^/]+)(\/.*)$/);
  if (!match) return errorResponse("route_not_found", "native proxy route not found", 404);
  const provider = providerById(decodePathSegment(match[1]));
  if (!provider) return errorResponse("provider_not_found", "provider not found", 404);
  const endpoint = provider.endpoints.find((candidate) => nativeMatch(candidate, match[2]));
  if (!endpoint || !endpoint.native_proxy) { const auth = await preauthenticate(request, env, "proxy_key", provider.id); return auth instanceof Response ? auth : errorResponse("route_not_found", "native provider route not found", 404); }
  const method = request.method.toUpperCase();
  if (!endpoint.methods.includes(method)) { const auth = await preauthenticate(request, env, "proxy_key", provider.id); return auth instanceof Response ? auth : errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405); }
  const control = responsesControl(provider, endpoint);
  if (control) {
    const preauthenticated = await preauthenticate(request, env, "proxy_key", provider.id);
    if (preauthenticated instanceof Response) return preauthenticated;
    await requireEmptyResponseControlBody(request);
    return proxyResponseControl(request, env, control.action, nativeParams(endpoint, match[2]).response_id, new URL(request.url).searchParams, "proxy_key", provider.id, control.create.id, preauthenticated ?? undefined);
  }
  let prepared;
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? {} : await readJson<unknown>(request);
    prepared = prepareNativeRequest(provider, endpoint, body, match[2], env);
  } catch (error) {
    const auth = await preauthenticate(request, env, "proxy_key", provider.id);
    if (auth instanceof Response) return auth;
    throw error;
  }
  const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
  const selection = { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method };
  const preauthenticated = await preauthenticate(request, env, "proxy_key", provider.id, undefined, selection);
  if (preauthenticated instanceof Response) return preauthenticated;
  return proxySelected(request, env, context, "proxy_key", selection, searchParamsRecord(new URL(request.url).searchParams), preauthenticated);
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
  validateSelectedInput(selection);
  const accountingContext = { context, env, auth, selection, request, compound, startedAtMs: Date.now() };
  let accounting: ReturnType<typeof createProxyAccounting> | undefined;
  let background: HttpBackground | undefined;
  let prepared: PreparedUpstream;
  let continuation: HttpContinuation | undefined;
  try {
    continuation = await HttpContinuation.resolve(request, selection, auth, env);
    prepared = await prepareSelected(request, env, selection, queryInput, auth, new Set(), true, reservedBudget?.connection, continuation?.pinned, "http", true);
    if (prepared.continuation) continuation?.bind(prepared.continuation);
    const cost = estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability, selection.endpoint, continuation?.parentTools);
    accounting = createProxyAccounting({ ...accountingContext, cost, grantKey: prepared.grantKey, grantLane: prepared.grantLane });
    if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || cost.reserveMicros > reservedBudget.cost.reserveMicros)) {
      accounting.fail(500, "provider_error", reservedBudget.reservation);
      return errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
    }
    // Monetary coverage alone cannot prove that the final request remains priced.
    if (reservedBudget) validateBudgetReservation(selection.capability, cost, auth.policy.monthlyBudgetMicros, reservedBudget.connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros);
  }
  catch (error) {
    const failure = selectedFailure(continuation?.preflightError(error) ?? error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    (accounting ?? createProxyAccounting(accountingContext)).fail(failure.status, status, reservedBudget?.reservation);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  const { cost, requestId } = accounting;
  const useSoft = auth.policy.budgetMode === "soft" && !prepared.backgroundRecovery && !reservedBudget && compound?.stage !== "fusion_synthesizer";
  let soft: ReturnType<typeof softBudget> | undefined;
  let budgetMs = 0;
  let upstreamMs = 0;
  const budgetStart = performance.now();
  let reservation = reservedBudget?.reservation;
  if (prepared.backgroundRecovery) {
    try {
      if (!prepared.continuation || !continuation || reservedBudget) throw new HttpError(400, "background_unsupported", "this route cannot own background recovery");
      const pathParams = Object.fromEntries(selection.endpoint.path_params.map(name => [name, selection.pathParams[name]]));
      background = await HttpBackground.prepare(request, env, auth, prepared.continuation, accounting.facts, prepared.connection, pathParams, prepared.headers, !Array.isArray(selection.body) && selection.body.stream === true);
      await background.admit();
      continuation.background(background.admission.id);
    } catch (error) {
      const failure = selectedFailure(error);
      // Once a durable admission was attempted, only that owner may account it.
      if (!background) accounting.fail(failure.status, failure.status === 402 ? "denied" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  } else if (!reservation && !useSoft) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  budgetMs = useSoft || !background && !reservation?.reservations.length ? 0 : performance.now() - budgetStart;
  let content: string | null;
  try { content = await retainRequestContent(env, auth, selection, requestId); }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", null));
    else accounting.fail(503, "provider_error", reservation);
    return errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  try {
    const dispatchStart = performance.now();
    if (background) await background.dispatch(content);
    else if (!useSoft) await markBudgetDispatched(env, reservation!);
    if (background || reservation?.reservations.length) budgetMs += performance.now() - dispatchStart;
  }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", content));
    else accounting.fail(503, "provider_error", reservation, content);
    return errorResponse("accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.", 503);
  }
  const endpointTimeout = selection.endpoint.timeout_ms ?? 120_000;
  const operation = new HttpOperation(request.signal, Math.min(selection.timeoutMs ?? endpointTimeout, endpointTimeout));
  const signal = operation.signal;
  // Compact alone requalifies after budget/retention awaits, under the same
  // cancellation/deadline owner as transport. Interrupted reads are known-unsent.
  if (prepared.revalidateCompactAccount) {
    try { signal.throwIfAborted(); await operation.wait(prepared.revalidateCompactAccount()); }
    catch (error) {
      const failure = signal.aborted ? new HttpError(502, "provider_unavailable", `upstream request to provider ${selection.provider.id} failed`) : selectedFailure(error);
      const status = operation.status ?? (failure.status < 500 ? "client_error" : "provider_error");
      operation.stop("upstream", error);
      accounting.fail(failure.status, status, reservation, content);
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  const discard = (response: Response) => { void response.body?.cancel(signal.reason).catch(() => undefined); };
  let response: Response | undefined;
  let grantFailover = false;
  let dispatched = false;
  try {
    // A canceled preflight is known-unsent even if the ledger marks already landed.
    signal.throwIfAborted();
    dispatched = true;
    const upstreamStart = performance.now();
    const pending = fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal });
    if (useSoft) {
      soft = softBudget(env, auth, selection.capability, prepared.connection, accounting.facts.event.id, error => operation.stop("upstream", error));
      reservation = soft.reservation;
      context.waitUntil(soft.check);
    }
    response = await operation.wait(pending, "upstream", discard);
    captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response);
    if (!background && !continuation?.requested && shouldFailoverGrant(response.status, selection.method, selection.capability, prepared.grantKey, grantRoutingPolicy(auth.policy.grantRouting).failover)) {
      let retry: PreparedUpstream | undefined;
      try {
        retry = await prepareSelected(request, env, selection, queryInput, auth, new Set([prepared.grantKey!]), true, prepared.connection);
      } catch {
        // Selection failure leaves the original rejection available to the caller.
      }
      if (retry) {
        signal.throwIfAborted();
        void response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
        // The alternate may execute without returning headers. Its uncertainty
        // must not inherit the discarded attempt's nonbillable rejection.
        response = undefined;
        prepared = retry;
        accounting.setGrant(prepared.grantKey, prepared.grantLane);
        response = await operation.wait(fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal }), "upstream", discard);
        captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response);
        if (prepared.continuation) continuation?.bind(prepared.continuation);
        grantFailover = true;
      }
    }
    upstreamMs = performance.now() - upstreamStart;
    if (soft) {
      budgetMs = await soft.beforeDelivery();
      if (soft.denial) throw soft.denial;
    }
    if (!response.ok) operation.acceptRejection(response.status);
    const streaming = Array.isArray(selection.body)
      ? selection.body.some(({ query }) => !!query && typeof query === "object" && "stream" in query && query.stream === true)
      : selection.body.stream === true;
    response = await normalizePreStreamError(response, streaming && selection.endpoint.response_format !== "audio.binary", operation);
  } catch (error) {
    soft?.close();
    if (soft?.denial) {
      operation.stop("upstream", soft.denial);
      void response?.body?.cancel().catch(() => undefined);
      accounting.fail(402, "denied", undefined, content);
      return errorResponse(soft.denial.code, soft.denial.message, 402);
    }
    operation.stop("upstream", error);
    void response?.body?.cancel().catch(() => undefined);
    // A fetch failure can incur cost; a received rejection stays nonbillable
    // even if reading its SSE error body failed.
    if (background) {
      if (!dispatched || response?.ok === false) context.waitUntil(background.unsent(response?.status ?? 502, operation.status ?? "provider_error", content));
      // Unknown dispatched delivery remains collectible; it is not a terminal.
    } else accounting.fail(502, operation.status ?? "provider_error", reservation, content, dispatched && response?.ok !== false);
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  // Endpoint timeouts cover fetch and first-event normalization, not delivery.
  // Retire only the timer; the caller and first cause still own delivery through EOF.
  operation.retireDeadline();
  if (continuation && response.ok && selection.capability !== "llm.responses.compact") {
    try { await operation.wait(continuation.headers(response), "publication"); }
    catch (error) {
      operation.stop("publication", error);
      discard(response);
      const failure = selectedFailure(error);
      if (!background) context.waitUntil(accounting.settle(failure.status, operation.status ?? "provider_error", true, null, reservation!, content));
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  const inspection = response.ok && selection.capability !== "llm.responses.compact" ? continuation?.inspect(response) : undefined;
  if (inspection && background) {
    const job = background;
    Object.assign(inspection, { observe: async (fact: import("./token-usage.ts").ResponsesObservation) => { await job.observe(fact, response!.status); } });
  }
  const observed = observeUsage(response, operation, inspection, selection.endpoint.response_format);
  if (background) {
    if (!response.ok) context.waitUntil(background.unsent(response.status, operation.status ?? "provider_error", content));
  } else context.waitUntil(observed.result.then(result => accounting.complete(observed.response, result, reservation!, content, operation.status)));
  response = observed.response;
  const outputHeaders = proxyResponseHeaders(response, selection.provider.id);
  outputHeaders.set("server-timing", `cr-admission;dur=${admissionDuration(auth).toFixed(1)}, cr-budget;dur=${budgetMs.toFixed(1)}, cr-upstream-ttfb;dur=${upstreamMs.toFixed(1)}`);
  outputHeaders.set("x-clawrouter-grant-lane", prepared.grantLane);
  if (grantFailover) outputHeaders.set("x-clawrouter-grant-failover", "1");
  outputHeaders.set("x-clawrouter-content-retention", retentionRequired(auth, selection.capability) ? "on; retention-days=30" : "off");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, compound?: CompoundRequestContext): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  let prepared: PreparedUpstream;
  try {
    prepared = await prepareSelected(request, env, selection, {}, auth, new Set(), false);
  } catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    createProxyAccounting({ context, env, auth, selection, request, compound }).fail(failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status);
  }
  const accounting = createProxyAccounting({ context, env, auth, selection, request, compound });
  const { cost } = accounting;
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection);
    return { auth, reservation, cost, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability, connection: prepared.connection };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

function selectionUpstreamModel(selection: ProxySelection): string | null {
  return !Array.isArray(selection.body) && typeof selection.body.model === "string" ? selection.body.model : selection.pathParams.model ?? selection.pathParams.deployment ?? null;
}

async function selectedAuth(request: Request, env: Env, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<AuthorizedIdentity | Response> {
  if (preauthenticated) return preauthenticated;
  if (mode === "access") return accessIdentity(request, env, selection.provider.id, { provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: selection.model?.id ?? selectionUpstreamModel(selection) });
  return (await preauthenticate(request, env, mode, selection.provider.id))!;
}

export async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: Record<string, unknown>, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection, pinned?: PinnedGrant, transport: "http" | "websocket" = "http", recoverBackground = false): Promise<PreparedUpstream> {
  assertPolicyModel(auth.policy, selection);
  assertServiceTier(auth, selection);
  if (selection.endpoint.request_format === "openai.images_generations" && (Object.keys(queryInput).length || new URL(request.url).search)) throw new HttpError(400, "invalid_image_generation", "image generation options must be in JSON, not query parameters");
  const compact = selection.endpoint.request_format === "openai.responses_compact";
  if (compact && (Object.keys(queryInput).length || new URL(request.url).search)) throw new HttpError(400, "invalid_compact_query", "compaction options must be in JSON, not query parameters");
  let connection: ProviderConnection;
  try { connection = await assertProviderAccess(selection.provider, auth, env, resolvedConnection); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider authorization failed"); }
  let upstream;
  const stickyHash = await grantStickyHash(request, auth);
  try { upstream = await upstreamAuth(selection.provider, auth, env, excludedGrantKeys, stickyHash, recordSelection, pinned, { provider: selection.provider, endpoint: selection.endpoint, mode: transport, model: selectionUpstreamModel(selection) }); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_not_configured", "provider is not configured"); }
  try {
    if (compact) await assertCompactAccount(auth, env, upstream);
    assertPolicyModel(auth.policy, selection);
    assertServiceTier(auth, selection, upstream.transport);
    const lifecycle = { provider: selection.provider, endpoint: selection.endpoint, mode: transport, responsesLifecycle: true };
    // Decide once from the materialized transport, before reservation. An
    // ordinary failover cannot promote an already reserved request into a job.
    const backgroundRecovery = recoverBackground && backgroundResponse(selection.endpoint, selection.body) && grantSupports(lifecycle, upstream.grant);
    if (backgroundRecovery) {
      assertOperationConfiguration(lifecycle, upstream.grant, env);
      if (Object.keys(queryInput).length || new URL(request.url).search) throw new HttpError(400, "background_query_unsupported", "background create options must be in JSON; caller query parameters are unsupported");
    }
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
    let continuation: ContinuationOwner | undefined;
    if (selection.capability === "llm.responses" || compact) {
      if (upstream.grantKey && !upstream.grant?.credentialLineage) throw new HttpError(503, "continuation_unavailable", "upstream credential ownership is unavailable");
      const create = compact ? selection.provider.endpoints.find(endpoint => endpoint.id === selection.provider.capabilities.find(capability => capability.id === "llm.responses")?.endpoint) : selection.endpoint;
      if (!create) throw new HttpError(503, "continuation_unavailable", "Responses creation ownership is unavailable");
      const ownerUrl = compact ? new URL(upstream.baseUrl.replace(/\/$/, "") + upstreamPath(selection.provider, create, {}, env, upstream)) : url;
      if (compact) upstream.query.forEach((value, name) => ownerUrl.searchParams.set(name, value));
      continuation = {
        providerId: selection.provider.id, endpointId: create.id, grantKey: upstream.grantKey,
        lineage: upstream.grant?.credentialLineage ?? null,
        // A WebSocket GET is only the handshake; both transports execute the
        // same logical Responses POST and must share continuation ownership.
        routeSha256: await responseRouteDigest(selection.provider, upstream, ownerUrl, headers, upstream.grantKey),
        policyGeneration: auth.policy.generation,
      };
    }
    return { headers, url, requestBody, grantKey: upstream.grantKey, grantLane: upstream.grantLane, grantRevision: upstream.grantRevision, connection, websocket: ["openai.responses", "openai.realtime"].includes(selection.endpoint.websocket ?? "") && upstream.transport === null, backgroundRecovery, continuation, ...(compact ? { revalidateCompactAccount: () => assertCompactAccount(auth, env, upstream) } : {}) };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

export function captureGrantRuntime(context: ExecutionContext, env: Env, key: string | null, revision: string | null, quota: CompiledQuotaConfig, response: Pick<Response, "status" | "headers">): void {
  if (!key) return;
  const state = observeGrantQuota(response, quota);
  if (state) context.waitUntil(recordGrantRuntime(env, key, { ...state, grantRevision: revision }).catch(() => undefined));
}

function grantStickyHash(request: Request, auth: AuthorizedIdentity): Promise<string | null> {
  return grantStickyInput(auth, proxySessionHash(auth), correlationMetadata(request).sessionId);
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

async function preauthenticate(request: Request, env: Env, mode: AuthMode, providerId?: string, requirement?: import("./provider-auth").GrantRequirement, selection?: ProxySelection): Promise<AuthorizedIdentity | Response | null> {
  if (mode === "proxy_key") {
    // Continuations select their recorded owner later. Invalid operations must
    // retain their existing error precedence without incrementing counters.
    if (selection) {
      try { validateSelectedInput(selection); }
      catch { selection = undefined; }
      if (selection && ["llm.responses", "llm.responses.compact"].includes(selection.capability) && (request.headers.has("x-codex-turn-state") || !Array.isArray(selection.body) && selection.body.previous_response_id)) selection = undefined;
    }
    const provider = providerId ? providerById(providerId) : null;
    return authenticateProxyKey(request.headers, env, provider ? [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }] : [], false, correlationMetadata(request).sessionId, selection ? { providerId: selection.provider.id, endpointId: selection.endpoint.id, mode: "http", model: selectionUpstreamModel(selection), catalogModelId: selection.model?.id ?? null, capability: selection.capability } : undefined);
  }
  return providerId ? accessIdentity(request, env, providerId, requirement) : null;
}
