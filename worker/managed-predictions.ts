import { requireManagedCreateAdmission } from "./upstream-retention-admission.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import type { BackgroundJob, BackgroundRecord, ManagedAdmission } from "./background-store.ts";
import { retentionRequired } from "./content-retention.ts";
import { setBackgroundRecovery } from "./correlation.ts";
import { backgroundCall, HttpBackground } from "./http-background.ts";
import { continuationScope } from "./http-continuation.ts";
import { HttpOperation } from "./http-operation.ts";
import { captureGrantRuntime, prepareSelected } from "./proxy.ts";
import { assertProviderAccess } from "./providers.ts";
import { createProxyAccounting } from "./proxy-accounting.ts";
import { hasProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { ManagedCreate, ManagedFileDescriptor, ManagedObservation, ManagedObservationLoss } from "./managed-lifecycle-types.ts";
import { managedLifecycleAdapter } from "./managed-lifecycle-adapters.ts";
import { applyManagedHeaders, assertManagedDispatch, managedProbeId } from "./managed-dispatch.ts";
import { managedFileBase, managedFilePublicBody, qualifyManagedFiles } from "./managed-files.ts";
import { managedPaths, managedRoute } from "./managed-routes.ts";
import { dispatchResponseControl, type ResponseControlDispatch } from "./responses-control-dispatch.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { errorResponse, HttpError, json, sha256Hex } from "./utils.ts";
import { WanManagedOperation, preflightWanJson, assertWanHeaders, wanRecordBytes } from "./managed-media-json.ts";

// Opt-in protocol path. Ordinary requests keep their existing hot path and do
// not pay for durable admission, local idempotency or background collection.
export async function proxyManagedPrediction(request: Request, env: Env, context: ExecutionContext, auth: AuthorizedIdentity,
  selection: ProxySelection, query: ProxyQuery, ownership?: WanManagedOperation): Promise<Response> {
  const wan = selection.endpoint.lifecycle?.protocol === "dashscope.video" ? ownership ?? new WanManagedOperation() : undefined;
  try { return await managedPrediction(request, env, context, auth, selection, query, wan); }
  finally { if (wan && !ownership) context.waitUntil(wan.finish()); }
}

async function managedPrediction(request: Request, env: Env, context: ExecutionContext, auth: AuthorizedIdentity,
  selection: ProxySelection, query: ProxyQuery, wan?: WanManagedOperation): Promise<Response> {
  const connection = await assertProviderAccess(selection.provider, auth, env, undefined, wan);
  if (!selection.endpoint.lifecycle) throw new HttpError(409, "response_owner_unavailable", "the managed prediction lifecycle is unavailable; raw job IDs cannot be forwarded");
  const { adapter } = managedRoute(selection.provider, selection.endpoint);
  if (selection.method !== "POST"
    || hasProxyQuery(query) || new URL(request.url).search) throw new HttpError(400, "invalid_prediction_request", "managed prediction creation requires a body-only declared POST");
  if (retentionRequired(auth, selection.capability)) throw new HttpError(400, "prediction_retention_unsupported", "this managed protocol does not support required request-content retention");
  let admittedPreparation: Awaited<ReturnType<typeof prepareSelected>> | undefined;
  let admission: import("./upstream-retention-admission.ts").ManagedCreateAdmission | undefined;
  if (adapter.prepareAdmitted) {
    const fixed = policyRequestCost(auth.policy, selection.capability);
    if (!Number.isSafeInteger(fixed) || fixed == null || fixed < 0) throw new HttpError(400, "pricing_required", "managed predictions require an explicit policy-fixed tariff before dispatch");
    if (selection.endpoint.path_params.length || Object.keys(selection.pathParams).length || adapter.retainedParams
      || selection.provider.auth.schemes.some(scheme => scheme.type === "sig_v4"))
      throw new HttpError(409, "managed_admission_unsupported", "retention admission requires a qualified body-only create route");
    admittedPreparation = await prepareSelected(request, env, selection, query, auth, new Set(), true, connection, undefined, "http", false, wan);
    admission = requireManagedCreateAdmission(auth.policy, env, admittedPreparation.continuation, adapter.protocol);
  }
  let create: ManagedCreate;
  try { create = adapter.prepareAdmitted
      ? adapter.prepareAdmitted(selection.body, request.headers, selection.pathParams, new URLSearchParams(), admission!)
      : adapter.prepare(selection.body, request.headers, selection.pathParams, new URLSearchParams());
    if (admittedPreparation && (Object.keys(create.pathParams).length || [...create.headers].length)) throw new Error("unsupported admitted route mutation");
    managedPaths(selection.provider, selection.endpoint, managedProbeId(adapter), create.pathParams); }
  catch { throw new HttpError(400, "invalid_prediction_request", "provide a supported native managed job input and route"); }
  selection = { ...selection, body: create.body, pathParams: create.pathParams };
  const fixed = policyRequestCost(auth.policy, selection.capability);
  if (!Number.isSafeInteger(fixed) || fixed == null || fixed < 0) throw new HttpError(400, "pricing_required", "managed predictions require an explicit policy-fixed tariff before dispatch");
  const scope = await continuationScope(auth), key = request.headers.get("Idempotency-Key");
  if (key !== null && !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be a bounded ASCII identifier");
  const digestInput = [selection.provider.id, selection.endpoint.id, selection.pathParams, create.body, create.headers.get("Cancel-After")];
  if (wan) { preflightWanJson(digestInput); preflightWanJson(create.body); assertWanHeaders(request.headers); }
  const managed: ManagedAdmission = { protocol: adapter.protocol, providerId: selection.provider.id, requestedVersion: create.requestedVersion,
    idempotencyKey: key === null ? null : await sha256Hex(key),
    requestDigest: await sha256Hex(JSON.stringify(digestInput,
      (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)) };
  if (key !== null) {
    const existing = await backgroundCall<BackgroundRecord | null>(env, scope, { action: "managed_lookup", managed, policyGeneration: auth.policy.generation }, wan);
    if (existing) return existingPrediction(request, scope, existing, selection.provider, selection.endpoint, wan);
  }
  const prepared = admittedPreparation ?? await prepareSelected(request, env, selection, query, auth, new Set(), true, connection, undefined, "http", false, wan);
  if (admittedPreparation) prepared.requestBody = JSON.stringify(create.body);
  if (!prepared.continuation) throw new HttpError(503, "prediction_owner_unavailable", "prediction ownership is unavailable");
  // Qualify the selected grant before durable admission; never shop another
  // account after a product/region guard rejects it.
  prepared.headers.delete("Prefer"); prepared.headers.delete("Idempotency-Key");
  applyManagedHeaders(selection.provider, prepared.headers, create);
  if (wan) assertWanHeaders(prepared.headers);
  const dispatchRequest = new Request(prepared.url, { method: "POST", headers: prepared.headers });
  assertManagedDispatch(adapter.protocol, dispatchRequest);
  const cost = { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  const accounting = createProxyAccounting({ request, env, context, auth, selection, cost, grantKey: prepared.grantKey, grantLane: prepared.grantLane });
  const background = await HttpBackground.prepare(request, env, auth, prepared.continuation, accounting.facts, prepared.connection,
    selection.pathParams, prepared.headers, false, wan);
  if (selection.endpoint.lifecycle?.files) managed.fileBaseUrl = managedFileBase(selection.provider, prepared.managedBaseUrl);
  background.admission.managed = managed;
  const admitted = await backgroundCall<{ admitted: boolean; created: boolean; job: BackgroundRecord }>(env, scope, { action: "managed_admit", admission: background.admission }, wan);
  if (admitted?.admitted !== true || !admitted.job || typeof admitted.created !== "boolean") throw new HttpError(503, "background_unavailable", "prediction admission was not acknowledged");
  if (!admitted.created) return existingPrediction(request, scope, admitted.job, selection.provider, selection.endpoint, wan);
  const task = (async () => {
    let attempted = false, dispatchConfirmed = false, providerStarted = false, response: Response | undefined;
    const operation = new HttpOperation(undefined, Math.min(selection.endpoint.timeout_ms ?? 120_000, 120_000));
    if (wan) wan.controlSignal = operation.signal;
    try {
      request.signal.throwIfAborted();
      assertManagedDispatch(adapter.protocol, dispatchRequest);
      attempted = true;
      await background.dispatch(null);
      dispatchConfirmed = true;
      if (wan && prepared.revalidateAccount) await operation.wait(prepared.revalidateAccount(operation.signal), "upstream");
      if (adapter.prepareAdmitted) requireManagedCreateAdmission(auth.policy, env, prepared.continuation, adapter.protocol);
      operation.signal.throwIfAborted();
      if (wan) assertManagedDispatch(adapter.protocol, dispatchRequest);
      providerStarted = true;
      const pending = fetch(prepared.url, { method: "POST", headers: prepared.headers, body: prepared.requestBody, signal: operation.signal, redirect: "manual" });
      response = wan ? await wan.fetch(pending, operation) : await operation.wait(pending, "upstream",
        late => { void late.body?.cancel().catch(() => undefined); });
      captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response);
      const reading = adapter.read(response, { action: "create", requestedVersion: create.requestedVersion, pathParams: create.pathParams,
        signal: operation.signal, ...(wan ? { registerInput: wan.registerInput } : {}) });
      let prediction = await operation.wait(wan ? wan.track(reading) : reading, "upstream");
      const bound = await backgroundCall<{ bound: boolean }>(env, scope, { action: "managed_bind", id: background.admission.id, responseId: prediction.id }, wan);
      if (bound?.bound !== true) throw new Error("prediction binding not acknowledged");
      prediction = qualifyManagedFiles(selection.provider, selection.endpoint, prediction, managed.fileBaseUrl);
      await observePrediction(env, scope, background.admission.id, prediction, response.status, wan);
      return predictionResponse(prediction, selection.provider, selection.endpoint, create.pathParams, response.status, wan, request.signal);
    } catch {
      const knownUnsent = !attempted || !!wan && dispatchConfirmed && !providerStarted;
      if (knownUnsent) await background.unsent(499, "client_error", null).catch(() => undefined);
      if (wan && knownUnsent) return wan.publish({ error: { code: "prediction_submission_unsent", message: "prediction was not sent" } },
        503, { "content-type": "application/json" }, request.signal);
      // No create replay and no inferred refund after dispatch. The existing
      // alarm retains the bound until a terminal or the observation deadline.
      const message = "prediction submission could not be confirmed; retry only with the original idempotency key or inspect the recovery locator";
      return wan ? wan.publish({ error: { code: "prediction_submission_unknown", message } }, 503, { "content-type": "application/json" }, request.signal)
        : errorResponse("prediction_submission_unknown", message, 503);
    } finally {
      operation.stop("complete");
      if (response && wan) wan.track(wan.discardUnclaimed(response));
      else void response?.body?.cancel().catch(() => undefined);
    }
  })();
  // Delivery can disconnect. Binding, collection and accounting still belong
  // to the durable job, and the in-flight creation may finish publication.
  context.waitUntil(task.then(() => undefined, () => undefined));
  if (wan) wan.track(task);
  return task;
}

function existingPrediction(request: Request, scope: string, job: BackgroundRecord, provider: CompiledProvider, create: CompiledEndpoint, wan?: WanManagedOperation): Response {
  if (!job.managed) throw new HttpError(409, "background_protocol_conflict", "the original job is not managed");
  setBackgroundRecovery(request, `${scope.slice("http-continuations:".length)}.${job.id}`);
  if (job.managed.observationUnavailable) return managedObservationUnavailable(wan, request.signal);
  const location = job.managed.upstreamId ? managedPaths(provider, create, job.managed.upstreamId, job.managed.route?.pathParams ?? {}).retrieve : null;
  const body = { job_id: job.id, submission: job.managed.submission, prediction_id: job.managed.upstreamId };
  const headers = { "content-type": "application/json", "cache-control": "no-store", ...(location ? { location } : { "retry-after": "5" }) };
  return wan ? wan.publish(body, location ? 303 : 202, headers, request.signal) : json(body, location ? 303 : 202, headers);
}

export async function observePrediction(env: Env, scope: string, id: string, prediction: ManagedObservation, statusCode: number, wan?: WanManagedOperation): Promise<void> {
  const ack = await backgroundCall<{ observed: boolean }>(env, scope, { action: "managed_observe", id, responseId: prediction.id, predictionStatus: prediction.terminal ?? "processing", statusCode, observationUnavailable: prediction.observationUnavailable, files: prediction.files }, wan);
  if (ack?.observed !== true) throw new HttpError(503, "background_unavailable", "prediction observation was not acknowledged");
}

export async function bindPredictionFiles(env: Env, scope: string, id: string, prediction: ManagedObservation): Promise<void> {
  if (prediction.files === undefined) return;
  const ack = await backgroundCall<{ files: ManagedFileDescriptor[] }>(env, scope, { action: "managed_files", id, responseId: prediction.id, files: prediction.files });
  if (!Array.isArray(ack?.files) || prediction.files.some(file => !ack.files.some(bound => bound.id === file.id && bound.mimeType === file.mimeType))) {
    throw new HttpError(503, "managed_files_unavailable", "output file ownership was not acknowledged; retain the existing job and do not resubmit generation");
  }
}

export function predictionResponse(prediction: ManagedObservation, provider: CompiledProvider, create: CompiledEndpoint,
  pathParams: Record<string, string>, status: number, wan?: WanManagedOperation, caller?: AbortSignal): Response {
  const headers = { "cache-control": "no-store", "x-clawrouter-upstream-provider": provider.id, "x-clawrouter-content-retention": "off" };
  if (prediction.observationUnavailable) {
    // A qualified native cancel/delete ACK stays bodyless. It still supplies
    // no execution or refund evidence; future polls use the frozen loss marker.
    if (status === 204 && prediction.observationUnavailable === "canceled_or_deleted") return new Response(null, { status, headers });
    return managedObservationUnavailable(wan, caller);
  }
  const { adapter } = managedRoute(provider, create);
  const body = managedFilePublicBody(provider, create, prediction, adapter.rewrite(prediction, managedPaths(provider, create, prediction.id, pathParams)));
  const responseHeaders = { ...headers, "content-type": "application/json", ...(create.lifecycle?.files ? { "x-clawrouter-job-id": prediction.id } : {}) };
  return wan ? wan.publish(body, status, responseHeaders, caller) : json(body, status, responseHeaders);
}

export function managedObservationUnavailable(wan?: WanManagedOperation, caller?: AbortSignal): Response {
  const message = "the original job can no longer be observed; its execution outcome is unknown, collection has stopped and automatic resubmission is unsafe";
  return wan ? wan.publish({ error: { code: "prediction_observation_unavailable", message } }, 410,
    { "content-type": "application/json", "cache-control": "no-store" }, caller)
    : errorResponse("prediction_observation_unavailable", message, 410, undefined, { "cache-control": "no-store" });
}

type ControlRead = { prediction: ManagedObservation; status: number };
export async function readManagedControl(env: Env, input: ResponseControlDispatch, operation: HttpOperation, fileBaseUrl?: string,
  wan?: WanManagedOperation): Promise<ControlRead & { evidence: ControlRead }> {
  const adapter = input.protocol && managedLifecycleAdapter(input.protocol);
  if (!adapter) throw new HttpError(409, "response_owner_unavailable", "the managed protocol is unavailable");
  const read = async (action: "retrieve" | "result" | "cancel"): Promise<ControlRead> => {
    let response: Response | undefined;
    const dispatch = { ...input, action };
    if (wan) {
      preflightWanJson(dispatch, wanRecordBytes, true);
      try {
        const physical = wan.track(dispatchResponseControl(env, dispatch, operation.signal, wan));
        response = await operation.wait(physical, "upstream", late => { void wan.discard(late).catch(() => undefined); });
        // The single native ticket owns the actual 1MiB response, not an ACK.
        const { providerById } = await import("./providers.ts");
        const provider = providerById(input.owner.providerId), create = provider?.endpoints.find(endpoint => endpoint.id === input.owner.endpointId);
        if (!provider || !create) throw new HttpError(409, "response_owner_unavailable", "original route is unavailable");
        const reading = adapter.read(response, { action, expectedId: input.responseId,
          requestedVersion: input.requestedVersion ?? "", pathParams: input.route.pathParams, signal: operation.signal, registerInput: wan.registerInput });
        const prediction = await operation.wait(wan.track(reading), "upstream");
        return { prediction: qualifyManagedFiles(provider, create, prediction, fileBaseUrl), status: response.status };
      } finally { if (response) wan.track(wan.discardUnclaimed(response)); }
    }
    try {
      response = await operation.wait(dispatchResponseControl(env, dispatch, operation.signal), "upstream",
        late => { void late.body?.cancel().catch(() => undefined); });
      const { providerById } = await import("./providers.ts");
      const provider = providerById(input.owner.providerId), create = provider?.endpoints.find(endpoint => endpoint.id === input.owner.endpointId);
      if (!provider || !create) throw new HttpError(409, "response_owner_unavailable", "original route is unavailable");
      const prediction = await operation.wait(adapter.read(response, { action, expectedId: input.responseId,
        requestedVersion: input.requestedVersion ?? "", pathParams: input.route.pathParams, signal: operation.signal }), "upstream");
      return { prediction: qualifyManagedFiles(provider, create, prediction, fileBaseUrl), status: response.status };
    } finally { void response?.body?.cancel().catch(() => undefined); }
  };
  // A terminal queue status can require a result read; cancellation ACKs can
  // require retrieval. At most two follow-ups, never another mutation or URL.
  const follow = async (first: ControlRead): Promise<ControlRead> => {
    let current = first;
    for (let count = 0; count < 2 && !current.prediction.terminal && !current.prediction.observationUnavailable && current.prediction.followUp; count++) {
      current = await read(current.prediction.followUp);
    }
    return current;
  };
  if (input.action === "cancel") {
    const current = await follow(await read("retrieve"));
    if (current.prediction.terminal || current.prediction.observationUnavailable) return { ...current, evidence: current };
  }
  const result = await read(input.action), evidence = await follow(result);
  // Return the native action's body; only qualified terminal evidence settles.
  return { ...result, evidence };
}

export async function collectManagedPrediction(env: Env, job: BackgroundJob, accept: (id: string, status: string, statusCode: number, loss?: ManagedObservationLoss, files?: readonly ManagedFileDescriptor[]) => Promise<void>): Promise<void> {
  if (!job.managed || job.managed.observationUnavailable || !job.responseId || !job.route || Date.now() >= job.observeUntil) return;
  const operation = new HttpOperation(undefined, Math.min(10_000, job.observeUntil - Date.now()));
  const wan = job.managed.protocol === "dashscope.video" ? new WanManagedOperation("collector") : undefined;
  if (wan) { wan.controlSignal = operation.signal; wan.requireOrdinary(job.owner.grantKey ? 1 : 2); }
  try {
    const { evidence } = await readManagedControl(env, { owner: job.owner, route: job.route, responseId: job.responseId,
      action: "retrieve", query: "", stream: false, protocol: job.managed.protocol, requestedVersion: job.managed.requestedVersion,
      deadline: job.observeUntil, authorization: { kind: "collection" } }, operation, job.managed.fileBaseUrl, wan);
    await accept(evidence.prediction.id, evidence.prediction.terminal ?? "processing", evidence.status, evidence.prediction.observationUnavailable, evidence.prediction.files);
  } finally { operation.stop("complete"); await wan?.finish(); }
}
