import { emptyReservation, finalizeAccounting, markBudgetDispatched, reserveBudget } from './accounting';
import { authenticateProxyKey, proxyKeyVerification } from './proxy-auth';
import { createProxyAccounting } from './proxy-accounting';
import { prepareSelected } from './proxy';
import { providerById } from './providers';
import type { ProxySelection } from './proxy-selection';
import type { AuthorizedIdentity, Env } from './types';
import { HttpError, errorResponse } from './utils';
import { REALTIME, parseRealtimeUsage } from './realtime-protocol';
import { RealtimeSession } from './realtime-session';

export async function proxyRealtimeWebSocket(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const auth = await authenticateProxyKey(request.headers, env, [{ id: 'openai', tokenRef: 'openai' }]);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url), models = url.searchParams.getAll('model');
  if (models.length !== 1 || (models[0] !== REALTIME.model && models[0] !== REALTIME.upstream) || [...url.searchParams.keys()].some(k => k !== 'model')) return errorResponse('realtime_model_unsupported', 'select openai/gpt-realtime-2.1; manual GA audio only', 400);
  if (request.headers.has('origin') || request.headers.has('sec-websocket-protocol') || request.headers.has('openai-beta')) return errorResponse('realtime_server_auth_required', 'Realtime supports server-to-server GA bearer sessions only', 400);
  const provider = providerById('openai')!, endpoint = provider.endpoints.find(e => e.id === 'realtime')!, model = provider.models.find(m => m.id === REALTIME.model)!;
  if (!endpoint || !model) throw new HttpError(503, 'realtime_unconfigured', 'Realtime manifest contract is unavailable');
  const selection: ProxySelection = { provider, endpoint, model, body: { model: REALTIME.upstream }, capability: 'audio.realtime', method: 'GET', pathParams: {} };
  const initial = await prepareSelected(request, env, selection, { model: REALTIME.upstream }, auth, new Set(), true, undefined, undefined, 'websocket');
  initial.url.searchParams.set('model', REALTIME.upstream);
  if (auth.policy.budgetMode === 'soft' || [auth.policy.monthlyBudgetMicros, auth.policy.dailyBudgetMicros, auth.policy.weeklyBudgetMicros, initial.connection?.monthlyBudgetMicros].every(v => v == null)) throw new HttpError(400, 'realtime_hard_budget_required', 'Realtime requires a durable hard-budget capacity owner');
  if (!initial.websocket) throw new HttpError(400, 'realtime_grant_unsupported', 'Realtime requires a qualified API-key upstream');
  // A retained conversation belongs to its original caller, not merely its
  // policy and upstream grant. Admin PUT can reassign a key without rotation.
  const caller = JSON.stringify([auth.authType, auth.credentialId, auth.principalId, auth.policy.tenantId ?? "default"]);
  const pin = { key: initial.grantKey, revision: initial.grantRevision };
  const fingerprint = JSON.stringify([initial.url.href, [...initial.headers.entries()]]);
  const inspect = async (): Promise<{ auth: AuthorizedIdentity; upstream: typeof initial }> => {
    const fresh = await authenticateProxyKey(request.headers, env, [{ id: 'openai', tokenRef: 'openai' }]);
    if (fresh instanceof Response) throw new HttpError(fresh.status, 'realtime_authority_revoked', 'Realtime authority is no longer valid');
    if (JSON.stringify([fresh.authType, fresh.credentialId, fresh.principalId, fresh.policy.tenantId ?? "default"]) !== caller) throw new HttpError(403, 'realtime_caller_changed', 'open a fresh session');
    if (fresh.policyId !== auth.policyId || fresh.policy.generation !== auth.policy.generation) throw new HttpError(403, 'realtime_policy_changed', 'open a fresh session');
    const upstream = await prepareSelected(request, env, selection, { model: REALTIME.upstream }, fresh, new Set(), false, undefined, pin, 'websocket');
    upstream.url.searchParams.set('model', REALTIME.upstream);
    if (fresh.policy.budgetMode === 'soft' || [fresh.policy.monthlyBudgetMicros, fresh.policy.dailyBudgetMicros, fresh.policy.weeklyBudgetMicros, upstream.connection?.monthlyBudgetMicros].every(v => v == null)) throw new HttpError(400, 'realtime_hard_budget_required', 'Realtime requires a durable hard-budget capacity owner');
    if (!upstream.websocket || upstream.grantKey !== pin.key || upstream.grantRevision !== pin.revision || JSON.stringify([upstream.url.href, [...upstream.headers.entries()]]) !== fingerprint) throw new HttpError(403, 'realtime_route_changed', 'open a fresh session');
    return { auth: fresh, upstream };
  };
  const check = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observation = inspect();
    context.waitUntil(observation.catch(() => undefined));
    try { return await Promise.race([observation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, 'realtime_authority_timeout', 'Realtime authority deadline exceeded')), REALTIME.guardMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const response = await connectRealtime(initial.url, initial.headers, request.signal, promise => context.waitUntil(promise));
  if (response.status !== 101 || !response.webSocket) {
    await response.body?.cancel(); return errorResponse('realtime_upstream_upgrade_failed', 'Realtime upstream rejected the upgrade', response.status >= 400 ? response.status : 502);
  }
  const upstream = response.webSocket;
  // Attach and accept under the bounded owner before awaiting authority.
  // Otherwise startup frames accumulate outside its queue during that RPC.
  const pair = new WebSocketPair(); pair[1].accept();
  const session = new RealtimeSession(pair[1], upstream, {
    waitUntil: promise => context.waitUntil(promise),
    guard: async () => { await check(); },
    expiresAt: proxyKeyVerification(auth)?.expiresAt ? Date.parse(proxyKeyVerification(auth)!.expiresAt!) : undefined,
    async fund(unitId, outputCap, signal) {
      const current = await check(); signal.throwIfAborted();
      // Full context and enforced output. No cache discount or byte estimate.
      const cost = { reserveMicros: Math.max(REALTIME.reservation, current.auth.policy.requestCostMicros ?? 0), basis: 'realtime_full_context_bound', inputTokens: REALTIME.context, outputTokens: REALTIME.output };
      const accounting = createProxyAccounting({ request, env, context, auth: current.auth, selection, cost, grantKey: pin.key, grantLane: current.upstream.grantLane });
      let reservation = emptyReservation();
      try {
        reservation = await reserveBudget(env, current.auth, selection.capability, cost, current.upstream.connection);
        signal.throwIfAborted();
        await markBudgetDispatched(env, reservation, signal); signal.throwIfAborted();
      } catch (error) {
        if (!await accounting.settle(503, 'provider_error', false, null, reservation, null)) throw new HttpError(503, 'realtime_accounting_unavailable', 'Realtime accounting failed');
        throw error;
      }
      let settled = false;
      return { async settle(terminal, sent, rejected, responseId) {
        if (settled) return; settled = true;
        const usage = terminal ? parseRealtimeUsage(terminal.response?.usage, outputCap) : null;
        const billable = sent && !rejected;
        const fixed = current.auth.policy.requestCostMicros;
        // This lane's qualified missing-usage hold is mandatory even for a
        // fixed-zero policy; a policy tariff does not prove vendor nonexecution.
        const actual = !billable ? 0 : !usage ? cost.reserveMicros : fixed ?? usage.cost;
        const event = { ...accounting.facts.event, occurred_at_ms: Date.now(),
          input_tokens: usage?.input ?? null, output_tokens: usage?.output ?? null, total_tokens: usage?.total ?? null, cached_input_tokens: usage?.cached ?? null,
          reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual,
          cost_basis: !billable ? 'none' : !usage ? 'realtime_full_context_bound' : fixed != null ? 'policy_fixed' : 'realtime_modality_usage',
          status: terminal?.response?.status === 'completed' ? 'success' as const : 'provider_error' as const, status_code: terminal ? 200 : null, duration_ms: Date.now() - accounting.facts.startedAtMs,
          realtime_usage: { unit_id: unitId, response_id: responseId, output_cap: outputCap, ...(usage ? { text_input_tokens: usage.textInput, audio_input_tokens: usage.audioInput, cached_text_input_tokens: usage.cachedText, cached_audio_input_tokens: usage.cachedAudio, text_output_tokens: usage.textOutput, audio_output_tokens: usage.audioOutput } : {}) },
        };
        if (!await finalizeAccounting(env, reservation, actual, event)) throw new HttpError(503, 'realtime_accounting_unavailable', 'Realtime accounting failed');
      } };
    },
  });
  request.signal.addEventListener('abort', () => session.close('request_aborted'), { once: true });
  upstream.accept();
  if (request.signal.aborted) session.close('request_aborted');
  try { await check(); } catch (error) { session.close('admission_retired'); throw error; }
  return new Response(null, { status: 101, webSocket: pair[0], headers: { 'x-clawrouter-realtime-policy': 'manual-no-input-transcription-v1', 'x-clawrouter-content-retention': 'off' } });
}

// Fetch cancellation is not an attestation that a late upgrade cannot arrive.
// The losing response remains owned and is explicitly retired, never reused.
export async function connectRealtime(url: URL, headers: Headers, parent: AbortSignal, waitUntil: (p: Promise<unknown>) => void, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  let retired = false;
  const pending = fetcher(url, { headers: new Headers([...headers, ['upgrade', 'websocket']]), signal, redirect: 'manual' });
  const retire = async (r: Response): Promise<void> => {
    try { r.webSocket?.accept(); r.webSocket?.close(1008, 'Connect retired'); await r.body?.cancel(); } catch { /* Peer already retired. */ }
  };
  let abort!: () => void;
  const stop = new Promise<never>((_, reject) => {
    abort = () => { retired = true; reject(new HttpError(504, 'realtime_connect_timeout', 'Realtime connection retired before admission')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  waitUntil(pending.then(r => { if (retired) return retire(r); }).catch(() => undefined));
  try { return await Promise.race([pending, stop]); }
  catch (error) { retired = true; controller.abort(); throw error; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
