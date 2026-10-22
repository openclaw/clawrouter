import { fundRealtimeUnit, type FundedInput } from './realtime-accounting';
import { authenticateProxyKey, proxyKeyVerification } from './proxy-auth';
import { prepareSelected } from './proxy';
import { providerById } from './providers';
import type { ProxySelection } from './proxy-selection';
import type { AuthorizedIdentity, Env } from './types';
import { HttpError, errorResponse } from './utils';
import { REALTIME } from './realtime-protocol';
import { RealtimeSession } from './realtime-session';
import { softBudget } from './soft-budget';

export async function proxyRealtimeWebSocket(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const auth = await authenticateProxyKey(request.headers, env, [{ id: 'openai', tokenRef: 'openai' }]);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url), models = url.searchParams.getAll('model');
  if (models.length !== 1 || (models[0] !== REALTIME.model && models[0] !== REALTIME.upstream) || [...url.searchParams.keys()].some(k => k !== 'model')) return errorResponse('realtime_model_unsupported', 'select openai/gpt-realtime-2.1; bounded GA audio only', 400);
  if (request.headers.has('origin') || request.headers.has('sec-websocket-protocol') || request.headers.has('openai-beta')) return errorResponse('realtime_server_auth_required', 'Realtime supports server-to-server GA bearer sessions only', 400);
  const provider = providerById('openai')!, endpoint = provider.endpoints.find(e => e.id === 'realtime')!, model = provider.models.find(m => m.id === REALTIME.model)!;
  if (!endpoint || !model) throw new HttpError(503, 'realtime_unconfigured', 'Realtime manifest contract is unavailable');
  const selection: ProxySelection = { provider, endpoint, model, body: { model: REALTIME.upstream }, capability: 'audio.realtime', method: 'GET', pathParams: {} };
  const inputModel = provider.models.find(m => m.id === 'openai/gpt-4o-mini-transcribe');
  const inputSelection: ProxySelection | null = inputModel ? { ...selection, model: inputModel, body: { model: inputModel.upstream }, capability: 'audio.transcription' } : null;
  let inputEnabled = false;
  const initial = await prepareSelected(request, env, selection, { model: REALTIME.upstream }, auth, new Set(), true, undefined, undefined, 'websocket');
  initial.url.searchParams.set('model', REALTIME.upstream);
  const soft = auth.policy.budgetMode === 'soft';
  if (!soft && [auth.policy.monthlyBudgetMicros, auth.policy.dailyBudgetMicros, auth.policy.weeklyBudgetMicros, initial.connection?.monthlyBudgetMicros].every(v => v == null)) throw new HttpError(400, 'realtime_hard_budget_required', 'Realtime hard mode requires a durable capacity owner');
  if (!initial.websocket) throw new HttpError(400, 'realtime_grant_unsupported', 'Realtime requires a qualified API-key upstream');
  // A retained conversation belongs to its original caller, not merely its
  // policy and upstream grant. Admin PUT can reassign a key without rotation.
  const caller = JSON.stringify([auth.authType, auth.credentialId, auth.principalId, auth.policy.tenantId ?? "default"]);
  const pin = { key: initial.grantKey, revision: initial.grantRevision };
  const fingerprint = JSON.stringify([initial.url.href, [...initial.headers.entries()]]);
  const inspect = async (input = false): Promise<{ auth: AuthorizedIdentity; upstream: typeof initial }> => {
    const fresh = await authenticateProxyKey(request.headers, env, [{ id: 'openai', tokenRef: 'openai' }]);
    if (fresh instanceof Response) throw new HttpError(fresh.status, 'realtime_authority_revoked', 'Realtime authority is no longer valid');
    if (JSON.stringify([fresh.authType, fresh.credentialId, fresh.principalId, fresh.policy.tenantId ?? "default"]) !== caller) throw new HttpError(403, 'realtime_caller_changed', 'open a fresh session');
    if (fresh.policyId !== auth.policyId || fresh.policy.generation !== auth.policy.generation) throw new HttpError(403, 'realtime_policy_changed', 'open a fresh session');
    const upstream = await prepareSelected(request, env, selection, { model: REALTIME.upstream }, fresh, new Set(), false, undefined, pin, 'websocket');
    upstream.url.searchParams.set('model', REALTIME.upstream);
    if ((fresh.policy.budgetMode === 'soft') !== soft) throw new HttpError(403, 'realtime_policy_changed', 'open a fresh session');
    if (!soft && [fresh.policy.monthlyBudgetMicros, fresh.policy.dailyBudgetMicros, fresh.policy.weeklyBudgetMicros, upstream.connection?.monthlyBudgetMicros].every(v => v == null)) throw new HttpError(400, 'realtime_hard_budget_required', 'Realtime requires a durable hard-budget capacity owner');
    if (!upstream.websocket || upstream.grantKey !== pin.key || upstream.grantRevision !== pin.revision || JSON.stringify([upstream.url.href, [...upstream.headers.entries()]]) !== fingerprint) throw new HttpError(403, 'realtime_route_changed', 'open a fresh session');
    if (input || inputEnabled) {
      if (!inputSelection) throw new HttpError(503, 'realtime_unconfigured', 'Input transcription model is not registered');
      // Same GA socket and pinned grant/account, but a DISTINCT model authority.
      // A realtime-only allowlist must not silently authorize the ASR model.
      const asr = await prepareSelected(request, env, inputSelection, {}, fresh, new Set(), false, upstream.connection, pin, 'websocket');
      if (!asr.websocket || asr.grantKey !== pin.key || asr.grantRevision !== pin.revision || JSON.stringify([...asr.headers.entries()]) !== JSON.stringify([...initial.headers.entries()])) throw new HttpError(403, 'realtime_route_changed', 'open a fresh session');
    }
    return { auth: fresh, upstream };
  };
  // Socket-local only. Measure freshness from observation START, not completion:
  // a slow RPC cannot mint a new stale lease. Funders/config/periodic guards
  // still check unconditionally; media alone may coalesce within 100ms (<5s).
  const mediaFreshMs = Math.min(100, REALTIME.guardMs);
  let authorityAt = -Infinity, budgetAt = -Infinity, mediaStarted = false;
  const check = async (input = false) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observation = inspect(input);
    context.waitUntil(observation.catch(() => undefined));
    try {
      const current = await Promise.race([observation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, 'realtime_authority_timeout', 'Realtime authority deadline exceeded')), REALTIME.guardMs); })]);
      authorityAt = Math.max(authorityAt, started); return current;
    }
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
    allowTranscription: soft,
    guardInput: async () => { await check(true); inputEnabled = true; },
    guardMedia: async (input, continuing) => {
      // A new ASR buffer has a mandatory fresh fundInput admission below.
      if (input && !continuing) { mediaStarted = true; return; }
      const started = performance.now();
      if (mediaStarted && started - authorityAt < mediaFreshMs && (!input || started - budgetAt < mediaFreshMs)) return;
      const current = await check(input);
      if (input) {
        const observation = softBudget(env, current.auth, 'audio.transcription', current.upstream.connection!, crypto.randomUUID(), () => undefined);
        context.waitUntil(observation.check);
        await observation.beforeDelivery(); observation.close();
        if (observation.denial) throw observation.denial;
        budgetAt = started;
      }
      mediaStarted = true;
    },
    async fundInput(unitId, signal) {
      const current = await check(true); signal.throwIfAborted();
      // The soft-budget observation inside funding starts here, after authority.
      // Stamping the earlier authority start would age the lease by that RPC and
      // force an immediate re-observation right after the first ASR byte.
      const started = performance.now();
      const unit = await fundRealtimeUnit({ request, env, context, auth: current.auth, selection: inputSelection!, connection: current.upstream.connection!, grantKey: pin.key!, grantLane: current.upstream.grantLane!, signal, unitId, outputCap: 0, input: true });
      budgetAt = Math.max(budgetAt, started);
      const wrap = (owner: typeof unit): FundedInput => ({
        settle: (terminal, sent, itemId) => owner.settle(terminal, sent, false, itemId),
        fork: () => wrap(owner.forkInput()),
      });
      return wrap(unit);
    },
    async fund(unitId, outputCap, signal) {
      const current = await check(); signal.throwIfAborted();
      return fundRealtimeUnit({ request, env, context, auth: current.auth, selection, connection: current.upstream.connection!, grantKey: pin.key!, grantLane: current.upstream.grantLane!, signal, unitId, outputCap });
    },
  });
  request.signal.addEventListener('abort', () => session.close('request_aborted'), { once: true });
  upstream.accept();
  if (request.signal.aborted) session.close('request_aborted');
  try { await check(); } catch (error) { session.close('admission_retired'); throw error; }
  return new Response(null, { status: 101, webSocket: pair[0], headers: { 'x-clawrouter-realtime-policy': soft ? 'proxy-vad-input-transcription-soft-v1' : 'manual-no-input-transcription-v1', 'x-clawrouter-content-retention': 'off' } });
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
