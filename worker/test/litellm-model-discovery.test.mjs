import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { workerAbortEvidence } from "../../scripts/worker-test-failure-reporter.mjs";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };

export const selected = "tenant/private-alias", hidden = "tenant/private-hidden";
export const catalogRow = { id: selected, object: "model", owned_by: "synthetic-tenant", model_info: { input_cost_per_token: "unqualified-unit" } };
export const key = id => `clawrouter-live-${id}-fixture-secret`;
export const manifests = readdirSync("providers").filter(name => name.endsWith(".provider.yaml")).sort().map(name => parse(readFileSync(`providers/${name}`, "utf8")));
assert.ok(manifests.length > 0);
assert.deepEqual(manifests.map(row => row.id).sort(), snapshot.providers.map(row => row.id).sort());
assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
const provider = snapshot.providers.find(row => row.id === "litellm");

// This drain observes originals; it never turns rejection (including undefined)
// into retirement credit. A child registered during an earlier join is included.
export async function joinOriginalOperations(records) {
  let cursor = 0;
  const failures = [];
  while (cursor < records.length) {
    const batch = records.slice(cursor); cursor += batch.length;
    const outcomes = await Promise.allSettled(batch.map(record => record.promise));
    for (let i = 0; i < outcomes.length; i++) if (outcomes[i].status === "rejected") failures.push(outcomes[i].reason);
  }
  if (failures.length) throw new AggregateError(failures, "original fixture operations failed");
}

export function observeLiteLLMOperation(s, kind, start, details = {}) {
  const record = {...details, kind, ordinal:s.operations.length, invoke:++s.sequence, state:"pending"};
  s.operations.push(record);
  let pending;
  try { pending = start(); }
  catch (error) { record.state="threw"; record.error=error; record.settle=++s.sequence; s.failures.push(error); throw error; }
  record.pending=pending;
  s.roots.push(pending.then(value => { record.value=value; record.state="fulfilled"; record.settle=++s.sequence; }, error => {
    record.error=error; record.state="rejected"; record.settle=++s.sequence;
    record.abortedAtSettle=record.signal?.aborted===true;
    record.sameSignalReasonAtSettle=record.signal?.aborted===true && error===record.signal.reason;
  }));
  return pending;
}
export async function collectLiteLLMOperations(s) {
  let at=0;
  while(at<s.roots.length){const batch=s.roots.slice(at);at=s.roots.length;for(const outcome of await Promise.allSettled(batch))if(outcome.status==="rejected")s.observerFailures.push(outcome.reason);}
  return s.operations.filter(r=>r.state!=="fulfilled");
}
// BEGIN request-owned fixture functions.
export function litellmPredicateFacts() {
  let first = null, evaluated = 0, passed = 0, failed = 0, undefinedFailure = null;
  const begin = id => { if (!Number.isInteger(id) || id < 0 || id > 29) throw new Error("invalid predicate id"); evaluated |= 2 ** id; };
  const fault = (id, error) => { failed |= 2 ** id; if (first === null) { first = id; undefinedFailure = error === undefined; } };
  return {
    run(id, action) { begin(id); try { const value = action(); passed |= 2 ** id; return value; } catch (error) { fault(id, error); throw error; } },
    async wait(id, action) { begin(id); try { const value = await action(); passed |= 2 ** id; return value; } catch (error) { fault(id, error); throw error; } },
    note(id, ok) { begin(id); if (ok) passed |= 2 ** id; else { failed |= 2 ** id; if (first === null) first = id; } return ok; },
    snapshot() { return [first, evaluated, passed & ~failed, failed, undefinedFailure]; },
  };
}
export function litellmRequestScope(storage, generation) {
  const requests = new WeakMap(), states = new WeakMap(), resources = new WeakMap(), responseBodies = new WeakMap(), transports = new WeakSet(), cleanup = new WeakMap();
  let next = 0, nextTransport = 0, nextReader = 0;
  const state = token => {
    const s = token && states.get(token);
    if (!s || !s.live || token.generation !== generation || requests.get(token.request) !== token) throw new Error("invalid ingress lifetime");
    return s;
  };
  const bound = (resource, owner) => {
    state(owner.token);
    if (!transports.has(owner)) throw new Error("foreign ingress transport");
    if (resources.get(resource) !== owner) throw new Error("foreign ingress resource");
    const current = storage.getStore();
    if (current !== undefined && current !== owner.token) throw new Error("foreign ingress context");
  };
  const matchesResponse = (owner, response, body) => transports.has(owner) && resources.get(response) === owner
    && responseBodies.get(response) === body && resources.get(body) === owner;
  return {
    matchesResponse,
    register(request, scenario) {
      if (!request || requests.has(request)) throw new Error("replayed ingress");
      const token = Object.freeze({ request, scenario, generation, id: ++next });
      requests.set(request, token); states.set(token, { live: true, entered: false }); return token;
    },
    invoke(token, fn, receiver, args) {
      const s = state(token);
      if (s.entered || args[0] !== token.request) throw new Error("foreign ingress invocation");
      s.entered = true;
      return storage.run(token, () => Reflect.apply(fn, receiver, args));
    },
    transport(scenario, signal) {
      const token = storage.getStore(), s = state(token);
      if (!s.entered || token.scenario !== scenario) throw new Error("unbound ingress transport");
      const owner = Object.defineProperties({}, Object.getOwnPropertyDescriptors(Object.freeze({ token, request: token.request, signal, id: ++nextTransport })));
      transports.add(owner); return owner;
    },
    response(owner, response) {
      state(owner.token);
      if (!transports.has(owner)) throw new Error("foreign ingress transport");
      if (resources.has(response)) throw new Error("ambiguous ingress response");
      const body = response.body;
      if (body && resources.has(body)) throw new Error("ambiguous ingress response");
      resources.set(response, owner); responseBodies.set(response, body);
      if (body) { resources.set(body, owner); cleanup.set(body, new Set()); }
      return body;
    },
    body(owner, body, expected = body, method = "getReader") {
      if (body !== expected) throw new Error("foreign body receiver"); bound(body, owner);
      if (method === "cancel") { const attempts = cleanup.get(body); if (attempts.has(method)) throw new Error("replayed body cleanup"); attempts.add(method); }
      else if (method !== "getReader") throw new Error("foreign body method");
    },
    reader(owner, body, reader) {
      bound(body, owner);
      if (resources.has(reader)) throw new Error("ambiguous ingress reader");
      resources.set(reader, owner); cleanup.set(reader, new Set()); return ++nextReader;
    },
    operation(owner, reader, expected = reader, method = "read") {
      if (reader !== expected) throw new Error("foreign reader receiver"); bound(reader, owner);
      if (!["read", "cancel", "unlock"].includes(method)) throw new Error("foreign reader method");
      if (method !== "read") { const attempts = cleanup.get(reader); if (attempts.has(method)) throw new Error("replayed reader cleanup"); attempts.add(method); }
    },
    retains(owner, response, body, reader) { return matchesResponse(owner,response,body) && resources.get(reader)===owner; },
    owns(owner, response, body, reader) {
      try { state(owner.token); } catch { return false; }
      return matchesResponse(owner, response, body) && resources.get(reader) === owner;
    },
    retire(token) { const s = state(token); s.live = false; },
  };
}
// Read-only readiness from originals already observed by this request owner.
// This does not certify the independent upstream producer's nonexpiry.
export function litellmHeldReady(r, scope) {
  if (r.mode !== "held" || r.failures.length || r.observerFailures.length
    || r.operations.some(op => op.state === "rejected" || op.state === "threw") || r.requests.length !== 1) return false;
  const request = r.requests[0], token = request.token;
  if (!token || token.request !== request.request || token.scenario !== r || request.retired || request.request.signal.aborted) return false;
  const handlers = r.operations.filter(op => op.kind === "handler" && op.token === token);
  const transports = r.inputs.filter(input => input.token === token && input.request === request.request);
  if (handlers.length !== 1 || handlers[0].state !== "pending" || transports.length !== 1 || r.inputs.length !== 1) return false;
  const transport = transports[0];
  if (!transport.signal || transport.signal.aborted || transport.abortSequence !== undefined) return false;
  const fetches = r.operations.filter(op => op.kind === "fetch" && op.transport === transport);
  const acquired = r.operations.filter(op => op.kind === "acquisition_observer" && op.input === transport);
  const readers = r.readers.filter(reader => reader.transport === transport);
  if (fetches.length !== 1 || fetches[0].state !== "fulfilled" || acquired.length !== 1 || acquired[0].state !== "fulfilled" || acquired[0].originalFetch !== fetches[0].pending || readers.length !== 1 || r.readers.length !== 1) return false;
  const reader = readers[0];
  if (reader.eof || reader.unlocks !== 0 || !reader.body.locked || !scope.owns(transport, fetches[0].value, reader.body, reader.reader)) return false;
  const reads = r.operations.filter(op => op.kind === "read" && op.reader === reader && op.input === transport && op.receiverIdentity === true);
  const pending = reads.filter(op => op.state === "pending");
  return pending.length === 1 && reads.some(op => op.state === "fulfilled" && op.value?.done === false
    && op.value.value?.byteLength > 0 && Number.isSafeInteger(op.settle) && Number.isSafeInteger(pending[0].invoke) && op.settle < pending[0].invoke);
}
export function litellmWorkerResource(r, scope) {
  const read = r.operations.find(op => op.kind === "read" && op.state !== "fulfilled"), reader = read?.reader, input = read?.input;
  if (!read || !reader || !input) return null;
  const matches = kind => r.operations.filter(op => op.kind === kind && op.reader === reader && op.input === input);
  const observers = matches("read_observer").filter(op => op.originalRead === read.pending), closed = matches("closed"), cancels = matches("cancel");
  const rows = [read, observers.length === 1 ? observers[0] : null, closed.length === 1 ? closed[0] : null, cancels.length === 1 ? cancels[0] : null];
  const mask = values => values.reduce((n,v,i) => n | (v === true ? 2 ** i : 0), 0);
  const error = op => !!op && Object.hasOwn(op,"error");
  const same = (a,b) => error(a) && error(b) ? Object.is(a.error,b.error) : null;
  const c = rows[3], reasonPresent = !!c && c.operandPresent;
  return [[input.token.generation,input.token.id,input.id,reader.id ?? null],
    mask([reader.bound,reader.response === input.response,scope?.matchesResponse(input,reader.response,reader.body) === true,reader.transport === input,read.receiverIdentity,rows[1]?.originalRead === read.pending]),
    rows.map(op => op ? [op.ordinal,["pending","fulfilled","rejected","threw"].indexOf(op.state),mask([error(op),error(op)&&op.error!==undefined,error(op)&&op.error!==null&&typeof op.error==="object"]),op.invoke,op.settle ?? null] : null),
    [same(rows[0],rows[1]),same(rows[0],rows[2]),same(rows[0],rows[3]),same(rows[2],rows[3]),reasonPresent&&error(read)?Object.is(c.reason,read.error):null,c?.signalAborted??null,c?.sameSignalReasonAtSettle??null,read.signalAborted??null,read.abortedAtSettle??null,read.sameSignalReasonAtSettle??null,c?.abortedAtSettle??null],
    c?.argc ?? null,[reader.unlockInvoke??null,reader.unlockSequence??null,reader.unlocks],reader.eof];
}
export function litellmWorkerLedger(r, scope) {
  const cap = n => Math.min(n, 1_000_000), kinds = ["handler", "fetch", "acquisition_observer", "read", "read_observer", "closed", "cancel", "body_cancel", "wait_until", "usage_ingest"];
  const bad = r.operations.filter(op => op.state !== "fulfilled"), selected = bad.slice(0, 2);
  return [cap(r.operations.length), cap(r.operations.filter(op => op.state === "pending").length), cap(r.failures.length), cap(r.observerFailures.length),
    cap(r.readers.filter(reader => reader.body.locked).length), cap(r.readers.filter(reader => reader.unlocks !== 1).length), cap(Math.max(0, bad.length - selected.length)),
    selected.map(op => [cap(op.ordinal), kinds.indexOf(op.kind) + 1, ["pending", "fulfilled", "rejected", "threw"].indexOf(op.state),
      op.input?.token?.id ?? op.transport?.token?.id ?? op.token?.id ?? null, op.input?.id ?? op.transport?.id ?? null, op.reader?.id ?? null,
      Object.hasOwn(op, "error"), Object.hasOwn(op, "error") ? op.error !== undefined : null, cap(op.invoke), op.settle == null ? null : cap(op.settle)]), litellmWorkerResource(r,scope),...(r.workerDataDisposition?[r.workerDataDisposition]:[])];
}
// Only the two authored partial-abort roles may receive this post-join DATA partition.
export function litellmPartialRole(r) {
  return r.control === "partial_abort" && r.mode === "partial_abort"
    && (r.id === "sdk_partial_abort" && r.nativeApi === undefined || r.id === "sdk_stream_partial_abort" && r.nativeApi === "stream");
}
export function litellmProducerRetired(r, source) {
  if(!source||source.released!==false||source.active!==0||source.expired!==0||source.canceled!==1||source.finished!==2||!Array.isArray(source.operations)||!source.operations.length
    || source.operations.some(op=>op.state!=="fulfilled")||source.operations.filter(op=>op.kind==="cancel").length!==1
    || JSON.stringify(source.joined)!==JSON.stringify([1,source.operations.length,source.operations.length*2,0]))return false;
  if(r.calls.length!==2||!Array.isArray(source.calls)||source.calls.length!==2)return false;
  if(!Array.isArray(source.owners)||source.owners.length!==2||source.owners.reduce((n,o)=>n+o.operations,0)!==source.operations.length||source.operations.some(op=>!["pull","cancel"].includes(op.kind)))return false;
  for(const method of ["GET","POST"]){
    const calls=source.calls.filter(call=>call.method===method), local=r.calls.filter(call=>call.method===method);
    if(calls.length!==1||local.length!==1)return false;const call=calls[0], request=local[0];
    const index=source.calls.indexOf(call),owners=source.owners.filter(owner=>owner.call===index);
    if(owners.length!==1)return false;const owner=owners[0];
    if(owner.finished!==true||owner.held!==(method==="POST")||owner.chat!==(method==="POST")||owner.eof!==(method==="GET")
      || owner.cancels!==(method==="POST"?1:0)||owner.fulfilledCancels!==owner.cancels||owner.operations<1||owner.observers!==owner.operations*2)return false;
    const url="https://gateway.example"+r.basePath+(method==="GET"?"/models":"/chat/completions");
    if(call.url!==url||request.url!==url||call.authorization!=="Bearer fixture-upstream-"+r.id||request.authorization!==call.authorization
      || request.query!==""||request.redirect!=="manual"||request.extra!==false||request.body!==(method==="POST")
      || (method==="GET"?call.body!==null:call.body?.model!=="tenant/private-alias"||call.body.stream!==true))return false;
  }
  return true;
}
export function litellmJoinedReadData(r, scope, source) {
  if (!litellmPartialRole(r) || r.failures.length || r.observerFailures.length || r.requests.length !== 2 || r.inputs.length !== 2) return null;
  const bad = r.operations.filter(op => op.state !== "fulfilled");
  if (bad.length !== 2) return null;
  const read = bad.find(op => op.kind === "read"), derivative = bad.find(op => op.kind === "read_observer");
  if (!read || !derivative || bad.some(op => op.state !== "rejected" || !Object.hasOwn(op,"error"))
    || read.error === null || typeof read.error !== "object" || !Object.is(read.error,derivative.error)
    || !read.pending || !derivative.pending || read.pending === derivative.pending || derivative.originalRead !== read.pending) return null;
  const reader=read.reader, input=read.input;
  if (!reader || !input || derivative.reader!==reader || derivative.input!==input || reader.transport!==input || reader.response!==input.response
    || !scope.owns(input,reader.response,reader.body,reader.reader) || reader.bound!==true || reader.eof || reader.unlocks!==1 || reader.body.locked || reader.unlockReceiver!==true) return null;
  if (input.token.scenario!==r || input.token.request!==input.request || r.requests.filter(q=>q.token===input.token&&q.request===input.request&&!q.retired).length!==1
    || r.readers.filter(value=>value===reader).length!==1 || r.inputs.filter(value=>value===input).length!==1) return null;
  for(const op of [read,derivative])if(op.receiver!==reader.reader||op.receiverIdentity!==true||op.originalMethod!==reader.methods.read)return null;
  for(const [name,key] of [["read","read"],["cancel","cancel"],["releaseLock","unlock"]])if(Object.getOwnPropertyDescriptor(reader.reader,name)?.value!==reader.wrappers[key])return null;
  for(const pending of [read.pending,derivative.pending])if(r.operations.filter(op=>op.pending===pending).length!==1||r.roots.includes(pending))return null;
  if(r.operations.some(op=>[read.pending,derivative.pending].includes(op.originalFetch)||(op.originalRead===read.pending&&op!==derivative)||op.originalRead===derivative.pending))return null;
  const owned=r.operations.filter(op=>op.reader===reader), closed=owned.filter(op=>op.kind==="closed"), canceled=owned.filter(op=>op.kind==="cancel");
  if(closed.length!==1||closed[0].pending!==reader.closed||closed[0].state!=="fulfilled"||canceled.length!==1||canceled[0].state!=="fulfilled"
    || canceled[0].input!==input||canceled[0].receiver!==reader.reader||canceled[0].originalMethod!==reader.methods.cancel||canceled[0].receiverIdentity!==true) return null;
  if(!Number.isSafeInteger(reader.unlockInvoke)||!Number.isSafeInteger(reader.unlockSequence)||reader.unlockSequence<=reader.unlockInvoke
    || owned.some(op=>!Number.isSafeInteger(op.settle)||op.settle>=reader.unlockInvoke)||closed[0].invoke>=read.invoke||canceled[0].invoke>=reader.unlockInvoke) return null;
  if(!owned.some(op=>op.kind==="read"&&op.state==="fulfilled"&&op.value?.done===false&&op.value.value?.byteLength>0&&op.settle<read.invoke))return null;
  const fetches=r.operations.filter(op=>op.kind==="fetch"&&op.transport===input), acquisitions=r.operations.filter(op=>op.kind==="acquisition_observer"&&op.input===input);
  if(fetches.length!==1||fetches[0].value!==reader.response||acquisitions.length!==1||acquisitions[0].originalFetch!==fetches[0].pending)return null;
  if(r.requests.some(q=>r.operations.filter(op=>op.kind==="handler"&&op.token===q.token&&op.state==="fulfilled").length!==1))return null;
  if(!litellmProducerRetired(r,source))return null;
  return [read,derivative];
}
// Snapshot every retained data field and array membership; no getter or error inspection.
export function litellmRetirementSeal(r, scope, pair) {
  const names=["operations","roots","inputs","readers","bodies","requests","failures","observerFailures","calls"],arrays=names.map(name=>r[name]);
  const members=arrays.map(values=>values.slice());
  const rows=[...r.operations,...r.inputs,...r.readers,...r.calls];
  const captured=rows.map(row=>Object.getOwnPropertyDescriptors(row));
  return () => arrays.every((values,i)=>r[names[i]]===values&&values.length===members[i].length&&values.every((v,j)=>v===members[i][j]))
    && rows.every((row,i)=>{const now=Object.getOwnPropertyDescriptors(row),before=captured[i];return Reflect.ownKeys(now).length===Reflect.ownKeys(before).length&&Reflect.ownKeys(before).every(key=>Object.hasOwn(before[key],"value")&&Object.hasOwn(now[key],"value")&&Object.is(before[key].value,now[key].value));})
    && r.readers.every(reader=>reader.unlocks===1&&!reader.body.locked&&scope.retains(reader.transport,reader.response,reader.body,reader.reader))
    && r.readers.every(reader=>[["read","read"],["cancel","cancel"],["releaseLock","unlock"]].every(([name,key])=>Object.getOwnPropertyDescriptor(reader.reader,name)?.value===reader.wrappers[key]))
    && (!pair||pair.every(op=>op.state==="rejected"));
}
export async function litellmWorkerDrain(r, scope, loadSource) {
  const checks=r.retireChecks??=litellmPredicateFacts();await checks.wait(1,()=>collectLiteLLMOperations(r));
  if(r.localRetirement){if(!r.localRetirement.valid()){const late=[...r.failures,...r.observerFailures,...r.operations.filter(op=>op.state!=="fulfilled").map(op=>op.error),new Error("late Worker retirement mutation")];r.workerDataDisposition=Object.freeze([1,r.operations.filter(op=>op.state==="rejected"||op.state==="threw").length,late.length]);throw new AggregateError(late,"invalidated Worker retirement");}if(r.localRetirement.failures.length)throw new AggregateError(r.localRetirement.failures,"original Worker retirement failed");return r.localRetirement;}
  const controlFailures=[];let source;
  if(litellmPartialRole(r))try{source=await loadSource();}catch(error){controlFailures.push(error);}
  await checks.wait(1,()=>collectLiteLLMOperations(r));
  const failures=[...r.failures,...r.observerFailures,...controlFailures];
  checks.note(2,r.failures.length===0);checks.note(3,r.observerFailures.length===0);
  if(litellmPartialRole(r)&&!litellmProducerRetired(r,source))failures.push(new Error("original producer did not retire"));
  const pair=failures.length===0?litellmJoinedReadData(r,scope,source):null;
  for(const op of r.operations)if(!checks.note(4,op.state==="fulfilled")&&!pair?.includes(op))failures.push(op.error);
  for(const reader of r.readers)if(!checks.note(5,reader.unlocks===1&&!reader.body.locked))failures.push(new Error("original reader remained owned"));
  if(!checks.note(6,!r.bodies.some(body=>body.locked)))failures.push(new Error("original body locked"));
  const raw=r.operations.filter(op=>op.state==="rejected"||op.state==="threw").length;
  r.workerDataDisposition=Object.freeze([pair&&failures.length===0?2:raw?1:0,raw,failures.length]);
  const stable=litellmRetirementSeal(r,scope,pair), sourceSnapshot=source===undefined?undefined:JSON.stringify(source);
  const result=Object.freeze({failures:Object.freeze(failures),source,valid:()=>stable()&&(source===undefined?sourceSnapshot===undefined:JSON.stringify(source)===sourceSnapshot)});if(litellmPartialRole(r))r.localRetirement=result;
  if(failures.length)throw new AggregateError(failures,"original Worker retirement failed");return result;
}
export async function litellmWorkerSourceProof(r, fetchOriginal) {
  const failures=[];let response,result;
  try{
    response=await observeLiteLLMOperation(r,"control_fetch",()=>Reflect.apply(fetchOriginal,globalThis,["https://fixture.test/proof/"+r.id]));
    if(response.status!==200)throw new Error("producer proof control failed");
    result=await observeLiteLLMOperation(r,"control_body",()=>response.json());
  }catch(error){failures.push(error);}
  try{if(response&&!response.bodyUsed)await observeLiteLLMOperation(r,"control_cancel",()=>response.body?.cancel());}catch(error){failures.push(error);}
  if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,"producer control and cleanup failed");return result;
}
export async function litellmControlResponse(response, action) {
  const errors = []; let result;
  try { assert.equal(response.status, 200, `control ${action}`); result = await response.json(); } catch (error) { errors.push(error); }
  try { if (!response.bodyUsed) await response.body?.cancel(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "control response and cleanup failed");
  return result;
}
// END request-owned fixture functions.

export function litellmDeadlineQualified(f) {
  // This is a post-join data-outcome disposition, not a cause classifier. A
  // concurrent read fault observed after the deadline can satisfy it too.
  const required=["workerOnly","uniqueBinding","deadlineBrand","callerUnaborted","prefix","pendingAtAbort","noEarlierFailure",
    "readReasonDefined","readAbortedAtSettle","observerSameReadReason","cancelSameSignalReason","receiverIdentity",
    "fetchFulfilled","cancelFulfilled","closedFulfilled","bodyUnlocked","otherOperationsFulfilled","sourceRetired","singleGet",
    "handler502","accountingZero"];
  return required.every(key=>f[key]===true) && f.observerFailures===0 && f.syncFailures===0 && f.rejected===2 && f.unlocks===1 &&
    [f.prefixSettled,f.readInvoked,f.abortObserved,f.readSettled,f.cancelInvoked,f.cancelSettled,f.closedSettled,f.unlockObserved].every(v=>Number.isSafeInteger(v)&&v>0) &&
    f.prefixSettled<f.readInvoked && f.readInvoked<f.abortObserved && f.abortObserved<f.readSettled && f.abortObserved<f.cancelInvoked &&
    Math.max(f.readSettled,f.cancelInvoked,f.cancelSettled,f.closedSettled)<f.unlockObserved;
}
export function litellmDeadlineWitness(s, InternalAbort, usage, charged) {
  const rejected=s.operations.filter(o=>o.state==="rejected"), reads=rejected.filter(o=>o.kind==="read"),
    read=reads.length===1?reads[0]:undefined, r=read?.reader, t=r?.transport;
  const observers=rejected.filter(o=>o.kind==="read_observer"&&o.originalRead===read?.pending&&o.reader===r);
  const observer=observers.length===1?observers[0]:undefined;
  const cancels=s.operations.filter(o=>o.kind==="cancel"&&o.reader===r), cancel=cancels.length===1?cancels[0]:undefined;
  const closed=s.operations.find(o=>o.kind==="closed"&&o.reader===r);
  const prefix=s.operations.find(o=>o.kind==="read"&&o.reader===r&&o.state==="fulfilled"&&o.value?.done===false&&o.value.value?.byteLength>0);
  const reason=t?.signal?.reason, cause=reason && typeof reason==="object"?Object.getOwnPropertyDescriptor(reason,"cause"):undefined;
  const source=s.source, event=usage?.events?.length===1?usage.events[0]:undefined;
  return {
    workerOnly:s.workerDeadline===true && s.mode==="deadline",
    uniqueBinding:!!r && s.readers.length===1 && s.readers[0]===r && s.inputs.length===1 && s.requests.length===1 && t===s.inputs[0] && t.request===s.requests[0].request && t.signal!==t.request.signal,
    deadlineBrand:reason instanceof InternalAbort && cause?.value==="deadline",
    callerUnaborted:!!t && !t.request.signal.aborted && t.callerAbortedAtAbort===false,
    prefix:!!prefix && r.eof===false,
    pendingAtAbort:!!read && read.signalAborted===false && t?.pendingAtAbort?.length===1 && t.pendingAtAbort[0]===read,
    noEarlierFailure:t?.noEarlierFailure===true,
    readReasonDefined:!!read && read.error!==undefined,
    readAbortedAtSettle:!!read && read.abortedAtSettle===true,
    readSameSignalReason:!!read && read.sameSignalReasonAtSettle===true && read.error===reason,
    observerSameReadReason:!!observer && !!read && observer.error===read.error,
    cancelSameSignalReason:!!cancel && cancel.operandPresent===true && cancel.reason===reason && cancel.signalAborted===true,
    receiverIdentity:!!r && r.unlockReceiver===true && s.operations.filter(o=>o.reader===r).every(o=>o.receiverIdentity===true),
    fetchFulfilled:!!t && s.operations.some(o=>o.kind==="fetch"&&o.transport===t&&o.state==="fulfilled"),
    cancelFulfilled:cancel?.state==="fulfilled",closedFulfilled:closed?.state==="fulfilled",bodyUnlocked:r?.body?.locked===false,
    otherOperationsFulfilled:!!read&&!!observer&&s.operations.every(o=>o===read||o===observer||o.state==="fulfilled"),
    sourceRetired:!!source&&source.active===0&&source.canceled===1&&source.finished===1&&source.expired===0&&source.operations.every(o=>o.state==="fulfilled"),
    singleGet:s.calls.length===1&&s.calls[0].method==="GET"&&s.calls[0].body===false&&s.calls[0].extra===false&&s.calls[0].authorization==="Bearer fixture-upstream-"+s.id&&s.calls[0].redirect==="manual"&&s.calls[0].url==="https://gateway.example/team/v1/models"&&source?.calls?.length===1&&source.calls[0].method==="GET"&&source.calls[0].url==="https://gateway.example/team/v1/models"&&source.calls[0].body===null,
    handler502:s.operations.filter(o=>o.kind==="handler").length===1&&s.operations.find(o=>o.kind==="handler")?.value?.status===502,
    accountingZero:charged===0&&!!event&&event.provider==="litellm"&&event.policy_id===s.id&&event.credential_id===s.id&&event.capability==="models.list"&&event.model===null&&event.actual_cost_micros===0&&event.reserved_cost_micros===0&&event.input_tokens===null&&event.output_tokens===null&&event.total_tokens===null&&event.status_code===502&&event.status==="timeout",
    observerFailures:s.observerFailures.length,syncFailures:s.failures.length,rejected:rejected.length,unlocks:r?.unlocks??0,
    prefixSettled:prefix?.settle??null,readInvoked:read?.invoke??null,abortObserved:t?.abortSequence??null,
    readSettled:read?.settle??null,cancelInvoked:cancel?.invoke??null,cancelSettled:cancel?.settle??null,closedSettled:closed?.settle??null,unlockObserved:r?.unlockSequence??null,
    readOrdinal:read?.ordinal??null,observerOrdinal:observer?.ordinal??null
  };
}

export function routerFixture() {
  return String.raw`
import worker from './worker/index.ts';
import {AsyncLocalStorage} from 'node:async_hooks'; export * from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage,usageSnapshot} from './worker/ledgers.ts';
import {sha256Hex} from './worker/utils.ts';
import {InternalHttpAbort} from './worker/http-operation.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
${litellmPredicateFacts.toString()}
${litellmRequestScope.toString()}
${litellmPartialRole.toString()}
${litellmProducerRetired.toString()}
${litellmJoinedReadData.toString()}
${litellmRetirementSeal.toString()}
${litellmWorkerDrain.toString()}
${litellmWorkerSourceProof.toString()}
${litellmWorkerResource.toString()}
${litellmWorkerLedger.toString()}
${litellmHeldReady.toString()}
${observeLiteLLMOperation.toString()}
${collectLiteLLMOperations.toString()}
${litellmDeadlineQualified.toString()}
${litellmDeadlineWitness.toString()}
const rawFetch=globalThis.fetch, records=new Map(), requestScope=litellmRequestScope(new AsyncLocalStorage(),1);
const selected='tenant/private-alias', hidden='tenant/private-hidden';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const signalState=signal=>signal==null?null:signal.aborted;
const invoke=(r,kind,start,details)=>observeLiteLLMOperation(r,kind,start,details);
const observe=(r,p,kind,input,reader,details={})=>invoke(r,kind,()=>p,{input,reader,signal:input?.signal,...details});
function observation(r){
 const counts={};for(const op of r.operations){const key=op.kind+'_'+op.state;counts[key]=(counts[key]??0)+1;}
 return {checks:r.retireChecks?.snapshot()??null,ledger:litellmWorkerLedger(r,requestScope),operations:r.operations.length,counts,ingress:r.ingresses.map(signalState),
  readers:r.readers.map(reader=>({unlocks:reader.unlocks,locked:reader.body.locked})),
  inputs:r.inputs.map(input=>({signalAborted:signalState(input.signal)})),
  rejections:r.operations.filter(op=>op.state==='rejected').slice(0,8).map(op=>({kind:op.kind,invoke:op.invoke,settle:op.settle,defined:op.error!==undefined,signalAtInvoke:op.signalAborted??null,signalAtSettlement:op.abortedAtSettle??null,sameSignalReason:op.sameSignalReasonAtSettle??false,
   sameClosedReason:r.operations.some(other=>other.reader&&other.reader===op.reader&&other.kind==='closed'&&other.state==='rejected'&&other.error===op.error),
   sameReadReason:r.operations.some(other=>other!==op&&other.reader&&other.reader===op.reader&&other.kind==='read'&&other.state==='rejected'&&other.error===op.error)})),
  syncFailures:r.failures.length};
}
function observeBody(r,response,input){
 const body=requestScope.response(input,response);input.response=response;
 if(!body)return;
 r.bodies.push(body);const get=body.getReader,cancel=body.cancel;
 const check=fn=>{try{fn();}catch(error){r.observerFailures.push(error);}};
 body.cancel=function(...args){check(()=>requestScope.body(input,this,body,'cancel'));return invoke(r,'body_cancel',()=>Reflect.apply(cancel,this,args),{input});};
 body.getReader=function(...args){
  check(()=>requestScope.body(input,this,body));
  let reader;try{reader=Reflect.apply(get,this,args);}catch(error){r.failures.push(error);throw error;}
  const info={body,reader,response,transport:input,unlocks:0,eof:false};check(()=>{info.id=requestScope.reader(input,body,reader);info.bound=requestScope.owns(input,response,body,reader);});r.readers.push(info);
  const closed=reader.closed;info.closed=closed;info.methods={};info.wrappers={};
  observe(r,closed,'closed',input,info,{receiverIdentity:this===body});
  for(const name of ['read','cancel']){const original=reader[name];info.methods[name]=original;reader[name]=function(...values){
   check(()=>requestScope.operation(input,this,reader,name));
   const pending=invoke(r,name,()=>Reflect.apply(original,this,values),{reader:info,input,signal:input.signal,originalMethod:original,receiver:this,receiverIdentity:this===reader,argc:values.length,operandPresent:values.length>0,reason:values[0],signalAborted:input.signal?.aborted===true});
   if(name==='read')observe(r,pending.then(chunk=>{if(chunk.done)info.eof=true;}),'read_observer',input,info,{originalRead:pending,originalMethod:original,receiver:this,receiverIdentity:this===reader});
   return pending;
  };info.wrappers[name]=reader[name];}
  const unlock=reader.releaseLock;info.methods.unlock=unlock;reader.releaseLock=function(...values){info.unlockInvoke=++r.sequence;check(()=>requestScope.operation(input,this,reader,'unlock'));try{const value=Reflect.apply(unlock,this,values);info.unlocks++;info.unlockSequence=++r.sequence;info.unlockReceiver=this===reader;return value;}catch(error){r.failures.push(error);throw error;}};
  info.wrappers.unlock=reader.releaseLock;Object.freeze(info.methods);Object.freeze(info.wrappers);
  return reader;
 };
}
globalThis.fetch=function(input,init){
 const request=new Request(input,init),match=/^Bearer fixture-upstream-([a-z0-9_]+)(?:-rotated)?$/.exec(request.headers.get('authorization')??'');
 const r=match&&records.get(match[1]);if(!r)throw Error('unbound original upstream credential');
 const url=new URL(request.url);if(url.origin!=='https://gateway.example'||!url.pathname.startsWith(r.basePath+'/'))throw Error('unexpected original destination');
 r.calls.push({url:request.url,method:request.method,authorization:request.headers.get('authorization'),query:url.search,redirect:request.redirect,body:request.body!==null,extra:request.headers.has('x-api-key')||request.headers.has('x-upstream-url')});
 const owner=requestScope.transport(r,init&&Object.hasOwn(init,'signal')?init.signal:input instanceof Request?input.signal:null);r.inputs.push(owner);
 if(owner.signal){const aborted=()=>{owner.abortSequence=++r.sequence;owner.callerAbortedAtAbort=owner.request?.signal.aborted;owner.pendingAtAbort=r.operations.filter(op=>op.kind==='read'&&op.reader?.transport===owner&&op.state==='pending');owner.noEarlierFailure=r.failures.length===0&&r.observerFailures.length===0&&r.operations.every(op=>op.state!=='rejected'&&op.state!=='threw');};if(owner.signal.aborted)aborted();else owner.signal.addEventListener('abort',aborted,{once:true});}
 const p=invoke(r,'fetch',()=>Reflect.apply(rawFetch,this,[input,init]),{transport:owner});observe(r,p.then(response=>observeBody(r,response,owner)),'acquisition_observer',owner,undefined,{originalFetch:p});return p;
};
async function drain(r){return litellmWorkerDrain(r,requestScope,()=>litellmWorkerSourceProof(r,rawFetch));}
async function retireDeadline(r,bindings){
 await collectLiteLLMOperations(r);
 const failures=[];let usage;
 try{const response=await invoke(r,'control_fetch',()=>Reflect.apply(rawFetch,globalThis,['https://fixture.test/proof/'+r.id]));r.source=await invoke(r,'control_body',()=>response.json());}catch(error){failures.push(error);}
 try{usage=await invoke(r,'usage',()=>usageSnapshot(bindings,'fixture',r.id,{kind:'admin'}));}catch(error){failures.push(error);}
 await collectLiteLLMOperations(r);
 const charged=bodyBudgetCharged(),deadline=litellmDeadlineWitness(r,InternalHttpAbort,usage,charged),qualified=litellmDeadlineQualified(deadline);
 for(const op of r.operations)if(op.state!=='fulfilled'&&!(qualified&&(op.ordinal===deadline.readOrdinal||op.ordinal===deadline.observerOrdinal)))failures.push(op.error);
 failures.push(...r.failures,...r.observerFailures);
 for(const reader of r.readers)if(reader.unlocks!==1||reader.body.locked)failures.push(Error('original reader remained owned'));
 if(r.bodies.some(body=>body.locked))failures.push(Error('original body locked'));
 r.retirementFailures=failures;
 return {retired:failures.length===0&&qualified,deadline,charged,source:r.source??null,events:usage?.events??[],unlocked:r.readers.every(x=>x.unlocks===1&&!x.body.locked),operations:r.operations.map(op=>({kind:op.kind,state:op.state,ordinal:op.ordinal}))};
}
function policy(row){return {enabled:true,generation:'fixture',providers:[row.mode==='foreign'?'openai':'litellm'],models:row.unrestricted?null:['litellm/'+selected],tenantId:'fixture',monthlyBudgetMicros:100,budgetMode:'reserve',requestCostMicros:row.mode==='unpriced'?null:7,retainRequestContent:false,grantRouting:{environmentFallback:false}};}
export default {async fetch(request,bindings,context){
 const url=new URL(request.url);
 if(url.pathname==='/__litellm/setup'){
  const rows=await request.json();if(records.size)throw Error('fixture initialized twice');
  await authorityCall(bindings,'/policies/initialize-all',rows.map(row=>({policyId:row.id,policy:policy(row)})));
  const secretSha256=await sha256Hex('fixture-secret');
  await authorityCall(bindings,'/credentials/initialize-all',rows.map(row=>({credentialId:row.id,credential:{enabled:true,secretSha256,policyId:row.id,policyGeneration:'fixture'}})));
  await authorityCall(bindings,'/connections/initialize-all',[{providerId:'litellm',enabled:true}]);
  for(const row of rows){const r={...row,basePath:row.basePath??'/team/v1',sequence:0,inputs:[],ingresses:[],operations:[],roots:[],observerFailures:[],calls:[],readers:[],bodies:[],failures:[],requests:[],policy:policy(row)};records.set(row.id,r);
   if(row.mode!=='missing')await putGrantCredentials(bindings,'oauth/'+row.id+'/litellm',{provider:row.mode==='invalid_owner'?'openai':'litellm',kind:'api_key',enabled:true,credential:'fixture-upstream-'+row.id});}
  return Response.json({ready:true});
 }
 const control=/^\/__litellm\/(observation|retire|usage|started|release|narrow|broaden|revoke|rotate|destination|disable)\/([a-z0-9_]+)$/.exec(url.pathname);
 if(control){const [,action,id]=control,r=records.get(id);if(!r)return new Response(null,{status:404});
  if(action==='observation')return Response.json(observation(r));
  if(action==='started'){const deadline=Date.now()+5000;while(!litellmHeldReady(r,requestScope)){if(Date.now()>=deadline)return new Response(null,{status:504});await scheduler.wait(10);}return Response.json({started:true});}
  if(action==='release')return Reflect.apply(rawFetch,globalThis,['https://fixture.test/release/'+id,{method:'POST'}]);
  if(action==='retire'){r.retireChecks??=litellmPredicateFacts();for(const q of r.requests)await r.retireChecks.wait(0,()=>q.promise);try{if(r.workerDeadline===true){r.retirement??=retireDeadline(r,bindings);return Response.json(await r.retirement);}const retirement=await drain(r);return Response.json({retired:true,source:retirement.source,dataDisposition:r.workerDataDisposition,calls:r.calls,operations:r.operations.map(x=>({kind:x.kind,state:x.state})),unlocked:r.readers.every(x=>x.unlocks===1&&!x.body.locked)});}finally{for(const q of r.requests)if(!q.retired){requestScope.retire(q.token);q.retired=true;}}}
  if(action==='usage'){await drain(r);return Response.json(await usageSnapshot(bindings,'fixture',id,{kind:'admin'}));}
  if(request.method!=='POST')return new Response(null,{status:405});
  if(action==='narrow'||action==='broaden'){r.policy={...r.policy,models:action==='narrow'?[]:null};await authorityCall(bindings,'/policies/put',{policyId:id,policy:r.policy});}
  else if(action==='revoke')await revokeGrantCredentials(bindings,'oauth/'+id+'/litellm');
  else if(action==='rotate')await putGrantCredentials(bindings,'oauth/'+id+'/litellm',{provider:'litellm',kind:'api_key',enabled:true,credential:'fixture-upstream-'+id+'-rotated'});
  else if(action==='destination')r.destinationFault=true;
  else {r.policy={...r.policy,enabled:false};await authorityCall(bindings,'/policies/put',{policyId:id,policy:r.policy});}
  return Response.json({changed:true});
 }
 const match=/^Bearer clawrouter-live-([a-z0-9_]+)-fixture-secret$/.exec(request.headers.get('authorization')??''),r=match&&records.get(match[1]);
 if(!r)return new Response(null,{status:401});
 r.ingresses.push(request.signal);const token=requestScope.register(request,r),returned={...deferred(),request,token};r.requests.push(returned);
 const env={...bindings,LITELLM_BASE_URL:'https://gateway.example'+r.basePath,LITELLM_API_KEY:'poison-environment',OPENAI_API_KEY:'poison-unrelated',LITELLM_MODEL:selected,USAGE_QUEUE:{send:event=>observe(r,ingestUsage(bindings,event),'usage_ingest')}};
 // Deliberately injected configuration-race control, not a deployed hot-reload claim.
 if(r.destinationFault){const namespace=env.GRANT_CREDENTIALS;env.GRANT_CREDENTIALS=new Proxy(namespace,{get(target,property){if(property==='get')return (...args)=>{const stub=Reflect.apply(target.get,target,args);return new Proxy(stub,{get(object,key){if(key==='fetch')return (...values)=>{if(new URL(values[0] instanceof Request?values[0].url:String(values[0])).pathname==='/inspect'){r.destinationFault=false;env.LITELLM_BASE_URL='https://foreign.example/v1';}return Reflect.apply(object.fetch,object,values);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
 try{return await invoke(r,'handler',()=>requestScope.invoke(token,worker.fetch,worker,[request,env,{waitUntil:p=>{observe(r,p,'wait_until',undefined,undefined,{token});context.waitUntil(p);}}]),{token});}finally{returned.resolve();}
}};`;
}

export function litellmObserveProducer(r, producer, kind, original, receiver, args) {
  const op={kind,state:"pending",producer};r.operations.push(op);let pending;
  try{pending=Reflect.apply(original,receiver,args);}catch(error){op.state="threw";op.error=error;throw error;}
  op.promise=pending;const observer=pending.then(()=>{op.state="fulfilled";},error=>{op.state="rejected";op.error=error;});r.observers.push(observer);op.observer=observer;
  const guard=observer.then(()=>undefined,error=>{r.observerFailures.push(error);});r.observers.push(guard);op.guard=guard;return pending;
}
export function litellmProducerOwners(r) {
  if(r.producers.length!==r.calls.length||r.operations.some(op=>!r.producers.includes(op.producer))||new Set(r.operations.map(op=>op.promise)).size!==r.operations.length||r.observers.length!==r.operations.length*2||new Set(r.observers).size!==r.observers.length)throw new Error("foreign producer ownership");
  return r.producers.map(producer=>{
    const index=r.calls.indexOf(producer.call),ops=r.operations.filter(op=>op.producer===producer),cancels=ops.filter(op=>op.kind==="cancel");
    if(index<0||r.producers.filter(p=>p.call===producer.call).length!==1||ops.some(op=>!r.observers.includes(op.observer)||!r.observers.includes(op.guard)))throw new Error("unbound producer observation");
    return {call:index,held:producer.held,chat:producer.chat,finished:producer.finished,eof:producer.eof,cancels:cancels.length,fulfilledCancels:cancels.filter(op=>op.state==="fulfilled").length,operations:ops.length,observers:ops.length*2};
  });
}
export async function joinLiteLLMProducer(r) {
  let at=0, observed=0;
  while(at<r.operations.length||observed<r.observers.length) {
    const originals=r.operations.slice(at).map(op=>op.promise), observers=r.observers.slice(observed), batch=[...originals,...observers];
    at=r.operations.length;observed=r.observers.length;const outcomes=await Promise.allSettled(batch);
    r.reportedObserverFailures??=new Set();
    for(let i=0;i<observers.length;i++)if(outcomes[originals.length+i].status==="rejected"&&!r.reportedObserverFailures.has(observers[i])){r.reportedObserverFailures.add(observers[i]);r.observerFailures.push(outcomes[originals.length+i].reason);}
  }
  return [1,r.operations.length,r.observers.length,r.operations.filter(op=>op.state!=="fulfilled").length+r.observerFailures.length];
}
export function upstreamFixture() {
  return String.raw`
${joinLiteLLMProducer.toString()}
${litellmObserveProducer.toString()}
${litellmProducerOwners.toString()}
const rows=new Map(),encoder=new TextEncoder();
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
export default {async fetch(request){
 const u=new URL(request.url);
 if(u.origin==='https://fixture.test'){
  if(u.pathname==='/setup'){for(const row of await request.json())rows.set(row.id,{...row,calls:[],active:0,canceled:0,aborted:0,expired:0,finished:0,release:false,operations:[],observers:[],observerFailures:[],producers:[]});return Response.json({ready:true});}
  const m=/^\/(release|state|started|proof)\/([a-z0-9_]+)$/.exec(u.pathname);if(!m||!rows.has(m[2]))return new Response(null,{status:404});const r=rows.get(m[2]);
  if(m[1]==='release')r.release=true;
  if(m[1]==='proof'){const joined=await joinLiteLLMProducer(r);return Response.json({owners:r.mode==='partial_abort'?litellmProducerOwners(r):null,released:r.release,calls:r.calls,active:r.active,canceled:r.canceled,aborted:r.aborted,expired:r.expired,finished:r.finished,operations:r.operations.map(op=>({kind:op.kind,state:op.state})),joined});}
  if(m[1]==='started'){const deadline=Date.now()+5000;while(r.calls.length===0){if(Date.now()>=deadline)return new Response(null,{status:504});await scheduler.wait(10);}}
  return Response.json({calls:r.calls,active:r.active,canceled:r.canceled,aborted:r.aborted,expired:r.expired,finished:r.finished,producer:[r.operations.length,...['pending','fulfilled','rejected','threw'].map(state=>r.operations.filter(op=>op.state===state).length)]});
 }
 const id=/^Bearer fixture-upstream-([a-z0-9_]+)(?:-rotated)?$/.exec(request.headers.get('authorization')??'')?.[1],r=rows.get(id);
 if(!r)throw Error('unknown original upstream key');
 const body=request.body?await request.json():null,call={url:request.url,method:request.method,body,authorization:request.headers.get('authorization')};r.calls.push(call);
 const chat=u.pathname.endsWith('/chat/completions');
 if(r.mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.example/models'}});
 if(r.mode==='error401'||r.mode==='error403')return Response.json({error:{message:'synthetic upstream denial'}},{status:r.mode==='error401'?401:403});
 const items=r.mode==='empty'?[]:[{id:'tenant/private-alias',object:'model',owned_by:'synthetic-tenant',model_info:{input_cost_per_token:'unqualified-unit'}},{id:'tenant/private-hidden'}];
 let text=chat?frame({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content:'synthetic-answer'},finish_reason:null}]})
  +frame({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],...(r.mode==='measured'?{usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}:{})})+'data: [DONE]\n\n':JSON.stringify({object:'list',data:items});
 if(r.mode==='loose')text=JSON.stringify({data:items});if(r.mode==='array')text=JSON.stringify(items);if(r.mode==='wrong')text=JSON.stringify({object:'wrong',data:[]});if(r.mode==='badrow')text=JSON.stringify({object:'list',data:[{}]});
 if(r.mode==='malformed'&&!chat)text='{bad';if(r.mode==='truncated'&&!chat)text=text.slice(0,-4);if(r.mode==='oversized')text=JSON.stringify({object:'list',data:[{id:'x',padding:'x'.repeat(2*1024*1024)}]});
 if(chat&&r.mode==='provider_error')text=frame({error:{message:'synthetic provider failure'}});
 const held=r.mode==='held'||r.mode==='deadline'||chat&&r.mode==='partial_abort';let offset=0,waiting,stopped=false;const started=Date.now();
 const producer={call,request,held,chat,finished:false,eof:false};r.producers.push(producer);
 const abort=()=>{r.aborted++;};request.signal.addEventListener('abort',abort,{once:true});
 const finish=()=>{if(!stopped){stopped=true;producer.finished=true;r.finished++;request.signal.removeEventListener('abort',abort);}};
 const source={async pull(controller){
  r.active++;
  try{
   if(held&&offset>0&&!r.release){
    // The original request owns this native I/O. Cancellation joins the actual
    // pending wait; a fixture expiry is an independent failure, never an abort.
    waiting=scheduler.wait(20);await waiting;waiting=undefined;
    if(stopped)return;
    if(Date.now()-started>=(r.mode==='deadline'?35000:10000)){r.expired++;finish();controller.error(Error('fixture producer expired'));return;}
    controller.enqueue(encoder.encode(chat?': fixture heartbeat\n\n':' '));return;
   }
   if(offset===text.length){producer.eof=true;finish();controller.close();return;}
   const end=held&&offset===0?(chat?text.indexOf('\n\n')+4:1):Math.min(offset+4096,text.length);controller.enqueue(encoder.encode(text.slice(offset,end)));offset=end;
  }finally{r.active--;}
 },async cancel(){r.canceled++;finish();if(waiting)await waiting;}};
 for(const kind of ['pull','cancel']){const original=source[kind];source[kind]=function(...args){return litellmObserveProducer(r,producer,kind,original,this,args);};}
 const stream=new ReadableStream(source,{highWaterMark:0});
 return new Response(stream,{headers:{'content-type':chat?'text/event-stream':'application/json'}});
}};`;
}

export async function withGateway(rows, body, { basePath = "/team/v1", hotCache = false, evidence } = {}) {
  rows = rows.map(row => ({ ...row, basePath }));
  evidence?.stage(1);
  let directory;
  try { directory = await mkdtemp(join(tmpdir(), "clawrouter-litellm-")); }
  catch (error) { evidence?.failed(error); throw error; }
  const failures = []; let runtime;
  try {
    evidence?.stage(2);
    runtime = await startWorkerdFixture(directory, routerFixture(), upstreamFixture(), { directRouter: true, requestContext: true, hotCache, bindings: { LITELLM_BASE_URL: "https://gateway.example" + basePath, LITELLM_MODEL: selected, LITELLM_API_KEY: "poison-environment", OPENAI_API_KEY: "poison-unrelated" } });
    evidence?.stage(3);
    const origin = String(await runtime.unsafeGetDirectURL("router")).replace(/\/$/, "");
    evidence?.stage(4);
    const upstream = await runtime.getWorker("upstream");
    evidence?.stage(5);
    const upstreamSetup = await upstream.fetch("https://fixture.test/setup", { method: "POST", body: JSON.stringify(rows) });
    evidence?.stage(5, 1); assert.equal(upstreamSetup.status, 200);
    evidence?.stage(6);
    const setup = await fetch(origin + "/__litellm/setup", { method: "POST", body: JSON.stringify(rows) });
    evidence?.stage(7); assert.equal(setup.status, 200);
    evidence?.stage(8); await setup.json();
    const control = async (action, id) => { const response = await fetch(`${origin}/__litellm/${action}/${id}`, { method: ["retire", "usage", "observation"].includes(action) ? "GET" : "POST" }); return litellmControlResponse(response, action); };
    const proof = async id => litellmControlResponse(await upstream.fetch("https://fixture.test/proof/" + id), "proof");
    const state = async id => litellmControlResponse(await upstream.fetch("https://fixture.test/state/" + id), "state");
    const started = async id => { const r = await upstream.fetch("https://fixture.test/started/" + id); assert.equal(r.status, 200); return r.json(); };
    const release = async id => (await upstream.fetch("https://fixture.test/release/" + id, { method: "POST" })).json();
    await body({ origin, control, state, proof, release, started, call: (id, path = "/v1/native/litellm/models", init = {}) => fetch(origin + path, { ...init, headers: { authorization: "Bearer " + key(id), ...init.headers } }) });
  } catch (error) { evidence?.failed(error); failures.push(error); }
  evidence?.stage(23);
  try { await runtime?.dispose(); } catch (error) { evidence?.failed(error); failures.push(error); }
  evidence?.stage(24);
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { evidence?.failed(error); failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "gateway assertion and cleanup failed");
}

function registerTests() {
  function deadlineRecords(){
    class InternalAbort extends Error {cause="deadline";}
    const controller=new AbortController(),caller=new AbortController(),reason=new InternalAbort();controller.abort(reason);
    const request={signal:caller.signal},transport={signal:controller.signal,request,callerAbortedAtAbort:false,abortSequence:8,noEarlierFailure:true};
    const reader={body:{locked:false},transport,unlocks:1,eof:false,unlockSequence:14,unlockReceiver:true};
    const read={kind:"read",ordinal:3,reader,signal:controller.signal,receiverIdentity:true,signalAborted:false,state:"rejected",invoke:6,settle:10,error:reason,pending:Promise.resolve(),abortedAtSettle:true,sameSignalReasonAtSettle:true};
    const observer={kind:"read_observer",ordinal:4,reader,originalRead:read.pending,receiverIdentity:true,state:"rejected",error:reason,invoke:7,settle:11};
    const ops=[{kind:"fetch",ordinal:0,transport,state:"fulfilled"},
      {kind:"closed",ordinal:1,reader,receiverIdentity:true,state:"fulfilled",settle:12},
      {kind:"read",ordinal:2,reader,receiverIdentity:true,state:"fulfilled",settle:5,value:{done:false,value:new Uint8Array([1])}},read,observer,
      {kind:"cancel",ordinal:5,reader,receiverIdentity:true,operandPresent:true,reason,signalAborted:true,state:"fulfilled",invoke:9,settle:13},
      {kind:"handler",ordinal:6,state:"fulfilled",value:{status:502}}, {kind:"waitUntil",ordinal:7,state:"fulfilled"}];
    transport.pendingAtAbort=[read];
    const s={id:"fixture",workerDeadline:true,mode:"deadline",operations:ops,failures:[],observerFailures:[],readers:[reader],inputs:[transport],requests:[{request}],
      calls:[{method:"GET",url:"https://gateway.example/team/v1/models",body:false,extra:false,authorization:"Bearer fixture-upstream-fixture",redirect:"manual"}],
      source:{active:0,canceled:1,finished:1,expired:0,operations:[{kind:"pull",state:"fulfilled"},{kind:"cancel",state:"fulfilled"}],calls:[{method:"GET",url:"https://gateway.example/team/v1/models",body:null}]}};
    const usage={events:[{provider:"litellm",policy_id:"fixture",credential_id:"fixture",capability:"models.list",model:null,actual_cost_micros:0,reserved_cost_micros:0,input_tokens:null,output_tokens:null,total_tokens:null,status_code:502,status:"timeout"}]};
    return {s,InternalAbort,usage,charged:0,reader,transport,read,observer,caller,reason};
  }
  const counterfactuals={
    "SDK default strict":c=>{c.s.workerDeadline=false;},"nondeadline strict":c=>{c.s.mode="eof";},
    "undefined read":c=>{c.read.error=c.observer.error=undefined;},"unpaired read":c=>{c.read.error={};},"independent observer":c=>{c.observer.error={};},
    "caller abort":c=>{c.caller.abort();},"provider error":c=>{c.reason.cause="upstream";},"lookalike brand":c=>{Object.setPrototypeOf(c.reason,Error.prototype);},
    "no abort":c=>{c.transport.signal=new AbortController().signal;},"late abort":c=>{c.transport.abortSequence=15;},
    "not aborted at read rejection":c=>{c.read.abortedAtSettle=false;},"read rejection before observed deadline":c=>{c.read.settle=7;},
    "no pending read":c=>{c.transport.pendingAtAbort=[];},"already aborted at read":c=>{c.read.signalAborted=true;},"earlier failure":c=>{c.transport.noEarlierFailure=false;},
    "prefix missing":c=>{c.s.operations[2].value.value=new Uint8Array();},"prefix EOF":c=>{c.s.operations[2].value.done=true;},
    "wrong request":c=>{c.transport.request={signal:new AbortController().signal};},"ambiguous request":c=>{c.s.requests.push({});},
    "wrong receiver":c=>{c.read.receiverIdentity=false;},"wrong reader":c=>{c.read.reader={};},
    "cancel rejection undefined":c=>{c.s.operations[5].state="rejected";c.s.operations[5].error=undefined;},"cancel wrong reason":c=>{c.s.operations[5].reason={};},
    "cancel absent":c=>{c.s.operations.splice(5,1);},"cancel before abort":c=>{c.s.operations[5].invoke=7;},"closed rejection":c=>{c.s.operations[1].state="rejected";},
    "early unlock":c=>{c.reader.unlockSequence=10;},"duplicate unlock":c=>{c.reader.unlocks=2;},"locked body":c=>{c.reader.body.locked=true;},
    "waitUntil pending":c=>{c.s.operations[7].state="pending";},"control failure":c=>{c.s.operations.push({kind:"control_body",state:"rejected",error:undefined});},
    "synchronous undefined":c=>{c.s.failures.push(undefined);},"observer failure":c=>{c.s.observerFailures.push(undefined);},
    "producer unjoined":c=>{c.s.source.finished=0;},"source expiry":c=>{c.s.source.expired=1;},"source uncanceled":c=>{c.s.source.canceled=0;},
    "replay":c=>{c.s.source.calls.push(c.s.source.calls[0]);},"POST":c=>{c.s.calls[0].method="POST";},
    "capacity charge":c=>{c.charged=1;},"wrong accounting":c=>{c.usage.events[0].actual_cost_micros=7;},"wrong handler":c=>{c.s.operations[6].value.status=200;},
    "reserved cost":c=>{c.usage.events[0].reserved_cost_micros=7;},"wrong provider":c=>{c.usage.events[0].provider="other";},
    "wrong credential":c=>{c.usage.events[0].credential_id="other";},"wrong policy":c=>{c.usage.events[0].policy_id="other";},
    "wrong capability":c=>{c.usage.events[0].capability="llm.chat";},"model accounting":c=>{c.usage.events[0].model="other";},
    "missing accounting":c=>{c.usage.events=[];},"duplicate accounting":c=>{c.usage.events.push({...c.usage.events[0]});},
    "non-timeout accounting":c=>{c.usage.events[0].status="provider_error";},"wrong accounting status":c=>{c.usage.events[0].status_code=200;},
    ...Object.fromEntries(["input_tokens","output_tokens","total_tokens"].flatMap(field=>[
      [field+" counted",c=>{c.usage.events[0][field]=0;}],
      [field+" missing",c=>{delete c.usage.events[0][field];}]
    ]))
  };
  test("LiteLLM deadline classifier retains original rejected data outcomes",()=>{
    const c=deadlineRecords();assert.equal(litellmDeadlineQualified(litellmDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged)),true);
    const dataReason={};c.read.error=c.observer.error=dataReason;c.read.sameSignalReasonAtSettle=false;
    const witness=litellmDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged);
    assert.equal(litellmDeadlineQualified(witness),true);assert.equal(witness.readSameSignalReason,false);
    assert.notEqual(c.read.error,c.reason);assert.equal(c.observer.error,c.read.error);assert.equal(c.s.operations[5].reason,c.reason);
    assert.equal(c.read.state,"rejected");assert.equal(c.observer.state,"rejected");
  });
  Object.assign(counterfactuals,{
    "upstream cancel rejection":c=>{c.s.source.operations[1].state="rejected";},
    "upstream pull pending":c=>{c.s.source.operations[0].state="pending";},
    "upstream still active":c=>{c.s.source.active=1;},
    "failed fetch":c=>{c.s.operations[0].state="rejected";},
    "derived wrong original":c=>{c.observer.originalRead=Promise.resolve();},
    "derived wrong reader":c=>{c.observer.reader={};},
    "cancel missing operand":c=>{c.s.operations[5].operandPresent=false;},
    "unlock receiver":c=>{c.reader.unlockReceiver=false;},
  });
  for(const [name,mutate] of Object.entries(counterfactuals))test("LiteLLM deadline counterfactual rejects "+name,()=>{
    const c=deadlineRecords();mutate(c);assert.equal(litellmDeadlineQualified(litellmDeadlineWitness(c.s,c.InternalAbort,c.usage,c.charged)),false);
  });
  test("LiteLLM deadline observer preserves original promise, receiver and undefined failures",async()=>{
    const s={sequence:0,operations:[],roots:[],failures:[],observerFailures:[]},receiver={};let finish;
    const original=new Promise(resolve=>{finish=resolve;});const args=[{}];
    function read(...actual){assert.equal(this,receiver);assert.equal(actual[0],args[0]);return original;}
    const result=observeLiteLLMOperation(s,"read",()=>Reflect.apply(read,receiver,args));assert.equal(result,original);
    let settled=false;const joined=collectLiteLLMOperations(s).then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);finish({done:true});await joined;
    let caught=false;try{observeLiteLLMOperation(s,"cancel",()=>{throw undefined;});}catch(error){caught=true;assert.equal(error,undefined);}assert.equal(caught,true);assert.deepEqual(s.failures,[undefined]);
    const rejected=Promise.reject(undefined);assert.equal(observeLiteLLMOperation(s,"cancel",()=>rejected),rejected);await collectLiteLLMOperations(s);assert.equal(s.operations.at(-1).state,"rejected");assert.equal(s.operations.at(-1).error,undefined);
  });

  test("LiteLLM shipping declaration preserves first capabilities, opaque card and unknown price", () => {
    assert.equal(provider.capabilities.find(x => x.id === "models.list").endpoint, "models_list");
    assert.equal(provider.capabilities.find(x => x.id === "llm.chat").endpoint, "chat_completions");
    assert.deepEqual(provider.models.map(x => [x.id, x.upstream, x.pricing]), [["litellm/configured", "${model}", null]]);
    for (const [id, path, upstream] of [["models_list", "/models", null], ["models_list_v1", "/v1/models", "/models"], ["chat_completions_v1", "/v1/chat/completions", "/chat/completions"]]) {
      const endpoint = provider.endpoints.find(x => x.id === id); assert.equal(endpoint.path, path); assert.equal(endpoint.upstreamPath ?? null, upstream);
    }
  });
  test("original operation drain joins late work and retains undefined independently", async () => {
    let done; const held = new Promise(resolve => { done = resolve; }); const entries = [{ promise: Promise.resolve().then(() => { entries.push({ promise: held }); }) }, { promise: Promise.reject(undefined) }];
    const observed = joinOriginalOperations(entries).then(() => ({ ok: true }), error => ({ error })); let ended = false; void observed.then(() => { ended = true; }); await Promise.resolve(); assert.equal(ended, false); done();
    const result = await observed; assert.deepEqual(result.error.errors, [undefined]);
  });
  test("real metadata policy refresh, owner rotation and override denial", { timeout: 120000 }, async t => {
    const rows = [];
    for (const route of ["native", "manifest"]) for (const action of ["narrow", "broaden", "revoke", "rotate", "destination", "query", "body", "method"]) rows.push({ id: route + "_" + action, mode: ["narrow", "broaden", "revoke"].includes(action) ? "held" : "table", action, route });
    await withGateway(rows, async f => {
      for (const row of rows) await t.test(row.id, async () => {
        const path = row.route === "native" ? "/v1/native/litellm/models" : "/v1/proxy/litellm/models_list";
        if (["query", "body", "method"].includes(row.action)) {
          const response = await f.call(row.id, path + (row.action === "query" ? "?url=https://foreign.example" : ""), row.action === "query" ? {} : { method: "POST", ...(row.action === "body" ? { body: JSON.stringify(row.route === "manifest" ? { body: { url: "https://foreign.example" } } : { url: "https://foreign.example" }) } : {}) });
          await response.arrayBuffer(); assert.ok(response.status >= 400); assert.equal((await f.state(row.id)).calls.length, 0);
        } else if (["narrow", "broaden", "revoke"].includes(row.action)) {
          const pending = f.call(row.id, path); const observed = pending.then(value => ({ value }), error => ({ error }));
          try { await f.started(row.id); await f.control(row.action, row.id); } finally { await f.release(row.id); }
          const outcome = await observed; if ("error" in outcome) throw outcome.error;
          const result = await outcome.value.json();
          if (row.action === "revoke") assert.ok(outcome.value.status >= 400);
          else { assert.equal(outcome.value.status, 200); assert.deepEqual(result.data, row.action === "narrow" ? [] : [catalogRow]); }
          assert.equal((await f.state(row.id)).calls.length, 1);
        } else {
          const warm = await f.call(row.id, path); assert.equal(warm.status, 200); await warm.arrayBuffer();
          // Consume the original first response before changing the same owner.
          await f.control("retire", row.id);
          await f.control(row.action, row.id);
          const next = await f.call(row.id, path); await next.arrayBuffer();
          if (row.action === "destination") { assert.ok(next.status >= 400); assert.equal((await f.state(row.id)).calls.length, 1); }
          else { assert.equal(next.status, 200); assert.equal((await f.state(row.id)).calls.at(-1).authorization, "Bearer fixture-upstream-" + row.id + "-rotated"); }
        }
        assert.equal((await f.control("retire", row.id)).retired, true);
        const state = await f.state(row.id); assert.equal(state.active, 0); assert.equal(state.expired, 0);
      });
    });
  });
  test("configured gateway suffixes remain original and native inference uses SQLite receipts", { timeout: 120000 }, async t => {
    for (const [index, basePath] of ["", "/team", "/team/v1"].entries()) await t.test("base" + index, async () => {
      const id = "base" + index;
      await withGateway([{ id, mode: "measured", unrestricted: true }], async f => {
        const models = await f.call(id); assert.equal(models.status, 200); await models.json();
        const response = await f.call(id, "/v1/native/litellm/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: selected, messages: [{ role: "user", content: "synthetic fixture" }], stream: true }) });
        assert.equal(response.status, 200); assert.match(await response.text(), /synthetic-answer/);
        const proof = await f.control("retire", id); assert.equal(proof.retired, true);
        assert.deepEqual(proof.calls.map(call => call.url), ["https://gateway.example" + basePath + "/models", "https://gateway.example" + basePath + "/chat/completions"]);
        const usage = await f.control("usage", id); assert.equal(usage.events.length, 2);
        const metadata = usage.events.find(event => event.reserved_cost_micros === 0); assert.equal(metadata.actual_cost_micros, 0);
        const event = usage.events.find(event => event.reserved_cost_micros === 7); assert.equal(event.actual_cost_micros, 7); assert.equal(event.reserved_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
        assert.equal(event.input_tokens, 4); assert.equal(event.output_tokens, 3);
      }, { basePath });
    });
  });
  test("original metadata caller abort retains strict acquisition and retirement outcomes", { timeout: 15000 }, async t => {
    const evidence = workerAbortEvidence(); let failed = false, primary;
    try { await withGateway([{ id: "native_abort", mode: "held" }], async f => {
      const controller = new AbortController();
      evidence.stage(9);
      const pending = f.call("native_abort", undefined, { signal: controller.signal });
      evidence.stage(9, 1);
      const result = pending.then(value => ({ value }), error => ({ error }));
      evidence.stage(10); await f.started("native_abort");
      evidence.stage(11); controller.abort();
      evidence.stage(12); const outcome = await result;
      assert.ok("error" in outcome);
      evidence.stage(13); assert.equal(controller.signal.aborted, true);
      let proof;
      evidence.stage(14);
      try { proof = await f.control("retire", "native_abort"); }
      catch (error) {
        evidence.failed(error);
        const reports = await Promise.allSettled([f.control("observation", "native_abort"), f.state("native_abort")]);
        evidence.observation(15, reports[0]); evidence.observation(16, reports[1]);
        const failures = [error, ...reports.filter(report => report.status === "rejected").map(report => report.reason)];
        if (reports.every(report => report.status === "fulfilled")) {
          const [observed, state] = reports.map(report => report.value);
          try { t.diagnostic(JSON.stringify({ worker: observed, upstream: { calls: state.calls.length, active: state.active, canceled: state.canceled, aborted: state.aborted, expired: state.expired, finished: state.finished } })); }
          catch (reportingError) { failures.push(reportingError); }
        }
        if (failures.length > 1) throw new AggregateError(failures, "original failure and observation failure");
        throw error;
      }
      evidence.stage(17); assert.equal(proof.retired, true);
      evidence.stage(18); const state = await f.state("native_abort");
      evidence.stage(19); assert.equal(state.calls.length, 1);
      evidence.stage(20); assert.equal(state.canceled, 1);
      evidence.stage(21); assert.equal(state.active, 0);
      evidence.stage(22); assert.equal(state.expired, 0);
    }, { evidence }); } catch (error) { failed = true; primary = error; }
    const reporting = evidence.report(t);
    if (failed && reporting.length === 0) throw primary;
    if (failed || reporting.length) throw new AggregateError([...(failed ? [primary] : []), ...reporting], "original failure and diagnostic reporting failure");
  });
  test("shipping 30000ms metadata deadline cancels without paid replay", { timeout: 45000 }, async t => {
    await withGateway([{ id: "native_deadline", mode: "deadline", workerDeadline: true }], async f => {
      const response = await f.call("native_deadline"); const body = await response.json();
      assert.equal(response.status, 502);
      assert.deepEqual(body, { error: { code: "provider_unavailable", message: "upstream request to provider litellm failed" } });
      const proof = await f.control("retire", "native_deadline");
      t.diagnostic(JSON.stringify({ deadline: proof.deadline, retired: proof.retired, charged: proof.charged, upstream: proof.source && { active: proof.source.active, canceled: proof.source.canceled, expired: proof.source.expired, finished: proof.source.finished } }));
      assert.equal(proof.retired, true); assert.equal(litellmDeadlineQualified(proof.deadline), true); assert.equal(proof.unlocked, true);
      assert.deepEqual(proof.operations.filter(op=>op.state!=="fulfilled").map(op=>[op.ordinal,op.kind,op.state]),[
        [proof.deadline.readOrdinal,"read","rejected"],[proof.deadline.observerOrdinal,"read_observer","rejected"]]);
      assert.equal(proof.charged, 0); assert.equal(proof.source.calls.length, 1); assert.equal(proof.source.calls[0].method, "GET");
      assert.equal(proof.source.canceled, 1); assert.equal(proof.source.active, 0); assert.equal(proof.source.expired, 0); assert.equal(proof.source.finished, 1);
      assert.ok(proof.source.operations.every(op=>op.state==="fulfilled"));assert.equal(proof.events.length,1);
    });
  });
  test("shipping LiteLLM HTTP/SQLite checks complete catalog envelopes, original grants and literal aliases", { timeout: 120000 }, async t => {
    const rows = []; for (const route of ["native", "manifest", "versioned"]) for (const mode of ["table", "empty", "loose", "array", "wrong", "badrow", "missing", "foreign", "invalid_owner", "malformed", "truncated", "oversized", "error401", "error403", "redirect"]) rows.push({ id: route + "_" + mode, mode });
    await withGateway(rows, async f => {
      for (const row of rows) await t.test(row.id, async () => {
        const path = row.id.startsWith("manifest") ? "/v1/proxy/litellm/models_list" : row.id.startsWith("versioned") ? "/v1/native/litellm/v1/models" : "/v1/native/litellm/models";
        const response = await f.call(row.id, path, { headers: { "x-api-key": "poison-caller", "x-upstream-url": "https://foreign.example" } });
        const result = await response.json();
        if (["table", "empty"].includes(row.mode)) { assert.equal(response.status, 200, result.error?.code); assert.deepEqual(result, { object: "list", data: row.mode === "empty" ? [] : [catalogRow] }); }
        else assert.ok(response.status >= 400, row.id);
        const proof = await f.control("retire", row.id); assert.equal(proof.retired, true); assert.equal(proof.unlocked, true);
        const state = await f.state(row.id); assert.equal(state.expired, 0); assert.equal(state.active, 0);
        const denied = ["missing", "foreign", "invalid_owner"].includes(row.mode);
        assert.equal(state.calls.length, denied ? 0 : 1); assert.equal(proof.calls.length, denied ? 0 : 1);
        if (!denied) { const call = proof.calls[0]; assert.equal(call.url, `https://gateway.example/team/v1/models`); assert.equal(call.authorization, "Bearer fixture-upstream-" + row.id); assert.equal(call.method, "GET"); assert.equal(call.query, ""); assert.equal(call.body, false); assert.equal(call.extra, false); assert.equal(call.redirect, "manual"); }
        const usage = await f.control("usage", row.id); for (const event of usage.events) { assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0); }
      });
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) registerTests();
