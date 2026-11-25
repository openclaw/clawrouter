import { accessIdentity } from "./access.ts";
import { emptyReservation, markBudgetDispatched, reserveBudget, settleBudget, type BudgetReservation } from "./accounting.ts";
import { correlationMetadata } from "./correlation.ts";
import { HttpOperation } from "./http-operation.ts";
import { createProxyAccounting } from "./proxy-accounting.ts";
import { authenticateProxyKey } from "./proxy-auth.ts";
import { proxyResponseHeaders } from "./proxy-response.ts";
import { modelSupportsEndpoint, providerById } from "./providers.ts";
import { prepareSelected, captureGrantRuntime } from "./proxy.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { softBudget, softBudgetPolicy } from "./soft-budget.ts";
import { readBounded, readTranscriptionUpload, transcriptionLimits } from "./transcription-body.ts";
import { transcriptionUsage } from "./transcription-usage.ts";
import type { Env } from "./types.ts";
import { errorResponse, HttpError } from "./utils.ts";

export function transcriptionPath(path: string): boolean {
  return ["/v1/audio/transcriptions", "/v1/native/openai/v1/audio/transcriptions", "/v1/proxy/openai/transcriptions"].includes(path) || senseAudioPath(path);
}

function senseAudioPath(path: string): boolean {
  return path === "/v1/native/senseaudio/v1/audio/transcriptions" || path === "/v1/proxy/senseaudio/transcriptions";
}

export async function proxyTranscription(request: Request, env: Env, context: ExecutionContext, mode: "proxy_key" | "access" = "proxy_key"): Promise<Response> {
  let path = new URL(request.url).pathname;
  if (mode === "access") { path = path.replace(/^\/v1\/playground(?=\/)/, ""); if (!path.startsWith("/v1/")) path = `/v1${path}`; }
  const sense = senseAudioPath(path), providerId = sense ? "senseaudio" : "openai";
  // Authentication precedes even content-type/length checks and any stream read.
  const initial = mode === "access" ? await accessIdentity(request, env, providerId) : await authenticateProxyKey(request.headers, env);
  if (initial instanceof Response) return initial;
  if (request.method !== "POST") return errorResponse("method_not_allowed", "transcription requires POST", 405);
  if (new URL(request.url).search) return errorResponse("transcription_option_unsupported", "transcription options must be multipart fields", 400);
  const provider = providerById(providerId), endpoint = provider?.endpoints.find(item => item.id === "transcriptions");
  if (!provider || !endpoint) return errorResponse("transcription_route_unsupported", "transcription declaration is unavailable", 400);
  if (sense && (path.includes("/native/") && !endpoint.native_proxy || endpoint.method !== "POST" || endpoint.path !== "/v1/audio/transcriptions" || endpoint.request_format !== "openai.audio_transcriptions"
    || endpoint.response_format !== "senseaudio.transcription" || endpoint.streaming || endpoint.lifecycle || endpoint.modelPassthrough
    || endpoint.path_params.length || Object.keys(endpoint.query).length || endpoint.upstreamPath
    || !provider.capabilities.some(item => item.id === "audio.transcription" && item.endpoint === endpoint.id))) return errorResponse("transcription_route_unsupported", "transcription requires its qualified unary multipart declaration", 400);
  const upload = await readTranscriptionUpload(request, sense ? "senseaudio" : "openai");
  const senseCodec = sense ? await import("./senseaudio-transcription.ts") : null;
  const modelId = sense ? `senseaudio/${senseCodec!.senseAudioModel}` : "openai/gpt-4o-transcribe";
  const model = provider.models.find(item => item.id === modelId);
  const native = path.includes("/native/");
  if (!model || !modelSupportsEndpoint(provider, model, endpoint) || sense && model.upstream !== senseCodec!.senseAudioModel
    || upload.fields.model !== model.id && !(native && upload.fields.model === model.upstream)) return errorResponse("model_capability_unsupported", "model is outside the selected transcription contract", 400);
  let nativeForm: FormData | undefined;
  if (senseCodec) {
    try { nativeForm = senseCodec.prepareSenseAudioUpload(upload); }
    catch { return errorResponse("invalid_transcription_upload", "upload is outside the selected transcription contract", 400); }
  }
  const selection: ProxySelection = { provider, endpoint, model, capability: "audio.transcription", body: { ...upload.fields, model: model.upstream }, pathParams: {}, method: "POST" };
  // Upload can take time: fresh canonical policy/credential/grant admission, with
  // the exact operation recorded once; never use the initial identity for egress.
  const auth = mode === "access" ? await accessIdentity(request, env, provider.id, { provider, endpoint, mode: "http", model: model.upstream }) : await authenticateProxyKey(request.headers, env, [{ id: provider.id, tokenRef: provider.id }], false, correlationMetadata(request).sessionId, {
    providerId: provider.id, endpointId: endpoint.id, mode: "http", model: model.upstream, catalogModelId: model.id, capability: selection.capability,
  });
  if (auth instanceof Response) return auth;
  const accounting = createProxyAccounting({ request, env, context, auth, selection });
  const operation = new HttpOperation(request.signal, endpoint.timeout_ms ?? 120_000);
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
      const prepared = await operation.wait(prepareSelected(request, env, selection, {}, auth));
      accounting.setGrant(prepared.grantKey, prepared.grantLane);
      if (sense && prepared.url.href !== "https://api.senseaudio.cn/v1/audio/transcriptions") throw new HttpError(400, "transcription_destination_unsupported", "transcription requires the selected regional destination");
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
      const form = nativeForm ?? new FormData();
      if (!nativeForm) {
        form.set("file", upload.file, upload.file.name);
        for (const [name, value] of Object.entries(upload.fields)) form.set(name, name === "model" ? model.upstream : value);
      }
      // Reconstructed body owns its boundary. Incoming auth and key headers are
      // never copied; prepareSelected owns the selected upstream credential.
      prepared.headers.delete("content-type");
      prepared.headers.delete("content-length");
      dispatched = true;
      const pending = fetch(prepared.url, { method: "POST", headers: prepared.headers, body: form, signal: operation.signal, redirect: "manual" });
      if (useSoft) {
        soft = softBudget(env, auth, selection.capability, prepared.connection, accounting.facts.event.id, error => operation.stop("upstream", error));
        reservation = soft.reservation; context.waitUntil(soft.check);
      }
      response = await operation.wait(pending, "upstream", late => { void late.body?.cancel().catch(() => undefined); });
      captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, provider.quota, response);
      if (soft) { await soft.beforeDelivery(); if (soft.denial) throw soft.denial; }
      if (sense && (response.status !== 200 || response.headers.has("content-range")
        || ![null, "identity"].includes(response.headers.get("content-encoding")))) throw new HttpError(502, "transcription_response_invalid", "upstream transcription response is unqualified");
      // No provider failover or HTTP redirect replay, including 401/429/3xx.
      if (!response.ok) operation.acceptRejection(response.status);
      const bytes = await readBounded(response.body, transcriptionLimits.response, operation);
      const declaredLength = response.headers.get("content-length");
      if ((sense || !response.headers.has("content-encoding")) && declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== bytes.length)) throw new HttpError(502, "transcription_response_invalid", "upstream transcription body was truncated");
      if (response.status >= 300 && response.status < 400) throw new HttpError(502, "transcription_redirect_unsupported", "upstream transcription redirects are not replayed");
      let tokens: ReturnType<typeof transcriptionUsage> = null;
      if (response.ok) {
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(502, "transcription_response_invalid", "upstream transcription did not return JSON");
        let result: unknown;
        try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new HttpError(502, "transcription_response_invalid", "upstream transcription JSON is incomplete or invalid"); }
        if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || "error" in result) throw new HttpError(502, "transcription_response_invalid", "upstream transcription text is missing");
        if (senseCodec) {
          if (!senseCodec.observeSenseAudioTranscription(result, true)) throw new HttpError(502, "transcription_response_invalid", "upstream transcription result is incomplete");
        } else tokens = transcriptionUsage(result);
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
      const rejected = !sense && response && response.status >= 400;
      await settle(failure.status, dispatched && !rejected, null, operation.status ?? (failure.status < 500 ? "client_error" : "provider_error"));
      return errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
    } finally { soft?.close(); operation.stop("complete"); }
  })();
  // Extend real Worker request lifetime through dispatch and terminal cleanup,
  // including an actual client disconnect, not just a simulated AbortSignal.
  context.waitUntil(pendingOperation.then(() => undefined, () => undefined));
  return pendingOperation;
}
