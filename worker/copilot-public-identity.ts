import { HttpError, safeEqual } from "./utils.ts";
import type { AccessPolicy, Env } from "./types.ts";
import type { CopilotRuntimeIdentity } from "./provider-copilot.ts";
import type { ResponseControlAuthorization } from "./response-control-authorization.ts";
import { inputRetirement } from "./input-retirement.ts";
import { inspectCopilotInferenceJson } from "./copilot-inference-dispatch.ts";

export interface CopilotPublicIdentityProfile {
  integrationId: string;
  editorVersion: string;
  editorPluginVersion: string;
  userAgent: string;
  initiator: "user" | "agent";
}
export interface CopilotPublicIdentityAttestation {
  revision: string;
  profile: CopilotPublicIdentityProfile;
}

const denied = () => new HttpError(403, "copilot_public_identity_unavailable", "Current Copilot integration authority unavailable");
const fields = ["integrationId", "editorVersion", "editorPluginVersion", "userAgent", "initiator"] as const;

// Private control/authority replies use the same finite original-reader rules.
// The enclosing operation owns this whole promise, including a late Response;
// it must never race/release individual reads. No growing chunk archive exists.
export async function readCopilotPublicJson(source: Pick<Response, "body" | "bodyUsed" | "headers">, signal: AbortSignal, maximum = 8192): Promise<unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 || !source.body || source.bodyUsed || source.body.locked) throw denied();
  let reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array> | undefined;
  let byob = false, window = new Uint8Array(16 * 1024), size = 0, reads = 0, eof = false, failed = false;
  const owner = inputRetirement({
    async cancel(reason) { try { await (reader ? reader.cancel(reason) : source.body!.cancel(reason)); } catch (error) { failed = true; throw error; } },
    releaseLock() { reader?.releaseLock(); if (source.body!.locked) { failed = true; throw denied(); } },
  });
  const cancel = () => { void owner.retire("cancel", signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const length = source.headers.get("content-length"), encoding = source.headers.get("content-encoding");
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(source.headers.get("content-type") ?? "")
      || source.headers.has("content-range") || encoding !== null && encoding.toLowerCase() !== "identity"
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw denied();
    try { reader = source.body.getReader({ mode: "byob" }); byob = true; }
    catch { reader = source.body.getReader(); }
    const bytes = new Uint8Array(maximum);
    for (;;) {
      signal.throwIfAborted(); if (++reads > 8192) throw denied();
      const next = await owner.read(() => byob ? (reader as ReadableStreamBYOBReader).read(window) : (reader as ReadableStreamDefaultReader<Uint8Array>).read());
      signal.throwIfAborted();
      if (next.value) {
        if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer) || next.value.buffer.byteLength > 16 * 1024
          || next.value.byteLength > maximum - size) throw denied();
        bytes.set(next.value, size); size += next.value.byteLength;
      }
      if (next.done) { eof = true; break; }
      if (byob) { if (!(next.value?.buffer instanceof ArrayBuffer) || !next.value.buffer.byteLength) throw denied(); window = new Uint8Array(next.value.buffer); }
    }
    if (!size || length !== null && Number(length) !== size) throw denied();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    inspectCopilotInferenceJson(text);
    await owner.retire("eof"); signal.throwIfAborted();
    if (failed) throw denied();
    return JSON.parse(text);
  } catch (error) { await owner.retire(eof ? "eof" : "cancel", error); throw error; }
  finally { signal.removeEventListener("abort", cancel); window = new Uint8Array(0); }
}

export function normalizeCopilotPublicIdentity(value: unknown): CopilotPublicIdentityProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !(fields as readonly string[]).includes(key))) throw denied();
  for (const key of fields.slice(0, 4)) {
    const text = row[key];
    if (typeof text !== "string" || !/^[\x20-\x7e]{1,512}$/.test(text) || text.trim() !== text) throw denied();
  }
  if (!/^[A-Za-z0-9._-]+$/.test(row.integrationId as string) || !["user", "agent"].includes(row.initiator as string)) throw denied();
  return Object.freeze({ integrationId: row.integrationId as string, editorVersion: row.editorVersion as string,
    editorPluginVersion: row.editorPluginVersion as string, userAgent: row.userAgent as string, initiator: row.initiator as "user" | "agent" });
}

export function readCopilotPublicIdentity(value: unknown): CopilotPublicIdentityAttestation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "revision") || !Object.hasOwn(row, "profile")
    || typeof row.revision !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.revision)) return null;
  try { return Object.freeze({ revision: row.revision, profile: normalizeCopilotPublicIdentity(row.profile) }); }
  catch { return null; }
}

// This authoritative snapshot contains both the key and its attestation. Cached
// admission, labels and a caller's client headers cannot mint an integration.
export async function currentCopilotPublicIdentity(env: Env, authorization: ResponseControlAuthorization, signal: AbortSignal,
  expected?: CopilotPublicIdentityAttestation): Promise<{ attestation: CopilotPublicIdentityAttestation; policy: AccessPolicy }> {
  const { assertControlCallerLive } = await import("./response-control-authorization.ts");
  const { proxyCredentialFailure } = await import("./proxy-auth.ts");
  if (authorization.kind !== "public") throw denied();
  const binding = authorization.binding, proof = binding.proof;
  if (proof.kind !== "proxy_key") throw denied();
  assertControlCallerLive(authorization);
  const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
  const response = await stub.fetch("https://clawrouter.internal/authorization/snapshot", { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialId: binding.credentialId, principalId: binding.principalId, policyId: binding.policyId }) });
  const snapshot = await readCopilotPublicJson(response, signal, 128 * 1024) as import("./authority-contracts.ts").AuthorizationSnapshot;
  if (response.status !== 200 || response.redirected) throw denied();
  signal.throwIfAborted(); assertControlCallerLive(authorization);
  const credential = snapshot.credential, policy = snapshot.policy;
  if (!credential || !policy || proof.credentialId !== binding.credentialId || proof.principalId !== binding.principalId
    || credential.policyId !== binding.policyId || (credential.principalId ?? null) !== binding.principalId
    || !safeEqual(credential.secretSha256, proof.secretSha256) || policy.policyId !== binding.policyId
    || policy.policy.generation !== binding.policyGeneration || (policy.policy.tenantId ?? "default") !== binding.tenantId
    || policy.policy.providers.length && !policy.policy.providers.includes("github-copilot")) throw denied();
  const failure = proxyCredentialFailure(credential, policy, snapshot.principalEnabled);
  if (failure) throw failure;
  const attestation = readCopilotPublicIdentity(credential.copilotPublicIdentity);
  if (!attestation || expected && (expected.revision !== attestation.revision
    || fields.some(key => expected.profile[key] !== attestation.profile[key]))) throw denied();
  return { attestation, policy: policy.policy };
}

export function copilotPublicRuntimeIdentity(attestation: CopilotPublicIdentityAttestation, ownerBinding: string): CopilotRuntimeIdentity {
  if (!/^[a-f0-9]{64}$/.test(ownerBinding)) throw denied();
  const { initiator: _initiator, ...profile } = normalizeCopilotPublicIdentity(attestation.profile);
  return Object.freeze({ ...profile, ownerBinding });
}
