import { accountingAdmissionFailure, accountingIdentity, admitAccountingJson, copyAccountingJson } from "./json-body.ts";
import { MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { planBudgetReservation } from "./accounting.ts";
import { admitBackgroundAdmission, admitInputAllocation, type BackgroundAdmission } from "./background-store.ts";
import type { ManagedInputAllocation } from "./managed-input-receipt.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { setBackgroundRecovery } from "./correlation.ts";
import { continuationScope } from "./http-continuation.ts";
import type { AccountingFacts, AccountingOutcome } from "./proxy-accounting.ts";
import { retainedResponseRoute } from "./responses-control-dispatch.ts";
import type { ResponsesObservation } from "./token-usage.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types.ts";
import { HttpError, randomId } from "./utils.ts";
import type { WanManagedOperation } from "./managed-media-json.ts";

// The HTTP request owns delivery only. Its durable scoped owner owns the
// generation's one reservation plan, terminal event and independently ACKed sinks.
export class HttpBackground {
  private readonly namespace: Env["ACCESS_CONTROL"];
  readonly scope: string;
  readonly admission: BackgroundAdmission;
  private readonly wan?: WanManagedOperation | MiniMaxVideoOperation;
  private constructor(namespace: Env["ACCESS_CONTROL"], scope: string, admission: BackgroundAdmission, wan?: WanManagedOperation | MiniMaxVideoOperation) { this.namespace = namespace; this.scope = scope; this.admission = admission; this.wan = wan; }

  static async prepare(request: Request, env: Env, auth: AuthorizedIdentity, owner: ContinuationOwner, facts: AccountingFacts,
    connection: ProviderConnection, pathParams: Record<string, string>, headers: Headers, stream: boolean, wan?: WanManagedOperation | MiniMaxVideoOperation): Promise<HttpBackground> {
    accountingIdentity(auth.policy.tenantId); accountingIdentity(auth.policyId); accountingIdentity(auth.principalId); accountingIdentity(auth.credentialId);
    accountingIdentity(headers.get("openai-organization")); accountingIdentity(headers.get("openai-project"));
    admitAccountingJson(pathParams, "capsule"); admitAccountingJson(owner, "capsule");
    const admittedAt = Date.now(), scope = await continuationScope(auth);
    const admission: BackgroundAdmission = {
      id: randomId("bg"), admittedAt, owner, facts,
      plan: planBudgetReservation(auth, facts.event.capability, facts.cost, connection, admittedAt),
      route: retainedResponseRoute(pathParams, headers), stream,
    };
    admitBackgroundAdmission(admission);
    const owned = copyAccountingJson(admission, "capsule");
    // Stamp before the durable call: a lost ACK must still leave a recoverable
    // locator, while an absent record explicitly does not imply settlement.
    setBackgroundRecovery(request, `${scope.slice("http-continuations:".length)}.${admission.id}`);
    return new HttpBackground(env.ACCESS_CONTROL, scope, owned, wan);
  }

  async admit(): Promise<void> {
    const ack = await backgroundNamespaceCall<{ admitted?: boolean } | null>(this.namespace, this.scope, { action: "admit", admission: this.admission }, this.wan);
    if (ack?.admitted !== true) throw new HttpError(503, "background_unavailable", "background admission was not acknowledged");
  }
  async dispatch(contentRef: string | null): Promise<void> {
    const ack = await backgroundNamespaceCall<{ dispatched?: boolean } | null>(this.namespace, this.scope, { action: "dispatch", id: this.admission.id, contentRef }, this.wan);
    if (ack?.dispatched !== true) throw new HttpError(503, "background_unavailable", "background dispatch was not acknowledged");
  }
  observe(fact: ResponsesObservation, statusCode: number): Promise<unknown> {
    return backgroundNamespaceCall(this.namespace, this.scope, { action: "observe", id: this.admission.id, fact, statusCode }, this.wan);
  }
  unsent(statusCode: number, status: AccountingOutcome["status"], contentRef: string | null): Promise<unknown> {
    return this.finishRejectedDelivery({ statusCode, status, billable: false, tokens: null, contentRef });
  }
  finishRejectedDelivery(outcome: Pick<AccountingOutcome, "statusCode" | "status" | "billable" | "tokens" | "contentRef">): Promise<unknown> {
    return backgroundNamespaceCall(this.namespace, this.scope, { action: "freeze", id: this.admission.id,
      outcome: { ...outcome, occurredAtMs: Date.now() } }, this.wan);
  }
}

export function backgroundCall<T>(env: Env, scope: string, body: unknown, wan?: WanManagedOperation | MiniMaxVideoOperation): Promise<T> {
  return backgroundNamespaceCall<T>(env.ACCESS_CONTROL, scope, body, wan);
}
async function backgroundNamespaceCall<T>(namespace: Env["ACCESS_CONTROL"], scope: string, body: unknown, wan?: WanManagedOperation | MiniMaxVideoOperation): Promise<T> {
  // Managed callers add protocol facts after prepare(); admit the actual NEW
  // message here, before either ordinary or private-control serialization/I/O.
  if (body && typeof body === "object" && "action" in body && ["admit", "managed_admit", "input_allocate", "managed_files"].includes(String(body.action))) {
    admitAccountingJson(body, "capsule");
    if ("admission" in body) admitBackgroundAdmission(body.admission as BackgroundAdmission);
    if (body.action === "input_allocate" && "input" in body) admitInputAllocation(body.input as ManagedInputAllocation);
  }
  if (wan) {
    const action = (body as { action?: unknown }).action;
    const mandatory = action === "dispatch" || action === "managed_bind" || action === "managed_observe" || wan instanceof MiniMaxVideoOperation && action === "managed_files" || action === "observe" || action === "freeze";
    try {
      return await wan.controlJson<T>(body, (text, signal) => {
        const stub = namespace.get(namespace.idFromName(scope));
        return stub.fetch("https://clawrouter.internal/responses-background", {
          method: "POST", body: text, signal, headers: { "content-type": "application/json" }, redirect: "manual",
        });
      }, mandatory);
    } catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "background_unavailable", "background recovery is unavailable; a missing acknowledgment does not confirm settlement"); }
  }
  try {
    const stub = namespace.get(namespace.idFromName(scope));
    const response = await stub.fetch("https://clawrouter.internal/responses-background", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const value = await response.json<{ error?: { code?: string; message?: string } }>();
    if (!response.ok) {
      if (response.status === 503 && value?.error?.code === "accounting_preflight_unavailable") accountingAdmissionFailure();
      if (typeof value?.error?.code === "string" && typeof value.error.message === "string") throw new HttpError(response.status, value.error.code, value.error.message);
      throw new Error("background owner acknowledgment unavailable");
    }
    return value as T;
  }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "background_unavailable", "background recovery is unavailable; a missing acknowledgment does not confirm settlement"); }
}
