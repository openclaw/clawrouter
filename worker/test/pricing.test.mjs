import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { actualModelCost, estimateModelCost, hostedToolPricingGap, requestPricingGap } from "../pricing.ts";

const pricing = {
  effectiveAt: "2026-06-19", source: "https://example.com", inputMicrosPerMillion: 2_500_000,
  outputMicrosPerMillion: 15_000_000, cachedInputMicrosPerMillion: 250_000,
  cacheWriteInputMicrosPerMillion: null,
  cacheWrite5mInputMicrosPerMillion: 3_125_000, cacheWrite1hInputMicrosPerMillion: 5_000_000,
  maxInputTokens: 1_050_000, maxRequestInputTokens: null, defaultMaxOutputTokens: 128_000,
  inputTokenOverhead: 1_024, longContext: null,
};

test("response-ID pricing requires final parent knowledge only on the selected Responses wire", () => {
  for (const previous_response_id of [undefined, null, ""]) {
    assert.equal(requestPricingGap(pricing, { previous_response_id }, "openai.responses", "hosted_tool_fee"), null);
  }
  const body = { previous_response_id: "response", input: [] };
  for (const [knowledge, expected] of [[undefined, "retained_tool_unknown"], ["unknown", "retained_tool_unknown"], ["token_only", null], ["hosted_tool_fee", "hosted_tool_fee"], ["hosted_tool_usage", "hosted_tool_usage"]]) {
    assert.equal(requestPricingGap(pricing, body, "openai.responses", knowledge), expected);
    for (const format of ["openai.chat_completions", "anthropic.messages", "google.generate_content"]) assert.equal(requestPricingGap(pricing, body, format, knowledge), null);
  }
  assert.equal(requestPricingGap(pricing, { ...body, tools: [{ type: "web_search" }] }, "openai.responses", "token_only"), "hosted_tool_fee");
  assert.equal(requestPricingGap(pricing, { ...body, input: [{ type: "tool_search_output", tools: [{ type: "mcp" }] }] }, "openai.responses", "token_only"), "hosted_tool_usage");
  assert.equal(requestPricingGap({ ...pricing, unpricedCosts: ["request_fee"] }, body, "openai.responses", "hosted_tool_fee"), "model_request_fee");
  assert.equal(requestPricingGap(pricing, { input: "full input", client_metadata: { "x-codex-turn-state": "turn" } }, "openai.responses"), null);
});

test("pricing reserves serialized text plus overhead and every requested choice", () => {
  const body = { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 1_000, n: 4 };
  const estimate = estimateModelCost(pricing, body);
  assert.equal(estimate.inputTokens, new TextEncoder().encode(JSON.stringify(body)).byteLength + 1_024);
  assert.equal(estimate.outputTokens, 4_000);
});

test("opaque inputs and provider-added tools reserve the full input window", () => {
  assert.equal(estimateModelCost(pricing, { input: [{ type: "input_image", image_url: "https://example.com/a.png" }] }).inputTokens, pricing.maxInputTokens);
  assert.equal(estimateModelCost(pricing, { tools: [{ type: "computer_20250124" }] }).inputTokens, pricing.maxInputTokens);
});

const claude = { request_format: "anthropic.messages" };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const le = (value, size) => Array.from({ length: size }, (_, index) => value >> index * 8 & 0xff);
const be = (value, size) => le(value, size).reverse();
const latin = (value) => [...value].map((character) => character.charCodeAt(0));
const pngChunk = (type, data) => [...be(data.length, 4), ...latin(type), ...data, 0, 0, 0, 0];
const jpegFrame = (width, height, frame = 0xc0) => [0xff, frame, 0, 17, 8, ...be(height, 2), ...be(width, 2), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const jpegScan = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34];
const headers = {
  // Signature, IHDR, and the first IDAT chunk header (CRCs are not inspected).
  png: (width, height, between = []) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", [...be(width, 4), ...be(height, 4), 8, 2, 0, 0, 0]), ...between, 0, 0, 0, 0, ...latin("IDAT")],
  // APP1 metadata carries a decoy thumbnail frame header that must be skipped;
  // a fill byte precedes DQT, and the walk ends at the start of scan.
  jpeg: (width, height, frame = 0xc2) => [0xff, 0xd8, 0xff, 0xe1, ...be(12, 2), 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 0xff, 0xff, 0xdb, 0, 3, 0, ...jpegFrame(width, height, frame), ...jpegScan],
  gif: (width, height, frameWidth, frameHeight) => [...latin("GIF89a"), ...le(width, 2), ...le(height, 2), 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...le(frameWidth, 2), ...le(frameHeight, 2), 0],
  vp8: (width, height) => [...latin("RIFF"), 0, 0, 0, 0, ...latin("WEBPVP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le(width, 2), ...le(height, 2)],
  vp8l: (width, height) => [...latin("RIFF"), 0, 0, 0, 0, ...latin("WEBPVP8L"), 0, 0, 0, 0, 0x2f, ...le((width - 1) | (height - 1) << 14, 4)],
  vp8x: (width, height) => [...latin("RIFF"), 0, 0, 0, 0, ...latin("WEBPVP8X"), 0, 0, 0, 0, 0, 0, 0, 0, ...le(width - 1, 3), ...le(height - 1, 3)],
};
const imageTurn = (block) => ({ max_tokens: 1_000, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: [block] }] }] });
const imageBlock = (media_type, bytes) => ({ type: "image", source: { type: "base64", media_type, data: b64(bytes) } });

test("Claude base64 images reserve their documented visual-token ceiling instead of their encoding", () => {
  // Expected token counts are the published ceil(w / 28) * ceil(h / 28) values
  // for these sizes; larger images are only ever downsized below this bound.
  for (const [media, bytes, tokens] of [
    ["image/png", headers.png(3_840, 2_160), 138 * 78],
    ["image/png", headers.png(1, 1), 1],
    ["image/jpeg", headers.jpeg(1_920, 1_080), 2_691],
    ["image/jpeg", headers.jpeg(1_092, 1_092, 0xc0), 1_521],
    ["image/gif", headers.gif(100, 100, 300, 50), 11 * 4],
    ["image/webp", headers.vp8(1_000, 1_000), 1_296],
    ["image/webp", headers.vp8l(200, 200), 64],
    ["image/webp", headers.vp8x(1_092, 1_092), 1_521],
    ["image/png", headers.png(8_000, 8_000), 286 * 286],
  ]) {
    const block = imageBlock(media, bytes), body = imageTurn(block);
    const estimate = estimateModelCost(pricing, body, claude);
    assert.equal(estimate.inputTokens, new TextEncoder().encode(JSON.stringify(body)).byteLength - block.source.data.length + pricing.inputTokenOverhead + tokens, `${media} ${tokens}`);
    // Only the selected Claude wire has this tokenizer contract.
    for (const endpoint of [undefined, { request_format: "openai.chat_completions" }, { request_format: "aws_bedrock.invoke" }]) {
      assert.equal(estimateModelCost(pricing, body, endpoint).inputTokens, pricing.maxInputTokens);
    }
  }
  const one = imageBlock("image/png", headers.png(1_920, 1_080));
  const two = { max_tokens: 1_000, messages: [{ role: "user", content: [one, { type: "text", text: "and" }, structuredClone(one)] }] };
  assert.equal(estimateModelCost(pricing, two, claude).inputTokens, new TextEncoder().encode(JSON.stringify(two)).byteLength - 2 * one.source.data.length + pricing.inputTokenOverhead + 2 * 2_691, "repeated images are billed and bounded per occurrence");
});

test("Claude media without a qualified header bound keeps the full input window", () => {
  const png = headers.png(64, 64);
  for (const block of [
    { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    { type: "image", source: { type: "file", file_id: "file_fixture" } },
    { ...imageBlock("image/png", png), file_id: "file_fixture" },
    { type: "image", source: { ...imageBlock("image/png", png).source, url: "https://example.com/a.png" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: b64(png).replace(/=+$/, "") } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: `${b64(png)}\n` } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: 42 } },
    imageBlock("image/svg+xml", latin("<svg/>")),
    imageBlock("image/jpeg", png),
    imageBlock("image/png", headers.png(8_001, 1)),
    imageBlock("image/png", headers.png(0, 10)),
    imageBlock("image/png", headers.png(64, 64).slice(0, 20)),
    imageBlock("image/jpeg", headers.jpeg(64, 0)),
    imageBlock("image/jpeg", [0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1]),
    imageBlock("image/gif", headers.gif(10, 10, 10, 10).slice(0, 30)),
    imageBlock("image/webp", headers.vp8(1 << 14 | 10, 10)),
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(latin("%PDF-1.7")) } },
    { ...imageBlock("image/png", png), extra: [{ type: "document", source: { type: "file", file_id: "file_fixture" } }] },
  ]) assert.equal(estimateModelCost(pricing, imageTurn(block), claude).inputTokens, pricing.maxInputTokens, JSON.stringify(block).slice(0, 120));
  const many = { max_tokens: 1, messages: [{ role: "user", content: Array.from({ length: 13 }, () => imageBlock("image/png", headers.png(8_000, 8_000))) }] };
  assert.equal(estimateModelCost(pricing, many, claude).inputTokens, pricing.maxInputTokens, "summed bounds saturate at the model window");
});

const imageEstimate = (body) => estimateModelCost(pricing, body, claude).inputTokens;
const boundedEstimate = (body, blocks) => new TextEncoder().encode(JSON.stringify(body)).byteLength - blocks.reduce((sum, block) => sum + block.source.data.length, 0) + pricing.inputTokenOverhead + blocks.length * 2_691;

test("only image blocks Claude bills as images qualify for the visual-token bound", async (t) => {
  const block = () => imageBlock("image/png", headers.png(1_920, 1_080));
  const user = (...content) => ({ role: "user", content });
  const assistant = (...content) => ({ role: "assistant", content });
  // Anthropic bills an image only as a direct user content block or a direct
  // block of a user tool_result's content; both positions keep the bound.
  const direct = block(), nested = block();
  const qualified = { max_tokens: 1_000, messages: [user(direct, { type: "text", text: "and" }), assistant({ type: "text", text: "ok" }), user({ type: "tool_result", tool_use_id: "toolu_fixture", content: [nested] })] };
  assert.equal(imageEstimate(qualified), boundedEstimate(qualified, [direct, nested]));
  // Anywhere else an image-shaped object is billed as text (or rejected), so
  // its encoded bytes are not replaced and the request keeps the full window.
  for (const [name, messages] of [
    ["tool_use input", [user({ type: "text", text: "go" }), assistant({ type: "tool_use", id: "toolu_fixture", name: "browser", input: { blob: block() } })]],
    ["server_tool_use input", [user({ type: "text", text: "go" }), assistant({ type: "server_tool_use", id: "srvtoolu_fixture", name: "web_fetch", input: block() })]],
    ["mcp_tool_use input", [user({ type: "text", text: "go" }), assistant({ type: "mcp_tool_use", id: "mcptoolu_fixture", name: "lookup", server_name: "fixture", input: { items: [block()] } })]],
    ["an assistant content block", [user({ type: "text", text: "go" }), assistant(block())]],
    ["an unknown field of a user block", [user({ type: "text", text: "go", metadata: block() })]],
    ["a field of a tool_result block", [user({ type: "tool_result", tool_use_id: "toolu_fixture", content: [], extra: block() })]],
    ["a nested field inside tool_result content", [user({ type: "tool_result", tool_use_id: "toolu_fixture", content: [{ type: "text", text: "x", attachment: block() }] })]],
    ["a tool_result nested in tool_result content", [user({ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: [block()] }] })]],
    ["a tool_result in an assistant message", [assistant({ type: "tool_result", tool_use_id: "toolu_fixture", content: [block()] })]],
    ["a message without a user role", [{ content: [block()] }]],
  ]) await t.test(name, () => assert.equal(imageEstimate({ max_tokens: 1_000, messages }), pricing.maxInputTokens));
});

test("qualifying Claude image blocks allow only documented keys", async (t) => {
  for (const [extra, bounded] of [
    [{ cache_control: { type: "ephemeral", ttl: "1h" } }, true],
    [{ transformations: { oversized_image: "downsize" } }, true],
    [{ transformations: { oversized_image: "error" } }, true],
    [{ transformations: { oversized_image: "upscale" } }, false],
    [{ transformations: { oversized_image: "downsize", scale: 2 } }, false],
    [{ transformations: "downsize" }, false],
    [{ detail: "high" }, false],
    [{ citations: { enabled: true } }, false],
  ]) await t.test(`${JSON.stringify(extra)} ${bounded ? "keeps" : "loses"} the bound`, () => {
    const block = { ...imageBlock("image/png", headers.png(1_920, 1_080)), ...extra }, body = imageTurn(block);
    assert.equal(imageEstimate(body), bounded ? boundedEstimate(body, [block]) : pricing.maxInputTokens);
  });
});

test("JPEG headers qualify only when a strict marker walk agrees with real decoders", async (t) => {
  const real = headers.jpeg(2_000, 2_000), realBody = imageTurn(imageBlock("image/jpeg", real));
  assert.equal(imageEstimate(realBody), boundedEstimate(realBody, [realBody.messages[0].content[0].content[0]]) - 2_691 + 72 * 72, "the unwrapped stream is bounded at 72 x 72 patches");
  // libjpeg and Pillow discard FF00 stuffing before a marker and decode the real
  // 2000x2000 frame; a length-skipping walk would read only the trailing 1x1 frame.
  const body = real.slice(2);
  const segment = (marker, payload = [0]) => [0xff, marker, ...be(payload.length + 2, 2), ...payload];
  for (const [name, bytes] of [
    ["FF00-wrapped real image", [0xff, 0xd8, 0xff, 0x00, ...be(body.length + 2, 2), ...body, ...jpegFrame(1, 1), ...jpegScan]],
    ["duplicate frame header (small first)", [0xff, 0xd8, ...jpegFrame(1, 1), ...jpegFrame(2_000, 2_000), ...jpegScan]],
    ["duplicate frame header (large first)", [0xff, 0xd8, ...jpegFrame(2_000, 2_000), ...jpegFrame(1, 1, 0xc2), ...jpegScan]],
    ...[0x02, 0x4f, 0xbf, 0xc8, 0xdc, 0xde, 0xdf, 0xf0, 0xfd].map((marker) => [`reserved or unsupported marker ${marker.toString(16)}`, [0xff, 0xd8, ...segment(marker), ...jpegFrame(1, 1), ...jpegScan]]),
    ["restart marker before the frame", [0xff, 0xd8, 0xff, 0xd0, ...jpegFrame(1, 1), ...jpegScan]],
    ["TEM marker before the frame", [0xff, 0xd8, 0xff, 0x01, ...jpegFrame(1, 1), ...jpegScan]],
    ["second SOI", [0xff, 0xd8, 0xff, 0xd8, ...jpegFrame(1, 1), ...jpegScan]],
    ["junk bytes between segments", [0xff, 0xd8, 0x00, ...jpegFrame(1, 1), ...jpegScan]],
    ["frame without a start of scan", [0xff, 0xd8, ...jpegFrame(1, 1)]],
    ["end of image before the scan", [0xff, 0xd8, ...jpegFrame(1, 1), 0xff, 0xd9, ...jpegScan]],
    ["frame length disagrees with its components", [0xff, 0xd8, 0xff, 0xc0, 0, 14, 8, 0, 1, 0, 1, 3, 1, 0x22, 0, 2, 0x11, 1, ...jpegScan]],
    ["frame without components", [0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, ...jpegScan]],
  ]) await t.test(name, () => assert.equal(imageEstimate(imageTurn(imageBlock("image/jpeg", bytes))), pricing.maxInputTokens));
});

test("PNG headers qualify only with one 13-byte IHDR before the first IDAT", async (t) => {
  const ihdr = (width, height) => pngChunk("IHDR", [...be(width, 4), ...be(height, 4), 8, 2, 0, 0, 0]);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], idat = [0, 0, 0, 0, ...latin("IDAT")];
  const ancillary = [...pngChunk("pHYs", [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]), ...pngChunk("tEXt", latin("Software\0fixture"))];
  const withAncillary = imageTurn(imageBlock("image/png", headers.png(1_920, 1_080, ancillary)));
  assert.equal(imageEstimate(withAncillary), boundedEstimate(withAncillary, [withAncillary.messages[0].content[0].content[0]]), "ancillary chunks before IDAT are walked");
  for (const [name, bytes] of [
    ["IHDR longer than 13 bytes", [...signature, ...pngChunk("IHDR", [...be(1, 4), ...be(1, 4), 8, 2, 0, 0, 0, 0]), ...idat]],
    ["IHDR shorter than 13 bytes", [...signature, 0, 0, 0, 12, ...latin("IHDR"), ...be(1, 4), ...be(1, 4), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...idat]],
    ["second IHDR before IDAT", [...signature, ...ihdr(1, 1), ...ihdr(2_000, 2_000), ...idat]],
    ["second IHDR after ancillary chunks", [...signature, ...ihdr(1, 1), ...ancillary, ...ihdr(2_000, 2_000), ...idat]],
    ["IEND before any IDAT", [...signature, ...ihdr(1, 1), 0, 0, 0, 0, ...latin("IEND"), ...idat]],
    ["no IDAT at all", [...signature, ...ihdr(1, 1)]],
    ["chunk length beyond the PNG limit", [...signature, ...ihdr(1, 1), 0x80, 0, 0, 0, ...latin("tEXt"), ...idat]],
  ]) await t.test(name, () => assert.equal(imageEstimate(imageTurn(imageBlock("image/png", bytes))), pricing.maxInputTokens));
});

test("native Gemini bounds use the selected wire format, ProtoJSON aliases, and the combined output ceiling", () => {
  const format = { request_format: "google.generate_content" };
  for (const [config, expected] of [
    [{ maxOutputTokens: 16 }, 16],
    [{ max_output_tokens: "1.6e1", candidate_count: "2" }, 32],
    [{ maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 1_024 }, candidateCount: 2 }, 32],
    [{ maxOutputTokens: 16, max_output_tokens: 32 }, 32],
    [{ max_output_tokens: 32, maxOutputTokens: 16 }, 16],
    [{ maxOutputTokens: 16, max_output_tokens: null }, pricing.defaultMaxOutputTokens],
    [{ maxOutputTokens: 16, candidateCount: 1, candidate_count: 2 }, 32],
    [{ maxOutputTokens: 16, candidate_count: 2, candidateCount: 1 }, 16],
    [{ maxOutputTokens: 2_147_483_647, candidateCount: 2_147_483_647 }, Number.MAX_SAFE_INTEGER],
  ]) {
    const body = { contents: [{ parts: [{ text: "hello" }] }], generationConfig: config, max_output_tokens: 1, n: 9 };
    const before = structuredClone(body), estimate = estimateModelCost(pricing, body, format);
    assert.equal(estimate.outputTokens, expected);
    assert.equal(estimate.inputTokens, new TextEncoder().encode(JSON.stringify(body)).byteLength + pricing.inputTokenOverhead);
    assert.deepEqual(body, before);
    assert.equal(estimateModelCost(pricing, body, { request_format: "openai.responses" }).outputTokens, 9);
  }
  for (const [body, expected] of [
    [{ generationConfig: { maxOutputTokens: 16 }, generation_config: { max_output_tokens: 32 } }, 32],
    [{ generation_config: { max_output_tokens: 32 }, generationConfig: { maxOutputTokens: 16 } }, 16],
    [{ generationConfig: { maxOutputTokens: 16 }, generation_config: null }, pricing.defaultMaxOutputTokens],
    [{ max_output_tokens: 1, n: 9 }, pricing.defaultMaxOutputTokens],
  ]) assert.equal(estimateModelCost(pricing, body, format).outputTokens, expected);
  for (const invalid of [-1, 1.5, 2_147_483_648, "Infinity", "bad", {}, true]) {
    assert.equal(estimateModelCost(pricing, { generationConfig: { maxOutputTokens: invalid } }, format).outputTokens, pricing.defaultMaxOutputTokens);
  }
});

test("native Gemini remote cache and typed media inputs reserve the full input bound", () => {
  const media = { mimeType: "image/png", data: "AA==" };
  for (const body of [
    { cachedContent: "cachedContents/fixture" }, { cached_content: "cachedContents/fixture" },
    { contents: [{ parts: [{ fileData: { fileUri: "https://example.com/file" } }] }] },
    { contents: [{ parts: [{ inline_data: media }] }] },
    { systemInstruction: { parts: [{ inlineData: media }] } },
    { system_instruction: { parts: [{ file_data: { file_uri: "https://example.com/file" } }] } },
    { contents: [{ parts: [{ functionResponse: { name: "fixture", response: {}, parts: [{ inlineData: media }] } }] }] },
  ]) assert.equal(estimateModelCost(pricing, body, { request_format: "google.generate_content" }).inputTokens, pricing.maxInputTokens);
  const body = { contents: [{ parts: [{ functionResponse: { name: "fixture", response: { fileData: "user-defined JSON", parts: [{ inlineData: media }] } } }] }] };
  assert.ok(estimateModelCost(pricing, body, { request_format: "google.generate_content" }).inputTokens < pricing.maxInputTokens);
  assert.ok(estimateModelCost(pricing, { cachedContent: "cachedContents/fixture" }, { request_format: "openai.responses" }).inputTokens < pricing.maxInputTokens);
});

test("pricing completeness follows selected wire declarations without reading client function JSON", () => {
  for (const type of ["web_search", "web_search_preview", "web_search_2025_08_26", "web_search_preview_2025_03_11", "file_search", "code_interpreter", "image_generation"]) {
    assert.equal(requestPricingGap(pricing, { tools: [{ type }] }, "openai.responses"), "hosted_tool_fee");
  }
  for (const type of ["container_auto", "container_reference"]) {
    assert.equal(requestPricingGap(pricing, { tools: [{ type: "shell", environment: { type } }] }, "openai.responses"), "hosted_tool_fee");
  }
  for (const type of ["web_search_20250305", "web_search_20260209", "web_search_20260318"]) {
    assert.equal(requestPricingGap(pricing, { tools: [{ type, name: "web_search" }] }, "anthropic.messages"), "hosted_tool_usage");
  }
  assert.equal(requestPricingGap(pricing, { web_search_options: {} }, "openai.chat_completions"), "hosted_tool_fee");
  for (const [key, gap] of [
    ...["googleSearch", "google_search", "googleSearchRetrieval", "google_search_retrieval", "googleMaps", "google_maps"].map(key => [key, "hosted_tool_fee"]),
    ...["urlContext", "url_context", "fileSearch", "file_search", "codeExecution", "code_execution"].map(key => [key, "hosted_tool_usage"]),
  ]) assert.equal(requestPricingGap(pricing, { tools: [{ [key]: {} }] }, "google.generate_content"), gap);
  for (const key of ["cachedContent", "cached_content"]) {
    assert.equal(requestPricingGap(pricing, { [key]: "cachedContents/fixture" }, "google.generate_content"), "hosted_tool_usage");
  }
  assert.equal(requestPricingGap(pricing, { tools: [{ googleSearch: {}, google_search: null }] }, "google.generate_content"), null);
  assert.equal(requestPricingGap(pricing, { tools: [{ google_search: null, googleSearch: {} }] }, "google.generate_content"), "hosted_tool_fee");
  assert.equal(requestPricingGap(pricing, { cachedContent: "cachedContents/fixture", cached_content: null }, "google.generate_content"), null);
  for (const format of ["openai.responses", "anthropic.messages", "openai.chat_completions", "google.generate_content"]) {
    for (const body of [
      { tools: [{ type: "function", name: "web_search", parameters: { googleSearch: {} } }] },
      { tools: [{ type: "function", function: { name: "file_search" } }] },
      { tools: [{ name: "web_search", input_schema: { type: "object" } }] },
      { tools: [{ functionDeclarations: [{ name: "codeExecution", parameters: { urlContext: {} } }] }] },
      { tools: [{ type: "shell", environment: { type: "local" } }] },
      { tools: [{ type: "tool_search", execution: "client" }] },
      ...["function", "custom", "namespace", "local_shell", "apply_patch", "computer", "computer_use_preview", "memory_20250818", "bash_20250124", "text_editor_20250728", "computer_toolset_20260801", "browser_toolset_20260801"].map(type => ({ tools: [{ type, name: "advisor_20260301" }] })),
      { input: [{ type: "web_search_call" }] }, { web_search_options: null },
    ]) assert.equal(requestPricingGap(pricing, body, format), null);
    assert.equal(requestPricingGap({ ...pricing, unpricedCosts: ["request_fee"] }, {}, format), "model_request_fee");
  }
  assert.equal(requestPricingGap(pricing, { tools: [{ googleSearch: {} }] }, "openai.responses"), null);
  assert.equal(requestPricingGap(pricing, { tools: [{ type: "file_search" }] }, "google.generate_content"), null);
});

test("opaque Responses prompt references cannot imply token-only pricing", () => {
  const body = { prompt: { id: "pmpt_fixture", version: "1" } };
  assert.equal(requestPricingGap(pricing, body, "openai.responses"), "hosted_tool_usage");
  assert.equal(requestPricingGap(pricing, { ...body, tools: [] }, "openai.responses"), "hosted_tool_usage");
  for (const format of ["openai.chat_completions", "anthropic.messages", "google.generate_content"]) assert.equal(requestPricingGap(pricing, body, format), null);
  assert.equal(requestPricingGap(pricing, { prompt: null }, "openai.responses"), null);
});

test("Responses classifies only protocol-tagged input tool declarations", () => {
  for (const type of ["additional_tools", "tool_search_output"]) for (const [tool, gap] of [
    ...[{ type: "web_search" }, { type: "file_search" }, { type: "code_interpreter" }, { type: "image_generation" }, { type: "shell", environment: { type: "container_auto" } }].map(tool => [tool, "hosted_tool_fee"]),
    ...["mcp", "programmatic_tool_calling", "tool_search"].map(type => [{ type }, "hosted_tool_usage"]),
  ]) {
    const body = { tools: [], input: [{ type, ...(type === "additional_tools" ? { role: "developer" } : { call_id: "call_fixture", execution: "client" }), tools: [tool] }] };
    assert.equal(requestPricingGap(pricing, body, "openai.responses"), gap);
    for (const format of ["openai.chat_completions", "anthropic.messages", "google.generate_content"]) assert.equal(requestPricingGap(pricing, body, format), null);
  }
  for (const body of [
    { input: [{ type: "message", tools: [{ type: "file_search" }] }] },
    { input: [{ type: "message", content: [{ type: "additional_tools", tools: [{ type: "file_search" }] }] }] },
    { input: [{ type: "function_call_output", output: { type: "tool_search_output", tools: [{ type: "file_search" }] } }] },
    { input: [{ type: "tool_search_output", tools: [{ type: "namespace", name: "fixture", tools: [{ type: "function", name: "file_search", parameters: { type: "object" } }] }] }] },
    { input: [{ type: "additional_tools", tools: [{ type: "function", name: "file_search", parameters: { tools: [{ type: "code_interpreter" }] } }] }] },
  ]) assert.equal(requestPricingGap(pricing, body, "openai.responses"), null);
});

test("Anthropic execution fee waivers do not qualify cumulative server-loop usage", () => {
  for (const type of ["code_execution_20250522", "code_execution_20250825", "code_execution_20260120", "code_execution_20260521"]) {
    const tool = { type, name: "code_execution" };
    assert.equal(requestPricingGap(pricing, { tools: [tool] }, "anthropic.messages"), "hosted_tool_fee");
    assert.equal(requestPricingGap(pricing, { tools: [tool, { type: "web_fetch_20250910", name: "web_fetch" }] }, "anthropic.messages"), "hosted_tool_fee");
    for (const fetch of ["web_fetch_20260209", "web_fetch_20260318"]) {
      const body = { tools: [tool, { type: fetch, name: "web_fetch" }] };
      assert.equal(requestPricingGap(pricing, body, "anthropic.messages"), "hosted_tool_usage");
      assert.equal(requestPricingGap(pricing, { tools: body.tools.toReversed() }, "anthropic.messages"), "hosted_tool_usage");
      assert.equal(estimateModelCost(pricing, body, { request_format: "anthropic.messages" }).inputTokens, pricing.maxInputTokens);
    }
    assert.equal(requestPricingGap(pricing, { tools: [tool, { type: "web_search_20260209", name: "web_search" }] }, "anthropic.messages"), "hosted_tool_usage");
    for (const format of ["openai.responses", "google.generate_content"]) assert.equal(requestPricingGap(pricing, { tools: [tool] }, format), null);
  }
  assert.equal(requestPricingGap(pricing, { tools: [{ name: "code_execution_20250825", input_schema: { type: "object" } }] }, "anthropic.messages"), null);
});

test("hosted declaration classification covers the finite server-work inventory without inventing fees", () => {
  for (const [format, tools] of [
    ...["mcp", "programmatic_tool_calling", "tool_search"].map(type => ["openai.responses", [{ type }]]),
    ["openai.responses", [{ type: "tool_search", execution: "server" }]],
    ...["advisor_20260301", "mcp_toolset", "tool_search_tool_regex", "tool_search_tool_bm25", "tool_search_tool_regex_20251119", "tool_search_tool_bm25_20251119", "web_fetch_20250910", "web_fetch_20260209", "web_fetch_20260309", "web_fetch_20260318"].map(type => ["anthropic.messages", [{ type }]]),
    ...["mcpServers", "mcp_servers"].map(key => ["google.generate_content", [{ [key]: [{ name: "fixture", streamableHttpTransport: { url: "https://example.com/mcp" } }] }]]),
  ]) {
    assert.equal(hostedToolPricingGap(tools, format), "hosted_tool_usage");
    assert.equal(requestPricingGap(pricing, { tools }, format), "hosted_tool_usage");
    for (const other of ["openai.responses", "anthropic.messages", "google.generate_content", "openai.chat_completions"].filter(value => value !== format)) assert.equal(requestPricingGap(pricing, { tools }, other), null);
  }
  assert.equal(hostedToolPricingGap([{ type: "future_tool" }, null], "openai.responses"), null, "null does not attest a complete retained inventory");
  for (const tools of [[{ type: "mcp" }, { type: "file_search" }], [{ type: "file_search" }, { type: "mcp" }]]) assert.equal(hostedToolPricingGap(tools, "openai.responses"), "hosted_tool_fee");
  for (const tools of [[{ mcpServers: [] }], [{ mcpServers: [{}], mcp_servers: null }], [{ mcpServers: {} }]]) assert.equal(hostedToolPricingGap(tools, "google.generate_content"), null);
  assert.equal(hostedToolPricingGap([{ mcp_servers: null, mcpServers: [{}] }], "google.generate_content"), "hosted_tool_usage");
});

test("only exact request-level orchestration and compaction declarations add usage gaps", () => {
  for (const [format, body] of [
    ["openai.responses", { multi_agent: { enabled: true, max_concurrent_subagents: 1 } }],
    ["anthropic.messages", { mcp_servers: [{ type: "url", name: "fixture", url: "https://example.com/mcp" }] }],
    ["anthropic.messages", { context_management: { edits: [{ type: "compact_20260112" }] } }],
    ["anthropic.messages", { compaction: { type: "summarize" } }],
  ]) {
    assert.equal(requestPricingGap(pricing, body, format), "hosted_tool_usage");
    for (const other of ["openai.responses", "anthropic.messages", "google.generate_content", "openai.chat_completions"].filter(value => value !== format)) assert.equal(requestPricingGap(pricing, body, other), null);
  }
  for (const body of [
    { multi_agent: { enabled: false } }, { multi_agent: { enabled: "true" } }, { mcp_servers: [] },
    { context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] } },
    { messages: [{ role: "assistant", content: [{ type: "compaction", content: "summary", signature: "fixture" }] }] },
    { tools: [{ name: "compact_20260112", input_schema: { compaction: { type: "summarize" }, mcp_servers: [{}], multi_agent: { enabled: true } } }] },
  ]) for (const format of ["openai.responses", "anthropic.messages", "google.generate_content", "openai.chat_completions"]) assert.equal(requestPricingGap(pricing, body, format), null);
});

test("cache and long-context rates keep settlement within reservation", () => {
  const tiered = { ...pricing, longContext: { thresholdInputTokens: 10, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 22_500_000, cachedInputMicrosPerMillion: 500_000, cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null } };
  const estimate = estimateModelCost(tiered, { input: "hello", max_output_tokens: 1_000, cache_control: { type: "ephemeral", ttl: "1h" } });
  const actual = actualModelCost(tiered, { input: estimate.inputTokens, output: 1_000, cached: 100, cacheWrite: 100, cacheWrite5m: 50, cacheWrite1h: 50 });
  assert.ok(actual != null && actual <= estimate.reserveMicros);
});

test("generic cache-write pricing reserves and settles reported writes", () => {
  const cachePricing = { ...pricing, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 500_000, cacheWriteInputMicrosPerMillion: 6_250_000, inputTokenOverhead: 0 };
  const estimate = estimateModelCost(cachePricing, { messages: [{ role: "user", content: "hello" }], max_tokens: 0 });
  const actual = actualModelCost(cachePricing, { input: estimate.inputTokens, output: 0, cached: 10, cacheWrite: 20, cacheWrite5m: null, cacheWrite1h: null });
  assert.ok(actual != null && actual <= estimate.reserveMicros);
  assert.equal(actual, Math.ceil(((estimate.inputTokens - 30) * 5_000_000 + 10 * 500_000 + 20 * 6_250_000) / 1_000_000));
  assert.equal(actualModelCost(cachePricing, { input: estimate.inputTokens, output: 0, cached: 10, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }), null);
});

test("bundled Astra standard pricing applies cache writes and the full-request long-context boundary", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../generated/provider-snapshot.json", import.meta.url), "utf8"));
  const astra = snapshot.model_index["openai/gpt-6-astra"].pricing;
  const tokens = { serviceTier: "default", input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };
  assert.equal(actualModelCost(astra, tokens), 2_120_000);
  assert.equal(actualModelCost(astra, { ...tokens, input: 272_001 }), 4_215_020);
  assert.equal(actualModelCost(astra, { ...tokens, cacheWrite: null }), null);
  assert.deepEqual(estimateModelCost(astra, { previous_response_id: "resp_example", service_tier: "default" }), {
    inputTokens: 922_000,
    outputTokens: 128_000,
    reserveMicros: 32_650_000,
  });
});

const catalog = JSON.parse(readFileSync(new URL("../generated/provider-snapshot.json", import.meta.url), "utf8")).model_index;
const counts = { input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };

test("Astra uses actual served tier, aliases, and exact long-context prices", () => {
  const astra = catalog["openai/gpt-6-astra"].pricing;
  for (const [serviceTier, short, long] of [["default", 2_120_000, 4_215_020], ["priority", 4_240_000, 8_430_040], ["fast", 4_240_000, 8_430_040], ["flex", 1_060_000, 2_107_510]]) {
    assert.equal(actualModelCost(astra, { ...counts, serviceTier }), short);
    assert.equal(actualModelCost(astra, { ...counts, serviceTier, input: 272_001 }), long);
  }
  for (const serviceTier of [undefined, "auto", "unknown"]) assert.equal(actualModelCost(astra, { ...counts, serviceTier }), null);
});

test("auto and omitted tiers reserve all supported rates without changing the request", () => {
  const astra = catalog["openai/gpt-6-astra"].pricing;
  for (const service_tier of [undefined, "auto", "priority", "fast"]) {
    const body = { previous_response_id: "opaque", service_tier };
    const before = structuredClone(body);
    assert.equal(estimateModelCost(astra, body).reserveMicros, 65_300_000);
    assert.deepEqual(body, before);
  }
  assert.equal(estimateModelCost(astra, { service_tier: "scale" }).pricingAvailable, false);
  assert.equal(estimateModelCost(pricing, { service_tier: "standard_only" }).pricingAvailable, undefined);
});

test("model-specific prices and short-only cards do not inherit an Astra multiplier", () => {
  const shortTokens = { input: 100_000, output: 1_000, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, serviceTier: "priority" };
  assert.equal(actualModelCost(catalog["openai/gpt-5.5"].pricing, shortTokens), 1_325_000);
  assert.equal(actualModelCost(catalog["openai/gpt-4.1-mini"].pricing, shortTokens), 72_800);
  assert.equal(actualModelCost(catalog["openai/gpt-5.6"].pricing, { ...shortTokens, serviceTier: "default" }), 420_000);
  assert.equal(actualModelCost(catalog["openai/gpt-5.4"].pricing, { ...shortTokens, input: 100_000, cached: 100_000, output: 0, serviceTier: "flex" }), 13_000);
  for (const id of ["openai/gpt-5.4", "openai/gpt-5.5"]) {
    const model = catalog[id].pricing;
    assert.equal(actualModelCost(model, { ...shortTokens, input: 272_001 }), null);
    const estimate = estimateModelCost(model, { previous_response_id: "opaque" });
    assert.ok(estimate.reserveMicros >= actualModelCost(model, { ...shortTokens, input: 272_000 }));
    assert.ok(estimate.reserveMicros >= actualModelCost(model, { ...shortTokens, input: model.maxInputTokens, serviceTier: "default" }));
  }
  assert.equal(estimateModelCost(catalog["openai/gpt-4.1-mini"].pricing, { service_tier: "flex" }).pricingAvailable, false);
});
