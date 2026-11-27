import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { tick, fixture, create, complete, respond } from "./responses-websocket-fixture.mjs";
const interrupt = (id, lane) => ({ type: "response.interrupt", response_id: id, mode: "discard_partial_items", ...(lane === undefined ? {} : { stream_id: lane }) });
const interruptAck = (id, lane, result = "accepted") => ({ type: `response.interrupt.${result}`, response_id: id, ...(lane === undefined ? {} : { stream_id: lane }) });

for (const result of ["accepted", "failed", "absent"]) test(`interrupt ${result} preserves terminal usage and fresh successor admission`, async t => {
  const f = fixture(t, { limits: { buffered: 1 }, admit: index => { if (index === 1) throw Object.assign(new Error("revoked"), { code: "proxy_key_revoked", status: 403 }); } });
  f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "first" } });
  await tick();
  // Controls remain usable even with the create buffer full.
  f.client.receive(interrupt("first"));
  assert.deepEqual(JSON.parse(f.upstream.sent[1]), interrupt("first"));
  assert.equal(f.admitted.length, 1); assert.equal(f.settled.length, 0);
  if (result !== "absent") f.upstream.receive(interruptAck("first", undefined, result));
  await tick();
  assert.equal(f.settled.length, 0);
  assert.equal(f.client.sent.map(JSON.parse).some(frame => frame.type.startsWith("response.interrupt.")), result !== "absent");
  const terminal = complete(undefined, "first");
  f.upstream.receive(terminal); await tick();
  f.client.receive(create(undefined, { previous_response_id: "first" })); await tick();
  assert.equal(f.admitted.length, 2); assert.equal(f.upstream.sent.length, 2);
  assert.deepEqual(f.settled.map(({ outcome, terminal: received, sent, executionStarted }) => ({ outcome, terminal: received, sent, executionStarted })), [{ outcome: "completed", terminal, sent: true, executionStarted: true }]);
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "proxy_key_revoked");
  assert.equal(f.client.closed, false);
});

for (const result of ["accepted", "failed"]) test(`late interrupt ${result} bypasses terminal settlement and successor ownership`, async t => {
  const publication = Promise.withResolvers(), settlement = Promise.withResolvers(), published = [];
  t.after(() => { publication.resolve(); settlement.resolve(); });
  const f = fixture(t, { publish: async (index, _identities, frame) => { published.push({ index, type: frame.type }); if (frame.type === "response.completed" && index === 0) await publication.promise; }, settle: () => settlement.promise });
  f.client.receive(create()); f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "first" } });
  f.client.receive(interrupt("first"));
  f.upstream.receive(complete(undefined, "first"));
  const ack = interruptAck("first", undefined, result);
  f.upstream.receive(ack);
  await tick();
  assert.deepEqual(f.client.sent.map(JSON.parse).map(frame => frame.type), ["response.created"]);
  publication.resolve(); await tick();
  assert.equal(f.client.sent.at(-1), JSON.stringify(ack));
  assert.equal(f.admitted.length, 2, "successor admission may overlap prior settlement");
  assert.equal(f.upstream.sent.filter(data => JSON.parse(data).type === "response.create").length, 1, "successor dispatch waits for settlement");
  settlement.resolve(); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "second" } });
  f.upstream.receive(ack); // Native duplicate/late ACK must not bind the successor.
  f.upstream.receive(complete(undefined, "second")); await tick();
  assert.equal(f.client.closed, false);
  assert.deepEqual(f.settled.map(item => item.terminal.response.id), ["first", "second"]);
  assert.ok(published.every(frame => !frame.type.startsWith("response.interrupt.")), "ACKs never enter continuation ownership or tool evidence");
});

test("completion wins the interrupt race and old controls survive newer same-lane terminals", async t => {
  const f = fixture(t);
  f.client.receive(create()); await tick();
  respond(f, undefined, "first"); await tick();
  f.client.receive(interrupt("first"));
  f.client.receive(create(undefined, { previous_response_id: "first", generate: false })); await tick();
  respond(f, undefined, "second"); await tick();
  f.client.receive(interrupt("first"));
  f.upstream.receive(interruptAck("first")); await tick();
  assert.deepEqual(f.upstream.sent.map(JSON.parse).map(frame => frame.type), ["response.create", "response.interrupt", "response.create", "response.interrupt"]);
  assert.equal(f.client.sent.at(-1), JSON.stringify(interruptAck("first")));
  assert.equal(f.settled.length, 2); assert.equal(f.client.closed, false);
});

test("interrupts reject unknown, foreign-lane, malformed and generation-bearing controls without dispatch", async t => {
  const f = fixture(t);
  f.client.receive(interrupt("unsent"));
  f.client.receive(create("a")); await tick();
  f.upstream.receive({ type: "response.created", stream_id: "a", response: { id: "owned" } }); await tick();
  const controls = [interrupt("owned"), interrupt("owned", "b"), interrupt("foreign", "a"), interrupt(undefined, "a"), interrupt({}, "a"), interrupt("x".repeat(257), "a"), interrupt("é".repeat(129), "a"), { ...interrupt("owned", "a"), mode: "other" }, { ...interrupt("owned", "a"), input: [] }, { ...interrupt("owned", "a"), background: true }];
  for (const frame of controls) f.client.receive(frame);
  assert.equal(f.upstream.sent.length, 1); assert.equal(f.admitted.length, 1); assert.equal(f.settled.length, 0);
  assert.equal(f.client.sent.map(JSON.parse).filter(frame => frame.type === "error").length, controls.length + 1);
  f.client.receive(interrupt("owned", "a"));
  assert.deepEqual(JSON.parse(f.upstream.sent[1]), interrupt("owned", "a"));
  assert.equal(f.client.closed, false);
});

test("named-lane ACKs preserve their stream without affecting parallel work", async t => {
  const f = fixture(t);
  f.client.receive(create("a")); f.client.receive(create("b")); await tick();
  f.upstream.receive({ type: "response.created", stream_id: "a", response: { id: "first" } });
  f.upstream.receive({ type: "response.created", stream_id: "b", response: { id: "parallel" } });
  f.client.receive(interrupt("first", "a"));
  const ack = interruptAck("first", "a");
  f.upstream.receive(ack); await tick();
  assert.equal(f.client.sent.at(-1), JSON.stringify(ack)); assert.equal(f.settled.length, 0);
  f.upstream.receive(complete("b", "parallel")); f.upstream.receive(complete("a", "first")); await tick();
  assert.deepEqual(f.settled.map(item => item.terminal.response.id), ["parallel", "first"]);
  assert.equal(f.client.closed, false);
});

test("an ACK for an owned response still requires a forwarded interrupt", async t => {
  const f = fixture(t);
  f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "owned" } });
  f.upstream.receive(interruptAck("owned")); await tick();
  assert.equal(f.client.closed, true);
  assert.deepEqual(f.settled.map(item => item.outcome), ["upstream_protocol_error"]);
});

for (const malformed of [interruptAck("foreign"), { type: "response.interrupt.accepted" }, interruptAck("owned", "other"), { ...interruptAck("owned"), stream_id: 42 }]) test(`unsolicited or malformed ACK cannot publish ownership: ${JSON.stringify(malformed)}`, async t => {
  const f = fixture(t);
  f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "owned" } });
  f.client.receive(interrupt("owned"));
  f.upstream.receive(malformed); await tick();
  assert.equal(f.client.closed, true);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "upstream_protocol_error", sent: true }]);
  assert.ok(f.client.sent.every(frame => !JSON.parse(frame).type.startsWith("response.interrupt.")));
});

test("interrupt send failure closes and retains sent work without dispatching queued work", async t => {
  const f = fixture(t);
  f.client.receive(create()); f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "first" } });
  f.upstream.send = () => { throw new Error("socket failed"); };
  f.client.receive(interrupt("first")); await tick();
  assert.equal(f.client.closed, true); assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "upstream_disconnect", sent: true }]);
});

test("repeated interrupts and their late-ACK records share a bounded connection lifetime", async t => {
  const f = fixture(t, { limits: { interrupts: 2 } });
  f.client.receive(create()); f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "first" } });
  for (let i = 0; i < 3; i++) f.client.receive(interrupt("first"));
  await tick();
  assert.equal(f.upstream.sent.length, 3); assert.equal(f.client.closed, true);
  assert.equal(JSON.parse(f.client.sent.at(-1)).error.code, "websocket_connection_limit_reached");
  assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), [{ outcome: "router_limit", sent: true }]);
});

for (const late of [false, true]) test(`uncorrelated interrupt error cannot release running work (late=${late})`, async t => {
  const f = fixture(t);
  f.client.receive(create()); f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "first" } });
  if (late) { f.upstream.receive(complete(undefined, "first")); await tick(); }
  f.client.receive(interrupt("first"));
  const failure = { type: "error", status: 400, error: { code: "invalid_request_error" } };
  f.upstream.receive(failure); await tick();
  assert.equal(f.client.sent.at(-1), JSON.stringify(failure));
  assert.equal(f.client.closed, true);
  assert.deepEqual(f.settled.map(({ outcome, sent }) => ({ outcome, sent })), late ? [{ outcome: "completed", sent: true }, { outcome: "upstream_disconnect", sent: true }] : [{ outcome: "upstream_disconnect", sent: true }]);
});

test("control diagnostics use bounded fixed categories and cannot break delivery", async t => {
  const observations = [];
  const f = fixture(t, { observeControl: event => { observations.push(event); throw new Error("log unavailable"); } });
  f.client.receive({ type: "private-client-string", input: "private-prompt" });
  f.client.receive(create(undefined, { background: true }));
  f.client.receive(create()); await tick();
  f.upstream.receive({ type: "response.created", response: { id: "private-response-id" } });
  f.client.receive(interrupt("private-response-id"));
  assert.deepEqual(observations, [
    { eventType: "other", outcome: "unsupported_event", background: false },
    { eventType: "response.create", outcome: "unsupported_event", background: true },
    { eventType: "response.interrupt", outcome: "forwarded", background: false },
  ]);
  assert.equal(f.upstream.sent.length, 2);
  for (let i = 0; i < 20; i++) f.client.receive({ type: "response.steer" });
  assert.equal(observations.length, 16);
  assert.ok(!JSON.stringify(observations).includes("private-"));
});
