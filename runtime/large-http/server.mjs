// Exclusive transport adapter. Canonical router owns auth, routing, retention,
// budgets, provider transforms and usage. No payloads/keys/raw errors are logged.
import {createServer} from 'node:http';
import {mkdtemp,open,rm,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';
import {responsePump} from './response-pump.mjs';
import {spoolUpload} from './spool.mjs';
import {routerHeaders,largeCreatePath} from '../../worker/large-http/headers.ts';
import {bodyBudgetCharged} from '../../worker/body-budget.ts';
import {HttpError} from '../../worker/utils.ts';
import {bindSingleDispatchTransport} from '../../worker/upstream-transport.ts';
import {runtimeFields} from '../../worker/large-http/provider-config.ts';
export async function startRuntime({route,providerOrigin='https://api.openai.com',providerOrigins=[providerOrigin],providerFetch,observe=()=>{},healthExtra=()=>({})}){
 const cap=64*1024*1024,token=process.env.LARGE_HTTP_RUNTIME_TOKEN,origin=process.env.LARGE_HTTP_ORIGIN;
 const slot=Number(process.env.LARGE_HTTP_SLOT),generation=Number(process.env.LARGE_HTTP_GENERATION),build=process.env.LARGE_HTTP_RUNTIME_SHA;
 if(!/^[a-f0-9]{64}$/.test(token??'')||!Number.isSafeInteger(slot)||slot<0||slot>=8||!Number.isSafeInteger(generation)||generation<1||!/^[a-f0-9]{64}$/.test(build??''))throw Error('runtime_identity_required');
 const nativeFetch=globalThis.fetch,NativeRequest=globalThis.Request,lengths=new WeakMap(),scope=new AsyncLocalStorage();
 const controlHeaders={'x-large-http-slot':String(slot),'x-large-http-generation':String(generation),'x-large-http-token':token};
 async function call(op,value,{body,headers={},signal,preserveStatus=false}={}){
  const r=await nativeFetch(origin+'/__large_http/'+op,{method:'POST',headers:{...controlHeaders,...headers,...(body?{}:{'content-type':'application/json'})},body:body??JSON.stringify(value),duplex:'half',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])});
  if(!r.ok&&!preserveStatus){await r.body?.cancel();throw Error('binding_failed');}return r;
 }
 const settingsResponse=await nativeFetch(origin+'/__large_http/settings',{headers:controlHeaders,redirect:'error',signal:AbortSignal.timeout(3000)});
 if(!settingsResponse.ok)throw Error('runtime_settings_failed');const settings=await settingsResponse.json();
 if(!settings||Object.keys(settings).some(k=>!runtimeFields.includes(k)||typeof settings[k]!=='string'))throw Error('runtime_settings_invalid');
 const allowedOrigins=typeof providerOrigins==='function'?providerOrigins(settings):providerOrigins;
 globalThis.FixedLengthStream=class extends TransformStream{
  constructor(expected){let size=0;super({transform(chunk,c){size+=chunk.byteLength;if(size>expected)throw Error('fixed_length_excess');c.enqueue(chunk);},flush(){if(size!==expected)throw Error('fixed_length_short');}});lengths.set(this.readable,expected);}
 };
 globalThis.Request=class extends NativeRequest{
  constructor(input,init={}){const next={...init};if(next.body instanceof ReadableStream){next.duplex='half';const size=lengths.get(next.body);if(size!==undefined){next.headers=new Headers(next.headers);next.headers.set('content-length',String(size));}}super(input,next);}
 };
 globalThis.fetch=async(input,init={})=>{
  const d=scope.getStore(),url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!d||d.attempted)throw Error('provider_replay_or_origin');
  if(!allowedOrigins.includes(url.origin))throw new HttpError(503,'upstream_not_dispatched','upstream request was not dispatched');
  const caller=init.signal??(input instanceof NativeRequest?input.signal:undefined),signal=AbortSignal.any([d.abort.signal,...(caller?[caller]:[])]);
  try{signal.throwIfAborted();await(await call('dispatch',d.grant,{signal})).body?.cancel();signal.throwIfAborted();}
  catch{throw new HttpError(503,'upstream_not_dispatched','upstream request was not dispatched');}
  // Once any provider fetch is issued, no transparent retry is permitted.
  d.attempted=true;d.profile.mark('dispatch');
  const next={...init,signal};if(next.body instanceof ReadableStream){next.duplex='half';const size=lengths.get(next.body);if(size!==undefined){next.headers=new Headers(next.headers);next.headers.set('content-length',String(size));}}
  let r;try{r=await(providerFetch??nativeFetch)(input,next);d.profile.mark('provider_headers');}catch(error){d.unknown=true;throw error;}
  const reader=r.body?.getReader();
  const body=reader?new ReadableStream({async pull(c){try{const n=await reader.read();if(n.done){d.eof=true;d.profile.mark('provider_eof');c.close();reader.releaseLock();}else c.enqueue(n.value);}catch(error){d.unknown=true;c.error(error);}},cancel(reason){d.unknown=true;return reader.cancel(reason);}}):null;
  if(!body){d.eof=true;d.profile.mark('provider_eof');}
  // Node fetch decodes compression; ServerResponse must not forward stale wire
  // encoding or compressed length for the decoded body.
  const headers=new Headers(r.headers);headers.delete('content-encoding');headers.delete('content-length');return new Response(body,{status:r.status,statusText:r.statusText,headers});
 };
 function namespace(binding){return {idFromName:name=>name,get:name=>({fetch:async(input,init)=>{const r=new NativeRequest(input,init),body=r.body?await r.text():null;if(body&&Buffer.byteLength(body)>1024*1024)throw Error('binding_metadata_limit');return call('do',{binding,name,url:r.url,method:r.method,headers:[...r.headers],body},{signal:r.signal,preserveStatus:true});}})};}
 const env={...settings,...Object.fromEntries(['ACCESS_CONTROL','BUDGET_LEDGER','USAGE_LEDGER','GRANT_CREDENTIALS','CONTENT_CLEANUP'].map(name=>[name,namespace(name)])),
  POLICY_KV:{get:async(key,type='text')=>{const r=await call('kv',{key,type});if(type==='stream'){if(r.headers.get('x-large-http-kv-present')==='1')return r.body;await r.body?.cancel();return null;}const v=await r.json();return Array.isArray(key)?new Map(v.entries):v.value;},list:async()=>{throw Error('authority_uninitialized');}},
  USAGE_QUEUE:{send:async(body)=>{await(await call('queue',{body})).body?.cancel();}},
  CONTENT_ARCHIVE:{put:async(key,body,options)=>{const size=typeof body==='string'?Buffer.byteLength(body):lengths.get(body);if(!Number.isSafeInteger(size)||size>cap+1024*1024)throw Error('archive_size_limit');await(await call('archive',null,{body,headers:{'x-archive-key':key,'x-archive-options':JSON.stringify(options),'content-length':String(size)}})).body?.cancel();}},
  ASSETS:{fetch:async()=>new Response(null,{status:404})}};
 bindSingleDispatchTransport(env,()=>scope.getStore()?.attempted);
 // A VM may retain owned spools after an abrupt process exit.
 for(const entry of await readdir(tmpdir(),{withFileTypes:true}))if(entry.isDirectory()&&/^clawrouter-large-[A-Za-z0-9]{6}$/.test(entry.name))await rm(join(tmpdir(),entry.name),{recursive:true,force:true});
 const directory=await mkdtemp(join(tmpdir(),'clawrouter-large-')),boot=crypto.randomUUID();
 const diagnostics=[],testing=settings.LARGE_HTTP_TESTING==='1';
 let busy=false,draining=false,stopping,spoolBytes=0,backgroundFailures=0;
 const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{
  if(req.headers['x-container-token']!==token){json(res,401,{});return;}
  const target=new URL(req.url,'http://runtime'),path=target.pathname;
  if(path==='/startup-health'&&req.method==='GET'){json(res,200,{ready:true,slot,generation,build,boot});return;}
  if(path==='/health'&&req.method==='GET'){json(res,200,{slot,generation,build,boot,busy,draining,spoolBytes,spoolFiles:(await readdir(directory)).length,bodyBytesLeased:bodyBudgetCharged(),backgroundFailures,diagnostics:{...healthExtra(),...(testing?{ownership:diagnostics,cpu:process.cpuUsage(),rssBytes:process.memoryUsage().rss,maxRssBytes:process.resourceUsage().maxRSS*1024,uptimeMs:Math.round(process.uptime()*1000)}:{})}});return;}
  if(draining||busy){req.resume();json(res,503,{error:{code:'large_slot_unavailable'}},{'x-should-retry':'true','retry-after':'1'});return;}
  if(req.method!=='POST'||!largeCreatePath(path)){json(res,404,{});return;}
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'){json(res,415,{});return;}
  if(Number(req.headers['content-length'])>cap){json(res,413,{});return;}
  let grant;try{grant=JSON.parse(req.headers['x-large-http-grant']??'null');}catch{}
  if(!grant||grant.slot!==slot||grant.generation!==generation||grant.boot!==boot||!Number.isSafeInteger(grant.fence)||grant.fence<1||!/^prf_[a-f0-9]{32}$/.test(grant.id??'')){json(res,409,{}, {'x-should-retry':'false'});return;}
  busy=true;const arrival=performance.now(),events={arrival:0},cpu=testing?process.cpuUsage():null;const abort=new AbortController(),delivery={grant,abort,attempted:false,eof:false,unknown:false,outputBytes:0,outputFinished:false,profile:{mark(name){if(testing)events[name]??=performance.now()-arrival;}}};
  let inputBytes=0,routed=false,timer=setTimeout(()=>{abort.abort();req.destroy();},120000),file,outputPump,failed=false,spoolClosed=true;
  const cancel=()=>{if(!res.writableFinished){if(outputPump)outputPump.close();else abort.abort();}};req.once('aborted',cancel);res.once('close',cancel);
  const pending=[];const fail=()=>{failed=true;backgroundFailures++;};
  const waitUntil=p=>pending.push(Promise.resolve(p).then(v=>{if(v===false)fail();},fail));
  try{
   file=join(directory,crypto.randomUUID());const handle=await open(file,'wx',0o600);spoolClosed=false;
   try{await spoolUpload(req,handle,abort.signal,cap,bytes=>{spoolBytes=bytes;inputBytes=bytes;});}finally{await handle.close();spoolClosed=true;}
   delivery.profile.mark('upload_eof');clearTimeout(timer);abort.signal.throwIfAborted();timer=setTimeout(()=>abort.abort(),300000);
   const incoming=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)incoming.append(req.rawHeaders[i],req.rawHeaders[i+1]);
   const headers=routerHeaders(incoming);headers.set('content-length',String(spoolBytes));
   const request=new Request('https://large-http.invalid'+path+target.search,{method:'POST',headers,body:Readable.toWeb(createReadStream(file)),duplex:'half',signal:abort.signal});
   routed=true;delivery.profile.mark('route_start');let result=await scope.run(delivery,()=>route(request,env,{waitUntil,passThroughOnException(){}}));delivery.profile.mark('route_end');
   if(result.status>=500&&delivery.unknown){await result.body?.cancel();const headers=new Headers(result.headers);for(const key of ['content-length','content-encoding','retry-after'])headers.delete(key);headers.set('content-type','application/json');headers.set('x-should-retry','false');result=new Response(JSON.stringify({error:{code:'upstream_delivery_unknown'}}),{status:424,headers});}
   res.writeHead(result.status,Object.fromEntries(result.headers));outputPump=responsePump({response:result,path,res,abort,delivery});await outputPump.run();
  }catch(error){
   failed=true;delivery.unknown||=delivery.attempted&&!delivery.eof;
   if(!res.headersSent&&!res.destroyed){if(error.status===413)req.resume();json(res,error.status??(abort.signal.aborted?499:routed?424:500),{error:{code:error.status===413?'request_too_large':abort.signal.aborted?'request_canceled':routed?'upstream_delivery_unknown':'large_runtime_failed'}},{'x-should-retry':'false',...(error.status===413?{connection:'close'}:{})});}else res.destroy();
  }finally{
   clearTimeout(timer);abort.abort();
   const settled=(async()=>{let index=0;while(index<pending.length){const batch=pending.slice(index);index=pending.length;await Promise.allSettled(batch);}})();
   if(await Promise.race([settled,new Promise(r=>{timer=setTimeout(()=>r('timeout'),30000);})])==='timeout'){draining=true;server.close();setTimeout(()=>process.exit(1),50).unref();return;}
   clearTimeout(timer);
   try{if(file)await rm(file,{force:true});spoolBytes=0;}catch{failed=true;draining=true;}
   // Before route() there is no canonical reservation or provider attempt.
   // Definitive upload failure can release ownership after descriptor/spool
   // cleanup. Once routing begins, failed or uncertain work stays quarantined.
   const clean=Boolean((!routed||(delivery.outputFinished||delivery.completionDrain?.drained)&&!failed)&&!draining&&spoolClosed&&!delivery.unknown&&spoolBytes===0&&bodyBudgetCharged()===0&&(!delivery.attempted||delivery.eof));
   delivery.profile.mark('cleanup');
   try{await(await call('finish',{...grant,clean})).body?.cancel();delivery.profile.mark('release_ack');}catch{draining=true;backgroundFailures++;}
   if(testing){diagnostics.push({id:grant.id,slot,generation,bytesBucket:inputBytes===0?'empty':inputBytes<=256*1024?'le256k':inputBytes<=8*1024**2?'le8m':inputBytes<=32_000_000?'le32mb':'le64m',events,clean,attempted:delivery.attempted,eof:delivery.eof,cpu:process.cpuUsage(cpu),rssBytes:process.memoryUsage().rss});if(diagnostics.length>64)diagnostics.shift();}
   busy=false;observe({slot,generation,id:grant.id,attempted:delivery.attempted,eof:delivery.eof,unknown:delivery.unknown,clean,spoolBytes,bodyBytesLeased:bodyBudgetCharged()});
  }
 });
 server.requestTimeout=125000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 await new Promise(r=>server.listen(Number(process.env.PORT??8080),'0.0.0.0',r));
 function stop(){if(stopping)return stopping;draining=true;stopping=(async()=>{const force=setTimeout(()=>process.exit(1),480000);const closed=new Promise(r=>server.close(r));while(busy)await new Promise(r=>setTimeout(r,25));await closed;const clean=backgroundFailures===0&&spoolBytes===0&&(await readdir(directory)).length===0&&bodyBudgetCharged()===0;await rm(directory,{recursive:true,force:true});clearTimeout(force);process.exit(clean?0:1);})();return stopping;}
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 return {server,boot};
}
