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

test("retained and complete inventories share one aggregate item and declaration budget", () => {
  const functions = count => Array.from({ length: count }, () => ({ type: "function", name: "run" }));
  for (const namespace of [false, true]) for (const extra of [0, 1, 89]) {
    const output = [0, extra].map(increase => ({
      type: "tool_search_output", execution: "client", status: "completed",
      tools: namespace ? [{ type: "namespace", name: "fixture", tools: functions(510 + increase) }] : functions(511 + increase),
    }));
    const knowledge = extra ? "unknown" : "token_only";
    assert.equal(retainedToolBase({ input: output }, "token_only"), knowledge, "the enclosing items and namespace entries count too");
    for (const sse of [false, true]) for (const projected of [false, true]) {
      const value = sse ? terminal({ output }) : { object: "response", id: "response_fixture", status: "completed", output };
      const evidence = createResponsesToolEvidence("token_only");
      evidence.accept(projected ? project(value).value() : value, sse);
      assert.equal(evidence.result()?.knowledge ?? "unknown", knowledge, `${namespace}/${extra}/${sse}/${projected}`);
    }
  }
  const output = Array.from({ length: 2 }, () => ({ type: "tool_search_output", tools: functions(600) }));
  assert.equal(retainedToolBase({ input: output }, "token_only"), "unknown");
  assert.equal(reduce([terminal({ output })]).knowledge, "unknown", "each inventory fits separately, but their aggregate does not");
});

test("unsupported nested inventories never certify recognized declaration kinds", () => {
  for (const nested of [null, [], Array(1024).fill(null)]) for (const type of ["function", "custom"]) {
    const declaration = { type, name: "run", tools: nested };
    for (const tool of [declaration, { type: "namespace", name: "fixture", tools: [declaration] }, { type: "namespace", name: "fixture", tools: [{ type: "namespace", name: "nested", tools: nested }] }]) {
      const output = [{ type: "additional_tools", tools: [tool] }];
      assert.equal(retainedToolBase({ input: output }, "token_only"), "unknown");
      for (const projected of [false, true]) {
        const event = terminal({ output });
        assert.equal(reduce([projected ? project(event).value() : event])?.knowledge ?? "unknown", "unknown");
      }
    }
  }
});

test("stream inventories charge only growth per association and bound terminal snapshots independently", () => {
  const functions = count => Array.from({ length: count }, () => ({ type: "function", name: "run" }));
  for (const extra of [0, 1]) {
    const output = [0, extra].map((increase, index) => ({ id: `item-${index}`, type: "additional_tools", tools: functions(511 + increase) }));
    const events = output.flatMap((item, output_index) => [
      added({ ...item, status: "in_progress", tools: [] }, { output_index }),
      added({ ...item, status: "in_progress" }, { output_index }),
      added({ ...item, status: "in_progress" }), done(item, { output_index }), done(item),
    ]);
    for (const projected of [false, true]) for (const complete of [false, true]) {
      const frames = [...events, terminal(complete ? { output } : {})];
      assert.equal(reduce(projected ? frames.map(frame => project(frame).value()) : frames)?.knowledge ?? "unknown", extra ? "unknown" : "token_only");
    }
  }
  const item = { id: "repeated", type: "additional_tools", tools: functions(600) };
  assert.equal(reduce([added(item), done(item), done(item), terminal({ output: [item] })]).knowledge, "token_only");
  const anonymous = Array.from({ length: 600 }, () => ({ type: "message" }));
  assert.equal(reduce([...anonymous.map(item => done(item)), terminal({ output: anonymous })]).knowledge, "token_only", "a repeated complete snapshot does not assign anonymous positions or double-count entries");
});

test("explicit added inventory uncertainty survives empty completion and repeated terminal output", () => {
  for (const tools of [null, [{ type: "web_search" }, null], [{ type: "future_executor" }], [{ type: "namespace", name: "fixture", tools: [[null]] }]]) {
    const item = { id: "inventory", type: "additional_tools", tools: [] };
    for (const complete of [false, true]) for (const projected of [false, true]) {
      const events = [added({ ...item, status: "in_progress", tools }), done(item), terminal(complete ? { output: [item] } : {})];
      assert.equal(reduce(projected ? events.map(event => project(event).value()) : events).knowledge, "unknown");
    }
  }
  for (const tools of [[], [{ type: "web_search" }]]) for (const projected of [false, true]) {
    const item = { id: "inventory", type: "tool_search_output", execution: "client", tools };
    const events = [added({ id: item.id, type: item.type, status: "in_progress" }), added({ ...item, status: "in_progress" }), done({ ...item, status: "completed" }), terminal()];
    assert.equal(reduce(projected ? events.map(event => project(event).value()) : events).knowledge, tools.length ? "hosted_tool_fee" : "token_only", "absent inventory and transient status do not erase later complete evidence");
  }
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

test("sparse indexed output requires contiguous observed positions without inferring anonymous positions", () => {
  const indexed = index => done({ id: `item-${index}`, type: "message" }, { output_index: index });
  for (const positions of [[1], [0, 2], [Number.MAX_SAFE_INTEGER]]) assert.equal(reduce([...positions.map(indexed), terminal()]).knowledge, "unknown");
  assert.equal(reduce([indexed(1), indexed(0), terminal()]).knowledge, "token_only", "arrival order does not define position");
  assert.equal(reduce([done({ type: "message" }), indexed(1), terminal()]).knowledge, "unknown");
  assert.equal(reduce([indexed(0), done({ id: "item-0", type: "message" }), indexed(1), terminal()]).knowledge, "token_only", "duplicate aliases remain one item");
});

test("complete terminal output fills only entirely unobserved positions", () => {
  const message = { id: "one", type: "message" };
  for (const [first, knowledge] of [
    [{ type: "message" }, "token_only"],
    [{ type: "additional_tools", tools: [{ type: "web_search" }] }, "hosted_tool_fee"],
    [{ type: "future_item" }, "unknown"],
  ]) assert.equal(reduce([done(message, { output_index: 1 }), terminal({ output: [first, message] })]).knowledge, knowledge);
  assert.equal(reduce([added(message, { output_index: 1 }), terminal({ output: [{ type: "message" }, message] })]).knowledge, "unknown", "terminal output never completes an observed added item");
});

test("ordinary event selectors share pending associations and require a matching item.done", () => {
  const item = { id: "call", type: "function_call" };
  for (const selector of [{ output_index: 0 }, { item_id: "call" }, { output_index: 0, item_id: "call" }]) {
    const event = { type: "response.function_call_arguments.delta", ...selector, delta: "{}" };
    assert.deepEqual(project(event).value(), { type: event.type, ...selector }, "HTTP projection preserves the selectors only");
    assert.equal(reduce([event, terminal()]).knowledge, "unknown");
    assert.equal(reduce([event, terminal({ output: [item] })]).knowledge, "unknown", "terminal output never completes a selector reference");
    const completed = done(item, selector.output_index === undefined ? {} : { output_index: 0 });
    assert.equal(reduce([event, completed, terminal()]).knowledge, "token_only");
  }
  const status = { type: "response.web_search_call.completed", output_index: 0, item_id: "search" };
  assert.equal(reduce([status, terminal()]).knowledge, "unknown", "a tool status event is not item.done");
  assert.equal(reduce([status, done({ id: "search", type: "web_search_call" }, { output_index: 0 }), terminal()]).knowledge, "token_only");
});

test("selector references validate aliases and share the existing association bound", () => {
  const reference = selector => ({ type: "response.output_text.delta", ...selector, delta: "fixture" });
  const message = { id: "one", type: "message" };
  for (const frames of [
    [reference({ output_index: 0, item_id: "one" }), reference({ output_index: 0, item_id: "two" })],
    [reference({ output_index: 0, item_id: "one" }), reference({ output_index: 1, item_id: "one" })],
    [reference({ output_index: 0 }), reference({ item_id: "one" })],
    ...[{ output_index: -1 }, { output_index: 0.5 }, { item_id: null }, { item_id: "x".repeat(257) }].map(selector => [reference(selector)]),
  ]) assert.equal(reduce([...frames, done(message, { output_index: 0 }), terminal()]).knowledge, "unknown");
  const references = Array.from({ length: toolEvidenceLimit }, (_, index) => reference({ item_id: `item-${index}` }));
  const completions = references.map((event, output_index) => done({ id: event.item_id, type: "message" }, { output_index }));
  assert.equal(reduce([...references, ...completions, terminal()]).knowledge, "token_only");
  assert.equal(reduce([...references, reference({ item_id: "overflow" }), ...completions, terminal()]).knowledge, "unknown");
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
