import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { observeUsage, normalizePreStreamError } from "../proxy-response.ts";

const encoder = new TextEncoder();
const usage = { input_tokens: 12, output_tokens: 3 };
const frame = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const created = { type: "response.created", response: { status: "in_progress" } };
const terminal = type => ({ type: `response.${type}`, response: { object: "response", status: type, usage } });

test("ingress abort owns pending and already-aborted streams exactly once", async () => {
  for (const stage of ["already", "pending", "terminal"]) for (const rejectCancel of [false, true]) {
    const abort = new AbortController(), entered = Promise.withResolvers();
    let pulls = 0, cancels = 0, results = 0;
    if (stage === "already") abort.abort(new Error("fixture caller abort"));
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(frame(created) + (stage === "terminal" ? frame(terminal("completed")) : "")));
        else entered.resolve();
      },
      cancel() { cancels++; if (rejectCancel) return Promise.reject(new Error("fixture cleanup rejection")); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    const observed = observeUsage(upstream, abort.signal);
    observed.result.then(() => { results++; });
    const reader = observed.response.body.getReader();
    if (stage !== "already") {
      await reader.read();
      const pending = reader.read();
      const rejected = assert.rejects(pending, /fixture caller abort/);
      await entered.promise;
      abort.abort(new Error("fixture caller abort"));
      await rejected;
    } else await assert.rejects(reader.read(), /fixture caller abort/);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    const result = await observed.result;
    assert.equal(result.delivery, "canceled");
    assert.equal(result.tokens?.total ?? null, stage === "terminal" ? 15 : null);
    assert.equal(cancels, 1);
    assert.equal(results, 1);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(upstream.body.locked, false);
  }
});

test("normal completion and delivery failure remove the ingress abort listener", async () => {
  for (const fail of [false, true]) {
    const abort = new AbortController();
    const observed = observeUsage(new Response(new ReadableStream({ pull(controller) {
      if (fail) controller.error(new Error("fixture failure"));
      else controller.close();
    } })), abort.signal);
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    if (fail) await assert.rejects(observed.response.text(), /fixture failure/);
    else await observed.response.text();
    const result = await observed.result;
    abort.abort();
    assert.equal((await observed.result), result);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(result.delivery, fail ? "failed" : "complete");
  }
});

test("JSON and SSE terminal outcome is independent of nullable usage", async () => {
  for (const status of ["completed", "incomplete", "failed"]) for (const withUsage of [true, false]) for (const contentType of ["application/json", "text/event-stream"]) {
    const event = terminal(status); if (!withUsage) delete event.response.usage;
    const text = contentType === "application/json" ? JSON.stringify(event.response) : frame(created) + frame(event);
    const observed = observeUsage(new Response(text, { headers: { "content-type": contentType } }));
    assert.equal(await observed.response.text(), text);
    const result = await observed.result;
    assert.equal(result.delivery, "complete");
    assert.equal(result.outcome, status === "failed" ? "provider_error" : "success");
    assert.equal(result.tokens?.total ?? null, withUsage ? 15 : null);
  }
});

test("recognized unterminated and malformed protocols fail without inventing usage", async () => {
  for (const text of [frame(created), frame({ type: "message_start", message: { usage } }), frame({ object: "chat.completion.chunk", usage }), frame(created) + 'data: {broken}\n\n', frame(created) + frame({ type: "error", error: { message: "fixture" } }), frame(created) + frame(terminal("completed")).trimEnd()]) {
    const observed = observeUsage(new Response(text, { headers: { "content-type": "text/event-stream" } }));
    assert.equal(await observed.response.text(), text);
    assert.deepEqual(await observed.result, { delivery: "complete", outcome: "provider_error", tokens: null });
  }
});

test("late terminal facts survive long SSE history and split CR/LF/UTF-8", async () => {
  const delta = frame({ type: "response.output_text.delta", delta: "🦞".repeat(2048) });
  for (const ending of ["\n", "\r\n", "\r"]) {
    const text = (frame(created) + delta.repeat(300) + frame(terminal("failed"))).replaceAll("\n", ending);
    const bytes = encoder.encode(text); let offset = 0;
    const observed = observeUsage(new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) controller.close();
      else { const end = Math.min(bytes.length, offset + 4093); controller.enqueue(bytes.subarray(offset, end)); offset = end; }
    } }), { headers: { "content-type": "text/event-stream" } }));
    assert.deepEqual(new Uint8Array(await observed.response.arrayBuffer()), bytes);
    assert.equal((await observed.result).outcome, "provider_error");
    assert.equal((await observed.result).tokens.total, 15);
  }
});

test("one oversized terminal is unknown evidence, while a later bounded terminal remains observable", async () => {
  const oversized = frame({ ...terminal("completed"), padding: "x".repeat(2 * 1024 * 1024) });
  for (const later of ["", frame(terminal("failed"))]) {
    const text = frame(created) + oversized + later;
    const observed = observeUsage(new Response(text, { headers: { "content-type": "text/event-stream" } }));
    assert.equal(await observed.response.text(), text);
    assert.equal((await observed.result).outcome, later ? "provider_error" : null);
    assert.equal((await observed.result).tokens?.total ?? null, later ? 15 : null);
  }
});

test("consumer cancellation and reader failure retain only already authoritative terminal usage", async () => {
  for (const afterTerminal of [false, true]) for (const delivery of ["canceled", "failed"]) {
    let pulls = 0, canceled = false;
    const text = frame(created) + (afterTerminal ? frame(terminal("completed")) : "");
    const observed = observeUsage(new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode(text));
      else if (delivery === "failed") controller.error(new Error("fixture read failure"));
    }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    const reader = observed.response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), text);
    if (delivery === "canceled") { await reader.cancel(); assert.equal(canceled, true); }
    else await assert.rejects(reader.read(), /fixture read failure/);
    const result = await observed.result;
    assert.equal(result.delivery, delivery);
    assert.equal(result.tokens?.total ?? null, afterTerminal ? 15 : null);
    assert.equal(result.outcome, afterTerminal ? "success" : null);
  }
});

test("valid generic JSON, generic SSE and binary delivery do not require token usage", async () => {
  for (const [text, contentType] of [['{"ok":true}', "application/json"], ['data: generic notification\n\n', "text/event-stream"], ["binary fixture", "application/octet-stream"]]) {
    const observed = observeUsage(new Response(text, { headers: { "content-type": contentType } }));
    assert.equal(await observed.response.text(), text);
    assert.deepEqual(await observed.result, { delivery: "complete", outcome: null, tokens: null });
  }
});

test("explicit JSON errors remain provider failures even without token usage", async () => {
  const observed = observeUsage(Response.json({ error: { message: "fixture" } }));
  assert.deepEqual(await observed.response.json(), { error: { message: "fixture" } });
  assert.deepEqual(await observed.result, { delivery: "complete", outcome: "provider_error", tokens: null });
});

test("usage inspection preserves split UTF-8 bytes and mixed-case media types", async () => {
  const bytes = encoder.encode(JSON.stringify({ text: "🦞", usage }));
  let offset = 0;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
      else controller.close();
    },
  }), { headers: { "content-type": "Application/JSON" } });
  const observed = observeUsage(upstream);
  assert.deepEqual(new Uint8Array(await observed.response.arrayBuffer()), bytes);
  assert.equal((await observed.result).tokens.total, 15);
});

test("oversized inspection falls back without truncating the client response", async () => {
  const text = JSON.stringify({ text: "a".repeat(2 * 1024 * 1024), usage });
  const observed = observeUsage(new Response(text, { headers: { "content-type": "application/json" } }));
  assert.equal(await observed.response.text(), text);
  assert.equal((await observed.result).tokens, null);
});

test("canceling a pending read never treats cancellation as a complete usage report", async () => {
  let pulls = 0;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const observed = observeUsage(new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode(JSON.stringify({ usage })));
      else entered();
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  const reader = observed.response.body.getReader();
  await reader.read();
  const read = reader.read();
  await pending;
  await reader.cancel();
  assert.equal((await read).done, true);
  assert.equal((await observed.result).tokens, null);
});

test("first-event normalization and accounting do not prefetch later SSE chunks", async () => {
  let pulls = 0;
  const first = 'data: {"type":"response.created"}\n\n';
  const last = `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (pulls === 0) controller.enqueue(encoder.encode(first));
      else if (pulls === 1) controller.enqueue(encoder.encode(last));
      else controller.close();
      pulls++;
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const observed = observeUsage(await normalizePreStreamError(response, true));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pulls, 1);
  assert.equal(await observed.response.text(), first + last);
  assert.equal((await observed.result).tokens.total, 15);
});
