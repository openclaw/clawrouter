import {HttpError} from './utils.ts';
import {reportCutTtlMs} from './usage-report-range.ts';
import type {UsageVisibilityCut} from './usage-report-visibility.ts';

// Private to policy-bindings ACCESS_CONTROL. No persisted roots, copied rows,
// secret, alarm, or public command protocol. The service supplies verified binding
// fingerprints afresh; unit4 owns provenance, not this memory owner.
interface Binding {actor:string; session:string; authority:string}
interface Query {
 from:number; to:number; timezone:string; grain:'day'|'minute'; rankOffset?:number;
 groupBy:'model'|'provider'|'key'|'user'; rankBy:'calls'|'tokens'|'recordedAmount';
 filters:{user?:string; key?:{kind:'session'}|{kind:'credential';id:string}; model?:string; provider?:string; status?:string; lane?:string; costClass?:string};
}
interface VectorEntry {tenantId:string;policyId:string;cut:UsageVisibilityCut}
// Unit3 must bounded-maintain before capture/read/drain in synchronous shard
// transactions (no await), and validate the WHOLE vector including projection
// qualification and current authority before finalize/publication. This registry
// validates metadata, never substitutes for source or attribution validation.
interface Capture {vector:VectorEntry[];effectiveFrom:number;capturedBetween:{from:number;to:number}}
interface CursorPosition {at:number;id:string;shard:number;query:Query;pageSize:number}
interface Root {
 operation:string;handle:string;binding:Binding;purpose:'browse'|'export';base:Query;
 revision:string;opened:number;expires:number;pendingUntil:number;
 capture:Capture|null;cursors:Array<{handle:string;position:CursorPosition}>;
}
const rootLimit=1024*1024, globalLimit=16*rootLimit, cursorLimit=16*1024;
const digest=/^[a-f0-9]{64}$/, opaque=/^[A-Za-z0-9_-]{43}$/;
function fail(kind:'invalid'|'capacity'|'restart'|'pending'):never {
 throw new HttpError(kind==='invalid'?400:kind==='restart'?410:kind==='pending'?409:422,'usage_cut_'+kind,'Usage capability '+kind);
}
function object(value:unknown,keys:string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('invalid');
 return value as Record<string,unknown>;
}
function str(value:unknown,max=512):asserts value is string {
 if(typeof value!=='string'||new TextEncoder().encode(value).length>max)fail('invalid');
}
function number(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)fail('invalid')}
function binding(value:unknown):asserts value is Binding {
 const b=object(value,['actor','session','authority']);
 for(const key of ['actor','session','authority'])if(typeof b[key]!=='string'||!digest.test(b[key] as string))fail('invalid');
}
function query(value:unknown):asserts value is Query {
 const q=object(value,['from','to','timezone','grain','groupBy','rankBy','rankOffset','filters']);number(q.from);number(q.to);
 if(q.rankOffset!==undefined){number(q.rankOffset);if(q.rankOffset>32768)fail('invalid')}
 if(q.from>=q.to||q.to-q.from>30*86400000)fail('invalid');str(q.timezone,100);
 if(!['day','minute'].includes(q.grain as string)||q.grain==='minute'&&q.to-q.from>86400000||!['model','provider','key','user'].includes(q.groupBy as string)||!['calls','tokens','recordedAmount'].includes(q.rankBy as string))fail('invalid');
 const f=object(q.filters,['user','key','model','provider','status','lane','costClass']);
 for(const key of Object.keys(f))if(key!=='key')str(f[key]);
 if(f.key!==undefined){const k=object(f.key,['kind','id']);if(k.kind==='credential')str(k.id);else if(k.kind!=='session'||Object.hasOwn(k,'id'))fail('invalid')}
}
function subset(base:Query,next:Query,effectiveFrom=base.from):void {
 if(next.from<effectiveFrom||next.to>base.to)fail('restart');
 for(const key of Object.keys(base.filters) as Array<keyof Query['filters']>)if(!equal(base.filters[key],next.filters[key]))fail('restart');
}
function capture(value:unknown,base:Query):asserts value is Capture {
 const c=object(value,['vector','effectiveFrom','capturedBetween']);number(c.effectiveFrom);
 if(c.effectiveFrom<base.from)fail('invalid');
 const interval=object(c.capturedBetween,['from','to']);number(interval.from);number(interval.to);if(interval.from>interval.to)fail('invalid');
 if(!Array.isArray(c.vector)||c.vector.length>64)fail('capacity');const seen=new Set<string>();
 for(const item of c.vector){const v=object(item,['tenantId','policyId','cut']);str(v.tenantId,2048);str(v.policyId,2048);if(new TextEncoder().encode(v.tenantId+v.policyId).length>2048)fail('capacity');
  const identity=JSON.stringify([v.tenantId,v.policyId]);if(seen.has(identity))fail('invalid');seen.add(identity);
  const cut=object(v.cut,['seq','epoch','createdAt','expiresAt','floor','source','normalizer']);
  for(const key of ['seq','createdAt','expiresAt','floor'])number(cut[key]);
  if(typeof cut.epoch!=='string'||!/^[a-f0-9]{32}$/.test(cut.epoch)||cut.normalizer!==2||!['projection','retained_ledger'].includes(cut.source as string)||Number(cut.expiresAt)-Number(cut.createdAt)!==reportCutTtlMs||Number(cut.floor)>c.effectiveFrom)fail('invalid');
 }
}
function token():string {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
function text(value:unknown):string {
 // Canonical property order prevents alternate JSON encodings from creating
 // extra binding slots or changing idempotent finalize/cursor identity.
 return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}
function bytes(value:unknown):number{return new TextEncoder().encode(JSON.stringify(value)).length}
function equal(a:unknown,b:unknown):boolean{return text(a)===text(b)}

export class UsageReportCuts {
 private roots=new Map<string,Root>();private clock=0;
 private timers=new Map<string,{expiry:ReturnType<typeof setTimeout>;pending?:ReturnType<typeof setTimeout>}>();
 private now():number {const now=Date.now();number(now);if(now>Number.MAX_SAFE_INTEGER-reportCutTtlMs)fail("invalid");this.clock=Math.max(this.clock,now);return this.clock}
 private sweep():void {const now=this.now();for(const [op,r] of this.roots)if(now>=r.expires||!r.capture&&now>=r.pendingUntil)this.drop(op)}
 private drop(operation:string):void {
  const timers=this.timers.get(operation);
  if(timers){clearTimeout(timers.expiry);if(timers.pending!==undefined)clearTimeout(timers.pending);this.timers.delete(operation)}
  this.roots.delete(operation);
 }
 private watch(root:Root):void {
  // At most two timers per admitted root (512 total). Start ONCE; changing the
  // earliest root or finalizing never reschedules another root's elapsed TTL.
  // Wall-clock sweep also expires forward jumps; callbacks need no clock read.
  const operation=root.operation,now=this.now();
  const expiry=setTimeout(()=>this.drop(operation),Math.max(1,root.expires-now));
  const pending=setTimeout(()=>{if(!this.roots.get(operation)?.capture)this.drop(operation)},Math.max(1,root.pendingUntil-now));
  this.timers.set(operation,{expiry,pending});
 }
 private admit(root:Root,previous?:Root):void {
  const size=bytes(root);let total=size;for(const r of this.roots.values())if(r!==previous)total+=bytes(r);
  if(size>rootLimit||total>globalLimit)fail('capacity');
 }
 private match(handle:unknown,b:Binding,revision:string,byOperation=false):Root {
  if(typeof handle!=='string'||!opaque.test(handle))fail('invalid');
  const root=byOperation?this.roots.get(handle):[...this.roots.values()].find(r=>r.handle===handle);
  if(!root||!equal(root.binding,b))fail('restart');
  if(root.revision!==revision){this.drop(root.operation);fail('restart')}
  return root;
 }
 /** Explicit private DO actions only. Unknown fields/intent combinations fail
  * before allocation; returning snapshots never lends mutable owner aliases. */
 dispatch(action:string,input:unknown,revision:string):unknown {
  this.sweep();if(!/^[a-f0-9]{32}$/.test(revision))fail('invalid');
  const fields:Record<string,string[]>={reserve:['binding','purpose','base'],finalize:['binding','operation','capture'],observe:['binding','operation'],read:['binding','cut','query'],cursor:['binding','cut','query','pageSize','position','cursor'],release:['binding','cut','operation']};
  if(!Object.hasOwn(fields,action))fail('invalid');const x=object(input,fields[action]);binding(x.binding);
  const b=x.binding;
  if(action==='reserve'){
   query(x.base);if(!['summary','browse','export'].includes(x.purpose as string))fail('invalid');
   if(x.purpose==='summary')return {cut:null};
   const own=[...this.roots.values()].filter(r=>equal(r.binding,b)&&r.purpose===x.purpose);
   if(own.length>=2){const oldest=x.purpose==='browse'?own.filter(r=>r.capture).sort((a,b)=>a.opened-b.opened)[0]:undefined;if(!oldest)fail('capacity');this.drop(oldest.operation)}
   if(this.roots.size>=256)fail('capacity');
   const opened=this.now();const root:Root={operation:token(),handle:token(),binding:b,purpose:x.purpose as Root['purpose'],base:x.base,revision,opened,expires:opened+reportCutTtlMs,pendingUntil:opened+20000,capture:null,cursors:[]};
   this.admit(root);
   this.roots.set(root.operation,JSON.parse(text(root)));this.watch(root);return {operation:root.operation,expiresAt:root.expires};
  }
  if(action==='release'){
   const handle=x.cut??x.operation;if(typeof handle!=='string'||!opaque.test(handle)||(x.cut!==undefined&&x.operation!==undefined))fail('invalid');
   // Missing is idempotent; a known foreign binding is denied, never removed.
   for(const [op,r] of this.roots)if(x.cut!==undefined?r.handle===handle:r.operation===handle){if(!equal(r.binding,b))fail('restart');this.drop(op)}
   return {released:true};
  }
  const root=this.match(action==='finalize'||action==='observe'?x.operation:x.cut,b,revision,action==='finalize'||action==='observe');
  if(action==='observe')return root.capture?{state:'ready',cut:root.handle,expiresAt:root.expires}:{state:'pending'};
  if(action==='finalize'){
   try{capture(x.capture,root.base);
    if(root.capture){if(!equal(root.capture,x.capture))fail('restart');return {cut:root.handle,expiresAt:root.expires}}
    const updated={...root,capture:x.capture};this.admit(updated,root);this.roots.set(root.operation,JSON.parse(text(updated)));
    const timers=this.timers.get(root.operation)!;if(timers.pending!==undefined){clearTimeout(timers.pending);timers.pending=undefined}
    return {cut:root.handle,expiresAt:root.expires};
   }catch(error){if(!root.capture)this.drop(root.operation);throw error}
  }
  if(!root.capture)fail('pending');query(x.query);subset(root.base,x.query,root.capture.effectiveFrom);
  if(action==='read')return JSON.parse(text({purpose:root.purpose,base:root.base,capture:root.capture,expiresAt:root.expires}));
  number(x.pageSize);if(x.pageSize<1||x.pageSize>100)fail('invalid');
  if(x.cursor!==undefined){if(x.position!==undefined||typeof x.cursor!=='string'||!opaque.test(x.cursor))fail('invalid');
   const found=root.cursors.find(c=>c.handle===x.cursor);if(!found||!equal(found.position.query,x.query)||found.position.pageSize!==x.pageSize)fail('restart');return JSON.parse(text(found.position));
  }
  const p=object(x.position,['at','id','shard']);number(p.at);str(p.id,8192);number(p.shard);if(p.shard>=root.capture.vector.length||p.at<x.query.from||p.at>=x.query.to)fail('invalid');
  const position:CursorPosition={at:p.at,id:p.id,shard:p.shard,query:x.query,pageSize:x.pageSize};if(bytes(position)>cursorLimit)fail('capacity');
  const retry=root.cursors.find(c=>equal(c.position,position));if(retry)return {cursor:retry.handle};
  const cursor={handle:token(),position},updated={...root,cursors:[...root.cursors.slice(-7),cursor]};this.admit(updated,root);
  this.roots.set(root.operation,JSON.parse(text(updated)));return {cursor:cursor.handle};
 }
}
