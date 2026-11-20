import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareOpenRouterChatImages, observeOpenRouterChatImages, readOpenRouterChatImages } from "../openrouter-chat-images.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/chat-images.json", import.meta.url)));
const prepare = (body = f.request, grant = f.grant) => prepareOpenRouterChatImages(body.model, body, grant);
const url = f.result.choices[0].message.images[0].image_url.url, base64 = url.split(",")[1];
const observe = (body, request = prepare()) => observeOpenRouterChatImages(body, request);
const response = message => ({ choices: [{ message, finish_reason: "stop" }] });

test("custom-host qualification preserves one native Chat request for the whole image count", () => {
  const body = structuredClone(f.request); body.n = 4;
  const result = prepare(body); assert.equal(result.selectedOrigin, "https://example.com");
  assert.equal(result.path, "/api/v1/chat/completions"); assert.equal(result.count, 4); assert.deepEqual(result.body, body);
  assert.equal(result.headers.has("authorization"), false); body.messages[0].content = "changed";
  assert.equal(result.body.messages[0].content, f.request.messages[0].content);
  for (const grant of [{ ...f.grant, chatImagesQualified: false }, { ...f.grant, selectedBaseUrl: "https://openrouter.ai/api/v1" },
    { ...f.grant, selectedBaseUrl: "http://example.com/v1" }, { ...f.grant, selectedBaseUrl: "https://user:synthetic@example.com/v1" },
    { ...f.grant, selectedBaseUrl: "https://example.com/v1?key=synthetic" }]) assert.throws(() => prepare(f.request, grant));
});

test("request reuses finite native model, inline-reference and geometry validation without route fallback", () => {
  const reference = { type: "image_url", image_url: { url } };
  const result = prepare({ ...f.request, messages: [{ role: "user", content: [{ type: "text", text: "Add a border." }, reference] }] });
  assert.equal(result.imageContract.inputImages, 1); assert.equal(result.body.messages[0].content[1].image_url.url, url);
  for (const body of [{ ...f.request, n: 5 }, { ...f.request, model: "google/new-model" },
    { ...f.request, stream: true }, { ...f.request, base_url: f.grant.selectedBaseUrl },
    { ...f.request, image_config: { image_size: "8K" } }, { ...f.request, model: "openai/gpt-5.4-image-2" },
    { ...f.request, messages: [{ role: "user", content: [{ type: "text", text: "Draw." }, { ...reference, image_url: { url: "https://example.com/input.png" } }] }] }]) assert.throws(() => prepare(body));
  assert.equal(prepare({ ...f.request, model: "openai/gpt-5.4-image-2", image_config: undefined }).imageContract.model, "openai/gpt-5.4-image-2");
});

test("frozen message image, content part and inline variants share byte and MIME checks", () => {
  const variants = [f.result, response({ images: [{ imageUrl: { url } }] }),
    response({ content: [{ type: "image_url", image_url: { url } }] }),
    response({ content: [{ type: "image", b64_json: base64, mime_type: "image/png" }] }),
    response({ content: [{ inlineData: { data: base64, mimeType: "image/png" } }] }),
    response({ content: [{ inline_data: { data: base64, mime_type: "image/png" } }] }), response({ content: `Image: ${url}` })];
  for (const body of variants) {
    const result = observe(body); assert.equal(result.images[0].base64, base64); assert.equal(result.images[0].mimeType, "image/png");
    assert.equal(result.delivery, "complete"); assert.equal(result.upstreamCostMicros, null);
  }
});

test("fewer outputs stay partial; filtered, extra, foreign or ambiguous images cannot become success", () => {
  const partial = observe(f.result, prepare({ ...f.request, n: 2 }));
  assert.equal(partial.delivery, "partial"); assert.equal(partial.upstreamCostMicros, null); assert.equal(partial.usage.cost, 0.04);
  for (const body of [{ ...f.result, model: "different" }, { ...f.result, error: "synthetic" },
    { choices: [{ ...f.result.choices[0], finish_reason: "content_filter" }] },
    response({ images: [f.result.choices[0].message.images[0], f.result.choices[0].message.images[0]] }),
    response({ images: [{ image_url: { url: "https://example.com/output.png" } }] }),
    response({ content: [{ inlineData: { data: base64, mimeType: "image/png", mime_type: "image/jpeg" } }] }),
    response({ content: [{ type: "image", b64_json: base64, media_type: "image/webp" }] }),
    response({ images: [{ image_url: { url }, imageUrl: { url } }] }),
    response({ content: "no image" }), { ...f.result, usage: { cost: -1 } }]) assert.throws(() => observe(body));
});

test("complete response and abort reuse native JSON bounds without replaying paid Chat", async () => {
  const request = prepare(), signal = () => new AbortController().signal;
  assert.equal((await readOpenRouterChatImages(Response.json(f.result), request, signal())).images.length, 1);
  for (const response of [Response.json(f.result, { status: 206 }), Response.json(f.result, { headers: { "content-length": "1" } }),
    Response.json(f.result, { headers: { "content-range": "bytes 0-1/100" } }),
    new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } })]) await assert.rejects(() => readOpenRouterChatImages(response, request, signal()));
  let canceled = false; const controller = new AbortController();
  const pending = readOpenRouterChatImages(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});
