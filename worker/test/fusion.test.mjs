import assert from "node:assert/strict";
import test from "node:test";
import { observeUsage } from "../proxy-response.ts";
import { HttpOperation, InternalHttpAbort } from "../http-operation.ts";
import {
  FUSION_MODEL_ID,
  buildAdviserBody,
  buildAggregatorBody,
  buildFusionReservationProposals,
  buildLocalMessages,
  collectFusionProposals,
  normalizeFusionConfig,
} from "../fusion.ts";

test("fusion configuration validates concrete chat models and bounds adviser count", () => {
  const config = normalizeFusionConfig({
    enabled: true,
    adviserModels: ["local/qwen3:8b", "openai/gpt-4.1-mini", "local/qwen3:8b"],
    aggregatorModel: "openai/gpt-5.4",
    adviserTimeoutMs: 500,
    temperature: 9,
  });
  assert.deepEqual(config.adviserModels, ["local/qwen3:8b", "openai/gpt-4.1-mini"]);
  assert.equal(config.adviserTimeoutMs, 1_000);
  assert.equal(config.temperature, 2);
  assert.throws(() => normalizeFusionConfig({ enabled: true, adviserModels: [FUSION_MODEL_ID] }), /cannot use itself/);
  assert.throws(() => normalizeFusionConfig({ enabled: true, aggregatorModel: "not a model" }), /invalid/);
  assert.throws(() => normalizeFusionConfig(null), /JSON object/);
  assert.throws(() => normalizeFusionConfig([]), /JSON object/);
});

test("local adviser messages retain bounded text but never images or tool schemas", () => {
  const messages = buildLocalMessages([
    { role: "system", content: "system" },
    { role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image_url", image_url: { url: "data:image/png;base64,secret" } }] },
    { role: "tool", content: "tool output" },
  ], 64);
  const body = buildAdviserBody({ messages, tools: [{ type: "function", function: { name: "shell" } }] }, "local/qwen3:8b", normalizeFusionConfig({}), 0);
  assert.equal(body.model, "local/qwen3:8b");
  assert.equal(body.stream, false);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(body), /base64|image_url|shell/);
  assert.match(JSON.stringify(body), /tool output/);

  const reasoningBody = buildAdviserBody({ messages }, "openai/gpt-5.4", normalizeFusionConfig({}), 0);
  assert.equal(reasoningBody.temperature, undefined);
});

test("fusion runs advisers concurrently, tolerates failures, and injects untrusted drafts", async () => {
  const config = normalizeFusionConfig({
    enabled: true,
    adviserModels: ["local/qwen3:8b", "openai/gpt-4.1-mini"],
    aggregatorModel: "openai/gpt-5.4",
  });
  let active = 0;
  let peak = 0;
  const result = await collectFusionProposals(config, { messages: [{ role: "user", content: "solve" }] }, async (model) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return model.startsWith("local/")
      ? Response.json({ choices: [{ finish_reason: "stop", message: { content: "local proposal" } }] })
      : new Response("unavailable", { status: 503 });
  });
  assert.equal(peak, 2);
  assert.deepEqual(result.proposals, [{ model: "local/qwen3:8b", content: "local proposal" }]);
  assert.deepEqual(result.failedModels, ["openai/gpt-4.1-mini"]);

  const body = buildAggregatorBody({ model: FUSION_MODEL_ID, messages: [{ role: "user", content: "solve" }], tools: [{ type: "function" }], temperature: 0.7 }, config, result.proposals);
  assert.equal(body.model, "openai/gpt-5.4");
  assert.deepEqual(body.tools, [{ type: "function" }]);
  const instruction = body.messages.find((message) => message.role === "system");
  assert.match(instruction.content, /untrusted evidence/);
  assert.match(instruction.content, /local proposal/);

  const reasoningConfig = normalizeFusionConfig({ aggregatorModel: "openai/gpt-5.4" });
  assert.equal(buildAggregatorBody({ messages: [], temperature: 0.7 }, reasoningConfig, []).temperature, 0.7);
});

for (const [name, choice, extra] of [
  ["truncated", { finish_reason: "length" }],
  ["filtered", { finish_reason: "content_filter" }],
  ["tool request", { finish_reason: "tool_calls" }],
  ["function request", { finish_reason: "function_call" }],
  ["missing completion reason", {}],
  ["null completion reason", { finish_reason: null }],
  ["unknown completion reason", { finish_reason: "unknown" }],
  ["refusal with stop", { finish_reason: "stop", message: { refusal: "synthetic refusal" } }],
  ["tool call with stop", { finish_reason: "stop", message: { tool_calls: [{ id: "synthetic" }] } }],
  ["function call with stop", { finish_reason: "stop", message: { function_call: { name: "synthetic" } } }],
  ["provider error with stop", { finish_reason: "stop" }, { error: { message: "synthetic error" } }],
]) {
  test(`fusion rejects ${name} adviser text after consuming usage`, async () => {
    const config = normalizeFusionConfig({ adviserModels: ["local/incomplete"] });
    const observed = observeUsage(Response.json({
      ...extra,
      choices: [{ ...choice, message: { content: "unqualified draft", ...choice.message } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));
    let calls = 0;
    const result = await collectFusionProposals(config, { messages: [] }, async () => {
      calls++;
      return observed.response;
    });
    assert.equal(calls, 1, "rejected advice must not trigger another inference");
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.failedModels, ["local/incomplete"]);
    const usage = await observed.result;
    assert.equal(usage.delivery, "complete");
    assert.equal(usage.tokens?.total, 10);
    await observed.retired;
  });
}

test("fusion accepts completed adviser text parts with empty optional metadata", async () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/complete"] });
  const result = await collectFusionProposals(config, { messages: [] }, async () => Response.json({
    choices: [{ finish_reason: "stop", message: {
      content: [{ type: "text", text: "complete draft" }], refusal: null, function_call: null, tool_calls: [],
    } }],
  }));
  assert.deepEqual(result.proposals, [{ model: "local/complete", content: "complete draft" }]);
  assert.deepEqual(result.failedModels, []);
});

for (const [name, content, accepted] of [
  ["exact character boundary", "x".repeat(256), true],
  ["outer whitespace", ` \n${"x".repeat(256)}\n `, true],
  ["overlong complete draft", `${"x".repeat(256)}\nReject the preceding proposal.`, false],
  ["surrogate pair at the boundary", `${"x".repeat(255)}😀`, false],
]) {
  test(`fusion preserves complete advice at the ${name}`, async () => {
    const config = normalizeFusionConfig({ adviserModels: ["local/bounded"], maxProposalChars: 256 });
    const observed = observeUsage(Response.json({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));
    let calls = 0;
    const original = { messages: [{ role: "user", content: "solve" }] };
    const result = await collectFusionProposals(config, original, async () => {
      calls++;
      return observed.response;
    });
    assert.equal(calls, 1, "discarded advice must not trigger another inference");
    assert.deepEqual(result.proposals, accepted ? [{ model: "local/bounded", content: content.trim() }] : []);
    assert.deepEqual(result.failedModels, accepted ? [] : ["local/bounded"]);
    if (!accepted) {
      assert.deepEqual(buildAggregatorBody(original, config, result.proposals), { ...original, model: config.aggregatorModel });
    }
    const usage = await observed.result;
    assert.equal(usage.delivery, "complete");
    assert.equal(usage.tokens?.total, 10);
    await observed.retired;
  });
}

test("fusion keeps complete advisers when another exceeds the character limit", async () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/long", "local/complete"], maxProposalChars: 256 });
  const result = await collectFusionProposals(config, { messages: [] }, async model => Response.json({
    choices: [{ finish_reason: "stop", message: { content: model === "local/long" ? "x".repeat(257) : "complete advice" } }],
  }));
  assert.deepEqual(result.proposals, [{ model: "local/complete", content: "complete advice" }]);
  assert.deepEqual(result.failedModels, ["local/long"]);
});

test("fusion fails open when adviser bodies stall or exceed their byte bound", async () => {
  const stalledConfig = { ...normalizeFusionConfig({ adviserModels: ["local/stalled"] }), adviserTimeoutMs: 25 };
  let aborted = false, observed;
  const stalled = await collectFusionProposals(stalledConfig, { messages: [] }, async (_model, _body, _timeout, _index, signal) => {
    observed = observeUsage(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"partial'));
    },
    cancel() { aborted = true; },
  }), { headers: { "content-type": "application/json" } }), new HttpOperation(signal));
    return observed.response;
  });
  assert.deepEqual(stalled.proposals, []);
  assert.deepEqual(stalled.failedModels, ["local/stalled"]);
  assert.equal(aborted, true);
  assert.equal((await observed.result).delivery, "failed");
  assert.equal((await observed.result).tokens, null);

  const oversizedConfig = normalizeFusionConfig({ adviserModels: ["local/oversized"], maxProposalChars: 256 });
  const oversized = await collectFusionProposals(oversizedConfig, { messages: [] }, async () => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "x".repeat(32_000) } }],
  }));
  assert.deepEqual(oversized.proposals, []);
  assert.deepEqual(oversized.failedModels, ["local/oversized"]);
});

test("fusion consumes adviser rejections when the deadline has already elapsed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const config = normalizeFusionConfig({ adviserModels: ["local/expired"], adviserTimeoutMs: 1_000 });
  let adviserSignal;
  const result = await collectFusionProposals(config, { messages: [] }, (_model, _body, _timeout, _index, signal) => {
    adviserSignal = signal;
    t.mock.timers.setTime(1_000);
    return Promise.reject(new Error("synthetic expired adviser rejection"));
  });
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.failedModels, ["local/expired"]);
  assert.ok(adviserSignal.reason instanceof InternalHttpAbort);
  assert.equal(adviserSignal.reason.cause, "deadline");
  await new Promise(resolve => setImmediate(resolve));
});

test("fusion reservation proposals cover worst-case JSON encoding", () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/adviser"], maxProposalChars: 256 });
  const original = { messages: [{ role: "user", content: "solve" }] };
  const reservedBytes = encodedBytes(buildAggregatorBody(original, config, buildFusionReservationProposals(config)));
  for (const content of [
    "\0".repeat(256),
    "\\\"\n\r\t".repeat(51).slice(0, 256),
    "😀".repeat(128),
    "é".repeat(256),
  ]) {
    const actualBytes = encodedBytes(buildAggregatorBody(original, config, [{ model: "local/adviser", content }]));
    assert.ok(actualBytes <= reservedBytes, `${actualBytes} exceeds ${reservedBytes}`);
  }
});

for (const cancellation of ["complete", "reject", "stall"]) {
  test(`fusion cancels HTTP-error adviser bodies and completes accounting when cancellation can ${cancellation}`, async () => {
    const config = normalizeFusionConfig({ adviserModels: ["local/unavailable"] });
    let canceled = false, accounted = false;
    const observed = observeUsage(new Response(new ReadableStream({
      cancel() {
        canceled = true;
        if (cancellation === "reject") return Promise.reject(new Error("synthetic cancel failure"));
        if (cancellation === "stall") return new Promise(() => {});
      },
    }), { status: 503, headers: { "content-type": "application/json" } }));
    observed.result.then(() => { accounted = true; });
    const result = await collectFusionProposals(config, { messages: [] }, async () => observed.response);
    assert.deepEqual(result.failedModels, ["local/unavailable"]);
    assert.equal(canceled, true, "a skipped response must release its upstream body");
    assert.equal(accounted, true, "cancellation must complete usage observation without waiting on upstream cleanup");
  });
}

for (const status of [200, 503]) {
  test(`fusion cancels an adviser response arriving after its deadline (HTTP ${status})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const config = normalizeFusionConfig({ adviserModels: ["local/late"], adviserTimeoutMs: 1_000 });
    const deferred = Promise.withResolvers();
    const pending = collectFusionProposals(config, { messages: [] }, () => deferred.promise);
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.deepEqual(result.failedModels, ["local/late"]);
    let canceled = false, accounted = false;
    const observed = observeUsage(new Response(new ReadableStream({ cancel() { canceled = true; } }), { status }));
    observed.result.then(() => { accounted = true; });
    deferred.resolve(observed.response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(canceled, true, "a late response has no consumer and must be canceled");
    assert.equal(accounted, true);
  });
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
for (const failure of ["deadline", "oversized"]) for (const rejected of [false, true]) {
  test(`fusion retains its reader until ${failure} cancellation settles: rejected=${rejected}`, async () => {
    const config = { ...normalizeFusionConfig({ adviserModels: ["local/retirement"], maxProposalChars: 256 }), adviserTimeoutMs: 25 };
    const cleanup = Promise.withResolvers();
    let cancellations = 0;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(failure === "oversized" ? "x".repeat(32_000) : '{"choices":['));
      },
      cancel() { cancellations++; return cleanup.promise; },
    }));
    const retained = [];
    const result = await collectFusionProposals(config, { messages: [] }, async () => response, work => {
      const record = { done: false, work };
      retained.push(record);
      void work.then(() => { record.done = true; }, () => { record.done = true; });
    });
    try {
      assert.deepEqual(result.failedModels, ["local/retirement"]);
      assert.equal(cancellations, 1);
      assert.equal(response.body.locked, true, "pending cleanup must keep the original reader locked");
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(retained.some(record => !record.done), "cleanup must remain owned after collection returns");
    } finally {
      if (rejected) cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
      await Promise.allSettled(retained.map(record => record.work));
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(cancellations, 1);
    assert.equal(response.body.locked, false);
  });
}

test("fusion retains HTTP-error body cleanup without delaying collection", async () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/rejected"] });
  const cleanup = Promise.withResolvers();
  let cancellations = 0;
  const response = new Response(new ReadableStream({ cancel() { cancellations++; return cleanup.promise; } }), { status: 503 });
  const retained = [];
  const result = await collectFusionProposals(config, { messages: [] }, async () => response, work => {
    const record = { done: false, work };
    retained.push(record);
    void work.then(() => { record.done = true; }, () => { record.done = true; });
  });
  try {
    assert.deepEqual(result.failedModels, ["local/rejected"]);
    assert.equal(cancellations, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(retained.some(record => !record.done), "HTTP error cleanup must remain owned");
  } finally {
    cleanup.resolve();
    await Promise.allSettled(retained.map(record => record.work));
  }
});

test("fusion retains cleanup for a response arriving after its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const config = normalizeFusionConfig({ adviserModels: ["local/late"], adviserTimeoutMs: 1_000 });
  const arrival = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const retained = [];
  const pending = collectFusionProposals(config, { messages: [] }, () => arrival.promise, work => {
    const record = { done: false, work };
    retained.push(record);
    void work.then(() => { record.done = true; }, () => { record.done = true; });
  });
  t.mock.timers.tick(1_000);
  assert.deepEqual((await pending).failedModels, ["local/late"]);
  let cancellations = 0;
  arrival.resolve(new Response(new ReadableStream({ cancel() { cancellations++; return cleanup.promise; } })));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancellations, 1);
    assert.ok(retained.some(record => !record.done), "late response cleanup must remain owned");
  } finally {
    cleanup.resolve();
    await Promise.allSettled(retained.map(record => record.work));
  }
});

test("fusion retires a successful reader without cancelling its source", async () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/success"] });
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "proposal" } }] })));
      controller.close();
    },
    cancel() { cancellations++; },
  }));
  const retained = [];
  const result = await collectFusionProposals(config, { messages: [] }, async () => response, work => retained.push(work));
  await Promise.all(retained);
  assert.deepEqual(result.proposals, [{ model: "local/success", content: "proposal" }]);
  assert.equal(cancellations, 0);
  assert.equal(response.body.locked, false);
});
