import type { BackgroundAdmission, BackgroundJob, BackgroundRecord } from "./background-store.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { pixVerseOrigins, validatePixVerseId } from "./managed-pixverse.ts";
import { HttpError } from "./utils.ts";

export const managedInputMaxBytes = 8 * 1024 * 1024;

// Private, server-derived receipt. A handle selects this row; it grants nothing.
export interface ManagedInputBinding {
  version: "clawrouter.managed-input.v1";
  scope: string;
  jobId: string;
  owner: ContinuationOwner;
  generation: number;
  product: "pixverse.video";
  origin: string;
  region: "international" | "cn";
  modelId: string;
  model: "v6" | "c1";
  slot: "image";
  digest: string;
  createDigest: string;
  size: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  expiresAt: number;
}
export interface ManagedInputReceipt {
  binding: ManagedInputBinding;
  state: "pending" | "dispatch_unknown" | "bound";
  imageId: string | null;
  createClaimed: boolean;
  // Same scoped row/outbox, but a distinct operation, reservation and event.
  upload: BackgroundRecord;
}
export interface ManagedInputAllocation {
  binding: ManagedInputBinding;
  admission: BackgroundAdmission;
  upload: Pick<BackgroundAdmission, "facts" | "plan">;
}
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validateManagedInput(binding: ManagedInputBinding): void {
  if (!binding || Object.keys(binding).sort().join() !== "createDigest,digest,expiresAt,generation,jobId,mime,model,modelId,origin,owner,product,region,scope,size,slot,version"
    || binding.version !== "clawrouter.managed-input.v1" || !/^http-continuations:[a-f0-9]{64}$/.test(binding.scope)
    || !/^bg_[a-f0-9]{32}$/.test(binding.jobId) || binding.product !== "pixverse.video" || binding.slot !== "image"
    || !Object.hasOwn(pixVerseOrigins, binding.region) || binding.origin !== pixVerseOrigins[binding.region]
    || !["v6", "c1"].includes(binding.model) || typeof binding.modelId !== "string" || !/^[a-zA-Z0-9._/-]{1,128}$/.test(binding.modelId)
    || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !digest(binding.digest) || !digest(binding.createDigest)
    || !Number.isSafeInteger(binding.size) || binding.size < 1 || binding.size > managedInputMaxBytes
    || !["image/png", "image/jpeg", "image/webp"].includes(binding.mime) || !Number.isSafeInteger(binding.expiresAt)) inputUnavailable();
  const owner = binding.owner;
  if (!owner || Object.keys(owner).sort().join() !== "endpointId,grantKey,lineage,policyGeneration,providerId,routeSha256"
    || owner.providerId !== "pixverse" || typeof owner.endpointId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(owner.endpointId)
    || typeof owner.grantKey !== "string" || !/^[a-zA-Z0-9_./:-]{1,256}$/.test(owner.grantKey)
    || typeof owner.lineage !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.lineage)
    || typeof owner.policyGeneration !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.policyGeneration) || !digest(owner.routeSha256)) inputUnavailable();
}
export function sameManagedInput(a: ManagedInputBinding, b: ManagedInputBinding): boolean {
  validateManagedInput(a); validateManagedInput(b);
  return Object.keys(a).every(key => key === "owner"
    ? Object.keys(a.owner).every(field => a.owner[field as keyof ContinuationOwner] === b.owner[field as keyof ContinuationOwner])
    : a[key as keyof ManagedInputBinding] === b[key as keyof ManagedInputBinding]);
}
export function assertManagedInputLive(binding: ManagedInputBinding): void {
  validateManagedInput(binding);
  if (Date.now() >= binding.expiresAt) inputUnavailable();
}
export function inputReceipt(job: BackgroundRecord | null, binding: ManagedInputBinding): ManagedInputReceipt {
  if (!job?.inputReceipt || job.id !== binding.jobId || !sameManagedInput(job.inputReceipt.binding, binding)) inputUnavailable();
  return job.inputReceipt;
}
export function validateInputAllocation(input: ManagedInputAllocation): void {
  const { binding, admission, upload } = input;
  assertManagedInputLive(binding);
  if (binding.expiresAt > admission.admittedAt + 60_000 || admission.id !== binding.jobId
    || JSON.stringify(binding.owner) !== JSON.stringify(admission.owner) || admission.managed?.protocol !== "pixverse.video"
    || admission.managed.requestedVersion !== binding.model || admission.facts.event.model !== binding.modelId
    || admission.facts.event.capability !== "video.generate" || upload.facts.event.capability !== "pixverse.image_upload"
    || admission.facts.event.id === upload.facts.event.id || admission.facts.event.request_id === upload.facts.event.request_id
    || upload.plan.legs.some(leg => admission.plan.legs.some(other => leg.request.reservationId === other.request.reservationId))) inputUnavailable();
  for (const operation of [admission, upload]) {
    const fixed = operation.facts.fixed;
    if (operation.facts.cost.basis !== "policy_fixed" || !Number.isSafeInteger(fixed) || fixed === null || fixed < 0
      || fixed !== operation.facts.cost.reserveMicros || operation.plan.reservedMicros !== (operation.plan.legs.length ? fixed : 0)
      || operation.plan.legs.some(leg => leg.request.costMicros !== fixed || leg.request.capability !== operation.facts.event.capability)) inputUnavailable();
  }
}
export function bindManagedInput(receipt: ManagedInputReceipt, imageId: string): void {
  assertManagedInputLive(receipt.binding);
  if (receipt.state === "pending" || receipt.createClaimed || receipt.imageId !== null && receipt.imageId !== imageId) inputUnavailable();
  receipt.imageId = validatePixVerseId(imageId); receipt.state = "bound";
}
export function inputUnavailable(): never { throw new HttpError(409, "managed_input_unavailable", "the original input intent is unavailable or already attempted; never replay an upload or create"); }
export function uploadJob(receipt: ManagedInputReceipt): BackgroundJob {
  const upload = receipt.upload;
  if (upload.phase === "complete" || upload.phase === "expired") inputUnavailable();
  return upload;
}
