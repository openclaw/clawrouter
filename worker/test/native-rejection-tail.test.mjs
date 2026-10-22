import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { HttpOperation } from "../http-operation.ts";
import { normalizePreStreamError, observeUsage } from "../proxy-response.ts";

// Real normalization, parsers, operation lifecycle and delivery observation.
// Only the provider byte stream is synthetic; no accounting decision is mocked.
for (const format of ["openai.chat", "openai.responses", "anthropic.messages"]) {
  const anthropic = format === "anthropic.messages";
  const native = { format: anthropic ? "anthropic" : "openai", requestId: "fixture-tail" };
  const error = { type: "error", error: { type: "api_error", message: "synthetic rejection" } };
  const prefix = `event: error\r\ndata: ${JSON.stringify(error)}\r\n\r\n`;
  const content = anthropic ? { type: "content_block_delta", delta: { type: "text_delta", text: "work" } }
    : format === "openai.responses" ? { type: "response.output_text.delta", delta: "work" }
    : { object: "chat.completion.chunk", choices: [{ delta: { content: "work" } }] };
  const usage = anthropic ? { type: "message_delta", usage: { output_tokens: 2 } }
    : format === "openai.responses" ? { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
    : { object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const tails = [
    ["content", "data: " + JSON.stringify(content), true],
    ["usage", "data: " + JSON.stringify(usage), true],
    ["partial-json", 'data: {"delta":"delivered work', true],
    ["empty", "data: \r\n", false],
    ["comment", ": keepalive", false],
    ["marker", anthropic ? 'data: {"type":"message_stop"}' : "data: [DONE]", false],
    ["json-error", `data: ${JSON.stringify(error)}`, false],
    ["event-error", 'event: error\r\ndata: {"partial"', false],
    ["null-error", 'data: {"error":null,"delta":"work"}', true],
  ];
  for (const [kind, tail, billable] of tails) for (const delivery of ["complete", "canceled"]) {
    test(`${format}: unfinished ${kind} at ${delivery} preserves rejection evidence correctly`, async () => {
      const wire = new TextEncoder().encode(prefix + tail);
      let offset = 0, canceled = 0;
      const source = new ReadableStream({
        pull(controller) {
          if (offset === wire.byteLength) {
            if (delivery === "complete") controller.close();
            return;
          }
          const end = Math.min(wire.byteLength, offset + 7);
          controller.enqueue(wire.subarray(offset, end)); offset = end;
        },
        cancel() { canceled++; },
      }, { highWaterMark: 0 });
      const operation = new HttpOperation();
      const normalized = await normalizePreStreamError(new Response(source, { headers: { "content-type": "text/event-stream" } }), true, operation, native);
      assert.equal(normalized.status, 200); assert.equal(operation.receivedRejection, true);
      const observed = observeUsage(normalized, operation, undefined, format);
      const reader = observed.response.body.getReader(), chunks = [];
      let received = 0;
      while (received < wire.byteLength) {
        const next = await reader.read(); assert.equal(next.done, false);
        chunks.push(next.value); received += next.value.byteLength;
      }
      if (delivery === "canceled") await reader.cancel("fixture cancellation after delivered tail");
      else assert.equal((await reader.read()).done, true);
      reader.releaseLock();
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(wire));
      const result = await observed.result;
      assert.equal(result.delivery, delivery);
      assert.equal(result.nonbillable === true, !billable);
      assert.equal(operation.receivedRejection, !billable);
      assert.equal(operation.status, "provider_error");
      assert.equal(result.tokens, null, "an unfinished SSE frame cannot supply authoritative usage");
      assert.equal(canceled, delivery === "canceled" ? 1 : 0);
    });
  }
}
