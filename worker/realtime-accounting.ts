import { accountingIdentity } from "./json-body.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { emptyReservation, accountingSinks, finalizeOwnedAccounting, planBudgetReservation, type AccountingSinks, type EstimatedCost, markBudgetDispatched, reserveBudget, type BudgetReservation } from './accounting';
import { admitAccountingFacts, createProxyAccounting } from './proxy-accounting';
import { prepareSoftBudget, startSoftBudget } from './soft-budget';
import { transcriptionUsage } from './transcription-usage';
import { parseRealtimeUsage, REALTIME } from './realtime-protocol';
import type { Json } from './realtime-protocol';
import type { AuthorizedIdentity, Env, ProviderConnection } from './types';
import type { ProxySelection } from './proxy-selection';
import { HttpError } from './utils';

export interface FundedInput {
  settle(terminal: Json | null, sent: boolean, itemId: string | null): Promise<void>;
  // Split a receipt for trailing media that was already admitted before egress.
  fork(): FundedInput;
}
interface FundedRealtimeUnit {
  settle(terminal: Json | null, sent: boolean, rejected: boolean, id: string | null): Promise<void>;
  forkInput(): FundedRealtimeUnit;
}
// Authority is refreshed by the socket owner before constructing each unit.
// Input ASR has no qualified preflight ceiling; it is available ONLY on an
// explicitly soft route, separately attributed from the Realtime response.
export async function fundRealtimeUnit(o: {
  request: Request; env: Env; context: ExecutionContext; auth: AuthorizedIdentity;
  selection: ProxySelection; connection: ProviderConnection; grantKey: string | null;
  grantLane: import('./types').GrantLane; signal: AbortSignal; unitId: string;
  outputCap: number; input?: boolean;
}): Promise<FundedRealtimeUnit> {
  accountingIdentity(o.unitId, 128);
  const soft = o.auth.policy.budgetMode === 'soft';
  if (o.input && !soft) throw new HttpError(400, 'pricing_required', 'Input transcription has no qualified hard-budget envelope');
  const cost = soft ? { reserveMicros: 0, basis: 'unpriced_request', inputTokens: null, outputTokens: null }
    : { reserveMicros: Math.max(REALTIME.reservation, policyRequestCost(o.auth.policy, o.selection.capability) ?? 0), basis: 'realtime_full_context_bound', inputTokens: REALTIME.context, outputTokens: REALTIME.output };
  const accounting = createProxyAccounting({ ...o, cost, realtime: true });
  const softPlan = soft ? prepareSoftBudget(o.auth, o.input ? 'audio.transcription' : o.selection.capability, o.connection, accounting.facts.event.id) : undefined;
  const reservePlan = !soft ? planBudgetReservation(o.auth, o.selection.capability, cost, o.connection) : undefined;
  admitAccountingFacts(accounting.facts, softPlan?.reservation ?? reservePlan);
  const sinks = accountingSinks(o.env), input = !!o.input, outputCap = o.outputCap, unitId = o.unitId;
  const fixed = policyRequestCost(o.auth.policy, o.selection.capability);
  let reservation = emptyReservation();
  try {
    if (soft) {
      const observation = startSoftBudget(o.env, softPlan!, () => undefined);
      reservation = observation.reservation;
      o.context.waitUntil(observation.check);
      await observation.beforeDelivery(); observation.close();
      if (observation.denial) throw observation.denial;
    } else {
      reservation = await reserveBudget(o.env, o.auth, o.selection.capability, cost, o.connection, undefined, { preparedPlan: reservePlan });
      o.signal.throwIfAborted(); await markBudgetDispatched(o.env, reservation, o.signal);
    }
    o.signal.throwIfAborted();
  } catch (error) {
    if (!await accounting.settle(503, 'provider_error', false, null, reservation, null)) throw new HttpError(503, 'realtime_accounting_unavailable', 'Realtime accounting failed');
    throw error;
  }
  return ownedRealtimeUnit(accounting, reservation, unitId, sinks, { input, outputCap, soft, fixed, cost: accounting.cost });
}

// Only privately admitted facts, explicit sinks and scalar tariff/operation facts
// survive funding. RealtimeSession validates external response/item IDs <=128.
function ownedRealtimeUnit(accounting: ReturnType<typeof createProxyAccounting>, reservation: BudgetReservation, unitId: string,
  sinks: AccountingSinks, options: { input: boolean; outputCap: number; soft: boolean; fixed: number | null | undefined; cost: EstimatedCost }): FundedRealtimeUnit {
  const { input: isInput, outputCap, soft, fixed, cost } = options;
  let settled = false; let forked = false;
  const finish = async (terminal: Json | null, sent: boolean, rejected: boolean, id: string | null) => {
    if (settled) return; settled = true;
    const input = isInput && terminal?.type === 'conversation.item.input_audio_transcription.completed' ? transcriptionUsage(terminal) : null;
    const output = !isInput && terminal ? parseRealtimeUsage(terminal.response?.usage, outputCap) : null;
    // The official mini-transcribe model page publishes 1.25 input / 5 output
    // microUSD per token. Quarter-micro units avoid floating-point ceil drift.
    const scaled = input ? input.input! * 5 + input.output! * 20 : NaN;
    const measured = input ? Number.isSafeInteger(scaled) ? Math.ceil(scaled / 4) : undefined : output?.cost;
    const billable = sent && !rejected;
    // No hard fixed-zero bypass for uncertain response execution. Soft unknown
    // ASR/response usage is explicitly unpriced, NOT evidence of free execution.
    const actual = !billable ? 0 : measured === undefined ? soft ? 0 : cost.reserveMicros : isInput ? measured : fixed ?? measured;
    const known = measured === undefined ? null : input ?? output;
    const event = { ...accounting.facts.event, occurred_at_ms: Date.now(),
      input_tokens: known?.input ?? null, output_tokens: known?.output ?? null, total_tokens: known?.total ?? null, cached_input_tokens: output?.cached ?? null,
      reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual,
      cost_basis: !billable ? 'none' : measured === undefined ? soft ? 'unpriced_usage' : 'realtime_full_context_bound' : isInput ? 'realtime_input_transcription_usage' : fixed != null ? 'policy_fixed' : 'realtime_modality_usage',
      status: (isInput ? input !== null && measured !== undefined : terminal?.response?.status === 'completed') ? 'success' as const : 'provider_error' as const,
      status_code: terminal ? 200 : null, duration_ms: Date.now() - accounting.facts.startedAtMs,
      realtime_usage: { unit_id: unitId, response_id: isInput ? null : id, output_cap: outputCap, ...(isInput ? { item_id: id } : {}), ...(output ? { text_input_tokens: output.textInput, audio_input_tokens: output.audioInput, cached_text_input_tokens: output.cachedText, cached_audio_input_tokens: output.cachedAudio, text_output_tokens: output.textOutput, audio_output_tokens: output.audioOutput } : {}) },
    };
    if (!await finalizeOwnedAccounting(sinks, reservation, actual, event)) throw new HttpError(503, 'realtime_accounting_unavailable', 'Realtime accounting failed');
  };
  return { settle: finish, forkInput() {
    if (!isInput || !soft || settled || forked || reservation.charges === undefined) throw new HttpError(503, 'realtime_input_ownership', 'Input admission cannot be split');
    forked = true;
    const child = accounting.fork();
    const charges = reservation.charges.map(({ objectName, request }) => ({ objectName, request: {
      ...request, chargeId: 'charge:' + child.facts.event.id + ':' + request.scopeKey + ':' + request.windowKey,
    } }));
    return ownedRealtimeUnit(child, { reservations: [], reservedMicros: 0, charges }, crypto.randomUUID(), sinks, options);
  } };
}
