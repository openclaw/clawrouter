import { assertInputOperationPolicy } from "./pixverse-input-policy.ts";
export { assertInputOperationPolicy } from "./pixverse-input-policy.ts";
import { resolveConnection } from "./authority.ts";
import { responseRouteDigest } from "./responses-control-dispatch.ts";
import { BodyLease } from "./body-budget.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { configuredUpstream, modelSupportsEndpoint, providerById } from "./providers.ts";
import { backgroundCall } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { assertManagedInputLive, inputUnavailable, managedInputMaxBytes, sameManagedInput, type ManagedInputBinding, type ManagedInputState, type ManagedInputReceipt } from "./managed-input-receipt.ts";
import { createPixVerseManagedAdapter, pixVerseOrigins, preparePixVerseImagePlan, preparePixVerseImageUpload } from "./managed-pixverse.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlScope, type ResponseControlAuthorization } from "./response-control-authorization.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { upstreamRetentionBindingAllowed } from "./upstream-retention-admission.ts";
import { readBounded } from "./transcription-body.ts";
import type { CompiledEndpoint, CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

export interface PixVerseInputDispatch {
  binding: ManagedInputBinding;
  authorization: ResponseControlAuthorization;
  action: "upload" | "create";
  deadline: number;
  plan: Record<string, unknown>;
}
export const pixVerseInputPaths = { upload: "/openapi/v2/image/upload", create: "/openapi/v2/video/img/generate" } as const;
const encoder = new TextEncoder();
export async function inputBytesDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function inputPlanDigest(plan: Record<string, unknown>): Promise<string> {
  return sha256Hex(JSON.stringify(plan, Object.keys(plan).sort()));
}
export async function inputRouteDigest(provider: CompiledProvider, endpoint: CompiledEndpoint, grant: UpstreamGrant, env: Env): Promise<{ digest: string; origin: string; region: "international" | "cn" }> {
  const upstream = configuredUpstream(provider, grant, env), origin = upstream.baseUrl;
  const region = origin === pixVerseOrigins.international ? "international" : origin === pixVerseOrigins.cn ? "cn" : null;
  const scheme = provider.auth.schemes.find(scheme => scheme.type !== "oauth");
  if (provider.id !== "pixverse" || !provider.endpoints.includes(endpoint) || endpoint.method !== "POST"
    || endpoint.path !== pixVerseInputPaths.create || endpoint.request_format !== "pixverse.image_video" || endpoint.response_format !== "pixverse.video"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length || endpoint.auth || endpoint.streaming || endpoint.websocket || endpoint.modelPassthrough
    || Object.keys(endpoint.query).length || Object.keys(endpoint.headers).length || !region || upstream.query.size || upstream.transport
    || scheme?.type !== "api_key" || scheme.header.toLowerCase() !== "api-key" || scheme.secretKind !== "api_key"
    || grant.kind !== "api_key" || typeof grant.credential !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(grant.credential)
    || upstream.headers.get("api-key") !== grant.credential || [...upstream.headers.keys()].some(name => name !== "api-key")) inputUnavailable();
  if (endpoint.inputProfile !== undefined) {
    if (endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1" || endpoint.lifecycle?.protocol !== "pixverse.video") inputUnavailable();
    return { origin, region, digest: await responseRouteDigest(provider, upstream, new URL(origin + endpoint.path),
      new Headers(upstream.headers), upstream.grantKey, endpoint.lifecycle, env) };
  }
  // Only existing unprofiled internal v1 receipts use this identity. Never try
  // it as a fallback for a profiled lifecycle route that fails verification.
  return { origin, region, digest: await sha256Hex(JSON.stringify(["clawrouter.managed-input.v1", provider.id, endpoint.id,
    endpoint.path, endpoint.request_format, endpoint.response_format, origin, grant.credentialLineage, pixVerseInputPaths.upload])) };
}

export interface PreparedInputDispatch {
  input: PixVerseInputDispatch;
  upload?: { body: FormData | ReadableStream<Uint8Array>; headers: Headers; length?: number };
  lease: BodyLease;
}
// Fixed internal binary envelope, never public multipart/body/path override.
export async function prepareInputDispatch(request: Request): Promise<PreparedInputDispatch> {
  const operation = new HttpOperation(request.signal, 30_000), lease = new BodyLease();
  try {
    if (!lease.grow(32 * 1024 * 1024)) throw new HttpError(503, "server_overloaded", "input upload capacity is busy");
    const raw = await readBounded(request.body, managedInputMaxBytes + 16_388, operation, 413);
    if (raw.length < 5) inputUnavailable();
    const size = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0);
    if (size > 16_384 || size < 1 || size + 4 > raw.length) inputUnavailable();
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(4, size + 4))) as PixVerseInputDispatch;
    if (!input || Object.keys(input).sort().join() !== "action,authorization,binding,deadline,plan" || !["upload", "create"].includes(input.action)) inputUnavailable();
    assertInputDeadline(input);
    if (input.binding.inputProfile !== undefined) inputUnavailable();
    const plan = preparePixVerseImagePlan(input.plan);
    if (plan.model !== input.binding.model || await inputPlanDigest(plan) !== input.binding.createDigest
      || await publicControlScope(input.authorization) !== input.binding.scope) inputUnavailable();
    const bytes = raw.slice(size + 4);
    let upload: PreparedInputDispatch["upload"];
    if (input.action === "upload") {
      if (bytes.length !== input.binding.size || await inputBytesDigest(bytes) !== input.binding.digest) inputUnavailable();
      upload = preparePixVerseImageUpload({ file: { bytes, type: input.binding.mime, name: "input-image" } });
    } else if (bytes.length) inputUnavailable();
    return { input: { ...input, plan }, upload, lease };
  } catch (error) { lease.release(); throw error; }
  finally { operation.stop("complete"); }
}
export function encodeInputDispatch(input: PixVerseInputDispatch, bytes?: Uint8Array): Uint8Array<ArrayBuffer> {
  const metadata = encoder.encode(JSON.stringify(input));
  if (metadata.length > 16_384 || bytes && bytes.length > managedInputMaxBytes) inputUnavailable();
  const body = new Uint8Array(4 + metadata.length + (bytes?.length ?? 0));
  new DataView(body.buffer).setUint32(0, metadata.length); body.set(metadata, 4); if (bytes) body.set(bytes, 4 + metadata.length);
  return body;
}
export function assertInputDeadline(input: PixVerseInputDispatch): void {
  assertManagedInputLive(input.binding);
  if (!Number.isSafeInteger(input.deadline) || Date.now() >= input.deadline || input.deadline > input.binding.expiresAt) inputUnavailable();
}

// Both dispatch and recovery use the same current original owner/policy checks.
export async function authorizeInputUnderOwner(env: Env, input: PixVerseInputDispatch, record: CredentialRecord | undefined,
  grant: UpstreamGrant | undefined, signal: AbortSignal): Promise<ManagedInputState | ManagedInputReceipt> {
  const { binding } = input;
  if (!record || !grant || record.version !== 1 || record.providerId !== "pixverse" || record.grantKey !== binding.owner.grantKey
    || record.kind !== "api_key" || record.generation !== binding.generation || record.lineage !== binding.owner.lineage
    || record.enabled !== true || record.revokedAt || record.status !== "active" || typeof record.credential !== "string"
    || record.credentials && Object.keys(record.credentials).length || record.accessToken || record.refreshToken) inputUnavailable();
  const provider = providerById("pixverse"), endpoint = provider?.endpoints.find(value => value.id === binding.owner.endpointId);
  const model = provider?.models.find(value => value.id === binding.modelId && value.upstream === binding.model);
  if (!provider || !endpoint || !model || !modelSupportsEndpoint(provider, model, endpoint)) inputUnavailable();
  if (endpoint.inputProfile !== binding.inputProfile || binding.inputProfile !== undefined
    && (!model.capabilities.includes("video.generate") || !provider.capabilities.some(value => value.id === "video.generate" && value.endpoint === endpoint.id))) inputUnavailable();
  const destination = await inputRouteDigest(provider, endpoint, grant, env);
  if (destination.digest !== binding.owner.routeSha256 || destination.origin !== binding.origin || destination.region !== binding.region) inputUnavailable();
  if ((await resolveConnection(env, provider.id))?.enabled === false) inputUnavailable();
  const policy = await authorizeResponseControl(env, input.authorization, binding.owner, signal, "pixverse.video");
  if (!policy) inputUnavailable();
  assertPolicyModel(policy, { model, endpoint, capability: "video.generate" }); assertInputOperationPolicy(policy);
  const receipt = await backgroundCall<ManagedInputReceipt | ManagedInputState>(env, binding.scope, { action: "input_get", binding, ...(binding.inputProfile ? { summary: true } : {}) });
  if (!sameManagedInput(receipt.binding, binding)) inputUnavailable();
  signal.throwIfAborted(); assertControlCallerLive(input.authorization);
  if (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now())
    || !upstreamRetentionBindingAllowed(env, binding.owner, "pixverse.video")) inputUnavailable();
  return receipt;
}

// Called only within the original credential owner's mutation tail. The scoped
// receipt claim is the last await. Its owner never calls this credential owner.
export async function dispatchInputUnderOwner(env: Env, prepared: PreparedInputDispatch, record: CredentialRecord | undefined,
  grant: UpstreamGrant | undefined, signal: AbortSignal): Promise<{ response: Promise<Response> }> {
  const { input } = prepared, { binding } = input;
  const receipt = await authorizeInputUnderOwner(env, input, record, grant, signal);
  const headers = input.action === "upload" ? prepared.upload!.headers : createPixVerseManagedAdapter("image", receipt.imageId ?? undefined)
    .prepare({ ...input.plan, img_id: Number(receipt.imageId) }, new Headers(), {}, new URLSearchParams()).headers;
  const body = input.action === "upload" ? prepared.upload!.body : JSON.stringify({ ...input.plan, img_id: Number(receipt.imageId) });
  const outbound = new Request(binding.origin + pixVerseInputPaths[input.action], { method: "POST", headers, body, redirect: "manual", signal, duplex: "half" } as RequestInit);
  outbound.headers.set("API-KEY", record!.credential!);
  const length = input.action === "upload" ? prepared.upload?.length : undefined;
  if (length !== undefined) {
    if (!Number.isSafeInteger(length) || length < 1 || length > managedInputMaxBytes + 1024) inputUnavailable();
    outbound.headers.set("content-length", String(length));
  }
  // Validate generated headers before the final owner call; never copy caller headers.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(outbound.headers.get("ai-trace-id") ?? "")
    || [...outbound.headers.keys()].some(name => !["api-key", "ai-trace-id", "content-type", ...(length === undefined ? [] : ["content-length"])].includes(name))) inputUnavailable();
  const ack = await backgroundCall<{ claimed: boolean; receipt: ManagedInputReceipt | ManagedInputState }>(env, binding.scope,
    { action: input.action === "upload" ? "input_claim_upload" : "input_claim_create", binding, ...(binding.inputProfile ? { summary: true } : {}) });
  signal.throwIfAborted(); assertInputDeadline(input); assertControlCallerLive(input.authorization);
  if (!ack?.claimed || !sameManagedInput(ack.receipt.binding, binding)
    || input.action === "create" && ack.receipt.imageId !== receipt.imageId
    || record!.expiresAt && (!Number.isFinite(Date.parse(record!.expiresAt)) || Date.parse(record!.expiresAt) <= Date.now())
    || !upstreamRetentionBindingAllowed(env, binding.owner, "pixverse.video")) inputUnavailable();
  return { response: fetch(outbound, { signal }) };
}
