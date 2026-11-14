// Continuous allocator. Each slot retains replay history until acknowledged
// destruction AND observed absence. Network effects never hold the store lock.
import {initialPool,poolTransition,attempt,type PoolState} from './pool-state.ts';
import {epochDrainMs,type AtomicStore,type EpochPorts,type EpochConfig} from './epoch.ts';
export interface ContinuousConfig extends EpochConfig {capacity:number;tenantLimit:number;slotStartsPerHour:number;testing?:boolean}
type Phase='idle'|'starting'|'ready'|'draining'|'stopping'|'blocked';
interface Member {generation:number;phase:Phase;fingerprint:string;until:number;drainUntil:number;nextAt:number;windowAt:number;starts:number;ids:string[]}
interface Observation {kind:'admitted'|'claimed'|'dispatch'|'released'|'quarantined'|'retired'|'refused';at:number;id:string;tenant:string;slot:number|null;generation:number|null;holdMs:number|null;status:number}
export interface ContinuousState {schema:2;generation:0;phase:'serving'|'draining'|'closed';accepting:boolean;control?:{revision:number};observations:Observation[];pool:PoolState;slots:Member[]}
export interface AdmissionReceipt {status:200;operationId:string;expectedRevision:number;revision:number;accepting:boolean}
// Receipts live in separate durable keys, not the bounded inference journal.
// They must commit atomically with the revision and must never be evicted: even
// a much later retry observes its original receipt, not a second transition.
export interface ContinuousStore extends AtomicStore<ContinuousState> {
 admission?(operationId:string,fn:(state:ContinuousState|undefined,receipt:AdmissionReceipt|undefined)=>{state:ContinuousState;value:any;receipt?:AdmissionReceipt}):Promise<any>;
}
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
// Leave a quarter of each incarnation's replay history for traffic while the
// first replacement is prepared. Serial maintenance then staggers histories.
export const continuousHistoryTarget=48;
export function continuousAlarmDelay(s:ContinuousState,c:Pick<ContinuousConfig,'capacity'|'slotStartsPerHour'>,now:number){
 if(s.phase==='closed')return 60000;
 if(s.phase==='draining')return 1000;
 const slots=s.slots.slice(0,c.capacity),spare=slots.filter(m=>m.phase==='ready').length>1;
 return slots.some(m=>{
  const credit=now-m.windowAt>=3600000||m.starts<c.slotStartsPerHour;
  return ['starting','draining','stopping'].includes(m.phase)||m.phase==='idle'&&credit||m.phase==='ready'&&(m.ids.length>=64||credit&&spare&&m.ids.length>=continuousHistoryTarget);
 })?1000:5000;
}
export function validateContinuous(s:ContinuousState){
 const p=s?.pool;
 if(s?.control!==undefined&&(!s.control||!safe(s.control.revision)||s.control.revision<1))throw Error('continuous_control_invalid');
 if(s?.schema!==2||!Array.isArray(s.observations)||s.observations.length>128||s.observations.some(o=>!['admitted','claimed','dispatch','released','quarantined','retired','refused'].includes(o.kind)||!safe(o.at)||!attempt.test(o.id)||!/^[a-f0-9]{64}$/.test(o.tenant)||o.slot!==null&&(!safe(o.slot)||o.slot>=8)||o.generation!==null&&!safe(o.generation)||o.holdMs!==null&&!safe(o.holdMs)||![200,409,429,503].includes(o.status))||typeof s.accepting!=='boolean'||s.generation!==0||!['serving','draining','closed'].includes(s.phase)||!p||p.schema!==1||!safe(p.fence)||!safe(p.next)||p.next>=8||
 !Array.isArray(s.slots)||s.slots.length!==8||!Array.isArray(p.members)||p.members.length!==8||!Array.isArray(p.grants)||p.grants.length>8||
 new Set(p.grants.map(g=>g.slot)).size!==p.grants.length||!p.seen||!safe(p.issued)||p.issued>512||Object.keys(p.seen).length!==p.issued||
 s.slots.some(m=>!['idle','starting','ready','draining','stopping','blocked'].includes(m.phase)||![m.generation,m.until,m.drainUntil,m.nextAt,m.windowAt,m.starts].every(safe)||m.starts>60||!Array.isArray(m.ids)||m.ids.length>64||m.ids.some(id=>!attempt.test(id)||!p.seen[id])||!/^[a-f0-9]{64}$/.test(m.fingerprint))||
 s.slots.reduce((n,m)=>n+m.ids.length,0)!==p.issued||new Set(s.slots.flatMap(m=>m.ids)).size!==p.issued||
 p.members.some(m=>m!==null&&(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.boot)||typeof m.quarantined!=='boolean'))||
 p.grants.some(g=>!attempt.test(g.id)||!/^[a-f0-9]{64}$/.test(g.tenant)||!safe(g.slot)||g.slot>=8||!safe(g.fence)||g.fence<1||g.fence>p.fence||!safe(g.until)||g.claimedAt!==undefined&&!safe(g.claimedAt)||g.admittedAt!==undefined&&!safe(g.admittedAt)||g.generation!==s.slots[g.slot].generation||g.boot!==p.members[g.slot]?.boot||!s.slots[g.slot].ids.includes(g.id)||!['granted','claimed','intent'].includes(g.stage))||JSON.stringify(s).length>150000)throw Error('continuous_journal_invalid');
}
export class ContinuousController {
 private ticking=false;
 private store:ContinuousStore;private ports:EpochPorts;private config:()=>ContinuousConfig;private clock:()=>number;
 constructor(store:ContinuousStore,ports:EpochPorts,config:()=>ContinuousConfig,clock=Date.now){this.store=store;this.ports=ports;this.config=config;this.clock=clock;}
 private transition<T>(state:ContinuousState|undefined,fn:(s:ContinuousState,c:ContinuousConfig,now:number)=>T){
  const c=this.config(),now=this.clock();
  if(![c.capacity,c.tenantLimit,c.slotStartsPerHour].every(Number.isInteger)||c.capacity<1||c.capacity>8||c.tenantLimit<1||c.tenantLimit>c.capacity||c.slotStartsPerHour<1||c.slotStartsPerHour>60)throw Error('continuous_config_invalid');
   if(state)validateContinuous(state);
   const s=state??{schema:2,generation:0,phase:'closed',accepting:true,observations:[],pool:initialPool(),slots:Array.from({length:8},()=>({generation:0,phase:'idle',fingerprint:c.fingerprint,until:0,drainUntil:0,nextAt:now,windowAt:now,starts:0,ids:[]}))} as ContinuousState;
   poolTransition(s.pool,'snapshot',{},now);
   const enabled=c.enabled&&s.accepting&&now<c.deadline;
   for(let i=0;i<8;i++){
    const m=s.slots[i];
    if(['ready','starting'].includes(m.phase)&&(!enabled||i>=c.capacity||m.fingerprint!==c.fingerprint||s.pool.members[i]?.quarantined))this.drain(m,now);
   }
   s.phase=enabled?'serving':s.slots.some(m=>!['idle','blocked'].includes(m.phase))?'draining':'closed';
   const value=fn(s,c,now);validateContinuous(s);return {state:s,value};
 }
 private update<T>(fn:(s:ContinuousState,c:ContinuousConfig,now:number)=>T){return this.store.update(state=>this.transition(state,fn));}
 private async admission(v:any){
  if(typeof v?.accepting!=='boolean')return {status:400};
  if(v.expectedRevision===undefined&&v.operationId===undefined)return this.update(s=>{
   if(s.control)return {status:409,revision:s.control.revision,accepting:s.accepting};
   s.accepting=v.accepting;return {status:200,accepting:s.accepting};
  });
  if(!safe(v.expectedRevision)||typeof v.operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.operationId))return {status:400};
  if(!this.store.admission)return {status:503};
  return this.store.admission(v.operationId,(state,prior)=>{
   const result=this.transition(state,s=>{
    const revision=s.control?.revision??0;
    if(prior){
     if(prior.status!==200||!safe(prior.expectedRevision)||!safe(prior.revision)||prior.revision!==prior.expectedRevision+1||prior.revision>revision||typeof prior.accepting!=='boolean')throw Error('continuous_receipt_invalid');
     if(prior.operationId===v.operationId&&prior.expectedRevision===v.expectedRevision&&prior.accepting===v.accepting)return prior;
     return {status:409,revision,accepting:s.accepting};
    }
    if(v.expectedRevision!==revision||revision===Number.MAX_SAFE_INTEGER)return {status:409,revision,accepting:s.accepting};
    s.accepting=v.accepting;s.control={revision:revision+1};
    return {status:200 as const,operationId:v.operationId,expectedRevision:v.expectedRevision,revision:revision+1,accepting:s.accepting};
   });
   return {...result,...(result.value.status===200?{receipt:result.value as AdmissionReceipt}:{})};
  });
 }
 private observe(s:ContinuousState,c:ContinuousConfig,kind:Observation['kind'],g:any,now:number,status=200){
  if(!c.testing||!attempt.test(g?.id??'')||!/^[a-f0-9]{64}$/.test(g?.tenant??''))return;
  s.observations.push({kind,at:now,id:g.id,tenant:g.tenant,slot:g.slot??null,generation:g.generation??null,holdMs:g.claimedAt===undefined?null:Math.max(0,now-g.claimedAt),status});s.observations=s.observations.slice(-128);
 }
 private drain(m:Member,now:number){m.phase='draining';m.drainUntil=now+epochDrainMs;}
 async command(op:string,v:any):Promise<any>{
  if(op==='admission')return this.admission(v);
  return this.update((s,c,now)=>{
  if(op==='snapshot')return {status:200,state:structuredClone(s)};
  if(!v||!attempt.test(v.id??''))return {status:400};
  if(op==='admit'){
   if(!c.enabled||!s.accepting||now>=c.deadline||s.pool.fence>=Number.MAX_SAFE_INTEGER)return {status:503};
   // Hide retiring/history-full members from allocation, preserving their
   // canonical owners for late dispatch, accounting and cleanup acknowledgments.
   const next=structuredClone(s.pool);
   for(let i=0;i<8;i++)if(s.slots[i].phase!=='ready'||s.slots[i].ids.length>=64)next.members[i]=null;
   const result=poolTransition(next,op,v,now,{tenantLimit:c.tenantLimit});
   if(result.status===200){const g=result.grant!;g.generation=s.slots[g.slot].generation;if(c.testing)g.admittedAt=now;next.members=s.pool.members;s.pool=next;s.slots[g.slot].ids.push(g.id);this.observe(s,c,'admitted',g,now);}
   else this.observe(s,c,'refused',v,now,result.status);
   return result;
  }
  const g=s.pool.grants.find(g=>g.id===v.id);
  if(!g||g.generation!==v.generation)return {status:409};
  if(!['claim','dispatch','finish'].includes(op))return {status:404};
  // An operator admission stop drains existing work. It does not invalidate
  // already granted capacity or prevent canonical completion/cleanup.
  const result=poolTransition(s.pool,op,v,now);
  if(result.status===200){if(op==='claim'&&c.testing)g.claimedAt=now;this.observe(s,c,op==='claim'?'claimed':op==='dispatch'?'dispatch':v.clean===true?'released':'quarantined',g,now);}
  return result;
 });}
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{
   const before=await this.update((s,c,now)=>{
    // Planned maintenance is serial; unhealthy slots are isolated independently.
    // An idle member with exhausted start credit cannot own maintenance:
    // healthy members must still be able to replace their bounded histories.
    if(!s.slots.slice(0,c.capacity).some(m=>['starting','draining','stopping'].includes(m.phase)||m.phase==='idle'&&m.generation<Number.MAX_SAFE_INTEGER&&(now-m.windowAt>=3600000||m.starts<c.slotStartsPerHour))){
     const ready=s.slots.slice(0,c.capacity).filter(m=>m.phase==='ready');
     // Never spend the last serving member or an unavailable start credit on
     // early maintenance. Full histories/age still impose their hard boundary.
     const m=ready.find(m=>now>=m.until||m.ids.length>=64)??(ready.length>1?ready.filter(m=>m.ids.length>=continuousHistoryTarget&&(now-m.windowAt>=3600000||m.starts<c.slotStartsPerHour)).sort((a,b)=>b.ids.length-a.ids.length)[0]:undefined);
     if(m)this.drain(m,now);
    }
    for(let i=0;i<8;i++){
     const m=s.slots[i];
     if(m.phase==='draining'&&(!s.pool.grants.some(g=>g.slot===i)||now>=m.drainUntil))m.phase='stopping';
    }
    // At most one new native start per alarm, with durable per-slot rate limits.
    const i=s.slots.findIndex((m,i)=>m.phase==='idle'&&i<c.capacity&&c.enabled&&s.accepting&&now<c.deadline&&now>=m.nextAt&&m.generation<Number.MAX_SAFE_INTEGER&&(now-m.windowAt>=3600000||m.starts<c.slotStartsPerHour));
    if(i>=0){const m=s.slots[i];if(now-m.windowAt>=3600000){m.windowAt=now;m.starts=0;}m.starts++;m.generation++;m.phase='starting';m.fingerprint=c.fingerprint;m.until=now+60000;}
    return structuredClone(s);
   });
   const observations=await Promise.all(before.slots.map(async(m,i)=>{
    if(['idle','blocked','draining'].includes(m.phase))return null;
    try{return await this.ports[m.phase==='stopping'?'retire':m.phase==='starting'?'prepare':'status'](i,m.generation);}catch{return {generation:m.generation,phase:'unknown'};}
   }));
   await this.update((s,c,now)=>{
    for(let i=0;i<8;i++){
     const m=s.slots[i],b=before.slots[i],o=observations[i];if(!o||m.generation!==b.generation||m.phase!==b.phase)continue;
     if(m.phase==='stopping'){
      if(o.generation===m.generation&&o.phase==='stopped'&&o.absent===true){
       // Exact-generation destruction ACK and absence are the only compaction
       // authority. Global fences remain monotonic across every incarnation.
       for(const g of s.pool.grants.filter(g=>g.slot===i))this.observe(s,c,'retired',g,now);
       for(const id of m.ids)delete s.pool.seen[id];s.pool.issued-=m.ids.length;m.ids=[];
       s.pool.grants=s.pool.grants.filter(g=>g.slot!==i);s.pool.members[i]=null;m.phase='idle';m.nextAt=now+1000;
      }else if(o.phase==='blocked')m.phase='blocked';
     }else if(o.generation!==m.generation||['failed','stopped','blocked','unknown'].includes(o.phase)||m.phase==='starting'&&now>=m.until){
      this.drain(m,now);if(s.pool.members[i])s.pool.members[i]!.quarantined=true;
     }else if(o.phase==='ready'){
      const result=poolTransition(s.pool,'ready',{slot:i,boot:o.boot},now);
      if(result.status!==200)this.drain(m,now);
      else if(m.phase==='starting'){m.phase='ready';m.until=now+c.epochMs;}
     }
    }
   });
  }finally{this.ticking=false;}
 }
}
