import { authorizeAdmin, verifiedAccessSession, verifiedUsageBinding, sessionPolicies } from "./access.ts";
import { readCompleteUsage, personalUsage } from "./usage-report.ts";
import { parseUsageReportRange, usageDateTools, reportRetentionMs } from "./usage-report-range.ts";
import { sameOrigin } from "./request-origin.ts";
import { privateJson, errorResponse, HttpError } from "./utils.ts";
import type { AccessSession, Env } from "./types.ts";
import type { CompleteUsageQuery, CompleteUsageOutcome } from "../shared/usage-report.ts";

type Kind = 'report' | 'events' | 'validate' | 'release';
function invalid(message: string): never { throw new HttpError(400, 'invalid_usage_query', message); }
/** Public syntax only; private addresses/authority are never caller inputs. */
export function parseCompleteUsageRequest(request: Request, kind: Kind, audience: 'admin' | 'personal', now = Date.now()) {
  const url = new URL(request.url), params = url.searchParams;
  if (new TextEncoder().encode(url.search).length > 8192) invalid('usage query exceeds 8 KiB');
  const allowed = kind === 'release' ? ['cut'] : ['from','to','days','timezone','grain','groupBy','rankBy','rankOffset','user','key','keyKind','model','provider','status','lane','costClass','intent','cut','cursor','limit'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('unsupported or repeated usage parameter');
  for (const [key,value] of params) if (!value || new TextEncoder().encode(value).length > (key === 'cut' || key === 'cursor' ? 43 : 512)) invalid('invalid usage parameter');
  const cut = params.get('cut') ?? undefined, cursor = params.get('cursor') ?? undefined;
  for (const handle of [cut,cursor]) if (handle !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(handle)) invalid('invalid opaque capability');
  const intent = params.get('intent') ?? 'summary';
  if (!['summary','browse','export'].includes(intent)) invalid('invalid report intent');
  if (kind !== 'report' && (!cut || params.has('intent')) || kind === 'report' && (cursor || intent === 'summary' && cut || intent === 'export' && cut)) invalid('invalid continuation');
  if (kind !== 'events' && (params.has('limit') || cursor)) invalid('pagination is only supported for events');
  if (audience === 'personal' && (params.has('user') || params.get('groupBy') === 'user')) invalid('personal owner is fixed');
  const range = parseUsageReportRange(params, now);
  const rawFrom = params.get('from');
  const requestedFrom = rawFrom ? (/^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? usageDateTools(range.timezone).midnight(rawFrom) : Date.parse(rawFrom)) : range.to - Number(params.get('days') ?? 7) * 86400000;
  const groupBy = params.get('groupBy') ?? (audience === 'admin' ? 'user' : 'model'), grain = params.get('grain') ?? 'day', rankBy = params.get('rankBy') ?? 'calls';
  if (!['user','model','provider','key'].includes(groupBy) || !['day','minute'].includes(grain) || !['calls','tokens','recordedAmount'].includes(rankBy) || grain === 'minute' && range.to-requestedFrom > 86400000) invalid('invalid grouping, rank or range');
  // The range parser already enforced calendar-vs-instant syntax and duration.
  // An autumn 30-calendar-day request may exceed 720h, but its excess is
  // necessarily outside retention (to <= now). Never widen private query bounds.
  const from = Math.max(requestedFrom, range.to-reportRetentionMs);
  if (from !== requestedFrom && (kind !== 'report' || cut)) invalid('continuations require effective bounds');
  const rankOffset = Number(params.get('rankOffset') ?? 0), pageSize = Number(params.get('limit') ?? 25);
  if (!Number.isSafeInteger(rankOffset) || rankOffset < 0 || rankOffset > 32768 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('invalid page bounds');
  const filters: CompleteUsageQuery['filters'] = {};
  for (const key of ['user','model','provider','status','lane','costClass'] as const) if (params.has(key)) filters[key] = params.get(key)!;
  if (filters.lane && !['api','subscription','unattributed'].includes(filters.lane) || filters.costClass && !['calculated','fixed','estimated','upper_bound','partial','unknown','no_charge'].includes(filters.costClass)) invalid('invalid classification');
  if (params.get('keyKind') === 'session') { if (params.has('key')) invalid('session key has no id'); filters.key = {kind:'session'}; }
  else if (params.has('key')) { if (params.has('keyKind') && params.get('keyKind') !== 'credential') invalid('invalid key kind'); filters.key = {kind:'credential',id:params.get('key')!}; }
  else if (params.has('keyKind')) invalid('credential id required');
  const query: CompleteUsageQuery = {from,to:range.to,timezone:range.timezone,grain:grain as CompleteUsageQuery['grain'],groupBy:groupBy as CompleteUsageQuery['groupBy'],rankBy:rankBy as CompleteUsageQuery['rankBy'],rankOffset,filters};
  return {kind,query,...(from !== requestedFrom ? {requestedFrom} : {}),...(kind === 'report' ? {intent:intent as 'summary'|'browse'|'export'} : {}),...(cut ? {cut} : {}),...(cursor ? {cursor} : {}),...(kind === 'events' ? {pageSize} : {})};
}
function outcomeResponse(outcome: CompleteUsageOutcome<unknown>): Response {
  if (outcome.kind === 'complete' || outcome.kind === 'no_access' || outcome.kind === 'outside_retained_range') return privateJson(outcome);
  const status = outcome.kind === 'restart' ? (['expired','evicted'].includes(outcome.reason) ? 410 : 409) : outcome.reason === 'capacity' ? 422 : 503;
  return privateJson({...outcome,error:{code:'usage_'+outcome.kind,message:outcome.kind === 'restart' ? 'Refresh required' : outcome.reason === 'capacity' ? 'Usage capacity unavailable; narrow the range or filters' : 'Usage unavailable; no complete result'}}, status);
}
/** Both route families use the existing verifier again at the final read boundary. */
export async function completeUsageResponse(request: Request, env: Env, audience: 'admin'|'personal', kind: Kind, initial: AccessSession): Promise<Response> {
  if (kind === 'release' && !sameOrigin(request,env)) return errorResponse('access_csrf_required','same-origin browser request required',403);
  const input = parseCompleteUsageRequest(request,kind,audience);
  let first: AccessSession | undefined = initial;
  const verify = async () => {
    const session = first ?? (audience === 'admin' ? await authorizeAdmin(request,env) : await verifiedAccessSession(request,env)); first = undefined;
    if (!session || session instanceof Response || audience === 'personal' && session.auth === 'admin_token') return null;
    const binding = await verifiedUsageBinding(session);
    return binding ? {session,...binding,audience} : null;
  };
  return outcomeResponse(await readCompleteUsage(env,verify,input,request.signal));
}
export async function sessionUsageReport(request: Request, env: Env, kind: Kind = 'report'): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session || session.auth === 'admin_token') return errorResponse('access_session_required','a verified session is required',401);
  const params = new URL(request.url).searchParams;
  // Existing callers keep their bare report/event and v1 cursor ABI. Complete
  // reports opt in with intent; their continuations carry a cut. Never retry a
  // malformed explicit complete request through the legacy parser.
  if ((kind === 'report' || kind === 'events') && !params.has('intent') && !params.has('cut')) {
    const policies = await sessionPolicies(session, env);
    return privateJson(await personalUsage(env, policies.map(p => ({ tenantId: p.policy.tenantId ?? 'default', policyId: p.policyId })), session.email, params, kind === 'events'));
  }
  return completeUsageResponse(request,env,'personal',kind,session);
}
