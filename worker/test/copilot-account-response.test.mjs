import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { once, getEventListeners } from "node:events";
import { HttpOperation } from "../http-operation.ts";
import { readCopilotAccountResponse } from "../copilot-account-response.ts";
import { consumeCopilotResponse } from "../copilot-response-stream.ts";

const failure = { message: "invalid_copilot_response_body" };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let server, origin;
before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.test"), mode = url.pathname;
    response.setHeader("content-type", url.searchParams.get("mime") ?? "application/json; charset=utf-8");
    if (url.searchParams.has("encoding")) response.setHeader("content-encoding", url.searchParams.get("encoding"));
    if (url.searchParams.has("range")) response.setHeader("content-range", "bytes 0-1/2");
    response.statusCode = Number(url.searchParams.get("status") ?? 200);
    if (mode === "/redirect") { response.writeHead(302, { location: "/json" }); response.end("{}"); return; }
    if (mode === "/stall") { response.write(" "); return; }
    if (mode === "/truncated") { response.setHeader("content-length", "50"); response.setHeader("connection", "close"); response.end("{}"); return; }
    if (mode === "/utf8") { response.end(Buffer.from([123,34,120,34,58,34,0xed,0xa0,0x80,34,125])); return; }
    const prefix = '{"endpoints":{"api":"https://foreign.example/base/"},"ignored":"';
    const size = Number(url.searchParams.get("bytes") ?? 0);
    const text = mode === "/sized" ? prefix + "x".repeat(size - Buffer.byteLength(prefix + '"}')) + '"}'
      : mode === "/fragmented" ? '{"endpoints":{"api":"é🦊/\\ud800"},"ignored":"' + "x".repeat(40000) + '"}'
      : mode === "/malformed" ? '{"endpoints":{"api":"x"},"tail":['
      : mode === "/empty" ? "" : '{"endpoints":{"api":"original"}}';
    if (url.searchParams.has("chunked")) response.setHeader("transfer-encoding", "chunked");
    response.end(text);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const fetched = (path = "/json") => fetch(origin + path, { redirect: "manual" });
async function read(response, operation = new HttpOperation(), expectedUrl = response.url) {
  try { return await readCopilotAccountResponse(response, { operation, expectedUrl }); }
  finally { operation.stop("complete"); }
}
function instrument(response, wrap) {
  const getReader = response.body.getReader.bind(response.body);
  response.body.getReader = options => wrap(getReader(options));
}

for (const status of [200,201,202,206,299]) test(`actual Node account status ${status} follows Response.ok without origin qualification`, async () => {
  const result = await read(await fetched(`/json?status=${status}`));
  assert.deepEqual(result, { endpoints: { api: "original" } }); assert.ok(Object.isFrozen(result.endpoints));
});

test("actual Node fetched bytes preserve fragmented UTF-8/escapes and reuse returned backing", async () => {
  const response = await fetched("/fragmented"); let previous, reads = 0;
  instrument(response, reader => ({
    async read(view) {
      if (previous) { assert.equal(view.buffer, previous.buffer); previous.fill(0xff); }
      assert.equal(view.byteLength, 16384); reads++;
      const next = await reader.read(view);
      if (next.value) { assert.ok(next.value.buffer.byteLength <= 16384); previous = next.value; }
      return next;
    }, cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  assert.deepEqual(await read(response), { endpoints: { api: "é🦊/\ud800" } });
  assert.ok(reads >= 4); assert.equal(response.body.locked, false);
});

test("16 MiB cumulative wire succeeds; declared and chunked overflow deny atomically", async () => {
  const cap = 16 * 1024 * 1024;
  assert.deepEqual(await read(await fetched(`/sized?bytes=${cap}`)), { endpoints: { api: "https://foreign.example/base/" } });
  for (const suffix of ["", "&chunked=1"]) {
    const response = await fetched(`/sized?bytes=${cap + 1}${suffix}`);
    await assert.rejects(read(response), failure); assert.equal(response.body.locked, false);
  }
});

test("actual URL, redirect, range, encoding, MIME and status admission are strict", async () => {
  await assert.rejects(read(new Response("{}", { headers: { "content-type": "application/json" } })), failure);
  await assert.rejects(read(await fetched(), new HttpOperation(), origin + "/wrong"), failure);
  await assert.rejects(read(await fetched(), new HttpOperation(), ""), failure);
  for (const path of ["/redirect", "/json?status=300", "/json?status=401", "/json?status=500", "/json?status=206&range=1",
    "/json?encoding=br", "/json?mime=text/plain", "/json?mime=application/json;charset=latin1", "/json?mime=application/json;extra=x"]) {
    const response = await fetched(path); await assert.rejects(read(response), failure); assert.equal(response.body.locked, false);
  }
  await assert.rejects(read(await fetch(origin + "/redirect")), failure);
  assert.deepEqual(await read(await fetched('/json?encoding=identity&mime=APPLICATION/JSON;charset=%22UTF-8%22')), { endpoints: { api: "original" } });
});

test("malformed tail, empty EOF, invalid UTF-8 and truncated HTTP never release a projection", async () => {
  for (const path of ["/malformed", "/empty", "/utf8", "/truncated"]) {
    const response = await fetched(path); await assert.rejects(read(response), failure); assert.equal(response.body.locked, false);
  }
});

test("safe content-length must match actual EOF, independently of HTTP parsing", async () => {
  for (const length of ["-1", "+2", "2.5", "1e0", "9007199254740992", "16777217", "1", "400"]) {
    const response = await fetched(), headers = new Headers(response.headers); headers.set("content-length", length);
    Object.defineProperty(response, "headers", { value: headers });
    await assert.rejects(read(response), failure); assert.equal(response.body.locked, false);
  }
});

test("used and locked bodies preserve their original consumer ownership", async () => {
  const used = await fetched(); await used.text(); await assert.rejects(read(used), failure);
  const locked = await fetched(), owner = locked.body.getReader(); await assert.rejects(read(locked), failure);
  assert.equal(locked.body.locked, true); await owner.cancel(); owner.releaseLock();
});

for (const empty of [8190,8191]) test(`all reads include ${empty} empty results, data and EOF without window replenishment`, async () => {
  const response = await fetched(); let reads = 0, backing;
  instrument(response, reader => ({
    read(view) {
      if (++reads <= empty) { backing ??= view.buffer; assert.equal(view.buffer, backing); return Promise.resolve({ done: false, value: view.subarray(0,0) }); }
      return reader.read(view);
    }, cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  if (empty === 8190) assert.deepEqual(await read(response), { endpoints: { api: "original" } });
  else await assert.rejects(read(response), failure);
  assert.equal(reads,8192); assert.equal(response.body.locked,false);
});

for (const fault of ["oversized", "missing", "zero"]) test(`invalid returned ${fault} backing fails without allocation fallback`, async () => {
  const response = await fetched(); let calls = 0;
  instrument(response, reader => ({
    read() { calls++; return Promise.resolve({ done:false, value:fault === "missing" ? undefined : fault === "zero" ? new Uint8Array(0) : new Uint8Array(new ArrayBuffer(16385),0,1) }); },
    cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  await assert.rejects(read(response),failure); assert.equal(calls,1); assert.equal(response.body.locked,false);
});

test("FIRST cancellation and pending-read settlement both precede result, unlock and listener retirement", async () => {
  const response = await fetched("/stall"), operation = new HttpOperation();
  const started = gate(), readAck = gate(), cancelStarted = gate(), cancelAck = gate();
  let calls = 0, cancels = 0, released = false, settled = false;
  instrument(response, reader => ({
    read(view) { const actual = reader.read(view); if (++calls !== 2) return actual; started.resolve(); return actual.then(async part => { await readAck.promise; return part; }); },
    async cancel(reason) { cancels++; const actual = reader.cancel(reason); cancelStarted.resolve(); await actual; await cancelAck.promise; },
    releaseLock() { released = true; reader.releaseLock(); },
  }));
  const result = readCopilotAccountResponse(response,{operation,expectedUrl:response.url});
  const rejection = assert.rejects(result.finally(() => { settled=true; }),failure);
  await started.promise; operation.cancel("synthetic-private"); await cancelStarted.promise;
  await Promise.resolve(); assert.equal(settled,false); assert.equal(released,false); assert.equal(response.body.locked,true);
  readAck.resolve(); await Promise.resolve(); assert.equal(settled,false);
  cancelAck.resolve(); await rejection;
  assert.equal(cancels,1); assert.equal(released,true); assert.equal(response.body.locked,false); assert.equal(getEventListeners(operation.signal,"abort").length,0);
});

for (const mode of ["release-error", "silent-lock", "abort-at-unlock", "abort-after-unlock"]) test(`${mode} cannot publish after valid account EOF`, async () => {
  const response=await fetched(),operation=new HttpOperation(); let native;
  instrument(response,reader => { native=reader; return {
    read:view=>reader.read(view),cancel:reason=>reader.cancel(reason),
    releaseLock() {
      if(mode==="silent-lock")return;
      reader.releaseLock();
      if(mode==="release-error")throw new Error("synthetic-private-cleanup");
      if(mode==="abort-at-unlock")operation.cancel("late");
      if(mode==="abort-after-unlock")queueMicrotask(()=>operation.cancel("late"));
    },
  }; });
  await assert.rejects(read(response,operation),failure);
  if(mode==="silent-lock"){assert.equal(response.body.locked,true);native.releaseLock();}
  assert.equal(response.body.locked,false);assert.equal(getEventListeners(operation.signal,"abort").length,0);
});

test("rejected FIRST cancellation is joined and sanitized, with exactly one cancellation call", async () => {
  const response=await fetched("/utf8"),ack=gate(),started=gate();let calls=0,settled=false;
  instrument(response,reader=>({read:view=>reader.read(view),async cancel(reason){calls++;await reader.cancel(reason);started.resolve();await ack.promise;throw new Error("synthetic-private-cancel");},releaseLock:()=>reader.releaseLock()}));
  const rejected=assert.rejects(read(response).finally(()=>{settled=true;}),failure);
  await started.promise;await Promise.resolve();assert.equal(settled,false);assert.equal(response.body.locked,true);
  ack.resolve();await rejected;assert.equal(calls,1);assert.equal(response.body.locked,false);
});

test("synchronous abort inside the physical read cannot escape pending-read registration", async () => {
  const response=await fetched(),operation=new HttpOperation(),ack=gate(),started=gate();let calls=0,settled=false;
  instrument(response,reader=>({
    read(view){const pending=reader.read(view);operation.cancel("inside read");return pending;},
    async cancel(reason){calls++;await reader.cancel(reason);started.resolve();await ack.promise;},
    releaseLock:()=>reader.releaseLock(),
  }));
  const rejected=assert.rejects(readCopilotAccountResponse(response,{operation,expectedUrl:response.url}).finally(()=>{settled=true;}),failure);
  await started.promise;await Promise.resolve();assert.equal(settled,false);assert.equal(response.body.locked,true);
  ack.resolve();await rejected;assert.equal(calls,1);assert.equal(response.body.locked,false);
});

test("original deadline and already-aborted pre-read body cleanup retain no listeners", async () => {
  const response=await fetched("/stall"),operation=new HttpOperation(undefined,30);
  await assert.rejects(readCopilotAccountResponse(response,{operation,expectedUrl:response.url}),failure);
  assert.equal(operation.status,"timeout");assert.equal(response.body.locked,false);assert.equal(getEventListeners(operation.signal,"abort").length,0);
  const pre=await fetched(),aborted=new HttpOperation();aborted.cancel("already");
  await assert.rejects(readCopilotAccountResponse(pre,{operation:aborted,expectedUrl:pre.url}),failure);assert.equal(pre.bodyUsed,true);assert.equal(pre.body.locked,false);
});

test("sink finish abort and caller deadline ownership remain explicit", async () => {
  const response=await fetched(),operation=new HttpOperation();
  await assert.rejects(consumeCopilotResponse(response,{operation,expectedUrl:response.url,profile:"account"},()=>({push(){},finish(){operation.cancel("finish");return {};}})),failure);
  const success=await fetched(),alive=new HttpOperation();
  await readCopilotAccountResponse(success,{operation:alive,expectedUrl:success.url});
  assert.equal(alive.delivery,undefined);assert.equal(alive.signal.aborted,false);assert.equal(getEventListeners(alive.signal,"abort").length,0);alive.stop("complete");
});
