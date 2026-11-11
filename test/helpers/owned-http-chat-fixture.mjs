import { createHash } from 'node:crypto';
import { ownedJsonCodecWire, ownedCodecSseLines, ownedUsageWire } from './owned-json-parser-cases.mjs';

export const ownedHttpModel = 'volcengine/doubao-seed-2-1-pro-260915';
export const ownedHttpPricingModel = 'fireworks/glm-5.2';
export const ownedHttpControlModels = { gmi: 'gmi/deepseek-ai/DeepSeek-V4-Pro', venice: 'venice/zai-org-glm-5-2' };
export const ownedHttpCases = ['soft_venice', 'soft', 'chat', 'tool', 'error', 'abort', 'large', 'off', 'gmi', 'venice', 'pricing', 'pricing_media', 'pricing_cache', 'pricing_wide', 'pricing_large', 'pricing_unicode', 'pricing_outside', 'pricing_prepare_fail'];
export const ownedHttpProxyKey = id => `clawrouter-live-owned_http_${id}-fixture-secret`;
export function createOwnedTerminalFixture(options, commands) {
  const row = { factories: [], shellAttempts: 0, shells: 0, primary: 0, fallback: 0, adopted: 0, failed: 0,
    closes: 0, installs: 0, launches: 0, logical: [], lateGets: 0, methodsA: 0, methodsB: 0,
    rejected: 0, foreignReads: 0, retainedFailure: false, pending: 0, diagnostics: [], order: [] };
  let factory, terminalEntry = false;
  const wrapOriginal = promise => {
    row.pending++;
    return promise.then(value => { row.pending--; return value; }, error => { row.pending--; throw error; });
  };
  const reject = run => {
    let failed = false;
    try { run(); } catch { failed = true; }
    if (!failed) throw Error('terminal replay/mixed tuple was accepted');
    row.rejected++;
  };
  return {
    row,
    env(env) {
      const bindings = {};
      for (const name of ['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE']) {
        const binding = env[name];
        bindings[name] = new Proxy(binding, { get(target, key) {
          if (key === 'idFromName') return function (...args) { row.methodsA++; return Reflect.apply(target.idFromName, target, args); };
          if (key === 'get') return function (...args) {
            row.methodsA++; const stub = Reflect.apply(target.get, target, args);
            return { fetch(...values) { row.methodsA++; return wrapOriginal(Reflect.apply(stub.fetch, stub, values)); } };
          };
          if (key === 'send') return function (...args) { row.methodsA++; return wrapOriginal(Reflect.apply(target.send, target, args)); };
          return Reflect.get(target, key, target);
        } });
      }
      const other = { idFromName() { row.methodsB++; throw Error('late binding B used'); },
        get() { row.methodsB++; throw Error('late binding B used'); }, send() { row.methodsB++; throw Error('late binding B used'); } };
      return new Proxy(env, { get(target, name, receiver) {
        if (!Object.hasOwn(bindings, name)) return Reflect.get(target, name, receiver);
        if (terminalEntry && options.late) { row.lateGets++; if (options.late === 'throw') throw undefined; return other; }
        if (factory) { factory.push(name); if (options.factoryThrow === name) throw undefined; }
        return bindings[name];
      } });
    },
    factoryBegin() { factory = []; row.factories.push(factory); },
    factoryEnd() { factory = undefined; },
    shell() { row.shellAttempts++; if (options.shellFailure) throw undefined; },
    prepared() { row.shells++; },
    receipt(fallback) {
      if (fallback) row.fallback++; else row.primary++;
      if (options.receipt === 'both' || !fallback && options.receipt === 'first') throw undefined;
    },
    validate(http, accounting, sinks, reservation, event, custody) {
      if (!options.wrong) return;
      const foreign = Object.defineProperties({}, { charges: { get() { row.foreignReads++; throw Error('foreign reservation inspected'); } },
        ownedHttp: { get() { row.foreignReads++; throw Error('foreign carrier inspected'); } } });
      reject(() => commands.startOwnedHttpAccountingTerminal(http, accounting, foreign, reservation, event, custody));
      reject(() => commands.startOwnedHttpAccountingTerminal(http, accounting, sinks, foreign, event, custody));
      reject(() => commands.startOwnedHttpAccountingTerminal(http, accounting, sinks, reservation, {}, custody));
      reject(() => commands.startOwnedHttpAccountingTerminal(http, accounting, sinks, reservation, event, {}));
      reject(() => commands.startOwnedHttpAccountingTerminal({}, accounting, sinks, reservation, event, custody));
    },
    enter() { terminalEntry = true; },
    adopted(http, accounting, sinks, reservation, event, custody) {
      row.adopted++; row.order.push('adopt');
      if (options.wrong) reject(() => commands.startOwnedHttpAccountingTerminal(http, accounting, sinks, reservation, event, custody));
    },
    failed() { row.failed++; row.order.push('failed'); },
    close() { row.closes++; row.order.push('close'); if (options.closeFailure) throw undefined; },
    installed() { row.installs++; row.order.push('install'); if (options.installFailure) throw undefined; },
    launching() { row.launches++; row.order.push('launch'); },
    started() { if (options.startFailure) throw undefined; },
    logical(value) { row.logical.push(value); },
    diagnostic(origin, absent) { row.diagnostics.push({ origin, undefined: absent }); if (options.diagnosticFailure) throw undefined; },
    clear(outcome, failed) { if (failed) row.retainedFailure = !!outcome; },
    release() { factory = undefined; },
  };
}
// Shared authored Node/Workerd witness. All deferred serialization and cleanup
// stay inside the actual returned operations; release is registered pre-dispatch.
export function createOwnedBudgetSequenceFixture(options, ExactBodyCharge, limit, charged, HttpError, commands) {
  let pressure, releaseFailure, releaseSend, releaseCancel;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const sendGate = new Promise(resolve => { releaseSend = resolve; });
  const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
  const shared = {}, originalReplace = ExactBodyCharge.prototype.replace;
  let watching = false;
  const row = { accepted: 0, reserve: [], dispatch: [], settle: [], queue: [], branches: [],
    pressure: false, refused: false, cancel: 0, cancelSettled: 0, sendSettled: 0,
    grows: 0, prepayBytes: 0, prepayCalls: 0, factories: 0, rejectedRights: 0 };
  let plan, caps;
  function rejects(run) {
    let rejected = false;
    try { run(); } catch (error) { if (error?.code !== 'identity_admission_unavailable') throw error; rejected = true; }
    if (!rejected) throw Error('invalid budget right was accepted');
    row.rejectedRights++;
  }
  const fail = kind => {
    if (kind === 'undefined') throw undefined;
    if (kind === 'forged') throw new HttpError(402, 'budget_exhausted', 'fixture transport lookalike');
    throw shared;
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  function exhaust() {
    if (pressure) return;
    pressure = ExactBodyCharge.reserve(limit - charged());
    if (!pressure) throw Error('budget fixture pressure setup');
    row.pressure = true;
  }
  function stopWatching() { if (watching) ExactBodyCharge.prototype.replace = originalReplace; watching = false; }
  function freePressure() { pressure?.release(); pressure = undefined; }
  if (options.legs === 1 && options.reserveFailure) releaseFailure();
  return {
    row,
    beforePlan(value) {
      if (!value?.legs) return;
      if (options.sameIds) for (const leg of value.legs) {
        leg.objectName = value.legs[0].objectName; leg.request.reservationId = value.legs[0].request.reservationId;
      }
      if (options.rights) plan = value;
    },
    prepay(bytes) { row.prepayCalls++; row.prepayBytes = bytes; if (options.prepayRefusal) exhaust(); },
    prepared(sequence) { row.factories++; if (options.rights) caps = sequence.legs.map(leg => leg.cap); },
    refused() { row.refused = true; freePressure(); plan = undefined; caps = undefined; },
    accepted() {
      row.accepted++;
      if (options.pressure && row.accepted === 1) {
        exhaust(); watching = true;
        ExactBodyCharge.prototype.replace = function (bytes) {
          if (bytes > this.bytes) row.grows++;
          return Reflect.apply(originalReplace, this, [bytes]);
        };
      }
      if (row.accepted === options.legs - (options.reserveFailure ? 1 : 0)) releaseFailure();
    },
    reserveClaimed(sink, intent, ordinal, cap) {
      if (!options.rights) return;
      rejects(() => commands.claimOwnedHttpBudgetReserve(sink, intent, ordinal));
      rejects(() => commands.claimOwnedHttpBudgetReserve(sink, intent, (ordinal + 1) % options.legs));
      rejects(() => commands.ownedHttpReserveAcknowledgment(sink, {}, intent.objectName, intent.request, undefined, {}));
      rejects(() => commands.ownedHttpReserveAcknowledgment({}, {}, intent.objectName, intent.request, undefined, cap));
    },
    branch(rollback, sink) {
      row.branches.push(rollback ? 'rollback' : 'dispatch');
      if (!options.rights) return;
      rejects(() => commands.claimOwnedHttpBudgetReserve(sink, plan.legs[0], 0));
      rejects(() => commands.ownedHttpSettleAcknowledgment(sink, {}, plan.legs[0].objectName, {}, undefined, caps[0]));
    },
    queueClaimed(sink, cap) { if (options.rights) rejects(() => commands.claimOwnedHttpBudgetQueue(sink, cap)); },
    finished(sink) {
      if (options.forwardPressure) { stopWatching(); freePressure(); }
      if (!options.rights) return;
      rejects(() => commands.claimOwnedHttpBudgetReserve(sink, plan.legs[0], 0));
      for (const cap of caps) rejects(() => commands.ownedHttpReserveAcknowledgment(sink, {}, '', {}, undefined, cap));
      plan = undefined; caps = undefined;
    },
    async fetch(stub, url, init) {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path === '/reserve') {
        const ordinal = row.reserve.length;
        row.reserve.push({ id: body.reservationId, ordinal, dispatched: body.dispatched === true });
        if (ordinal === (options.failureOrdinal ?? options.legs - 1) && options.reserveFailure) {
          await failureGate;
          if (options.reserveFailure === 'denied') return json({ allowed: false });
          if (options.reserveFailure === 'malformed') return json({ ignored: true });
          if (options.reserveFailure === 'lost') {
            const response = await Reflect.apply(stub.fetch, stub, [url, init]); await response.body?.cancel();
          }
          fail(options.reserveFailure);
        }
      } else if (path === '/dispatch') {
        row.dispatch.push({ id: body.reservationId });
        if (options.dispatchFailure) return json({}, 503);
      } else if (path === '/settle') {
        row.settle.push({ id: body.reservationId, cost: body.actualCostMicros });
        if (options.settleFailure) {
          if (options.settleFailure === 'undefined' || options.settleFailure === 'shared') fail(options.settleFailure);
          const status = Number(options.settleFailure);
          if (options.holdCancel) return new Response(new ReadableStream({
            cancel() { row.cancel++; return cancelGate.then(() => { row.cancelSettled++; }); },
          }, { highWaterMark: 0 }), { status });
          return json({}, status);
        }
      }
      return Reflect.apply(stub.fetch, stub, [url, init]);
    },
    send(queue, args) {
      const value = args[0];
      if (value.kind !== 'budget_settlement') return Reflect.apply(queue.send, queue, args);
      const copy = { id: value.request.reservationId, cost: value.request.actualCostMicros, args: args.length,
        root: Object.isFrozen(value), request: Object.isFrozen(value.request), ledger: Object.isFrozen(value.ledger),
        before: JSON.stringify(value), after: null, hookBlocked: false };
      row.queue.push(copy);
      return (options.holdSend ? sendGate : Promise.resolve()).then(async () => {
        copy.hookBlocked = !Reflect.defineProperty(value.request, 'toJSON', { value() { throw Error('queue hook ran'); } });
        copy.after = JSON.stringify(value);
        if (options.queueFailure) fail(options.queueFailure);
        await Reflect.apply(queue.send, queue, args); row.sendSettled++;
      });
    },
    release() { stopWatching(); freePressure(); releaseFailure(); releaseSend(); releaseCancel(); },
    releaseSend() { stopWatching(); freePressure(); releaseSend(); },
    releaseCancel() { releaseCancel(); },
  };
}
export async function seedOwnedHttpChat(runtime) {
  const kv = await runtime.getKVNamespace('POLICY_KV', 'router');
  for (const id of ownedHttpCases) {
    const priced = id.startsWith('pricing');
    const provider = id === 'soft_venice' ? 'venice' : priced ? 'fireworks' : Object.hasOwn(ownedHttpControlModels, id) ? id : 'volcengine';
    const model = id === 'soft_venice' ? ownedHttpControlModels.venice : priced ? ownedHttpPricingModel : ownedHttpControlModels[id] ?? ownedHttpModel;
    await kv.put(`policies/owned_http_${id}`, JSON.stringify({ enabled: true, generation: 'fixture', tenantId: 'fixture',
      providers: [provider], models: [model], monthlyBudgetMicros: priced ? 1000000000000 : 1000000, requestCostMicros: priced ? null : 7,
      budgetMode: id.startsWith('soft') ? 'soft' : 'reserve', ...(id.startsWith('soft') ? { dailyBudgetMicros: 1000000, weeklyBudgetMicros: 1000000 } : {}), retainRequestContent: false,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { [provider]: [provider] } } }));
    await kv.put(`credentials/owned_http_${id}`, JSON.stringify({ enabled: true,
      secretSha256: createHash('sha256').update('fixture-secret').digest('hex'), policyId: `owned_http_${id}`, policyGeneration: 'fixture' }));
  }
  for (const provider of ['volcengine', 'gmi', 'venice', 'fireworks'])
    await kv.put(`connections/${provider}`, JSON.stringify({ providerId: provider, enabled: true }));
}

export const ownedHttpRouter = String.raw`
import handler,{privateOwnedHttpChat} from './worker/index.ts';export * from './worker/index.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {bodyBudgetCharged,bodyBudgetBytes,ExactBodyCharge} from './worker/body-budget.ts';
import {snapshot} from './worker/providers.ts';
import {PolicyBindingIndexObject as NativeAuthority} from './worker/authority.ts';
import {HttpError} from './worker/utils.ts';
import {evictCredentialGeneration} from './worker/credential-preflight.ts';
import * as budgetCommands from './worker/http-identity-owner.ts';
const createOwnedBudgetSequenceFixture = ${createOwnedBudgetSequenceFixture.toString()};
const createOwnedTerminalFixture = ${createOwnedTerminalFixture.toString()};
import {createSseUsageInspector,extractUsageTokens,responseOutcome} from './worker/token-usage.ts';
export class PolicyBindingIndexObject extends NativeAuthority {
 constructor(ctx,env){super(ctx,env);this.fixtureSql=ctx.storage.sql;}
 async fetch(request){
  if(new URL(request.url).pathname!=='/fixture/revalidation-change')return super.fetch(request);
  const {provider,change}=await request.json();
  if(!['venice','gmi'].includes(provider)||!['disabled','rotated','policy-provider','policy-model'].includes(change))throw Error('fixture control shape');
  const id='owned_http_'+provider;
  if(change==='disabled'||change==='rotated'){
   const row=[...this.fixtureSql.exec('SELECT credential_json FROM proxy_credentials WHERE credential_id = ?',id)][0];
   if(!row)throw Error('fixture credential absent');const value=JSON.parse(row.credential_json);
   if(change==='disabled')value.enabled=false;else value.secretSha256='ab'.repeat(32);
   this.fixtureSql.exec('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?',JSON.stringify(value),id);
  }else{
   const row=[...this.fixtureSql.exec('SELECT policy_json FROM access_policies WHERE policy_id = ?',id)][0];
   if(!row)throw Error('fixture policy absent');const value=JSON.parse(row.policy_json);
   if(change==='policy-provider')value.providers=['other'];else value.models=['other/model'];
   this.fixtureSql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?',JSON.stringify(value),id);
  }
  return new Response(null,{status:204});
 }
}
const ids=['soft_venice','soft','chat','tool','error','abort','large','off','gmi','venice','pricing','pricing_media','pricing_cache','pricing_wide','pricing_large','pricing_unicode','pricing_outside','pricing_prepare_fail'],calls=[],intakes=[],completed=[],events=[];
let parserHold,intakeController;
// Post-native fixture gate. The originating fetch/queue continuation keeps its
// original value; foreign requests release/read scalars only, never native I/O.
function holdParserPhase(phase,original){
 const hold=parserHold;if(!hold||(hold.phase.endsWith('-then')?hold.phase.slice(0,-5):hold.phase)!==phase||--hold.remaining!==0)return original;
 const work=original.then(async value=>{
  hold.arrived=true;
  if(!hold.released)await new Promise(resolve=>{hold.release=resolve;});
  hold.release=undefined;return value;
 });
 if(hold.phase.endsWith('-then')){const then=work.then;Object.defineProperty(work,'then',{value(...args){Reflect.apply(then,this,args);return Promise.resolve();}});}
 return work;
}
const priced=snapshot.providers.find(p=>p.id==='fireworks').models.find(m=>m.id==='fireworks/glm-5.2');
// Fixture rates distinguish the ONE-hour early return from a maximum over both.
priced.pricing={...priced.pricing,cacheWrite1hInputMicrosPerMillion:2000000,cacheWrite5mInputMicrosPerMillion:9000000};
const originalValues=Object.values;let pricingActive=false,recursivePricingValues=0;
Object.values=function(value){if(pricingActive&&value&&Object.hasOwn(value,'ownedPricingNested'))recursivePricingValues++;return Reflect.apply(originalValues,this,arguments);};
const originalFetch=globalThis.fetch;
globalThis.fetch=function(input,init){
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(url!=='https://api.venice.ai/api/v1/chat/completions')return Reflect.apply(originalFetch,this,arguments);
 calls.push({kind:'provider',path:'/chat/completions',charged:bodyBudgetCharged()});
 return observeControlRead('provider','/chat/completions',Reflect.apply(originalFetch,this,arguments),init.signal);
};
let scoped,offScoped,pressure,controlFault,controlReadFault,controlReply,reasonReads=0;
let configurationFault,configurationGets=0,configurationReasonReads=0;
function clearConfigurationFault(){
 if(!configurationFault)return;
 const {provider,headers,keys,base}=configurationFault;
 provider.adapter.injectHeaders=headers;provider.config_keys=keys;provider.base_urls.default=base;configurationFault=undefined;
}
function configurationValue(){
 configurationGets++;const mode=configurationFault.mode;
 if(mode==='invalid-url')return '!';
 if(mode==='missing')return undefined;
 if(mode==='undefined')throw undefined;
 if(mode==='forged')throw new HttpError(402,'budget_exhausted','fixture forged business error');
 const reason={};for(const name of ['status','code','message','stack','cause'])Object.defineProperty(reason,name,{get(){configurationReasonReads++;throw Error('opaque configuration reason inspected');}});throw reason;
}

const controlReads=[],materializationReplies=[];
function observeControlRead(kind,path,original,signal){
 if(!controlReadFault||controlReadFault.kind!==kind||path!==(controlReadFault.path??(kind==='authority'?'/authorization/snapshot':kind==='provider'?'/chat/completions':'/inspect')))return original;
 const fault=controlReadFault;controlReadFault=undefined;
 const row={kind,read:0,readSettled:0,cancel:0,cancelSettled:0,unlock:0,released:false},shared={};
 for(const key of ['message','stack','cause','errors','code','status'])Object.defineProperty(shared,key,{get(){reasonReads++;throw Error('raw reason observed');}});
 const reason=fault.reason==='undefined'?undefined:fault.reason==='huge'?'x'.repeat(17*1024*1024):shared;
 if(fault.mode)Object.assign(row,{held:false,nativeUnlocked:0,unlockSettled:0,thenCalls:0,closedNative:0,closedSettled:0,closedGetter:0});
 let release;const gate=new Promise(resolve=>{release=resolve;});
 // This fixture gate is AFTER the original native cancellation. It is not
 // evidence that a remote producer or physical native storage has retired.
 row.release=()=>{row.released=true;release();release=undefined;row.release=undefined;};controlReads.push(row);
 if(fault.mode==='fetch-install-before'||fault.mode==='fetch-install-after'){
  const nativeThen=Promise.prototype.then;row.installFailed=false;row.lateCallbacks=0;row.foreignDisposed=0;
  const observeBody=response=>{
   const body=response.body,getReader=body?.getReader;
   if(body)body.getReader=function(...args){
    const reader=Reflect.apply(getReader,this,args),cancel=reader.cancel,unlock=reader.releaseLock;
    reader.cancel=function(...args){row.cancel++;const work=Reflect.apply(cancel,this,args);void Reflect.apply(nativeThen,work,[()=>{row.cancelSettled++;},()=>{row.cancelSettled++;}]);return work;};
    reader.releaseLock=function(...args){row.unlock++;return Reflect.apply(unlock,this,args);};return reader;
   };
   return response;
  };
  Object.defineProperty(original,'then',{value(yes,no){
   if(this!==original||arguments.length!==2)throw Error('fixture continuation observer boundary');row.thenCalls++;
   void Reflect.apply(nativeThen,this,[response=>{
    row.readSettled++;row.held=true;
    void gate.then(()=>{
     row.lateCallbacks++;yes(observeBody(response));
     // A duplicate is foreign to the private receipt. Its fixture producer
     // disposes it explicitly after the callback; it is no refund evidence.
     if(fault.mode==='fetch-install-after')void response.body?.cancel().then(()=>{row.foreignDisposed++;},()=>{row.foreignDisposed++;});
    });
   },error=>{row.readSettled++;no(error);}]);
   if(fault.mode==='fetch-install-after'){
    const bytes=new TextEncoder().encode('{}');
    yes(observeBody(new Response(new ReadableStream({type:'bytes',start(controller){controller.enqueue(bytes);controller.close();}}))));
   }
   row.installFailed=true;throw undefined;
  }});
  return original;
 }
 if(fault.mode==='fetch-return-held'||fault.mode==='fetch-return-undefined'){
  const nativeThen=Promise.prototype.then;row.returnReads=0;row.callbacks=0;row.held=true;
  Object.defineProperty(original,'then',{value(yes,no){
   if(this!==original||arguments.length!==2)throw Error('fixture continuation observer boundary');row.thenCalls++;
   void Reflect.apply(nativeThen,this,[response=>{row.callbacks++;yes(response);},no]);
   return fault.mode==='fetch-return-held'?gate:undefined;
  }});
  return original;
 }
 return original.then(response=>{
  if(fault.reason==='listener'){
   const add=signal.addEventListener,remove=signal.removeEventListener;let installed;
   signal.addEventListener=function(name,callback,options){if(name==='abort'&&!installed)installed=callback;return Reflect.apply(add,this,[name,callback,options]);};
   signal.removeEventListener=function(name,callback,options){if(name==='abort'&&callback===installed){row.removalFailed=true;throw undefined;}return Reflect.apply(remove,this,[name,callback,options]);};
   row.release=()=>{
    // Fixture cleanup can remove its deliberate obstruction. It cannot grant
    // production a retirement receipt or refund an already UNKNOWN owner.
    if(installed)Reflect.apply(remove,signal,['abort',installed]);installed=undefined;
    delete signal.addEventListener;delete signal.removeEventListener;
    row.released=true;release();release=undefined;row.release=undefined;
   };
   return response;
  }
  const body=response.body;
  const observed=new Proxy(body,{get(target,name){
   if(name==='cancel'&&fault.mode==='body-cancel')return function(...args){
    row.cancel++;const original=Reflect.apply(target.cancel,target,args);
    return original.then(async()=>{row.cancelSettled++;row.held=true;await gate;if(fault.reason!=='success')throw reason;});
   };
   if(name==='getReader')return options=>{
    const reader=target.getReader(options);let failed=false;
    if(fault.mode){
     const read=reader.read,unlock=reader.releaseLock;
     if(fault.mode==='read-install-before'||fault.mode==='read-install-after'){
      const nativeThen=Promise.prototype.then;row.installFailed=false;row.lateCallbacks=0;
      Object.defineProperty(reader,'read',{value(...args){
       row.read++;const work=Reflect.apply(read,this,args);
       Object.defineProperty(work,'then',{value(yes,no){
        if(this!==work||arguments.length!==2)throw Error('fixture read observer boundary');row.thenCalls++;
        void Reflect.apply(nativeThen,this,[value=>{row.readSettled++;row.lateCallbacks++;yes(value);},error=>{row.readSettled++;no(error);}]);
        if(fault.mode==='read-install-after')yes({done:false,value:new Uint8Array([123,125])});
        row.installFailed=true;throw undefined;
       }});return work;
      }});
      return reader;
     }

     Object.defineProperty(reader,'read',{value(...args){row.read++;const work=Reflect.apply(read,this,args);return work.then(value=>{row.readSettled++;return value;});}});
     if(fault.mode==='closed-getter')Object.defineProperty(reader,'closed',{get(){row.closedGetter++;throw reason;}});
     if(fault.mode==='closed'||fault.mode==='unlock-before-closed'){
      const originalClosed=reader.closed;
      const observed=originalClosed.then(()=>{row.closedNative++;if(fault.mode==='closed')row.held=true;return gate.then(()=>{row.closedSettled++;if(fault.reason!=='success')throw reason;});});
      Object.defineProperty(reader,'closed',{get(){return observed;}});
     }
     Object.defineProperty(reader,'releaseLock',{value(...args){
      row.unlock++;
      const native=()=>{Reflect.apply(unlock,this,args);row.nativeUnlocked++;};
      if(fault.mode.startsWith('closed')){native();row.unlockSettled++;return;}
      if(fault.mode.startsWith('unlock-before'))native();
      row.held=true;
      const original=gate.then(()=>{if(fault.mode==='unlock-after')native();row.unlockSettled++;if(fault.reason!=='success')throw reason;});
      return fault.mode==='unlock-after'&&fault.reason==='success'?{then(fulfilled,rejected){row.thenCalls++;return original.then(fulfilled,rejected);}}:original;
     }});
     return reader;
    }
    return new Proxy(reader,{get(object,key){
     if(key==='read')return(...args)=>{
      row.read++;const work=Reflect.apply(object.read,object,args);
      return work.then(value=>{row.readSettled++;if(!failed&&row.read>(fault.afterReads??0)){failed=true;throw reason;}return value;},error=>{row.readSettled++;throw error;});
     };
     if(key==='cancel')return(...args)=>{
      row.cancel++;const work=Reflect.apply(object.cancel,object,args);
      const outcome=work.then(()=>({failed:false}),error=>({failed:true,error}));
      return outcome.then(async result=>{
       row.cancelSettled++;await gate;
       if(result.failed)throw result.error;
       throw reason;
      });
     };
     if(key==='releaseLock')return()=>{Reflect.apply(object.releaseLock,object,[]);row.unlock++;throw reason;};
     const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;
    }});
   };
   const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(response,{get(target,name){if(name==='body')return observed;const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
 });
}
function controlFailure(kind,origin){
 if(!controlFault||controlFault.kind!==kind||controlFault.origin!==origin)return;
 const reason=controlFault.reason;controlFault=undefined;
 if(reason==='undefined')throw undefined;
 if(reason==='huge')throw 'x'.repeat(17*1024*1024);
 if(reason==='forged')throw new HttpError(401,'grant_refresh_failed','synthetic forged acquisition');
 const opaque={};for(const key of ['message','stack','cause','errors','code','status'])Object.defineProperty(opaque,key,{get(){reasonReads++;throw Error('raw reason observed');}});throw opaque;
}
function environment(env,off=false){
 if(!scoped){
  const authority=new Proxy(env.ACCESS_CONTROL,{get(target,name){if(name==='idFromName')return value=>{controlFailure('authority','id');return target.idFromName(value);};if(name==='get')return id=>{
   controlFailure('authority','get');const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{const path=new URL(url).pathname;calls.push({kind:'authority',path,charged:bodyBudgetCharged()});let original=object.fetch(url,init);if(globalThis.__ownedJsonObservation?.consumers.intake.capturedBytes>0)original=holdParserPhase('intake',original);return observeControlRead('authority',path,path==='/authorization/snapshot'?holdParserPhase('delivery',original):original,init.signal);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const credentials=new Proxy(env.GRANT_CREDENTIALS,{get(target,name){if(name==='idFromName')return value=>{controlFailure('credential','id');return target.idFromName(value);};if(name==='get')return id=>{
   controlFailure('credential','get');const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{
    const path=new URL(url).pathname;calls.push({kind:'credential',path,emptyInspect:path==='/inspect'?init.body==='{}':undefined});
    if(path==='/materialize'&&controlReply){
     const fault=controlReply;controlReply=undefined;
     const original=object.fetch(url,init).then(async response=>{
      await response.body?.cancel();
      const bytes=new TextEncoder().encode(JSON.stringify({error:{code:fault.identity?'identity_admission_unavailable':'grant_refresh_failed',message:fault.identity?'Identity admission failed (protocol)':'fixture refresh unavailable'}}));
      const replacement=new Response(new ReadableStream({type:'bytes',start(controller){controller.enqueue(bytes);controller.close();}}),{status:fault.identity?503:401,headers:{'content-type':'application/json','retry-after':'7'}});
      const headers=replacement.headers,get=headers.get,row={identity:fault.identity,retryAfterReads:0};materializationReplies.push(row);
      headers.get=function(name){if(name.toLowerCase()==='retry-after')row.retryAfterReads++;return Reflect.apply(get,this,[name]);};
      return replacement;
     });
     return observeControlRead('credential',path,original,init.signal);
    }
    if(path==='/materialize'&&typeof init.body==='string'&&JSON.parse(init.body).key==='oauth/owned_http_pricing_prepare_fail/fireworks'){
     const bytes=new TextEncoder().encode('{"error":{"code":"grant_credential_missing","message":"synthetic refusal"}}');
     return Promise.resolve(new Response(new ReadableStream({type:'bytes',start(controller){controller.enqueue(bytes);controller.close();}}),{status:503,headers:{'content-type':'application/json'}}));
    }
    return observeControlRead('credential',path,object.fetch(url,init),init.signal);
   };const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const budget=new Proxy(env.BUDGET_LEDGER,{get(target,name){if(name==='get')return id=>{const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return(url,init)=>{
   const value=typeof init?.body==='string'?JSON.parse(init.body):{};calls.push({kind:'budget',path:new URL(url).pathname,charged:bodyBudgetCharged(),reservationId:value.reservationId,chargeId:value.chargeId,costMicros:value.costMicros,actualCostMicros:value.actualCostMicros});const original=globalThis.__ownedBudgetSequenceFixture?globalThis.__ownedBudgetSequenceFixture.fetch(object,url,init):object.fetch(url,init);return new URL(url).pathname==='/status'?holdParserPhase('status',original):original;
  };const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});};const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const queue=new Proxy(env.USAGE_QUEUE,{get(target,name){if(name==='send')return (...args)=>{
   const value=args[0];if(value.type==='clawrouter.usage.v1')events.push({id:value.id,requestId:value.request_id,reserved:value.reserved_cost_micros,status:value.status_code,input:value.input_tokens,output:value.output_tokens});
   if(queueHandoff&&value.type==='clawrouter.usage.v1'){
    const row=queueHandoff;row.calls++;row.args=args.length;row.frozen=Object.isFrozen(value);row.nullPrototype=Object.getPrototypeOf(value)===null;row.before=JSON.stringify(value);
    return row.gate.then(async()=>{
     row.hookBlocked=!Reflect.defineProperty(value,'toJSON',{value(){row.hooks++;return{};}});
     row.valueBlocked=!Reflect.set(value,'id','replaced-fixture-id');row.prototypeBlocked=!Reflect.setPrototypeOf(value,{toJSON(){row.hooks++;return{};}});
     row.after=JSON.stringify(value);const original=Reflect.apply(target.send,target,args);await original;row.completed=true;
    });
   }
   const original=globalThis.__ownedBudgetSequenceFixture?globalThis.__ownedBudgetSequenceFixture.send(target,args):Reflect.apply(target.send,target,args);return value.type==='clawrouter.usage.v1'?holdParserPhase('accounting',original):original;
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const values={ACCESS_CONTROL:authority,GRANT_CREDENTIALS:credentials,BUDGET_LEDGER:budget,USAGE_QUEUE:queue,CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'60',VOLCANO_ENGINE_API_KEY:'must-not-fallback',ARK_API_KEY:'must-not-fallback'};
  scoped=new Proxy(env,{get(target,name,receiver){if(name==='OWNED_CONFIG_FIXTURE'&&configurationFault)return configurationValue();return Object.hasOwn(values,name)?values[name]:Reflect.get(target,name,receiver);}});
  if(globalThis.__ownedTerminalFixture)scoped=globalThis.__ownedTerminalFixture.env(scoped);
  offScoped=new Proxy(scoped,{get(target,name,receiver){return name==='CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS'?'0':Reflect.get(target,name,receiver);}});
 }
 return off?offScoped:scoped;
}
let queueHandoff;
export default {...handler,async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/terminal'){
  if(request.method==='DELETE'){globalThis.__ownedTerminalFixture?.release();return new Response(null,{status:204});}
  if(request.method==='POST'){
   if(scoped||globalThis.__ownedTerminalFixture)throw Error('terminal fixture must precede request bindings');
   const options=await request.json();globalThis.__ownedTerminalFixture=createOwnedTerminalFixture(options,budgetCommands);
   return new Response(null,{status:204});
  }
  return Response.json(globalThis.__ownedTerminalFixture?.row??null);
 }
 if(path==='/fixture/budget-sequence'){
  if(request.method==='DELETE'){globalThis.__ownedBudgetSequenceFixture?.release();return new Response(null,{status:204});}
  if(request.method==='POST'){
   if(globalThis.__ownedBudgetSequenceFixture)throw Error('budget fixture already configured');
   const options=await request.json();
   if(options.legs!==4)throw Error('budget fixture leg count');
   const policy=JSON.parse(await env.POLICY_KV.get('policies/owned_http_chat'));
   policy.dailyBudgetMicros=1000000;policy.weeklyBudgetMicros=1000000;
   await env.POLICY_KV.put('policies/owned_http_chat',JSON.stringify(policy));
   await env.POLICY_KV.put('connections/volcengine',JSON.stringify({providerId:'volcengine',enabled:true,monthlyBudgetMicros:1000000}));
   globalThis.__ownedBudgetSequenceFixture=createOwnedBudgetSequenceFixture(options,ExactBodyCharge,bodyBudgetBytes,bodyBudgetCharged,HttpError,budgetCommands);
   return new Response(null,{status:204});
  }
  if(request.method==='PATCH'){globalThis.__ownedBudgetSequenceFixture?.releaseSend();return new Response(null,{status:204});}
  return Response.json(globalThis.__ownedBudgetSequenceFixture?.row??null);
 }
 if(path==='/fixture/queue-handoff'){
  if(request.method==='DELETE'){queueHandoff?.release();return new Response(null,{status:204});}
  if(request.method==='POST'){
   if(queueHandoff&&!queueHandoff.completed)throw Error('queue fixture still live');
   let release;const gate=new Promise(resolve=>{release=resolve;});
   queueHandoff={gate,release,calls:0,args:0,frozen:false,nullPrototype:false,before:null,after:null,hooks:0,hookBlocked:false,valueBlocked:false,prototypeBlocked:false,completed:false};
   return new Response(null,{status:204});
  }
  const row=queueHandoff;return Response.json(row?{calls:row.calls,args:row.args,frozen:row.frozen,nullPrototype:row.nullPrototype,before:row.before,after:row.after,hooks:row.hooks,hookBlocked:row.hookBlocked,valueBlocked:row.valueBlocked,prototypeBlocked:row.prototypeBlocked,completed:row.completed}:null);
 }
 if(path==='/fixture/grants'){
  for(const id of ids){const provider=id==='soft_venice'?'venice':id.startsWith('pricing')?'fireworks':id==='gmi'||id==='venice'?id:'volcengine';await putGrantCredentials(env,'oauth/owned_http_'+id+'/'+provider,{
   provider,enabled:true,kind:'api_key',credential:'fixture-upstream-'+id,...(id==='gmi'?{accountId:'fixture-organization'}:{}),unknownOwnedField:{value:['kept',null,7]}});}
  return new Response(null,{status:204});
 }
 if(path==='/fixture/configuration'){
  if(request.method==='DELETE'){clearConfigurationFault();return new Response(null,{status:204});}
  const mode=await request.text();if(!['missing','undefined','forged','opaque','invalid-url'].includes(mode)||configurationFault)throw Error('fixture configuration mode');
  const provider=snapshot.providers.find(value=>value.id==='volcengine');
  configurationFault={mode,provider,headers:provider.adapter.injectHeaders,keys:provider.config_keys,base:provider.base_urls.default};
  provider.config_keys=[...provider.config_keys,'OWNED_CONFIG_FIXTURE'];
  if(mode==='invalid-url')provider.base_urls.default='$'+'{OWNED_CONFIG_FIXTURE}';
  else provider.adapter.injectHeaders={...provider.adapter.injectHeaders,'x-owned-configuration':'$'+'{OWNED_CONFIG_FIXTURE}'};
  return new Response(null,{status:204});
 }
 if(path==='/fixture/control-fault'){
  const value=await request.json();if(!['authority','credential'].includes(value.kind)||!['id','get'].includes(value.origin)||!['undefined','huge','opaque','forged'].includes(value.reason))throw Error('fixture fault shape');
  controlFault=value;return new Response(null,{status:204});
 }
 if(path==='/fixture/control-read'){
  if(request.method==='DELETE'){for(const row of controlReads)row.release?.();return new Response(null,{status:204});}
  const value=await request.json();if(!['authority','credential','provider'].includes(value.kind)||!['undefined','shared','huge','listener','success'].includes(value.reason))throw Error('fixture read shape');
  if(value.afterReads!==undefined&&(value.kind!=='provider'||value.afterReads!==1||value.reason==='listener'))throw Error('fixture read phase');
  if(value.path!==undefined&&!(value.kind==='authority'?['/admission/credential-preflight','/admission/resolve'].includes(value.path):value.kind==='credential'&&value.path==='/materialize'))throw Error('fixture private receipt path');
  if(value.mode!==undefined&&(!['unlock-before','unlock-after','closed','closed-getter','unlock-before-closed','body-cancel','read-install-before','read-install-after','fetch-return-held','fetch-return-undefined','fetch-install-before','fetch-install-after'].includes(value.mode)||value.reason==='listener'||value.afterReads!==undefined))throw Error('fixture returned work shape');
  if(value.reason==='success'&&value.mode===undefined)throw Error('fixture success shape');
  controlReadFault=value;return new Response(null,{status:204});
 }
 if(path==='/fixture/control-reply'){
  if(request.method==='DELETE'){controlReply=undefined;return new Response(null,{status:204});}
  const value=await request.json();if(typeof value.identity!=='boolean')throw Error('fixture materialization reply');
  controlReply={identity:value.identity};return new Response(null,{status:204});
 }
 if(path==='/fixture/parser-hold'){
  if(request.method==='DELETE'){if(parserHold){parserHold.released=true;parserHold.release?.();}return new Response(null,{status:204});}
  const phase=await request.text();if(!['delivery','accounting','accounting-then','status-then','intake'].includes(phase)||parserHold)throw Error('fixture parser hold shape');
  parserHold={phase,remaining:phase==='delivery'?2:1,arrived:false,released:false};return new Response(null,{status:204});
 }
 if(path==='/fixture/revalidation-change'){
  const original=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://authority/fixture/revalidation-change',{method:'POST',body:await request.text()});
  const response=await original;await response.text();return new Response(null,{status:response.status});
 }
 if(path==='/fixture/intake-mutate'){globalThis.__ownedJsonObservation.mutateIntake();return new Response(null,{status:204});}
 if(path==='/fixture/intake-abort'){intakeController?.abort();return new Response(null,{status:204});}
 if(path==='/fixture/evict'){evictCredentialGeneration(environment(env), 'owned_http_'+await request.text());return new Response(null,{status:204});}
 if(path==='/fixture/usage-reference'){
  const {name,format}=await request.json(),wire=globalThis.__ownedUsageWire(name,format==='sse');let result;
  if(format==='sse'){const inspector=createSseUsageInspector();inspector.push(new TextEncoder().encode(wire));inspector.end();result=inspector.result();const again=inspector.result();if(JSON.stringify(result)!==JSON.stringify(again))throw Error('ordinary repeated-result mismatch');}
  else if(new TextEncoder().encode(wire).length>2097152)result={tokens:null,outcome:null};
  else{let value,valid=false;try{value=JSON.parse(wire);valid=true;}catch{}result=valid?{tokens:extractUsageTokens(value),outcome:responseOutcome(value)}:{tokens:null,outcome:'provider_error'};}
  return Response.json(result);
 }
 if(path==='/fixture/usage-case'){
  const value=await request.json();if(!globalThis.__ownedJsonObservation||typeof value.name!=='string'||!['sse','json'].includes(value.format))throw Error('fixture usage case');
  globalThis.__ownedUsageWire(value.name,value.format==='sse');
  globalThis.__ownedJsonObservation.consumerMode='usage:'+value.name+':'+value.format;return new Response(null,{status:204});
 }
 if(path==='/fixture/consumer-mode'){
  if(request.method==='DELETE'){globalThis.__ownedJsonObservation?.releaseConsumer();return new Response(null,{status:204});}
  const mode=await request.text();if(![...['bodyless','constructors','methods','next','trace','long-text','fund-grow','status-grow','final-grow','shrink','body-swap','constructor-fail','producer-fail','fail-held','capacity-held'].map(name=>'publication-'+name),...['snapshot','after','big','late','copy-normalizer','copy-public','install-before','install-after','install-reject','unlock-before-success','unlock-after-success','closed-undefined','read-undefined'].map(name=>'generic-'+name),...['tiny-empty','sniff-eof','replay-eof','trace','eof-value','large-backing','capture-before','capture-after','then-early','unlock-before-success','unlock-after-success','closed-undefined'].map(name=>'normalizer-'+name),'intake-constructor-capture','bootstrap-refuse','initial-error-hooks','initial-error-refuse','metadata-poison','metadata-branded-held','metadata-refuse-0','metadata-refuse-2','metadata-refuse-3','metadata-refuse-4','metadata-refuse-5','headers-prototype-foreach','headers-constructor-held','headers-swap','headers-foreach','headers-iterator','headers-next','headers-late','headers-long-text','headers-status-object','headers-text-object','archive-kernel-held','rpc-trace','rpc-duplicates','public-byte-snapshot','public-eof-foreign','public-capacity-refusal','handoff-getters','handoff-duplicates','public-handoff-getters','public-handoff-duplicates','source-handoff-getters','source-handoff-duplicates','normal','shared-refusal','forged','stale','mode','then-early','public-then-early','source-then-early','intake-request-before','intake-request-after','intake-request-late','intake-cells-148','intake-cells-512',...['third-bytes','shadow-buffer','value1-oversized','value2-oversized','value3-oversized','length-one-to-four','length-four-to-one','length-object','set-accessor','set-replacement','set-shadow','set-persist-through-auth','set-change-in-third-getter'].map(name=>'intake-operand-'+name),'status-pending-success','status-unlock-after-success','status-unlock-before-closed-shared','status-closed-undefined','capture-before','capture-after','read-undefined','read-primitive','read-shared','unlock-before-success','unlock-before-undefined','unlock-before-primitive','unlock-before-shared','unlock-after-success','unlock-after-undefined','unlock-after-primitive','unlock-after-shared','unlock-before-closed-shared','closed-undefined','closed-shared',...['before','after'].flatMap(order=>['success','undefined','primitive','shared'].map(kind=>'public-unlock-'+order+'-'+kind)),'public-closed-undefined','public-closed-shared','public-unlock-before-closed-shared',...['before','after'].flatMap(order=>['success','undefined','primitive','shared'].map(kind=>'intake-unlock-'+order+'-'+kind)),'intake-closed-undefined','intake-closed-shared','intake-unlock-before-closed-shared'].includes(mode)||!globalThis.__ownedJsonObservation)throw Error('fixture consumer mode');
  globalThis.__ownedJsonObservation.consumerMode=mode;return new Response(null,{status:204});
 }
 if(path==='/fixture/state')return Response.json({configurationGets,configurationReasonReads,driverReads:globalThis.__ownedJsonObservation?.driverReads??0,driverFactories:globalThis.__ownedJsonObservation?.driverFactories??0,intakeFactories:globalThis.__ownedJsonObservation?.intakeFactories??0,shared:globalThis.__ownedJsonObservation?.shared??null,consumers:globalThis.__ownedJsonObservation?.consumers??null,usage:globalThis.__ownedJsonObservation?.usage??null,statusReaders:globalThis.__ownedJsonObservation?.statusReaders??[],rpcReaders:globalThis.__ownedJsonObservation?.rpcReaders??[],archive:globalThis.__ownedJsonObservation?.archive??null,headerClone:globalThis.__ownedJsonObservation?.headers??null,initialErrors:globalThis.__ownedJsonObservation?.initialErrors,metadata:globalThis.__ownedJsonObservation?.metadata??null,continuationStages:globalThis.__ownedJsonObservation?.continuationStages,adapterReads:globalThis.__ownedJsonObservation?.adapterReads??null,parsers:globalThis.__ownedJsonObservation?.rows??[],parserHold:parserHold?{arrived:parserHold.arrived,released:parserHold.released}:null,calls,intakes,completed,events,recursivePricingValues,reasonReads,materializationReplies,controlReads:controlReads.map(({kind,read,readSettled,cancel,cancelSettled,unlock,released,removalFailed,held,nativeUnlocked,unlockSettled,thenCalls,closedNative,closedSettled,closedGetter,installFailed,lateCallbacks})=>({kind,read,readSettled,cancel,cancelSettled,unlock,released,...(removalFailed?{removalFailed:true}:{}),...(installFailed===undefined?{}:{installFailed,lateCallbacks}),...(held===undefined?{}:{held,nativeUnlocked,unlockSettled,thenCalls,closedNative,closedSettled,closedGetter})})),charged:bodyBudgetCharged()});
 if(path==='/fixture/pressure'){
  if(request.method==='DELETE'){pressure?.release();pressure=undefined;return new Response(null,{status:204});}
  if(pressure)throw Error('fixture pressure already held');
  pressure=ExactBodyCharge.reserve(bodyBudgetBytes-bodyBudgetCharged()-40*1024*1024);
  if(!pressure)throw Error('fixture pressure reserve failed');
  return new Response(null,{status:204});
 }
 if(path==='/fixture/upstream')return fetch('https://fixture.example/state');
 if(path==='/v1/catalog')return handler.fetch(request,environment(env),context);
 const id=ids.find(value=>request.headers.get('authorization')==='Bearer clawrouter-live-owned_http_'+value+'-fixture-secret')??'unknown';
 intakes.push({id,path});
 const roots=[];
 const own=promise=>{const outcome=promise.then(()=>({failed:false}),error=>{
  // Only invocation-local inspection of the final owned aggregate. The report
  // carries fixed origin enums/presence; no raw rejection, message or stack.
  const errors=error instanceof AggregateError?Object.getOwnPropertyDescriptor(error,'errors')?.value:undefined,origins=[];
  if(!Array.isArray(errors))origins.push({origin:'unexpected',undefined:false});
  else for(const value of errors){
   const origin=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'origin')?.value:undefined;
   const absent=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'primaryIsUndefined')?.value:undefined;
   origins.push({origin:['read','cancel','unlock','closed','listener-remove','abort','pull','retire'].includes(origin)?origin:'unexpected',undefined:absent===true});
  }
  return{failed:true,origins};
 });roots.push(outcome);return promise;};
 const observed=new Proxy(context,{get(target,name){if(name==='waitUntil')return promise=>target.waitUntil(own(promise));const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
 let response;
 try{if(globalThis.__ownedJsonObservation?.consumerMode.startsWith('intake-request-')||globalThis.__ownedJsonObservation?.consumerMode==='generic-late'){const headers=new Headers(request.headers);headers.delete('content-length');intakeController=new AbortController();request=new Request(request,{headers,signal:intakeController.signal});}pricingActive=id.startsWith('pricing');return response=await privateOwnedHttpChat.fetch(request,environment(env,id==='off'),observed);}
 finally{
  pricingActive=false;
  // This ORIGINAL caller owns these accepted promises; foreign requests read
  // only completed scalar flags. The receipt never claims native physical ACK.
  context.waitUntil((async()=>{let failed=false;const origins=[];for(let i=0;i<roots.length;i++){const outcome=await roots[i];failed||=outcome.failed;if(outcome.origins)origins.push(...outcome.origins);}completed.push({id,failed,origins});})());
  response=undefined;
 }
}};
`;

export const ownedHttpUpstream = String.raw`
__COMPACT_JSON_WIRE__
__OWNED_SSE_LINES__
__OWNED_USAGE_WIRE__
const calls=[];
export default {async fetch(request){
 if(request.url==='https://fixture.example/state')return Response.json(calls);
 if(!['https://ark.cn-beijing.volces.com/api/v3/chat/completions','https://api.gmi-serving.com/v1/chat/completions','https://api.venice.ai/api/v1/chat/completions','https://api.fireworks.ai/inference/v1/chat/completions'].includes(request.url))throw Error('unexpected owned HTTP destination');
 const header=request.headers.get('authorization')??'',id=header.startsWith('Bearer fixture-upstream-')?header.slice('Bearer fixture-upstream-'.length):'invalid';
 const body=await request.json(),row={id,requestMarker:typeof body.messages?.[0]?.content==='string'?(body.messages[0].content.startsWith('snapA')?'snapA':body.messages[0].content.startsWith('snapB')?'snapB':null):null,method:request.method,model:body.model,stream:body.stream===true,bytes:new TextEncoder().encode(JSON.stringify(body)).byteLength,canceled:false,organization:request.headers.get('x-organization-id')};calls.push(row);
 if(id==='gmi'&&row.organization!=='fixture-organization')throw Error('original organization missing');
 if(id==='invalid')return Response.json({error:{type:'invalid_request_error',message:'fixture credential rejected'}},{status:401});
 if(body.ownedPublicationCase==='bodyless')return new Response(null,{status:204});
 if(body.ownedGenericUsageCase)return new Response(ownedUsageWire(body.ownedGenericUsageCase,body.stream===true),{headers:{'content-type':body.stream===true?'text/event-stream':'application/json'}});
 if(body.ownedNormalizerCase){
  const mode=body.ownedNormalizerCase;
  if(mode==='json-limit'||mode==='json-over'){
   const prefix='{"error":{"message":"',suffix='"}}',length=65536+(mode==='json-over'?1:0);
   return new Response(prefix+'x'.repeat(length-prefix.length-suffix.length)+suffix,{status:400,headers:{'content-type':'application/json'}});
  }
  if(mode==='native-json')return new Response(' {"error":{"message":"fixture native","type":"invalid_request_error","extra":true}} \n',{status:400,headers:{'content-type':'application/json'}});
  const event='data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n';
  const prefix=mode==='comments'?': comment\r\n\r\n':mode==='cutoff'?':'+ 'x'.repeat(8192):mode==='crossing'?':'+ 'x'.repeat(2097153)+'\n\n':'';
  return new Response(prefix+event,{headers:{'content-type':'text/event-stream'}});
 }
 if(id==='error')return Response.json({error:{type:'invalid_request_error',message:'synthetic rejection'}},{status:400});
 const usage={prompt_tokens:4,completion_tokens:3,total_tokens:7};
 if(id==='venice'&&body.messages?.some(message=>message.role==='user'&&message.content==='fixture-owned-flat-escaped'))return new Response('data: '+JSON.stringify({model:body.model,choices:[{index:0,delta:{content:'synthetic-answer'},finish_reason:'stop'}],usage}).slice(0,-1)+',\"extra\":\"'+'\\u0061'.repeat(21000)+'\"}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 if((id==='venice'||id==='soft_venice')&&body.ownedVeniceCase?.startsWith('line-'))return new Response(ownedCodecSseLines(body.model,body.ownedVeniceCase),{headers:{'content-type':'text/event-stream'}});
 if((id==='venice'||id==='soft_venice')&&body.ownedVeniceCase?.startsWith('compact-')){
  const later=body.ownedVeniceCase==='compact-later-object128'||body.ownedVeniceCase==='compact-later-object129'||body.ownedVeniceCase==='compact-later-flat-invalid',comments=body.ownedVeniceCase==='compact-comment-prefix',wire=ownedJsonCodecWire(later?(body.ownedVeniceCase==='compact-later-flat-invalid'?'compact-flat-invalid':body.ownedVeniceCase==='compact-later-object129'?'compact-object129':'compact-object-string128'):comments?'compact-object128':body.ownedVeniceCase,body.model);
  const prefix=later?'data: '+JSON.stringify({model:body.model,choices:[]})+'\n\n':comments?':'+ 'x'.repeat(8192)+'\n\n':'';
  return new Response(body.stream===true?prefix+'data: '+wire+'\n\ndata: [DONE]\n\n':wire,{headers:{'content-type':body.stream===true?'text/event-stream':'application/json'}});
 }
 if((id==='venice'||id==='soft_venice')&&body.ownedVeniceCase&&body.stream!==true){
  const mode=body.ownedVeniceCase,prefix='{"model":'+JSON.stringify(body.model)+',"extra":';let wire;
  if(mode==='depth128'||mode==='depth129'){const depth=mode==='depth128'?127:128;wire=prefix+'['.repeat(depth)+'0'+']'.repeat(depth)+'}';}
  else if(mode==='object-depth128')wire=prefix+'{"child":'.repeat(127)+'0'+'}'.repeat(128);
  else if(mode==='open2048')wire='['.repeat(2048)+'0'+']'.repeat(2048);
  else if(mode==='nodes65536'||mode==='nodes65537')wire=prefix+'['+'0,'.repeat(mode==='nodes65536'?65532:65533)+'0]}';
  else if(mode==='wire-limit'||mode==='wire-plus'){const size=2097152+(mode==='wire-plus'?1:0);wire=prefix+'"'+'x'.repeat(size-prefix.length-3)+'"}';}
  else if(mode==='unicode-unknown')wire=prefix+'{"__proto__":{"kept":true},"duplicate":1,"duplicate":2,"text":"é😀\\ud800x\\udfff\\n\\\"\\\\"}}';
  else if(mode==='wrong-model')wire='{"model":"other-model"}';
  else if(mode==='own-error')wire='{"model":'+JSON.stringify(body.model)+',"error":null}';
  else throw Error('fixture Venice mode');
  return new Response(wire,{headers:{'content-type':'application/json','etag':'fixture-etag','digest':'fixture-digest','content-md5':'fixture-md5'}});
 }
 if(body.stream!==true)return Response.json({id:'fixture-owned-chat',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'synthetic-answer'},finish_reason:'stop'}],usage});
 const encoder=new TextEncoder();let stage=0;
 const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'fixture-owned-chat',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
 return new Response(new ReadableStream({async pull(controller){
  if((id==='venice'||id==='soft_venice')&&body.ownedVeniceCase==='stream-large'&&stage<20){stage++;controller.enqueue(encoder.encode(chunk({content:'x'.repeat(120000)})));return;}
  if(id==='abort'&&stage>0){await new Promise(resolve=>setTimeout(resolve,10));controller.enqueue(encoder.encode(': keepalive\n\n'));return;}
  if(stage++===0){controller.enqueue(encoder.encode(id==='tool'?chunk({role:'assistant',tool_calls:[{index:0,id:'fixture-tool',type:'function',function:{name:'lookup',arguments:'{"value":"'}}]}):chunk({role:'assistant',content:'synthetic-answer'})));return;}
  if(stage===2&&id==='tool'){controller.enqueue(encoder.encode(chunk({tool_calls:[{index:0,function:{arguments:'fixture"}'}}]})));return;}
  controller.enqueue(encoder.encode(chunk({},id==='tool'?'tool_calls':'stop')+'data: '+JSON.stringify({id:'fixture-owned-chat',object:'chat.completion.chunk',model:body.model,choices:[],usage})+'\n\ndata: [DONE]\n\n'));controller.close();
 },cancel(){row.canceled=true;}}),{headers:{'content-type':'text/event-stream'}});
}};
`.replace('__COMPACT_JSON_WIRE__', () => ownedJsonCodecWire.toString()).replace('__OWNED_SSE_LINES__', () => ownedCodecSseLines.toString()).replace('__OWNED_USAGE_WIRE__', () => ownedUsageWire.toString());
