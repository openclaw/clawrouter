import { assertMultipartDestination, multipartRoute, multipartSelection, prepareMultipart, readMultipartResponse } from "./transcription-protocol.ts";
import { nativeJsonResponse, nativeResponseLease } from "./native-response.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { grantRevision, type PinnedGrant } from "./grant-selection.ts";
import { accessIdentity } from "./access.ts";
import { emptyReservation, markBudgetDispatched, reserveBudget, settleBudget, type BudgetReservation } from "./accounting.ts";
import { correlationMetadata } from "./correlation.ts";
import { HttpOperation } from "./http-operation.ts";
import { createProxyAccounting } from "./proxy-accounting.ts";
import { authenticateProxyKey } from "./proxy-auth.ts";
import { observeUsage, proxyResponseHeaders } from "./proxy-response.ts";
import { assertProviderAccess, configuredUpstream, upstreamAuth, modelSupportsEndpoint, providerById, providerModel } from "./providers.ts";
import { prepareSelected, captureGrantRuntime } from "./proxy.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { softBudget, softBudgetPolicy } from "./soft-budget.ts";
import { readBinaryUpload, readBounded, readTranscriptionUpload, transcriptionLimits } from "./transcription-body.ts";
import { transcriptionUsage } from "./transcription-usage.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { decodePathSegment, errorResponse, HttpError } from "./utils.ts";

function rawTranscriptionRoute(path: string): { provider: CompiledProvider; endpoint: CompiledEndpoint } | null {
  const match = path.replace(/^\/v1\/playground\//, "/v1/").match(/^\/v1\/(native|proxy)\/([^/]+)(\/.*)$/);
  if (!match) return null;
  const provider = providerById(decodePathSegment(match[2]));
  const endpoint = provider?.endpoints.find(endpoint => endpoint.request_format === "deepgram.prerecorded"
    && (match[1] === "native" ? endpoint.native_proxy && endpoint.path === match[3] : `/${endpoint.id}` === match[3]));
  return provider && endpoint ? { provider, endpoint } : null;
}

export function transcriptionPath(path: string): boolean {
  return ["/v1/audio/transcriptions", "/v1/native/openai/v1/audio/transcriptions", "/v1/proxy/openai/transcriptions"].includes(path) || multipartRoute(path) !== null || rawTranscriptionRoute(path) !== null;
}

export async function proxyTranscription(request: Request, env: Env, context: ExecutionContext, mode: "proxy_key" | "access" = "proxy_key"): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/v1\/playground\//, "/v1/"), protocol = multipartRoute(path), rawRoute = rawTranscriptionRoute(path);
  // Authentication precedes even content-type/length checks and any stream read.
  const initial = mode === "access" ? await accessIdentity(request, env, protocol?.providerId ?? rawRoute?.provider.id ?? "openai") : await authenticateProxyKey(request.headers, env);
  if (initial instanceof Response) return initial;
  if (request.method !== "POST") return errorResponse("method_not_allowed", "transcription requires POST", 405);
  const nativeQuery = new URL(request.url).searchParams;
  if (!rawRoute && nativeQuery.size) return errorResponse("transcription_option_unsupported", "transcription options must be multipart fields", 400);
  const registered = protocol ? multipartSelection(protocol) : undefined;
  const provider = rawRoute?.provider ?? registered?.provider ?? providerById("openai")!;
  const endpoint = rawRoute?.endpoint ?? registered?.endpoint ?? provider.endpoints.find(item => item.id === "transcriptions")!;
  let selection: ProxySelection = registered ?? { provider, endpoint,
    model: rawRoute ? null : provider.models.find(item => item.id === "openai/gpt-4o-transcribe")!,
    capability: "audio.transcription", body: {}, pathParams: {}, method: "POST" };
  const admit = (fresh: boolean) => {
    const model = selection.model!;
    return mode === "access" ? accessIdentity(request, env, provider.id, { provider, endpoint, mode: "http", model: model.upstream })
      : authenticateProxyKey(request.headers, env, [{ id: provider.id, tokenRef: provider.id }], false, correlationMetadata(request).sessionId, {
        providerId: provider.id, endpointId: endpoint.id, mode: "http", model: model.upstream, catalogModelId: model.id, capability: selection.capability,
      }, fresh ? "authoritative" : "cached");
  };
  let admitted: AuthorizedIdentity | undefined, original: Awaited<ReturnType<typeof upstreamAuth>> | undefined, pinned: PinnedGrant | undefined;
  if (protocol) {
    const before = await admit(true); if (before instanceof Response) return before; admitted = before;
    assertPolicyModel(before.policy, selection); await assertProviderAccess(provider, before, env);
    original = await upstreamAuth(provider, before, env, new Set(), null, true, undefined, { provider, endpoint, mode: "http", model: selection.model!.upstream });
    if (original.grant && original.grant.kind !== "api_key") throw new HttpError(400, "grant_transport_unavailable", "native transcription requires its original API key");
    pinned = { key: original.grantKey, revision: original.grantRevision };
  }
  const deadline = Date.now() + (endpoint.timeout_ms ?? 120_000);
  const capacity = protocol ? nativeResponseLease(48 * 1024 * 1024) : undefined;
  let transferred = false;
  try {
  let upload: Awaited<ReturnType<typeof readTranscriptionUpload>> | undefined;
  let raw: { bytes: Uint8Array<ArrayBuffer>; contentType: string; query: URLSearchParams } | undefined;
  let form: FormData | undefined, nativeHeaders: Headers | undefined;
  if (rawRoute) {
    if (endpoint.method !== "POST" || endpoint.path !== "/v1/listen" || endpoint.response_format !== "deepgram.prerecorded"
      || endpoint.path_params.length || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.streaming || endpoint.websocket
      || endpoint.modelPassthrough || Object.keys(endpoint.query).length
      || !provider.capabilities.some(item => item.id === "audio.transcription" && item.endpoint === endpoint.id && item.methods.includes("POST"))) throw new HttpError(400, "transcription_route_unsupported", "raw transcription requires a qualified synchronous native route");
    const { deepgramAudioLimit, prepareDeepgramPrerecorded } = await import("./deepgram-prerecorded.ts");
    const bytes = await readBinaryUpload(request, deepgramAudioLimit);
    let prepared;
    try { prepared = prepareDeepgramPrerecorded(bytes, request.headers.get("content-type") ?? "", nativeQuery); }
    catch { throw new HttpError(400, "transcription_option_unsupported", "raw transcription requires supported binary audio and native query options"); }
    const model = providerModel(provider, prepared.query.get("model")!, endpoint, true);
    if (!model || !modelSupportsEndpoint(provider, model, endpoint)) throw new HttpError(400, "model_capability_unsupported", "the native transcription model is not qualified for this route");
    raw = { bytes, contentType: prepared.contentType, query: prepared.query };
    selection = { provider, endpoint, model, capability: "audio.transcription", body: { model: model.upstream }, pathParams: {}, method: "POST" };
  } else {
    upload = await readTranscriptionUpload(request, protocol ? { maximumReads: 8192, exactLength: true, timeoutMs: Math.max(1, Math.min(transcriptionLimits.readMs, deadline - Date.now())) } : undefined);
    if (protocol) { const multipart = prepareMultipart(protocol, selection, upload); form = multipart.body; nativeHeaders = multipart.headers; }
    else {
      const model = selection.model!, native = path.includes("/native/");
      if (upload.fields.model !== model.id && !(native && upload.fields.model === model.upstream)) return errorResponse("model_capability_unsupported", "this route supports only openai/gpt-4o-transcribe", 400);
      selection.body = { ...upload.fields, model: model.upstream };
    }
  }
  const model = selection.model!;
  // Both native upload profiles bypass stale post-upload admission. Multipart
  // additionally retains the original pre-upload credential through dispatch.
  const auth = await admit(!!protocol || !!raw);
  if (auth instanceof Response) return auth;
  if (admitted && !sameCaller(admitted, auth)) throw new HttpError(403, "transcription_owner_changed", "upload caller ownership changed");
  const accounting = createProxyAccounting({ request, env, context, auth, selection });
  const operation = new HttpOperation(request.signal, protocol ? Math.max(1, deadline - Date.now()) : endpoint.timeout_ms ?? 120_000);
  let reservation: BudgetReservation = emptyReservation(), dispatched = false, response: Response | undefined;
  let soft: ReturnType<typeof softBudget> | undefined;
  let settled = false;
  const settle = async (statusCode: number, billable: boolean, tokens: ReturnType<typeof transcriptionUsage>, status: "success" | "client_error" | "provider_error" | "timeout" | "denied") => {
    if (settled) return true;
    settled = true;
    // Full JSON is small/bounded: finish accounting before delivery. A false ACK
    // stops this request; there is no persistent operation or next queued unit.
    return accounting.settle(statusCode, status, billable, tokens, reservation, null);
  };
  const pendingOperation = (async () => {
    try {
      operation.signal.throwIfAborted();
      const prepared = await operation.wait(prepareSelected(request, env, selection, raw?.query ?? {}, auth, new Set(), !protocol, undefined, pinned));
      accounting.setGrant(prepared.grantKey, prepared.grantLane);
      if (protocol) {
        assertMultipartDestination(protocol, prepared.url, prepared.headers);
        if (prepared.grantKey !== original!.grantKey || prepared.headers.get("authorization") !== original!.headers.get("authorization"))
          throw new HttpError(503, "transcription_owner_unavailable", "the original upload credential changed");
      }
      const useSoft = softBudgetPolicy(auth.policy);
      if (!useSoft) {
        const pending = reserveBudget(env, auth, selection.capability, accounting.cost, prepared.connection, (intent, state) => {
          if (state === "denied") {
            reservation.reservations = reservation.reservations.filter(item => item.reservationId !== intent.request.reservationId);
            return;
          }
          // Own even an uncertain committed leg, not only successful ACKs.
          reservation.reservedMicros = accounting.cost.reserveMicros;
          reservation.reservations.push({ reservationId: intent.request.reservationId, objectName: intent.objectName });
        });
        // Cancellation can precede later attempted legs, including a committed
        // leg whose ACK is lost. Own both outcomes through terminal refund.
        context.waitUntil(pending.then(
          late => operation.signal.aborted ? settleBudget(env, late, 0) : undefined,
          () => operation.signal.aborted ? settleBudget(env, reservation, 0) : undefined,
        ));
        reservation = await operation.wait(pending);
      }
      operation.signal.throwIfAborted();
      if (!useSoft) await operation.wait(markBudgetDispatched(env, reservation, operation.signal));
      operation.signal.throwIfAborted();
      let body: BodyInit;
      if (raw) {
        body = raw.bytes;
        prepared.headers.set("content-type", raw.contentType);
      } else {
        if (!form) {
          form = new FormData(); form.set("file", upload!.file, upload!.file.name);
          for (const [name, value] of Object.entries(upload!.fields)) form.set(name, name === "model" ? model.upstream : value);
        }
        body = form;
        prepared.headers.delete("content-type");
      }
      if (protocol) {
        const current = await operation.wait(admit(true));
        if (current instanceof Response || !sameCaller(auth, current)) throw new HttpError(403, "transcription_owner_changed", "transcription caller is no longer authorized");
        assertPolicyModel(current.policy, selection);
        const currentUpstream = await operation.wait(upstreamAuth(provider, current, env, new Set(), null, false, pinned,
          { provider, endpoint, mode: "http", model: model.upstream }));
        if (currentUpstream.headers.get("authorization") !== prepared.headers.get("authorization"))
          throw new HttpError(503, "transcription_owner_unavailable", "the original transcription credential changed");
        if (original!.grantKey) {
          const owner = await operation.wait(inspectGrantCredentials(env, original!.grantKey, operation.signal));
          if (!owner || owner.enabled !== true || owner.revokedAt || grantRevision(owner) !== original!.grantRevision
            || owner.credentialGeneration !== original!.grant?.credentialGeneration || owner.credentialLineage !== original!.grant?.credentialLineage
            || owner.provider !== provider.id || owner.kind !== "api_key" || (owner.accountId ?? null) !== (original!.grant?.accountId ?? null))
            throw new HttpError(503, "transcription_owner_unavailable", "the original transcription credential is unavailable");
        } else if (configuredUpstream(provider, null, env).headers.get("authorization") !== original!.headers.get("authorization")) {
          throw new HttpError(503, "transcription_owner_unavailable", "the original transcription credential changed");
        }
        operation.signal.throwIfAborted();
        if (Date.now() >= deadline) throw new HttpError(504, "transcription_timeout", "transcription deadline exceeded");
      }
      // Selected credentials and the raw or reconstructed body own the headers;
      // caller auth/lengths cannot replace them, and redirects stay manual.
      prepared.headers.delete("content-length");
      if (nativeHeaders) prepared.headers.set("accept", nativeHeaders.get("accept")!);
      dispatched = true;
      const pending = fetch(prepared.url, { method: "POST", headers: prepared.headers, body, signal: operation.signal, redirect: "manual" });
      if (useSoft) {
        soft = softBudget(env, auth, selection.capability, prepared.connection, accounting.facts.event.id, error => operation.stop("upstream", error));
        reservation = soft.reservation; context.waitUntil(soft.check);
      }
      response = await operation.wait(pending, "upstream", late => { void late.body?.cancel().catch(() => undefined); });
      captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, provider.quota, response);
      if (soft) { await soft.beforeDelivery(); if (soft.denial) throw soft.denial; }
      if (protocol) {
        const validated = await operation.wait(readMultipartResponse(protocol, response, operation.signal), "upstream");
        operation.signal.throwIfAborted(); operation.stop("complete");
        if (!await settle(200, true, null, "success")) return errorResponse("accounting_unavailable", "transcription accounting could not be durably completed", 503);
        const headers = proxyResponseHeaders(response, provider.id);
        headers.set("cache-control", "no-store"); headers.set("x-clawrouter-content-retention", "off");
        headers.set("x-clawrouter-grant-lane", prepared.grantLane);
        headers.set("x-clawrouter-accounting", accounting.cost.basis === "policy_fixed" ? "policy-fixed" : "unpriced-usage");
        const result = nativeJsonResponse(validated.body, new Response(null, { headers }));
        const delivery = observeUsage(result, new HttpOperation(request.signal, Math.max(1, deadline - Date.now())), undefined,
          endpoint.response_format, undefined, { tokens: null, outcome: "success" });
        transferred = true; void delivery.result.then(() => capacity!.release());
        return delivery.response;
      }
      // No provider failover or HTTP redirect replay, including 401/429/3xx.
      if (!response.ok) operation.acceptRejection(response.status);
      const bytes = await readBounded(response.body, transcriptionLimits.response, operation);
      const declaredLength = response.headers.get("content-length");
      if (!response.headers.has("content-encoding") && declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== bytes.length)) throw new HttpError(502, "transcription_response_invalid", "upstream transcription body was truncated");
      if (response.status >= 300 && response.status < 400) throw new HttpError(502, "transcription_redirect_unsupported", "upstream transcription redirects are not replayed");
      let tokens: ReturnType<typeof transcriptionUsage> = null;
      if (response.ok) {
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(502, "transcription_response_invalid", "upstream transcription did not return JSON");
        let result: unknown;
        try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new HttpError(502, "transcription_response_invalid", "upstream transcription JSON is incomplete or invalid"); }
        if (raw) {
          const { observeDeepgramPrerecorded } = await import("./deepgram-prerecorded.ts");
          if (!observeDeepgramPrerecorded(result, true)) throw new HttpError(502, "transcription_response_invalid", "upstream transcription tracks are incomplete or invalid");
          // Preserve native channel order and bytes. Duration is not token usage.
        } else {
          if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || "error" in result) throw new HttpError(502, "transcription_response_invalid", "upstream transcription text is missing");
          tokens = transcriptionUsage(result);
        }
      }
      operation.signal.throwIfAborted();
      // Complete bounded EOF wins the outcome before durable publication. Late
      // caller/deadline signals must not turn a committed success into 499/504.
      operation.stop("complete");
      const ok = await settle(response.status, response.ok || response.status >= 300 && response.status < 400, tokens, response.ok ? "success" : response.status < 500 ? "client_error" : "provider_error");
      if (!ok) return errorResponse("accounting_unavailable", "transcription accounting could not be durably completed", 503);
      operation.signal.throwIfAborted();
      const headers = proxyResponseHeaders(response, provider.id);
      headers.delete("content-length"); headers.delete("content-encoding"); headers.delete("location");
      headers.set("cache-control", "no-store");
      headers.set("x-clawrouter-content-retention", "off");
      headers.set("x-clawrouter-grant-lane", prepared.grantLane);
      headers.set("x-clawrouter-accounting", accounting.cost.basis === "policy_fixed" ? "policy-fixed" : tokens ? "measured" : "unpriced-usage");
      return new Response(bytes, { status: response.status, headers });
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(operation.status === "timeout" ? 504 : request.signal.aborted ? 499 : 502, "transcription_unavailable", "transcription request failed");
      void response?.body?.cancel().catch(() => undefined);
      if (soft?.denial) {
        // Match the shared soft-budget owner: an observed denial is not a
        // monetary charge, even when a fixed fee exists and egress has begun.
        reservation = emptyReservation();
        const ok = await settle(402, false, null, "denied");
        if (!ok) return errorResponse("accounting_unavailable", "transcription accounting could not be durably completed", 503);
        return errorResponse(soft.denial.code, soft.denial.message, 402);
      }
      const rejected = response && response.status >= 400;
      await settle(failure.status, dispatched && (protocol !== null || !rejected), null, operation.status ?? (failure.status < 500 ? "client_error" : "provider_error"));
      return errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
    } finally { soft?.close(); operation.stop("complete"); }
  })();
  // Extend real Worker request lifetime through dispatch and terminal cleanup,
  // including an actual client disconnect, not just a simulated AbortSignal.
  context.waitUntil(pendingOperation.then(() => undefined, () => undefined));
  return await pendingOperation;
  } finally { if (!transferred) capacity?.release(); }
}

function sameCaller(a: AuthorizedIdentity, b: AuthorizedIdentity): boolean {
  return a.credentialId === b.credentialId && a.principalId === b.principalId && a.policyId === b.policyId
    && a.policy.tenantId === b.policy.tenantId && a.policy.generation === b.policy.generation;
}
