import assert from "node:assert/strict";
import test from "node:test";
import { prepareSageRequest, decodeSageResponse } from "../provider-sage.ts";
import { prepareSystemOneRequest, decodeSystemOneResponse, systemOneRequestHeaders } from "../provider-systemone.ts";
import { decisionImageBytes, decisionImageUri } from "../provider-decision-images.ts";
import { png, uri, sageImage, liquidImage, typeSafeImage } from "./provider-decision-image-fixtures.ts";

test("Sage image fields survive single and batch requests without model injection", () => {
  assert.deepEqual(prepareSageRequest(sageImage), sageImage);
  const batch = { requests: [{ content: sageImage.content, questions: [sageImage.question] }] };
  assert.deepEqual(prepareSageRequest(batch, true), batch);
  const result = { id: "gate", kind: "yesno", result: { answer: "yes", probability: 0.98 }, meta: { usage: { input_tokens: 81, output_tokens: 0, image_tokens: 313 } } };
  const decoded = decodeSageResponse(result, sageImage);
  assert.strictEqual(decoded.response, result);
  assert.equal(decoded.inspection.outcome, "success");
  assert.equal(decoded.inspection.tokens, null, "unqualified image-counter overlap cannot become a tariff");
  assert.equal(decodeSageResponse({ ...result, meta: { usage: { input_tokens: 81, output_tokens: 0, image_tokens: -1 } } }, sageImage), null);
});

test("Sage enforces image-only question limits and non-null image tag results", () => {
  assert.throws(() => prepareSageRequest({ ...sageImage, question: { id: "sort", kind: "sort", instructions: "sort" } }), /sage_sort_content/);
  assert.throws(() => prepareSageRequest({ ...sageImage, question: { id: "choice", kind: "choice", instructions: "select", options: Array.from({ length: 21 }, (_, i) => ({ option: String(i) })) } }), /sage_criteria/);
  const request = prepareSageRequest({ ...sageImage, question: { id: "tags", kind: "tags", tags: [{ id: "red" }] } });
  const response = { id: "tags", kind: "tags", result: { tags: [{ id: "red", probability: 0.99, applies: true }] }, meta: {} };
  assert.ok(decodeSageResponse(response, request));
  response.result.tags[0].applies = null;
  assert.equal(decodeSageResponse(response, request), null);
});

test("Liquid preserves ordered image forms and aggregate input usage", () => {
  const input = { ...liquidImage, images: [uri, { content_type: "image/png", base64: png }] };
  const prepared = prepareSystemOneRequest(input, "d1.1", "liquid-ai");
  assert.deepEqual(prepared, input);
  assert.deepEqual(systemOneRequestHeaders(prepared, "liquid-ai"), {});
  const response = { model: "d1.1", answers: { gate: { type: "noul", noul: 0.87 } }, usage: { input_tokens: 313, output_tokens: 0 } };
  const decoded = decodeSystemOneResponse(response, prepared, "liquid-ai");
  assert.equal(decoded.inspection.tokens.input, 313);
  assert.equal(decoded.inspection.tokens.total, 313);
  assert.throws(() => prepareSystemOneRequest({ ...input, images: Array(9).fill(uri) }, "d1.1", "liquid-ai"), /liquid_images/);
  assert.throws(() => prepareSystemOneRequest({ ...input, images: [] }, "d1.1", "liquid-ai"), /liquid_images/);
});

test("TypeSafe referenced assets require its product-specific image header", () => {
  const prepared = prepareSystemOneRequest(typeSafeImage, "jev-latest", "typesafe");
  assert.deepEqual(prepared, typeSafeImage);
  assert.deepEqual(systemOneRequestHeaders(prepared, "typesafe"), { "TypeSafe-Danger-Zone-Images": "true" });
  const text = prepareSystemOneRequest({ model: "jev-latest", state: "text", questions: typeSafeImage.questions }, "jev-latest", "typesafe");
  assert.deepEqual(systemOneRequestHeaders(text, "typesafe"), {});
  for (const state of ["unused", { "fixture-image-reference": "not a value reference" }]) {
    assert.throws(() => prepareSystemOneRequest({ ...typeSafeImage, state }, "jev-latest", "typesafe"), /image_reference/);
  }
  const inCriteria = { ...typeSafeImage, state: "text", questions: { gate: { type: "noul", criteria: { true: { image: "fixture-image-reference" } } } } };
  assert.ok(prepareSystemOneRequest(inCriteria, "jev-latest", "typesafe"));
  const overlapping = { ...typeSafeImage, assets: { ...typeSafeImage.assets, reference: typeSafeImage.assets["fixture-image-reference"] } };
  assert.throws(() => prepareSystemOneRequest(overlapping, "jev-latest", "typesafe"), /reference_overlap/);
});

test("native image contracts never cross products or fetch remote images", () => {
  assert.throws(() => prepareSystemOneRequest(typeSafeImage, "d1.1", "liquid-ai"), /systemone_fields/);
  assert.throws(() => prepareSystemOneRequest(liquidImage, "jev-latest", "typesafe"), /systemone_fields/);
  assert.throws(() => prepareSystemOneRequest({ ...typeSafeImage, assets: { "fixture-image-reference": { type: "image", format: "png", data_base64: png, part: "upload" } } }, "jev-latest", "typesafe"), /typesafe_image/);
  assert.throws(() => prepareSageRequest({ ...sageImage, content: { kind: "image", media: "https://image.example/photo.png" } }), /image_uri/);
  assert.throws(() => prepareSystemOneRequest({ ...liquidImage, images: ["https://image.example/photo.png"] }, "d1.1", "liquid-ai"), /image_uri/);
});

test("image wire validation rejects mismatched signatures, malformed padding and encoded overflow", () => {
  assert.equal(decisionImageBytes(png, "image/png"), Buffer.from(png, "base64").length);
  for (const data of ["", "!AAA", "AAAA=", "AAA=\n", "AB==", "AAB="]) assert.throws(() => decisionImageBytes(data, "image/png"), /invalid_decision_image/);
  assert.throws(() => decisionImageBytes(png, "image/jpeg"), /image_media_type/);
  assert.throws(() => decisionImageBytes("A".repeat(4 * Math.ceil(4 * 1024 * 1024 / 3) + 4), "image/png"), /image_base64/);
  assert.throws(() => decisionImageUri(uri, ["image/jpeg"]), /image_uri/);
});

test("complete JSON limits include image bytes, text, questions and selected model", () => {
  assert.throws(() => prepareSystemOneRequest({ ...liquidImage, state: "x".repeat(4_500_000) }, "d1.1", "liquid-ai"), /body_limit/);
  assert.throws(() => prepareSystemOneRequest(liquidImage, "x".repeat(4_500_000), "liquid-ai"), /body_limit/);
});
