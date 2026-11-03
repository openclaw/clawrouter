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
import { prepareReplicateCreate, readReplicatePrediction, rewriteReplicatePredictionUrls, type ReplicatePrediction } from "./replicate-lifecycle.ts";
import { dispatchResponseControl, type ResponseControlDispatch } from "./responses-control-dispatch.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { errorResponse, HttpError, json, sha256Hex } from "./utils.ts";

// Opt-in protocol path. Ordinary requests keep their existing hot path and do
// not pay for durable admission, local idempotency or background collection.
export async function proxyManagedPrediction(request: Request, env: Env, context: ExecutionContext, auth: AuthorizedIdentity,
  selection: ProxySelection, query: ProxyQuery): Promise<Response> {
  const connection = await assertProviderAccess(selection.provider, auth, env);
  if (!selection.endpoint.lifecycle) throw new HttpError(409, "response_owner_unavailable", "the managed prediction lifecycle is unavailable; raw job IDs cannot be forwarded");
  if (selection.endpoint.lifecycle?.protocol !== "replicate.predictions" || selection.method !== "POST"
    || hasProxyQuery(query) || new URL(request.url).search) throw new HttpError(400, "invalid_prediction_request", "managed prediction creation requires a body-only declared POST");
  if (retentionRequired(auth, selection.capability)) throw new HttpError(400, "prediction_retention_unsupported", "this managed protocol does not support required request-content retention");
  let create: ReturnType<typeof prepareReplicateCreate>;
  try { create = prepareReplicateCreate(selection.body, request.headers); }
  catch { throw new HttpError(400, "invalid_prediction_request", "provide a supported version and input object; webhooks and streaming are unavailable"); }
  const fixed = policyRequestCost(auth.policy, selection.capability);
  if (!Number.isSafeInteger(fixed) || fixed == null || fixed < 0) throw new HttpError(400, "pricing_required", "managed predictions require an explicit policy-fixed tariff before dispatch");
  const scope = await continuationScope(auth), key = request.headers.get("Idempotency-Key");
  if (key !== null && !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be a bounded ASCII identifier");
  const managed: ManagedAdmission = { protocol: "replicate.predictions", requestedVersion: create.requestedVersion,
    idempotencyKey: key === null ? null : await sha256Hex(key),
    requestDigest: await sha256Hex(JSON.stringify([selection.provider.id, selection.endpoint.id, selection.pathParams, create.body, create.headers.get("Cancel-After")],
      (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)) };
  if (key !== null) {
    const existing = await backgroundCall<BackgroundRecord | null>(env, scope, { action: "managed_lookup", managed, policyGeneration: auth.policy.generation });
    if (existing) return existingPrediction(request, scope, existing, selection.provider.id);
  }
  const prepared = await prepareSelected(request, env, selection, query, auth, new Set(), true, connection);
  if (!prepared.continuation) throw new HttpError(503, "prediction_owner_unavailable", "prediction ownership is unavailable");
  const cost = { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  const accounting = createProxyAccounting({ request, env, context, auth, selection, cost, grantKey: prepared.grantKey, grantLane: prepared.grantLane });
  const background = await HttpBackground.prepare(request, env, auth, prepared.continuation, accounting.facts, prepared.connection,
    selection.pathParams, prepared.headers, false);
  background.admission.managed = managed;
  const admitted = await backgroundCall<{ admitted: boolean; created: boolean; job: BackgroundRecord }>(env, scope, { action: "managed_admit", admission: background.admission });
  if (admitted?.admitted !== true || !admitted.job || typeof admitted.created !== "boolean") throw new HttpError(503, "background_unavailable", "prediction admission was not acknowledged");
  if (!admitted.created) return existingPrediction(request, scope, admitted.job, selection.provider.id);
  // Native async creation never forwards wait preferences or a key that could
  // imply an upstream replay guarantee. The durable local scope owns retries.
  prepared.headers.delete("Prefer"); prepared.headers.delete("Idempotency-Key");
  create.headers.forEach((value, name) => prepared.headers.set(name, value));
  const task = (async () => {
    let attempted = false, response: Response | undefined;
    const operation = new HttpOperation(undefined, Math.min(selection.endpoint.timeout_ms ?? 120_000, 120_000));
    try {
      request.signal.throwIfAborted();
      attempted = true;
      await background.dispatch(null);
      response = await operation.wait(fetch(prepared.url, { method: "POST", headers: prepared.headers, body: prepared.requestBody, signal: operation.signal, redirect: "manual" }), "upstream",
        late => { void late.body?.cancel().catch(() => undefined); });
      captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response);
      const prediction = await operation.wait(readReplicatePrediction(response), "upstream");
      const bound = await backgroundCall<{ bound: boolean }>(env, scope, { action: "managed_bind", id: background.admission.id, responseId: prediction.observation.id });
      if (bound?.bound !== true) throw new Error("prediction binding not acknowledged");
      await observePrediction(env, scope, background.admission.id, prediction, response.status);
      return predictionResponse(prediction, selection.provider.id, response.status);
    } catch {
      if (!attempted) await background.unsent(499, "client_error", null).catch(() => undefined);
      // No create replay and no inferred refund after dispatch. The existing
      // alarm retains the bound until a terminal or the observation deadline.
      return errorResponse("prediction_submission_unknown", "prediction submission could not be confirmed; retry only with the original idempotency key or inspect the recovery locator", 503);
    } finally { operation.stop("complete"); void response?.body?.cancel().catch(() => undefined); }
  })();
  // Delivery can disconnect. Binding, collection and accounting still belong
  // to the durable job, and the in-flight creation may finish publication.
  context.waitUntil(task.then(() => undefined, () => undefined));
  return task;
}

function existingPrediction(request: Request, scope: string, job: BackgroundRecord, providerId: string): Response {
  if (!job.managed) throw new HttpError(409, "background_protocol_conflict", "the original job is not a managed prediction");
  setBackgroundRecovery(request, `${scope.slice("http-continuations:".length)}.${job.id}`);
  const location = job.managed.upstreamId ? predictionPaths(providerId, job.managed.upstreamId).get : null;
  return json({ job_id: job.id, submission: job.managed.submission, prediction_id: job.managed.upstreamId }, location ? 303 : 202,
    { "cache-control": "no-store", ...(location ? { location } : { "retry-after": "5" }) });
}

export async function observePrediction(env: Env, scope: string, id: string, prediction: ReplicatePrediction, statusCode: number): Promise<void> {
  const ack = await backgroundCall<{ observed: boolean }>(env, scope, { action: "managed_observe", id, responseId: prediction.observation.id, predictionStatus: prediction.observation.status, statusCode });
  if (ack?.observed !== true) throw new HttpError(503, "background_unavailable", "prediction observation was not acknowledged");
}

export function predictionResponse(prediction: ReplicatePrediction, providerId: string, status: number): Response {
  return json(rewriteReplicatePredictionUrls(prediction, predictionPaths(providerId, prediction.observation.id)), status,
    { "cache-control": "no-store", "x-clawrouter-upstream-provider": providerId, "x-clawrouter-content-retention": "off" });
}
function predictionPaths(providerId: string, id: string) {
  const get = `/v1/native/${providerId}/v1/predictions/${id}`;
  return { get, cancel: `${get}/cancel` };
}

export async function readManagedControl(env: Env, input: ResponseControlDispatch, operation: HttpOperation): Promise<{ prediction: ReplicatePrediction; status: number }> {
  // Every explicit cancel first observes current state. After an uncertain
  // cancel, the next authenticated attempt cannot blindly repeat the POST.
  const read = async (action: "retrieve" | "cancel") => {
    let response: Response | undefined;
    try {
      response = await operation.wait(dispatchResponseControl(env, { ...input, action }, operation.signal), "upstream",
        late => { void late.body?.cancel().catch(() => undefined); });
      return { prediction: await operation.wait(readReplicatePrediction(response, input.responseId), "upstream"), status: response.status };
    } finally { void response?.body?.cancel().catch(() => undefined); }
  };
  const current = await read("retrieve");
  return input.action === "cancel" && !current.prediction.observation.terminal ? read("cancel") : current;
}

export async function collectManagedPrediction(env: Env, job: BackgroundJob, accept: (id: string, status: string, statusCode: number) => Promise<void>): Promise<void> {
  if (!job.managed || !job.responseId || !job.route || Date.now() >= job.observeUntil) return;
  const operation = new HttpOperation(undefined, Math.min(10_000, job.observeUntil - Date.now()));
  try {
    const { prediction, status } = await readManagedControl(env, { owner: job.owner, route: job.route, responseId: job.responseId,
      action: "retrieve", query: "", stream: false, protocol: job.managed.protocol, deadline: job.observeUntil, authorization: { kind: "collection" } }, operation);
    await accept(prediction.observation.id, prediction.observation.status, status);
  } finally { operation.stop("complete"); }
}
