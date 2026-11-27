import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { azureSpeechRegionalOrigin, prepareAzureSpeechSsml, azureSpeechSsmlLimit } from "../azure-speech-ssml.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/azure-speech/ssml.json", import.meta.url), "utf8"));
const prepare = (body = wire.request.body, format = wire.request.headers["X-Microsoft-OutputFormat"]) => prepareAzureSpeechSsml(body, "application/ssml+xml; charset=utf-8", format);

test("Azure Speech preserves the frozen SSML and all three output targets", () => {
  for (const format of wire.consumerOutputFormats) {
    const result = prepare(undefined, format);
    assert.equal(result.body, wire.request.body);
    assert.equal(result.language, "en-US");
    assert.equal(result.voice, "en-US-JennyNeural");
    assert.equal(result.outputFormat, format);
    assert.equal(result.inputCodePoints, [..."Synthetic café & 中文 😀"].length);
    assert.ok(result.characterUpperBound > result.inputCodePoints + 2);
  }
});

test("Azure Speech binds the public regional origin without accepting URL-shaped regions", () => {
  assert.equal(azureSpeechRegionalOrigin("eastus"), "https://eastus.tts.speech.microsoft.com");
  for (const region of ["", "https://example.com", "eastus.example.com/", "eastus@host", "../eastus", "eastus:443", "EASTUS", "x".repeat(33)]) {
    assert.throws(() => azureSpeechRegionalOrigin(region), /region/);
  }
});

test("Azure Speech rejects general XML, external resources and ambiguous character input", () => {
  const ssml = wire.request.body;
  for (const bad of [
    '<!DOCTYPE speak SYSTEM "https://xml.example">' + ssml,
    ssml.replace("Synthetic café", '<audio src="https://audio.example"/>'),
    ssml.replace("&amp;", "&unknown;"), ssml.replace("&amp;", "&#38;"),
    ssml.replace("Synthetic café", "\u0000"), ssml.replace("Synthetic café", "\ud800"),
    ssml.replace("Synthetic café", "]]>"),
    ssml.replace("</voice>", "</voice><voice name=\"en-US-JennyNeural\">extra</voice>"),
    ssml.replace('name="en-US-JennyNeural"', 'name="voice&quot; injected"'),
    ssml.replace("Synthetic café &amp; 中文 😀", " "),
  ]) assert.throws(() => prepare(bad));
  assert.throws(() => prepare("x".repeat(azureSpeechSsmlLimit + 1)), /byte limit/);
  assert.throws(() => prepare(undefined, "mp3"), /format/);
  assert.throws(() => prepareAzureSpeechSsml(ssml, "application/json", wire.consumerOutputFormats[0]), /ssml\+xml/);
});

test("Azure Speech character bound preserves entities, whitespace and Han/supplementary characters", () => {
  const inner = "中文\t😀 e\u0301 &amp; &lt;voice&gt;";
  const body = wire.request.body.replace("Synthetic café &amp; 中文 😀", inner);
  const result = prepare(body);
  assert.equal(result.characterUpperBound, inner.length * 2);
  assert.equal(result.inputCodePoints, [..."中文\t😀 e\u0301 & <voice>"].length);
  assert.equal(result.body, body);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});
