import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesToolEvidence, createToolEvidenceProjection, retainedToolBase, toolEvidenceLimit } from "../responses-tool-evidence.ts";

const tools = values => ({ input: [{ type: "additional_tools", tools: values }] });
const terminal = (extra = {}) => ({ type: "response.completed", response: { id: "response_fixture", ...extra } });
const done = (item, extra = {}) => ({ type: "response.output_item.done", item, ...extra });
const added = (item, extra = {}) => ({ type: "response.output_item.added", item, ...extra });
function reduce(events, base = "token_only") {
  const evidence = createResponsesToolEvidence(base);
  for (const event of events) evidence.accept(event, true);
  return evidence.result();
}

function* tokens(value) {
  if (Array.isArray(value)) {
    yield { name: "startArray" }; for (const child of value) yield* tokens(child); yield { name: "endArray" };
  } else if (value && typeof value === "object") {
    yield { name: "startObject" };
    for (const [key, child] of Object.entries(value)) {
      yield { name: "startKey" }; yield { name: "stringChunk", value: key }; yield { name: "endKey" }; yield* tokens(child);
    }
    yield { name: "endObject" };
  } else if (typeof value === "string" || typeof value === "number") {
    const kind = typeof value === "string" ? "String" : "Number";
    yield { name: `start${kind}` }; yield { name: `${kind.toLowerCase()}Chunk`, value: String(value) }; yield { name: `end${kind}` };
  } else yield { name: value === null ? "nullValue" : value ? "trueValue" : "falseValue", value };
}
function project(value) {
  const projection = createToolEvidenceProjection();
  for (const token of tokens(value)) projection.accept(token);
  return projection;
}

test("projection charges each selected object, array and scalar exactly once", () => {
  const kinds = [null, true, false, 12, "malformed", [null, null], {}];
  const tools = Array.from({ length: toolEvidenceLimit - 1 }, (_, index) => kinds[index % kinds.length]);
  const value = { output: [{ type: "additional_tools", tools }] };
  assert.equal(project(value).value().output[0].tools.length, toolEvidenceLimit - 1);
  tools.push(null);
  assert.equal(project(value).value(), undefined, "the enclosing output item also consumes one entry");
});

test("projection discards aggregate overflow across individually bounded namespace arrays", () => {
  for (const child of [null, true, false, 1, "malformed", [null], {}]) {
    const tools = Array.from({ length: 2 }, () => ({ type: "namespace", name: "fixture", tools: Array(511).fill(child) }));
    const projection = project({ output: [{ type: "additional_tools", tools }] });
    assert.equal(projection.value(), undefined, JSON.stringify(child));
    for (const token of tokens({ output: [] })) projection.accept(token);
    assert.equal(projection.value(), undefined, "later tokens cannot restore discarded evidence");
  }
});

test("only complete supported declaration inventories certify token-only history", () => {
  for (const tool of [
    { type: "function", name: "web_search", parameters: { type: "web_search" } },
    { type: "custom", name: "tool" }, { type: "tool_search", execution: "client" },
    { type: "namespace", name: "fixture", tools: [{ type: "function", name: "run" }, { type: "custom", name: "raw" }] },
    { type: "shell", environment: { type: "local" } }, { type: "apply_patch" },
    { type: "computer" }, { type: "computer_use_preview", display_width: 800, display_height: 600, environment: "browser" },
  ]) assert.equal(retainedToolBase(tools([tool]), "token_only"), "token_only", JSON.stringify(tool));
  for (const value of [undefined, null, {}, "web_search", [{ type: "new_executor" }], [{ type: "function" }], [{ type: "shell" }], [{ type: "tool_search", execution: "new_executor" }], [{ type: "computer_use_preview" }], [{ type: "namespace", name: "fixture", tools: [{ type: "namespace", name: "nested", tools: [] }] }]]) {
    assert.equal(retainedToolBase(tools(value), "token_only"), "unknown", JSON.stringify(value));
  }
  for (const type of ["web_search", "file_search", "code_interpreter", "image_generation"]) assert.equal(retainedToolBase(tools([{ type }]), "token_only"), "hosted_tool_fee");
  for (const tool of [{ type: "mcp" }, { type: "tool_search", execution: "server" }, { type: "programmatic_tool_calling" }]) assert.equal(retainedToolBase(tools([tool]), "token_only"), "hosted_tool_usage");
});

test("retained base is independent of tariff and excludes current top-level tool configuration", () => {
  assert.equal(retainedToolBase({ tools: [{ type: "web_search" }], input: "ordinary text" }, "token_only"), "token_only");
  assert.equal(retainedToolBase({ input: [{ role: "user", content: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] }] }, "token_only"), "token_only");
  for (const type of ["compaction", "context_compaction", "item_reference", "compaction_trigger", "future_item", "mcp_list_tools"]) assert.equal(retainedToolBase({ input: [{ type }] }, "token_only"), "unknown");
  for (const body of [{ conversation: "opaque" }, { prompt: { id: "opaque" } }, { input: [{ id: "item_reference" }] }]) assert.equal(retainedToolBase(body, "token_only"), "unknown");
  for (const knowledge of ["unknown", "hosted_tool_usage", "hosted_tool_fee"]) assert.equal(retainedToolBase({ input: [] }, knowledge), knowledge);
});

test("Codex anonymous done-only items and sparse matching completion qualify", () => {
  const result = reduce([done({ type: "message", role: "assistant", content: "first" }), done({ type: "tool_search_call", execution: "client", arguments: {} }), terminal()]);
  assert.deepEqual(result, { responseId: "response_fixture", knowledge: "token_only" });
  assert.equal(reduce([done({ type: "tool_search_output", execution: "client", status: "completed", tools: [{ type: "web_search" }] }), terminal()]).knowledge, "hosted_tool_fee");
});

test("item association rejects unresolved additions, alias conflicts and conflicting duplicates", () => {
  const message = { id: "a", type: "message" };
  const cases = [
    [added(message, { output_index: 0 })],
    [added({ type: "message" }), done({ type: "message" })],
    [done(message, { output_index: 0 }), done({ ...message, id: "b" }, { output_index: 0 })],
    [done(message, { output_index: 0 }), done(message, { output_index: 1 })],
    [added(message, { output_index: 0 }), added({ id: "b", type: "message" }, { output_index: 1 }), done({ id: "b", type: "message" }, { output_index: 0 })],
    [done({ id: "a", type: "additional_tools", tools: [] }), done({ id: "a", type: "additional_tools", tools: [{ type: "web_search" }] })],
    [done({ id: "a", type: "additional_tools", status: "incomplete", tools: [] })],
    [done(message, { output_index: -1 })],
    [added({ id: "a", type: "additional_tools", tools: [{ type: "web_search" }] }), done({ id: "a", type: "additional_tools", tools: [] })],
  ];
  for (const events of cases) assert.equal(reduce([...events, terminal()]).knowledge, "unknown", JSON.stringify(events));
  assert.equal(reduce([added(message, { output_index: 0 }), done(message, { output_index: 0 }), done(message), terminal({ output: [message] })]).knowledge, "token_only");
});

test("terminal output is inspected and cannot erase streamed declarations or conflicts", () => {
  const item = { id: "a", type: "additional_tools", tools: [{ type: "web_search" }] };
  assert.equal(reduce([done(item, { output_index: 0 }), terminal({ output: [item] })]).knowledge, "hosted_tool_fee");
  for (const output of [[], {}, null, [{ id: "a", type: "message" }], [{ ...item, tools: [] }]]) assert.equal(reduce([done(item, { output_index: 0 }), terminal({ output })]).knowledge, "unknown");
  assert.equal(reduce([terminal({ output: [{ type: "future_executor" }] })]).knowledge, "unknown");
  assert.equal(reduce([done({ type: "message", status: "incomplete" }), { type: "response.incomplete", response: { id: "response_fixture" } }]).knowledge, "token_only");
});

test("malformed, mismatched, overflow and late events never promote clean knowledge", () => {
  assert.equal(reduce([{ type: "response.created", response: { id: "first" } }, terminal()]).knowledge, "unknown");
  const evidence = createResponsesToolEvidence("token_only");
  evidence.invalid(); evidence.accept(terminal(), true);
  assert.equal(evidence.result().knowledge, "unknown");
  const events = Array.from({ length: toolEvidenceLimit + 1 }, (_, output_index) => done({ type: "message" }, { output_index }));
  assert.equal(reduce([...events, terminal()]).knowledge, "unknown");
  assert.equal(reduce([terminal(), done({ type: "additional_tools", tools: [{ type: "web_search" }] }), terminal()]).knowledge, "token_only", "first terminal freezes the proof");
  assert.equal(reduce([{ type: "response.failed", response: { id: "response_fixture" } }, terminal()]).knowledge, "unknown");
  assert.equal(reduce([done({ type: "message" })]), null, "missing terminal leaves the durable claim pending");
  assert.equal(reduce([{ type: "response.future_declarations", tools: [{ type: "web_search" }] }, terminal()]).knowledge, "unknown");
  assert.equal(reduce([{ type: "response.compaction.compacting" }, terminal()]).knowledge, "unknown");
  assert.equal(reduce([{ type: "response.output_text.delta", delta: "web_search" }, { type: "response.reasoning_summary_text.done", text: "ordinary text" }, terminal()]).knowledge, "token_only");
});
