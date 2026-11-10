import { identityJsonProfiles } from "./access-json.ts";
import type { Env } from "./types";
import { admitAdmission, admitIdentity, copyIdentity, admittedEffectivePolicy, advanceIdentitySource, identityFailure, identityPlan, identitySourceBudget,
  identitySourceSnapshot, type IdentitySourceBudget } from "./identity-admission.ts";
import { admitBridgeFactories, admitBridgeCopyFactories, admissionBridgePhasePayload, reserveAdmissionScratch, retireAdmissionScratch, PreflightTicket, GenerationMetadataCharge, GenerationConsumptionLease, admissionScratchBytes, type GenerationRetainedCharge } from "./credential-preflight-arena.ts";
import { admitGenerationFactories, admitGenerationConsumptionFactories, generationMetadata, measureGenerationGraph, freezeGenerationGraph,
  copyGenerationCoverage, generationCoverageLayout, sameGenerationCoverage,
  type GenerationCoverage, type GenerationAuthentication, type IdentityGenerationPreparation, type IdentityGenerationBorrow } from "./identity-generations.ts";
import { PrivateCacheReservation, hotCacheNow, hotCacheConfig, tryRunInBackground, type HotCacheConfig } from "./hot-cache.ts";
import { ownsCredentialPrefetchPermit, moveOwnedCredentialBorrow, type OwnedCredentialBorrow } from "./credential-cache.ts";
import { materializeGrantCredentials } from "./grant-credentials.ts";
import { grantRevision } from "./grant-eligibility.ts";
import { snapshot as providerSnapshot } from "./providers.ts";
import { GenerationAdvisoryState, waitGenerationFlushWindow, admitGenerationOverlay, generationSelectionWorkingBytes, planGenerationSelection, generationRuntimeWorkingBytes, detachedGenerationRuntime, detachedGenerationFeedback } from "./admission-cache.ts";
import { authorityCall } from "./authority.ts";
import { recordGrantRuntime } from "./grant-selection.ts";
import { ownedGenerationCredentialFailure } from "./proxy-auth.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import { safeEqual } from "./utils.ts";
import { admissionContinuationHeader, admissionContinuationVersion, admissionContinuationPath, closeAdmissionEnvelope, type AdmissionContinuationEnvelope, checkPreflightIdentity, credentialPreflightHeader, credentialPreflightNamespace,
  credentialPreflightPath, credentialPreflightVersion } from "./credential-preflight-protocol.ts";
import { consumeAdmissionBridge, consumePreflightReply } from "./credential-preflight-source.ts";

// Capture the native Annex B lookups and apply before any input inspection.
// Availability is qualified by hosted Node/Workerd witnesses, never assumed.
const serializationLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
const serializationLookupSetter = (Object.prototype as { __lookupSetter__?: unknown }).__lookupSetter__;
const serializationApply = Reflect.apply;

// Deliberately no caller from ordinary admission/preverification. These empty
// carriers grant neither identity nor authentication and have no wire encoding.
export interface CredentialPreflightProof { readonly kind?: never }
export interface CredentialPreflightContinuation { readonly kind?: never }
type Authority = NonNullable<Env["ACCESS_CONTROL"]>;
type Owner = { binding: Authority; namespace: typeof credentialPreflightNamespace; kid: string;
  digest: string; source: IdentitySourceBudget; ticket: PreflightTicket };
const proofs = new WeakMap<CredentialPreflightProof, Owner>();
const continuations = new WeakMap<CredentialPreflightContinuation, Owner>();
export type CredentialPreflightResult = { outcome: "unknown" | "invalid" } | { outcome: "matched"; proof: CredentialPreflightProof };

export function preflightCredential(env: Pick<Env, "ACCESS_CONTROL">, kid: string, digest: string, signal?: AbortSignal): Promise<CredentialPreflightResult> {
  // The common Worker body arena funds every new operation factory first.
  const ticket = PreflightTicket.reserve(); ticket.enter("operation");
  try {
    checkPreflightIdentity(kid, digest);
    if (!env.ACCESS_CONTROL) throw identityFailure("protocol");
    const operation = run({ binding: env.ACCESS_CONTROL, namespace: credentialPreflightNamespace,
      kid, digest, source: identitySourceBudget(), ticket }, signal);
    // Observe immediately without retaining fulfilled graphs or changing the
    // ORIGINAL operation's fulfillment/rejection delivered to its caller.
    void operation.then(() => undefined, () => undefined);
    return operation;
  } catch (error) { ticket.release(); throw error; }
}
async function run(owner: Owner, signal?: AbortSignal): Promise<CredentialPreflightResult> {
  let body: string | undefined, init: RequestInit | undefined;
  let sent: IdentitySourceBudget | undefined, replySource: IdentitySourceBudget | undefined;
  let request: { credentialId: string; secretSha256: string; source: IdentitySourceBudget } | undefined;
  let plan: ReturnType<typeof identityPlan> | undefined, stub: DurableObjectStub | undefined;
  let reply: Awaited<ReturnType<typeof consumePreflightReply>> | undefined;
  let retained = false;
  try {
    sent = identitySourceSnapshot(owner.source);
    request = { credentialId: owner.kid, secretSha256: owner.digest, source: sent };
    plan = identityPlan(); plan.item(request, 0);
    body = JSON.stringify(request);
    init = { method: "POST", headers: { "content-type": "application/json", [credentialPreflightHeader]: credentialPreflightVersion }, body, signal, redirect: "manual" };
    stub = owner.binding.get(owner.binding.idFromName(owner.namespace));
    replySource = identitySourceBudget();
    reply = await consumePreflightReply(owner.ticket,
      () => stub!.fetch(`https://authority${credentialPreflightPath}`, init), replySource, signal);
    advanceIdentitySource(owner.source, sent, reply.source, replySource);
    // Actual fetch, ORIGINAL body read/FIRST cancel/unlock and late-body cleanup
    // have joined. Clear outbound aliases before changing the payload charge.
    body = undefined; init = undefined; sent = undefined; replySource = undefined;
    const outcome = reply.outcome;
    request = undefined; plan = undefined; stub = undefined; reply = undefined; signal = undefined;
    if (outcome !== "matched") return { outcome };
    // Exact normative scalar payload: UTF-16 strings + seven 64-bit counters.
    // Control slots remain separately inventoried; this is NOT a heap sizeof.
    owner.ticket.retainProof(2 * (owner.kid.length + owner.digest.length + owner.namespace.length) + 7 * 8);
    const proof = Object.freeze({}); proofs.set(proof, owner); retained = true;
    return { outcome: "matched", proof };
  } finally {
    body = undefined; init = undefined; sent = undefined; replySource = undefined;
    request = undefined; plan = undefined; stub = undefined; reply = undefined; signal = undefined;
    if (!retained) retireOwner(owner);
  }
}
function retireOwner(owner: Owner): void {
  owner.kid = ""; owner.digest = ""; owner.binding = undefined as never;
  retireAdmissionScratch(owner.ticket); owner.ticket.release();
}
function ownerOf(proof: CredentialPreflightProof, env: Pick<Env, "ACCESS_CONTROL">, kid: string, digest: string): Owner {
  const owner = proofs.get(proof);
  if (!owner || owner.binding !== env.ACCESS_CONTROL || owner.namespace !== credentialPreflightNamespace
    || owner.kid !== kid || owner.digest !== digest) throw identityFailure("protocol");
  return owner;
}
export function consumeCredentialPreflight(proof: CredentialPreflightProof, env: Pick<Env, "ACCESS_CONTROL">,
  kid: string, digest: string): CredentialPreflightContinuation {
  const owner = ownerOf(proof, env, kid, digest);
  // Failed expansion leaves the SAME funded proof owned by its caller. A
  // successful expansion transfers atomically; no release/reacquire interval.
  owner.ticket.expandForContinuation();
  proofs.delete(proof);
  const continuation = Object.freeze({}); continuations.set(continuation, owner);
  return continuation;
}
export function releaseCredentialPreflight(proof: CredentialPreflightProof): void {
  const owner = proofs.get(proof);
  if (!owner) throw identityFailure("protocol");
  proofs.delete(proof); retireOwner(owner);
}
export function releaseCredentialPreflightContinuation(continuation: CredentialPreflightContinuation): void {
  const owner = continuations.get(continuation);
  if (!owner) throw identityFailure("protocol");
  continuations.delete(continuation); retireOwner(owner);
}

// Inactive continuation: the caller never receives the full admission graph.
export interface PrivateAdmissionHandle { dispose(): void }
type AdmissionOwner = Owner & { admission?: import("./authority-admission.ts").AdmissionResult; generationSnapshotOnly?: boolean };
const admissions = new WeakMap<PrivateAdmissionHandle, AdmissionOwner>();
function disposeAdmission(this: PrivateAdmissionHandle): void {
  const owner = admissions.get(this);
  if (!owner) throw identityFailure("protocol");
  admissions.delete(this); owner.admission = undefined; retireOwner(owner);
}
export function completeCredentialAdmission(continuation: CredentialPreflightContinuation,
  input: Omit<import("./authority-admission.ts").AdmissionRequest, "credentialId" | "secretSha256"> & { credentialId?: string; secretSha256?: string },
  signal?: AbortSignal): Promise<PrivateAdmissionHandle> {
  const owner = continuations.get(continuation);
  if (!owner) throw identityFailure("protocol");
  admitIdentity(input);
  if (input.credentialId !== undefined && input.credentialId !== owner.kid
    || input.secretSha256 !== undefined && input.secretSha256 !== owner.digest
    || input.cover !== undefined || input.video !== undefined || input.search !== undefined) throw identityFailure("protocol");
  // Validate the bridge inventory before consuming the single-use owner.
  admitBridgeFactories();
  guardAdmissionSerialization(owner, input);
  continuations.delete(continuation);
  const operation = runAdmission(owner, input, signal);
  void operation.then(() => undefined, () => undefined);
  return operation;
}
// PRIVATE passive-data prevalidation. The ordinary planner intentionally skips
// callable members; JSON serialization would consult their toJSON FIRST. Inspect
// native accessor lookup before a type-only Get: no hook invocation, Symbol enumeration or a
// retained key vector. Failed prevalidation leaves the continuation owned.
function guardAdmissionSerialization(owner: AdmissionOwner, input: Record<string, unknown>): void {
  const worker = admissionBridgePhasePayload.workerReply, ticket = owner.ticket;
  ticket.enter("source");
  let lease: ReturnType<typeof reserveAdmissionScratch> | undefined;
  let visit: ((value: unknown, depth: number, keyUnits: number) => void) | undefined;
  try {
    // Parent data descriptors can coexist along the existing 24-level JSON
    // profile. Fund their admitted string references plus active key occurrences;
    // omitted callable-member keys are measured before their descriptor factory.
    if (typeof serializationLookupGetter !== "function" || typeof serializationLookupSetter !== "function") throw identityFailure("protocol");
    lease = reserveAdmissionScratch(ticket, worker.admittedRepresentations + worker.flatten + worker.decodedChunk,
      { C: 1, P: 1, N: 25, U: identityJsonProfiles.complete.units + 256 + 6, B: 0 });
    visit = (value: unknown, depth: number, keyUnits: number): void => {
      if (typeof value === "function") {
        // Native internal descriptor lookup returns ONLY an accessor or undefined,
        // never a JS descriptor carrying an arbitrarily large inert data value.
        // Each fixed argument array's last consumer finishes before the next one.
        const unsupported = serializationApply(serializationLookupGetter, value, ["toJSON"]) !== undefined
          || serializationApply(serializationLookupSetter, value, ["toJSON"]) !== undefined
          || typeof (value as Function & { toJSON?: unknown }).toJSON === "function";
        // The final typeof borrows only its operand. No inert value is assigned
        // to an application field/array/descriptor or used in a string operation.
        value = undefined;
        if (unsupported) throw identityFailure("protocol");
        return;
      }
      if (value === null || typeof value !== "object") return;
      if (depth >= identityJsonProfiles.complete.depth) throw identityFailure("limit");
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const key = String(index);
          lease!.admit({ C: 1, P: 1, N: 25, U: identityJsonProfiles.complete.units + 256 + 6 + keyUnits + key.length, B: 0 });
          let descriptor = Object.getOwnPropertyDescriptor(value, key);
          try {
            if (descriptor && !Object.hasOwn(descriptor, "value")) throw identityFailure("protocol");
            visit!(descriptor?.value, depth + 1, keyUnits + key.length);
          } finally { descriptor = undefined; }
        }
      } else for (const key in value) if (Object.hasOwn(value, key)) {
        lease!.admit({ C: 1, P: 1, N: 25, U: identityJsonProfiles.complete.units + 256 + 6 + keyUnits + key.length, B: 0 });
        let descriptor = Object.getOwnPropertyDescriptor(value, key);
        try {
          if (!descriptor || !Object.hasOwn(descriptor, "value")) throw identityFailure("protocol");
          visit!(descriptor.value, depth + 1, keyUnits + key.length);
        } finally { descriptor = undefined; }
      }
      value = undefined;
    };
    visit(input, 0, 0);
  } finally { visit = undefined; input = undefined as never; lease?.retire(); lease = undefined; ticket.leave("source"); }
}

// Private copy admission is distinct from JSON planning: enumerable own string
// properties with undefined values still create key/value cells in the temporary copy.
// No key vector or Symbol enumeration. The earlier JSON admission checked
// enumerable string descriptors; Symbol getters/payloads are never examined.
function fundAdmissionCopy(owner: AdmissionOwner, input: Record<string, unknown>,
  phase: ReturnType<typeof reserveAdmissionScratch>): void {
  admitBridgeCopyFactories();
  owner.ticket.enter("source");
  try {
    // Inner/outer carriers plus the seven-counter snapshot. Count BOTH owner
    // assignments conservatively even when they replace an existing input key.
    const vector = { C: 3, P: 22, N: 7,
      U: "admission".length + "source".length + "credentialId".length + owner.kid.length
        + "secretSha256".length + owner.digest.length
        + "bytes".length + "text".length + "values".length + "containers".length
        + "members".length + "entries".length + "units".length, B: 0 };
    phase.admit(vector);
    for (const key in input) if (Object.hasOwn(input, key)) {
      const value: unknown = input[key];
      vector.P += 2; vector.U += key.length;
      if (typeof value === "string") vector.U += value.length;
      else if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "function" || typeof value === "symbol") vector.N++;
      // Reference cells keep their already-admitted borrowed graphs under the
      // full ticket. No equality/interning credit is taken for string values.
      phase.admit(vector);
    }
  } finally { owner.ticket.leave("source"); }
}

async function runAdmission(owner: AdmissionOwner, input: Record<string, unknown>, signal?: AbortSignal): Promise<PrivateAdmissionHandle> {
  let body: string | undefined, init: RequestInit | undefined, request: unknown;
  let copied: Record<string, unknown> | undefined;
  let sent: IdentitySourceBudget | undefined, replySource: IdentitySourceBudget | undefined;
  let reply: AdmissionContinuationEnvelope<import("./authority-admission.ts").AdmissionResult> | null | undefined;
  let stub: DurableObjectStub | undefined, retained = false;
  // Source-proven Worker overlap includes outgoing text, reply wire/text/graph,
  // flattening and the current decoded chunk. This is an application component
  // bound, not a fabricated byte backing in PASSIVE_SCRATCH_DATA.
  const worker = admissionBridgePhasePayload.workerReply;
  let phase: ReturnType<typeof reserveAdmissionScratch> | undefined;
  try {
    phase = reserveAdmissionScratch(owner.ticket, worker.admittedRepresentations + worker.flatten + worker.decodedChunk,
      { C: 0, P: 0, N: 0, U: 0, B: 0 });
    fundAdmissionCopy(owner, input, phase);
    sent = identitySourceSnapshot(owner.source);
    // Visit original borrowed fields and the exact owner replacements BEFORE
    // constructing the inner copy or either outer carrier. Replacement keys
    // keep their original position; new keys append in object-literal order.
    const plan = identityPlan();
    plan.object(0, field => {
      field("admission", undefined, () => plan.object(1, member => {
        for (const key in input) if (Object.hasOwn(input, key)) member(key,
          key === "credentialId" ? owner.kid : key === "secretSha256" ? owner.digest : key === "snapshot" && owner.generationSnapshotOnly ? "only" : input[key]);
        if (!Object.prototype.propertyIsEnumerable.call(input, "credentialId")) member("credentialId", owner.kid);
        if (!Object.prototype.propertyIsEnumerable.call(input, "secretSha256")) member("secretSha256", owner.digest);
      }));
      field("source", sent);
    });
    owner.ticket.enter("source");
    try {
      // Ephemeral JSON staging only: preserve every enumerable own STRING field.
      // Null prototype keeps __proto__ as data without per-field descriptors.
      // Symbol keys have no JSON representation and are never enumerated/read.
      copied = Object.create(null) as Record<string, unknown>;
      for (const key in input) if (Object.hasOwn(input, key)) {
        const value = key === "snapshot" && owner.generationSnapshotOnly ? "only" : input[key];
        // JSON-omitted executable/opaque values never become passive borrowers.
        copied[key] = typeof value === "function" || typeof value === "symbol" ? undefined : value;
      }
      copied.credentialId = owner.kid; copied.secretSha256 = owner.digest;
      request = { admission: copied, source: sent };
    } finally { owner.ticket.leave("source"); }
    body = JSON.stringify(request); request = undefined; copied = undefined; input = undefined as never; owner.generationSnapshotOnly = undefined;
    init = { method: "POST", headers: { "content-type": "application/json", [admissionContinuationHeader]: admissionContinuationVersion }, body, signal, redirect: "manual" };
    stub = owner.binding.get(owner.binding.idFromName(owner.namespace));
    replySource = identitySourceBudget();
    reply = await consumeAdmissionBridge(owner.ticket, () => stub!.fetch(`https://authority${admissionContinuationPath}`, init), replySource, "complete", (value, response) => {
      if (!response?.ok) {
        const error = (value as { error?: { code?: unknown; message?: unknown } })?.error;
        if (response?.status === 503 && error?.code === "identity_admission_unavailable") {
          for (const kind of ["limit", "protocol", "transport", "cleanup"] as const) if (error.message === `Identity admission failed (${kind})`) throw identityFailure(kind);
          throw identityFailure("protocol");
        }
        throw new Error("Authority identity query failed");
      }
      const closed = closeAdmissionEnvelope<import("./authority-admission.ts").AdmissionResult>(value);
      admitAdmission(closed.admission);
      return closed;
    }, signal, undefined, "continuation");
    if (!reply) throw identityFailure("protocol");
    if (signal?.aborted) throw identityFailure("transport");
    advanceIdentitySource(owner.source, sent, reply.source, replySource);
    owner.admission = reply.admission;
    body = undefined; init = undefined; request = undefined; copied = undefined; reply = undefined; sent = undefined; replySource = undefined; stub = undefined; signal = undefined;
    // Full graph remains under the SAME 32 MiB ticket. No scalar shrink/GC credit.
    const handle = Object.freeze({ dispose: disposeAdmission });
    admissions.set(handle, owner); retained = true;
    return handle;
  } finally {
    body = undefined; init = undefined; request = undefined; copied = undefined; reply = undefined; sent = undefined; replySource = undefined; stub = undefined; signal = undefined; input = undefined as never;
    phase?.retire();
    if (!retained) { owner.admission = undefined; retireOwner(owner); }
  }
}

// The new index is deliberately unreachable from ordinary admission/cache APIs.
// Namespace policy-bindings and auth kind proxy-key are closed constants: a
// provider, digest, request or generation never creates another stable entry.
type GenerationRuntimeObservation = { value?: import("./types").GrantRuntimeState; lease: GenerationConsumptionLease };
type GenerationPartition = { binding: Authority; entries: Map<string, GenerationEntry>;
  funding: GenerationMetadataCharge; cache?: PrivateCacheReservation;
  runtime?: Map<string, Map<string | null, GenerationRuntimeObservation>>; runtimePending?: number; runtimeFunding?: GenerationConsumptionLease };
type GenerationEntry = { partition: GenerationPartition; kid: string; first?: GenerationSlot;
  second?: GenerationSlot; current?: GenerationSlot; sequence: number; publishedSequence: number; funding: GenerationMetadataCharge; cache?: PrivateCacheReservation };
type GenerationSlot = { entry: GenerationEntry; owner: AdmissionOwner; continuation?: CredentialPreflightContinuation;
  handle?: PrivateAdmissionHandle; ready: boolean; published: boolean; borrowers: number; sequence: number; storedAt: number; maxAgeMs: number;
  funding: GenerationMetadataCharge; initialBorrowFunding?: GenerationMetadataCharge; cache?: PrivateCacheReservation; graphCache?: PrivateCacheReservation;
  temporaryCharge?: GenerationRetainedCharge; advisory?: GenerationAdvisoryState; feedback?: Map<string, GenerationPendingFeedback>; counters?: Map<string, GenerationPendingCount>; countCursor?: Map<string, GenerationPendingCount>; coverage?: { value: GenerationCoverage; funding: GenerationMetadataCharge; cache?: PrivateCacheReservation; initialBorrow?: IdentityGenerationBorrow } };
type GenerationBorrower = { slot: GenerationSlot; funding: GenerationMetadataCharge; cache?: PrivateCacheReservation };
type GenerationRegistry = { partitions: WeakMap<Authority, GenerationPartition>;
  preparations: WeakMap<IdentityGenerationPreparation, GenerationSlot>; borrowers: WeakMap<IdentityGenerationBorrow, GenerationBorrower>;
  count: number; funding: GenerationMetadataCharge; cache?: PrivateCacheReservation };
let generationRegistry: GenerationRegistry | undefined;
function retireGenerationRegistry(): void {
  if (generationRegistry?.count !== 0) return;
  const registry = generationRegistry; generationRegistry = undefined;
  registry.partitions = undefined as never; registry.preparations = undefined as never; registry.borrowers = undefined as never;
  registry.cache?.release(); registry.cache = undefined; registry.funding.release();
}

function generationFunding(kind: keyof typeof generationMetadata, stringUnits = 0): GenerationMetadataCharge {
  const layout = generationMetadata[kind], funding = generationMetadata.funding;
  return GenerationMetadataCharge.reserve(layout.payload + funding.payload + 2 * stringUnits, layout.structure + funding.structure);
}
function retireGenerationEntry(entry: GenerationEntry): void {
  if (entry.first || entry.second) return;
  const partition = entry.partition;
  partition.entries.delete(entry.kid); entry.kid = "";
  entry.partition = undefined as never;
  entry.cache?.release(); entry.cache = undefined; entry.funding.release();
  if (!partition.entries.size) {
    generationRegistry!.partitions.delete(partition.binding); partition.binding = undefined as never;
    partition.entries = undefined as never;
    const failures: unknown[] = [];
    if (partition.runtime) for (const entry of partition.runtime) {
      let key: string | undefined = entry[0]; const versions = entry[1];
      entry.pop(); entry.pop(); partition.runtime.delete(key); key = undefined;
      for (const pair of versions) {
        let revision: string | null | undefined = pair[0], observation: GenerationRuntimeObservation | undefined = pair[1];
        pair.pop(); pair.pop(); versions.delete(revision); revision = undefined;
        observation.value = undefined; const charge = observation.lease; observation = undefined;
        try { charge.release(); } catch (error) { failures.push(error); }
      }
    }
    partition.runtime?.clear(); partition.runtime = undefined; partition.runtimePending = undefined;
    const runtimeFunding = partition.runtimeFunding; partition.runtimeFunding = undefined;
    try { runtimeFunding?.release(); } catch (error) { failures.push(error); }
    const cache = partition.cache; partition.cache = undefined;
    try { cache?.release(); } catch (error) { failures.push(error); }
    try { partition.funding.release(); } catch (error) { failures.push(error); }
    generationRegistry!.count--;
    try { retireGenerationRegistry(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "generation authority observations retirement");
  }
}
function retireGenerationSlot(slot: GenerationSlot): void {
  if (!slot.owner) return;
  if (slot.published || slot.borrowers) return;
  // A failed/unknown original operation cannot retire its slot just because an
  // error was observed. The source owner's actual ticket remains the authority.
  if (!slot.ready && slot.owner.ticket.bytes) return;
  const entry = slot.entry;
  if (slot.coverage) { const coverage = slot.coverage; slot.coverage = undefined; coverage.value = undefined as never; coverage.cache?.release(); coverage.cache = undefined; coverage.funding.release(); }
  slot.advisory?.dispose(); slot.advisory = undefined;
  slot.owner.admission = undefined;
  slot.handle = undefined; slot.continuation = undefined;
  retireOwner(slot.owner);
  slot.owner.source = undefined as never; slot.owner.ticket = undefined as never; slot.owner = undefined as never;
  slot.initialBorrowFunding?.release(); slot.initialBorrowFunding = undefined;
  slot.graphCache?.release(); slot.graphCache = undefined;
  slot.temporaryCharge?.release(); slot.temporaryCharge = undefined;
  slot.cache?.release(); slot.cache = undefined; slot.funding.release();
  if (entry.first === slot) entry.first = undefined;
  if (entry.second === slot) entry.second = undefined;
  if (entry.current === slot) entry.current = undefined;
  slot.entry = undefined as never;
  retireGenerationEntry(entry);
}
function disposeGenerationPreparation(this: IdentityGenerationPreparation): void {
  const slot = generationRegistry?.preparations.get(this);
  if (!slot) throw identityFailure("protocol");
  generationRegistry!.preparations.delete(this);
  if (slot.continuation) releaseCredentialPreflightContinuation(slot.continuation);
  slot.continuation = undefined; retireGenerationSlot(slot);
}

export function prepareCredentialGeneration(proof: CredentialPreflightProof): IdentityGenerationPreparation {
  const owner = proofs.get(proof);
  if (!owner || owner.namespace !== credentialPreflightNamespace) throw identityFailure("protocol");
  admitGenerationFactories();
  let partition = generationRegistry?.partitions.get(owner.binding), entry = partition?.entries.get(owner.kid);
  if (entry?.first && entry.second) throw identityFailure("limit");
  // Every index/product has real prospective small funding BEFORE its factory.
  // Any failure here leaves the genuine proof registered and releasable.
  let slotFunding: GenerationMetadataCharge | undefined;
  let initialBorrowFunding: GenerationMetadataCharge | undefined;
  try {
    if (!generationRegistry) {
      const funding = generationFunding("registry");
      generationRegistry = { partitions: new WeakMap(), preparations: new WeakMap(), borrowers: new WeakMap(), count: 0, funding };
    }
    if (!partition) {
      const funding = generationFunding("partition");
      partition = { binding: owner.binding, entries: new Map(), funding };
      generationRegistry!.partitions.set(owner.binding, partition); generationRegistry.count++;
    }
    if (!entry) {
      const funding = generationFunding("entry", 2 * owner.kid.length);
      entry = { partition, kid: owner.kid, sequence: 0, publishedSequence: 0, funding }; partition.entries.set(owner.kid, entry);
    }
    if (!Number.isSafeInteger(entry.sequence + 1)) throw identityFailure("limit");
    slotFunding = generationFunding("slot", owner.kid.length + owner.digest.length + owner.namespace.length);
    initialBorrowFunding = generationFunding("borrower");
    // Expansion is atomic and precedes consuming proof. Shared-cache vector
    // pressure is NOT a prerequisite for full hydration.
    owner.ticket.expandForContinuation();
    owner.ticket.retainGenerationComponent(generationRegistry.funding.bytes + partition.funding.bytes
      + entry.funding.bytes + slotFunding.bytes + initialBorrowFunding.bytes);
    const continuation = Object.freeze({});
    const slot: GenerationSlot = { entry, owner, continuation, ready: false, published: false, borrowers: 0,
      sequence: ++entry.sequence, storedAt: hotCacheNow(), maxAgeMs: 0, funding: slotFunding, initialBorrowFunding };
    const preparation = Object.freeze({ dispose: disposeGenerationPreparation });
    if (!entry.first) entry.first = slot; else entry.second = slot;
    continuations.set(continuation, owner); generationRegistry!.preparations.set(preparation, slot); proofs.delete(proof);
    return preparation;
  } catch (error) {
    initialBorrowFunding?.release(); slotFunding?.release();
    if (entry) retireGenerationEntry(entry);
    else if (partition && !partition.entries.size) { generationRegistry!.partitions.delete(owner.binding); partition.funding.release(); generationRegistry!.count--; }
    retireGenerationRegistry();
    throw error;
  }
}

function disposeGenerationBorrow(this: IdentityGenerationBorrow): void {
  const borrower = generationRegistry?.borrowers.get(this);
  if (!borrower) throw identityFailure("protocol");
  generationRegistry!.borrowers.delete(this);
  const slot = borrower.slot;
  if (slot.coverage?.initialBorrow === this) slot.coverage.initialBorrow = undefined;
  borrower.slot = undefined as never;
  borrower.cache?.release(); borrower.cache = undefined; borrower.funding.release();
  slot.borrowers--; retireGenerationSlot(slot);
}
function newGenerationBorrow(slot: GenerationSlot): IdentityGenerationBorrow {
  const funding = slot.initialBorrowFunding ?? generationFunding("borrower");
  slot.initialBorrowFunding = undefined;
  let cache: PrivateCacheReservation | undefined;
  try {
    if (slot.graphCache) {
      cache = PrivateCacheReservation.adoptMetadata(funding) ?? undefined;
      if (!cache) {
        // Optional metadata pressure cannot reject a matching hit. Expand the
        // SAME graph owner before removing publication; all old borrows survive.
        // A refusal here is actual common-arena/UNKNOWN pressure, not cache fit.
        const temporary = slot.graphCache.demoteForBorrow();
        if (!temporary) throw identityFailure("limit");
        slot.temporaryCharge = temporary; slot.graphCache = undefined;
        slot.published = false;
        if (slot.entry.current === slot) slot.entry.current = undefined;
      }
    }
    const borrower = { slot, funding, cache }, handle = Object.freeze({ dispose: disposeGenerationBorrow });
    generationRegistry!.borrowers.set(handle, borrower); slot.borrowers++;
    return handle;
  } catch (error) { cache?.release(); funding.release(); throw error; }
}

function promoteGeneration(slot: GenerationSlot, borrower: GenerationBorrower, vector: ReturnType<typeof measureGenerationGraph>): boolean {
  const entry = slot.entry, partition = entry.partition, registry = generationRegistry!;
  // Publication history belongs to the stable entry, not to its current value.
  // Eviction/expiry can clear current while a newer borrowed generation lives.
  if (entry.publishedSequence > slot.sequence) return false;
  let registryReceipt: PrivateCacheReservation | undefined;
  let partitionReceipt: PrivateCacheReservation | undefined, entryReceipt: PrivateCacheReservation | undefined;
  let slotReceipt: PrivateCacheReservation | undefined, borrowerReceipt: PrivateCacheReservation | undefined;
  let graphReceipt: PrivateCacheReservation | undefined, coverageReceipt: PrivateCacheReservation | undefined, committed = false;
  try {
    if (!registry.cache) { registryReceipt = PrivateCacheReservation.adoptMetadata(registry.funding) ?? undefined; if (!registryReceipt) return false; }
    if (!partition.cache) { partitionReceipt = PrivateCacheReservation.adoptMetadata(partition.funding) ?? undefined; if (!partitionReceipt) return false; }
    if (!entry.cache) { entryReceipt = PrivateCacheReservation.adoptMetadata(entry.funding) ?? undefined; if (!entryReceipt) return false; }
    slotReceipt = PrivateCacheReservation.adoptMetadata(slot.funding) ?? undefined; if (!slotReceipt) return false;
    borrowerReceipt = PrivateCacheReservation.adoptMetadata(borrower.funding) ?? undefined; if (!borrowerReceipt) return false;
    if (slot.coverage) { coverageReceipt = PrivateCacheReservation.adoptMetadata(slot.coverage.funding) ?? undefined; if (!coverageReceipt) return false; }
    if (!slot.owner.ticket.generationReady) throw identityFailure("protocol");
    graphReceipt = PrivateCacheReservation.transfer(vector, slot.owner.ticket) ?? undefined; if (!graphReceipt) return false;
    // Destination credit precedes publication and source-credit retirement.
    // There is no await, graph clone, callback or release/reacquire interval.
    registry.cache ??= registryReceipt; partition.cache ??= partitionReceipt; entry.cache ??= entryReceipt;
    slot.cache = slotReceipt; borrower.cache = borrowerReceipt; slot.graphCache = graphReceipt;
    if (slot.coverage) slot.coverage.cache = coverageReceipt;
    const previous = entry.current;
    entry.current = slot; entry.publishedSequence = slot.sequence; slot.published = true; committed = true;
    if (previous && previous !== slot) { previous.published = false; retireGenerationSlot(previous); }
    return true;
  } finally {
    if (!committed) { graphReceipt?.release(); coverageReceipt?.release(); borrowerReceipt?.release(); slotReceipt?.release(); entryReceipt?.release(); partitionReceipt?.release(); registryReceipt?.release(); }
  }
}

export function completeCredentialGeneration(preparation: IdentityGenerationPreparation,
  input: Parameters<typeof completeCredentialAdmission>[1], config: HotCacheConfig, signal?: AbortSignal): Promise<IdentityGenerationBorrow> {
  const slot = generationRegistry?.preparations.get(preparation);
  if (!slot || !slot.continuation || !Number.isFinite(config.maxAgeMs) || config.maxAgeMs < 0 || config.maxAgeMs > 3_600_000) throw identityFailure("protocol");
  generationRegistry!.preparations.delete(preparation);
  slot.maxAgeMs = config.maxAgeMs;
  const operation = runGeneration(slot, input, signal);
  void operation.then(() => undefined, () => undefined);
  return operation;
}
async function runGeneration(slot: GenerationSlot, input: Parameters<typeof completeCredentialAdmission>[1], signal?: AbortSignal): Promise<IdentityGenerationBorrow> {
  let handle: PrivateAdmissionHandle | undefined, borrow: IdentityGenerationBorrow | undefined;
  let traversal: ReturnType<typeof reserveAdmissionScratch> | undefined;
  try {
    handle = await completeCredentialAdmission(slot.continuation!, input, signal);
    // completeCredentialAdmission's finally and ORIGINAL joins have completed.
    slot.continuation = undefined; slot.handle = handle;
    if (admissions.get(handle) !== slot.owner || !slot.owner.ticket.generationReady) throw identityFailure("protocol");
    if (signal?.aborted) throw identityFailure("transport");
    input = undefined as never; signal = undefined;
    // The reply is an ordinary parsed JSON tree. Its whole profile and scalar
    // fields stay funded; bounded traversal scratch is admitted BEFORE visiting.
    traversal = reserveAdmissionScratch(slot.owner.ticket, 21020672,
      { C: 1, P: 0, N: 80, U: 24 * 1024 + 64, B: 0 });
    const vector = measureGenerationGraph(slot.owner.admission);
    freezeGenerationGraph(slot.owner.admission);
    traversal.retire(); traversal = undefined;
    slot.ready = true;
    // No raw getter, callback, graph clone, serializer hook or new source prefix.
    borrow = newGenerationBorrow(slot);
    if (slot.coverage?.value.snapshot === "select" && slot.owner.admission!.selection !== undefined)
      slot.coverage.initialBorrow = borrow;
    admissions.delete(handle); slot.handle = undefined; handle = undefined;
    if (slot.maxAgeMs && generationCredentialMatches(slot, slot.owner.digest)) promoteGeneration(slot, generationRegistry?.borrowers.get(borrow)!, vector);
    const result = borrow; borrow = undefined; return result;
  } finally {
    input = undefined as never; signal = undefined;
    traversal?.retire();
    if (borrow) borrow.dispose();
    if (handle && admissions.has(handle)) { handle.dispose(); slot.handle = undefined; }
    if (slot.continuation && continuations.has(slot.continuation)) releaseCredentialPreflightContinuation(slot.continuation);
    slot.continuation = undefined;
    retireGenerationSlot(slot);
  }
}
function generationCredentialMatches(slot: GenerationSlot, digest: string): boolean {
  const admission = slot.owner.admission, credential = admission?.credential?.credential;
  return !!credential && credential.enabled && !credentialExpired(credential)
    && safeEqual(credential.secretSha256, digest) && !!admission?.policy?.policy.enabled
    && credential.policyGeneration === admission.policy.policy.generation
    && !admission.policyUnavailable && !admission.ownerUnavailable && !admission.connectionsUnavailable
    && (credential.principalId == null || admission.owner?.record.enabled === true);
}

// A permitted hit only verifies/borrows this immutable snapshot; it is not a new
// authentication result and never performs an RPC. Future adapters must retain
// the borrow for every use/background obligation. OFF still counts live slots.
export function borrowCredentialGeneration(env: Pick<Env, "ACCESS_CONTROL">, kid: string, digest: string,
  config: HotCacheConfig): IdentityGenerationBorrow | undefined {
  checkPreflightIdentity(kid, digest);
  if (!env.ACCESS_CONTROL || !config.maxAgeMs) return undefined;
  const entry = generationRegistry?.partitions.get(env.ACCESS_CONTROL)?.entries.get(kid), slot = entry?.current;
  if (!slot || !slot.ready || !slot.published) return undefined;
  const now = hotCacheNow();
  if (now < slot.storedAt || now - slot.storedAt >= Math.min(config.maxAgeMs, slot.maxAgeMs)) {
    slot.published = false; entry!.current = undefined; retireGenerationSlot(slot); return undefined;
  }
  if (!safeEqual(slot.owner.digest, digest) || !generationCredentialMatches(slot, digest)) return undefined;
  admitGenerationFactories();
  return newGenerationBorrow(slot);
}
export function evictCredentialGeneration(env: Pick<Env, "ACCESS_CONTROL">, kid: string): void {
  const entry = env.ACCESS_CONTROL && generationRegistry?.partitions.get(env.ACCESS_CONTROL)?.entries.get(kid), slot = entry?.current;
  if (!entry || !slot) return;
  entry.current = undefined; slot.published = false; retireGenerationSlot(slot);
}

// NEW consumption route only. The old generation entrypoint deliberately gains
// no inferred coverage. Failed prevalidation leaves its preparation releasable.
export function completeConsumableCredentialGeneration(preparation: IdentityGenerationPreparation,
  input: Parameters<typeof completeCredentialAdmission>[1], config: HotCacheConfig, signal?: AbortSignal): Promise<IdentityGenerationBorrow> {
  admitGenerationConsumptionFactories();
  const slot = generationRegistry?.preparations.get(preparation);
  if (!slot || slot.coverage) throw identityFailure("protocol");
  const frame = GenerationConsumptionLease.reserve(4096);
  let funding: GenerationMetadataCharge | undefined;
  try {
    admitIdentity(input); guardAdmissionSerialization(slot.owner, input);
    const borrowed: GenerationCoverage = { providers: input.providers ?? [], allConnections: input.allConnections === true,
      snapshot: input.snapshot, selection: input.selection };
    const layout = generationCoverageLayout(borrowed), owner = generationMetadata.funding;
    funding = GenerationMetadataCharge.reserve(layout.bytes + owner.payload, layout.fields + owner.structure);
    const value = copyGenerationCoverage(borrowed);
    slot.coverage = { value, funding }; funding = undefined;
    // Pending observations may make the authority's otherwise-valid choice
    // locally ineligible. Preserve the ordinary snapshot-only deferral without
    // copying the caller graph or changing any ordinary admission entrypoint.
    slot.owner.generationSnapshotOnly = input.snapshot === "select" && !!input.selection && (slot.entry.partition.runtimePending ?? 0) > 0;
    return completeCredentialGeneration(preparation, input, config, signal);
  } catch (error) {
    if (slot.coverage) { const coverage = slot.coverage; slot.coverage = undefined; coverage.value = undefined as never; coverage.funding.release(); }
    throw error;
  } finally { funding?.release(); frame.release(); }
}

type GenerationAuthenticationOwner = {
  slot: GenerationSlot; parent: IdentityGenerationBorrow; lease: GenerationConsumptionLease;
  identity?: import("./types").AuthorizedIdentity; failure?: import("./utils.ts").HttpError;
  children: number; closed: boolean; initialSelection: boolean;
};
// The registry is lazy and its owner is charged before the WeakMap factory.
let generationAuthentications: WeakMap<GenerationAuthentication, GenerationAuthenticationOwner> | undefined;
let generationAuthenticationRegistryCharge: GenerationConsumptionLease | undefined;
let generationAuthenticationCount = 0;
function authenticationOwner(handle: GenerationAuthentication): GenerationAuthenticationOwner {
  const owner = generationAuthentications?.get(handle);
  if (!owner || owner.closed) throw identityFailure("protocol");
  return owner;
}
function generationAuthenticationStatus(this: GenerationAuthentication): number { return authenticationOwner(this).failure?.status ?? 200; }
function generationAuthenticationCode(this: GenerationAuthentication): string | undefined { return authenticationOwner(this).failure?.code; }
function retireAuthentication(owner: GenerationAuthenticationOwner): void {
  if (!owner.closed || owner.children) return;
  owner.identity = undefined; owner.failure = undefined; owner.slot = undefined as never;
  const parent = owner.parent; owner.parent = undefined as never;
  const failures: unknown[] = [];
  try { parent.dispose(); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  if (!--generationAuthenticationCount) {
    generationAuthentications = undefined;
    const charge = generationAuthenticationRegistryCharge; generationAuthenticationRegistryCharge = undefined;
    try { charge?.release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "generation authentication retirement");
}
function disposeGenerationAuthentication(this: GenerationAuthentication): void {
  const owner = authenticationOwner(this);
  generationAuthentications!.delete(this); owner.closed = true; retireAuthentication(owner);
}

// The trusted digest/binding/kid come ONLY from the actual generation owner.
// A request's facets are compared against its admitted coverage, never inferred
// from an absent pool/selection or from the stable index key.
export function authenticateCredentialGeneration(borrow: IdentityGenerationBorrow, env: Pick<Env, "ACCESS_CONTROL">,
  required: GenerationCoverage): GenerationAuthentication {
  return createGenerationAuthentication(borrow, env, required);
}
function createGenerationAuthentication(borrow: IdentityGenerationBorrow, env: Pick<Env, "ACCESS_CONTROL">,
  required: GenerationCoverage, refreshFrom?: GenerationAuthenticationOwner): GenerationAuthentication {
  admitGenerationConsumptionFactories();
  const sourceBorrower = generationRegistry?.borrowers.get(borrow), slot = sourceBorrower?.slot;
  if (!slot?.ready || !slot.coverage || slot.owner.binding !== env.ACCESS_CONTROL) throw identityFailure("protocol");
  const frame = GenerationConsumptionLease.reserve(4096);
  let lease: GenerationConsumptionLease | undefined, parent: IdentityGenerationBorrow | undefined;
  let hasPrimary = false, primary: unknown;
  try {
    admitIdentity(required); generationCoverageLayout(required);
    if (!sameGenerationCoverage(slot.coverage.value, required)) throw identityFailure("protocol");
    const admission = slot.owner.admission!;
    // The base graph remains funded by the separately owned parent. Account a
    // conservative complete policy/identity copy BEFORE effective-policy work.
    const plan = identityPlan(); plan.item(admission, 0);
    const counts = plan.counts;
    const bytes = 4096 + 8 * (counts.containers + 2 * counts.members + counts.entries + counts.values) + 2 * counts.units;
    lease = GenerationConsumptionLease.reserve(bytes);
    parent = newGenerationBorrow(slot);
    if (refreshFrom && (refreshFrom.slot.owner.binding !== slot.owner.binding || refreshFrom.slot.owner.kid !== slot.owner.kid || !required.selection)) throw identityFailure("protocol");
    const failure = ownedGenerationCredentialFailure(admission, refreshFrom?.slot.owner.digest ?? slot.owner.digest, refreshFrom ? required.selection : undefined);
    let identity: import("./types").AuthorizedIdentity | undefined;
    if (!failure) {
      const credential = admission.credential!.credential, policy = admission.policy!, principal = admission.owner;
      identity = { serviceTiers: credential.serviceTiers, credentialId: slot.owner.kid, principalId: credential.principalId ?? null,
        authType: "proxy_key", policyId: credential.policyId,
        policy: admittedEffectivePolicy(credential.policyId, policy.policy, principal?.record.budgetOverrides),
        contentRetentionDisabled: refreshFrom ? refreshFrom.identity!.contentRetentionDisabled : principal?.record.contentRetentionDisabled ?? false };
      admitIdentity(identity);
    }
    if (!generationAuthentications) {
      generationAuthenticationRegistryCharge = GenerationConsumptionLease.reserve(512);
      generationAuthentications = new WeakMap();
    }
    const owner: GenerationAuthenticationOwner = { slot, parent, lease, identity, failure: failure ?? undefined, children: 0, closed: false,
      initialSelection: slot.coverage.initialBorrow === borrow };
    const handle = Object.freeze({ dispose: disposeGenerationAuthentication, status: generationAuthenticationStatus, code: generationAuthenticationCode });
    generationAuthentications.set(handle, owner); generationAuthenticationCount++;
    if (slot.coverage.initialBorrow === borrow) slot.coverage.initialBorrow = undefined;
    parent = undefined; lease = undefined; return handle;
  } catch (error) { hasPrimary = true; primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try { parent?.dispose(); } catch (error) { failures.push(error); }
    try { lease?.release(); } catch (error) { failures.push(error); }
    try { frame.release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "generation authentication cleanup");
  }
}

interface GenerationSelectionOwner {
  auth: GenerationAuthenticationOwner; lease: GenerationConsumptionLease;
  result?: import("./grant-eligibility.ts").GrantSelectionResult; users: number;
  prefetchProvider?: (typeof providerSnapshot.providers)[number]; destination?: OwnedCredentialBorrow;
}
export interface GenerationSelectionHandle {
  dispose(): void;
  selected(): boolean;
  matchesKey(key: string): boolean;
  hasConfiguredGrant(): boolean;
  readonly flush: GenerationFlushReceipt;
}
let generationSelections: WeakMap<GenerationSelectionHandle, GenerationSelectionOwner> | undefined;
let generationSelectionRegistryCharge: GenerationConsumptionLease | undefined;
let generationSelectionCount = 0;
function selectedOwner(handle: GenerationSelectionHandle): GenerationSelectionOwner {
  const value = generationSelections?.get(handle);
  if (!value) throw identityFailure("protocol");
  return value;
}
function releaseGenerationSelection(owner: GenerationSelectionOwner): void {
  if (--owner.users) return;
  owner.result = undefined; owner.prefetchProvider = undefined;
  const destination = owner.destination; owner.destination = undefined;
  const auth = owner.auth; owner.auth = undefined as never;
  const failures: unknown[] = [];
  try { destination?.dispose(); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  auth.children--;
  try { retireAuthentication(auth); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "generation selection retirement");
}
function disposeGenerationSelection(this: GenerationSelectionHandle): void {
  const owner = selectedOwner(this); generationSelections!.delete(this);
  const failures: unknown[] = [];
  try { releaseGenerationSelection(owner); } catch (error) { failures.push(error); }
  if (!--generationSelectionCount) {
    generationSelections = undefined;
    const charge = generationSelectionRegistryCharge; generationSelectionRegistryCharge = undefined;
    try { charge?.release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "generation selection handle cleanup");
}
function generationSelected(this: GenerationSelectionHandle): boolean { return !!selectedOwner(this).result!.selected; }
function generationSelectedKey(this: GenerationSelectionHandle, key: string): boolean { return selectedOwner(this).result!.selected?.key === key; }
function generationConfigured(this: GenerationSelectionHandle): boolean { return selectedOwner(this).result!.hasConfiguredGrant; }

function selectionCovered(coverage: GenerationCoverage, request: import("./authority-admission.ts").AdmissionSelection): boolean {
  const source = coverage.selection;
  return !!source && !!coverage.snapshot && source.providerId === request.providerId && source.endpointId === request.endpointId
    && source.mode === request.mode && source.model === request.model && source.catalogModelId === request.catalogModelId
    && source.capability === request.capability && source.sessionHash === request.sessionHash;
}
function generationSelectionPayload(value: unknown): number {
  const plan = identityPlan(); plan.item(value, 0);
  const counts = plan.counts;
  return 4096 + 8 * (counts.containers + 2 * counts.members + counts.entries + counts.values) + 2 * counts.units;
}
export function selectCredentialGeneration(handle: GenerationAuthentication, env: Env,
  request: import("./authority-admission.ts").AdmissionSelection): GenerationSelectionHandle | undefined {
  admitGenerationConsumptionFactories();
  const auth = authenticationOwner(handle), slot = auth.slot;
  if (auth.failure) throw auth.failure;
  if (slot.owner.binding !== env.ACCESS_CONTROL || !selectionCovered(slot.coverage!.value, request)) throw identityFailure("protocol");
  const frame = GenerationConsumptionLease.reserve(4096);
  let work: GenerationConsumptionLease | undefined, resultLease: GenerationConsumptionLease | undefined;
  let created: GenerationAdvisoryState | undefined, pending: GenerationPendingCount | undefined, flush: GenerationFlushOwner | undefined;
  let unpublished: GenerationSelectionHandle | undefined;
  let runtimeView: ReturnType<typeof generationRuntimeView> | undefined;
  let overlay: GenerationAdvisoryState | undefined, debit: import("./admission-cache.ts").GenerationSelectionDebit | undefined;
  let hasPrimary = false, primary: unknown;
  try {
    admitIdentity(request);
    const base = generationSelectionWorkingBytes(slot.owner.admission!, request);
    work = GenerationConsumptionLease.reserve(base);
    overlay = slot.advisory ?? (created = GenerationAdvisoryState.create());
    runtimeView = generationRuntimeView(slot, request.providerId);
    const planned = planGenerationSelection(env, slot.owner.admission!, overlay, request, (vector, run) => {
      work!.replace(base + admissionScratchBytes(vector));
      try { return run(); } finally { work!.replace(base); }
    }, auth.initialSelection ? slot.owner.admission!.selection : undefined, runtimeView.values);
    if (!planned) return undefined;
    admitIdentity(planned.result.selected, "record");
    resultLease = GenerationConsumptionLease.reserve(generationSelectionPayload(planned.result));
    const result = planned.result.selected ? { ...planned.result, selected: copyIdentity(planned.result.selected) } : { ...planned.result };
    freezeGenerationGraph(result);
    // Both final copy admission and the complete prospective advisory update
    // precede the first counter/cursor mutation. No authority writes occur here.
    admitGenerationOverlay(slot.owner.admission!, overlay, planned, undefined, runtimeView.values);
    debit = overlay.admitSelection(planned);
    if (planned.selectedKey) { pending = prepareGenerationCount(slot, planned); flush = newGenerationFlush(slot, env, pending, undefined, true); }
    if (!generationSelections) {
      generationSelectionRegistryCharge = GenerationConsumptionLease.reserve(512); generationSelections = new WeakMap();
    }
    const provider = providerSnapshot.providers.find(item => item.id === request.providerId);
    const prefetchProvider = !request.excludedKeys?.length && !request.pinnedKey && provider && provider.id !== "anthropic-vertex"
      && !(provider.id === "minimax" && provider.endpoints.some(endpoint => endpoint.id === request.endpointId
        && (endpoint.request_format === "minimax.images" || endpoint.request_format === "minimax.music"))) ? provider : undefined;
    const owner: GenerationSelectionOwner = { auth, lease: resultLease, result, users: 1, prefetchProvider };
    // The operation's receipt belongs to THIS caller/request, not to the shared
    // generation slot. It exposes no data graph and is never used by hints.
    const selectedRecord = { dispose: disposeGenerationSelection, selected: generationSelected, matchesKey: generationSelectedKey,
      hasConfiguredGrant: generationConfigured, flush: generationFlushRejected as GenerationFlushReceipt };
    const selected: GenerationSelectionHandle = selectedRecord;
    generationSelections.set(selected, owner); generationSelectionCount++; auth.children++;
    unpublished = selected; resultLease = undefined;
    slot.advisory = overlay; created = undefined;
    overlay.commitSelection(planned, debit); auth.initialSelection = false;
    if (pending) { commitGenerationCount(slot, pending); pending = undefined; }
    if (flush) { selectedRecord.flush = commitGenerationSchedule(flush); flush = undefined; }
    Object.freeze(selected); unpublished = undefined; return selected;
  } catch (error) { hasPrimary = true; primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try { unpublished?.dispose(); } catch (error) { failures.push(error); }
    try { if (flush && !flush.started) abandonGenerationFlush(flush); } catch (error) { failures.push(error); }
    try { if (pending) releaseGenerationCount(pending); } catch (error) { failures.push(error); }
    try { resultLease?.release(); } catch (error) { failures.push(error); }
    try { if (runtimeView) { runtimeView.values = undefined as never; runtimeView.lease.release(); } } catch (error) { failures.push(error); }
    try { if (overlay && debit) overlay.rollbackSelection(debit); } catch (error) { failures.push(error); }
    try { created?.dispose(); } catch (error) { failures.push(error); }
    try { work?.release(); } catch (error) { failures.push(error); }
    try { frame.release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "generation selection cleanup");
  }
}

// An authority partition owns detached observations independently of any
// predecessor's counts/cursor. Revision keys isolate rotated grants. No view
// contains a foreign original promise or borrows an unowned mutable graph.
function generationRuntimeView(slot: GenerationSlot, providerId: string): { values: Record<string, import("./types").GrantRuntimeState>; lease: GenerationConsumptionLease } {
  const lease = GenerationConsumptionLease.reserve(4096);
  let values: Record<string, import("./types").GrantRuntimeState> | undefined;
  try {
    values = Object.create(null); let retained = 4096;
    const pool = slot.owner.admission!.pools[providerId], snapshot = slot.owner.admission!.snapshots?.[providerId];
    for (const candidate of snapshot?.candidates ?? []) {
      if (!candidate.grant) continue;
      const observation = slot.entry.partition.runtime?.get(candidate.key)?.get(grantRevision(candidate.grant));
      if (!observation?.value) continue;
      const bytes = generationRuntimeWorkingBytes(pool?.states[candidate.key], observation.value) + 4 * candidate.key.length + 128;
      lease.replace(retained + bytes);
      values![candidate.key] = detachedGenerationRuntime(pool?.states[candidate.key], observation.value);
      retained += bytes;
    }
    return { values: values!, lease };
  } catch (primary) { values = undefined; try { lease.release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "generation runtime view"); } throw primary; }
}

interface GenerationPendingFeedback {
  key: string; value?: import("./types").GrantRuntimeState; lease: GenerationConsumptionLease;
  parent: IdentityGenerationBorrow; inflight: boolean; claim?: GenerationFlushOwner;
  partition: GenerationPartition; published: boolean;
}
// A pending value's owner survives publication eviction. Replacing it during an
// original write does not retire that original write's copy or replay its work.
function releaseGenerationFeedback(record: GenerationPendingFeedback): void {
  record.value = undefined; record.key = ""; record.claim = undefined;
  if (record.published) { record.partition.runtimePending = (record.partition.runtimePending ?? 0) - 1; record.published = false; }
  record.partition = undefined as never;
  const parent = record.parent; record.parent = undefined as never;
  const failures: unknown[] = [];
  try { parent.dispose(); } catch (error) { failures.push(error); }
  try { record.lease.release(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "generation pending record cleanup");
}
export function queueCredentialGenerationRuntime(handle: GenerationAuthentication, key: string,
  incoming: import("./types").GrantRuntimeState): GenerationFlushReceipt {
  admitGenerationConsumptionFactories();
  const auth = authenticationOwner(handle), slot = auth.slot;
  if (auth.failure) throw auth.failure;
  let covered = false;
  for (const provider of slot.coverage!.value.providers) if (slot.owner.admission!.pools[provider.id]?.keys.includes(key)) covered = true;
  if (!covered) throw identityFailure("protocol");
  const frame = GenerationConsumptionLease.reserve(4096);
  let work: GenerationConsumptionLease | undefined, held: GenerationConsumptionLease | undefined;
  let runtimeRegistry: GenerationConsumptionLease | undefined;
  let pendingLease: GenerationConsumptionLease | undefined, parent: IdentityGenerationBorrow | undefined, created: GenerationAdvisoryState | undefined, flush: GenerationFlushOwner | undefined;
  let hasPrimary = false, primary: unknown;
  try {
    admitIdentity(incoming, "record");
    const overlay = slot.advisory ?? (created = GenerationAdvisoryState.create());
    const partition = slot.entry.partition, revision = incoming.grantRevision ?? null;
    if (!partition.runtimeFunding) runtimeRegistry = GenerationConsumptionLease.reserve(512);
    let previousShared = partition.runtime?.get(key)?.get(revision);
    let previous = previousShared?.value;
    if (!previous) for (const provider of slot.coverage!.value.providers) {
      const pool = slot.owner.admission!.pools[provider.id];
      if (pool?.keys.includes(key)) { previous = pool.states[key]; break; }
    }
    const prior = slot.feedback?.get(key);
    const localBytes = generationRuntimeWorkingBytes(previous, incoming);
    const pendingBytes = generationRuntimeWorkingBytes(prior?.value, incoming);
    work = GenerationConsumptionLease.reserve(Math.max(localBytes, pendingBytes));
    // Reserve the full detached result and map/owner cells prospectively. This
    // stays independently backed after transient merge arrays have retired.
    held = GenerationConsumptionLease.reserve(localBytes + 4 * key.length + 4 * (revision?.length ?? 0) + 1024);
    pendingLease = GenerationConsumptionLease.reserve(pendingBytes + 4 * key.length + 512);
    parent = newGenerationBorrow(slot);
    const value = detachedGenerationRuntime(previous, incoming);
    admitGenerationOverlay(slot.owner.admission!, overlay, undefined, { key, value });
    const pendingValue = detachedGenerationFeedback(prior?.value, incoming);
    freezeGenerationGraph(value); freezeGenerationGraph(pendingValue);
    const record: GenerationPendingFeedback = { key, value: pendingValue, lease: pendingLease, parent, inflight: false, partition, published: false };
    const observation: GenerationRuntimeObservation = { value, lease: held };
    flush = newGenerationFlush(slot, { ACCESS_CONTROL: slot.owner.binding } as Env, undefined, record, true);
    slot.feedback ??= new Map();
    partition.runtimeFunding ??= runtimeRegistry; runtimeRegistry = undefined;
    partition.runtime ??= new Map();
    let versions = partition.runtime.get(key); if (!versions) { versions = new Map(); partition.runtime.set(key, versions); }
    versions.set(revision, observation);
    slot.feedback.set(key, record); slot.advisory = overlay;
    partition.runtimePending = (partition.runtimePending ?? 0) + 1; record.published = true;
    held = undefined; pendingLease = undefined; parent = undefined; created = undefined;
    previous = undefined;
    if (previousShared) { const previousCharge = previousShared.lease; previousShared.value = undefined; previousShared = undefined; previousCharge.release(); }
    if (prior && !prior.inflight) releaseGenerationFeedback(prior);
    const receipt = commitGenerationSchedule(flush!); flush = undefined;
    return receipt;
  } catch (error) { hasPrimary = true; primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try { if (flush && !flush.started) abandonGenerationFlush(flush); } catch (error) { failures.push(error); }
    try { parent?.dispose(); } catch (error) { failures.push(error); }
    try { pendingLease?.release(); } catch (error) { failures.push(error); }
    try { runtimeRegistry?.release(); } catch (error) { failures.push(error); }
    try { held?.release(); } catch (error) { failures.push(error); }
    try { created?.dispose(); } catch (error) { failures.push(error); }
    try { work?.release(); } catch (error) { failures.push(error); }
    try { frame.release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "generation feedback cleanup");
  }
}

// This completion joins ONLY this invocation's synchronously claimed cohort.
// It never awaits a foreign request's original work or promises a global drain.
export function flushCredentialGenerationRuntime(handle: GenerationAuthentication, env: Env): Promise<void> {
  admitGenerationConsumptionFactories();
  const auth = authenticationOwner(handle), slot = auth.slot;
  if (auth.failure) throw auth.failure;
  if (slot.owner.binding !== env.ACCESS_CONTROL) throw identityFailure("protocol");
  const owner = newGenerationFlush(slot, env);
  try { return startGenerationFlush(owner, false); }
  catch (primary) { try { abandonGenerationFlush(owner); } catch (cleanup) { throw new AggregateError([primary, cleanup], "generation flush start"); } throw primary; }
}

interface GenerationPendingCount {
  id: string; poolKey: string; key: string; count: number; lastMs: number; cursorKey?: string;
  parent: IdentityGenerationBorrow; lease: GenerationConsumptionLease; inflight: boolean; sendCursor: boolean; claim?: GenerationFlushOwner;
}
function prepareGenerationCount(slot: GenerationSlot, plan: import("./admission-cache.ts").GenerationSelectionPlan): GenerationPendingCount {
  const lease = GenerationConsumptionLease.reserve(4096 + 8 * plan.poolKey.length + 6 * plan.selectedKey!.length + 2 * (plan.cursorKey?.length ?? 0));
  let parent: IdentityGenerationBorrow | undefined;
  try {
    parent = newGenerationBorrow(slot);
    const id = `${plan.poolKey}\n${plan.selectedKey}`, previous = slot.counters?.get(id);
    return { id, poolKey: plan.poolKey, key: plan.selectedKey!, count: previous && !previous.inflight ? previous.count + 1 : 1,
      lastMs: plan.lastMs!, cursorKey: plan.cursorKey, parent, lease, inflight: false, sendCursor: false };
  } catch (primary) {
    const failures: unknown[] = [];
    try { parent?.dispose(); } catch (error) { failures.push(error); }
    try { lease.release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([primary, ...failures], "generation count preparation");
    throw primary;
  }
}
function commitGenerationCount(slot: GenerationSlot, record: GenerationPendingCount): void {
  const previous = slot.counters?.get(record.id);
  slot.counters ??= new Map(); slot.counters.set(record.id, record);
  if (record.cursorKey) { slot.countCursor ??= new Map(); slot.countCursor.set(record.poolKey, record); }
  if (previous && !previous.inflight) releaseGenerationCount(previous);
}
function releaseGenerationCount(record: GenerationPendingCount): void {
  record.id = ""; record.poolKey = ""; record.key = ""; record.cursorKey = undefined; record.claim = undefined;
  const parent = record.parent; record.parent = undefined as never;
  const failures: unknown[] = [];
  try { parent.dispose(); } catch (error) { failures.push(error); }
  try { record.lease.release(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "generation pending record cleanup");
}

export interface GenerationSelectionHint { dispose(): void }
interface GenerationHintOwner { selected: GenerationSelectionOwner; lease: GenerationConsumptionLease }
let generationHints: WeakMap<GenerationSelectionHint, GenerationHintOwner> | undefined;
let generationHintsCharge: GenerationConsumptionLease | undefined;
let generationHintCount = 0;
function disposeGenerationHint(this: GenerationSelectionHint): void {
  const owner = generationHints?.get(this);
  if (!owner) throw identityFailure("protocol");
  generationHints!.delete(this);
  const selected = owner.selected; owner.selected = undefined as never;
  const failures: unknown[] = [];
  try { releaseGenerationSelection(selected); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  if (!--generationHintCount) {
    generationHints = undefined;
    const charge = generationHintsCharge; generationHintsCharge = undefined;
    try { charge?.release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "generation hint retirement");
}
export function retainCredentialGenerationHint(selected: GenerationSelectionHandle, previous?: GenerationSelectionHint): GenerationSelectionHint {
  admitGenerationConsumptionFactories();
  const value = selectedOwner(selected);
  if (previous && !generationHints?.has(previous)) throw identityFailure("protocol");
  const lease = GenerationConsumptionLease.reserve(1024);
  let unpublished: GenerationSelectionHint | undefined;
  try {
    if (!generationHints) { generationHintsCharge = GenerationConsumptionLease.reserve(512); generationHints = new WeakMap(); }
    const owner: GenerationHintOwner = { selected: value, lease }, hint = Object.freeze({ dispose: disposeGenerationHint });
    generationHints.set(hint, owner); generationHintCount++; value.users++;
    unpublished = hint;
    // A failed prospective reserve leaves the old hint untouched. Publication
    // replacement retires only its own metadata and child, never the base graph.
    previous?.dispose(); unpublished = undefined; return hint;
  } catch (primary) {
    try { if (unpublished) unpublished.dispose(); else lease.release(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], "generation hint replacement"); }
    throw primary;
  }
}

// A hint remains dispose-only. This separate single-use capability owns a child
// before registration and carries no public grant, loader or materializer hook.
export interface OwnedGenerationPrefetch { dispose(): void }
interface GenerationPrefetchOwner {
  selected?: GenerationSelectionOwner; lease: GenerationConsumptionLease;
  binding?: Env["GRANT_CREDENTIALS"]; id: string; config?: HotCacheConfig;
  permit?: object; materialized: boolean;
}
let generationPrefetches: WeakMap<OwnedGenerationPrefetch, GenerationPrefetchOwner> | undefined;
let generationPrefetchCharge: GenerationConsumptionLease | undefined;
let generationPrefetchCount = 0;
function generationPrefetchOwner(cap: OwnedGenerationPrefetch): GenerationPrefetchOwner {
  const owner = generationPrefetches?.get(cap);
  if (!owner) throw identityFailure("protocol");
  return owner;
}
export function checkOwnedGenerationPrefetch(cap: OwnedGenerationPrefetch): void {
  admitGenerationConsumptionFactories();
  if (generationPrefetchOwner(cap).permit) throw identityFailure("protocol");
}
function disposeGenerationPrefetch(this: OwnedGenerationPrefetch): void {
  checkOwnedGenerationPrefetch(this); retireGenerationPrefetch(this);
}
function retireGenerationPrefetch(cap: OwnedGenerationPrefetch): void {
  const owner = generationPrefetchOwner(cap), selected = owner.selected;
  generationPrefetches!.delete(cap);
  owner.selected = undefined; owner.binding = undefined; owner.id = ""; owner.config = undefined; owner.permit = undefined;
  const failures: unknown[] = [];
  try { if (selected) releaseGenerationSelection(selected); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  if (!--generationPrefetchCount) {
    generationPrefetches = undefined;
    const charge = generationPrefetchCharge; generationPrefetchCharge = undefined;
    try { charge?.release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "generation prefetch child cleanup");
}
function generationPrefetchIdUnits(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 64;
  const plan = identityPlan("record"); plan.item(value, 0);
  return plan.counts.text + 16 * plan.counts.containers + 64;
}
export function prepareCredentialGenerationPrefetch(hint: GenerationSelectionHint, env: Env): OwnedGenerationPrefetch {
  admitGenerationConsumptionFactories();
  const selected = generationHints?.get(hint)?.selected;
  if (!selected || selected.auth.slot.owner.binding !== env.ACCESS_CONTROL) throw identityFailure("protocol");
  // This is an independently backed, full temporary component, never scratch
  // borrowed from a promoted/zeroed generation ticket. ORIGINAL materialization
  // request/reader and all registration/terminal products remain under it.
  const lease = GenerationConsumptionLease.reserve(32 * 1024 * 1024);
  let retained = false;
  try {
    const raw = env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS;
    const grant = selected.result!.selected;
    // Legacy scalar fields are not retyped here. Conservatively fund ordinary
    // String conversion of their passive JSON values, including array separators
    // and object tags, before interpolation; canonical numbers use less.
    const revision = grant ? grantRevision(grant.grant) : null;
    const idUnits = grant ? grant.key.length + generationPrefetchIdUnits(grant.grant.credentialGeneration) + generationPrefetchIdUnits(revision) + 2 : 0;
    const retainedIds = 6 * idUnits + 32768;
    if (Math.max(26361856, 2 * (typeof raw === "string" ? raw.length : 64)) + retainedIds > lease.bytes) throw identityFailure("limit");
    const currentConfig = hotCacheConfig(env);
    const config = Object.freeze({ maxAgeMs: currentConfig.maxAgeMs, freshMs: currentConfig.freshMs });
    const id = grant ? `${grant.key}\n${grant.grant.credentialGeneration ?? ""}\n${revision ?? ""}` : "";
    if (!generationPrefetches) { generationPrefetchCharge = GenerationConsumptionLease.reserve(512); generationPrefetches = new WeakMap(); }
    const owner: GenerationPrefetchOwner = { selected, lease, binding: env.GRANT_CREDENTIALS, id, config, materialized: false };
    const cap = Object.freeze({ dispose: disposeGenerationPrefetch });
    generationPrefetches.set(cap, owner); generationPrefetchCount++; selected.users++; retained = true;
    return cap;
  } finally { if (!retained) lease.release(); }
}
// Only the cache module can mint the nonescaping permit. Even a genuine cap
// holder cannot invoke the named materialization command to obtain a graph.
export function claimOwnedGenerationPrefetch(cap: OwnedGenerationPrefetch, permit: object): { eligible: boolean; id: string; config: HotCacheConfig; authority: Authority; binding: Env["GRANT_CREDENTIALS"] } {
  checkOwnedGenerationPrefetch(cap);
  if (!ownsCredentialPrefetchPermit(permit, cap)) throw identityFailure("protocol");
  const owner = generationPrefetchOwner(cap); owner.permit = permit;
  return { eligible: !!owner.selected!.prefetchProvider && !!owner.selected!.result!.selected, id: owner.id, config: owner.config!, authority: owner.selected!.auth.slot.owner.binding, binding: owner.binding };
}
export function materializeOwnedGenerationPrefetch(cap: OwnedGenerationPrefetch, permit: object): Promise<import("./types").UpstreamGrant> {
  const owner = generationPrefetchOwner(cap);
  if (owner.permit !== permit || !ownsCredentialPrefetchPermit(permit, cap) || owner.materialized) throw identityFailure("protocol");
  const selected = owner.selected!.result!.selected, provider = owner.selected!.prefetchProvider;
  if (!selected || !provider) throw identityFailure("protocol");
  owner.materialized = true;
  // The cache module receives this ORIGINAL parsed reply under the temporary
  // owner. Only its private funded destination may retain it after that owner.
  return materializeGrantCredentials({ GRANT_CREDENTIALS: owner.binding } as Env,
    selected.key, selected.grant, provider.id, provider.auth.refresh, false);
}
export function finishOwnedGenerationPrefetch(cap: OwnedGenerationPrefetch, permit: object): void {
  const owner = generationPrefetchOwner(cap);
  if (owner.permit !== permit || !ownsCredentialPrefetchPermit(permit, cap)) throw identityFailure("protocol");
  retireGenerationPrefetch(cap);
}

// A batching boundary, not an acceptance/profile limit: unclaimed records keep
// their own parents and funding for a subsequent originating-request flush.
export const generationFlushCohortLimit = 4;
// New phase-owner field: retained property-name occurrence plus boolean.
const generationFlushPlanningBytes = 2 * "planning".length + 1;
export interface GenerationPendingWork { drain(): Promise<void>; dispose(): void }
export type GenerationFlushReceipt = Readonly<{ accepted: false; pending?: GenerationPendingWork } | { accepted: true; completed: Promise<void> }>;
const generationFlushRejected: GenerationFlushReceipt = Object.freeze({ accepted: false });
interface GenerationFlushOwner {
  slot?: GenerationSlot; env?: Env; parent?: IdentityGenerationBorrow; lease: GenerationConsumptionLease;
  counts: GenerationPendingCount[]; feedback: GenerationPendingFeedback[]; failures: unknown[];
  original?: Promise<void>; completion?: Promise<void>; started: boolean; abandoned: boolean; planning: boolean; pending?: GenerationPendingWork;
}
let generationPendingWork: WeakMap<GenerationPendingWork, GenerationFlushOwner> | undefined;
let generationPendingCharge: GenerationConsumptionLease | undefined;
let generationPendingCount = 0;
function pendingGenerationOwner(cap: GenerationPendingWork): GenerationFlushOwner {
  const owner = generationPendingWork?.get(cap);
  if (!owner || owner.started || owner.abandoned) throw identityFailure("protocol");
  return owner;
}
function dropGenerationPendingCap(owner: GenerationFlushOwner): void {
  if (!owner.pending) return;
  generationPendingWork!.delete(owner.pending); owner.pending = undefined;
  if (!--generationPendingCount) {
    generationPendingWork = undefined;
    const charge = generationPendingCharge; generationPendingCharge = undefined; charge?.release();
  }
}
function drainPendingGenerationWork(this: GenerationPendingWork): Promise<void> {
  admitGenerationConsumptionFactories();
  const owner = pendingGenerationOwner(this), previous = owner.lease.bytes;
  // This single-use cap transfers its EXISTING funded parent, arrays and source
  // owner into the invoking request. No second cohort owner overlaps it.
  try { claimGenerationFlush(owner); }
  catch (primary) {
    restoreGenerationClaims(owner);
    try { owner.lease.replace(previous); } catch (cleanup) { throw new AggregateError([primary, cleanup], "pending generation claim"); }
    throw primary;
  }
  try { return startGenerationFlush(owner, false); }
  catch (primary) { try { abandonGenerationFlush(owner); } catch (cleanup) { throw new AggregateError([primary, cleanup], "pending generation start"); } throw primary; }
}
function disposePendingGenerationWork(this: GenerationPendingWork): void {
  const owner = pendingGenerationOwner(this), slot = owner.slot!;
  // Refusal leaves a real obligation. A caller may retire this cap only after
  // every unattempted row has transferred into a genuine started cohort.
  for (const record of slot.counters?.values() ?? []) if (!record.inflight) throw identityFailure("protocol");
  for (const record of slot.feedback?.values() ?? []) if (!record.inflight) throw identityFailure("protocol");
  abandonGenerationFlush(owner);
}
function newGenerationFlush(slot: GenerationSlot, env: Env, nextCount?: GenerationPendingCount,
  nextFeedback?: GenerationPendingFeedback, pendingCap = false): GenerationFlushOwner {
  // Fixed claim cells, cursor flags and terminal failure products are CONTROL,
  // never passive scratch. All factories are covered before lists are built.
  const lease = GenerationConsumptionLease.reserve(32768 + generationFlushPlanningBytes + 512 * generationFlushCohortLimit);
  let parent: IdentityGenerationBorrow | undefined, prepared: GenerationFlushOwner | undefined;
  try {
    if (env.ACCESS_CONTROL !== slot.owner.binding) throw identityFailure("protocol");
    parent = newGenerationBorrow(slot);
    const owner: GenerationFlushOwner = { slot, env: { ACCESS_CONTROL: slot.owner.binding } as Env, parent, lease,
      counts: [], feedback: [], failures: [], started: false, abandoned: false, planning: false };
    prepared = owner;
    claimGenerationFlush(owner, nextCount, nextFeedback);
    if (pendingCap) {
      if (!generationPendingWork) { generationPendingCharge = GenerationConsumptionLease.reserve(512); generationPendingWork = new WeakMap(); }
      const cap = Object.freeze({ drain: drainPendingGenerationWork, dispose: disposePendingGenerationWork });
      generationPendingWork.set(cap, owner); generationPendingCount++; owner.pending = cap;
    }
    return owner;
  } catch (primary) {
    const failures: unknown[] = [];
    if (prepared) { try { abandonGenerationFlush(prepared); } catch (error) { failures.push(error); } }
    else {
      try { parent?.dispose(); } catch (error) { failures.push(error); }
      try { lease.release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError([primary, ...failures], "generation cohort preparation");
    throw primary;
  }
}
// Claim lists are already covered by the fixed owner component. Request text
// grows prospectively; a failed re-claim clears lists before restoring debit.
function claimGenerationFlush(owner: GenerationFlushOwner, nextCount?: GenerationPendingCount, nextFeedback?: GenerationPendingFeedback): void {
  const slot = owner.slot!, counts = owner.counts, feedback = owner.feedback;
  if (counts.length || feedback.length || owner.started || owner.abandoned) throw identityFailure("protocol");
  if (nextCount) counts.push(nextCount);
  if (nextFeedback) feedback.push(nextFeedback);
  // New accepted work is included first; older unclaimed work fills the
  // remaining fixed cohort. Neither list can acquire later replacements.
  if (slot.counters) for (const record of slot.counters.values()) {
    if (counts.length + feedback.length === generationFlushCohortLimit) break;
    if (!record.inflight && record.id !== nextCount?.id) counts.push(record);
  }
  if (slot.feedback) for (const record of slot.feedback.values()) {
    if (counts.length + feedback.length === generationFlushCohortLimit) break;
    if (!record.inflight && record.key !== nextFeedback?.key) feedback.push(record);
  }
  // The retained observations fund their own graphs. This owner separately
  // funds the largest actual serialized outbound envelope plus the bounded
  // ACK/header/terminal component. Rows are sent sequentially, not batched.
  const requestText = planGenerationFlushWire(owner);
  owner.lease.replace(32768 + generationFlushPlanningBytes + 512 * generationFlushCohortLimit + 2 * requestText);
  // Prospective ownership claims and cursor decisions precede the caller's
  // counter/runtime publication. Registration rejection reverses ONLY these
  // unstarted claims; it never drops the independently funded observations.
  for (const record of counts) {
    record.sendCursor = record === nextCount ? !!record.cursorKey
      : !(nextCount?.cursorKey && nextCount.poolKey === record.poolKey) && slot.countCursor?.get(record.poolKey) === record;
    record.inflight = true; record.claim = owner;
  }
  for (const record of feedback) { record.inflight = true; record.claim = owner; }
}
// Prospective serialization plans have no source-counter authority. They count
// every escaped wire occurrence before authorityCall can allocate JSON text.
function planGenerationFlushWire(owner: GenerationFlushOwner): number {
  admitGenerationConsumptionFactories();
  if (owner.started || owner.original || owner.planning) throw identityFailure("protocol");
  // All four claimed rows/parents stay funded in the synchronous cohort row.
  // SOURCE/READ/TERMINAL are exclusively assigned to this synchronous visitor;
  // there is no original request, reader, ACK or cancellation for THIS cohort.
  owner.planning = true;
  try {
    let text = 0;
    for (const record of owner.counts) text = Math.max(text, generationCountWireUnits(record));
    for (const record of owner.feedback) text = Math.max(text, generationFeedbackWireUnits(record));
    return text;
  } finally {
    // Helpers return only scalars. Their plans, closures, descriptors and every
    // recursion/cursor frame have returned or unwound before transport may start.
    owner.planning = false;
  }
}
function generationCountWireUnits(record: GenerationPendingCount): number {
  let plan: ReturnType<typeof identityPlan> | undefined = identityPlan();
  try {
    plan.object(0, root => root("records", undefined, () => plan!.array(1, entry => entry(undefined,
      () => plan!.object(2, member => {
        member("poolKey", record.poolKey); member("key", record.key); member("count", record.count); member("lastMs", record.lastMs);
        // Fund the optional cursor even when the final fixed-cohort flag is false.
        if (record.cursorKey) member("cursorKey", record.cursorKey);
      })))));
    return plan.counts.text;
  } finally { plan = undefined; }
}
function generationFeedbackWireUnits(record: GenerationPendingFeedback): number {
  let plan: ReturnType<typeof identityPlan> | undefined = identityPlan();
  try {
    plan.object(0, member => { member("key", record.key); member("state", record.value); });
    return plan.counts.text;
  } finally { plan = undefined; }
}
function restoreGenerationClaims(owner: GenerationFlushOwner): void {
  for (const record of owner.counts) if (record.claim === owner) { record.claim = undefined; record.inflight = false; }
  for (const record of owner.feedback) if (record.claim === owner) { record.claim = undefined; record.inflight = false; }
  owner.counts.length = 0; owner.feedback.length = 0;
}
function abandonGenerationFlush(owner: GenerationFlushOwner): void {
  if (owner.started) throw identityFailure("protocol");
  if (owner.abandoned) return;
  owner.abandoned = true;
  restoreGenerationClaims(owner); owner.slot = undefined; owner.env = undefined;
  const parent = owner.parent; owner.parent = undefined;
  const failures = owner.failures;
  try { dropGenerationPendingCap(owner); } catch (error) { failures.push(error); }
  try { parent?.dispose(); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "generation cohort abandonment");
}
function commitGenerationSchedule(owner: GenerationFlushOwner): GenerationFlushReceipt {
  // Registration and start occur in THIS invocation/request. No shared promise,
  // foreign successor, queue callback or later-request completion is consulted.
  let accepted = false, completion: Promise<void> | undefined;
  try {
    accepted = tryRunInBackground(() => {
      try { return completion = startGenerationFlush(owner, true); }
      catch (primary) {
        try { abandonGenerationFlush(owner); }
        catch (cleanup) { return completion = Promise.reject(new AggregateError([primary, cleanup], "generation background start")); }
        return completion = Promise.reject(primary);
      }
    });
  } catch (primary) {
    if (!owner.started) {
      try { abandonGenerationFlush(owner); } catch (cleanup) { throw new AggregateError([primary, cleanup], "generation registration"); }
      throw primary;
    }
    // Once started, registration failure cannot orphan the accepted ORIGINAL.
    // Its receipt still joins cleanup, then reports this independent failure.
    owner.failures.push(primary); accepted = true;
  }
  if (!accepted && !owner.started) {
    // Transfer the retained owner to the already-funded closed capability.
    // Public selection/authentication disposal no longer strands pending rows.
    restoreGenerationClaims(owner);
    if (!owner.pending) throw identityFailure("protocol");
    return Object.freeze({ accepted: false, pending: owner.pending });
  }
  if (!completion) throw identityFailure("protocol");
  void completion.then(() => undefined, () => undefined);
  return Object.freeze({ accepted: true, completed: completion });
}
function startGenerationFlush(owner: GenerationFlushOwner, delayed: boolean): Promise<void> {
  const slot = owner.slot!;
  if (owner.started || owner.abandoned || owner.planning) throw identityFailure("protocol");
  // Validate ALL references before the first claim effect. This is synchronous
  // with publication of nextCount/nextFeedback; no borrowed callback runs here.
  for (const record of owner.counts) if (record.claim !== owner || !record.inflight || slot.counters?.get(record.id) !== record) throw identityFailure("protocol");
  for (const record of owner.feedback) if (record.claim !== owner || !record.inflight || slot.feedback?.get(record.key) !== record) throw identityFailure("protocol");
  dropGenerationPendingCap(owner);
  owner.started = true;
  // Every original begins and finishes in the accepted thunk's request context.
  // UNKNOWN at any original keeps the whole remaining fixed cohort funded.
  owner.original = runOwnedGenerationFlush(owner, delayed);
  const completion = owner.original.then(() => finishGenerationFlush(owner, false), reason => finishGenerationFlush(owner, true, reason));
  owner.completion = completion;
  void completion.then(() => undefined, () => undefined);
  return completion;
}
async function runOwnedGenerationFlush(owner: GenerationFlushOwner, delayed: boolean): Promise<void> {
  // A coalescing timer failure must not discard already-claimed, unattempted
  // observations. Retain that independent origin and attempt the fixed cohort.
  if (delayed) try { await waitGenerationFlushWindow(); } catch (error) { owner.failures.push(error); }
  const slot = owner.slot!, env = owner.env!;
  for (let i = 0; i < owner.counts.length; i++) {
    const record = owner.counts[i];
    try { await authorityCall(env, "/grant-pools/record", { records: [{ poolKey: record.poolKey, key: record.key,
      count: record.count, lastMs: record.lastMs, ...(record.sendCursor && record.cursorKey ? { cursorKey: record.cursorKey } : {}) }] }); }
    catch { /* Ordinary best effort. An attempted count is never replayed. */ }
    if (slot.counters?.get(record.id) === record) slot.counters.delete(record.id);
    if (slot.countCursor?.get(record.poolKey) === record) slot.countCursor.delete(record.poolKey);
    try { releaseGenerationCount(record); } catch (error) { owner.failures.push(error); }
    // No completed-record/promise history. Only bounded failure origins remain.
    owner.counts[i] = undefined as never;
  }
  owner.counts.length = 0;
  for (let i = 0; i < owner.feedback.length; i++) {
    const record = owner.feedback[i];
    try { await recordGrantRuntime(env, record.key, record.value!); }
    catch { /* Ordinary best effort; do not replay a lost ACK. */ }
    if (slot.feedback?.get(record.key) === record) slot.feedback.delete(record.key);
    try { releaseGenerationFeedback(record); } catch (error) { owner.failures.push(error); }
    owner.feedback[i] = undefined as never;
  }
  owner.feedback.length = 0;
  if (!slot.counters?.size) slot.counters = undefined;
  if (!slot.countCursor?.size) slot.countCursor = undefined;
  if (!slot.feedback?.size) slot.feedback = undefined;
}
function finishGenerationFlush(owner: GenerationFlushOwner, hasPrimary: boolean, primary?: unknown): void {
  // No successor launch here. Other requests' records/receipts stay under their
  // own accepted owners. Completion says nothing about global pending work.
  owner.original = undefined; owner.completion = undefined; owner.env = undefined; owner.slot = undefined;
  owner.counts.length = 0; owner.feedback.length = 0;
  const parent = owner.parent; owner.parent = undefined;
  const failures = owner.failures;
  try { dropGenerationPendingCap(owner); } catch (error) { failures.push(error); }
  try { parent?.dispose(); } catch (error) { failures.push(error); }
  try { owner.lease.release(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "generation flush cleanup");
  if (hasPrimary) throw primary;
}

export function refreshCredentialGenerationAuthentication(handle: GenerationAuthentication, fresh: IdentityGenerationBorrow,
  env: Pick<Env, "ACCESS_CONTROL">, required: GenerationCoverage): void {
  const previous = authenticationOwner(handle);
  if (previous.failure) throw previous.failure;
  const nextHandle = createGenerationAuthentication(fresh, env, required, previous);
  const next = authenticationOwner(nextHandle);
  if (next.failure) {
    const failure = next.failure;
    try { nextHandle.dispose(); } catch (cleanup) { throw new AggregateError([failure, cleanup], "generation refresh cleanup"); }
    throw failure;
  }
  // All new policy/identity/capability factories and their exact overlapping
  // funding have succeeded. Existing children retain the OLD owner record.
  // The public opaque identity keeps its reference, as ordinary refresh does.
  generationAuthentications!.delete(nextHandle);
  generationAuthentications!.set(handle, next);
  previous.closed = true;
  retireAuthentication(previous);
}


// Closed provenance gate for the new destination. No data graph or callback is
// accepted/returned. Caller-lived traversal and ID copies are funded separately.
export function checkCredentialGenerationDestination(handle: GenerationSelectionHandle, env: Env,
  authority: Authority, binding: NonNullable<Env["GRANT_CREDENTIALS"]>, id: string): void {
  admitGenerationConsumptionFactories();
  const owner = selectedOwner(handle), selected = owner.result!.selected;
  if (!selected || owner.auth.slot.owner.binding !== authority || env.ACCESS_CONTROL !== authority || env.GRANT_CREDENTIALS !== binding)
    throw identityFailure("protocol");
  const lease = GenerationConsumptionLease.reserve(32 * 1024 * 1024);
  let expected: string | undefined, hasPrimary = false, primary: unknown;
  try {
    const units = selected.key.length + generationPrefetchIdUnits(selected.grant.credentialGeneration) + generationPrefetchIdUnits(grantRevision(selected.grant)) + 2;
    if (26361856 + 6 * units + 32768 > lease.bytes) throw identityFailure("limit");
    expected = `${selected.key}\n${selected.grant.credentialGeneration ?? ""}\n${grantRevision(selected.grant) ?? ""}`;
    if (expected !== id) throw identityFailure("protocol");
  } catch (error) { hasPrimary = true; primary = error; }
  expected = undefined;
  try { lease.release(); } catch (cleanup) { throw hasPrimary ? new AggregateError([primary, cleanup], "private credential provenance cleanup") : cleanup; }
  if (hasPrimary) throw primary;
}
export function adoptCredentialGenerationDestination(handle: GenerationSelectionHandle, env: Env, borrowed: OwnedCredentialBorrow): void {
  const owner = selectedOwner(handle);
  const adopted = moveOwnedCredentialBorrow(borrowed, handle, env), previous = owner.destination;
  owner.destination = adopted;
  previous?.dispose();
}
