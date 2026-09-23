import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesOperationAborted, ResponsesWebSocketSession } from "../responses-websocket-session.ts";

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
      if (options.admit) await options.admit(index, body, signal);
      return { pin: "fixture-route:grant-1", payload: JSON.stringify({ type: "response.create", ...body, ...(lane ? { stream_id: lane } : {}) }), timeoutMs: 600_000, connect: options.connect ?? (async () => upstream), settle: async (outcome, terminal, sent, executionStarted) => { settled.push({ index, outcome, terminal, sent, executionStarted }); await options.settle?.(); } };
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
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "client_disconnect", sent: false }]);
  assert.equal(f.admitted[0].signal.aborted, true);
  assert.ok(f.admitted[0].signal.reason instanceof ResponsesOperationAborted);
  assert.equal(f.admitted[0].signal.reason.cause, "client_disconnect");
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

test("close during a deferred connect closes the late socket without sending or settling twice", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { connect: () => gate });
  f.client.receive(create());
  await tick();
  f.client.close();
  release(f.upstream);
  await tick();
  assert.equal(f.upstream.closed, true);
  assert.equal(f.upstream.sent.length, 0);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "client_disconnect", sent: false }]);
});

for (const phase of ["admission", "terminal"]) {
  test(`failed ${phase} accounting closes the session before queued work is admitted`, async (t) => {
    const failure = () => { throw Object.assign(new Error("accounting failed"), { status: 503, code: "accounting_unavailable" }); };
    const f = fixture(t, phase === "admission" ? { admit: failure } : { settle: failure });
    f.client.receive(create()); f.client.receive(create()); f.client.receive(create("other"));
    await tick();
    if (phase === "terminal") { respond(f); await tick(); }
    assert.equal(f.client.closed, true);
    assert.ok(f.client.sent.some((value) => JSON.parse(value).error?.code === "accounting_unavailable"));
    assert.equal(f.admitted.length, phase === "admission" ? 1 : 2);
    assert.equal(f.upstream.sent.length, phase === "admission" ? 0 : 2);
    assert.equal(f.settled.length, phase === "admission" ? 0 : 2);
  });
}

test("coded handshake failure closes the poisoned connection and releases only admitted work", async (t) => {
  const f = fixture(t, { connect: async () => { throw Object.assign(new Error("upstream rejected upgrade"), { code: "upgrade_rejected", status: 403 }); } });
  f.client.receive(create()); f.client.receive(create()); f.client.receive(create("other"));
  await tick();
  f.client.receive(create("later"));
  assert.equal(f.client.closed, true);
  assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "error", sent: false }]);
  assert.equal(f.settled[0].terminal.status, 403);
  assert.equal(JSON.parse(f.client.sent[0]).error.code, "upgrade_rejected");
});

test("deadline closes upstream and conservatively settles sent operations once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, { limits: { responseMs: 10 } });
  f.client.receive(create());
  await tick();
  t.mock.timers.tick(10);
  await tick();
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
  assert.deepEqual(f.settled.map((item) => item.outcome), ["router_limit"]);
});

test("malformed, steering, background and binary events have visible outcomes", async (t) => {
  const f = fixture(t);
  for (const value of ["{", create(""), { type: "response.steer" }, create(undefined, { background: true }), new Uint8Array([1])]) f.client.receive(value);
  assert.deepEqual(f.client.sent.map((item) => JSON.parse(item).error.code), ["invalid_json", "invalid_stream_id", "unsupported_event", "unsupported_event", "unsupported_event"]);
  assert.equal(f.admitted.length, 0);
  assert.equal(f.client.closed, true);
});

for (const first of ["client", "upstream"]) {
  test(`${first} close owns settlement through synchronous reciprocal close and abort callbacks`, async (t) => {
    const f = fixture(t);
    f.client.receive(create("started")); f.client.receive(create("unobserved"));
    await tick();
    f.upstream.receive({ type: "response.created", stream_id: "started", response: { id: "started" } });
    for (const { signal } of f.admitted) signal.addEventListener("abort", () => {
      f.upstream.close(); f.client.close();
    });
    f[first].close();
    await tick();
    assert.deepEqual(f.settled.map(({ outcome, sent, executionStarted }) => ({ outcome, sent, executionStarted })), [
      { outcome: `${first}_disconnect`, sent: true, executionStarted: true },
      { outcome: `${first}_disconnect`, sent: true, executionStarted: false },
    ]);
    assert.ok(f.admitted.every(({ signal }) => signal.reason.cause === `${first}_disconnect`));
    assert.equal(f.client.closed, true);
    assert.equal(f.upstream.closed, true);
  });
}

for (const phase of ["admission", "connect"]) {
  test(`client close remains the cause when pending ${phase} rejects late`, async (t) => {
    const gate = Promise.withResolvers();
    const f = fixture(t, { [phase === "admission" ? "admit" : "connect"]: () => gate.promise });
    f.client.receive(create()); f.client.receive(create());
    await tick();
    f.client.close();
    gate.reject(Object.assign(new Error("late provider failure"), { status: 503, code: "provider_unavailable" }));
    await tick();
    assert.equal(f.admitted.length, 1);
    assert.equal(f.admitted[0].signal.reason.cause, "client_disconnect");
    assert.equal(f.upstream.sent.length, 0);
    assert.equal(f.client.sent.length, 0);
    // Admission rejection owns its own receipt; a returned reservation is the
    // session's responsibility. Neither path may settle the queued create.
    assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), phase === "admission" ? [] : [{ outcome: "client_disconnect", sent: false }]);
  });
}

test("close settles sent and late-admitted work separately without admitting queued creates", async (t) => {
  const gate = Promise.withResolvers();
  const f = fixture(t, { limits: { active: 2 }, admit: (index) => index === 1 ? gate.promise : undefined });
  f.client.receive(create("sent")); f.client.receive(create("waiting")); f.client.receive(create("queued"));
  await tick();
  assert.equal(f.upstream.sent.length, 1);
  f.client.close();
  gate.resolve();
  await tick();
  assert.equal(f.admitted.length, 2);
  assert.deepEqual(f.settled.map(({ index, outcome, sent }) => ({ index, outcome, sent })), [
    { index: 0, outcome: "client_disconnect", sent: true },
    { index: 1, outcome: "client_disconnect", sent: false },
  ]);
});

test("a terminal already claimed wins even when forwarding closes the client", async (t) => {
  const gate = Promise.withResolvers();
  const f = fixture(t, { settle: () => gate.promise });
  f.client.receive(create()); f.client.receive(create());
  await tick();
  f.upstream.receive({ type: "response.created", response: { id: "finished" } });
  f.client.send = () => { throw new Error("peer closed during terminal delivery"); };
  f.upstream.receive(complete(undefined, "finished"));
  await tick();
  assert.equal(f.client.closed, true);
  assert.equal(f.upstream.closed, true);
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].outcome, "completed");
  assert.equal(f.settled[0].terminal.response.id, "finished");
  gate.resolve();
});

test("a close already claimed ignores a subsequent terminal", async (t) => {
  const f = fixture(t);
  f.client.receive(create());
  await tick();
  f.upstream.receive({ type: "response.created", response: { id: "late" } });
  f.client.close();
  f.upstream.receive(complete(undefined, "late"));
  await tick();
  assert.deepEqual(f.settled.map(({ outcome, terminal }) => ({ outcome, terminal })), [{ outcome: "client_disconnect", terminal: null }]);
});

test("a timeout owns only its operation when error delivery also fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, { limits: { responseMs: 10 } });
  f.client.receive(create("expired")); f.client.receive(create("collateral")); f.client.receive(create("expired"));
  await tick();
  f.client.send = () => { throw new Error("error delivery failed"); };
  t.mock.timers.tick(10);
  await tick();
  assert.equal(f.admitted.length, 2);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "timeout", sent: true }, { outcome: "router_error", sent: true }]);
  assert.deepEqual(f.admitted.map(({ signal }) => signal.reason.cause), ["timeout", "router_error"]);
  assert.equal(f.client.closed, true);
  assert.equal(f.upstream.closed, true);
});

test("a deadline during admission survives a late reservation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gate = Promise.withResolvers();
  const f = fixture(t, { limits: { responseMs: 10 }, admit: () => gate.promise });
  f.client.receive(create()); f.client.receive(create());
  await tick();
  t.mock.timers.tick(10);
  assert.equal(f.admitted[0].signal.reason.cause, "timeout");
  gate.resolve();
  await tick();
  assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "timeout", sent: false }]);
});

test("an upstream global error owns collateral lanes before failed error delivery", async (t) => {
  const f = fixture(t);
  f.client.receive(create("a")); f.client.receive(create("b"));
  await tick();
  f.client.send = () => { throw new Error("error delivery failed"); };
  f.upstream.receive({ type: "error", status: 503, error: { code: "upstream_unavailable" } });
  await tick();
  assert.deepEqual(f.settled.map(({ outcome }) => outcome), ["upstream_disconnect", "upstream_disconnect"]);
});

test("an upstream global error keeps its cause without bypassing the output cap", async (t) => {
  const f = fixture(t, { limits: { outputBytes: 256 } });
  f.client.receive(create("lane"));
  await tick();
  f.upstream.receive({ type: "response.created", stream_id: "lane", response: { id: "held" } });
  f.upstream.receive({ type: "error", status: 503, error: { code: "upstream_unavailable", message: "x".repeat(1_000) } });
  await tick();
  assert.ok(f.client.sent.reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 700);
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "websocket_connection_limit_reached");
  assert.deepEqual(f.settled.map(({ outcome }) => outcome), ["upstream_disconnect"]);
});

test("a rejected handshake keeps its error when error delivery closes the client", async (t) => {
  const f = fixture(t, { connect: async () => { throw Object.assign(new Error("upgrade rejected"), { code: "upgrade_rejected", status: 403 }); } });
  f.client.send = () => { throw new Error("peer closed"); };
  f.client.receive(create());
  await tick();
  assert.deepEqual(f.settled.map(({ outcome, sent, terminal }) => ({ outcome, sent, status: terminal?.status })), [{ outcome: "error", sent: false, status: 403 }]);
});

for (const peer of ["client", "upstream"]) {
  test(`${peer} protocol violation keeps its origin through reciprocal close`, async (t) => {
    const f = fixture(t);
    f.client.receive(create());
    await tick();
    f[peer].receive(new Uint8Array([1]));
    await tick();
    assert.deepEqual(f.settled.map(({ outcome }) => outcome), [`${peer}_protocol_error`]);
  });
}
