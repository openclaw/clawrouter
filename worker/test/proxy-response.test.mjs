import assert from "node:assert/strict";
import test from "node:test";
import { observeUsage, normalizePreStreamError } from "../proxy-response.ts";

const encoder = new TextEncoder();
const usage = { input_tokens: 12, output_tokens: 3 };

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
  assert.equal((await observed.tokens).total, 15);
});

test("oversized inspection falls back without truncating the client response", async () => {
  const text = JSON.stringify({ text: "a".repeat(2 * 1024 * 1024), usage });
  const observed = observeUsage(new Response(text, { headers: { "content-type": "application/json" } }));
  assert.equal(await observed.response.text(), text);
  assert.equal(await observed.tokens, null);
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
  assert.equal(await observed.tokens, null);
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
  assert.equal((await observed.tokens).total, 15);
});
