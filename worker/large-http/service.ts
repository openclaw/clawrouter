import type {Env} from '../types.ts';
import {readJson} from '../utils.ts';
import {runtimeFields} from './config.ts';
import {lifecycleCall} from './lifecycle-client.ts';
declare const __LARGE_HTTP_RUNTIME_SHA__:string;
const prefix='/__large_http/';
/** Private control and canonical binding bridge; remains available for drain. */
export async function largeHttpService(r:Request,e:Env):Promise<Response>{
 if(!e.LARGE_HTTP_SLOTS||!e.LARGE_HTTP_POOL||!e.LARGE_HTTP_TOKEN)return new Response(null,{status:404});
 const slot=Number(r.headers.get('x-large-http-slot')),generation=Number(r.headers.get('x-large-http-generation')),token=r.headers.get('x-large-http-token');
 if(!Number.isSafeInteger(slot)||slot<0||slot>=8||!Number.isSafeInteger(generation)||generation<1||!token||!/^[a-f0-9]{64}$/.test(token))return new Response(null,{status:403});
 const auth=await e.LARGE_HTTP_SLOTS.getByName('large-http-slot-'+slot).fetch('https://slot/control/authorize',{method:'POST',headers:{'x-container-token':e.LARGE_HTTP_TOKEN},body:JSON.stringify({generation,token}),signal:AbortSignal.timeout(3000)});
 if(!auth.ok)return new Response(null,{status:403});const state=await auth.json<any>();if(state.authorized!==true)return new Response(null,{status:403});
 const op=new URL(r.url).pathname.slice(prefix.length);
 if(op==='runtime'&&r.method==='GET'){
  // Versioned static assets keep native source out of Worker module startup.
  // Worker-first routing and the slot authorization above guard public access;
  // only this binding call reaches the immutable, content-addressed artifact.
  if(typeof __LARGE_HTTP_RUNTIME_SHA__!=='string'||!e.ASSETS)return new Response(null,{status:503});
  try{
   const artifact=await e.ASSETS.fetch('https://runtime.invalid/__large_http/artifact/'+__LARGE_HTTP_RUNTIME_SHA__+'.mjs');
   if(artifact.status!==200||!artifact.body){await artifact.body?.cancel();return new Response(null,{status:503});}
   return new Response(artifact.body,{headers:{'content-type':'text/javascript','cache-control':'no-store','x-content-type-options':'nosniff'}});
  }catch{return new Response(null,{status:503});}
 }
 if(op==='settings'&&r.method==='GET')return Response.json(Object.fromEntries(runtimeFields.filter(k=>typeof e[k]==='string').map(k=>[k,e[k]])),{headers:{'cache-control':'no-store'}});
 if(r.method!=='POST')return new Response(null,{status:405});
 if(op==='archive'){
  const key=r.headers.get('x-archive-key')??'',size=Number(r.headers.get('content-length'));
  if(!/^v1\/[^/]{1,512}\/content_[a-f0-9]{32}\.json$/.test(key)||!Number.isSafeInteger(size)||size<1||size>65*1024*1024||!r.body)return new Response(null,{status:400});
  const options=JSON.parse(r.headers.get('x-archive-options')??'{}');
  if(options.httpMetadata?.contentType!=='application/json'||!/^\d{13}$/.test(options.customMetadata?.expiresAt??''))return new Response(null,{status:400});
  await e.CONTENT_ARCHIVE.put(key,r.body.pipeThrough(new FixedLengthStream(size)),options);return Response.json({stored:true});
 }
 const v=await readJson<any>(r,undefined,1024*1024);
 if(op==='dispatch'||op==='finish'){
  if(v.generation!==generation||v.slot!==slot||v.boot!==state.boot||state.phase!=='ready'&&op==='dispatch')return new Response(null,{status:409});
  const result=await lifecycleCall(e,op,v);return Response.json(result,{status:result.status});
 }
 if(op==='do'){
  if(!['ACCESS_CONTROL','BUDGET_LEDGER','USAGE_LEDGER','GRANT_CREDENTIALS','CONTENT_CLEANUP'].includes(v.binding)||typeof v.name!=='string'||v.name.length>512||typeof v.url!=='string'||!['GET','POST'].includes(v.method)||!(v.body===null||typeof v.body==='string')||new URL(v.url).origin!=='https://clawrouter.internal')return new Response(null,{status:400});
  if(v.headers!==undefined&&(!Array.isArray(v.headers)||v.headers.length>100||!v.headers.every((h:unknown)=>Array.isArray(h)&&h.length===2&&h.every(x=>typeof x==='string'))))return new Response(null,{status:400});
  const ns=e[v.binding] as DurableObjectNamespace;return ns.get(ns.idFromName(v.name)).fetch(v.url,{method:v.method,headers:v.headers,body:v.body,signal:r.signal,redirect:'manual'});
 }
 if(op==='queue'){await e.USAGE_QUEUE.send(v.body);return Response.json({sent:true});}
 if(op==='kv'){
  if(v.type==='stream'){
   if(typeof v.key!=='string')return new Response(null,{status:400});
   const body=await e.POLICY_KV.get(v.key,'stream');return new Response(body,{headers:{'x-large-http-kv-present':body===null?'0':'1'}});
  }
  if(!(typeof v.key==='string'||Array.isArray(v.key)&&v.key.length<=100&&v.key.every((k:unknown)=>typeof k==='string'))||!['text','json'].includes(v.type))return new Response(null,{status:400});
  const value:any=await e.POLICY_KV.get(v.key,v.type);return Response.json(value instanceof Map?{entries:[...value]}:{value});
 }
 return new Response(null,{status:404});
}
