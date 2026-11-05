import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { readCopilotInferenceInput, copilotInferenceResponse, disposeCopilotInferenceResponse } from "./copilot-inference-response.ts";
import { copilotAccountingIdentity, copilotAccountingSelection, copilotInferenceUnavailable, type CopilotInferenceInput } from "./copilot-inference-dispatch.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { HttpError } from "./utils.ts";
import type { AccessPolicy, Env } from "./types.ts";
import type { BudgetReservation } from "./accounting.ts";

// Owner-local continuation only. Neither a token nor a capacity/entitlement
// handle is accepted from or returned to the private RPC caller.
export interface CopilotInferenceAccess {
  retain(work: Promise<void>): void;
  begin(operation: HttpOperation): Promise<void>;
  qualify(value: unknown, deadline: number, preflight: (input: CopilotInferenceInput, policy: AccessPolicy) => Promise<void>): Promise<{ input: CopilotInferenceInput; policy: AccessPolicy }>;
  post(input: CopilotInferenceInput, beforePost: (policy: AccessPolicy) => Promise<(policy: AccessPolicy) => void>, dispatched: () => void): Promise<{ response: Response; url: string }>;
  revalidate(force?: boolean): Promise<void>;
  end(): Promise<void>;
}

export async function runCopilotInference(request: Request, env: Env, access: CopilotInferenceAccess): Promise<Response> {
  const allocation = new BodyLease();
  let operation: HttpOperation | undefined, dispatched = false, reserving = false, settled: Promise<boolean> | undefined;
  let accounting: ReturnType<typeof import("./proxy-accounting.ts")["createProxyAccounting"]> | undefined;
  let reservation: BudgetReservation = { reservations: [], reservedMicros: 0 }, delivery = Promise.resolve();
  let producerEnd!: () => void;
  const producer = new Promise<void>(resolve => { producerEnd = resolve; });
  const fail = () => {
    if (!accounting) return Promise.resolve(true);
    return settled ??= accounting.settle(operation?.status === "timeout" ? 504 : 503, operation?.status ?? "provider_error", dispatched, null, reservation, null,
      null, undefined, dispatched ? "unknown" : "unsent");
  };
  let work: Promise<Response>;
  try {
    // One synchronous all-or-nothing 96 MiB reservation. No release/reacquire,
    // nested catalog charge, caller allocation or zero-charge qualification.
    if (!allocation.grow(48 * 1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
    const raw = request.headers.get("x-clawrouter-copilot-deadline"), deadline = Number(raw);
    if (!raw || !/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline - Date.now() > 2_147_483_647) throw copilotInferenceUnavailable();
    const current = operation = new HttpOperation(request.signal, deadline - Date.now());
    work = (async () => {
      await access.begin(current);
      const value = await readCopilotInferenceInput(request, current);
      const [{ createProxyAccounting, estimateCost }, budgets, { resolveConnection }, { policyRequestCost }, { observeUsage }] = await Promise.all([
        import("./proxy-accounting.ts"), import("./accounting.ts"), import("./authority.ts"), import("../shared/request-pricing.ts"), import("./proxy-response.ts"),
      ]);
      let admittedBudget: string | undefined;
      const budgetIdentity = (policy: AccessPolicy) => JSON.stringify([policyRequestCost(policy, "llm.chat"), policy.monthlyBudgetMicros ?? null,
        policy.dailyBudgetMicros ?? null, policy.weeklyBudgetMicros ?? null, policy.budgetScope ?? null, policy.budgetMode ?? null]);
      const checkPolicy = (policy: AccessPolicy) => { if (budgetIdentity(policy) !== admittedBudget) throw copilotInferenceUnavailable(); };
      let providerBudget: number | null | undefined;
      const connection = async () => {
        const value = await resolveConnection(env, "github-copilot");
        current.signal.throwIfAborted();
        if (value?.enabled === false) throw new HttpError(503, "provider_disabled", "Copilot provider is disabled");
        return value ?? undefined;
      };
      const qualified = await access.qualify(value, deadline, async (input, policy) => {
        if (jsonBodyBytes(input.selected) > 32 * 1024 || jsonBodyBytes(input.body) > 512 * 1024) throw copilotInferenceUnavailable();
        const selection = copilotAccountingSelection(input), cost = estimateCost(selection.model, input.body, policyRequestCost(policy, "llm.chat"),
          "llm.chat", selection.endpoint, undefined, undefined, "github-copilot");
        const linked = await connection(); providerBudget = linked?.monthlyBudgetMicros ?? null;
        // Dollar admission precedes ALL authenticated account/catalog egress.
        budgets.validateBudgetReservation("llm.chat", cost, policy.monthlyBudgetMicros, linked, policy.dailyBudgetMicros, policy.limitHint, policy.weeklyBudgetMicros);
        admittedBudget = budgetIdentity(policy);
        accounting = createProxyAccounting({ env, context: { waitUntil: work => access.retain(work) } as ExecutionContext,
          auth: copilotAccountingIdentity(input, policy), selection, request, cost, grantKey: input.selected.key });
      });
      current.signal.throwIfAborted(); checkPolicy(qualified.policy);
      const linked = await connection();
      if ((linked?.monthlyBudgetMicros ?? null) !== providerBudget) throw copilotInferenceUnavailable();
      reserving = true;
      try { reservation = await budgets.reserveBudget(env, copilotAccountingIdentity(qualified.input, qualified.policy), "llm.chat", accounting!.cost, linked); }
      finally { reserving = false; }
      current.signal.throwIfAborted();
      const upstream = await access.post(qualified.input, async policy => {
        checkPolicy(policy);
        const fresh = await connection();
        if ((fresh?.monthlyBudgetMicros ?? null) !== providerBudget) throw copilotInferenceUnavailable();
        await budgets.markBudgetDispatched(env, reservation, current.signal);
        return checkPolicy;
      }, () => { dispatched = true; });
      accounting!.observeUpstreamResponse(upstream.response, new URL(upstream.url));
      const guarded = copilotInferenceResponse(upstream.response, current, upstream.url, qualified.input.body.stream === true, access.revalidate);
      const observed = observeUsage(guarded.response, current, undefined, qualified.input.selected.selection.format);
      const completion = observed.result.then(result => {
        // All possibly-paid failures retain the reservation. Generic parsed
        // error/consumer cancellation is not evidence of an upstream refund.
        settled ??= accounting!.settle(200, current.status ?? (result.delivery === "complete" ? result.outcome ?? "success" : "provider_error"), true,
          result.delivery === "complete" && result.outcome !== "provider_error" ? result.tokens : null, reservation, null, null, undefined,
          result.delivery === "complete" && result.outcome !== "provider_error" ? "succeeded" : "unknown");
        return settled;
      });
      // Both the original response and accounting/delivery owners must retire.
      delivery = Promise.allSettled([guarded.retired, observed.retired, completion]).then(results => {
        const rejected = results.find(result => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
      });
      void delivery.catch(() => undefined);
      if (current.signal.aborted) { await observed.response.body?.cancel(current.signal.reason); await delivery; current.signal.throwIfAborted(); }
      producerEnd(); // Actual delivery is represented by observed.retired.
      return observed.response;
    })();
  } catch (error) { work = Promise.reject(error); }
  // Register physical work before the prompt public cancellation race. A late
  // Response is disposed by this SAME continuation; it is never replayed.
  const physical = work.then(async response => {
    if (operation?.signal.aborted && response.body && !response.body.locked && !response.bodyUsed) await response.body.cancel(operation.signal.reason);
    await delivery;
  }, async () => {
    // Rejection before the first input read still owns its FIRST cancellation.
    await Promise.allSettled([fail(), !request.bodyUsed && !request.body?.locked ? disposeCopilotInferenceResponse(request) : Promise.resolve()]);
  });
  const retained = Promise.allSettled([physical, producer]).then(async () => {
    if (request.body?.locked) throw new Error("copilot_inference_control_not_retired");
    await access.end(); operation?.stop("complete"); allocation.release();
  });
  access.retain(retained); void retained.catch(() => undefined);
  try { return operation ? await operation.wait(work, "upstream") : await work; }
  catch (error) {
    operation?.stop("upstream", error);
    if (!reserving) access.retain(fail().then(() => undefined));
    // Tiny fixed response is charged through actual producer EOF/cancel too.
    const status = error instanceof HttpError ? error.status : operation?.status === "timeout" ? 504 : 503;
    const code = error instanceof HttpError ? error.code : "copilot_inference_unavailable";
    const bytes = new TextEncoder().encode(JSON.stringify({ error: { code, message: "Copilot inference unavailable" } }));
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes); } else { controller.close(); producerEnd(); } },
      cancel() { producerEnd(); },
    }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  }
}
