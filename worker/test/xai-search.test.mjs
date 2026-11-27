import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareXaiSearch, observeXaiSearch, readXaiSearch } from "../xai-search.ts";

const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/search.json", import.meta.url)));
const qualification = { model: "grok-4.7", servingModels: ["grok-4.7"], reasoningEfforts: ["low", "medium", "high"] };
const copy = value => structuredClone(value);
const prepare = value => prepareXaiSearch(value, qualification);
const response = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("native Responses search preserves the frozen request, selected model and qualified efforts", () => {
  for (const body of [fixture.webRequest, fixture.xRequest]) {
    const input = copy(body), prepared = prepare(input);
    assert.equal(prepared.path, "/v1/responses"); assert.deepEqual(prepared.body, body);
    assert.equal(prepared.headers.get("authorization"), null);
    input.tools.push({ type: "code_interpreter" }); assert.equal(prepared.body.tools.length, 1);
  }
  for (const patch of [{ store: true }, { stream: true }, { previous_response_id: "other_job" }, { model: "grok-new" },
    { reasoning: { effort: "none" } }, { input: [{ role: "user", content: [{ type: "input_file", file_id: "other_file" }] }] },
    { tools: [{ type: "web_search", allowed_domains: ["example.com"] }] }, { max_turns: 0 }, { max_turns: 11 }]) {
    assert.throws(() => prepare({ ...fixture.webRequest, ...patch }), /invalid_xai_search/);
  }
  assert.throws(() => prepare({ ...fixture.webRequest, input: [{ role: "user", content: "\ud800" }] }));
});

test("X handles and real UTC dates preserve exact native filters without pretending they filter thread fetches", () => {
  const input = copy(fixture.xRequest);
  input.tools[0].allowed_x_handles = Array.from({ length: 20 }, (_, i) => `example${i}`);
  assert.equal(prepare(input).body.tools[0].allowed_x_handles.length, 20);
  for (const patch of [{ allowed_x_handles: [...input.tools[0].allowed_x_handles, "extra"] },
    { allowed_x_handles: ["EXAMPLE", "example"] }, { allowed_x_handles: ["@example"] },
    { excluded_x_handles: ["other"] }, { from_date: "2026-02-30" }, { to_date: "2026-10-01" },
    { enable_video_understanding: "true" }]) {
    assert.throws(() => prepare({ ...input, tools: [{ ...input.tools[0], ...patch }] }), /invalid_xai_search/);
  }
});

test("completed answer joins adjacent blocks, keeps citations opaque, and separates calls from fetched items", async () => {
  const result = await readXaiSearch(response(fixture.completed), prepare(fixture.webRequest), new AbortController().signal);
  assert.equal(result.answer, "Example answer."); assert.equal(result.status, "completed");
  assert.deepEqual(result.citations, ["https://example.com/source"]);
  assert.deepEqual(result.counts, { inputTokens: 120, outputTokens: 40, webSearchCalls: 1, xSearchCalls: 2, xPostsFetched: 44, xUsersFetched: 3 });
  assert.equal(result.upstreamCostMicros, null);
  const body = copy(fixture.completed); body.citations = ["javascript:alert(1)", "https://user:pass@example.com", "https://example.org/primary", "https://example.org/primary"];
  assert.deepEqual(observeXaiSearch(body, prepare(fixture.webRequest), true).citations, ["https://example.org/primary"]);
});

test("native incomplete/failed outcomes retain usage and never assert successful delivery or free work", () => {
  const request = prepare(fixture.xRequest);
  const partial = observeXaiSearch(fixture.incomplete, request, true);
  assert.equal(partial.status, "incomplete"); assert.equal(partial.answer, "Partial answer");
  assert.equal(partial.counts.xPostsFetched, 19); assert.equal(partial.upstreamCostMicros, null);
  const failed = observeXaiSearch(fixture.failed, request, true);
  assert.equal(failed.status, "failed"); assert.equal(failed.counts.xSearchCalls, null);
  assert.throws(() => observeXaiSearch(fixture.completed, request, false), /incomplete_transport/);
  for (const patch of [{ status: "in_progress" }, { model: "unexpected-model" }, { error: { code: "failed" } },
    { usage: { input_tokens: -1 } }, { usage: { server_side_tool_usage_details: { x_posts_fetched: 1.5 } } }]) {
    assert.throws(() => observeXaiSearch({ ...fixture.completed, ...patch }, request, true));
  }
});

test("answer truncation preserves Unicode and bounded citation selection without positional claims", () => {
  const body = copy(fixture.completed);
  body.output = [{ type: "output_text", text: "a".repeat(19999) + "🦊tail" }];
  body.citations = Array.from({ length: 1001 }, (_, i) => `https://example.com/${i}`);
  body.inline_citations = [{ start_index: 19999, end_index: 20000, url: "https://example.com/ambiguous" }];
  const result = observeXaiSearch(body, prepare(fixture.webRequest), true);
  assert.equal(result.answer, "a".repeat(19999)); assert.equal(result.truncated, true);
  assert.equal(result.citations.length, 20); assert.equal(result.inlineCitations, undefined);
  assert.deepEqual(result.body.inline_citations, body.inline_citations);
});

test("only complete bounded HTTP JSON becomes an observation", async () => {
  const request = prepare(fixture.webRequest), signal = new AbortController().signal;
  for (const reply of [new Response("{}", { status: 202, headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/event-stream" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-range": "bytes 0-1/50" } }),
    new Response(JSON.stringify(fixture.completed), { headers: { "content-type": "application/json", "content-length": "99999" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(readXaiSearch(reply, request, signal), /invalid_xai_search/);
  }
});

test("abort cancels a stalled body without replaying or inventing a terminal result", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = readXaiSearch(new Response(body, { headers: { "content-type": "application/json" } }), prepare(fixture.webRequest), controller.signal);
  controller.abort(); await assert.rejects(pending, /invalid_xai_search/); assert.equal(cancelled, true);
});
