import {DurableObject} from 'cloudflare:workers';
import {Capacity, type Journal, type Native} from './capacity.ts';
import {StartupReadiness} from './readiness.ts';
import {health} from './health.ts';
import {emptyBody} from './empty.ts';
import {largeCreatePath,requestTarget} from './headers.ts';
import {poolCall} from './pool.ts';
declare const __LARGE_HTTP_BOOTSTRAP__:string;
const bootstrap=__LARGE_HTTP_BOOTSTRAP__;
export interface SlotEnv {SLOTS:DurableObjectNamespace;POOL:DurableObjectNamespace;MODE:string;HOST:string;CANARY_TOKEN:string;IMAGE:string;SESSION:string;DEADLINE:string;RUNTIME_SHA:string;RUNTIME_BYTES:string;LOCAL_ORIGIN?:string;LOCAL_CAPACITY_ORIGIN?:string}
export class ManagedSlot extends DurableObject<SlotEnv> {
 private capacity?:Capacity;
 private index=-1;
 private readiness?:StartupReadiness;
 private acknowledgement:'pending'|'resolved'|'rejected'='pending';
 private starts=0;
 private nativeEvents:any[]=[];
 private async inspectNative(){const event:any={kind:'inspect',startedAt:Date.now()};if(this.nativeEvents.length<128)this.nativeEvents.push(event);try{const x=await this.ctx.container!.inspect();event.ok=true;event.present=x!==null;event.imageMatches=x?.image===this.env.IMAGE;event.labelsMatch=x?.labels?.session===this.env.SESSION&&x?.labels?.member==='B'&&x?.labels?.permit==='1';return x;}catch(e){event.ok=false;throw e;}finally{event.ms=Date.now()-event.startedAt;}}
 private tail:Promise<unknown>=Promise.resolve();
 constructor(ctx:DurableObjectState,e:SlotEnv){
  super(ctx,e);const c=ctx.container,deadline=Number(e.DEADLINE);
  this.index=Array.from({length:8},(_,i)=>i).find(i=>ctx.id.toString()===e.SLOTS.idFromName('managed-router-'+i).toString())??-1;
  if(!c||this.index<0||
    !Number.isSafeInteger(deadline)||!/^[a-f0-9-]{36}$/.test(e.SESSION)||
    !(e.MODE==='local'?c.images.base===e.IMAGE:/^clawrouter-payload-managed-[a-f0-9]{12}\.services-91b\.workers\.dev$/.test(e.HOST)&&e.IMAGE==='cloudflare/debian-trixie'&&Object.keys(c.images).length===0))return;
  this.readiness=new StartupReadiness({acknowledgement:()=>this.acknowledgement,running:()=>c.running,inspect:()=>this.inspectNative(),
    health:()=>health(signal=>c.getTcpPort(8080).fetch('http://guest/startup-health',{headers:{'x-container-token':e.CANARY_TOKEN},signal}))},
    {session:e.SESSION,image:e.IMAGE,deadline});
  const native:Native={absent:async()=>!c.running&&await c.inspect()===null,
    start:g=>{
      if(g!==1||this.starts||Date.now()>=deadline)throw Error('start_forbidden');this.starts++;
      c.start({image:e.IMAGE,instance:'standard-1',enableInternet:true,
        labels:{session:e.SESSION,member:'B',permit:'1'},entrypoint:['node','--input-type=module','-e',bootstrap],
        env:{CAPACITY_SLOT_ID:String(this.index),SESSION:e.SESSION,CANARY_TOKEN:e.CANARY_TOKEN,CANARY_BUILD_ID:e.RUNTIME_SHA,
          CANARY_BRIDGE_ORIGIN:e.MODE==='local'?e.LOCAL_ORIGIN!:'https://'+e.HOST,
          CANARY_UPSTREAM_ORIGIN:e.MODE==='local'?e.LOCAL_ORIGIN!:'https://'+e.HOST,
          CANARY_LOCAL:e.MODE==='local'?'1':'0',...(e.MODE==='local'?{CANARY_LOCAL_CAPACITY_ORIGIN:e.LOCAL_CAPACITY_ORIGIN!}:{}),RUNTIME_SHA:e.RUNTIME_SHA,RUNTIME_BYTES:e.RUNTIME_BYTES}});
    },monitor:()=>{const p=c.monitor();void p.then(()=>{this.nativeEvents.push({kind:'monitor',ok:true,at:Date.now()});},(error)=>{const m=String(error?.message??'').toLowerCase();this.nativeEvents.push({kind:'monitor',ok:false,at:Date.now(),flags:{engine:/docker|engine/.test(m),timeout:/timeout|timed out|deadline/.test(m),connection:/connection|socket|connect/.test(m),image:/image/.test(m),capacity:/limit|capacity|resource|memory/.test(m),destroyed:/destroy|stop|cancel/.test(m),start:/start/.test(m)}});});return p;},keepalive:()=>{
      void c.setInactivityTimeout(300000).then(()=>{this.acknowledgement='resolved';},()=>{this.acknowledgement='rejected';});
      // Startup check requires the actual native acknowledgement; this only
      // acknowledges issuing it, matching the qualified startup candidate.
      return Promise.resolve();
    },ready:()=>this.readiness!.check(),destroy:async()=>{throw Error('replacement_not_exposed');}};
  this.capacity=new Capacity({read:()=>ctx.storage.get('capacity'),write:(s:Journal)=>ctx.storage.put('capacity',s)},native,
    {identity:e.SESSION+':'+ctx.id.toString()+':'+e.IMAGE,deadline});
 }
 async fetch(r:Request):Promise<Response>{
  if(r.headers.get('x-container-token')!==this.env.CANARY_TOKEN||!this.capacity)return new Response(null,{status:403});
  const p=new URL(r.url).pathname;
  if(p.startsWith('/control/')){
    if(!await emptyBody(r))return new Response(null,{status:409});
    const result=this.tail.then(async()=>{
      if(p==='/control/state'&&r.method==='GET')return Response.json({capacity:(await this.capacity!.command('state')).state,
        starts:this.starts,nativeEvents:this.nativeEvents,readiness:this.readiness!.snapshot(),acknowledgement:this.acknowledgement,running:this.ctx.container!.running});
      if(r.method!=='POST'||!['/control/start','/control/check'].includes(p))return new Response(null,{status:404});
      const v=await this.capacity!.command(p.endsWith('start')?'start':'check',1);if(v.code===200){const registered=await poolCall(this.env,'ready',{slot:this.index,boot:this.readiness!.snapshot().boot});if(registered.status!==200)throw Error('pool_register_failed');}return Response.json(v,{status:v.code});
    });this.tail=result.catch(()=>{});try{return await result;}catch{return new Response(null,{status:503});}
  }
  if(Date.now()>=Number(this.env.DEADLINE))return new Response(null,{status:410});
  const s=await this.capacity.command('state');
  if(s.state.phase!=='ready'||!this.ctx.container!.running)return new Response(null,{status:503});
  if(!(['/health','/diagnostics'].includes(p)&&r.method==='GET'||largeCreatePath(p)&&r.method==='POST'))return new Response(null,{status:404});
  if(r.method==='POST'){
    if(r.signal.aborted)return new Response(null,{status:499});
    const id=r.headers.get('x-canary-trace-id');if(!id||!/^prf_[a-f0-9]{32}$/.test(id))return new Response(null,{status:400});
    const admitted=await this.ctx.storage.transaction(async tx=>{
      const n=await tx.get<number>('dispatch-count')??0;
      if(n>=64||await tx.get('intent:'+id)!==undefined)return false;
      await tx.put({'dispatch-count':n+1,['intent:'+id]:{at:Date.now(),boot:this.readiness!.snapshot().boot}});return true;
    });
    if(!admitted)return new Response(null,{status:409});
    let grant;try{grant=JSON.parse(r.headers.get('x-canary-pool-grant')??'null');}catch{}
    if(!grant||grant.id!==id||grant.slot!==this.index||grant.boot!==this.readiness!.snapshot().boot)return new Response(null,{status:409});
    if(r.signal.aborted)return new Response(null,{status:499});
    let claimed;try{claimed=await poolCall(this.env,'claim',grant);}catch{return Response.json({error:{code:'claim_unknown'}},{status:424,headers:{'x-should-retry':'false'}});}
    if(claimed.status!==200)return new Response(null,{status:409});
    if(r.signal.aborted){try{await poolCall(this.env,'finish',{...grant,clean:true});}catch{}return new Response(null,{status:499});}
  }
  try{return await this.ctx.container!.getTcpPort(8080).fetch(new Request('http://guest'+requestTarget(r.url),r));}
  catch{return Response.json({error:{code:'upstream_delivery_unknown'}},{status:424,headers:{'x-should-retry':'false'}});}
 }
}
