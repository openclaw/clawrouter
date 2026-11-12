import {backgroundRecoveryHeader,correlationRequestId,setBackgroundRecovery} from '../correlation.ts';
import {authenticateProxyKey} from '../proxy-auth.ts';
import {sha256Hex} from '../utils.ts';
import type {Env} from '../types.ts';
import {largeCreatePath} from './headers.ts';
import {poolCall} from './control-client.ts';
import {probeUnknown,releaseProbe,type ProbeIntake} from './probe.ts';
import {mediaJsonBytes} from './runtime-limits.ts';
import {lifecycleCall} from './lifecycle-client.ts';

export interface LargeHttpEnv {
 LARGE_HTTP_ENABLED?: string;
 LARGE_HTTP_CAPACITY?: string;
 LARGE_HTTP_TENANT_LIMIT?: string;
 LARGE_HTTP_SLOT_STARTS_PER_HOUR?: string;
 LARGE_HTTP_LIFECYCLE?: string;
 LARGE_HTTP_POOL?: DurableObjectNamespace;
 LARGE_HTTP_SLOTS?: DurableObjectNamespace;
 LARGE_HTTP_TOKEN?: string;
 LARGE_HTTP_DEADLINE?: string;
 /** Canary-only controls. Never configured by the ordinary deployment. */
 LARGE_HTTP_TESTING?: string;
}
const routes=new WeakMap<Request,string>();
export const largeHttpRoute=(r:Request)=>routes.get(r);
function refusal(code:string,status:number,retry=true):Response {
 return Response.json({error:{code}},{status,headers:{'x-should-retry':String(retry),...(retry?{'retry-after':'1'}:{})}});
}
/** No reads, admission, body buffering or new starts for ordinary requests. */
export function largeHttp(request:Request,env:Env,intake?:ProbeIntake):Response|Promise<Response|Request>|undefined{
 if(mediaJsonBytes!==32_000_000||env.LARGE_HTTP_ENABLED==='0'||request.method!=='POST'||!largeCreatePath(new URL(request.url).pathname))return;
 const known=request.headers.has('content-length'),raw=request.headers.get('content-length');
 if(known&&!/^(?:0|[1-9]\d*)$/.test(raw!))return refusal('invalid_content_length',400,false);
 const length=known?Number(raw):null,testing=env.LARGE_HTTP_TESTING==='1';
 if(length!==null&&length<=32_000_000&&!(testing&&request.headers.get('x-canary-force-container')==='1')){if(testing)routes.set(request,'worker');return;}
 // Source-only/local deployments without the native service retain the
 // Worker envelope. Normal deploy provisioning supplies these bindings.
 if(length===null&&(!intake||!env.LARGE_HTTP_POOL||!env.LARGE_HTTP_SLOTS||!env.LARGE_HTTP_TOKEN))return;
 return admitLargeHttp(request,env,length,testing,intake);
}

async function admitLargeHttp(request:Request,env:Env,length:number|null,testing:boolean,intake?:ProbeIntake):Promise<Response|Request>{
 const ingress=request;
 const token=env.LARGE_HTTP_TOKEN,deadline=Number(env.LARGE_HTTP_DEADLINE??Number.MAX_SAFE_INTEGER);

 if(request.signal.aborted){releaseProbe(request);return new Response(null,{status:499});}
 // The qualified protocol surface is currently Responses create/compact.
 // Selection, transforms, credentials and accounting remain owned by the router.
 if(length===null&&! (testing&&request.headers.get('x-canary-force-container')==='1')){
  const probe=await probeUnknown(request,intake);request=probe.request;
  if(request.signal.aborted){releaseProbe(request);return new Response(null,{status:499});}
  if(probe.small){if(testing)routes.set(ingress,'worker');return request;}
 }
 // The canonical intake owns the prefix through the Worker envelope.
 // Previously supported bodies stay on its original authentication and budget
 // path. Larger streams authenticate before tenant admission and dispatch.
 let auth;
 try{auth=await authenticateProxyKey(request.headers,env);}
 catch(error){releaseProbe(request);throw error;}
 if(auth instanceof Response){releaseProbe(request);void request.body?.cancel().catch(()=>{});return auth;}
 if(length!==null&&(!Number.isSafeInteger(length)||length>64*1024*1024)){releaseProbe(request);return refusal('request_too_large',413,false);}
 if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity'){releaseProbe(request);return refusal('identity_required',415,false);}
 if(!/^[a-f0-9]{64}$/.test(token??'')||!Number.isSafeInteger(deadline)||Date.now()>=deadline||!env.LARGE_HTTP_POOL||!env.LARGE_HTTP_SLOTS){releaseProbe(request);return refusal('large_runtime_unavailable',503);}
 if(testing)routes.set(ingress,'container');
 const headers=new Headers(request.headers),requestId=correlationRequestId(ingress);
 if(requestId)headers.set('x-request-id',requestId);
 for(const name of [...headers.keys()])if(name.startsWith('x-large-http-')||name==='x-container-token'||name==='x-canary-pool-grant'||!testing&&name.startsWith('x-canary-'))headers.delete(name);
 const supplied=testing?headers.get('x-canary-trace-id'):null;
 if(supplied&&!/^prf_[a-f0-9]{32}$/.test(supplied)){releaseProbe(request);return refusal('invalid_attempt_id',400,false);}
 const id=supplied??'prf_'+crypto.randomUUID().replaceAll('-','');headers.set('x-canary-trace-id',id);
 const pool={CANARY_TOKEN:token!,POOL:env.LARGE_HTTP_POOL,DEADLINE:String(deadline)},tenant=await sha256Hex(token+':pool:'+(auth.policy.tenantId??'default'));
 if(request.signal.aborted){releaseProbe(request);return new Response(null,{status:499});}
 const lifecycle=env.LARGE_HTTP_LIFECYCLE==='1'||!env.LARGE_HTTP_DEADLINE;
 let result;try{
  const generation=lifecycle&&env.LARGE_HTTP_DEADLINE?(await lifecycleCall(env,'snapshot',{})).state.generation:undefined;
  result=lifecycle?await lifecycleCall(env,'admit',{id,tenant,generation}):await poolCall(pool,'admit',{id,tenant});
 }catch{releaseProbe(request);return refusal('admission_unknown',424,false);}
 if(result.status!==200){releaseProbe(request);void request.body?.cancel().catch(()=>{});return refusal(result.status===409?'duplicate_attempt':result.status===429?'tenant_capacity':'pool_capacity',result.status,result.status!==409);}
 if(request.signal.aborted){releaseProbe(request);return new Response(null,{status:499});}
 headers.set(lifecycle?'x-large-http-grant':'x-canary-pool-grant',JSON.stringify(result.grant));headers.set('x-container-token',token!);
 try{
  const response=await env.LARGE_HTTP_SLOTS.getByName((lifecycle?'large-http-slot-':'managed-router-')+result.grant.slot).fetch(new Request(request,{headers}));
  // The canonical native ingress has already removed provider/caller spoofing.
  // Restore its response-only locator to this ingress's local metadata before
  // the outer response wrapper runs, including on uncertain/error delivery.
  const locator=response.headers.get(backgroundRecoveryHeader);
  if(locator&&/^[0-9a-f]{64}\.bg_[0-9a-f]{32}$/.test(locator))setBackgroundRecovery(ingress,locator);
  return response;
 }
 catch{return refusal('upstream_delivery_unknown',424,false);}
 finally{releaseProbe(request);}
}
