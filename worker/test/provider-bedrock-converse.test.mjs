import assert from "node:assert/strict";
import test from "node:test";
import { bedrockBase64, bedrockConverseLimit, createBedrockConverseDecoder, decodeBedrockConverseResponse, extractBedrockConverseUsage, prepareBedrockConverseRequest } from "../provider-bedrock-converse.ts";
import { buildBedrockSystemPrompt, prepareBedrockReplay } from "../provider-bedrock-replay.ts";

const model = { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", api: "bedrock-converse-stream", provider: "amazon-bedrock", claude: true };
const tool = { name: "inspect", description: "Synthetic fixture", parameters: { type: "object" } };
const assistant = content => ({ role: "assistant", model: model.id, api: model.api, provider: model.provider, content });
const usage = { inputTokens: 50, outputTokens: 12, totalTokens: 62, cacheReadInputTokens: 10, cacheWriteInputTokens: 4, cacheDetails: [{ ttl: "5m", inputTokens: 1 }, { ttl: "5m", inputTokens: 1 }, { ttl: "1h", inputTokens: 2 }] };
const expectedUsage = { input: 64, output: 12, total: 76, cached: 10, cacheWrite: 4, cacheWrite5m: 2, cacheWrite1h: 2 };
const start = { messageStart: { role: "assistant" } };
const text = { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "synthetic answer" } } };
const stop = { messageStop: { stopReason: "end_turn" } };
const meta = { metadata: { usage } };
const decode = (events, ended = true) => { const decoder = createBedrockConverseDecoder(); events.forEach(event => decoder.accept(event)); return decoder.result(ended); };
const delta = (index, value) => ({ contentBlockDelta: { contentBlockIndex: index, delta: value } });
const closed = index => ({ contentBlockStop: { contentBlockIndex: index } });
const call = (index, name = "inspect") => ({ contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: `call-${index}`, name } } } });

// Ported replay cases from frozen OpenClaw 31ad71a8 stream.runtime.tool-replay.test.ts.
test("tool-free and toolChoice-none replay keeps settled evidence without tool blocks", () => {
  const messages = [assistant([{ type: "toolCall", id: "call/1", name: "inspect", arguments: '{"path":' }]), { role: "toolResult", toolCallId: "call/1", toolName: "inspect", isError: true, content: [{ type: "text", text: "synthetic failure" }] }];
  const before = structuredClone(messages);
  for (const [tools, options] of [[[], {}], [[tool], { toolChoice: "none" }]]) {
    const result = prepareBedrockReplay({ messages, tools }, model, options);
    assert.equal(result.toolConfig, undefined);
    assert.deepEqual(result.messages[0].content, [{ text: "[Assistant tool call]: inspect({})" }]);
    assert.deepEqual(result.messages[1].content, [{ text: "[Tool result: inspect (error)]:" }, { text: "synthetic failure" }]);
  }
  assert.deepEqual(messages, before);
});

test("native tool replay coerces malformed historical arguments and groups empty/image/audio results", () => {
  const input = { tools: [tool], messages: [assistant([{ type: "toolCall", id: "call/1", name: "inspect", arguments: '{"path":' }]),
    { role: "toolResult", toolCallId: "call/1", content: [{ type: "image", mimeType: "image/png", data: "" }] },
    { role: "toolResult", toolCallId: "call/2", isError: true, content: [{ type: "audio", mimeType: "audio/wav", data: "AQ==" }] },
    { role: "toolResult", toolCallId: "call/3", content: [{ type: "text", text: "settled" }] }] };
  const before = structuredClone(input), result = prepareBedrockReplay(input, model);
  assert.deepEqual(input, before);
  assert.deepEqual(result.messages[0].content[0].toolUse, { toolUseId: "call_1", name: "inspect", input: {} });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[1].content.map(block => block.toolResult.content), [[{ text: "(no output)" }], [{ text: "(see attached audio)" }], [{ text: "settled" }]]);
  assert.equal(result.messages[1].content[1].toolResult.status, "error");
});

test("signed/redacted reasoning survives same-model replay; cross-model opaque content is dropped", () => {
  const blocks = [{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "signed-fixture" }, { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "AQID", redacted: true }, { type: "text", text: "answer" }];
  const input = { messages: [assistant(blocks)] };
  assert.deepEqual(prepareBedrockReplay(input, model).messages[0].content, [{ reasoningContent: { reasoningText: { text: "visible reasoning", signature: "signed-fixture" } } }, { reasoningContent: { redactedContent: "AQID" } }, { text: "answer" }]);
  assert.deepEqual(prepareBedrockReplay(input, { ...model, id: "anthropic.claude-haiku-4-5-20251001-v1:0" }).messages[0].content, [{ text: "visible reasoning" }, { text: "answer" }]);
  assert.deepEqual(prepareBedrockReplay({ messages: [assistant([{ type: "thinking", thinking: "omit sentinel", thinkingSignature: "reasoning_content" }, { type: "text", text: "answer" }])] }, model).messages[0].content, [{ text: "answer" }]);
  assert.throws(() => prepareBedrockReplay({ messages: [assistant([{ type: "thinking", redacted: true }])] }, model), /invalid_bedrock_base64/);
});

test("GPT-5.6 Sol lifts tool images after contiguous results without mutating stored history", () => {
  const input = { tools: [tool], messages: [{ role: "toolResult", toolCallId: "a", content: [{ type: "image", mimeType: "image/png", data: "AQID" }] }, { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "second" }] }] };
  const before = structuredClone(input), result = prepareBedrockReplay(input, { ...model, id: "openai.gpt-5.6-sol", claude: false });
  assert.deepEqual(input, before);
  const content = result.messages[0].content;
  assert.equal(content[0].toolResult.content[0].text, '(see attached images labeled "Images from tool result a")');
  assert.equal(content[1].toolResult.toolUseId, "b");
  assert.equal(content[2].text, "Images from tool result a:");
  assert.deepEqual(content[3], { image: { format: "png", source: { bytes: "AQID" } } });
});

test("portable base64, Unicode cleanup and collision guards reject corrupt replay", () => {
  assert.equal(bedrockBase64(" YQ \n"), "YQ==");
  for (const value of ["?", "A", "YR==", "", "===="]) assert.throws(() => bedrockBase64(value), /invalid_bedrock_base64/);
  assert.equal(prepareBedrockReplay({ messages: [{ role: "user", content: "\ud800x\udc00" }] }, model).messages[0].content[0].text, "\ufffdx\ufffd");
  assert.throws(() => prepareBedrockReplay({ tools: [tool], messages: [assistant([{ type: "toolCall", id: "a/b", name: "inspect", arguments: {} }, { type: "toolCall", id: "a?b", name: "inspect", arguments: {} }])] }, model), /tool_id_collision/);
});

test("system cache boundaries and the two user checkpoints exclude volatile prefixes", () => {
  const cachePoint = { type: "default", ttl: "1h" };
  assert.deepEqual(buildBedrockSystemPrompt("stable\n<!-- OPENCLAW_CACHE_BOUNDARY -->\ndynamic", cachePoint), [{ text: "stable" }, { cachePoint }, { text: "dynamic" }]);
  const messages = [{ role: "user", content: "old" }, assistant([{ type: "text", text: "old answer" }]), { role: "user", content: "recent" }, { role: "user", content: "runtime context" }, { role: "user", content: "new" }];
  const result = prepareBedrockReplay({ messages }, model, { cachePoint }, new Set([3]));
  assert.deepEqual(result.messages.map(message => message.content.some(block => block.cachePoint)), [true, false, true, false, false]);
  assert.equal(prepareBedrockReplay({ messages }, { ...model, bindsThinkingPrefix: true }, { cachePoint }, new Set([3])).messages[4].content.at(-1).cachePoint.ttl, "1h");
});

test("stable tool order and adaptive tool choice retain the native schema", () => {
  const input = { tools: [{ ...tool, name: "z" }, { ...tool, name: "a" }], messages: [{ role: "user", content: "fixture" }] };
  const result = prepareBedrockReplay(input, model, { adaptiveThinking: true, toolChoice: { type: "tool", name: "z" } });
  assert.deepEqual(result.toolConfig.tools.map(value => value.toolSpec.name), ["a", "z"]);
  assert.deepEqual(result.toolConfig.toolChoice, { auto: {} });
  assert.deepEqual(result.toolConfig.tools[0].toolSpec.inputSchema, { json: { type: "object" } });
});

test("Converse and ConverseStream bind the selected model/ARN in the encoded path", () => {
  const body = { modelId: "caller-alias", stream: true, messages: [{ role: "user", content: [{ text: "fixture" }] }], additionalModelRequestFields: { thinking: { type: "adaptive" } }, requestMetadata: { fixture: "public" } };
  const before = structuredClone(body), arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/fixture";
  for (const stream of [false, true]) {
    const result = prepareBedrockConverseRequest(body, arn, stream);
    assert.equal(result.path, `/model/${encodeURIComponent(arn)}/converse${stream ? "-stream" : ""}`);
    assert.equal(result.body.modelId, undefined); assert.equal(result.body.stream, undefined);
    assert.deepEqual(result.body.additionalModelRequestFields, body.additionalModelRequestFields);
  }
  assert.deepEqual(body, before);
  assert.throws(() => prepareBedrockConverseRequest(body, "\ninvalid", true), /invalid_bedrock_model/);
});

test("usage includes cache tokens exactly once, floors inconsistent totals, and preserves TTL buckets", () => {
  assert.deepEqual(extractBedrockConverseUsage(usage), expectedUsage);
  assert.deepEqual(extractBedrockConverseUsage({ inputTokens: 0, outputTokens: 0 }), { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null });
  for (const value of [{}, { inputTokens: 1 }, { ...usage, inputTokens: "50" }, { ...usage, cacheReadInputTokens: null }, { ...usage, outputTokens: -1 }, { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }, { ...usage, cacheDetails: [{ ttl: "1h", inputTokens: 5 }] }]) assert.equal(extractBedrockConverseUsage(value), null);
});

test("unary text/reasoning/tools decode with native usage and content-free refusal", () => {
  const content = [{ text: "answer" }, { reasoningContent: { reasoningText: { text: "reasoning", signature: "fixture" } } }, { toolUse: { toolUseId: "call-0", name: "inspect", input: { path: "fixture" } } }];
  const body = { output: { message: { role: "assistant", content } }, stopReason: "tool_use", usage };
  const result = decodeBedrockConverseResponse(body);
  assert.equal(result.stop, "toolUse"); assert.deepEqual(result.content, content); assert.deepEqual(result.inspection, { outcome: "success", tokens: expectedUsage });
  const refusal = decodeBedrockConverseResponse({ ...body, stopReason: "refusal", additionalModelResponseFields: { stop_details: { message: "private provider text" } } });
  assert.equal(refusal.error, "bedrock_refusal"); assert.deepEqual(refusal.content, []); assert.equal(JSON.stringify(refusal).includes("private provider text"), false);
});

test("streamed text needs messageStop, accepts metadata after stop and preserves length reason", () => {
  assert.deepEqual(decode([start, text, stop, meta]), { content: [{ text: "synthetic answer" }], stop: "stop", inspection: { tokens: expectedUsage, outcome: "success" }, error: null });
  assert.equal(decode([start, text, { messageStop: { stopReason: "model_context_window_exceeded" } }]).stop, "length");
  for (const [events, ended] of [[[start, text, meta], true], [[start, text, stop, meta], false], [[text, stop, meta], true], [[start, text, stop, text], true]]) {
    assert.deepEqual(decode(events, ended).inspection, { tokens: null, outcome: null });
  }
});

test("streamed tool siblings validate atomically after complete blocks", () => {
  const prefix = [start, call(0), delta(0, { toolUse: { input: '{"path":' } }), delta(0, { toolUse: { input: '"fixture"}' } }), closed(0)];
  const good = decode([...prefix, { messageStop: { stopReason: "tool_use" } }, meta]);
  assert.deepEqual(good.content[0].toolUse.input, { path: "fixture" });
  for (const suffix of [[call(1), delta(1, { toolUse: { input: '{"unfinished":' } }), closed(1)], [call(1)], [call(1), delta(1, { toolUse: { input: "[]" } }), closed(1)]]) {
    const result = decode([...prefix, ...suffix, stop, meta]);
    assert.deepEqual(result.content, []); assert.equal(result.inspection.outcome, null);
  }
});

test("reasoning signatures and redacted byte chunks round-trip once at the boundary", () => {
  const events = [start, delta(0, { reasoningContent: { text: "reason" } }), delta(0, { reasoningContent: { signature: "sig" } }), closed(0), delta(1, { reasoningContent: { redactedContent: "AQI=" } }), delta(1, { reasoningContent: { redactedContent: "AwQ=" } }), closed(1), stop, meta];
  const before = structuredClone(events), result = decode(events);
  assert.deepEqual(events, before);
  assert.deepEqual(result.content, [{ reasoningContent: { reasoningText: { text: "reason", signature: "sig" } } }, { reasoningContent: { redactedContent: "AQIDBA==" } }]);
  const replay = prepareBedrockReplay({ messages: [assistant([{ type: "thinking", redacted: true, thinkingSignature: result.content[1].reasoningContent.redactedContent }])] }, model);
  assert.deepEqual(replay.messages[0].content, [result.content[1]]);
});

test("HTTP-200 stream exceptions and refusals never expose buffered output or provider prose", () => {
  for (const key of ["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"]) {
    const result = decode([start, text, { [key]: { message: "private prompt" } }]);
    assert.deepEqual(result.content, []); assert.equal(result.inspection.outcome, "provider_error"); assert.equal(result.error, `bedrock_${key}`);
    assert.equal(JSON.stringify(result).includes("private prompt"), false);
  }
  const refused = decode([start, text, { messageStop: { stopReason: "refusal", additionalModelResponseFields: { stopDetails: "private" } } }, meta]);
  assert.deepEqual(refused.content, []); assert.equal(refused.error, "bedrock_refusal");
});

test("unknown/malformed/oversized event evidence stays unavailable and sealed decoders cannot change", () => {
  for (const event of [{ mystery: {} }, { contentBlockDelta: { contentBlockIndex: 4096, delta: { text: "x" } } }, delta(0, { text: "x", reasoningContent: { text: "x" } }), delta(0, { text: "x".repeat(bedrockConverseLimit) })]) assert.equal(decode([start, event, stop, meta]).inspection.outcome, null);
  const decoder = createBedrockConverseDecoder(); [start, text, stop, meta].forEach(event => decoder.accept(event));
  const first = decoder.result(); decoder.accept({ internalServerException: {} }); assert.deepEqual(decoder.result(), first);
});
