import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRouterImageModels, prepareOpenRouterImage, observeOpenRouterImage, readOpenRouterImage } from "../openrouter-images.ts";

const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/images.json", import.meta.url)));
const prepare = body => prepareOpenRouterImage(body.model, body);
const request = prepare(fixture.request);
const response = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("frozen canonical image requests preserve three identities and one paid image per native POST", () => {
  const bodies = [fixture.request, fixture.editRequest, fixture.openaiRequest];
  assert.deepEqual(bodies.map(body => body.model), [...openRouterImageModels]);
  for (const body of bodies) {
    const copy = structuredClone(body), request = prepare(copy);
    assert.equal(request.path, "/api/v1/images"); assert.deepEqual(request.body, body);
    assert.equal(request.headers.get("authorization"), null);
    copy.prompt = "changed"; assert.equal(request.body.prompt, body.prompt);
  }
  for (const patch of [{ n: 2 }, { model: "openai/gpt-image-2" }, { stream: true }, { prompt: "\ud800" },
    { provider: { api_key: "synthetic" } }, { resolution: "8K" }, { aspect_ratio: "auto" }]) {
    assert.throws(() => prepare({ ...fixture.request, ...patch }), /invalid_openrouter_image/);
  }
  assert.throws(() => prepare({ ...fixture.openaiRequest, resolution: "1K" }), /model_options/);
});

test("ordered inline references are bounded and cannot become arbitrary file/URL authorities", () => {
  const request = prepare(fixture.editRequest); assert.equal(request.inputImages, 1);
  for (const input_references of [[], Array(6).fill(fixture.editRequest.input_references[0]),
    [{ type: "image_url", image_url: { url: "https://example.com/reference.png" } }],
    [{ type: "input_file", file_id: "another_job_file" }],
    [{ type: "image_url", image_url: { url: "data:image/png;base64,AB==" } }]]) {
    assert.throws(() => prepare({ ...fixture.editRequest, input_references }), /invalid_openrouter_image/);
  }
});

test("one complete native result carries bytes and observed usage without inventing serving model or cost", async () => {
  const result = await readOpenRouterImage(response(fixture.response), request, new AbortController().signal);
  assert.equal(result.images.length, 1); assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].base64, fixture.response.data[0].b64_json);
  assert.equal(result.usage.cost, 0.04); assert.equal(result.upstreamCostMicros, null); assert.equal(result.servingModel, null);
  assert.equal(result.selectedModel, request.model);
  const withoutMime = structuredClone(fixture.response); delete withoutMime.data[0].media_type;
  assert.equal(observeOpenRouterImage(withoutMime, request, true).images[0].mimeType, "image/png");
});

test("wrong image signatures, URL results, sibling results and identity/cost contradictions cannot succeed", () => {
  for (const patch of [{ data: [] }, { data: [...fixture.response.data, ...fixture.response.data] },
    { data: [{ ...fixture.response.data[0], media_type: "image/jpeg" }] },
    { data: [{ ...fixture.response.data[0], url: "https://example.com/result" }] },
    { data: [{ b64_json: btoa("<svg>synthetic</svg>"), media_type: "image/svg+xml" }] },
    { data: [{ ...fixture.response.data[0], finish_reason: "content_filter" }] },
    { model: "another-model" }, { usage: { cost: -1 } }, { error: { message: "synthetic failure" } }]) {
    assert.throws(() => observeOpenRouterImage({ ...fixture.response, ...patch }, request, true), /invalid_openrouter_image/);
  }
  assert.throws(() => observeOpenRouterImage(fixture.response, request, false));
  // A later failed sibling does not rewrite an earlier successful native bill.
  const first = observeOpenRouterImage(fixture.response, request, true);
  assert.throws(() => observeOpenRouterImage({ error: { message: "synthetic sibling failure" } }, request, true));
  assert.equal(first.usage.cost, 0.04); assert.equal(first.upstreamCostMicros, null);
});

test("shared strict reader rejects partial transport and aborts stalled image envelopes", async () => {
  for (const reply of [new Response("{}", { status: 202, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(fixture.response), { headers: { "content-type": "application/json", "content-length": "99999" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-range": "bytes 0-1/9" } })]) {
    await assert.rejects(readOpenRouterImage(reply, request, new AbortController().signal));
  }
  let cancelled = false; const controller = new AbortController();
  const pending = readOpenRouterImage(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
