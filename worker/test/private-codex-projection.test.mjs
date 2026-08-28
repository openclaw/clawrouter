import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { containResponse } = await import("../private-codex-output.ts");
const alias = "codex-latest";
const target = "SYNTHETIC_SELECTED_TARGET_8T";
const reported = "SYNTHETIC_BACKEND_REPORT_9R";
const upstream = { version: 1, target, accountId: "SYNTHETIC_ACCOUNT_3A", accessToken: "SYNTHETIC_TOKEN_4T", expiresAt: 9999999999999 };
const enc = new TextEncoder();
const responseBody = (extra = {}) => ({ object: "response", id: "synthetic-response", status: "completed", model: target, output: [], ...extra });
const created = (extra = {}) => ({ type: "response.created", response: responseBody({ status: "in_progress", ...extra }) });
const completed = (extra = {}) => ({ type: "response.completed", response: responseBody(extra) });
const delta = (text, extra = {}) => ({ type: "response.output_text.delta", item_id: "synthetic-item", content_index: 0, output_index: 0, delta: text, ...extra });

function sse(events, headers = {}, chunkSize = 17) {
  const bytes = enc.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + chunkSize, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { "content-type": "text/event-stream", ...headers } });
}
const contain = (response, stream = false) => containResponse(response, alias, upstream, stream, new AbortController().signal, () => {});
const parseEvents = (text) => [...text.matchAll(/^data: (.+)$/gm)].filter((match) => match[1] !== "[DONE]").map((match) => JSON.parse(match[1]));
function assertPrivate(text, extras = [reported]) {
  for (const value of [target, upstream.accountId, upstream.accessToken, ...extras]) assert.equal(text.includes(value), false);
}

function arbitraryData() {
  const properties = { model: { type: "object", properties: { error: { type: "string" } } }, error: { type: "string" }, headers: { type: "object" } };
  return {
    tools: [{ type: "function", name: "synthetic_simple", parameters: { type: "object", properties } },
      { type: "namespace", name: "synthetic_namespace", tools: Array.from({ length: 5 }, (_, index) => ({ type: "function", name: `synthetic_${index}`, parameters: { type: "object", properties } })) }],
    metadata: { code: { model: "synthetic-domain-model", error: { message: "synthetic user error" }, headers: ["synthetic-header"], retry_model: "synthetic-data", faster_model: "synthetic-data", auto_review_model_override: "synthetic-data" },
      user: { response: { model: "synthetic-user-model", headers: { "openai-model": "synthetic-user-header" }, error: "synthetic-user-error" } } },
    output: [{ type: "function_call", name: "synthetic_tool", call_id: "synthetic-call", arguments: '{"model":"synthetic-data","error":{"code":1},"headers":{"model":"synthetic-data"}}' }, { type: "reasoning", encrypted_content: "synthetic-encrypted-bytes" }],
  };
}

test("reporting model projection aliases JSON and SSE body identity without changing arbitrary response data", async () => {
  const data = arbitraryData();
  const body = responseBody({ ...data, model: reported, headers: { "OpenAI-Model": target } });
  const json = await contain(Response.json(body, { headers: { "OpenAI-Model": target } }));
  assert.equal(json.status, 200);
  const text = await json.text(); assertPrivate(text); assert.equal(json.headers.get("openai-model"), alias);
  assert.deepEqual(JSON.parse(text), { ...body, model: alias, headers: { "OpenAI-Model": alias } });
  const events = [created({ ...data, model: reported, headers: { "x-openai-model": target } }), completed({ model: reported })];
  const stream = await contain(sse(events, { "OpenAI-Model": target }), true);
  const wire = await stream.text(); assertPrivate(wire); assert.doesNotMatch(wire, /private_upstream_error/);
  assert.deepEqual(parseEvents(wire), [created({ ...data, model: alias, headers: { "x-openai-model": alias } }), completed({ model: alias })]);
});

test("arbitrary response data model/error/headers names never become protocol selectors", async () => {
  const data = arbitraryData();
  const json = await contain(Response.json(responseBody(data)));
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), responseBody({ ...data, model: alias }));
  const stream = await contain(sse([created(data), { type: "response.output_item.done", item: { type: "tool_search_call", arguments: data.metadata } }, completed()]), true);
  const wire = await stream.text(); assert.doesNotMatch(wire, /private_upstream_error/);
  assert.deepEqual(parseEvents(wire), [created({ ...data, model: alias }), { type: "response.output_item.done", item: { type: "tool_search_call", arguments: data.metadata } }, completed({ model: alias })]);
});

test("reporting names are decoded and learned before inspecting any JSON/SSE sibling", async () => {
  const escaped = [...reported].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const wire = JSON.stringify(responseBody({ model: reported })).replace(reported, escaped);
  const json = await contain(new Response(wire, { headers: { "content-type": "application/json" } }));
  assert.equal(json.status, 200); assert.equal((await json.json()).model, alias);
  const cases = [
    { metadata: { model: reported } }, { metadata: { error: reported } }, { metadata: { [reported]: true } },
    { tools: [{ parameters: { properties: { model: { description: reported } } } }] },
    { output: [{ arguments: `{"value":"${escaped}"}` }] }, { output: [{ encrypted_content: reported }] },
    { metadata: { response: { headers: { "OpenAI-Model": reported } } } },
    { output: [{ text: target }] }, { output: [{ text: upstream.accountId }] }, { output: [{ text: upstream.accessToken }] },
  ];
  for (const extra of cases) {
    // model is deliberately inserted last, after arbitrary data containing the name.
    const body = { object: "response", id: "synthetic-response", status: "completed", ...extra, model: reported };
    const result = await contain(Response.json(body));
    assert.equal(result.status, 502); assertPrivate(await result.text());
    const stream = await contain(sse([{ type: "response.created", response: { ...body, status: "in_progress" } }, completed({ model: reported })]), true);
    const text = await stream.text(); assertPrivate(text); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed/);
  }
  const stream = await contain(sse([{ type: "response.created", metadata: { echo: reported }, response: { model: reported } }]), true);
  const text = await stream.text(); assertPrivate(text); assert.match(text, /private_upstream_error/);
});

test("learned reporting identity cannot authorize actual HTTP or typed event model headers", async () => {
  for (const name of ["OpenAI-Model", "x-openai-model", "x-codex-safety-buffering-faster-model"]) {
    for (const model of [reported, "SYNTHETIC_UNAUTHORIZED_MODEL_7U"]) {
      const result = await contain(Response.json(responseBody({ model: reported }), { headers: { [name]: model } }));
      assert.equal(result.status, 502); assertPrivate(await result.text(), [reported, model]);
      const json = await contain(Response.json(responseBody({ model: reported, headers: { [name]: [model] } })));
      assert.equal(json.status, 502); assertPrivate(await json.text(), [reported, model]);
      for (const event of [
        created({ model: reported, headers: { [name]: model } }),
        { type: "response.metadata", headers: { [name]: [model] } },
        completed({ model: reported, headers: { [name]: model } }),
      ]) {
        const stream = await contain(sse([created({ model: reported }), event, completed({ model: reported })]), true);
        const text = await stream.text(); assertPrivate(text, [reported, model]); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed/);
      }
    }
  }
});

test("only typed safety selectors are projected and still require the authorized target", async () => {
  const safety = { use_cases: ["synthetic-case"], reasons: ["synthetic-reason"], retry_model: target };
  const metadata = { openai_verification_recommendation: ["synthetic-required-verification"], openai_chatgpt_moderation_metadata: { required: true }, code: arbitraryData().metadata.code };
  const events = [created({ model: reported }), { type: "response.metadata", metadata, safety_buffering: safety },
    { type: "response.metadata", metadata: { type: "safety_buffering", ...safety } },
    { type: "response.metadata", safety_buffering: { ...safety, retry_model: null } }, completed({ model: reported })];
  const stream = await contain(sse(events, { "x-codex-safety-buffering-enabled": "false", "x-codex-safety-buffering-faster-model": target }), true);
  const text = await stream.text(); assertPrivate(text); assert.doesNotMatch(text, /private_upstream_error/);
  assert.equal(stream.headers.get("x-codex-safety-buffering-enabled"), "false");
  assert.equal(stream.headers.get("x-codex-safety-buffering-faster-model"), alias);
  assert.deepEqual(parseEvents(text), [created({ model: alias }), { type: "response.metadata", metadata, safety_buffering: { ...safety, retry_model: alias } },
    { type: "response.metadata", metadata: { type: "safety_buffering", ...safety, retry_model: alias } },
    { type: "response.metadata", safety_buffering: { ...safety, retry_model: null } }, completed({ model: alias })]);
  for (const key of ["retry_model", "faster_model", "auto_review_model_override", "model"]) {
    for (const model of [reported, "SYNTHETIC_SAFETY_ALTERNATE_6S"]) {
      for (const envelope of [{ safety_buffering: { ...safety, [key]: model } }, { metadata: { type: "safety_buffering", ...safety, [key]: model } }]) {
        const result = await contain(sse([created({ model: reported }), { type: "response.metadata", ...envelope }, completed({ model: reported })]), true);
        const wire = await result.text(); assertPrivate(wire, [reported, model]); assert.match(wire, /private_upstream_error/); assert.doesNotMatch(wire, /response.completed/);
      }
    }
  }
});

test("learned identities are held across network chunks and logical text/tool deltas", async () => {
  const first = reported.slice(0, 12), last = reported.slice(12);
  const custom = { type: "response.custom_tool_call_input.delta", item_id: "synthetic-custom" };
  const tool = { type: "response.function_call_arguments.delta", item_id: "synthetic-function" };
  const escaped = [...reported].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const args = `{"model":"${escaped}","error":null}`;
  const cases = [
    [delta(first), delta(last)],
    [delta(first), delta("safe interleaved data", { item_id: "synthetic-other", output_index: 1 }), delta(last)],
    [delta(first), delta(last, { item_id: "synthetic-other", output_index: 1 })],
    [{ type: "response.reasoning_summary_text.delta", summary_index: 0, delta: first }, { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: last }],
    [{ ...custom, delta: first }, { ...custom, delta: last }],
    [{ ...tool, delta: `{"value":"${first}` }, { ...tool, delta: `${last}"}` }],
    [{ ...tool, delta: args.slice(0, 35) }, { ...tool, delta: args.slice(35) }, { type: "response.function_call_arguments.done", item_id: tool.item_id, arguments: args }],
    [{ type: "response.output_text.done", text: reported }],
    [{ type: "response.custom_tool_call_input.done", item_id: custom.item_id, input: reported }],
  ];
  for (const events of cases) {
    const stream = await contain(sse([created({ model: reported }), ...events, completed({ model: reported })], {}, 1), true);
    const text = await stream.text(); assertPrivate(text); assert.match(text, /private_upstream_error/);
    assert.equal(text.includes(first), false); assert.equal(text.includes(last), false); assert.doesNotMatch(text, /response.completed/);
    assert.deepEqual(parseEvents(text)[0], created({ model: alias }));
  }
});

test("learned matcher safely disambiguates prefixes and preserves encoded tool data", async () => {
  const prefix = reported.slice(0, 12), safeTail = "unrelated-safe-ending";
  const args = '{"model":"synthetic-domain","error":{"code":1},"headers":["synthetic-header"]}';
  const events = [created({ model: reported }), delta(prefix), delta(safeTail),
    { type: "response.function_call_arguments.delta", item_id: "synthetic-tool", delta: args.slice(0, 15) },
    { type: "response.function_call_arguments.delta", item_id: "synthetic-tool", delta: args.slice(15) },
    { type: "response.function_call_arguments.done", item_id: "synthetic-tool", arguments: args }, completed({ model: reported })];
  const stream = await contain(sse(events), true);
  const text = await stream.text(); assertPrivate(text); assert.doesNotMatch(text, /private_upstream_error/);
  assert.deepEqual(parseEvents(text), [created({ model: alias }), ...events.slice(1, -1), completed({ model: alias })]);
});

test("learning is bounded and never resets matcher history or accepts a late reporting change", async () => {
  for (const model of ["", " ", null, {}, [], "x".repeat(129), "synthetic\nmodel", "synthetic-🦞"]) {
    const json = await contain(Response.json(responseBody({ model })));
    assert.equal(json.status, 502); assertPrivate(await json.text());
    const stream = await contain(sse([created({ model })]), true);
    assert.match(await stream.text(), /private_upstream_error/);
  }
  const changed = "SYNTHETIC_CHANGED_REPORT_5C";
  for (const events of [
    [created(), created({ model: reported })],
    [delta("safe"), created({ model: reported })],
    [delta(target.slice(0, 12)), created({ model: reported })],
    [created({ model: reported }), created({ model: changed })],
    [created({ model: reported }), delta(reported.slice(0, 12)), completed({ model: changed })],
  ]) {
    const stream = await contain(sse([...events, completed({ model: reported })]), true);
    const text = await stream.text(); assertPrivate(text, [reported, changed]); assert.match(text, /private_upstream_error/);
    assert.equal(text.includes(target.slice(0, 12)), false); assert.equal(text.includes(reported.slice(0, 12)), false); assert.doesNotMatch(text, /response.completed/);
  }
  // Repeating the learned name, target or alias cannot replace the original sensitive set.
  const stream = await contain(sse([created({ model: reported }), created({ model: target }), created({ model: alias }), delta(reported.slice(0, 12)), delta(reported.slice(12))]), true);
  const text = await stream.text(); assertPrivate(text); assert.match(text, /private_upstream_error/);
});

test("HTTP and typed affinity are inspected against reporting identity before release", async () => {
  const unsafe = [reported, JSON.stringify({ affinity: reported }), encodeURIComponent(JSON.stringify({ affinity: reported })), Buffer.from(JSON.stringify({ affinity: reported })).toString("base64url")];
  for (const value of unsafe) {
    for (const name of ["x-codex-turn-state", "x-reasoning-included"]) {
      for (const streaming of [false, true]) {
        const upstreamResponse = streaming ? sse([created({ model: reported }), completed({ model: reported })], { [name]: value })
          : Response.json(responseBody({ model: reported }), { headers: { [name]: value } });
        const result = await contain(upstreamResponse, streaming);
        assert.equal(result.status, 502); assert.equal(result.headers.get(name), null);
        assertPrivate(JSON.stringify([...result.headers]) + await result.text());
      }
      const stream = await contain(sse([created({ model: reported, headers: { [name]: value } })]), true);
      const text = await stream.text(); assertPrivate(text); assert.match(text, /private_upstream_error/);
    }
  }
  const affinity = Buffer.from(JSON.stringify({ affinity: "synthetic-cell" })).toString("base64url");
  const stream = await contain(sse([created({ model: reported }), completed({ model: reported })], { "x-codex-turn-state": affinity, "x-reasoning-included": "" }), true);
  assert.equal(stream.headers.get("x-codex-turn-state"), affinity); assert.equal(stream.headers.get("x-reasoning-included"), "");
  assert.doesNotMatch(await stream.text(), /private_upstream_error/);
});

test("reporting names cannot escape via terminal responses, genuine errors or local failure text", async () => {
  for (const event of [
    completed({ model: reported, output: [{ text: reported }] }),
    { type: "response.failed", response: { model: reported, status: "failed", error: { code: "cyber_policy", message: reported } } },
    { type: "error", error: { message: reported } },
    { type: "response.created", response: { model: reported, error: { message: reported } } },
  ]) {
    const stream = await contain(sse([created({ model: reported }), event]), true);
    const text = await stream.text(); assertPrivate(text); assert.doesNotMatch(text, /response.completed/);
    if (event.type === "response.failed") { assert.match(text, /response.failed/); assert.match(text, /cyber_policy/); }
    else assert.match(text, /private_upstream_error/);
  }
  const model = "private_upstream_error";
  const stream = await contain(sse([created({ model }), { type: "error" }]), true);
  const text = await stream.text(); assert.equal(text.includes(model), false); assert.doesNotMatch(text, /response.completed/);
  const late = await contain(sse([created(), created({ model })]), true);
  assert.equal((await late.text()).includes(model), false);
  const json = await contain(Response.json(responseBody({ model, error: { message: model } })));
  assert.equal(json.status, 502); assert.equal((await json.text()).includes(model), false);
});
