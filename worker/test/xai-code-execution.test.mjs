import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareXaiCodeExecution, observeXaiCodeExecution, readXaiCodeExecution } from "../xai-code-execution.ts";

const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/code-execution.json", import.meta.url)));
const qualification = { model: "grok-4.7", servingModels: ["grok-4.7"], reasoningEfforts: ["low", "medium", "high"] };
const prepare = value => prepareXaiCodeExecution(value, qualification);
const request = prepare(fixture.request);
const response = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("frozen code execution sends the native Responses tool, not the SDK alias or a local executor", () => {
  assert.equal(request.path, "/v1/responses"); assert.deepEqual(request.body, fixture.request);
  assert.equal(request.headers.get("authorization"), null);
  const input = structuredClone(fixture.request), prepared = prepare(input);
  input.tools[0].type = "web_search"; assert.equal(prepared.body.tools[0].type, "code_interpreter");
  for (const patch of [{ tools: [{ type: "code_execution" }] }, { tools: [{ type: "code_interpreter", container: "other_container" }] },
    { tools: [{ type: "code_interpreter" }, { type: "web_search" }] }, { store: true }, { stream: true },
    { previous_response_id: "other_response" }, { model: "unqualified-model" }, { reasoning: { effort: "none" } },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "other_file" }] }] },
    { input: [{ role: "user", content: "\ud800" }] }, { max_turns: 11 }]) {
    assert.throws(() => prepare({ ...fixture.request, ...patch }), /invalid_xai_code_execution/);
  }
});

test("complete native result preserves the answer, observed tool type and independent usage counter", async () => {
  const result = await readXaiCodeExecution(response(fixture.completed), request, new AbortController().signal);
  assert.equal(result.status, "completed"); assert.equal(result.answer, "The sum is 55.");
  assert.equal(result.usedCodeExecution, true); assert.equal(result.codeInterpreterCalls, 1);
  assert.deepEqual(result.outputTypes, ["code_interpreter_call", "message"]);
  assert.equal(result.counts.inputTokens, 120); assert.equal(result.upstreamCostMicros, null);
});

test("attempted, absent and incomplete execution remain distinct from billable tool usage", () => {
  const attempted = observeXaiCodeExecution(fixture.attempted, request, true);
  assert.equal(attempted.usedCodeExecution, true); assert.equal(attempted.codeInterpreterCalls, 0);
  assert.equal(attempted.counts.outputTokens, 20); assert.equal(attempted.upstreamCostMicros, null);
  const unused = observeXaiCodeExecution(fixture.unused, request, true);
  assert.equal(unused.usedCodeExecution, false); assert.equal(unused.codeInterpreterCalls, null);
  const partial = observeXaiCodeExecution(fixture.incomplete, request, true);
  assert.equal(partial.status, "incomplete"); assert.equal(partial.answer, ""); assert.equal(partial.codeInterpreterCalls, 1);
  assert.equal(partial.upstreamCostMicros, null);
});

test("native counters and model identity cannot be fabricated from output item count", () => {
  const body = structuredClone(fixture.completed);
  body.output.unshift({ type: "code_interpreter_call", id: "code_another_attempt", status: "failed" });
  assert.equal(observeXaiCodeExecution(body, request, true).codeInterpreterCalls, 1);
  for (const count of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    body.usage.server_side_tool_usage_details.code_interpreter_calls = count;
    assert.throws(() => observeXaiCodeExecution(body, request, true), /invalid_xai_code_execution/);
  }
  assert.throws(() => observeXaiCodeExecution({ ...fixture.completed, model: "another-model" }, request, true));
  assert.throws(() => observeXaiCodeExecution(fixture.completed, request, false));
});

test("bounded native transport rejects partial delivery and cancels stalled reads", async () => {
  await assert.rejects(readXaiCodeExecution(new Response("{}", { status: 206, headers: { "content-type": "application/json" } }), request, new AbortController().signal));
  let cancelled = false; const controller = new AbortController();
  const pending = readXaiCodeExecution(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
