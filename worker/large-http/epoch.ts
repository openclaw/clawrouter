// One bounded durable epoch; fixed slot actors own every native effect.
import {initialPool,poolTransition,poolLimit,attempt,type PoolState} from './pool-state.ts';
export type EpochPhase='starting'|'serving'|'draining'|'stopping'|'cooldown'|'closed';
export interface Epoch {
 schema:1;generation:number;phase:EpochPhase;fingerprint:string;
 until:number;drainUntil:number;nextAt:number;windowAt:number;starts:number;
 prepared:number;counts:number[];pool:PoolState;reason:string;failures:Array<{generation:number;at:number;slots:SlotObservation[]}>;
}
export interface EpochConfig {fingerprint:string;epochMs:number;enabled:boolean;deadline:number;startWindowMs:number;startsPerWindow:number}
export interface SlotObservation {phase:string;generation:number;boot?:string;absent?:boolean;reason?:string}
export interface AtomicStore<S> {
 update<T>(fn:(state:S|undefined)=>{state:S;value:T}):Promise<T>;
}
export interface EpochPorts {
 prepare(slot:number,generation:number):Promise<SlotObservation>;
 status(slot:number,generation:number):Promise<SlotObservation>;
 retire(slot:number,generation:number):Promise<SlotObservation>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const phases:EpochPhase[]=['starting','serving','draining','stopping','cooldown','closed'];
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export const epochDrainMs=460000;
export function validateEpochConfig(c:EpochConfig):void {
 if(!digest.test(c.fingerprint)||typeof c.enabled!=='boolean'||!safe(c.deadline)||
 !safe(c.epochMs)||c.epochMs<60000||c.epochMs>21600000||
 !safe(c.startWindowMs)||c.startWindowMs<3600000||c.startWindowMs>86400000||
 !Number.isInteger(c.startsPerWindow)||c.startsPerWindow<1||c.startsPerWindow>3)throw Error('epoch_config_invalid');
}
export function validateEpoch(s:Epoch):void {
 const p=s?.pool;
 if(!s||s.schema!==1||!phases.includes(s.phase)||!safe(s.generation)||!digest.test(s.fingerprint)||
 ![s.until,s.drainUntil,s.nextAt,s.windowAt,s.starts].every(safe)||s.starts>3||
 !safe(s.prepared)||s.prepared>8||!Array.isArray(s.counts)||s.counts.length!==poolLimit||s.counts.some(n=>!safe(n)||n>64)||
 !p||p.schema!==1||!safe(p.fence)||!safe(p.next)||p.next>=poolLimit||!safe(p.issued)||p.issued>512||
 s.counts.reduce((a,b)=>a+b,0)!==p.issued||p.fence!==p.issued||
 !Array.isArray(p.members)||p.members.length!==poolLimit||p.members.some(m=>m!==null&&(!uuid.test(m.boot)||typeof m.quarantined!=='boolean'))||
 !Array.isArray(p.grants)||p.grants.length>poolLimit||new Set(p.grants.map(g=>g.slot)).size!==p.grants.length||
 !p.seen||Object.keys(p.seen).length!==p.issued||Object.entries(p.seen).some(([k,v])=>!attempt.test(k)||!['granted','expired','complete','quarantined'].includes(v))||
 p.grants.some(g=>!attempt.test(g.id)||!digest.test(g.tenant)||!safe(g.slot)||g.slot>=poolLimit||!safe(g.fence)||g.fence<1||g.fence>p.fence||
  !safe(g.until)||g.generation!==s.generation||g.boot!==p.members[g.slot]?.boot||!['granted','claimed','intent'].includes(g.stage)||!p.seen[g.id])||
 !Array.isArray(s.failures)||s.failures.length>3||s.failures.some(f=>!safe(f.generation)||!safe(f.at)||!Array.isArray(f.slots)||f.slots.length!==8||f.slots.some(o=>!safe(o.generation)||!['pending','idle','starting','ready','failed','destroying','destroyed','stopped','blocked','unknown'].includes(o.phase)||o.reason!==undefined&&!/^none$|^reconstructed$|^start_or_keepalive$|^readiness(?:_(?:health_deadline|effect_deadline|boot_changed|boot_invalid|runtime_identity|native_identity|native_image|keepalive_rejected|startup_expired))?$|^native_exit(?:_(?:engine|timeout|resource|start|unknown))?$|^destroy_unknown$/.test(o.reason)))||
 typeof s.reason!=='string'||s.reason.length>40||JSON.stringify(s).length>100000)throw Error('epoch_journal_invalid');
}
function idle(c:EpochConfig,now:number):Epoch {
 return {schema:1,generation:0,phase:'closed',fingerprint:c.fingerprint,until:0,drainUntil:0,nextAt:now,windowAt:now,starts:0,prepared:0,counts:Array(poolLimit).fill(0),pool:initialPool(),reason:'initial',failures:[]};
}
function drain(s:Epoch,now:number,reason:string){s.phase='draining';s.reason=reason;s.drainUntil=now+epochDrainMs;}
export class EpochController {
 private ticking=false;
 private store:AtomicStore<Epoch>;private ports:EpochPorts;private config:()=>EpochConfig;private clock:()=>number;
 constructor(store:AtomicStore<Epoch>,ports:EpochPorts,config:()=>EpochConfig,clock=Date.now){this.store=store;this.ports=ports;this.config=config;this.clock=clock;}
 private update<T>(fn:(s:Epoch,c:EpochConfig,now:number)=>T):Promise<T>{
  const c=this.config(),now=this.clock();validateEpochConfig(c);
  return this.store.update(s=>{if(s)validateEpoch(s);s??=idle(c,now);const value=fn(s,c,now);validateEpoch(s);return {state:s,value};});
 }
 async command(op:string,value:any):Promise<any>{
  return this.update((s,c,now)=>{
   if(['serving','draining'].includes(s.phase)){
    poolTransition(s.pool,'snapshot',{},now);
    if(s.phase==='serving'&&s.pool.members.some(m=>m?.quarantined))drain(s,now,'quarantine');
   }
   if(op==='snapshot')return {status:200,state:structuredClone(s)};
   if(!value||value.generation!==s.generation)return {status:409};
   if(op==='admit'){
    if(!c.enabled||now>=c.deadline||s.fingerprint!==c.fingerprint||now>=s.until||s.pool.issued>=512||s.counts.some(n=>n>=64)){
     if(s.phase==='serving')drain(s,now,'rotation');return {status:503};
    }
    if(s.phase!=='serving')return {status:503};
    // Refusals have no dispatch authority and consume no history.
    const next=structuredClone(s.pool),result=poolTransition(next,op,value,now);
    if(result.status===200){s.pool=next;s.counts[result.grant!.slot]++;result.grant!.generation=s.generation;}
    return result;
   }
   if(!['claim','dispatch','finish'].includes(op))return {status:404};
   if(!['serving','draining'].includes(s.phase))return {status:409};
   const result=poolTransition(s.pool,op,value,now);
   if(s.pool.members.some(m=>m?.quarantined)&&s.phase==='serving')drain(s,now,'quarantine');
   return result;
  });
 }
 async tick():Promise<void>{
  if(this.ticking)return;this.ticking=true;
  try{
   let prepareFrom=0;
   const before=await this.update((s,c,now)=>{
    if((!c.enabled||now>=c.deadline||s.fingerprint!==c.fingerprint||now>=s.until||s.pool.issued>=512||s.counts.some(n=>n>=64))&&['starting','serving'].includes(s.phase))drain(s,now,'rotation');
    if(['serving','draining'].includes(s.phase)){
     poolTransition(s.pool,'snapshot',{},now);
     if(s.phase==='serving'&&s.pool.members.some(m=>m?.quarantined))drain(s,now,'quarantine');
    }
    if(s.phase==='draining'&&(s.pool.grants.length===0||now>=s.drainUntil))s.phase='stopping';
    if(s.phase==='cooldown'&&(!c.enabled||now>=c.deadline))s.phase='closed';
    if(['cooldown','closed'].includes(s.phase)&&now>=s.nextAt&&c.enabled&&now<c.deadline){
     if(now-s.windowAt>=c.startWindowMs){s.windowAt=now;s.starts=0;}
     if(s.starts>=c.startsPerWindow){s.phase='cooldown';s.nextAt=Math.min(c.deadline,s.windowAt+c.startWindowMs);}
     else if(s.generation>=Number.MAX_SAFE_INTEGER)s.phase='closed';
     else Object.assign(s,idle(c,now),{failures:s.failures,phase:'starting',generation:s.generation+1,windowAt:s.windowAt,starts:s.starts+1,until:Math.min(c.deadline,now+60000)});
    }
    prepareFrom=s.prepared;if(s.phase==='starting')s.prepared=Math.min(8,s.prepared+1);
    return structuredClone(s);
   });
   if(['closed','cooldown','draining'].includes(before.phase))return;
   const fn=before.phase==='starting'?'prepare':before.phase==='stopping'?'retire':'status';
   // Storage locks never span native/network operations.
   const observations=await Promise.all(Array.from({length:poolLimit},async(_,i)=>{
    if(before.phase==='starting'&&i>=before.prepared)return {phase:'pending',generation:before.generation};
    const operation=before.phase==='starting'&&i<prepareFrom?'status':fn;
    try{return await this.ports[operation](i,before.generation);}catch{return {phase:'unknown',generation:before.generation};}
   }));
   await this.update((s,c,now)=>{
    if(s.generation!==before.generation||s.phase!==before.phase)return;
    if(s.phase==='stopping'){
     if(observations.every(o=>o.generation===s.generation&&o.phase==='stopped'&&o.absent===true)){
      // Destruction ACK + absence precede compaction; generation fences reject
      // every delayed old claim/finish/dispatch after the next start.
      s.pool=initialPool();s.counts.fill(0);s.phase=c.enabled&&now<c.deadline?'cooldown':'closed';s.nextAt=now+1000;
     }
    }else if(observations.some(o=>o.generation!==s.generation||['failed','stopped','blocked','unknown'].includes(o.phase))){
     s.failures.push({generation:s.generation,at:now,slots:observations.map(o=>({generation:o.generation,phase:o.phase,...(o.reason?{reason:o.reason}:{})}))});s.failures=s.failures.slice(-3);drain(s,now,'native_unavailable');
    }
    else if(observations.every(o=>o.phase==='ready'&&uuid.test(o.boot??''))){
     for(let i=0;i<poolLimit;i++)if(poolTransition(s.pool,'ready',{slot:i,boot:observations[i].boot},now).status!==200){drain(s,now,'boot_changed');break;}
     if(s.phase==='starting'){s.phase='serving';s.until=Math.min(c.deadline,now+c.epochMs);}
    }
   });
  }finally{this.ticking=false;}
 }
}
