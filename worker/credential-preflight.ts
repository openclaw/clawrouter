import type { Env } from "./types";
import { advanceIdentitySource, identityFailure, identityPlan, identitySourceBudget,
  identitySourceSnapshot, type IdentitySourceBudget } from "./identity-admission.ts";
import { PreflightTicket } from "./credential-preflight-arena.ts";
import { checkPreflightIdentity, credentialPreflightHeader, credentialPreflightNamespace,
  credentialPreflightPath, credentialPreflightVersion } from "./credential-preflight-protocol.ts";
import { consumePreflightReply } from "./credential-preflight-source.ts";

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
  owner.ticket.release();
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
