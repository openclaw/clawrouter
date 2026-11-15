import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createProviderApiKeyResolver, createProviderAuthResolver } from "../../src/agents/models-config.providers.secrets.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";
import * as guard from "../../src/infra/net/fetch-guard.js";

const pin="2d1a1c293537ed34fdbf0f496d364aec575e5ba9";
const origin=process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Provider="baseten"|"arcee"|"novita";
type Case={id:string;provider:Provider;group:string;scenario:string;api:"stream"|"simple";workerOnly:boolean};
const rows=JSON.parse(process.env.CLAWROUTER_PRIVATE_CATALOG_CASES!) as Case[];
const providers:Provider[]=["baseten","arcee","novita"];
const groups=["stream","simple","empty","opaque","foreign","environment","rotation","revocation","warm","held","request","invalid","preabort","partial"];
const envNames={baseten:"BASETEN_API_KEY",arcee:"ARCEEAI_API_KEY",novita:"NOVITA_API_KEY"};
const nativeFetch=globalThis.fetch,undici=createRequire(import.meta.url)("undici/index.js") as typeof import("undici"),originalUndiciFetch=undici.fetch;
const originalGuard=guard.fetchWithSsrFGuard;
const key=(row:Case,kind="inference",secret="fixture-secret")=>`clawrouter-live-${row.id}_${kind}-${secret}`;
const base=(row:Case,alias=false)=>origin+"/v1/native/"+(alias?"clawrouter-":"")+row.provider;
type Original={kind:string;pending:Promise<unknown>;state:"pending"|"fulfilled"|"rejected";reason?:unknown};
type Transport={method:string;path:string;credential:string|null;signal:AbortSignal|undefined;dispatcher:unknown;response?:Response;guardObserved:boolean;releases:number;releaseDone:boolean;
 bodies:ReadableStream[];readers:Array<{unlocks:number}>;closes:Promise<unknown>[]};
function throwFailures(failures:unknown[]):void{if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"private client body and original cleanup failed");}
async function command(row:Case,kind:string,value:unknown={}){const r=await nativeFetch(origin+"/private-control/"+kind+"/"+row.id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});const text=await r.text();expect(r.status).toBe(200);return JSON.parse(text);}

async function fixture(row:Case,body:(f:Awaited<ReturnType<typeof session>>)=>Promise<void>){
 const state=await createOpenClawTestState({label:"private-catalog-client"});const failures:unknown[]=[],originals:Original[]=[],observers:Promise<unknown>[]=[],restores:Array<()=>void>=[],transports:Transport[]=[];
 const track=<T>(kind:string,pending:Promise<T>):Promise<T>=>{const o:Original={kind,pending,state:"pending"};originals.push(o);observers.push(pending.then(()=>{o.state="fulfilled";},reason=>{o.state="rejected";o.reason=reason;}));return pending;};
 const invoke=<T>(kind:string,fn:()=>Promise<T>)=>{try{return track(kind,fn());}catch(e){failures.push(e);throw e;}};
 const observer=(p:Promise<unknown>)=>{observers.push(p.then(()=>{},e=>{failures.push(e);}));};
 const patch=(object:any,name:string,value:any)=>{const descriptor=Object.getOwnPropertyDescriptor(object,name);Object.defineProperty(object,name,{configurable:true,writable:true,value});restores.push(()=>{expect(Object.getOwnPropertyDescriptor(object,name)?.value).toBe(value);if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];});};
 const observedBodies=new WeakSet<object>(),observedDispatchers=new WeakSet<object>();
 const observeBody=(response:Response,t:Transport)=>{const b=response.body;if(!b||observedBodies.has(b))return;observedBodies.add(b);t.bodies.push(b);
  const cancel=b.cancel,get=b.getReader;patch(b,"cancel",function(this:ReadableStream,...args:Parameters<typeof cancel>){return invoke("body_cancel",()=>Reflect.apply(cancel,this,args));});
  patch(b,"getReader",function(this:ReadableStream,...args:any[]){let reader;try{reader=Reflect.apply(get,this,args);}catch(e){failures.push(e);throw e;}const r={unlocks:0};t.readers.push(r);track("closed",reader.closed);
   for(const kind of ["read","cancel"]){const original=reader[kind];patch(reader,kind,function(this:unknown,...args:unknown[]){return invoke(kind,()=>Reflect.apply(original,this,args));});}
   const release=reader.releaseLock;patch(reader,"releaseLock",function(this:unknown,...args:unknown[]){try{const result=Reflect.apply(release,this,args);r.unlocks++;return result;}catch(e){failures.push(e);throw e;}});return reader;});
 };
 const observedFetch=(fetcher:Function,receiver:unknown)=>(input:RequestInfo|URL,init?:DispatcherAwareRequestInit):Promise<Response>=>{
  const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);expect(u.origin).toBe(origin);expect(u.search).toBe("");
  expect([base(row)+"/models",base(row,true)+"/models",base(row)+"/chat/completions",base(row,true)+"/chat/completions"]).toContain(u.href);
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined)),t:Transport={path:u.pathname,method:init?.method??(input instanceof Request?input.method:"GET"),credential:headers.get("authorization"),signal:init?.signal??undefined,dispatcher:init?.dispatcher,guardObserved:false,releases:0,releaseDone:false,bodies:[],readers:[],closes:[]};
  expect(headers.has("x-api-key")).toBe(false);expect(headers.has("x-upstream-url")).toBe(false);expect(["inference","discovery","alternate"].flatMap(kind=>["fixture-secret","rotated-secret","invalid-secret"].map(secret=>"Bearer "+key(row,kind,secret)))).toContain(t.credential);expect(t.signal).toBeInstanceOf(AbortSignal);expect(t.dispatcher).toBeDefined();transports.push(t);
  const d=t.dispatcher as {close:Function};if(!observedDispatchers.has(d)){observedDispatchers.add(d);const close=d.close;let depth=0;patch(d,"close",function(this:unknown,...args:unknown[]){const outer=depth++===0;try{const result=Reflect.apply(close,this,args);if(outer&&result&&typeof result.then==="function"){t.closes.push(result);track("dispatcher_close",result);}return result;}catch(e){failures.push(e);throw e;}finally{depth--;}});}
  const pending=invoke("fetch",()=>Reflect.apply(fetcher,receiver,[input,init]) as Promise<Response>);observer(pending.then(response=>{t.response=response;observeBody(response,t);},()=>{}));return pending;
 };
 let f:Awaited<ReturnType<typeof session>>|undefined;
 try{
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
  for(const name of [...Object.values(envNames),"OPENAI_API_KEY","OPENROUTER_API_KEY"])vi.stubEnv(name,"synthetic-poison-unselected");
  // Ordinary function, not a mock: keep the guard's genuine dispatcher path.
  patch(globalThis,"fetch",observedFetch(nativeFetch,globalThis));
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observedFetch(originalUndiciFetch,undici)});
  vi.spyOn(guard,"fetchWithSsrFGuard").mockImplementation(function(this:unknown,...args:Parameters<typeof originalGuard>){
   const pending=Reflect.apply(originalGuard,this,args);observer(pending.then(result=>{const found=transports.filter(t=>t.response===result.response&&!t.guardObserved);expect(found).toHaveLength(1);const t=found[0];t.guardObserved=true;
    const release=result.release;patch(result,"release",function(this:unknown,...params:unknown[]){t.releases++;const p=invoke("guard_release",()=>Reflect.apply(release,this,params));observer(p.then(()=>{t.releaseDone=true;},()=>{}));return p;});
   },()=>{}));return pending;
  } as typeof originalGuard);
  f=await session(row,state,track,transports);await body(f);
 }catch(e){failures.push(e);}
 // Every original must finish before descriptor restoration or state disposal.
 // There is no cancellation disposition and no global dispatcher-pool close.
 let at=0,seen=0;
 while(at<originals.length||seen<observers.length){
  const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.map(o=>o.pending));
  const observed=observers.slice(seen);seen=observers.length;for(const r of await Promise.allSettled(observed))if(r.status==="rejected")failures.push(r.reason);
 }
 for(const o of originals)if(o.state==="rejected")failures.push(o.reason);else if(o.state!=="fulfilled")failures.push(new Error("original operation pending"));
 const check=async(fn:()=>unknown)=>{try{await fn();}catch(e){failures.push(e);}};
 if(!row.workerOnly&&row.scenario!=="cold")await check(()=>expect(transports.some(t=>t.method==="GET")).toBe(true));
 if(["eof","provider_error","environment","rotation","caller_revoke","grant_revoke","unpriced","foreign_inference","stream_abort","simple_abort"].includes(row.scenario))await check(()=>expect(transports.some(t=>t.method==="POST")).toBe(true));
 for(const t of transports){await check(()=>expect(t.guardObserved).toBe(true));await check(()=>expect(t.releases).toBe(1));await check(()=>expect(t.releaseDone).toBe(true));for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));}
 await check(()=>command(row,"join"));
 for(const restore of restores.toReversed())await check(restore);
 for(const cleanup of [()=>vi.restoreAllMocks(),()=>vi.unstubAllGlobals(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])await check(cleanup);
 throwFailures(failures);
}

async function session(row:Case,state:Awaited<ReturnType<typeof createOpenClawTestState>>,track:<T>(kind:string,p:Promise<T>)=>Promise<T>,transports:Transport[]){
 const {default:entry}=await loadBundledPluginFacade<{default:Parameters<typeof registerSingleProviderPlugin>[0]}>({pluginId:row.provider,artifactBasename:"index.js"});
 const plugin=await registerSingleProviderPlugin(entry);expect(plugin.id).toBe(row.provider);expect(plugin.catalog?.run).toBeTypeOf("function");
 const store:AuthProfileStore={version:1,profiles:{[row.provider+":selected"]:{type:"api_key",provider:row.provider,key:key(row,"discovery")},[row.provider+":other-label"]:{type:"api_key",provider:row.provider,key:key(row,"discovery")},"openai:poison":{type:"api_key",provider:"openai",key:"synthetic-foreign-profile"}}};await state.writeAuthProfiles(store);
 // Baseten selects configured auth first. Its env marker resolves the selected
 // discovery bytes; inference still receives a separate explicit proxy key.
 const discover=(options:{secret?:string;credential?:string;alias?:boolean;signal?:AbortSignal;profile?:string}={})=>{
  const config:OpenClawConfig={models:{providers:{[row.provider]:{baseUrl:base(row,options.alias),api:"openai-completions",apiKey:options.profile??(row.provider==="baseten"?envNames.baseten:key(row,"inference",options.secret)),models:[]}}}};
  const env=options.profile?{}:{[envNames[row.provider]]:options.credential??key(row,"discovery",options.secret)};
  const resolveProviderApiKey=createProviderApiKeyResolver(env,store,config),resolveProviderAuth=createProviderAuthResolver(env,store,config);
  const selected=row.provider==="baseten"?resolveProviderAuth(row.provider):resolveProviderApiKey(row.provider);
  expect(selected.discoveryApiKey).toBe(options.profile?key(row,"discovery"):options.credential??key(row,"discovery",options.secret));
  return track("catalog_result",plugin.catalog!.run({config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:options.signal,resolveProviderApiKey,resolveProviderAuth}));
 };
 const infer=(provider:any,options:{signal?:AbortSignal;credential?:string;api?:"stream"|"simple"}={})=>{
  expect([base(row),base(row,true)]).toContain(provider.baseUrl);expect(provider.api).toBe("openai-completions");
  const actual=provider.models.find((m:{id:string})=>m.id==="tenant/opaque-a");expect(actual).toBeDefined();
  const model={...actual,provider:row.provider,api:provider.api,baseUrl:provider.baseUrl} as Model<"openai-completions">;
  const context:Context={messages:[{role:"user",content:"synthetic private catalog request",timestamp:1}]};
  const which=options.api??row.api,plain=which==="stream"?stream:streamSimple;
  const hook=which==="stream"?plugin.wrapStreamFn:plugin.wrapSimpleCompletionStreamFn;
  const fn=row.provider==="baseten"?(expect(hook).toBeTypeOf("function"),hook!({streamFn:plain,sourceApi:model.api,modelId:model.id,config:{},providerId:row.provider} as Parameters<NonNullable<typeof hook>>[0])):plain;
  if(row.provider!=="baseten")expect(hook).toBeUndefined();
  const result=fn!(model,context,{apiKey:options.credential??key(row),signal:options.signal,maxTokens:16});return {stream:result,result:track("inference_result",result.result())};
 };
 return {discover,infer,transports};
}
function ready(result:any){expect(result.provider).toBeDefined();expect(result.provider.models.map((m:{id:string})=>m.id)).toContain("tenant/opaque-a");return result.provider;}
function failedCatalog(result:any,status:"auth-rejected"|"unavailable"){expect(result.provider).toBeUndefined();expect(Object.keys(result.providers??{})).toEqual([]);expect(result.outcomes).toContainEqual(expect.objectContaining({status}));}
async function completeInference(f:Awaited<ReturnType<typeof session>>,provider:any,options:Parameters<typeof f.infer>[1]={}){const result=f.infer(provider,options),value=await result.result;expect(value.stopReason).toBe("stop");expect(value.content).toContainEqual({type:"text",text:"private-prefix"});expect(value.usage).toMatchObject({input:4,output:3,totalTokens:7});return value;}
async function waitPrefix(row:Case){const end=Date.now()+5000;while(Date.now()<end){if((await command(row,"state")).prefix)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("owned prefix not observed");}

async function exercise(row:Case){await fixture(row,async f=>{
 const {scenario:s}=row;
 if(row.workerOnly){const path=base(row)+"/models"+(s==="query"?"?page=2":""),r=await nativeFetch(path,{method:s==="query"?"GET":"POST",headers:{authorization:"Bearer "+key(row),"content-type":"application/json"},...(s==="query"?{}:{body:JSON.stringify(s==="body"?{account:"foreign"}:{})})});await r.arrayBuffer();expect([400,405]).toContain(r.status);expect((await command(row,"state")).calls).toBe(0);expect(f.transports).toHaveLength(0);return;}
 if(s==="foreign_discovery"){failedCatalog(await f.discover({credential:key(row,"discovery","invalid-secret")}),"auth-rejected");expect((await command(row,"state")).calls).toBe(0);return;}
 if(s==="cold"){const c=new AbortController();c.abort(new Error("synthetic preabort"));failedCatalog(await f.discover({signal:c.signal}),"unavailable");expect(f.transports).toHaveLength(0);expect((await command(row,"state")).calls).toBe(0);return;}
 if(s==="shared_abort"){
  const c=new AbortController(),original=f.discover({signal:c.signal}),survivor=f.discover();let bodyError=false,error:unknown;
  try{await waitPrefix(row);c.abort(new Error("synthetic shared waiter abort"));failedCatalog(await original,"unavailable");expect(c.signal.aborted).toBe(true);}catch(e){bodyError=true;error=e;}
  const failures:unknown[]=[];if(bodyError)failures.push(error);try{await command(row,"complete");}catch(e){failures.push(e);}try{ready(await survivor);}catch(e){failures.push(e);}throwFailures(failures);return;
 }
 if(["redirect","malformed","truncated","oversize"].includes(s)){failedCatalog(await f.discover(),"unavailable");expect((await command(row,"state")).calls).toBe(1);return;}
 const catalog=await f.discover();
 if(s==="empty"){expect(catalog.provider.models).toEqual([]);expect((await f.discover()).provider.models).toEqual([]);expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="narrow"){expect(catalog.provider.models).toEqual([]);return;}
 const provider=ready(catalog);
 if(s==="broaden"){expect(provider.models.map((m:{id:string})=>m.id)).toEqual(["tenant/opaque-a"]);return;}
 if(s==="unpriced"){expect(provider.models[0].cost).toMatchObject({input:0,output:0});const value=await f.infer(provider).result;expect(value.stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="warm"){await f.discover();expect((await command(row,"state")).calls).toBe(1);await f.discover({profile:row.provider+":selected"});await f.discover({profile:row.provider+":other-label"});expect((await command(row,"state")).calls).toBe(1);await f.discover({alias:true});expect((await command(row,"state")).calls).toBe(2);await f.discover({credential:key(row,"alternate")});expect((await command(row,"state")).calls).toBe(3);return;}
 if(s==="warm_abort"){const c=new AbortController();c.abort(new Error("synthetic warm preabort"));failedCatalog(await f.discover({signal:c.signal}),"unavailable");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="caller_revoke"||s==="grant_revoke"){await command(row,"mutate",{kind:s});const value=await f.infer(provider).result;expect(value.stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);const denied=await f.discover({alias:true});failedCatalog(denied,s==="caller_revoke"?"auth-rejected":"unavailable");return;}
 if(s==="rotation"){await command(row,"mutate",{kind:"rotation"});const before=(await command(row,"state")).calls;expect((await f.infer(provider).result).stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(before);const current=ready(await f.discover({secret:"rotated-secret"}));await completeInference(f,current,{credential:key(row,"inference","rotated-secret")});return;}
 if(s==="foreign_inference"){expect((await f.infer(provider,{credential:key(row,"inference","invalid-secret")}).result).stopReason).toBe("error");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="inference_abort"){const c=new AbortController();c.abort(new Error("synthetic inference preabort"));expect((await f.infer(provider,{signal:c.signal}).result).stopReason).toBe("aborted");expect((await command(row,"state")).calls).toBe(1);return;}
 if(s==="stream_abort"||s==="simple_abort"){const c=new AbortController(),pending=f.infer(provider,{signal:c.signal});let partial=false;for await(const event of pending.stream){if(event.type==="text_delta"){partial=true;c.abort(new Error("synthetic original caller abort"));break;}}expect(partial).toBe(true);expect((await pending.result).stopReason).toBe("aborted");return;}
 if(s==="provider_error"){const c=new AbortController();expect((await f.infer(provider,{signal:c.signal}).result).stopReason).toBe("error");expect(c.signal.aborted).toBe(false);return;}
 await completeInference(f,provider);
});}

describe("registered private catalogs with native Worker and SQLite",()=>{
 for(const provider of providers)for(const group of groups)it(provider+" "+group,async()=>{
  const selected=rows.filter(r=>r.provider===provider&&r.group===group);expect(selected.length).toBeGreaterThan(0);
  // Forty-two registrations retain every expanded scenario. They do not replace
  // individual request assertions or enlarge native runner/child time limits.
  for(const row of selected)await exercise(row);
 });
});
