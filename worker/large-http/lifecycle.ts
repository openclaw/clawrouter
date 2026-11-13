import {DurableObject} from 'cloudflare:workers';
import type {Env} from '../types.ts';
import {readJson} from '../utils.ts';
import {ContinuousController,continuousAlarmDelay,type ContinuousState,type ContinuousStore,type AdmissionReceipt} from './continuous.ts';
import {EpochController,type AtomicStore,type Epoch} from './epoch.ts';
import {NativeSlot,type NativeJournal} from './native-slot.ts';
import {runtimeConfig,type RuntimeConfig} from './config.ts';
import {health} from './health.ts';
import {startupInspection} from './inspection.ts';
import {lifecycleCall} from './lifecycle-client.ts';
import {bootstrap} from '../../runtime/large-http/bootstrap.ts';
import {largeCreatePath,requestTarget} from './headers.ts';
function store<S>(ctx:DurableObjectState,key:string):AtomicStore<S>{return {update:fn=>ctx.storage.transaction(async tx=>{const result=fn(await tx.get<S>(key));await tx.put(key,result.state);return result.value;})};}
function continuousStore(ctx:DurableObjectState):ContinuousStore{return {
 ...store<ContinuousState>(ctx,'continuous'),
 admission:(operationId,fn)=>ctx.storage.transaction(async tx=>{
  const key='admission:'+operationId,result=fn(await tx.get<ContinuousState>('continuous'),await tx.get<AdmissionReceipt>(key));
  await tx.put('continuous',result.state);if(result.receipt)await tx.put(key,result.receipt);return result.value;
 })
};}
const digest=/^[a-f0-9]{64}$/,bootId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
interface SlotInspection {slot:number;protocol:1|null;generation:number|null;phase:string;boot:string|null;fingerprint:string|null;runtimeSha:string|null;config:{fingerprint:string;runtimeSha:string}|null}
export class LargeHttpPool extends DurableObject<Env>{
 private controller:Promise<EpochController|ContinuousController>;
 private config:Promise<RuntimeConfig>;
 constructor(ctx:DurableObjectState,e:Env){
  super(ctx,e);this.config=runtimeConfig(e);this.controller=this.config.then(config=>new (e.LARGE_HTTP_DEADLINE?EpochController:ContinuousController)(e.LARGE_HTTP_DEADLINE?store<any>(ctx,'epoch'):continuousStore(ctx),Object.fromEntries(['prepare','status','retire'].map(op=>[op,async(slot:number,generation:number)=>{
   const r=await e.LARGE_HTTP_SLOTS!.getByName('large-http-slot-'+slot).fetch('https://slot/control/'+op,{method:'POST',headers:{'x-container-token':e.LARGE_HTTP_TOKEN!},body:JSON.stringify({generation}),signal:AbortSignal.timeout(3000)});
   if(!r.ok)throw Error('slot_unavailable');return r.json();
  }])) as any,()=>config));
 }
 private async inspectSlot(slot:number):Promise<SlotInspection>{
  const unknown:SlotInspection={slot,protocol:null,generation:null,phase:'unknown',boot:null,fingerprint:null,runtimeSha:null,config:null};
  try{
   const r=await this.env.LARGE_HTTP_SLOTS!.getByName('large-http-slot-'+slot).fetch('https://slot/control/state',{method:'POST',headers:{'x-container-token':this.env.LARGE_HTTP_TOKEN!},body:'{}',signal:AbortSignal.timeout(3000)});
   if(!r.ok)return unknown;const s=await r.json() as any;
   if(s?.schema!==1||!Number.isSafeInteger(s.generation)||s.generation<0||!['idle','starting','ready','failed','destroying','destroyed','stopped','blocked'].includes(s.phase)||typeof s.boot!=='string'||s.boot!==''&&!bootId.test(s.boot)||!digest.test(s.fingerprint))return unknown;
   const config=s.control?.schema===1&&s.control.slot===slot&&digest.test(s.control.runtimeSha)&&digest.test(s.control.fingerprint)?{runtimeSha:s.control.runtimeSha as string,fingerprint:s.control.fingerprint as string}:null;
   // Whitelist fields: never forward the token, IDs, or arbitrary protocol data.
   return {slot,protocol:config?1:null,generation:s.generation,phase:s.phase,boot:s.boot,fingerprint:s.fingerprint,runtimeSha:config&&digest.test(s.runtimeSha)?s.runtimeSha:null,config};
  }catch{return unknown;}
 }
 private async snapshot(){
  const c=await this.config,slots=await Promise.all(Array.from({length:8},(_,i)=>this.inspectSlot(i)));
  // Re-read after remote observations. Qualification compares the fresh slot
  // journal/config with canonical owners, never the allocator's ready bit alone.
  const result=await(await this.controller).command('snapshot',{}),s:Epoch|ContinuousState=result.state;
  return {...result,control:{schema:1,revision:s.schema===2?s.control?.revision??0:null,fenced:s.schema===2&&s.control!==undefined,runtimeSha:c.runtimeSha,fingerprint:c.fingerprint},slots:slots.map(o=>{
   const m=s.schema===2?s.slots[o.slot]:null,owner=s.pool.members[o.slot];
   const matchesPool=s.schema===2?m!.phase==='ready'&&m!.generation===o.generation&&m!.fingerprint===c.fingerprint:s.phase==='serving'&&s.generation===o.generation&&s.fingerprint===c.fingerprint;
   return {...o,qualified:o.protocol===1&&o.phase==='ready'&&matchesPool&&!!owner&&!owner.quarantined&&owner.boot===o.boot&&o.fingerprint===c.fingerprint&&o.runtimeSha===c.runtimeSha&&o.config?.fingerprint===c.fingerprint&&o.config?.runtimeSha===c.runtimeSha};
  })};
 }
 private async arm(){const result=await(await this.controller).command('snapshot',{}),s:Epoch|ContinuousState=result.state;
  const now=Date.now(),at=now+(this.env.LARGE_HTTP_DEADLINE?(s.phase==='serving'?5000:s.phase==='closed'?60000:1000):continuousAlarmDelay(s as ContinuousState,await this.config,now));
  const wake=(!this.env.LARGE_HTTP_DEADLINE&&s.phase!=='closed')||s.phase!=='closed'||this.env.LARGE_HTTP_ENABLED!=='0'&&now<Number(this.env.LARGE_HTTP_DEADLINE);
  if(wake)await this.ctx.storage.transaction(async tx=>{const existing=await tx.getAlarm();if(existing===null||at<existing)await tx.setAlarm(at);});
 }
 async alarm(){try{await(await this.controller).tick();}finally{await this.arm();}}
 async fetch(r:Request):Promise<Response>{
  if(r.headers.get('x-container-token')!==this.env.LARGE_HTTP_TOKEN)return new Response(null,{status:403});
  if(r.method!=='POST')return new Response(null,{status:405});
  const op=new URL(r.url).pathname.slice(1),v=await readJson<any>(r,undefined,4096);
  if(op==='activate'){await this.ctx.storage.setAlarm(Date.now()+1);return Response.json({status:200});}
  if(!['snapshot','admit','claim','dispatch','finish','admission'].includes(op))return Response.json({status:404},{status:404});
  const result=await(await this.controller).command(op,v);await this.arm();return Response.json(op==='snapshot'?await this.snapshot():result,{status:result.status});
 }
}
export class LargeHttpSlot extends DurableObject<Env>{
 private slot:Promise<NativeSlot>;
 private config:Promise<RuntimeConfig>;
 private index:number;
 constructor(ctx:DurableObjectState,e:Env){
  super(ctx,e);this.index=Array.from({length:8},(_,i)=>i).find(i=>ctx.id.toString()===e.LARGE_HTTP_SLOTS!.idFromName('large-http-slot-'+i).toString())??-1;
  this.config=runtimeConfig(e);
  this.slot=this.config.then(config=>{
   const c=ctx.container;if(!c||this.index<0)throw Error('native_unavailable');
   let inspectionGeneration=0,inspection=startupInspection(()=>c.inspect());
   return new NativeSlot(store<NativeJournal>(ctx,'native'),{
    absent:async()=>!c.running&&await c.inspect()===null,
    start:(generation,token)=>c.start({image:config.image,instance:'standard-1',enableInternet:true,labels:{slot:String(this.index),generation:String(generation),build:config.runtimeSha},entrypoint:['node','--input-type=module','-e',bootstrap],env:{LARGE_HTTP_SLOT:String(this.index),LARGE_HTTP_GENERATION:String(generation),LARGE_HTTP_RUNTIME_TOKEN:token,LARGE_HTTP_ORIGIN:config.origin,LARGE_HTTP_LOCAL:config.local?'1':'0',LARGE_HTTP_RUNTIME_SHA:config.runtimeSha,LARGE_HTTP_RUNTIME_BYTES:String(config.runtimeBytes)}}),
    monitor:()=>{const watch=c.monitor();ctx.waitUntil(watch.catch(()=>{}));return watch;},keepalive:()=>c.setInactivityTimeout(600000),destroy:()=>c.destroy(),
    ready:async(generation,token)=>{
     if(!c.running)return null;
     if(inspectionGeneration!==generation){inspectionGeneration=generation;inspection=startupInspection(()=>c.inspect());}
     const observed=inspection();if(observed.kind==='pending')return null;
     const info=observed.value;
     if(!info)return null;
     if(info.labels?.slot!==String(this.index)||info.labels?.generation!==String(generation)||info.labels?.build!==config.runtimeSha)throw Error('native_identity');
     if(info.image==='')return null;if(info.image!==config.image)throw Error('native_image');
     const h=await health(signal=>c.getTcpPort(8080).fetch('http://guest/startup-health',{headers:{'x-container-token':token},signal}),{pendingStartupHeaders:true});
     if(h.kind==='unavailable')return null;
     const v=h.value as any;
     if(h.status!==200||!v||v.ready!==true||v.slot!==this.index||v.generation!==generation||v.build!==config.runtimeSha||typeof v.boot!=='string')throw Error('runtime_identity');
     return v.boot;
    }
   },()=>config);
  });
 }
 async fetch(r:Request):Promise<Response>{
  if(r.headers.get('x-container-token')!==this.env.LARGE_HTTP_TOKEN)return new Response(null,{status:403});
  const p=new URL(r.url).pathname,slot=await this.slot;
  if(p.startsWith('/control/')&&r.method==='POST'){
   const v=await readJson<any>(r,undefined,4096),op=p.slice('/control/'.length);
   if(op==='authorize'){
    const s=await slot.state();return Response.json({authorized:s.generation===v.generation&&s.token===v.token&&['starting','ready','failed'].includes(s.phase),generation:s.generation,phase:s.phase,boot:s.boot});
   }
   if(op==='health'){const s=await slot.state();if(s.phase!=='ready')return new Response(null,{status:503});return this.ctx.container!.getTcpPort(8080).fetch('http://guest/health',{headers:{'x-container-token':s.token},signal:AbortSignal.timeout(2000)});}
   if(op==='state'){const {token:_,...state}=await slot.state(),c=await this.config;return Response.json({...state,control:{schema:1,slot:this.index,fingerprint:c.fingerprint,runtimeSha:c.runtimeSha}});}
   if(!['prepare','status','retire'].includes(op))return new Response(null,{status:404});
   const work=slot[op as 'prepare'|'status'|'retire'](v.generation);this.ctx.waitUntil(work);
   if(op==='status')return Response.json(await work);
   // A control acknowledgement observes the persisted intent, not cold native
   // completion. Subsequent alarms observe readiness/destruction independently.
   const s=await slot.state();return Response.json({generation:s.generation,phase:s.phase,boot:s.boot,reason:s.reason,...(s.phase==='stopped'?{absent:true}:{})});
  }
  if(!largeCreatePath(p)||r.method!=='POST')return new Response(null,{status:404});
  let grant;try{grant=JSON.parse(r.headers.get('x-large-http-grant')??'null');}catch{}
  if(!grant||grant.slot!==this.index||!await slot.accept(grant.generation,grant.boot,grant.id))return new Response(null,{status:409,headers:{'x-should-retry':'false'}});
  let claimed;try{claimed=await lifecycleCall(this.env,'claim',grant);}catch{return Response.json({error:{code:'claim_unknown'}},{status:424,headers:{'x-should-retry':'false'}});}
  if(claimed.status!==200)return new Response(null,{status:409,headers:{'x-should-retry':'false'}});
  if(r.signal.aborted){try{await lifecycleCall(this.env,'finish',{...grant,clean:true});}catch{}return new Response(null,{status:499});}
  const s=await slot.state(),headers=new Headers(r.headers);headers.set('x-container-token',s.token);
  try{return await this.ctx.container!.getTcpPort(8080).fetch(new Request('http://guest'+requestTarget(r.url),new Request(r,{headers})));}
  catch{return Response.json({error:{code:'upstream_delivery_unknown'}},{status:424,headers:{'x-should-retry':'false'}});}
 }
}
