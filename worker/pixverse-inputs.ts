import { assertProviderAccess, modelSupportsEndpoint, upstreamAuth } from "./providers.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { planBudgetReservation } from "./accounting.ts";
import { createProxyAccounting } from "./proxy-accounting.ts";
import { backgroundCall, HttpBackground } from "./http-background.ts";
import { continuationScope } from "./http-continuation.ts";
import { HttpOperation } from "./http-operation.ts";
import type { BackgroundRecord, ManagedAdmission } from "./background-store.ts";
import { assertManagedInputLive, inputUnavailable, managedInputMaxBytes, sameManagedInput, type ManagedInputBinding, type ManagedInputReceipt } from "./managed-input-receipt.ts";
import { assertInputOperationPolicy, encodeInputDispatch, inputBytesDigest, inputPlanDigest, inputRouteDigest } from "./pixverse-input-dispatch.ts";
import { createPixVerseManagedAdapter, preparePixVerseImagePlan, readPixVerseImageUpload } from "./managed-pixverse.ts";
import { publicControlAuthorization } from "./response-control-authorization.ts";
import { requireManagedCreateAdmission } from "./upstream-retention-admission.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { HttpError, randomId, sha256Hex } from "./utils.ts";

// The public profile and internal foundation share the same scoped row/outbox.
export async function allocatePixVerseInput(request: Request, env: Env, context: ExecutionContext, auth: AuthorizedIdentity,
  selection: ProxySelection, file: Readonly<{ bytes: Uint8Array<ArrayBuffer>; type: string }>): Promise<ManagedInputBinding> {
  publicControlAuthorization(auth);
  const plan = preparePixVerseImagePlan(selection.body), model = selection.model;
  if (!file || Object.keys(file).sort().join() !== "bytes,type" || !(file.bytes instanceof Uint8Array)
    || !file.bytes.length || file.bytes.length > managedInputMaxBytes || !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    || selection.provider.id !== "pixverse" || selection.method !== "POST" || selection.capability !== "video.generate"
    || !model || model.upstream !== plan.model || !selection.provider.models.includes(model)
    || !modelSupportsEndpoint(selection.provider, model, selection.endpoint) || Object.keys(selection.pathParams).length
    || new URL(request.url).search) inputUnavailable();
  assertPolicyModel(auth.policy, selection); assertInputOperationPolicy(auth.policy);
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key", "one-job input allocation requires a stable bounded Idempotency-Key");
  const scope = await continuationScope(auth), digest = await inputBytesDigest(file.bytes), createDigest = await inputPlanDigest(plan);
  const managed: ManagedAdmission = { protocol: "pixverse.video", providerId: "pixverse", requestedVersion: model.upstream,
    idempotencyKey: await sha256Hex(key), requestDigest: await sha256Hex(JSON.stringify([selection.endpoint.id, model.id, digest, createDigest, file.type, file.bytes.length, ...(selection.endpoint.inputProfile ? [selection.endpoint.inputProfile] : [])])) };
  const lookup = () => backgroundCall<BackgroundRecord | null>(env, scope, { action: "managed_lookup", managed, policyGeneration: auth.policy.generation });
  const previous = await lookup();
  if (previous) {
    if (!previous.inputReceipt || previous.inputReceipt.binding.inputProfile !== selection.endpoint.inputProfile) inputUnavailable();
    return previous.inputReceipt.binding;
  }
  const connection = await assertProviderAccess(selection.provider, auth, env);
  const upstream = await upstreamAuth(selection.provider, auth, env, new Set(), null, true, undefined,
    { provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: model.upstream });
  const grant = upstream.grant;
  if (!upstream.grantKey || !grant || grant.provider !== "pixverse" || grant.credentialStore !== "durable_object"
    || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration) || grant.enabled !== true
    || grant.revokedAt || grant.credentialStatus !== "active") inputUnavailable();
  const destination = await inputRouteDigest(selection.provider, selection.endpoint, grant, env);
  const owner = { providerId: "pixverse", endpointId: selection.endpoint.id, grantKey: upstream.grantKey,
    lineage: grant.credentialLineage, routeSha256: destination.digest, policyGeneration: auth.policy.generation };
  requireManagedCreateAdmission(auth.policy, env, owner, "pixverse.video");
  const facts = (capability: string) => {
    const cost = { reserveMicros: auth.policy.requestCostsMicros![capability], basis: "policy_fixed", inputTokens: null, outputTokens: null };
    return createProxyAccounting({ request: new Request(request.url, { headers: { "x-request-id": randomId("request") } }), env, context, auth, selection: { ...selection, capability }, cost,
      grantKey: upstream.grantKey, grantLane: upstream.grantLane }).facts;
  };
  const generation = facts("video.generate"), upload = facts("pixverse.image_upload");
  const background = await HttpBackground.prepare(request, env, auth, owner, generation, connection, {}, new Headers(), false);
  background.admission.managed = managed;
  const binding: ManagedInputBinding = { version: "clawrouter.managed-input.v1",
    ...(selection.endpoint.inputProfile ? { inputProfile: selection.endpoint.inputProfile } : {}), scope, jobId: background.admission.id, owner,
    generation: grant.credentialGeneration!, product: "pixverse.video", origin: destination.origin, region: destination.region,
    modelId: model.id, model: plan.model as "v6" | "c1", slot: "image", digest, createDigest, size: file.bytes.length,
    mime: file.type as ManagedInputBinding["mime"], expiresAt: background.admission.admittedAt + 60_000 };
  try {
    const ack = await backgroundCall<{ allocated: boolean; receipt: Pick<ManagedInputReceipt, "binding"> }>(env, scope, { action: "input_allocate", ...(binding.inputProfile ? { summary: true } : {}), input: {
      binding, admission: background.admission, upload: { facts: upload, plan: planBudgetReservation(auth, "pixverse.image_upload", upload.cost, connection, background.admission.admittedAt) } } });
    if (!ack?.allocated || !sameManagedInput(ack.receipt.binding, binding)) inputUnavailable();
    return binding;
  } catch (error) {
    // Lost allocation ACK or a concurrent same-key attempt resolves only the
    // already committed row. It never invents a second job or reservation.
    const existing = await lookup();
    if (existing?.inputReceipt && existing.inputReceipt.binding.inputProfile === selection.endpoint.inputProfile) return existing.inputReceipt.binding;
    throw error;
  }
}

export async function getPixVerseInput(env: Env, auth: AuthorizedIdentity, binding: ManagedInputBinding): Promise<ManagedInputReceipt> {
  publicControlAuthorization(auth);
  if (await continuationScope(auth) !== binding.scope || auth.policy.generation !== binding.owner.policyGeneration) inputUnavailable();
  return backgroundCall(env, binding.scope, { action: "input_get", binding });
}

export async function dispatchPixVerseInput(request: Request, env: Env, auth: AuthorizedIdentity, binding: ManagedInputBinding,
  planValue: unknown, action: "upload" | "create", bytes?: Uint8Array<ArrayBuffer>): Promise<ManagedInputReceipt> {
  const authorization = publicControlAuthorization(auth), plan = preparePixVerseImagePlan(planValue);
  assertManagedInputLive(binding);
  if (await continuationScope(auth) !== binding.scope || !binding.owner.grantKey || await inputPlanDigest(plan) !== binding.createDigest) inputUnavailable();
  if (action === "upload" ? !bytes || bytes.length !== binding.size || await inputBytesDigest(bytes) !== binding.digest : bytes !== undefined) inputUnavailable();
  const receipt = await getPixVerseInput(env, auth, binding);
  // An acknowledged or lost-ACK bound result is returned without a second POST.
  if (action === "upload" && receipt.state === "bound") return receipt;
  if (action === "upload" && receipt.state !== "pending" || action === "create" && (receipt.state !== "bound" || receipt.createClaimed)) inputUnavailable();
  const operation = new HttpOperation(request.signal, Math.min(30_000, binding.expiresAt - Date.now()));
  let response: Response | undefined;
  try {
    const body = encodeInputDispatch({ binding, authorization, action, deadline: Math.min(binding.expiresAt, Date.now() + 30_000), plan }, bytes);
    response = await operation.wait(env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(binding.owner.grantKey))
      .fetch("https://clawrouter.internal/managed-input/dispatch", { method: "POST", body, signal: operation.signal, redirect: "manual" }));
    if (!response.ok || response.status !== 200 || response.redirected) inputUnavailable();
    if (action === "upload") {
      const result = await operation.wait(readPixVerseImageUpload(response));
      const ack = await backgroundCall<{ bound: boolean; receipt: ManagedInputReceipt }>(env, binding.scope,
        { action: "input_bind_upload", binding, imageId: result.id });
      if (!ack?.bound || ack.receipt.imageId !== result.id || !sameManagedInput(ack.receipt.binding, binding)) inputUnavailable();
      return ack.receipt;
    }
    const result = await operation.wait(createPixVerseManagedAdapter("image", receipt.imageId!).read(response,
      { action: "create", requestedVersion: binding.model, pathParams: {} }));
    const ack = await backgroundCall<{ bound: boolean }>(env, binding.scope, { action: "managed_bind", id: binding.jobId, responseId: result.id });
    if (!ack?.bound) inputUnavailable();
    return getPixVerseInput(env, auth, binding);
  } finally { operation.stop("complete"); void response?.body?.cancel().catch(() => undefined); }
}

// Advisory caller-specific catalog qualification. Dispatch still rechecks the
// selected original owner, policy and consent at each paid POST boundary.
export async function qualifyPixVerseInputCatalog(provider: CompiledProvider, endpoint: CompiledEndpoint, auth: AuthorizedIdentity, env: Env): Promise<void> {
  if (!endpoint.native_proxy || endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1") inputUnavailable();
  assertInputOperationPolicy(auth.policy);
  const upstream = await upstreamAuth(provider, auth, env, new Set(), null, true, undefined, { provider, endpoint, mode: "http" });
  if (!upstream.grantKey || !upstream.grant || upstream.grant.credentialStore !== "durable_object" || !upstream.grant.credentialLineage) inputUnavailable();
  const destination = await inputRouteDigest(provider, endpoint, upstream.grant, env);
  requireManagedCreateAdmission(auth.policy, env, { providerId: provider.id, endpointId: endpoint.id, grantKey: upstream.grantKey,
    lineage: upstream.grant.credentialLineage, routeSha256: destination.digest, policyGeneration: auth.policy.generation }, "pixverse.video");
}
