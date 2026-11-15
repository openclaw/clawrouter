import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createProviderApiKeyResolver, createProviderAuthResolver } from "../../src/agents/models-config.providers.secrets.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";

const pin = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Case = {id:string; mode:string; api:"stream"|"simple"};
const cases = JSON.parse(process.env.CLAWROUTER_BIFROST_CASES!) as Case[];
const nativeFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const nativeUndiciFetch = undici.fetch;
const nativeGuard = guard.fetchWithSsrFGuard;
const key = (id:string) => `clawrouter-live-${id}-fixture-secret`;
const discoveryKey=(row:Case)=>key(row.mode==='profile'?row.id:row.id+"_discovery");
type Original = {kind:string; pending:Promise<unknown>; state:"pending"|"fulfilled"|"rejected"; reason?:unknown};
type Transport = {path:string; signal?:AbortSignal; dispatcher?:NonNullable<DispatcherAwareRequestInit["dispatcher"]>;
  closeStarted:Promise<void>; notifyClose:()=>void; closes:unknown[]; bodies:ReadableStream[]; readers:Array<{unlocks:number}>; guardObserved:boolean; releases:number};

async function command(id:string,kind:string,body:unknown={}) {
  const response = await nativeFetch(origin+"/__bifrost/"+kind+"/"+id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const text = await response.text(); expect(response.status).toBe(200); return JSON.parse(text);
}
function throwFailures(failures:unknown[]):void {
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,"Bifrost originals and cleanup failed");
}

async function fixture(row:Case, body:(discover:()=>Promise<any>, control:AbortController, track:<T>(kind:string,promise:Promise<T>)=>Promise<T>, inferenceKey:string)=>Promise<void>) {
  const state = await createOpenClawTestState({label:"bifrost-worker-contract"});
  const failures:unknown[]=[], originals:Original[]=[], transports:Transport[]=[], observers:Promise<unknown>[]=[], restores:Array<()=>void>=[];
  const control=new AbortController();
  const retainObserver=(pending:Promise<unknown>)=>{observers.push(pending.then(()=>{},error=>{failures.push(error);}));};
  const observe=<T>(kind:string,pending:Promise<T>):Promise<T>=>{
    const record:Original={kind,pending,state:"pending"}; originals.push(record);
    retainObserver(pending.then(()=>{record.state="fulfilled";},reason=>{record.state="rejected";record.reason=reason;}));return pending;
  };
  const invoke=<T>(kind:string,run:()=>Promise<T>)=>{try{return observe(kind,run());}catch(error){failures.push(error);throw error;}};
  const patch=(object:any,name:string,replacement:any)=>{
    const descriptor=Object.getOwnPropertyDescriptor(object,name);
    Object.defineProperty(object,name,{configurable:true,writable:true,value:replacement});
    restores.push(()=>{expect(Object.getOwnPropertyDescriptor(object,name)?.value).toBe(replacement);if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];});
  };
  const bodies=new WeakSet<object>();
  const observeBody=(response:Response,t:Transport)=>{
    const b=response.body;if(!b||bodies.has(b))return;bodies.add(b);t.bodies.push(b);
    const get=b.getReader,cancel=b.cancel;
    patch(b,"cancel",function(this:ReadableStream,...args:any[]){return invoke("body_cancel",()=>Reflect.apply(cancel,this,args));});
    patch(b,"getReader",function(this:ReadableStream,...args:any[]){
      let reader;try{reader=Reflect.apply(get,this,args);}catch(error){failures.push(error);throw error;}const r={unlocks:0};t.readers.push(r);observe("closed",reader.closed);
      for(const name of ["read","cancel"]){const original=reader[name];patch(reader,name,function(this:unknown,...args:any[]){return invoke(name,()=>Reflect.apply(original,this,args));});}
      const release=reader.releaseLock;patch(reader,"releaseLock",function(this:unknown,...args:any[]){try{const result=Reflect.apply(release,this,args);r.unlocks++;return result;}catch(error){failures.push(error);throw error;}});return reader;
    });
  };
  const observingFetch=(fetcher:Function,receiver:unknown)=>(input:RequestInfo|URL,init?:DispatcherAwareRequestInit):Promise<Response>=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    expect(url.origin).toBe(origin);expect(url.search).toBe("");
    expect(["/v1/native/bifrost/v1/models","/v1/native/bifrost/v1/chat/completions"]).toContain(url.pathname);
    const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
    expect(headers.get("authorization")).toBe("Bearer "+(url.pathname.endsWith("/models")?discoveryKey(row):key(row.id)));
    expect(headers.has("x-api-key")).toBe(false);
    let notifyClose!:()=>void;
    const t:Transport={path:url.pathname,signal:init?.signal??undefined,dispatcher:init?.dispatcher,closeStarted:new Promise(resolve=>{notifyClose=resolve;}),notifyClose:()=>notifyClose(),closes:[],bodies:[],readers:[],guardObserved:false,releases:0};transports.push(t);
    if(t.dispatcher){
      expect(t.dispatcher).toBeInstanceOf(undici.Agent);
      const original=t.dispatcher.close;let depth=0;
      patch(t.dispatcher,"close",function(this:unknown,...args:unknown[]){const outer=depth++===0;try{const result=Reflect.apply(original,this,args);if(outer){t.closes.push(result);if(result&&typeof result.then==='function')observe("dispatcher_close",result);}return result;}catch(error){failures.push(error);throw error;}finally{depth--;if(outer)t.notifyClose();}});
    }
    const pending=Reflect.apply(fetcher,receiver,[input,init]) as Promise<Response>;observe("fetch",pending);
    retainObserver(pending.then(response=>observeBody(response,t),()=>{}));return pending;
  };
  try {
    expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(pin);expect(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(pin);
    for(const name of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","BIFROST_API_KEY","BIFROST_VIRTUAL_KEY","LITELLM_API_KEY"])vi.stubEnv(name,"synthetic-poison-other-provider");
    patch(globalThis,"fetch",observingFetch(nativeFetch,globalThis));
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__",{...undici,fetch:observingFetch(nativeUndiciFetch,undici)});
    const seenGuards=new WeakSet<object>();
    vi.spyOn(guard,"fetchWithSsrFGuard").mockImplementation(function(this:unknown,...args:Parameters<typeof nativeGuard>){
      const pending=Reflect.apply(nativeGuard,this,args);retainObserver(pending.then(result=>{
        if(seenGuards.has(result))return;seenGuards.add(result);
        const path=new URL(String(args[0].url)).pathname,matches=transports.filter(t=>t.path===path&&!t.guardObserved);
        if(matches.length!==1)throw Error("ambiguous original guarded transport");const t=matches[0];t.guardObserved=true;
        observeBody(result.response,t);const release=result.release;
        patch(result,"release",function(this:unknown,...args:unknown[]){t.releases++;return invoke("guard_release",()=>Reflect.apply(release,this,args));});
      },()=>{}));return pending;
    } as typeof nativeGuard);
    const store:AuthProfileStore={version:1,profiles:{"bifrost:selected":{type:"api_key",provider:"bifrost",key:row.mode==='profile'?key(row.id):"synthetic-poison-unselected-profile"},"openai:poison":{type:"api_key",provider:"openai",key:"synthetic-unrelated-profile"}}};
    await state.writeAuthProfiles(store);
    const config:OpenClawConfig={models:{providers:{bifrost:{baseUrl:origin+"/v1/native/bifrost/v1",api:"openai-completions",apiKey:row.mode==='profile'?"bifrost:selected":key(row.id),models:[]}}}};
    // This frozen discovery resolver prefers the environment key. Inference
    // retains the independently configured credential. The profile arm has
    // no discovery environment key and resolves its explicit profile reference.
    const env=row.mode==='profile'?{}:{BIFROST_VIRTUAL_KEY:discoveryKey(row)};
    vi.stubEnv('BIFROST_VIRTUAL_KEY',row.mode==='profile'?undefined:discoveryKey(row));
    const resolveProviderApiKey=createProviderApiKeyResolver(env,store,config),resolveProviderAuth=createProviderAuthResolver(env,store,config);
    expect(resolveProviderApiKey('bifrost').discoveryApiKey).toBe(discoveryKey(row));
    expect(resolveProviderAuth('bifrost').apiKey).toBe(key(row.id));
    const {default:entry}=await loadBundledPluginFacade<{default:Parameters<typeof registerSingleProviderPlugin>[0]}>({pluginId:"bifrost",artifactBasename:"index.js"});
    const plugin=await registerSingleProviderPlugin(entry);expect(plugin.id).toBe("bifrost");expect(plugin.catalog?.run).toBeTypeOf("function");
    const discover=()=>observe("catalog_result",plugin.catalog!.run({config,env,agentDir:state.agentDir(),workspaceDir:state.workspaceDir,signal:control.signal,
      resolveProviderApiKey,resolveProviderAuth}));
    await body(discover,control,observe,resolveProviderAuth("bifrost").apiKey!);
  } catch(error){failures.push(error);}
  // Strict baseline: every rejection remains a failure, including undefined.
  // No native cancellation disposition has been qualified for this SDK pin.
  const check=async(run:()=>unknown)=>{try{await run();}catch(error){failures.push(error);}};
  let at=0;while(at<originals.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.map(r=>r.pending));}
  for(const t of transports)if(t.dispatcher)await check(async()=>{
    await t.closeStarted;
    for(const pending of t.closes)if(pending&&typeof (pending as Promise<unknown>).then==='function')await pending;
    expect(t.closes).toHaveLength(1);expect(t.dispatcher!.destroyed).toBe(true);
  });
  // Closing can register additional original operations. Inspect all of them.
  while(at<originals.length){const batch=originals.slice(at);at=originals.length;await Promise.allSettled(batch.map(r=>r.pending));}
  let observed=0;while(observed<observers.length){const batch=observers.slice(observed);observed=observers.length;await Promise.all(batch);}
  for(const r of originals)if(r.state==='rejected')failures.push(r.reason);else await check(()=>expect(r.state).toBe('fulfilled'));
  for(const t of transports){for(const r of t.readers)await check(()=>expect(r.unlocks).toBe(1));for(const b of t.bodies)await check(()=>expect(b.locked).toBe(false));if(t.guardObserved)await check(()=>expect(t.releases).toBe(1));}
  try {await command(row.id,'join');}catch(error){failures.push(error);}
  for(const restore of restores.toReversed())try{restore();}catch(error){failures.push(error);}
  for(const cleanup of [()=>vi.restoreAllMocks(),()=>vi.unstubAllGlobals(),()=>vi.unstubAllEnvs(),()=>state.cleanup(),()=>state.restoreEnv()])try{await cleanup();}catch(error){failures.push(error);}
  throwFailures(failures);
}

function inference(provider:any,row:Case,signal:AbortSignal,inferenceKey:string) {
  expect(provider.baseUrl).toBe(origin+"/v1/native/bifrost/v1");expect(provider.apiKey).toBe(row.mode==='profile'?"bifrost:selected":key(row.id));expect(inferenceKey).toBe(key(row.id));
  expect(provider.models.length).toBe(1);
  const actual=provider.models[0];expect(actual.id).toBe(row.mode==='account_b'?"tenant/opaque-b":"tenant/opaque-a");
  const model={...actual,provider:"bifrost",api:provider.api,baseUrl:provider.baseUrl} as Model<"openai-completions">;
  const context:Context={messages:[{role:"user",content:"synthetic Bifrost request",timestamp:1}]};
  return (row.api==='stream'?stream:streamSimple)(model,context,{apiKey:inferenceKey,signal,maxTokens:16});
}

describe("registered Bifrost private discovery and public inference",()=>{
  // The four original controls precede any future cancellation disposition.
  for(const row of cases)it(row.id,async()=>{
    await fixture(row,async(discover,controller,track,inferenceKey)=>{
      const catalog=await discover();
      if(['malformed','loose','error401','error403','redirect','missing_owner','invalid_owner'].includes(row.mode)){
        expect(catalog.provider).toBeUndefined();expect(catalog.outcomes).toContainEqual(expect.objectContaining({provider:'bifrost',status:['error401','error403'].includes(row.mode)?'auth-rejected':'unavailable'}));return;
      }
      expect(catalog.provider).toBeDefined();
      if(row.mode==='empty'){expect(catalog.provider.models).toEqual([]);return;}
      if(row.mode==='revoked'){
        await command(row.id,'mutate',{kind:'caller_revoke'});const denied=await discover();expect(denied.provider).toBeUndefined();expect(denied.outcomes).toContainEqual(expect.objectContaining({status:'auth-rejected'}));return;
      }
      if(row.mode==='rotation')await command(row.id,'mutate',{kind:'rotation'});
      if(row.mode==='preabort')controller.abort(new Error('synthetic original preabort'));
      const resultStream=inference(catalog.provider,row,controller.signal,inferenceKey),resultPromise=track("inference_result",resultStream.result());
      if(row.mode==='partial'){
        let delivered=false;for await(const event of resultStream)if(event.type==='text_delta'){delivered=true;controller.abort(new Error('synthetic original partial abort'));break;}
        expect(delivered).toBe(true);
      }
      const result=await resultPromise;
      if(['preabort','partial'].includes(row.mode)){expect(controller.signal.aborted).toBe(true);expect(result.stopReason).toBe('aborted');}
      else if(['provider_error','unpriced'].includes(row.mode)){expect(controller.signal.aborted).toBe(false);expect(result.stopReason).toBe('error');}
      else{expect(controller.signal.aborted).toBe(false);expect(result.stopReason).toBe('stop');expect(result.content).toContainEqual({type:'text',text:'synthetic-prefix'});expect(result.usage).toMatchObject({input:4,output:3,totalTokens:7});}
    });
  },120000);
});
