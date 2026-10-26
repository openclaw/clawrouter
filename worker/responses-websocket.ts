import { correlationMetadata } from "./correlation";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { emptyReservation, markBudgetDispatched, reserveBudget, type BudgetReservation } from "./accounting";
import { retainRequestContent, retentionRequired } from "./content-retention";
import { continuationRestart, HttpContinuation } from "./http-continuation";
import { authenticateProxyKey } from "./proxy-auth";
import { createProxyAccounting, estimateCost } from "./proxy-accounting";
import { concreteOpenAiSelection, isSelectionFailure, nativeMatch, prepareNativeRequest, searchParamsRecord, type ProxySelection } from "./proxy-selection";
import { captureGrantRuntime, prepareSelected } from "./proxy";
import { assertProviderAccess, providerById } from "./providers";
import { ResponsesOperationAborted, ResponsesWebSocketSession, type AdmittedResponse, type ResponsesCloseCause } from "./responses-websocket-session";
import { extractUsageTokens } from "./token-usage";
import { softBudget, softBudgetPolicy, softBudgetPreflight } from "./soft-budget";
import type { CompiledQuotaConfig, Env, UsageEvent } from "./types";
import { decodePathSegment, errorResponse, HttpError } from "./utils";

export async function proxyResponsesWebSocket(request: Request, env: Env, context: ExecutionContext, path: string): Promise<Response> {
  const initialAuth = await authenticateProxyKey(request.headers, env);
  if (initialAuth instanceof Response) return initialAuth;
  const native = path.match(/^\/v1\/native\/([^/]+)(\/.*)$/);
  const provider = native ? providerById(decodePathSegment(native[1])) : null;
  const endpoint = native && provider?.endpoints.find((candidate) => nativeMatch(candidate, native[2]));
  if (native) {
    if (!provider || !endpoint?.native_proxy) return errorResponse("route_not_found", "native provider route not found", 404);
    if (endpoint.websocket !== "openai.responses") return errorResponse("websocket_unsupported", "this endpoint does not support Responses WebSockets", 400);
    await assertProviderAccess(provider, initialAuth, env);
  } else if (path !== "/v1/responses") return errorResponse("route_not_found", "Responses WebSocket route not found", 404);

  const pair = new WebSocketPair();
  pair[1].accept();
  let pinned: { providerId: string; endpointId: string; key: string | null; revision: string | null } | undefined;
  const connectionId = crypto.randomUUID();
  new ResponsesWebSocketSession(pair[1], {
    observeControl: (event) => console.log({ event: "responses_websocket_control", connection_id: connectionId, ...event }),
    waitUntil: (promise) => context.waitUntil(promise),
    async admit(body, lane, requestId, _pin, signal, witnesses) {
      let selection: ProxySelection;
      try {
        if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "model_required", "each response.create requires a model");
        if (native && provider && endpoint) {
          const prepared = prepareNativeRequest(provider, endpoint, body, native[2], env);
          selection = { provider, endpoint, ...prepared, capability: "llm.responses", method: "POST" };
        } else {
          const result = concreteOpenAiSelection("/v1/responses", body, env);
          if (isSelectionFailure(result)) throw await responseError(result.response);
          selection = result;
        }
        if (selection.endpoint.websocket !== "openai.responses" || !selection.model?.capabilities.includes("llm.responses")) throw new HttpError(400, "websocket_unsupported", "selected model route does not support Responses WebSockets");
        if (pinned && (pinned.providerId !== selection.provider.id || pinned.endpointId !== selection.endpoint.id)) throw new HttpError(409, "websocket_route_changed", "a WebSocket connection cannot change provider routes; open a new connection");
      } catch (error) {
        // Failed selection must still check this create's credential lifecycle.
        // Successful selection stays on the combined admission/snapshot path.
        const auth = await authenticateProxyKey(request.headers, env, [], false, correlationMetadata(request).sessionId);
        if (auth instanceof Response) throw await responseError(auth);
        throw error;
      }
      const auth = await authenticateProxyKey(request.headers, env, [{ id: selection.provider.id, tokenRef: selection.provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? selection.provider.id }], false, correlationMetadata(request).sessionId, {
        providerId: selection.provider.id, endpointId: selection.endpoint.id, mode: "websocket",
        model: !Array.isArray(selection.body) && typeof selection.body.model === "string" ? selection.body.model : null,
        catalogModelId: selection.model.id, capability: selection.capability, pinnedKey: pinned?.key,
      });
      if (auth instanceof Response) throw await responseError(auth);
      const headers = new Headers(request.headers);
      headers.set("x-request-id", requestId);
      const operationRequest = new Request(request.url, { method: "POST", headers, signal });
      const accountingContext = { env, context, auth, selection, request: operationRequest, startedAtMs: Date.now() };
      let accounting: ReturnType<typeof createProxyAccounting> | undefined;
      let reservation = emptyReservation(), content: string | null = null;
      let continuation: HttpContinuation | undefined;
      let useSoft = softBudgetPolicy(auth.policy);
      const reserveOptions = () => ({ dispatched: !retentionRequired(auth, selection.capability) });
      try {
        let cost: ReturnType<typeof estimateCost> | undefined;
        const resolve = HttpContinuation.resolve(operationRequest, selection, auth, env, "websocket", { witnesses, pin: pinned });
        const prepare = (pin: Parameters<typeof prepareSelected>[8]) => prepareSelected(operationRequest, env, selection, searchParamsRecord(new URL(request.url).searchParams), auth, new Set(), true, undefined, pin, "websocket");
        // Unpinned selection can refresh auth; only a pinned create can reserve
        // against this admission's connection while materialization is pending.
        const preparing = pinned ? prepare(pinned) : resolve.then(value => prepare(value?.pinned));
        const reserving = pinned && !useSoft ? resolve.then(async value => {
          cost = estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability), selection.capability, selection.endpoint, value?.parentTools);
          const connection = await assertProviderAccess(selection.provider, auth, env);
          signal.throwIfAborted();
          return reserveBudget(env, auth, selection.capability, cost, connection, undefined, reserveOptions());
        }) : Promise.resolve(undefined);
        const [resolved, prepared, reserved] = await Promise.allSettled([resolve, preparing, reserving]);
        if (reserved.status === "fulfilled" && reserved.value) reservation = reserved.value;
        if (resolved.status === "rejected") throw resolved.reason;
        continuation = resolved.value;
        // Failed recovery closes the session even when preparation also failed.
        if (reserved.status === "rejected" && reserved.reason instanceof HttpError && reserved.reason.code === "accounting_unavailable") throw reserved.reason;
        if (prepared.status === "rejected") throw prepared.reason;
        const upstream = prepared.value;
        // Unpinned credential failover can refresh policy during preparation.
        useSoft = softBudgetPolicy(auth.policy);
        // A foreign continuation used to reach the session's generic pin-change
        // close. Reject it here with the actionable continuation restart error.
        if (pinned && continuation?.pinned && (continuation.pinned.key !== pinned.key || "revision" in continuation.pinned && continuation.pinned.revision !== pinned.revision)) throw continuationRestart();
        if (upstream.continuation) continuation?.bind(upstream.continuation);
        cost ??= estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability), selection.capability, selection.endpoint, continuation?.parentTools);
        accounting = createProxyAccounting({ ...accountingContext, cost, grantKey: upstream.grantKey, grantLane: upstream.grantLane });
        if (!upstream.websocket) throw new HttpError(400, "websocket_transport_unsupported", "selected upstream grant transport is not qualified for Responses WebSockets");
        signal.throwIfAborted();
        if (reserved.status === "rejected") throw reserved.reason;
        if (useSoft) {
          const denial = softBudgetPreflight(env, auth, selection.capability, upstream.connection);
          if (denial) throw denial;
          reservation = { reservations: [], reservedMicros: 0, charges: [] };
        } else if (!pinned) reservation = await reserveBudget(env, auth, selection.capability, accounting.cost, upstream.connection, undefined, reserveOptions());
        try { content = await retainRequestContent(env, auth, selection, requestId); }
        catch { throw new HttpError(503, "content_retention_unavailable", "required request-content retention is temporarily unavailable"); }
        await markBudgetDispatched(env, reservation);
        pinned ??= { providerId: selection.provider.id, endpointId: selection.endpoint.id, key: upstream.grantKey, revision: upstream.grantRevision };
        const observe = grantObserver(context, env, upstream.grantKey, upstream.grantRevision, selection.provider.quota);
        const usageId = accounting.facts.event.id;
        return {
          pin: JSON.stringify([selection.provider.id, selection.endpoint.id, upstream.grantKey, upstream.grantRevision, upstream.continuation?.routeSha256]),
          payload: JSON.stringify({ type: "response.create", ...selection.body, ...(lane ? { stream_id: lane } : {}) }),
          timeoutMs: selection.endpoint.timeout_ms ?? 120_000,
          connect: upstreamConnection(upstream.url, upstream.headers, signal, observe),
          beforeSend: useSoft ? () => {
            const denial = softBudgetPreflight(env, auth, selection.capability, upstream.connection);
            if (denial) throw denial;
            const soft = softBudget(env, auth, selection.capability, upstream.connection, usageId);
            Object.assign(reservation, soft.reservation);
            context.waitUntil(soft.check);
          } : undefined,
          publish: async (identities, frame) => {
            await continuation?.publishFrame(identities, frame);
            continuation?.rememberWebSocket(witnesses, pinned!);
          },
          settle: settlement(accounting, reservation, content, observe),
        };
      } catch (error) {
        const preflightError = continuation?.preflightError(error) ?? error;
        const failure = preflightError instanceof HttpError ? preflightError : new HttpError(503, "provider_unavailable", "Responses request preflight failed");
        const aborted = signal.aborted && signal.reason instanceof ResponsesOperationAborted ? signal.reason : null;
        const outcome = aborted ? closeStatus(aborted.cause) : {
          statusCode: failure.status,
          status: failure.status === 402 || failure.status === 403 ? "denied" as const : failure.status < 500 ? "client_error" as const : "provider_error" as const,
        };
        await requireAccounting((accounting ?? createProxyAccounting(accountingContext)).settle(outcome.statusCode, outcome.status, false, null, reservation, content));
        if (aborted) throw aborted;
        throw failure;
      }
    },
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function upstreamConnection(url: URL, inputHeaders: Headers, signal: AbortSignal, observe: (response: Pick<Response, "status" | "headers">) => void): AdmittedResponse["connect"] {
  return async () => {
    const headers = new Headers(inputHeaders);
    headers.set("upgrade", "websocket");
    const response = await fetch(url, { method: "GET", headers, signal, redirect: "manual" });
    observe(response);
    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel();
      throw new HttpError(response.status >= 400 ? response.status : 502, "upstream_upgrade_failed", `upstream rejected the WebSocket upgrade with HTTP ${response.status}`);
    }
    response.webSocket.accept();
    return response.webSocket;
  };
}

function settlement(accounting: ReturnType<typeof createProxyAccounting>, reservation: BudgetReservation, content: string | null, observe: (response: Pick<Response, "status" | "headers">) => void): AdmittedResponse["settle"] {
  return (outcome, terminal, sent, executionStarted) => {
    // The upgrade response already owns its HTTP quota observation. Only sent
    // creates can report a later WebSocket error with new quota evidence.
    if (sent && terminal?.type === "error" && typeof terminal.status === "number" && [401, 403, 429].includes(terminal.status)) {
      const headers = new Headers();
      if (terminal.headers && typeof terminal.headers === "object" && !Array.isArray(terminal.headers)) {
        for (const [name, value] of Object.entries(terminal.headers)) if (typeof value === "string") { try { headers.set(name, value); } catch { /* Invalid optional quota headers do not hide the native error. */ } }
      }
      observe({ status: terminal.status, headers });
    }
    const tokens = terminal ? extractUsageTokens(terminal) : null;
    const { status, statusCode } = outcome === "completed" || outcome === "incomplete" ? { status: "success" as const, statusCode: 200 }
      : outcome === "failed" || outcome === "error" ? { status: "provider_error" as const, statusCode: typeof terminal?.status === "number" ? terminal.status : 502 }
      : closeStatus(outcome);
    // A request-scoped error before a response is rejected work. Once upstream
    // execution starts, reserve mode retains its estimate on missing usage;
    // soft mode charges only observed usage or an explicit fixed tariff.
    const billable = sent && (outcome !== "error" || executionStarted || tokens !== null);
    return requireAccounting(accounting.settle(statusCode, status, billable, tokens, reservation, content));
  };
}

function closeStatus(cause: ResponsesCloseCause): { status: UsageEvent["status"]; statusCode: UsageEvent["status_code"] } {
  if (cause === "client_disconnect") return { status: "client_error", statusCode: null };
  if (cause === "timeout") return { status: "timeout", statusCode: 504 };
  if (cause === "client_protocol_error" || cause === "router_limit") return { status: "client_error", statusCode: 400 };
  return { status: "provider_error", statusCode: cause === "router_error" ? 503 : 502 };
}

async function requireAccounting(result: Promise<boolean>): Promise<void> {
  if (!await result) throw new HttpError(503, "accounting_unavailable", "Response accounting could not finish; open a new connection.");
}

async function responseError(response: Response): Promise<HttpError> {
  const body = await response.json<{ error: { code: string; message: string } }>();
  return new HttpError(response.status, body.error.code, body.error.message);
}

function grantObserver(context: ExecutionContext, env: Env, key: string | null, revision: string | null, quota: CompiledQuotaConfig) {
  return (response: Pick<Response, "status" | "headers">) => captureGrantRuntime(context, env, key, revision, quota, response);
}
