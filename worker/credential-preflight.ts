import type { Env } from "./types";
import { admitAdmission, admitIdentity, advanceIdentitySource, identityFailure, identityPlan, identitySourceBudget,
  identitySourceSnapshot, type IdentitySourceBudget } from "./identity-admission.ts";
import { admitBridgeFactories, admissionBridgePhasePayload, reserveAdmissionScratch, retireAdmissionScratch, PreflightTicket } from "./credential-preflight-arena.ts";
import { admissionContinuationHeader, admissionContinuationVersion, admissionContinuationPath, closeAdmissionEnvelope, type AdmissionContinuationEnvelope, checkPreflightIdentity, credentialPreflightHeader, credentialPreflightNamespace,
  credentialPreflightPath, credentialPreflightVersion } from "./credential-preflight-protocol.ts";
import { consumeAdmissionBridge, consumePreflightReply } from "./credential-preflight-source.ts";

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
  continuations.delete(continuation);
  const operation = runAdmission(owner, input, signal);
  void operation.then(() => undefined, () => undefined);
  return operation;
}
async function runAdmission(owner: AdmissionOwner, input: Record<string, unknown>, signal?: AbortSignal): Promise<PrivateAdmissionHandle> {
  let body: string | undefined, init: RequestInit | undefined, request: unknown;
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
    sent = identitySourceSnapshot(owner.source);
    // Visit original borrowed fields and the exact owner replacements BEFORE
    // constructing the inner spread or either outer carrier. Replacement keys
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
    request = { admission: { ...input, credentialId: owner.kid, secretSha256: owner.digest }, source: sent };
    body = JSON.stringify(request); request = undefined; input = undefined as never;
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
    body = undefined; init = undefined; request = undefined; reply = undefined; sent = undefined; replySource = undefined; stub = undefined; signal = undefined;
    // Full graph remains under the SAME 32 MiB ticket. No scalar shrink/GC credit.
    const handle = Object.freeze({ dispose: disposeAdmission });
    admissions.set(handle, owner); retained = true;
    return handle;
  } finally {
    body = undefined; init = undefined; request = undefined; reply = undefined; sent = undefined; replySource = undefined; stub = undefined; signal = undefined; input = undefined as never;
    phase?.retire();
    if (!retained) { owner.admission = undefined; retireOwner(owner); }
  }
}
