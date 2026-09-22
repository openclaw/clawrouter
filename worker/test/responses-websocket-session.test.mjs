import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWebSocketSession } from "../responses-websocket-session.ts";

class Socket extends EventTarget {
  sent = [];
  closed = false;
  send(value) { if (this.closed) throw new Error("closed"); this.sent.push(value); }
  receive(value) { const event = new Event("message"); event.data = typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value; this.dispatchEvent(event); }
  close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event("close")); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const client = new Socket(), upstream = new Socket(), admitted = [], settled = [], pending = [];
  const session = new ResponsesWebSocketSession(client, {
    limits: options.limits,
    waitUntil(promise) { pending.push(promise); },
    async admit(body, lane, requestId, pin, signal) {
      const index = admitted.length;
      admitted.push({ body, lane, requestId, pin, signal });
      if (options.admit) await options.admit(index, body);
      return { pin: "fixture-route:grant-1", payload: JSON.stringify({ type: "response.create", ...body, ...(lane ? { stream_id: lane } : {}) }), timeoutMs: 600_000, connect: options.connect ?? (async () => upstream), settle: async (outcome, terminal) => { settled.push({ index, outcome, terminal }); } };
    },
  });
  t.after(async () => { session.close(); await Promise.all(pending); });
  return { client, upstream, admitted, settled, session, pending };
}
const create = (lane, extra = {}) => ({ type: "response.create", model: "fixture-model", input: "hello", ...(lane === undefined ? {} : { stream_id: lane }), ...extra });
const complete = (lane, id = "response-1", extra = {}) => ({ type: "response.completed", ...(lane === undefined ? {} : { stream_id: lane }), response: { id, service_tier: "priority", usage: { input_tokens: 1, output_tokens: 2 }, ...extra } });
function respond(f, lane, id = "response-1") {
  f.upstream.receive({ type: "response.created", ...(lane === undefined ? {} : { stream_id: lane }), response: { id } });
  f.upstream.receive(complete(lane, id));
}

test("one socket multiplexes lanes, preserves FIFO and response IDs, and accounts every prewarm", async (t) => {
  const f = fixture(t);
  f.client.receive(create("main", { generate: false, stream: true, stream_options: { reasoning_summary_delivery: "sequential_cutoff" }, client_metadata: { marker: "keep" } }));
  f.client.receive(create("main", { previous_response_id: "prewarm" }));
  f.client.receive(create("other"));
  await tick();
  assert.equal(f.upstream.sent.length, 2);
  assert.equal(f.admitted[0].body.stream, undefined);
  assert.deepEqual(f.admitted[0].body.stream_options, { reasoning_summary_delivery: "sequential_cutoff" });
  assert.equal(f.admitted[0].body.generate, false);
  assert.deepEqual(f.admitted[0].body.client_metadata, { marker: "keep" });
  respond(f, "main", "prewarm");
  await tick();
  assert.equal(f.upstream.sent.length, 3);
  assert.equal(JSON.parse(f.upstream.sent[2]).previous_response_id, "prewarm");
  assert.equal(new Set(f.admitted.map((item) => item.requestId)).size, 3);
  respond(f, "main", "continuation");
  respond(f, "other", "parallel");
  await tick();
  assert.equal(f.settled.length, 3);
  assert.ok(f.settled.every((item) => item.outcome === "completed"));
});

test("admission is fresh at dispatch and a denied queued turn never reaches upstream", async (t) => {
  let revoked = false;
  const f = fixture(t, { admit: async () => { if (revoked) throw Object.assign(new Error("credential revoked"), { status: 403, code: "proxy_key_revoked" }); } });
  f.client.receive(create());
  f.client.receive(create());
  await tick();
  revoked = true;
  respond(f);
  await tick();
  assert.equal(f.admitted.length, 2);
  assert.equal(f.upstream.sent.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "proxy_key_revoked");
  revoked = false;
  f.client.receive(create());
  await tick();
  assert.equal(f.upstream.sent.length, 2);
});

test("active responses, named lanes and aggregate queued bytes are independently bounded", async (t) => {
  const f = fixture(t, { limits: { active: 2, lanes: 3, bufferedBytes: 400, frameBytes: 300 } });
  f.client.receive(create("a")); f.client.receive(create("b")); f.client.receive(create("c"));
  await tick();
  assert.equal(f.upstream.sent.length, 2);
  f.client.receive(create("d"));
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "websocket_stream_limit_reached");
  f.client.receive(create("a", { input: "x".repeat(180) }));
  f.client.receive(create("b", { input: "x".repeat(180) }));
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "websocket_queue_full");
  respond(f, "a");
  await tick();
  assert.equal(f.upstream.sent.length, 3);
  f.session.close();
  await tick();
  assert.equal(f.settled.length, 3);
  assert.equal(f.admitted.length, 3);
});

test("upstream errors and metadata remain exact and completed reservations settle once", async (t) => {
  const f = fixture(t);
  f.client.receive(create("lane"));
  await tick();
  const metadata = { type: "codex.response.metadata", stream_id: "lane", headers: { "x-models-etag": "fixture-tag" } };
  f.upstream.receive(metadata);
  const failure = { type: "error", status: 400, stream_id: "lane", error: { code: "previous_response_not_found", message: "fixture" }, headers: { "retry-after": "1" } };
  f.upstream.receive(failure);
  f.upstream.receive(failure);
  f.upstream.close();
  await tick();
  assert.equal(f.client.sent[0], JSON.stringify(metadata));
  assert.equal(f.client.sent[1], JSON.stringify(failure));
  assert.deepEqual(f.settled.map((item) => item.outcome), ["error"]);
});

test("close during admission releases the late reservation without sending or replaying", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { admit: () => gate });
  f.client.receive(create());
  await tick();
  f.client.close();
  release();
  await tick();
  assert.equal(f.upstream.sent.length, 0);
  assert.deepEqual(f.settled.map((item) => item.outcome), ["not_sent"]);
  assert.equal(f.admitted[0].signal.aborted, true);
});

test("a delayed terminal cannot bind or settle a subsequent same-lane operation", async (t) => {
  const f = fixture(t);
  f.client.receive(create()); f.client.receive(create());
  await tick();
  respond(f, undefined, "first");
  await tick();
  assert.equal(f.upstream.sent.length, 2);
  f.upstream.receive(complete(undefined, "first"));
  await tick();
  assert.equal(f.settled.length, 1);
  assert.equal(f.client.closed, false);
  respond(f, undefined, "second");
  await tick();
  assert.deepEqual(f.settled.map((item) => item.terminal.response.id), ["first", "second"]);
});

test("coded handshake failure closes the poisoned connection and releases only admitted work", async (t) => {
  const f = fixture(t, { connect: async () => { throw Object.assign(new Error("upstream rejected upgrade"), { code: "upgrade_rejected", status: 403 }); } });
  f.client.receive(create()); f.client.receive(create()); f.client.receive(create("other"));
  await tick();
  f.client.receive(create("later"));
  assert.equal(f.client.closed, true);
  assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled.map((item) => item.outcome), ["not_sent"]);
  assert.equal(JSON.parse(f.client.sent[0]).error.code, "upgrade_rejected");
});

test("deadline closes upstream and conservatively settles sent operations once", async (t) => {
  const f = fixture(t, { limits: { responseMs: 10 } });
  f.client.receive(create());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.upstream.closed, true);
  assert.equal(f.client.closed, true);
  assert.deepEqual(f.settled.map((item) => item.outcome), ["timeout"]);
});

test("a slow sink cannot accumulate unbounded individually valid output frames", async (t) => {
  const f = fixture(t, { limits: { outputBytes: 400 } });
  f.client.receive(create());
  await tick();
  f.upstream.receive({ type: "response.created", response: { id: "slow" } });
  for (let index = 0; index < 100; index++) f.upstream.receive({ type: "response.output_text.delta", response_id: "slow", delta: "x".repeat(100) });
  await tick();
  assert.equal(f.client.closed, true);
  assert.equal(f.upstream.closed, true);
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "websocket_connection_limit_reached");
  assert.ok(f.client.sent.reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 700);
  assert.deepEqual(f.settled.map((item) => item.outcome), ["disconnect"]);
});

test("malformed, steering, background and binary events have visible outcomes", async (t) => {
  const f = fixture(t);
  for (const value of ["{", create(""), { type: "response.steer" }, create(undefined, { background: true }), new Uint8Array([1])]) f.client.receive(value);
  assert.deepEqual(f.client.sent.map((item) => JSON.parse(item).error.code), ["invalid_json", "invalid_stream_id", "unsupported_event", "unsupported_event", "unsupported_event"]);
  assert.equal(f.admitted.length, 0);
  assert.equal(f.client.closed, true);
});
