import assert from "node:assert/strict";
import test from "node:test";
import { decodeCopilotModelCatalog } from "../provider-copilot-catalog.ts";
import { copilotModelFormats, filterCopilotModels } from "../provider-copilot.ts";

const message = "invalid_copilot_model_catalog";
const row = (id = "fixture-model", patch = {}) => ({ id, model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: ["/responses"], ...patch });
const decode = data => decodeCopilotModelCatalog(JSON.stringify({ data }));
const reject = text => assert.throws(() => decodeCopilotModelCatalog(text), { message });

test("data-only native envelope and authoritative empty projection do not require OpenAI object:list", () => {
  assert.deepEqual(decodeCopilotModelCatalog('{"data":[],"provider_metadata":{"future":true}}'), { data: [] });
  const result = decode([row()]);
  assert.equal(result.data[0].id, "fixture-model");
  assert.equal(Object.isFrozen(result) && Object.isFrozen(result.data) && Object.isFrozen(result.data[0]), true);
  assert.deepEqual(filterCopilotModels(result, () => false), { data: [] });
  assert.deepEqual(decode([]), { data: [] });
});

test("empty, disabled, unconfigured and hidden rows never resurrect static seeds", () => {
  for (const patch of [{ model_picker_enabled: false }, { model_picker_enabled: undefined }, { policy: { state: " DISABLED " } }, { policy: { state: " Unconfigured " } }]) assert.deepEqual(decode([row("fixture", patch)]), { data: [] });
  for (const policy of [undefined, {}, { state: "future-policy" }]) {
    const result = decode([row("fixture", { policy })]);
    assert.equal(result.data.length, 1);
    assert.equal("entitled" in result.data[0], false);
    assert.deepEqual(filterCopilotModels(result, () => false), { data: [] });
  }
});

test("known non-chat objects and internal router IDs are excluded, not remapped", () => {
  const result = decode([row("embedding", { capabilities: { type: "embedding" } }), row("router", { object: "router" }), row("accounts/fixture/router"), row("chat", { object: "model", capabilities: { type: "chat" } })]);
  assert.deepEqual(result.data.map(value => value.id), ["chat"]);
  assert.deepEqual(decode([row("claude-looking-name", { supported_endpoints: undefined }), row("gpt-looking-name", { supported_endpoints: [] }), row("unknown", { supported_endpoints: ["/future"] })]), { data: [] });
});

test("normalized IDs are trimmed only, preserving case, Unicode and internal characters", () => {
  const values = [" MiXeD/model alias ", "mixed/model alias", "模型-1", "é", "e\u0301"];
  assert.deepEqual(decode(values.map(id => row(id))).data.map(value => value.id), values.map(id => id.trim()));
  assert.equal(decode([row(" "+"😀".repeat(256)+" ")]).data[0].id.length, 512);
  assert.equal(decode([row("x".repeat(512))]).data[0].id.length, 512);
  for (const id of ["", " \t\n", null, 1, {}, "x".repeat(513), "😀".repeat(257)]) reject(JSON.stringify({ data: [row(id)] }));
});

test("post-trim duplicates deny the whole response including excluded rows in either order", () => {
  const exclusions = [{ model_picker_enabled: false }, { policy: { state: "disabled" } }, { policy: { state: "unconfigured" } }, { object: "embedding" }, { capabilities: { type: "embedding" } }, { supported_endpoints: [] }];
  for (const patch of exclusions) {
    for (const values of [[row("same", patch), row(" same ")], [row("same"), row(" same ", patch)]]) reject(JSON.stringify({ data: values }));
  }
  reject(JSON.stringify({ data: [row("accounts/internal"), row(" accounts/internal ")] }));
  reject(JSON.stringify({ data: [row(" ", { model_picker_enabled: false })] }));
});

test("4096 raw rows are admitted; 4097 are rejected before filtering", () => {
  const data = Array.from({ length: 4096 }, (_, index) => row(`fixture-${index}`));
  assert.equal(decode(data).data.length, 4096);
  assert.deepEqual(decode(data.map(value => ({ ...value, model_picker_enabled: false }))), { data: [] });
  reject(JSON.stringify({ data: [...data, row("extra")].map(value => ({ ...value, model_picker_enabled: false })) }));
});

test("2 MiB means actual UTF-8 bytes and is checked before JSON.parse", () => {
  const cap = 2 * 1024 * 1024, base = '{"data":[],"padding":""}';
  const exact = '{"data":[],"padding":"' + "x".repeat(cap - Buffer.byteLength(base)) + '"}';
  assert.equal(Buffer.byteLength(exact), cap);
  assert.deepEqual(decodeCopilotModelCatalog(exact), { data: [] });
  const over = '{"data":[],"padding":"' + "é".repeat(cap / 2) + '"}';
  assert.ok(over.length < cap && Buffer.byteLength(over) > cap);
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => { calls++; return original(...args); };
  try { reject(exact + " "); reject(over); assert.equal(calls, 0); }
  finally { JSON.parse = original; }
});

test("depth 64 is allowed; deeper object/array graphs are rejected before allocation", () => {
  const arrays = depth => '{"data":[],"extra":' + "[".repeat(depth) + "0" + "]".repeat(depth) + "}";
  const objects = depth => '{"data":[],"extra":' + '{"x":'.repeat(depth) + "0" + "}".repeat(depth) + "}";
  for (const build of [arrays, objects]) assert.deepEqual(decodeCopilotModelCatalog(build(63)), { data: [] });
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => { calls++; return original(...args); };
  try { for (const build of [arrays, objects]) reject(build(64)); assert.equal(calls, 0); }
  finally { JSON.parse = original; }
});

test("preparse nesting scan treats escaped quotes, backslashes and braces inside strings as data", () => {
  const name = 'quoted "' + "\\".repeat(4) + "[{}]".repeat(100) + '\\"tail';
  assert.equal(decode([row("fixture", { name })]).data[0].name, name);
  for (const text of ['{"data":[]} trailing', '{"data":[}', '{"data":[],"x":"unterminated', '{"data":[],"x":"escaped\\"}', "}", "{"]) reject(text);
});

test("malformed authority containers and flags fail even on excluded rows", () => {
  const patches = [];
  for (const value of [null, [], "enabled", 1, true]) {
    patches.push({ policy: value }, { capabilities: value }, { capabilities: { limits: value } }, { capabilities: { supports: value } });
  }
  for (const value of [null, [], {}, 1, false]) patches.push({ policy: { state: value } }, { object: value }, { capabilities: { type: value } });
  for (const value of [null, [], {}, 1, "true"]) patches.push({ model_picker_enabled: value }, { preview: value }, ...["vision", "streaming", "tool_calls"].map(key => ({ capabilities: { supports: { [key]: value } } })));
  patches.push({ supported_endpoints: null }, { supported_endpoints: "responses" }, { supported_endpoints: ["/responses", 1] }, { capabilities: { supports: { reasoning_effort: ["high", 1] } } }, { capabilities: { supports: { reasoning_effort: "high" } } });
  for (const patch of patches) {
    reject(JSON.stringify({ data: [row("fixture", patch)] }));
    reject(JSON.stringify({ data: [row("accounts/excluded", patch)] }));
  }
});

test("structural errors are content-free and never return a partially parsed catalog", () => {
  for (const payload of [null, [], {}, { data: {} }, { data: [null] }, { data: [row(), "synthetic-private-detail"] }, { data: [row(), { id: "bad", policy: "synthetic-private-detail" }] }]) reject(JSON.stringify(payload));
  reject("synthetic-private-detail");
});

test("context, prompt and output facts remain distinct positive safe integers", () => {
  const facts = { max_context_window_tokens: 123456, max_prompt_tokens: 234567, max_output_tokens: 3456 };
  assert.deepEqual(decode([row("fixture", { capabilities: { limits: facts } })]).data[0].capabilities.limits, facts);
  for (const field of Object.keys(facts)) {
    for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "8192", true, {}, []]) {
      const observed = decode([row("fixture", { capabilities: { limits: { ...facts, [field]: value } } })]).data[0].capabilities.limits;
      assert.equal(Object.hasOwn(observed, field), false);
      for (const other of Object.keys(facts).filter(key => key !== field)) assert.equal(observed[other], facts[other]);
    }
  }
  assert.equal(decode([row("fixture", { capabilities: { limits: { max_output_tokens: Number.MAX_SAFE_INTEGER } } })]).data[0].capabilities.limits.max_output_tokens, Number.MAX_SAFE_INTEGER);
});

test("missing facts stay absent; explicit false/empty facts survive without starter or inference permission", () => {
  const missing = decode([row()]).data[0];
  assert.equal("capabilities" in missing, false);
  const present = decode([row("fixture", { preview: false, capabilities: { supports: { vision: false, streaming: false, tool_calls: false, reasoning_effort: [] }, limits: {} } })]).data[0];
  assert.deepEqual(present.capabilities, { supports: { vision: false, streaming: false, tool_calls: false, reasoning_effort: [] }, limits: {} });
  assert.equal(present.preview, false);
  assert.equal(Object.isFrozen(present.capabilities) && Object.isFrozen(present.capabilities.supports) && Object.isFrozen(present.capabilities.limits), true);
  assert.deepEqual(filterCopilotModels({ data: [present] }, () => false), { data: [] });
});

test("reported reasoning and vision facts do not supply missing modalities, limits or prices", () => {
  const result = decode([row("fixture", { capabilities: { supports: { vision: true, reasoning_effort: [" HIGH ", "high", "future-effort", ""] } }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, premium_multiplier: 0, billing: { multiplier: 2 }, maxTokens: 8192, contextWindow: 128000 })]);
  assert.deepEqual(result.data[0].capabilities.supports, { vision: true, reasoning_effort: ["high", "future-effort"] });
  for (const field of ["cost", "pricing", "premium_multiplier", "billing", "maxTokens", "contextWindow", "input", "output", "entitled"]) assert.equal(field in result.data[0], false);
  assert.equal("limits" in result.data[0].capabilities, false);
  assert.equal(decode([row("fixture", { capabilities: { supports: { reasoning_effort: null } } })]).data[0].capabilities.supports.reasoning_effort, null);
});

// Frozen OpenClaw 31ad71a manifest / qualified848 fixtures: 8 Messages,
// 4 Chat and 7 Responses. No new IDs, inferred transport or retirement dates.
const frozen = [
  ["claude-fable-5", "anthropic.messages"], ["claude-opus-5.5", "anthropic.messages"],
  ["claude-opus-5", "anthropic.messages"], ["claude-sonnet-5.5", "anthropic.messages"],
  ["claude-sonnet-5", "anthropic.messages"], ["claude-haiku-4.5", "anthropic.messages"],
  ["claude-opus-4.8", "anthropic.messages"], ["claude-sonnet-4.6", "anthropic.messages"],
  ["gemini-3.6-flash", "openai.chat_completions"], ["gemini-3.1-pro-preview", "openai.chat_completions"],
  ["gemini-3.5-flash", "openai.chat_completions"], ["gemini-2.5-pro", "openai.chat_completions"],
  ["gpt-5.6-sol", "openai.responses"], ["gpt-5.6-terra", "openai.responses"],
  ["gpt-5.6-luna", "openai.responses"], ["gpt-5.3-codex", "openai.responses"],
  ["gpt-5.4", "openai.responses"], ["gpt-5.5", "openai.responses"], ["gpt-5.4-mini", "openai.responses"],
];
const paths = { "anthropic.messages": "/messages", "openai.chat_completions": "/chat/completions", "openai.responses": "/responses" };
for (const [id, format] of frozen) {
  test(`frozen format requires advertised transport: ${id}`, () => {
    const result = decode([row(id, { supported_endpoints: [` /v1${paths[format]}/ `] })]);
    assert.equal(result.data[0].id, id);
    assert.deepEqual(copilotModelFormats(result.data[0]), [format]);
    assert.deepEqual(decode([row(id, { supported_endpoints: undefined })]), { data: [] });
    assert.deepEqual(decode([row(id, { policy: { state: "unconfigured" } })]), { data: [] });
    assert.deepEqual(filterCopilotModels(result, () => false), { data: [] });
  });
}
