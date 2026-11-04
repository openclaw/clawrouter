import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once, getEventListeners } from "node:events";
import { HttpOperation } from "../http-operation.ts";
import { readCopilotResponseText } from "../copilot-response-body.ts";

const failure = error => error.message === "invalid_copilot_response_body";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let server, origin;
before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.test");
    const path = url.pathname;
    response.setHeader("content-type", url.searchParams.get("mime") ?? "application/json; charset=utf-8");
    if (url.searchParams.has("encoding")) response.setHeader("content-encoding", url.searchParams.get("encoding"));
    if (url.searchParams.has("range")) response.setHeader("content-range", "bytes 0-1/2");
    if (path === "/redirect") { response.writeHead(302, { location: "/json" }); response.end("{}"); return; }
    if (path === "/stall") { response.writeHead(200); response.write(" "); return; }
    if (path === "/truncated") { response.setHeader("content-length", "20"); response.setHeader("connection", "close"); response.end("{}"); return; }
    if (path === "/invalid-utf8") { response.end(Buffer.from([0xc3, 0x28])); return; }
    if (path === "/multibyte") { response.end('"' + "a".repeat(16382) + "é🦊" + '"'); return; }
    response.statusCode = Number(url.searchParams.get("status") ?? 200);
    const requested = url.searchParams.has("bytes") ? Number(url.searchParams.get("bytes")) : 2;
    const bytes = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 2 * 1024 * 1024 + 1) : 0;
    if (url.searchParams.has("chunked")) response.setHeader("transfer-encoding", "chunked");
    response.end(path === "/raw" ? "x".repeat(bytes) : "{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

async function fetched(path = "/json") { return fetch(origin + path, { redirect: "manual" }); }
async function read(response, profile = "catalog", operation = new HttpOperation(), expectedUrl = response.url) {
  try { return await readCopilotResponseText(response, { profile, operation, expectedUrl }); }
  finally { operation.stop("complete"); }
}
function instrument(response, change) {
  const original = response.body.getReader.bind(response.body);
  response.body.getReader = options => change(original(options));
}

test("Node fetched Response preserves complete UTF-8 across native BYOB windows without parsing JSON", async () => {
  const response = await fetched("/multibyte"), windows = [];
  instrument(response, reader => ({
    read: async view => { const requested = view.byteLength; const next = await reader.read(view); windows.push([requested, next.value?.buffer.byteLength ?? 0]); return next; },
    cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  assert.equal(await read(response), '"' + "a".repeat(16382) + "é🦊" + '"');
  assert.ok(windows.length >= 3); assert.ok(windows.every(([requested, backing]) => requested > 0 && requested <= 16384 && backing <= 16384));
  assert.equal(response.body.locked, false);
  assert.equal(await read(await fetched("/raw?bytes=8")), "xxxxxxxx");
});

for (const [profile, cap] of [["device", 8192], ["catalog", 2 * 1024 * 1024]]) {
  test(`Node ${profile} exact byte cap succeeds and one extra byte fails before publication`, async () => {
    assert.equal((await read(await fetched(`/raw?bytes=${cap}`), profile)).length, cap);
    for (const suffix of ["", "&chunked=1"]) {
      const response = await fetched(`/raw?bytes=${cap + 1}${suffix}`);
      await assert.rejects(read(response, profile), failure); assert.equal(response.body.locked, false);
    }
  });
}

test("Node response uses exact actual URL and catalog/device status envelopes", async () => {
  await assert.rejects(read(new Response("{}", { headers: { "content-type": "application/json" } }), "catalog"), failure);
  await assert.rejects(read(await fetched(), "catalog", new HttpOperation(), origin + "/other"), failure);
  await assert.rejects(read(await fetched(), "catalog", new HttpOperation(), ""), failure);
  assert.equal(await read(await fetched("/json?status=201"), "device"), "{}");
  for (const status of [201, 206, 299, 300, 400, 500]) await assert.rejects(read(await fetched(`/json?status=${status}`)), failure);
  for (const status of [300, 400, 429, 500]) await assert.rejects(read(await fetched(`/json?status=${status}`), "device"), failure);
  await assert.rejects(read(await fetched("/redirect")), failure);
  const followed = await fetch(origin + "/redirect"); assert.equal(followed.redirected, true);
  await assert.rejects(read(followed), failure);
});

test("Node rejects range, encoding and non-JSON or non-UTF-8 MIME metadata", async () => {
  for (const path of ["/json?range=1", "/json?encoding=br", "/json?encoding=gzip", "/json?mime=text/plain",
    "/json?mime=application/problem%2Bjson", "/json?mime=application/json;charset=latin1", "/json?mime=application/json;foo=bar"]) {
    const response = await fetched(path); await assert.rejects(read(response), failure); assert.equal(response.body.locked, false);
  }
  assert.equal(await read(await fetched('/json?encoding=identity&mime=APPLICATION/JSON;charset=%22UTF-8%22')), "{}");
});

test("Node rejects malformed UTF-8 and truncated HTTP bodies with content-free errors", async () => {
  await assert.rejects(read(await fetched("/invalid-utf8")), failure);
  const response = await fetched("/truncated"), operation = new HttpOperation(undefined, 1000);
  await assert.rejects(read(response, "catalog", operation), failure);
  assert.equal(response.body.locked, false); assert.notEqual(operation.status, "timeout");
});

test("Node used or locked response bodies retain their original consumer ownership", async () => {
  const used = await fetched(); await used.text(); await assert.rejects(read(used), failure);
  const locked = await fetched(), owner = locked.body.getReader();
  await assert.rejects(read(locked), failure); assert.equal(locked.body.locked, true);
  assert.equal(new TextDecoder().decode((await owner.read()).value), "{}");
  await owner.cancel(); owner.releaseLock();
});

test("Node original operation deadline cancels a pending native body read and retires listeners", async () => {
  const response = await fetched("/stall"), operation = new HttpOperation(undefined, 30);
  await assert.rejects(readCopilotResponseText(response, { operation, expectedUrl: response.url, profile: "catalog" }), failure);
  assert.equal(operation.status, "timeout"); assert.equal(response.body.locked, false);
  assert.equal(getEventListeners(operation.signal, "abort").length, 0);
});

test("Node cancellation waits for actual pending read and delayed cancel settlement before releasing ownership", async () => {
  const response = await fetched("/stall"), operation = new HttpOperation(), pending = deferred(), cancelStarted = deferred(), cleanup = deferred();
  let reads = 0, settled = false, released = false;
  instrument(response, reader => ({
    read: view => { const result = reader.read(view); if (++reads === 2) pending.resolve(); return result; },
    cancel: async reason => { const result = reader.cancel(reason); cancelStarted.resolve(); await result; await cleanup.promise; },
    releaseLock: () => { released = true; reader.releaseLock(); },
  }));
  const result = readCopilotResponseText(response, { operation, expectedUrl: response.url, profile: "catalog" });
  const rejected = assert.rejects(result.finally(() => { settled = true; }), failure);
  await pending.promise; operation.cancel(new Error("synthetic-private-reason")); await cancelStarted.promise;
  await Promise.resolve(); assert.equal(settled, false); assert.equal(released, false); assert.equal(response.body.locked, true);
  cleanup.resolve(); await rejected;
  assert.equal(released, true); assert.equal(response.body.locked, false); assert.equal(getEventListeners(operation.signal, "abort").length, 0);
});

test("Node already-aborted operation cancels an unused body without taking another lease", async () => {
  const response = await fetched(), operation = new HttpOperation(); operation.cancel("synthetic-private");
  await assert.rejects(readCopilotResponseText(response, { operation, expectedUrl: response.url, profile: "catalog" }), failure);
  assert.equal(response.body.locked, false); assert.equal(response.bodyUsed, true);
});

// Fault injection around an ACTUAL fetched body supplements, not substitutes for,
// the untampered Node/workerd transport cases. Native networks coalesce reads.
for (const empty of [8190, 8191]) test(`all-read guard counts ${empty} injected empty results plus native data and EOF`, async () => {
  const response = await fetched(); let calls = 0;
  instrument(response, reader => ({
    read: view => ++calls <= empty ? Promise.resolve({ done: false, value: view.subarray(0, 0) }) : reader.read(view),
    cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  if (empty === 8190) assert.equal(await read(response), "{}"); else await assert.rejects(read(response), failure);
  assert.equal(calls, 8192); assert.equal(response.body.locked, false);
});

test("tiny injected view cannot hide an oversized backing allocation", async () => {
  const response = await fetched(); let calls = 0;
  instrument(response, reader => ({
    read: () => { calls++; return Promise.resolve({ done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 1) }); },
    cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }));
  await assert.rejects(read(response), failure); assert.equal(calls, 1); assert.equal(response.body.locked, false);
});

test("reader neither parses nor retires caller deadline after successful transport", async () => {
  const response = await fetched("/raw?bytes=4"), operation = new HttpOperation();
  assert.equal(await readCopilotResponseText(response, { operation, expectedUrl: response.url, profile: "device" }), "xxxx");
  assert.equal(operation.delivery, undefined); assert.equal(operation.signal.aborted, false);
  assert.equal(getEventListeners(operation.signal, "abort").length, 0); operation.stop("complete");
});

test("empty native EOF is transport text, not an invented JSON envelope", async () => {
  assert.equal(await read(await fetched("/raw?bytes=0")), "");
});

test("unsafe or mismatched declared lengths reject even when a fetched body has only two bytes", async () => {
  for (const length of ["-1", "+2", "2.5", "1e0", "9007199254740992", "8193", "3", "1"]) {
    const response = await fetched(), headers = new Headers(response.headers); headers.set("content-length", length);
    // Invalid HTTP lengths may be rejected before fetch yields a Response.
    // Inject metadata only to exercise the reader's independent admission check.
    Object.defineProperty(response, "headers", { value: headers });
    await assert.rejects(read(response, "device"), failure); assert.equal(response.body.locked, false);
  }
});
