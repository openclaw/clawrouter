// Explicit synthetic-only build entry. The production entry never imports this.
import {WorkerEntrypoint} from 'cloudflare:workers';
import handler from './index.ts';
import {LargeHttpSlot as ProductionSlot} from './large-http/lifecycle.ts';
import {largeCreatePath} from './large-http/headers.ts';
import {authorizeAdmin} from './access.ts';
import {readJson,sha256Hex} from './utils.ts';
import {rehearsalConfig,journal,journalCall,type RehearsalEnv} from './native-rehearsal/contract.ts';
export {PolicyBindingIndexObject,BudgetLedgerObject,GrantCredentialObject,UsageLedgerObject,ContentArchiveCleanupObject} from './index.ts';
export {LargeHttpPool} from './large-http/lifecycle.ts';
export {NativeRehearsalState} from './native-rehearsal/state.ts';
export class LargeHttpSlot extends ProductionSlot {
 protected override async startContainer(options:ContainerStartupOptions){
  const c=rehearsalConfig(this.env),slot=Number(options.env!.LARGE_HTTP_SLOT),generation=Number(options.env!.LARGE_HTTP_GENERATION),runtimeSha=options.env!.LARGE_HTTP_RUNTIME_SHA;
  // Durable budget intent precedes every native start, including a failed one.
  await journalCall(this.env,'start',{slot,generation,runtimeSha});
  const exports=this.ctx.exports as {NativeRehearsalEgress:(options:{props:{slot:number;generation:number;runtimeSha:string}})=>Fetcher;NativeRehearsalDeny:Fetcher};
  const container=this.ctx.container!,outbound=exports.NativeRehearsalEgress({props:{slot,generation,runtimeSha}});
  await container.interceptOutboundHttps('api.openai.com',outbound);
  await container.interceptOutboundHttps(new URL(c.origin).hostname,outbound);
  await container.interceptAllOutboundHttp(exports.NativeRehearsalDeny);
  // No public fallback, other ports or DNS egress. Runtime-provided ephemeral CA
  // is trusted by Node; verification is never disabled. Native bytes unchanged.
  rehearsalConfig(this.env);
  container.start({...options,enableInternet:false,env:{...options.env,NODE_EXTRA_CA_CERTS:'/etc/cloudflare/certs/cloudflare-containers-ca.crt'},
   entrypoint:['node','--input-type=module','-e','setTimeout(()=>process.exit(1),'+(c.expiresAt-Date.now())+');'+options.entrypoint![3]]});
 }
}
export class NativeRehearsalDeny extends WorkerEntrypoint {fetch(){return new Response(null,{status:403});}}
export class NativeRehearsalEgress extends WorkerEntrypoint<RehearsalEnv,{slot:number;generation:number;runtimeSha:string}> {
 async fetch(r:Request):Promise<Response>{
  const c=rehearsalConfig(this.env,Date.now(),true),u=new URL(r.url),props=this.ctx.props;
  if(u.username||u.password||u.search||u.hash)return new Response(null,{status:403});
  if(u.origin==='https://api.openai.com'&&u.pathname==='/v1/responses'&&r.method==='POST'){
   rehearsalConfig(this.env);
   const headers=new Headers(r.headers);headers.set('x-rehearsal-slot',String(props.slot));headers.set('x-rehearsal-generation',String(props.generation));headers.set('x-rehearsal-runtime',props.runtimeSha);
   return journal(this.env).fetch(new Request('https://rehearsal/upstream',new Request(r,{headers})));
  }
  // Preserve real authorization, fencing, DO/KV/queue/accounting implementation.
  // Only the owned callback origin is forwarded, never a provider or redirect.
  const op=u.pathname.slice('/__large_http/'.length);
  if(u.origin!==c.origin||!u.pathname.startsWith('/__large_http/')||!(['runtime','settings'].includes(op)&&r.method==='GET'||['dispatch','finish','do','kv','queue','archive'].includes(op)&&r.method==='POST'))return new Response(null,{status:403});
  let event:any;
  if(['dispatch','finish','do','queue'].includes(op)){
   const v=await readJson<any>(r.clone() as Request,undefined,1024*1024);
   event={op,...props};
   if(typeof v.id==='string')event.idHash=await sha256Hex(v.id);
   if(op==='finish')event.clean=v.clean===true;
   if(op==='queue'&&v.body?.type==='clawrouter.usage.v1'){
    const x=v.body;event.usage={idHash:await sha256Hex(String(x.id)),requestIdHash:await sha256Hex(String(x.request_id)),actualCostMicros:x.actual_cost_micros,reservedCostMicros:x.reserved_cost_micros,status:x.status,statusCode:x.status_code,contentRetained:x.content_retained};
   }
  }
  const response=await fetch(r,{redirect:'error'});
  if(event)await journalCall(this.env,'callback',{...event,status:response.status});
  return response;
 }
}
export default {
 async fetch(r:Request,e:RehearsalEnv,ctx:ExecutionContext){
  try{
   const p=new URL(r.url).pathname;
   rehearsalConfig(e,Date.now(),p.startsWith('/__native_rehearsal/')||p.startsWith('/__large_http/')||p==='/v1/admin/large-http');
   if(p.startsWith('/__native_rehearsal/')){
    const auth=await authorizeAdmin(r,e);if(auth instanceof Response)return auth;
    const op=p.slice('/__native_rehearsal/'.length);
    if(!['setup','snapshot','release','close'].includes(op)||r.method!=='POST')return new Response(null,{status:404});
    if(op==='setup')rehearsalConfig(e);
    return journal(e).fetch(new Request('https://rehearsal/'+op,r));
   }
   if(r.method==='POST'&&largeCreatePath(p)){
    const headers=new Headers(r.headers);headers.set('x-canary-force-container','1');r=new Request(r,{headers});
   }else if(p.startsWith('/v1/')&&p!=='/v1/admin/large-http'&&!['/v1/health','/v1/providers','/v1/catalog'].includes(p))return new Response(null,{status:403});
   return handler.fetch!(r as Request<unknown,IncomingRequestCfProperties>,e,ctx);
  }catch{return Response.json({error:{code:'synthetic_rehearsal_refused'}},{status:503});}
 },
 queue:handler.queue,
 scheduled:handler.scheduled,
};
