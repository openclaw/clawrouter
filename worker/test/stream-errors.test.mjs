import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";


const { normalizePreStreamError, observeUsage } = await import("../proxy-response.ts");
const { HttpOperation } = await import("../http-operation.ts");
const encoder = new TextEncoder();

function chunkedSse(chunks, headers = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(encoder.encode(chunks[index++]));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } });
}

test("streaming pre-stream upstream errors preserve HTTP status in a JSON envelope", async () => {
  const response = await normalizePreStreamError(new Response('event: error\ndata: {"error":{"message":"invalid request","type":"invalid_request","code":400}}\n\n', {
    status: 400,
    headers: { "content-type": "text/event-stream", "retry-after": "17", "x-ratelimit-remaining": "0", "content-length": "999" },
  }), true);
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(response.headers.get("content-length"), null);
  assert.deepEqual(await response.json(), { error: { message: "invalid request", type: "invalid_request", code: 400 } });
});

test("HTTP 200 first-event SSE errors become mapped JSON failures", async () => {
  const response = await normalizePreStreamError(chunkedSse([
    'event: error\ndata: {"error":{"message":"invalid request","type":"invalid_request","code":400}}\n\n',
  ]), true);
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { error: { message: "invalid request", type: "invalid_request", code: 400 } });
});

test("unreadable known HTTP error details keep their generic envelope through the same operation observer", async () => {
  for (const status of [400, 429, 503]) for (const contentType of ["application/json", "text/event-stream"]) {
    const operation = new HttpOperation();
    operation.acceptRejection(status);
    const source = new Response(new ReadableStream({ pull() { throw new Error("fixture unreadable error details"); } }, { highWaterMark: 0 }), {
      status, headers: { "content-type": contentType, "retry-after": "17", "content-length": "999" },
    });
    const observed = observeUsage(await normalizePreStreamError(source, true, operation), operation, undefined, "openai.responses");
    const { response } = observed;
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: { message: "upstream request failed", type: "upstream_error", code: status } });
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(source.body.locked, false);
    assert.equal((await observed.result).delivery, "complete");
    assert.equal(operation.status, status < 500 ? "client_error" : "provider_error");
    assert.equal(operation.signal.aborted, false);
  }
});

test("HTTP 200 first-event read failure remains exceptional", async () => {
  const operation = new HttpOperation();
  const failure = new Error("fixture first-event read failure");
  const source = new Response(new ReadableStream({ pull() { throw failure; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(normalizePreStreamError(source, true, operation), error => error === failure);
  assert.equal(source.body.locked, false);
  assert.equal(operation.signal.reason, failure);
  assert.equal(operation.status, "provider_error");
});

test("leading SSE comments and empty blocks do not hide a first error event", async () => {
  const response = await normalizePreStreamError(chunkedSse([
    ': ping\r\n\r\n\n\nevent: error\n\n: still here\n\ndata: {"error":{"message":"bad model","type":"invalid_request","code":422}}\n\n',
  ]), true);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: { message: "bad model", type: "invalid_request", code: 422 } });
});

test("CR-only and mixed SSE line endings still expose first-event errors", async () => {
  const crOnly = await normalizePreStreamError(chunkedSse([
    'event: error\rdata: {"error":{"message":"CR error","code":400}}\r\r',
  ]), true);
  assert.equal(crOnly.status, 400);
  assert.deepEqual(await crOnly.json(), { error: { message: "CR error", type: "upstream_error", code: 400 } });

  const mixed = await normalizePreStreamError(chunkedSse([
    ': ping\r\n\revent: error\ndata: {"error":{"message":"mixed error","code":409}}\r\n\r',
  ]), true);
  assert.equal(mixed.status, 409);
  assert.deepEqual(await mixed.json(), { error: { message: "mixed error", type: "upstream_error", code: 409 } });
});

test("non-2xx SSE skips comment heartbeats and preserves multiline structured errors", async () => {
  const response = await normalizePreStreamError(new Response(': ping\n\nevent: error\r\ndata: {"error":\r\ndata: {"message":"quota","type":"rate_limit","code":"insufficient_quota"}}\r\n\r\n', {
    status: 429,
    headers: { "content-type": "text/event-stream" },
  }), true);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { message: "quota", type: "rate_limit", code: "insufficient_quota" } });
});

test("non-2xx SSE maps its first error event without waiting for stream close", async () => {
  let cancelled = false;
  const source = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: error\ndata: {"error":{"message":"quota now","type":"rate_limit","code":"insufficient_quota"}}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { status: 429, headers: { "content-type": "text/event-stream" } });
  let timeout;
  const response = await Promise.race([
    normalizePreStreamError(source, true),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("normalization waited for SSE close")), 250); }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(response.status, 429);
  assert.equal(cancelled, true);
  assert.deepEqual(await response.json(), { error: { message: "quota now", type: "rate_limit", code: "insufficient_quota" } });
});

test("an empty data message makes a later SSE error mid-stream", async () => {
  const body = 'data:\n\nevent: error\ndata: {"error":{"message":"later","code":400}}\n\n';
  const response = await normalizePreStreamError(chunkedSse([body]), true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
});

test("healthy SSE streams pass through byte-identically across split first-event chunks", async () => {
  const chunks = [
    'data: {"choices":[{"del',
    'ta":{"content":"hi"}}]}\r',
    '\n\r\n',
    'event: error\ndata: {"error":{"message":"later","code":502}}\n\n',
  ];
  const expected = Buffer.from(chunks.join(""));
  const response = await normalizePreStreamError(chunkedSse(chunks), true);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
});

test("mid-stream SSE error events remain HTTP 200 event streams", async () => {
  const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\nevent: error\ndata: {"error":{"message":"provider disconnected","code":502}}\n\n';
  const source = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const response = await normalizePreStreamError(source, true);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(await response.text(), body);
});

test("first-event error codes outside HTTP error range map to 502", async () => {
  const response = await normalizePreStreamError(chunkedSse([
    'data: {"error":{"message":"invalid status","type":"upstream_error","code":200}}\n\n',
  ]), true);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { message: "invalid status", type: "upstream_error", code: 200 } });
});

test("oversized first SSE events pass through byte-identically", async () => {
  const body = `data: ${"x".repeat(8 * 1024)}\n\nevent: error\ndata: {"error":{"message":"later","code":400}}\n\n`;
  const source = chunkedSse([body.slice(0, 3_000), body.slice(3_000, 7_000), body.slice(7_000)]);
  const response = await normalizePreStreamError(source, true);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(body));
});

test("non-stream upstream errors pass through unchanged", async () => {
  const source = Response.json({ error: { message: "invalid request", type: "invalid_request", code: 400 } }, { status: 400 });
  const response = await normalizePreStreamError(source, false);
  assert.equal(response, source);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: "invalid request", type: "invalid_request", code: 400 } });
});

// BEGIN inert replay owner tests.
function inertReplayFunctions() {
  const source = readFileSync(new URL("../proxy-response.ts", import.meta.url), "utf8");
  const input = readFileSync(new URL("../input-retirement.ts", import.meta.url), "utf8").replaceAll("export ", "");
  const replay = source.slice(source.indexOf("const replayRetirements ="), source.indexOf("export interface SseBoundaryCursor"));
  class InertStream { constructor(source, strategy) { this.source = source; this.strategy = strategy; } }
  class InertResponse { constructor(body, init) { this.body = body; Object.assign(this, init); } }
  return new Function("ReadableStream", "Response", stripTypeScriptTypes(input + replay, {mode:"transform"}) + ";return {replayInputOwner,replayResponse,replayRetirements};")(InertStream, InertResponse);
}
const replayDeferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const replayTurns = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
for (const readRejects of [false,true]) for (const cancelRejects of [false,true]) test(`inert replay joins original read and cancellation ${readRejects}/${cancelRejects}`,async()=>{
  const {replayResponse,replayRetirements}=inertReplayFunctions(), read=replayDeferred(), cancel=replayDeferred();
  let unlocks=0,cancels=0,settled=false;const reason={},bytes={};
  const reader={read(){assert.equal(this,reader);return read.promise;},cancel(value){assert.equal(this,reader);assert.equal(value,reason);cancels++;return cancel.promise;},releaseLock(){assert.equal(this,reader);unlocks++;}};
  const response=replayResponse({body:{},status:200,statusText:"OK",headers:{}},reader,[],false);
  const controller={enqueue(){assert.fail("late data");},close(){assert.fail("late close");},error(){assert.fail("late error");}};
  const pulling=response.body.source.pull(controller), retiring=response.body.source.cancel(reason);
  retiring.then(()=>{settled=true;});
  assert.equal(response.body.source.cancel({}),retiring);assert.equal(cancels,1);assert.equal(unlocks,0);
  if(cancelRejects)cancel.reject(undefined);else cancel.resolve();await replayTurns();assert.equal(unlocks,0);assert.equal(settled,false);
  if(readRejects)read.reject(undefined);else read.resolve({done:false,value:bytes});
  await pulling;await retiring;await replayRetirements.get(response.body);assert.equal(unlocks,1);assert.equal(settled,true);
});
test("inert replay keeps synchronous undefined and independent source release failures",async()=>{
  const {replayInputOwner}=inertReplayFunctions(), predecessor=replayDeferred();let unlocks=0,nested;
  const owner=replayInputOwner({cancel(){nested=owner.retire("cancel");throw undefined;},releaseLock(){unlocks++;throw undefined;}},predecessor.promise);
  const retiring=owner.retire("cancel");const caught=retiring.then(()=>assert.fail("failure lost"),error=>error);
  assert.equal(retiring,nested);await replayTurns();assert.equal(unlocks,0);predecessor.reject(undefined);
  const error=await caught;assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[undefined,undefined,undefined]);assert.equal(unlocks,1);
});
test("inert replay preserves original read and independent release undefined",async()=>{
  const {replayResponse}=inertReplayFunctions();let errorPresent=false,reported,unlocks=0;
  const response=replayResponse({body:{},status:200,headers:{}},{read(){throw undefined;},cancel(){assert.fail();},releaseLock(){unlocks++;throw undefined;}},[],false);
  await response.body.source.pull({error(error){errorPresent=true;reported=error;},close(){assert.fail();}});
  assert.equal(errorPresent,true);assert.ok(reported instanceof AggregateError);assert.deepEqual(reported.errors,[undefined,undefined]);assert.equal(unlocks,1);
});
test("inert replay preserves bytes metadata EOF and single release",async()=>{
  const {replayResponse,replayRetirements}=inertReplayFunctions(), bytes={},headers={},delivered=[];let reads=0,unlocks=0,closed=0;
  const response=replayResponse({body:{},status:429,statusText:"Held",headers},{read(){reads++;return Promise.resolve({done:true});},cancel(){assert.fail();},releaseLock(){unlocks++;}},[bytes],false);
  const c={enqueue(v){delivered.push(v);},close(){closed++;},error(){assert.fail();}};
  await response.body.source.pull(c);await response.body.source.pull(c);await replayRetirements.get(response.body);
  assert.equal(delivered[0],bytes);assert.equal(response.headers,headers);assert.equal(response.status,429);assert.equal(response.statusText,"Held");assert.equal(reads,1);assert.equal(closed,1);assert.equal(unlocks,1);
});
// END inert replay owner tests.
