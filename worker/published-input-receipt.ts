import type { ContinuationOwner } from "./continuation-store.ts";
import type { PublicControlBinding } from "./response-control-authorization.ts";
import { HttpError, safeEqual } from "./utils.ts";

export const publishedInputVersion = "clawrouter.published-input.v1";
export const publishedInputSlot = "messages[0].content[1].image_url.url";
export const publishedInputMaxBytes = 8 * 1024 * 1024;
export const publishedInputLifetimeMs = 15 * 60_000;
export interface PublishedInputBinding {
  version: typeof publishedInputVersion;
  id: string;
  scope: string;
  issuer: PublicControlBinding;
  owner: ContinuationOwner & { providerId: "openrouter"; grantKey: string; lineage: string };
  generation: number;
  publicOrigin: string;
  origin: "https://openrouter.ai";
  path: "/api/v1/chat/completions";
  modelId: string;
  upstreamModel: "google/lyria-3-pro-preview" | "google/lyria-3-clip-preview";
  slot: typeof publishedInputSlot;
  requestDigest: string;
  permissionDigest: string;
  digest: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  idempotencyDigest: string;
  verifierDigest: string;
  allocatedAt: number;
  expiresAt: number;
}
export interface PublishedInputObject { key: string; version: string; etag: string; digest: string; mime: PublishedInputBinding["mime"]; size: number }
export interface PublishedInputAttempt {
  admissionDigest: string;
  requestId: string;
  eventId: string;
  reservedMicros: number;
  reservations: { objectName: string; reservationId: string }[];
}
export interface PublishedInputReceipt {
  version: typeof publishedInputVersion;
  binding: PublishedInputBinding;
  state: "pending" | "publication_unknown" | "published" | "forwarding_unknown";
  object: PublishedInputObject | null;
  attempt: PublishedInputAttempt | null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => object(value)
  && Object.keys(value).sort().join(",") === expected.slice().sort().join(",");
const text = (value: unknown, limit = 256): value is string => typeof value === "string" && value.length > 0
  && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
const date = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function readPublishedInputOrigin(value: unknown): string | null {
  try {
    const origin = new URL(value as string);
    if (origin.protocol !== "https:" || origin.origin !== value || origin.username || origin.password) return null;
    return origin.origin;
  } catch { return null; }
}

export function validatePublishedInput(value: unknown): asserts value is PublishedInputBinding {
  if (!keys(value, ["version", "id", "scope", "issuer", "owner", "generation", "publicOrigin", "origin", "path", "modelId",
    "upstreamModel", "slot", "requestDigest", "permissionDigest", "digest", "mime", "size", "idempotencyDigest", "verifierDigest", "allocatedAt", "expiresAt"])
    || value.version !== publishedInputVersion || typeof value.id !== "string" || value.id.length !== 38 || !/^asset_[a-f0-9]{32}$/.test(value.id)
    || typeof value.scope !== "string" || value.scope.length !== 83 || !/^http-continuations:[a-f0-9]{64}$/.test(value.scope)
    || value.origin !== "https://openrouter.ai" || value.path !== "/api/v1/chat/completions"
    || !text(value.modelId) || !value.modelId.startsWith("openrouter/")
    || !["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"].includes(value.upstreamModel as string)
    || value.slot !== publishedInputSlot || !digest(value.requestDigest) || !digest(value.permissionDigest) || !digest(value.digest)
    || !digest(value.idempotencyDigest) || !digest(value.verifierDigest)
    || !["image/png", "image/jpeg", "image/webp"].includes(value.mime as string)
    || !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > publishedInputMaxBytes
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || !date(value.allocatedAt) || !date(value.expiresAt) || value.expiresAt <= value.allocatedAt
    || value.expiresAt - value.allocatedAt > publishedInputLifetimeMs) publishedInputUnavailable();
  if (readPublishedInputOrigin(value.publicOrigin) === null) publishedInputUnavailable();
  const owner = value.owner;
  if (!keys(owner, ["providerId", "endpointId", "grantKey", "lineage", "routeSha256", "policyGeneration"])
    || owner.providerId !== "openrouter" || owner.endpointId !== "music_generate" || !text(owner.grantKey, 1024)
    || !owner.grantKey.startsWith("oauth/") || !text(owner.lineage) || !digest(owner.routeSha256) || !text(owner.policyGeneration)) publishedInputUnavailable();
  validatePublishedIssuer(value.issuer);
  if (value.issuer.policyGeneration !== owner.policyGeneration) publishedInputUnavailable();
}

export function validatePublishedIssuer(value: unknown): asserts value is PublicControlBinding {
  if (!keys(value, ["credentialId", "principalId", "policyId", "policyGeneration", "tenantId", "proof"])
    || value.credentialId !== null && !text(value.credentialId) || value.principalId !== null && !text(value.principalId)
    || !text(value.policyId) || !text(value.policyGeneration) || !text(value.tenantId) || !object(value.proof)) publishedInputUnavailable();
  const proof = value.proof;
  if (proof.kind === "proxy_key") {
    const expected = ["kind", "credentialId", "principalId", "secretSha256", ...(Object.hasOwn(proof, "expiresAt") ? ["expiresAt"] : [])];
    if (!keys(proof, expected) || proof.credentialId !== value.credentialId || !text(proof.credentialId)
      || proof.principalId !== value.principalId || !digest(proof.secretSha256)
      || proof.expiresAt != null && (!text(proof.expiresAt) || !Number.isFinite(Date.parse(proof.expiresAt)))) publishedInputUnavailable();
  } else {
    if (value.credentialId !== null || proof.email !== value.principalId || !text(proof.email) || !date(proof.expiresAtMs)) publishedInputUnavailable();
    if (proof.kind === "local") {
      if (!keys(proof, ["kind", "email", "sessionSha256", "expiresAtMs"]) || !digest(proof.sessionSha256)) publishedInputUnavailable();
    } else if (proof.kind !== "cloudflare_access" || !keys(proof, ["kind", "email", "expiresAtMs"])) publishedInputUnavailable();
  }
}

export function publishedInputKey(binding: PublishedInputBinding): string {
  return `published-input/v1/${binding.scope.slice("http-continuations:".length)}/${binding.id}`;
}
export function assertPublishedInputLive(binding: PublishedInputBinding, now = Date.now()): void {
  validatePublishedInput(binding);
  if (!date(now) || now < binding.allocatedAt || now >= binding.expiresAt) publishedInputUnavailable();
  const proof = binding.issuer.proof;
  if (proof.kind === "proxy_key" ? proof.expiresAt != null && Date.parse(proof.expiresAt) <= now : proof.expiresAtMs <= now) publishedInputUnavailable();
}
export function samePublishedInput(a: PublishedInputBinding, b: PublishedInputBinding): boolean {
  validatePublishedInput(a); validatePublishedInput(b);
  // Parsed records and allocation inputs have a fixed schema, but key insertion
  // order is not authority. Compare a canonical, bounded metadata graph.
  return canonical(a) === canonical(b);
}
export function samePublishedObject(a: PublishedInputObject, b: PublishedInputObject): boolean { return canonical(a) === canonical(b); }
export function validatePublishedObject(value: unknown, binding: PublishedInputBinding): asserts value is PublishedInputObject {
  if (!keys(value, ["key", "version", "etag", "digest", "mime", "size"]) || value.key !== publishedInputKey(binding)
    || !text(value.version) || !text(value.etag) || value.digest !== binding.digest || value.mime !== binding.mime || value.size !== binding.size) publishedInputUnavailable();
}
export function validatePublishedAttempt(value: unknown): asserts value is PublishedInputAttempt {
  if (!keys(value, ["admissionDigest", "requestId", "eventId", "reservedMicros", "reservations"]) || !digest(value.admissionDigest) || !text(value.requestId) || !text(value.eventId)
    || !Number.isSafeInteger(value.reservedMicros) || (value.reservedMicros as number) < 0
    || !Array.isArray(value.reservations) || value.reservations.length > 8
    || value.reservations.some(leg => !keys(leg, ["objectName", "reservationId"]) || !text(leg.objectName, 1024) || !text(leg.reservationId))) publishedInputUnavailable();
}
export function assertPublishedVerifier(receipt: PublishedInputReceipt, verifierDigest: string): void {
  assertPublishedInputLive(receipt.binding);
  if (!digest(verifierDigest) || !safeEqual(receipt.binding.verifierDigest, verifierDigest)) publishedInputUnavailable();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function publishedInputUnavailable(): never {
  throw new HttpError(409, "published_input_unavailable", "the original published input or destination attempt is unavailable");
}
