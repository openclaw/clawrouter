import type { PersonalUsageEvents, PersonalUsageReport, PersonalUsageEvent, UsageCostSummary, UsageGroupBy, UsageMetrics, UsageReportGroup } from "../shared/usage-report.ts";
import { usageStub } from "./ledgers.ts";
import type { Env } from "./types.ts";
import { HttpError, normalizeEmail } from "./utils.ts";
import { parseUsageReportRange } from "./usage-report-range.ts";
import { emptyUsageMetrics, usageMetricKeys, type UsageAggregateRow, type UsageEventPosition, type UsageReportQuery, type UsageReportShard, type UsageReportMigrationOptions, type UsageReportMigrationEffect, type UsageReportHistory } from "./usage-report-store.ts";

const filterNames = ["model", "provider", "key", "status", "costClass", "lane"] as const;
const classes = new Set(["calculated", "fixed", "estimated", "upper_bound", "partial", "unknown", "no_charge"]);
const lanes = new Set(["api", "subscription", "unattributed"]);
function invalid(message: string): never { throw new HttpError(400, "invalid_usage_query", message); }
export function parseUsageReportQuery(params: URLSearchParams, now = Date.now()) {
  for (const key of params.keys()) if (!["from", "to", "days", "timezone", "groupBy", "cursor", "limit", ...filterNames].includes(key)) invalid("unsupported usage parameter: " + key);
  for (const key of params.keys()) if (params.getAll(key).length > 1) invalid("duplicate usage parameters are not allowed");
  const groupBy = params.get("groupBy") ?? "model";
  if (!["model", "provider", "key"].includes(groupBy)) invalid("groupBy must be model, provider, or key");
  const filters: UsageReportQuery["filters"] = {};
  for (const name of filterNames) { const value = params.get(name); if (value !== null) { if (!value || value.length > 512) invalid("invalid exact filter"); filters[name] = value; } }
  if (filters.costClass && !classes.has(filters.costClass) || filters.lane && !lanes.has(filters.lane)) invalid("invalid cost classification");
  const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be 1..100");
  return { range: parseUsageReportRange(params, now), groupBy: groupBy as UsageGroupBy, filters, limit };
}
interface Policy { tenantId: string; policyId: string }
interface Cursor { v: 1; binding: string; position: UsageEventPosition & { shard: string }; now: number }
function decodeCursor(value: string): Cursor {
  if (value.length > 16384) invalid("invalid usage cursor");
  try {
    const cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)))) as Cursor;
    if (cursor.v !== 1 || typeof cursor.binding !== "string" || !Number.isSafeInteger(cursor.now) || !Number.isSafeInteger(cursor.position?.at) || typeof cursor.position?.id !== "string" || !cursor.position.id || cursor.position.id.length > 8192 || typeof cursor.position.shard !== "string" || cursor.position.shard.length > 1200) invalid("invalid usage cursor");
    return cursor;
  } catch { return invalid("invalid usage cursor"); }
}
function encodeCursor(cursor: Cursor): string { return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), b => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function cursorBinding(principal: string, policies: Policy[], query: ReturnType<typeof parseUsageReportQuery>): Promise<string> {
  const scope = policies.map(p => [p.tenantId, p.policyId]).sort((a, b) => compareUsageIds(JSON.stringify(a), JSON.stringify(b)));
  const data = JSON.stringify([principal, scope, query.range.from, query.range.to, query.range.timezone, query.groupBy, query.filters]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
/** Max eight concurrent shard calls; any rejected/non-2xx shard rejects the whole read. */
export async function mapUsageShards<T>(policies: Policy[], fetchShard: (policy: Policy) => Promise<T>): Promise<T[]> {
  const unique = [...new Map(policies.map(p => [JSON.stringify([p.tenantId, p.policyId]), p])).values()];
  const results = new Array<T>(unique.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, unique.length) }, async () => { while (index < unique.length) { const i = index++; results[i] = await fetchShard(unique[i]); } }));
  return results;
}
function safeSum(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || !Number.isSafeInteger(value)) throw new HttpError(422, "usage_range_too_large", "usage totals exceed exact numeric bounds; choose a narrower range or filter");
  return value;
}
function addMetrics(target: UsageMetrics, source: UsageMetrics) { for (const key of usageMetricKeys) target[key] = safeSum(target[key], source[key]); }
function addCost(target: UsageCostSummary[], row: Pick<UsageAggregateRow, "lane" | "costClass" | "calls" | "amountMicros">) {
  let cost = target.find(c => c.lane === row.lane && c.costClass === row.costClass);
  if (!cost) { cost = { lane: row.lane, costClass: row.costClass, calls: 0, amountMicros: 0 }; target.push(cost); }
  cost.calls = safeSum(cost.calls, row.calls); cost.amountMicros = safeSum(cost.amountMicros, row.amountMicros);
}
// SQLite BINARY is UTF-8 ordering, not locale ordering (nor UTF-16 for astral characters).
export function compareUsageIds(a: string, b: string): number {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export function mergeUsageReports(shards: UsageReportShard[], query: ReturnType<typeof parseUsageReportQuery>, now = Date.now()): PersonalUsageReport {
  const report: PersonalUsageReport = { range: query.range, groupBy: query.groupBy, metrics: emptyUsageMetrics(), costs: [], groups: [], buckets: query.range.buckets.map(b => ({ ...b, metrics: emptyUsageMetrics(), costs: [] })), groupsTruncated: shards.some(s => s.groupsTruncated), historyComplete: shards.every(s => s.historyComplete), projectionComplete: shards.every(s => s.projectionComplete !== false), historySource: shards.some(s => s.historySource === "retained_ledger") ? "retained_ledger" : "projection", generatedAt: now };
  const groups = new Map<string | null, UsageReportGroup>();
  for (const shard of shards) for (const row of shard.rows) {
    if (row.dimension === "total") { addMetrics(report.metrics, row); addCost(report.costs, row); }
    else if (row.dimension === "bucket") { const bucket = report.buckets[Number(row.value)]; if (bucket) { addMetrics(bucket.metrics, row); addCost(bucket.costs, row); } }
    else if (row.dimension === "group") {
      const value = row.value === null ? null : String(row.value);
      let group = groups.get(value);
      if (!group) { group = { value, metrics: emptyUsageMetrics(), costs: [] }; groups.set(value, group); }
      addMetrics(group.metrics, row); addCost(group.costs, row);
    }
  }
  report.groupsTruncated ||= groups.size > 100;
  report.groups = [...groups.values()].sort((a, b) => a.value === null ? b.value === null ? 0 : -1 : b.value === null ? 1 : compareUsageIds(a.value, b.value)).slice(0, 100);
  return report;
}
interface EventShard extends UsageReportHistory { shard?: string; events: PersonalUsageEvent[] }
export function mergeUsageEvents(shards: EventShard[], limit: number) {
  const ordered = shards.flatMap(s => s.events.map(event => ({ event, shard: s.shard ?? "" }))).sort((a, b) => b.event.occurredAt - a.event.occurredAt || compareUsageIds(b.event.id, a.event.id) || compareUsageIds(b.shard, a.shard));
  const selected = ordered.slice(0, limit), last = selected.at(-1);
  return { events: selected.map(row => row.event), lastShard: last?.shard, hasMore: ordered.length > limit, historyComplete: shards.every(s => s.historyComplete), projectionComplete: shards.every(s => s.projectionComplete !== false), historySource: shards.some(s => s.historySource === "retained_ledger") ? "retained_ledger" as const : "projection" as const };
}
/** Principal and policy scope are arguments supplied exclusively by verified session authority. */
export async function personalUsage(env: Env, policies: Policy[], principalId: string, params: URLSearchParams, events = false, now = Date.now()): Promise<PersonalUsageReport | PersonalUsageEvents> {
  const principal = normalizeEmail(principalId);
  if (!principal) throw new HttpError(401, "access_session_required", "a verified session principal is required");
  const cursor = params.has("cursor") ? decodeCursor(params.get("cursor")!) : null;
  if (cursor && !events) invalid("cursor is only supported for events");
  if (cursor && (cursor.now > now || now - cursor.now > 30 * 86_400_000)) invalid("usage cursor has expired");
  const query = parseUsageReportQuery(params, cursor?.now ?? now);
  const binding = await cursorBinding(principal, policies, query);
  if (cursor && cursor.binding !== binding) invalid("cursor does not match this owner and query");
  // Retention continues advancing during pagination. Keep query binding anchored, clip only SQL execution.
  const sqlRange = { ...query.range, from: Math.min(query.range.to, Math.max(query.range.from, now - 30 * 86_400_000)) };
  const shards = await mapUsageShards(policies, async policy => {
    const shard = JSON.stringify([policy.tenantId, policy.policyId]);
    const request: UsageReportQuery = { ...query, range: sqlRange, principal, ...policy };
    const response = await usageStub(env, policy.tenantId, policy.policyId).fetch("https://clawrouter.internal/" + (events ? "personal-events" : "personal-report"), { method: "POST", body: JSON.stringify({ query: request, limit: query.limit, before: cursor?.position, includeEqualId: cursor ? compareUsageIds(shard, cursor.position.shard) < 0 : false }) });
    if (!response.ok) throw new HttpError(503, "usage_report_unavailable", "personal usage is unavailable; retry later");
    const result = await response.json<UsageReportShard | EventShard>();
    return events ? { ...result, shard } : result;
  });
  if (!events) return mergeUsageReports(shards as UsageReportShard[], query, now);
  const merged = mergeUsageEvents(shards as EventShard[], query.limit), last = merged.events.at(-1);
  return { events: merged.events, historyComplete: merged.historyComplete, projectionComplete: merged.projectionComplete, historySource: merged.historySource, nextCursor: merged.hasMore && last ? encodeCursor({ v: 1, binding, now: cursor?.now ?? now, position: { at: last.occurredAt, id: last.id, shard: merged.lastShard! } }) : null };
}

/** Operator/private tooling only: deliberately not wired to any public route.
 * Defaults to a dry-run; call each batch explicitly, with separate apply authorization. */
export async function migrateUsageReportShard(env: Env, policy: Policy, options: UsageReportMigrationOptions = {}) {
  const response = await usageStub(env, policy.tenantId, policy.policyId).fetch("https://clawrouter.internal/reporting-migration", { method: "POST", body: JSON.stringify(options) });
  if (!response.ok) throw new HttpError(503, "usage_migration_unavailable", "reporting migration did not acknowledge a batch");
  return response.json<{ dryRun: boolean; examined: number; projected: number; lastRowid: number; upperRowid: number; complete: boolean; previouslyComplete: boolean; effects: UsageReportMigrationEffect[] }>();
}

// Unit3 private service. No public route is switched here. Unit4 supplies the
// existing verifier and verified-session binding accessor; synthetic callers in
// tests prove mechanics, NOT authentication. Scope is resolved here, never input.
import type { AccessSession } from './types.ts';
import type { CompleteUsageQuery, CompleteUsageReport, CompleteUsageEvents, CompleteUsageEvent, CompleteUsageOutcome, UsageAdditives, CompleteUsageGroup, UsageGroupIdentity, UsageCoverage } from '../shared/usage-report.ts';
import type { UsageVisibilityCut } from './usage-report-visibility.ts';
import { UsageVisibilityError } from './usage-report-visibility.ts';
import { completeUsageLimits as limits, completeUsageBuckets, validateCompleteUsageQuery, usageJsonBytes, type UsageShardInput, type UsageShardResult, type UsageCandidateSize, type UsageGroupPage, type CompleteAggregateRow } from './usage-report-store.ts';
import { sha256Hex } from './utils.ts';
interface VerifiedUsageCaller { session: AccessSession; actor: string; sessionBinding: string; audience: 'admin' | 'personal' }
type UsageVerifier = () => Promise<VerifiedUsageCaller | null>;
interface CompleteRead {
  kind: 'report' | 'events' | 'validate' | 'release'; query: CompleteUsageQuery;
  intent?: 'summary' | 'browse' | 'export'; cut?: string; cursor?: string; pageSize?: number;
}
interface PrivateBinding { actor: string; session: string; authority: string }
interface PrivateVector extends Policy { cut: UsageVisibilityCut }
interface PrivateCapture { vector: PrivateVector[]; effectiveFrom: number; capturedBetween: { from: number; to: number } }
interface InventoryEvidence { revision: string; captureAudit: UsageCoverage['captureAudit']; addresses?: Policy[] }
interface ResolvedUsage { binding: PrivateBinding; addresses: Policy[]; inventory: InventoryEvidence; personal: boolean; owner?: string }
type Failure = Exclude<CompleteUsageOutcome<never>,{kind:'complete'}>;
class CompleteFailure extends Error { readonly outcome: Failure; constructor(outcome: Failure) { super(outcome.kind); this.outcome=outcome; } }
function failComplete(kind: 'restart' | 'unavailable', reason: string): never { throw new CompleteFailure({kind,reason} as Failure); }
function nonnegative(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) failComplete('unavailable','capacity'); }
function stable(value: unknown): string { return JSON.stringify(value,(_k,v)=>v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v); }
function identityCompare(a: UsageGroupIdentity, b: UsageGroupIdentity): number {
  for (const key of ['owner','value'] as const) { const x=a[key],y=b[key]; if(x===y)continue; if(x===null)return -1;if(y===null)return 1;return compareUsageIds(x,y); } return 0;
}
function emptyAdditives(): UsageAdditives { return {metrics:emptyUsageMetrics(),recordedChargeMicros:0,chargeReportedCalls:0,costs:[]}; }
function addAdditives(target: UsageAdditives, source: UsageAdditives): void {
  addMetrics(target.metrics,source.metrics); target.recordedChargeMicros=safeSum(target.recordedChargeMicros,source.recordedChargeMicros); target.chargeReportedCalls=safeSum(target.chargeReportedCalls,source.chargeReportedCalls);
  for(const cost of source.costs) addCost(target.costs,cost);
  target.costs.sort((a,b)=>compareUsageIds(a.lane,b.lane)||compareUsageIds(a.costClass,b.costClass));
}
function rowAdditives(row: CompleteAggregateRow): UsageAdditives {
  if(!lanes.has(row.lane)||!classes.has(row.costClass))failComplete('unavailable','source');
  for(const key of [...usageMetricKeys,'recordedChargeMicros','chargeReportedCalls','amountMicros'] as const)nonnegative(row[key]);
  return {metrics:Object.fromEntries(usageMetricKeys.map(k=>[k,row[k]])) as unknown as UsageMetrics,
    recordedChargeMicros:row.recordedChargeMicros,chargeReportedCalls:row.chargeReportedCalls,
    costs:[{lane:row.lane,costClass:row.costClass,calls:row.calls,amountMicros:row.amountMicros}]};
}
function remainderOf(total: UsageAdditives, selected: UsageAdditives[]): UsageAdditives {
  const remainder=structuredClone(total), minus=(a:number,b:number)=>{nonnegative(a);nonnegative(b);if(b>a)failComplete('unavailable','source');return a-b;};
  for(const row of selected){for(const key of usageMetricKeys)remainder.metrics[key]=minus(remainder.metrics[key],row.metrics[key]);
    remainder.recordedChargeMicros=minus(remainder.recordedChargeMicros,row.recordedChargeMicros);remainder.chargeReportedCalls=minus(remainder.chargeReportedCalls,row.chargeReportedCalls);
    for(const cost of row.costs){const c=remainder.costs.find(c=>c.lane===cost.lane&&c.costClass===cost.costClass);if(!c)failComplete('unavailable','source');c.calls=minus(c.calls,cost.calls);c.amountMicros=minus(c.amountMicros,cost.amountMicros);}}
  remainder.costs=remainder.costs.filter(c=>c.calls!==0||c.amountMicros!==0);return remainder;
}
function equalAdditives(a: UsageAdditives,b: UsageAdditives): boolean { return stable(a)===stable(b); }
/** One request-local budget. Reservations happen synchronously before fan-out;
 * a failed peer stops new calls, then every already-issued peer is collected. */
class CompleteOperation {
  calls=0;visits=0;bytes=0;stopped=false;
  private controller=new AbortController();private timer:ReturnType<typeof setTimeout>;private deadline=performance.now()+20000;
  readonly signal:AbortSignal;
  constructor(signal?:AbortSignal){this.signal=signal?AbortSignal.any([signal,this.controller.signal]):this.controller.signal;this.timer=setTimeout(()=>this.controller.abort(),20000);}
  close(){clearTimeout(this.timer);}
  check(){if(performance.now()>=this.deadline)this.controller.abort();if(this.stopped||this.signal.aborted)failComplete('unavailable','cancelled');}
  charge(count=1){this.check();this.calls+=count;if(this.calls>limits.calls)failComplete('unavailable','capacity');}
  work(size:UsageCandidateSize){this.check();nonnegative(size.rows);nonnegative(size.bytes);this.visits=safeSum(this.visits,size.rows);this.bytes=safeSum(this.bytes,size.bytes);if(this.visits>limits.visits||this.bytes>limits.classifiedBytes)failComplete('unavailable','capacity');}
  async call<T>(stub:DurableObjectStub,path:string,input:unknown):Promise<T>{
    this.charge();
    if(usageJsonBytes(input)>limits.pageBytes)failComplete('unavailable','capacity');
    const response=await stub.fetch('https://clawrouter.internal'+path,{method:'POST',body:JSON.stringify(input),signal:this.signal});
    const reader=response.body?.getReader();if(!reader)failComplete('unavailable','source');
    let size=0;const chunks:Uint8Array[]=[];
    try{while(true){this.check();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limits.pageBytes)failComplete('unavailable','capacity');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    this.check();if(!response.ok){if(response.status===409||response.status===410)failComplete('restart','evicted');if(response.status===422)failComplete('unavailable','capacity');failComplete('unavailable','source');}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;
  }
  async map<T,R>(items:T[],run:(item:T,index:number)=>Promise<R>):Promise<R[]>{
    let next=0,failed:unknown;const results=new Array<R>(items.length);
    await Promise.all(Array.from({length:Math.min(limits.fanout,items.length)},async()=>{while(next<items.length&&!this.stopped){const i=next++;try{this.check();results[i]=await run(items[i],i);}catch(e){failed??=e;this.stopped=true;}}}));
    if(failed)throw failed;this.check();return results;
  }
}
function authorityStub(env:Env){return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));}
async function resolveCompleteAuthority(env:Env,verify:UsageVerifier,op:CompleteOperation):Promise<ResolvedUsage>{
  op.check();const caller=await verify();op.check();
  if(!caller||!['admin','personal'].includes(caller.audience)||caller.audience==='admin'&&caller.session.role!=='admin')failComplete('restart','authority');
  if(!/^[a-f0-9]{64}$/.test(caller.actor)||!/^[a-f0-9]{64}$/.test(caller.sessionBinding))failComplete('restart','authority');
  const personal=caller.audience==='personal',owner=personal?normalizeEmail(caller.session.email):undefined;
  if(personal&&!owner)failComplete('restart','authority');
  // Personal authority keeps its existing bounded policy resolver. Evidence-only
  // inventory read must not initialize or enumerate all other users' policies.
  // Existing bounded resolver uses at most three calls each for bindings and
  // policies (resolve, optional initialize, resolve); reserve all six first.
  if(personal)op.charge(6);
  const entries=personal?await (await import('./access.ts')).sessionPolicies(caller.session,env):null;op.check();
  const inventory=await op.call<InventoryEvidence>(authorityStub(env),personal?'/usage-inventory-evidence':'/usage-inventory',{});
  if(!inventory||!/^[a-f0-9]{32}$/.test(inventory.revision)||!inventory.captureAudit)failComplete('unavailable','source');
  nonnegative(inventory.captureAudit.startedAt);nonnegative(inventory.captureAudit.verifiedSince);
  if(typeof inventory.captureAudit.captureGapObserved!=='boolean')failComplete('unavailable','source');
  const input=entries?entries.map(p=>({tenantId:p.policy.tenantId??'default',policyId:p.policyId})):inventory.addresses;
  if(!Array.isArray(input))failComplete('unavailable','source');
  for(const p of input)if(!p||typeof p.tenantId!=='string'||typeof p.policyId!=='string'||new TextEncoder().encode(p.tenantId+p.policyId).length>2048)failComplete('unavailable','source');
  const addresses=[...new Map(input.map(p=>[stable(p),p])).values()].sort((a,b)=>compareUsageIds(a.tenantId,b.tenantId)||compareUsageIds(a.policyId,b.policyId));
  if(addresses.length>limits.shards)failComplete('unavailable','capacity');
  const authority=await sha256Hex(stable({role:caller.session.role,owner,addresses,revision:inventory.revision,audit:inventory.captureAudit}));
  op.check();return {personal,owner:owner??undefined,addresses,inventory,binding:{actor:caller.actor,session:caller.sessionBinding,authority}};
}
async function shardCall<T>(env:Env,op:CompleteOperation,p:Policy,input:Omit<UsageShardInput,'tenantId'|'policyId'>):Promise<T>{
  const r=await op.call<UsageShardResult>(usageStub(env,p.tenantId,p.policyId),'/complete-usage',{...input,...p});
  if(r?.kind==='restart'||r?.kind==='unavailable')failComplete(r.kind,r.reason);
  if(r?.kind!=='complete')failComplete('unavailable','source');return r.value as T;
}
function checkSize(sizes:UsageCandidateSize[]):void{
  let rows=0,bytes=0;for(const size of sizes){nonnegative(size.rows);nonnegative(size.bytes);if(size.rows>limits.candidateRows)failComplete('unavailable','capacity');rows=safeSum(rows,size.rows);bytes=safeSum(bytes,size.bytes);}
  if(rows>limits.totalRows||bytes>limits.inputBytes)failComplete('unavailable','capacity');
}
async function finalValidation(env:Env,verify:UsageVerifier,op:CompleteOperation,resolved:ResolvedUsage,capture:PrivateCapture,query:CompleteUsageQuery){
  await op.map(capture.vector,p=>shardCall<{valid:true}>(env,op,p,{action:'validate',query,cut:p.cut}).then(r=>{if(r.valid!==true)failComplete('unavailable','source');}));
  const current=await resolveCompleteAuthority(env,verify,op);
  if(stable(current.binding)!==stable(resolved.binding))failComplete('restart','authority');
}
function coverageFor(r:ResolvedUsage,c:PrivateCapture,base:CompleteUsageQuery):UsageCoverage{
  return {authority:r.personal?'current_access':'admin_retained',scope:r.personal?'personal_current_access':'admin_current_plus_tracked_retired',
    discoveredScopeEnumeration:'complete',allDiscoveredSourcesAnswered:true,retainedAttributionComplete:true,
    historicalLocations:'not_exhaustively_assessed',formerLocationLateWrites:'not_bounded',captureAudit:r.inventory.captureAudit,
    effectiveFrom:c.effectiveFrom,clippedFrom:c.effectiveFrom>base.from?base.from:null,capturedBetween:c.capturedBetween};
}
async function completeGroups(env:Env,op:CompleteOperation,capture:PrivateCapture,query:CompleteUsageQuery,sizes:UsageCandidateSize[]):Promise<Omit<CompleteUsageReport,'cut'|'coverage'>>{
  checkSize(sizes);const total=emptyAdditives(),groups=new Map<string,CompleteUsageGroup>();let groupBytes=0;
  const buckets=completeUsageBuckets(query).map(b=>({...b,...emptyAdditives()}));
  await op.map(capture.vector,async(p,i)=>{
    let after:UsageGroupIdentity|undefined;
    do{
      op.work(sizes[i]);const page=await shardCall<UsageGroupPage>(env,op,p,{action:'groups',query,cut:p.cut,after,allowance:sizes[i]});
      if(!Array.isArray(page.rows)||!page.work||page.work.rows>sizes[i].rows||page.work.bytes>sizes[i].bytes)failComplete('unavailable','source');
      for(const row of page.rows){const values=rowAdditives(row);
        if(row.dimension==='total'){if(after)failComplete('unavailable','source');addAdditives(total,values);}
        else if(row.dimension==='bucket'){const bucket=buckets[Number(row.value)];if(after||!bucket)failComplete('unavailable','source');addAdditives(bucket,values);}
        else if(row.dimension==='group'){
          if(row.owner!==null&&typeof row.owner!=='string'||row.value!==null&&typeof row.value!=='string')failComplete('unavailable','source');
          const identity={owner:row.owner,value:row.value as string|null};if(after&&identityCompare(identity,after)<=0)failComplete('unavailable','source');
          const key=stable(identity),previous=groups.get(key),group=previous??{identity,...emptyAdditives()};
          const old=previous?usageJsonBytes(group)+new TextEncoder().encode(key).length:0;
          addAdditives(group,values);groupBytes+=usageJsonBytes(group)+new TextEncoder().encode(key).length-old;groups.set(key,group);
          if(groups.size>limits.groups||groupBytes>limits.groupBytes)failComplete('unavailable','capacity');
        }else failComplete('unavailable','source');
      }
      if(page.next&&after&&identityCompare(page.next,after)<=0)failComplete('unavailable','source');
      after=page.next??undefined;
    }while(after);
  });
  const all=[...groups.values()],groupTotal=emptyAdditives(),bucketTotal=emptyAdditives();
  for(const g of all)addAdditives(groupTotal,g);for(const b of buckets)addAdditives(bucketTotal,b);
  if(!equalAdditives(total,groupTotal)||!equalAdditives(total,bucketTotal))failComplete('unavailable','source');
  const metric=(g:CompleteUsageGroup)=>query.rankBy==='calls'?g.metrics.calls:query.rankBy==='tokens'?safeSum(g.metrics.inputTokens,g.metrics.outputTokens):g.recordedChargeMicros;
  all.sort((a,b)=>metric(b)-metric(a)||identityCompare(a.identity,b.identity));
  const offset=query.rankOffset??0,selected=all.slice(offset,offset+100);
  return {...total,query,buckets,groups:selected,remainder:remainderOf(total,selected),rank:{exact:true,distinctGroups:all.length,offset,hasMore:offset+selected.length<all.length}};
}
function eventOrder(a:{event:CompleteUsageEvent;shard:number},b:{event:CompleteUsageEvent;shard:number}){return b.event.occurredAt-a.event.occurredAt||compareUsageIds(b.event.id,a.event.id)||b.shard-a.shard;}
/** Sole complete engine. Verified callback owns authentication, this service owns
 * current scope, capture, totals/ranks/events, capability use and final validation. */
export async function readCompleteUsage(env:Env,verify:UsageVerifier,input:CompleteRead,signal?:AbortSignal):Promise<CompleteUsageOutcome<CompleteUsageReport|CompleteUsageEvents|{valid:true}|{released:true}>>{
  const op=new CompleteOperation(signal);let operation:string|undefined,binding:PrivateBinding|undefined,published=false;
  try{
    validateCompleteUsageQuery(input.query);
    if(Object.keys(input).some(k=>!['kind','query','intent','cut','cursor','pageSize'].includes(k))||!['report','events','validate','release'].includes(input.kind))invalid('invalid complete read');
    const intent=input.intent??'summary';
    for(const handle of [input.cut,input.cursor])if(handle!==undefined&&(typeof handle!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(handle)))invalid('invalid opaque capability');
    if(!['summary','browse','export'].includes(intent)||input.kind==='report'&&(intent==='summary'&&(input.cut!==undefined||input.cursor!==undefined)||intent==='export'&&input.cut!==undefined||input.cursor!==undefined)
      ||input.kind!=='report'&&(!input.cut||input.intent!==undefined)||input.kind!=='events'&&(input.cursor!==undefined||input.pageSize!==undefined))invalid('invalid intent or continuation');
    const resolved=await resolveCompleteAuthority(env,verify,op);binding=resolved.binding;
    if(resolved.personal&&(!resolved.addresses.length))return {kind:'no_access'};
    let query:CompleteUsageQuery={...structuredClone(input.query),rankOffset:input.query.rankOffset??0};
    if(resolved.personal){if(query.groupBy==='user'||query.filters.user!==undefined&&query.filters.user!==resolved.owner)invalid('personal owner is fixed');query.filters.user=resolved.owner;}
    const registry=<T>(action:string,body:unknown)=>op.call<T>(authorityStub(env),'/usage-cuts/'+action,body);
    if(input.kind==='release')return {kind:'complete',value:await registry<{released:true}>('release',{binding,cut:input.cut})};
    let capture:PrivateCapture,base=query,sizes:UsageCandidateSize[],purpose=intent;
    if(input.cut){
      const root=await registry<{purpose:'browse'|'export';base:CompleteUsageQuery;capture:PrivateCapture}>('read',{binding,cut:input.cut,query});
      capture=root.capture;base=root.base;purpose=root.purpose;
      if(!capture||!Array.isArray(capture.vector)||stable(capture.vector.map(({tenantId,policyId})=>({tenantId,policyId})))!==stable(resolved.addresses))failComplete('restart','authority');
      sizes=input.kind==='validate'?[]:await op.map(capture.vector,p=>shardCall<UsageCandidateSize>(env,op,p,{action:'preflight',query,cut:p.cut}));
    }else{
      if(intent!=='summary'){const reserved=await registry<{operation:string}>('reserve',{binding,purpose:intent,base:query});operation=reserved.operation;}
      const from=Date.now();
      const cuts=await op.map(resolved.addresses,p=>shardCall<{cut:UsageVisibilityCut;work:UsageCandidateSize}>(env,op,p,{action:'capture',query}));
      sizes=cuts.map(c=>c.work);checkSize(sizes);
      capture={vector:resolved.addresses.map((p,i)=>({...p,cut:cuts[i].cut})),effectiveFrom:Math.max(query.from,...cuts.map(c=>c.cut.floor)),capturedBetween:{from,to:Math.max(from,Date.now())}};
      if(capture.effectiveFrom>=query.to)return {kind:'outside_retained_range',effectiveFrom:capture.effectiveFrom,requestedTo:query.to};
      query={...query,from:capture.effectiveFrom};
    }
    let value:CompleteUsageReport|CompleteUsageEvents|{valid:true};const coverage=coverageFor(resolved,capture,base);
    if(input.kind==='validate')value={valid:true};
    else if(input.kind==='events'){
      const limit=input.pageSize??25;if(!Number.isInteger(limit)||limit<1||limit>100)invalid('page size must be 1..100');checkSize(sizes);
      const before=input.cursor?await registry<{at:number;id:string;shard:number}>('cursor',{binding,cut:input.cut,query,pageSize:limit,cursor:input.cursor}):undefined;
      const pages=await op.map(capture.vector,async(p,i)=>{op.work(sizes[i]);return shardCall<{events:CompleteUsageEvent[];hasMore:boolean}>(env,op,p,{action:'events',query,cut:p.cut,limit,before:before?{at:before.at,id:before.id}:undefined,includeEqualId:before?i<before.shard:false,allowance:sizes[i]});});
      const ordered=pages.flatMap((p,shard)=>{if(!Array.isArray(p.events)||p.events.length>limit||typeof p.hasMore!=='boolean')failComplete('unavailable','source');return p.events.map(event=>({event,shard}));}).sort(eventOrder);
      for(let i=0;i<ordered.length;i++){const row=ordered[i];nonnegative(row.event.occurredAt);if(typeof row.event.id!=='string'||row.event.occurredAt<query.from||row.event.occurredAt>=query.to||i&&eventOrder(ordered[i-1],row)>=0||before&&eventOrder({event:{occurredAt:before.at,id:before.id} as CompleteUsageEvent,shard:before.shard},row)>=0)failComplete('unavailable','source');}
      const selected=ordered.slice(0,limit),last=selected.at(-1),more=ordered.length>limit||pages.some(p=>p.hasMore);
      if(more&&!last)failComplete('unavailable','source');
      const next=more?await registry<{cursor:string}>('cursor',{binding,cut:input.cut,query,pageSize:limit,position:{at:last!.event.occurredAt,id:last!.event.id,shard:last!.shard}}):null;
      value={events:selected.map(r=>r.event),nextCursor:next?.cursor??null,coverage};
    }else{
      const report=await completeGroups(env,op,capture,query,sizes);
      if(purpose==='export'&&report.metrics.calls>50000)failComplete('unavailable','capacity');
      value={...report,coverage,cut:input.cut??null};
    }
    await finalValidation(env,verify,op,resolved,capture,query);
    if(operation){
      let receipt:{cut:string};
      try{receipt=await registry<{cut:string}>('finalize',{binding,operation,capture});}
      catch(error){
        // Unknown finalize outcome: observe SAME operation, never allocate again.
        const observed=await registry<{state:string;cut?:string}>('observe',{binding,operation});
        if(observed.state!=='ready'||!observed.cut)throw error;receipt={cut:observed.cut};
      }
      (value as CompleteUsageReport).cut=receipt.cut;
    }
    op.check();if(usageJsonBytes(value)>limits.pageBytes)failComplete('unavailable','capacity');published=true;
    return {kind:'complete',value};
  }catch(error){
    if(error instanceof CompleteFailure)return error.outcome;
    if(error instanceof UsageVisibilityError)return {kind:error.kind,reason:error.reason} as Failure;
    if(signal?.aborted||op.signal.aborted)return {kind:'unavailable',reason:'cancelled'};
    if(error instanceof HttpError&&error.status===422)return {kind:'unavailable',reason:'capacity'};
    if(error instanceof HttpError&&error.status===400)throw error;
    return {kind:'unavailable',reason:'source'};
  }finally{
    op.close();
    if(operation&&binding&&!published){
      // Cleanup gets its own bounded request even after work cancellation. Lost
      // cleanup still has admission-owned 20s pending / fixed root expiry.
      const cleanup=new CompleteOperation();try{await cleanup.call(authorityStub(env),'/usage-cuts/release',{binding,operation});}catch{}finally{cleanup.close();}
    }
  }
}

function eventAdditives(event: CompleteUsageEvent): UsageAdditives {
  const result=emptyAdditives(),m=result.metrics;m.calls=1;
  if(!['generation','utility'].includes(event.callKind)||typeof event.status!=='string'||!lanes.has(event.lane)||!classes.has(event.costClass))failComplete('unavailable','source');
  m.generationCalls=Number(event.callKind==='generation');m.utilityCalls=Number(event.callKind==='utility');
  m.successfulCalls=Number(event.status==='success');m.deniedCalls=Number(event.status==='denied');m.errorCalls=Number(event.status!=='success'&&event.status!=='denied');
  for(const [field,present] of [['inputTokens','inputReportedCalls'],['outputTokens','outputReportedCalls'],['cachedInputTokens','cacheReadReportedCalls'],['cacheWriteInputTokens','cacheWriteReportedCalls'],['reasoningOutputTokens','reasoningReportedCalls']] as const){
    const v=event[field];if(v!==null){nonnegative(v);m[field]=v;m[present]=1;}
  }
  if(event.recordedChargeMicros!==null){nonnegative(event.recordedChargeMicros);result.recordedChargeMicros=event.recordedChargeMicros;result.chargeReportedCalls=1;}
  if(event.reportingCostMicros!==null)nonnegative(event.reportingCostMicros);
  if(event.costClass==='unknown'&&event.reportingCostMicros!==null||event.costClass!=='unknown'&&event.reportingCostMicros===null)failComplete('unavailable','source');
  result.costs=[{lane:event.lane,costClass:event.costClass,calls:1,amountMicros:event.reportingCostMicros??0}];return result;
}
/** Private mechanics only; CSV/JSON download adapters and UI remain Unit4. A new
 * export always captures independently using the selected ABSOLUTE refinement.
 * No file/result escapes until every additive and final vector check passes. */
export async function exportCompleteUsage(env:Env,verify:UsageVerifier,query:CompleteUsageQuery,signal?:AbortSignal):Promise<CompleteUsageOutcome<{report:CompleteUsageReport;events:CompleteUsageEvent[]}>>{
  let report:CompleteUsageReport|undefined;
  try{
    const opened=await readCompleteUsage(env,verify,{kind:'report',intent:'export',query},signal);
    if(opened.kind!=='complete')return opened;
    report=opened.value as CompleteUsageReport;if(!report.cut||report.metrics.calls>50000)failComplete('unavailable','capacity');
    const events:CompleteUsageEvent[]=[],seen=new Set<string>(),total=emptyAdditives();let cursor:string|undefined,bytes=usageJsonBytes(report)+32,last:CompleteUsageEvent|undefined;
    do{
      if(signal?.aborted)failComplete('unavailable','cancelled');
      const read=await readCompleteUsage(env,verify,{kind:'events',cut:report.cut,query:report.query,pageSize:100,cursor},signal);
      if(read.kind!=='complete')return read;
      const page=read.value as CompleteUsageEvents;
      if(page.nextCursor&&(seen.has(page.nextCursor)||!page.events.length))failComplete('unavailable','source');
      for(const event of page.events){
        if(last&&(event.occurredAt>last.occurredAt||event.occurredAt===last.occurredAt&&compareUsageIds(event.id,last.id)>0))failComplete('unavailable','source');
        // Equal ID/time on different shards is deliberately NOT deduplicated.
        addAdditives(total,eventAdditives(event));bytes+=usageJsonBytes(event)+1;
        if(events.length>=50000||bytes>16*1024*1024)failComplete('unavailable','capacity');
        events.push(event);last=event;
      }
      cursor=page.nextCursor??undefined;if(cursor)seen.add(cursor);
    }while(cursor);
    const expected:UsageAdditives={metrics:report.metrics,recordedChargeMicros:report.recordedChargeMicros,chargeReportedCalls:report.chargeReportedCalls,costs:report.costs};
    if(!equalAdditives(total,expected))failComplete('unavailable','source');
    const final=await readCompleteUsage(env,verify,{kind:'validate',cut:report.cut,query:report.query},signal);
    if(final.kind!=='complete')return final;
    if(signal?.aborted)failComplete('unavailable','cancelled');
    return {kind:'complete',value:{report,events}};
  }catch(error){if(error instanceof CompleteFailure)return error.outcome;if(error instanceof HttpError&&error.status===422)return {kind:'unavailable',reason:'capacity'};if(signal?.aborted)return {kind:'unavailable',reason:'cancelled'};return {kind:'unavailable',reason:'source'};}
  finally{if(report?.cut)await readCompleteUsage(env,verify,{kind:'release',cut:report.cut,query:report.query}).catch(()=>undefined);}
}
