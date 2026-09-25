import { planBudgetReservation } from "./accounting.ts";
import type { BackgroundAdmission } from "./background-store.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { setBackgroundRecovery } from "./correlation.ts";
import { continuationScope } from "./http-continuation.ts";
import type { AccountingFacts, AccountingOutcome } from "./proxy-accounting.ts";
import { retainedResponseRoute } from "./responses-control-dispatch.ts";
import type { ResponsesObservation } from "./token-usage.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types.ts";
import { HttpError, randomId } from "./utils.ts";

// The HTTP request owns delivery only. Its durable scoped owner owns the
// generation's one reservation plan, terminal event and independently ACKed sinks.
export class HttpBackground {
  private readonly env: Env;
  readonly scope: string;
  readonly admission: BackgroundAdmission;
  private constructor(env: Env, scope: string, admission: BackgroundAdmission) { this.env = env; this.scope = scope; this.admission = admission; }

  static async prepare(request: Request, env: Env, auth: AuthorizedIdentity, owner: ContinuationOwner, facts: AccountingFacts,
    connection: ProviderConnection, pathParams: Record<string, string>, headers: Headers, stream: boolean): Promise<HttpBackground> {
    const admittedAt = Date.now(), scope = await continuationScope(auth);
    const admission: BackgroundAdmission = {
      id: randomId("bg"), admittedAt, owner, facts,
      plan: planBudgetReservation(auth, facts.event.capability, facts.cost, connection, admittedAt),
      route: retainedResponseRoute(pathParams, headers), stream,
    };
    // Stamp before the durable call: a lost ACK must still leave a recoverable
    // locator, while an absent record explicitly does not imply settlement.
    setBackgroundRecovery(request, `${scope.slice("http-continuations:".length)}.${admission.id}`);
    return new HttpBackground(env, scope, admission);
  }

  async admit(): Promise<void> {
    const ack = await backgroundCall<{ admitted?: boolean } | null>(this.env, this.scope, { action: "admit", admission: this.admission });
    if (ack?.admitted !== true) throw new HttpError(503, "background_unavailable", "background admission was not acknowledged");
  }
  async dispatch(contentRef: string | null): Promise<void> {
    const ack = await backgroundCall<{ dispatched?: boolean } | null>(this.env, this.scope, { action: "dispatch", id: this.admission.id, contentRef });
    if (ack?.dispatched !== true) throw new HttpError(503, "background_unavailable", "background dispatch was not acknowledged");
  }
  observe(fact: ResponsesObservation, statusCode: number): Promise<unknown> {
    return backgroundCall(this.env, this.scope, { action: "observe", id: this.admission.id, fact, statusCode });
  }
  unsent(statusCode: number, status: AccountingOutcome["status"], contentRef: string | null): Promise<unknown> {
    return backgroundCall(this.env, this.scope, { action: "freeze", id: this.admission.id,
      outcome: { occurredAtMs: Date.now(), statusCode, status, billable: false, tokens: null, contentRef } });
  }
}

export async function backgroundCall<T>(env: Env, scope: string, body: unknown): Promise<T> {
  try {
    const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(scope));
    const response = await stub.fetch("https://clawrouter.internal/responses-background", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const value = await response.json<{ error?: { code?: string; message?: string } }>();
    if (!response.ok) {
      if (typeof value?.error?.code === "string" && typeof value.error.message === "string") throw new HttpError(response.status, value.error.code, value.error.message);
      throw new Error("background owner acknowledgment unavailable");
    }
    return value as T;
  }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "background_unavailable", "background recovery is unavailable; a missing acknowledgment does not confirm settlement"); }
}
