import { identityJsonProfiles } from "./access-json.ts";
import type { Env } from "./types";
import { admitAdmission, admitIdentity, advanceIdentitySource, identityFailure, identityPlan, identitySourceBudget,
  identitySourceSnapshot, type IdentitySourceBudget } from "./identity-admission.ts";
import { admitBridgeFactories, admitBridgeCopyFactories, admissionBridgePhasePayload, reserveAdmissionScratch, retireAdmissionScratch, PreflightTicket } from "./credential-preflight-arena.ts";
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
type AdmissionOwner = Owner & { admission?: import("./authority-admission.ts").AdmissionResult };
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
          key === "credentialId" ? owner.kid : key === "secretSha256" ? owner.digest : input[key]);
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
        const value = input[key];
        // JSON-omitted executable/opaque values never become passive borrowers.
        copied[key] = typeof value === "function" || typeof value === "symbol" ? undefined : value;
      }
      copied.credentialId = owner.kid; copied.secretSha256 = owner.digest;
      request = { admission: copied, source: sent };
    } finally { owner.ticket.leave("source"); }
    body = JSON.stringify(request); request = undefined; copied = undefined; input = undefined as never;
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
