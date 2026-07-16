import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { normalizePreStreamError } = await import("../proxy.ts");
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
