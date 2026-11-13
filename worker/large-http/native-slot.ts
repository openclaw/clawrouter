import type {AtomicStore,SlotObservation} from './epoch.ts';
import {attempt} from './pool-state.ts';
import {bounded} from './capacity.ts';
export type NativePhase='idle'|'starting'|'ready'|'failed'|'destroying'|'destroyed'|'stopped'|'blocked';
export interface NativeJournal {
 schema:1;generation:number;phase:NativePhase;fingerprint:string;runtimeSha?:string;token:string;
 boot:string;until:number;ids:string[];reason:string;
}
export interface SlotConfig {fingerprint:string;runtimeSha?:string;enabled:boolean;deadline:number}
export interface NativePorts {
 absent():Promise<boolean>;
 start(generation:number,token:string):void;
 keepalive():Promise<void>;
 ready(generation:number,token:string):Promise<string|null>;
 monitor():Promise<void>;
 destroy():Promise<void>;
}
const digest=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases:NativePhase[]=['idle','starting','ready','failed','destroying','destroyed','stopped','blocked'];
export function validateNativeJournal(s:NativeJournal):void {
 if(!s||s.schema!==1||!Number.isSafeInteger(s.generation)||s.generation<0||!phases.includes(s.phase)||!digest.test(s.fingerprint)||s.runtimeSha!==undefined&&!digest.test(s.runtimeSha)||!digest.test(s.token)||
 !Number.isSafeInteger(s.until)||s.until<0||!(s.boot===''||uuid.test(s.boot))||s.phase==='ready'&&!uuid.test(s.boot)||
 typeof s.reason!=='string'||!/^none$|^reconstructed$|^start_or_keepalive$|^readiness(?:_(?:health_deadline|effect_deadline|boot_changed|boot_invalid|runtime_identity|native_identity|native_image|keepalive_rejected|startup_expired))?$|^native_exit(?:_(?:engine|timeout|resource|start|unknown))?$|^destroy_unknown$/.test(s.reason)||
 !Array.isArray(s.ids)||s.ids.length>64||new Set(s.ids).size!==s.ids.length||s.ids.some(x=>!attempt.test(x)))throw Error('slot_journal_invalid');
}
export class NativeSlot {
 private loaded=false;
 private observing=false;
 private preparing=false;
 private retiring=false;
 private lease?:{generation:number;phase:'pending'|'resolved'|'rejected';refreshAt:number};
 private tail:Promise<unknown>=Promise.resolve();
 private store:AtomicStore<NativeJournal>;private native:NativePorts;private config:()=>SlotConfig;private clock:()=>number;
 constructor(store:AtomicStore<NativeJournal>,native:NativePorts,config:()=>SlotConfig,clock=Date.now){this.store=store;this.native=native;this.config=config;this.clock=clock;}
 private async update<T>(fn:(s:NativeJournal)=>T):Promise<T>{
  const c=this.config();if(!digest.test(c.fingerprint)||c.runtimeSha!==undefined&&!digest.test(c.runtimeSha)||!Number.isSafeInteger(c.deadline))throw Error('slot_config_invalid');
  const operation=this.tail.then(()=>this.store.update(s=>{
   if(s)validateNativeJournal(s);
   s??={schema:1,generation:0,phase:'idle',fingerprint:c.fingerprint,token:'0'.repeat(64),boot:'',until:0,ids:[],reason:'none'};
   if(!this.loaded){
    // No native continuation survives reconstruction. Never repeat a start or
    // an unresolved destroy. Destruction ACK persisted before eviction is safe.
    if(['starting','ready'].includes(s.phase)){s.phase='failed';s.reason='reconstructed';}
    if(s.phase==='destroying'){s.phase='blocked';s.reason='reconstructed';}
   }
   const value=fn(s);validateNativeJournal(s);return {state:s,value};
  })).then(value=>{this.loaded=true;return value;});
  this.tail=operation.catch(()=>{});return operation;
 }
 async state():Promise<NativeJournal>{return this.update(s=>structuredClone(s));}
 private async phase(generation:number,from:NativePhase[],to:NativePhase,reason='none'){await this.update(s=>{if(s.generation===generation&&from.includes(s.phase)){s.phase=to;s.reason=reason;}});}
 private refreshLease(generation:number):void {
  if(this.lease?.generation===generation&&(this.lease.phase==='pending'||this.clock()<this.lease.refreshAt))return;
  const lease=this.lease={generation,phase:'pending' as 'pending'|'resolved'|'rejected',refreshAt:this.clock()+60000};
  // The native timeout acknowledgement can arrive after cold-start control
  // returns. Observe that one effect; readiness waits for the actual ACK.
  const pending=this.native.keepalive();
  void pending.then(()=>{if(this.lease===lease)lease.phase='resolved';},()=>{if(this.lease===lease)lease.phase='rejected';});
 }
 async prepare(generation:number):Promise<SlotObservation>{
  if(this.preparing||this.retiring)return this.status(generation);
  this.preparing=true;
  try{
  const c=this.config(),now=this.clock();
  const start=await this.update(s=>{
   if(!c.enabled||now>=c.deadline||!Number.isSafeInteger(generation)||generation<1)return null;
   if(generation!==s.generation+1||!['idle','stopped'].includes(s.phase))return null;
   // Bind the digest to this start intent, never to a later worker's config.
   // Old journals without it remain unqualified until an acknowledged rotation.
   Object.assign(s,{generation,phase:'starting',fingerprint:c.fingerprint,runtimeSha:c.runtimeSha,token:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),boot:'',until:Math.min(c.deadline,now+30000),ids:[],reason:'none'});
   return s.token;
  });
  if(start!==null){
   try{
    // Durable intent precedes the native effect. No await between a settled
    // absence check and issuance, and no second issuance in this generation.
    if(!await bounded(this.native.absent()))throw Error('native_present');
    const s=await this.state();if(s.generation!==generation||s.phase!=='starting')return this.status(generation);
    this.native.start(generation,start);
    const watch=this.native.monitor();void watch.then(()=>this.phase(generation,['starting','ready'],'failed','native_exit'),error=>{const message=String(error?.message??'').toLowerCase();const kind=/docker|engine/.test(message)?'engine':/timed out|timeout|deadline/.test(message)?'timeout':/capacity|resource|memory|limit/.test(message)?'resource':/start/.test(message)?'start':'unknown';return this.phase(generation,['starting','ready'],'failed','native_exit_'+kind);}).catch(()=>{});
    this.refreshLease(generation);
   }catch{await this.phase(generation,['starting','ready'],'failed','start_or_keepalive');}
  }
  }finally{this.preparing=false;}
  return this.status(generation);
 }
 async status(generation:number):Promise<SlotObservation>{
  const before=await this.state();
  if(before.generation!==generation)return {generation:before.generation,phase:before.phase};
  if(!['starting','ready','destroyed','stopped'].includes(before.phase)||this.observing||this.preparing)return {generation,phase:before.phase,boot:before.boot,reason:before.reason};
  this.observing=true;
  try{
   if(['destroyed','stopped'].includes(before.phase)){
    const absent=await bounded(this.native.absent());
    if(absent)await this.phase(generation,['destroyed'],'stopped');
    return {generation,phase:absent?'stopped':'blocked',absent};
   }
   if(before.phase==='starting'&&this.clock()>=before.until)throw Error('startup_expired');
   this.refreshLease(generation);
   if(this.lease?.phase==='rejected')throw Error('keepalive_rejected');
   // Readiness establishes this process incarnation once. Its native monitor
   // owns liveness thereafter; a request fences the exact boot before routing.
   // Probing the same Node event loop while it parses a large request can
   // mistake ordinary scheduling delay for process death and block dispatch.
   if(before.phase==='ready'){
    const s=await this.state();return {generation:s.generation,phase:s.phase,boot:s.boot,reason:s.reason};
   }
   if(this.lease?.phase!=='resolved')return {generation,phase:before.phase,boot:before.boot,reason:before.reason};
   const boot=await bounded(this.native.ready(generation,before.token));
   if(boot!==null&&!uuid.test(boot))throw Error('boot_invalid');
   if(boot!==null)await this.update(s=>{if(s.generation===generation&&['starting','ready'].includes(s.phase)){s.boot=boot;s.phase='ready';}});
  }catch(error){const code=error instanceof Error&&['health_deadline','effect_deadline','boot_changed','boot_invalid','runtime_identity','native_identity','native_image','keepalive_rejected','startup_expired'].includes(error.message)?'readiness_'+error.message:'readiness';await this.phase(generation,['starting','ready'],'failed',code);}
  finally{this.observing=false;}
  const after=await this.state();return {generation:after.generation,phase:after.phase,boot:after.boot,reason:after.reason};
 }
 async retire(generation:number):Promise<SlotObservation>{
  if(this.preparing||this.retiring){const s=await this.state();return {generation:s.generation,phase:s.phase};}
  this.retiring=true;
  try{
  const issue=await this.update(s=>{
   if(!Number.isSafeInteger(generation)||generation<1||generation<s.generation||generation>s.generation+1)return false;
   if(generation>s.generation){if(!['idle','stopped'].includes(s.phase))return false;s.generation=generation;}
   if(['destroying','destroyed','stopped','blocked'].includes(s.phase))return false;
   s.phase='destroying';return true;
  });
  if(issue){
   try{await this.native.destroy();await this.phase(generation,['destroying'],'destroyed');}
   catch{await this.phase(generation,['destroying'],'blocked','destroy_unknown');}
  }
  }finally{this.retiring=false;}
  return this.status(generation);
 }
 async accept(generation:number,boot:string,id:string):Promise<boolean>{
  return this.update(s=>{
   if(s.phase!=='ready'||s.generation!==generation||s.boot!==boot||!attempt.test(id)||s.ids.includes(id)||s.ids.length>=64)return false;
   s.ids.push(id);return true;
  });
 }
}
