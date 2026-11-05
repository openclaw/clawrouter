import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { prepareVeniceChatBinding: prepare, validateVeniceReturnedModel: validate } = await import("../venice-chat-binding.ts");
const selected = "claude-fable-5", other = "zai-org-glm-5-2";
const requestError = error => error.status === 400 && error.code === "invalid_venice_chat_request";
const fallbackError = error => error.status === 400 && error.code === "unsupported_venice_fallbacks";
const responseError = error => error.status === 502 && error.code === "invalid_venice_returned_model";
const binding = () => prepare({ model: selected }, selected);

test("Venice Chat binds the literal Fable model without mutating native request or replay", () => {
  const body = Object.freeze({ model: selected, stream: true, messages: Object.freeze([
    Object.freeze({ role: "assistant", content: "", reasoning_content: "synthetic-replay", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }),
    Object.freeze({ role: "tool", tool_call_id: "call_fixture", content: "synthetic-result" }),
  ]), tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { fallbacks: { type: "array" } } } } }] });
  const before = JSON.stringify(body), result = prepare(body, selected);
  assert.deepEqual(result, { selectedUpstreamModel: selected });
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.selectedUpstreamModel = other; }, TypeError);
  assert.equal(JSON.stringify(body), before);
});

test("Venice Chat rejects absent or malformed selected identities and request bodies", () => {
  for (const value of [null, undefined, "", " \t", 1, {}, []]) assert.throws(() => prepare({ model: value }, value), requestError);
  for (const body of [null, undefined, [], selected, {}, { model: null }, { model: 1 }, Object.create({ model: selected })])
    assert.throws(() => prepare(body, selected), requestError);
});

test("Venice Chat does not normalize router prefixes, whitespace, casing or different models", () => {
  for (const model of [`venice/${selected}`, ` ${selected}`, `${selected} `, selected.toUpperCase(), other, "default", "fastest"])
    assert.throws(() => prepare({ model }, selected), requestError);
});

for (const model of [selected, other]) test(`Venice Chat ${model} rejects every top-level fallbacks value`, () => {
  for (const fallbacks of [undefined, null, [], false, "", {}, [{ model: other }], [{ model }], Array(10).fill({ model: other }), Array(11).fill({ model: other })]) {
    const body = { model, fallbacks };
    assert.throws(() => prepare(body, model), fallbackError);
    assert.equal(Object.hasOwn(body, "fallbacks"), true);
    assert.equal(body.fallbacks, fallbacks);
  }
});

test("Venice Chat rejects fallback property presence without evaluating or removing its value", () => {
  const body = { model: selected };
  Object.defineProperty(body, "fallbacks", { get() { throw new Error("synthetic-private-value"); } });
  assert.throws(() => prepare(body, selected), fallbackError);
  const inherited = Object.assign(Object.create({ fallbacks: [] }), { model: selected });
  assert.throws(() => prepare(inherited, selected), fallbackError);
});

test("Venice returned JSON model confirms only the selected identity and leaves native content intact", () => {
  const payload = { id: "chatcmpl_fixture", object: "chat.completion", model: selected,
    choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, cost: { usd: 0.1, diem: 0.2 } };
  const before = structuredClone(payload);
  assert.equal(validate(binding(), payload), selected);
  assert.deepEqual(payload, before);
});

test("Venice validates every parsed SSE model observation without inheriting a previous frame identity", () => {
  const bound = binding();
  for (const delta of [{ role: "assistant", reasoning_content: "synthetic-reasoning" },
    { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "}" } }] }]) {
    const frame = { id: "chatcmpl_fixture", object: "chat.completion.chunk", model: selected, choices: [{ index: 0, delta }] };
    assert.equal(validate(bound, frame), selected);
  }
  assert.throws(() => validate(bound, { object: "chat.completion.chunk", choices: [{ delta: { content: "synthetic-answer" } }] }), responseError);
  assert.throws(() => validate(bound, { model: other, choices: [{ delta: { content: "synthetic-answer" } }] }), responseError);
});

test("Venice rejects a permissioned but unrequested returned model", () => {
  const permitted = new Set([selected, other]);
  assert.equal(permitted.has(other), true);
  assert.throws(() => validate(binding(), { model: other }), responseError);
});

test("Venice returned identity must be an explicit matching string", () => {
  for (const payload of [null, undefined, [], selected, {}, { model: null }, { model: 1 }, { model: {} }, { model: "" },
    { model: `venice/${selected}` }, { model: `${selected} ` }, { model: selected.toUpperCase() },
    { choices: [{ model: selected }] }, Object.create({ model: selected })])
    assert.throws(() => validate(binding(), payload), responseError);
});

test("Venice model-less SSE metadata and framing sent to the payload validator fail closed", () => {
  for (const payload of [{ choices: [], usage: { total_tokens: 5 } }, { model: undefined, choices: [] }, "[DONE]", ": heartbeat"])
    assert.throws(() => validate(binding(), payload), responseError);
});

test("Venice malformed bindings do not permit matching invalid response identities", () => {
  for (const value of [null, undefined, {}, [], { selectedUpstreamModel: null }, { selectedUpstreamModel: "" }, { selectedUpstreamModel: 1 }])
    assert.throws(() => validate(value, { model: value?.selectedUpstreamModel }), responseError);
});

test("Venice validation errors never echo request, model, content or billing data", () => {
  const secret = "synthetic-private-content";
  for (const run of [() => prepare({ model: secret, messages: [secret] }, selected),
    () => prepare({ model: selected, fallbacks: [{ model: secret }] }, selected),
    () => validate(binding(), { model: secret, choices: [secret], cost: { usd: secret } })]) {
    assert.throws(run, error => {
      assert.doesNotMatch(JSON.stringify({ code: error.code, message: error.message }), /synthetic-private-content|claude-fable-5/);
      return error.status === 400 || error.status === 502;
    });
  }
});

test("Venice binding helper loads through native Node runtime imports", () => {
  const url = new URL("../venice-chat-binding.ts", import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(url)}); const b = m.prepareVeniceChatBinding({model: "claude-fable-5"}, "claude-fable-5"); if (m.validateVeniceReturnedModel(b, {model: "claude-fable-5"}) !== "claude-fable-5") throw new Error("binding failed");`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }), "");
});
