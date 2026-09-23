import { emptyReservation, markBudgetDispatched, reserveBudget, type BudgetReservation } from "./accounting";
import { retainRequestContent } from "./content-retention";
import { HttpContinuation } from "./http-continuation";
import { authenticateProxyKey } from "./proxy-auth";
import { createProxyAccounting } from "./proxy-accounting";
import { concreteOpenAiSelection, isSelectionFailure, nativeMatch, prepareNativeRequest, searchParamsRecord, type ProxySelection } from "./proxy-selection";
import { captureGrantRuntime, prepareSelected } from "./proxy";
import { assertProviderAccess, providerById } from "./providers";
import { ResponsesOperationAborted, ResponsesWebSocketSession, type AdmittedResponse, type ResponsesCloseCause } from "./responses-websocket-session";
import { extractUsageTokens } from "./token-usage";
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
  new ResponsesWebSocketSession(pair[1], {
    waitUntil: (promise) => context.waitUntil(promise),
    async admit(body, lane, requestId, _pin, signal) {
      const auth = await authenticateProxyKey(request.headers, env);
      if (auth instanceof Response) throw await responseError(auth);
      if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "model_required", "each response.create requires a model");
      let selection: ProxySelection;
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
      const headers = new Headers(request.headers);
      headers.set("x-request-id", requestId);
      const operationRequest = new Request(request.url, { method: "POST", headers, signal });
      const accounting = createProxyAccounting({ env, context, auth, selection, request: operationRequest });
      let reservation = emptyReservation(), content: string | null = null;
      try {
        const continuation = await HttpContinuation.resolve(operationRequest, selection, auth, env, "websocket");
        const upstream = await prepareSelected(operationRequest, env, selection, searchParamsRecord(new URL(request.url).searchParams), auth, new Set(), true, undefined, continuation?.pinned ?? pinned, "websocket");
        if (upstream.continuation) continuation?.bind(upstream.continuation);
        if (!upstream.websocket) throw new HttpError(400, "websocket_transport_unsupported", "selected upstream grant transport is not qualified for Responses WebSockets");
        signal.throwIfAborted();
        reservation = await reserveBudget(env, auth, selection.capability, accounting.cost, upstream.connection);
        try { content = await retainRequestContent(env, auth, selection, requestId); }
        catch { throw new HttpError(503, "content_retention_unavailable", "required request-content retention is temporarily unavailable"); }
        await markBudgetDispatched(env, reservation);
        pinned ??= { providerId: selection.provider.id, endpointId: selection.endpoint.id, key: upstream.grantKey, revision: upstream.grantRevision };
        const observe = grantObserver(context, env, upstream.grantKey, upstream.grantRevision, selection.provider.quota);
        return {
          pin: JSON.stringify([selection.provider.id, selection.endpoint.id, upstream.grantKey, upstream.grantRevision, upstream.continuation?.routeSha256]),
          payload: JSON.stringify({ type: "response.create", ...selection.body, ...(lane ? { stream_id: lane } : {}) }),
          timeoutMs: selection.endpoint.timeout_ms ?? 120_000,
          connect: upstreamConnection(upstream.url, upstream.headers, signal, observe),
          publish: identities => continuation?.publish(identities) ?? Promise.resolve(),
          settle: settlement(accounting, reservation, content, observe),
        };
      } catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "Responses request preflight failed");
        const aborted = signal.aborted && signal.reason instanceof ResponsesOperationAborted ? signal.reason : null;
        const outcome = aborted ? closeStatus(aborted.cause) : {
          statusCode: failure.status,
          status: failure.status === 402 || failure.status === 403 ? "denied" as const : failure.status < 500 ? "client_error" as const : "provider_error" as const,
        };
        await requireAccounting(accounting.settle(outcome.statusCode, outcome.status, false, null, reservation, content));
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
    // execution starts, missing usage must retain the estimate, including on close.
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
