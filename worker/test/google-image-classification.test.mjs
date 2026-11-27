import assert from "node:assert/strict";
import test from "node:test";
import { googleImageRequest } from "../google-image-classification.ts";

test("explicit Google image format is unpriced intent independently of model/body", () => {
  for (const body of [undefined, null, {}, [], { model: "text-model" }])
    assert.equal(googleImageRequest(null, body, "google.image_generate"), true);
});
test("only the two frozen selected upstream identities classify omitted output modalities", () => {
  for (const model of ["gemini-3.1-flash-image", "gemini-3-pro-image"])
    assert.equal(googleImageRequest(model, {}, "google.generate_content"), true);
  for (const model of [null, undefined, "gemini-3.5-flash", "google-gemini/gemini-3-pro-image", "other-image-model"])
    assert.equal(googleImageRequest(model, {}, "google.generate_content"), false);
});
test("output IMAGE names and numeric proto enum values classify native intent", () => {
  for (const value of ["IMAGE", 2, "2"]) for (const config of ["generationConfig", "generation_config"])
    for (const field of ["responseModalities", "response_modalities"])
      assert.equal(googleImageRequest("text-model", { [config]: { [field]: ["TEXT", value] } }, "google.generate_content"), true);
});
test("outer ProtoJSON aliases use the last value including null", () => {
  const image = { responseModalities: ["IMAGE"] }, text = { responseModalities: ["TEXT"] };
  assert.equal(googleImageRequest(null, { generationConfig: text, generation_config: image }, "google.generate_content"), true);
  assert.equal(googleImageRequest(null, { generation_config: image, generationConfig: text }, "google.generate_content"), false);
  assert.equal(googleImageRequest(null, { generationConfig: image, generation_config: null }, "google.generate_content"), false);
});
test("nested ProtoJSON aliases use the last value including null", () => {
  for (const [config, expected] of [
    [{ responseModalities: ["TEXT"], response_modalities: ["IMAGE"] }, true],
    [{ response_modalities: ["IMAGE"], responseModalities: ["TEXT"] }, false],
    [{ responseModalities: ["IMAGE"], response_modalities: null }, false],
  ]) assert.equal(googleImageRequest(null, { generationConfig: config }, "google.generate_content"), expected);
});
test("ordinary inline image input, function arguments and prompt strings do not imply image output", () => {
  const body = { model: "gemini-3-pro-image", contents: [{ parts: [{ text: "IMAGE" }, { inlineData: { mimeType: "image/png", data: "synthetic" } },
    { functionResponse: { response: { generationConfig: { responseModalities: ["IMAGE"] } } } }] }],
    tools: [{ functionDeclarations: [{ name: "IMAGE", parameters: { properties: { responseModalities: { default: ["IMAGE"] } } } }] }] };
  assert.equal(googleImageRequest("gemini-3.5-flash", body, "google.generate_content"), false);
});
test("other protocols never acquire a Google image contract from fields or names", () => {
  for (const format of ["openai.chat_completions", "anthropic.messages", "google.embed_content", "google.omni_video_create", "xai.images_generations"])
    assert.equal(googleImageRequest("gemini-3-pro-image", { generationConfig: { responseModalities: ["IMAGE"] } }, format), false);
});
test("missing, text-only and malformed non-image modality values do not invent image output", () => {
  for (const modalities of [undefined, null, [], ["TEXT"], [1], ["AUDIO"], {}, "IMAGE"])
    assert.equal(googleImageRequest(null, { generationConfig: { responseModalities: modalities } }, "google.generate_content"), false);
});
