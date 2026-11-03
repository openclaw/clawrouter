import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { prepareDeepgramPrerecorded } from "../worker/deepgram-prerecorded.ts";

test("Deepgram's default native query resolves the unpriced transcription model", () => {
  const manifest = parse(readFileSync(new URL("../providers/deepgram.provider.yaml", import.meta.url), "utf8"));
  const snapshot = compileProviderSnapshot([manifest]);
  const request = prepareDeepgramPrerecorded(new Uint8Array([0, 255, 128, 42]), "audio/wav", new URLSearchParams());
  assert.equal(request.query.get("model"), "nova-3");
  const model = snapshot.model_index["deepgram/nova-3"];
  assert.equal(model.provider, "deepgram");
  assert.equal(model.upstream, request.query.get("model"));
  assert.deepEqual(model.capabilities, ["audio.transcription"]);
  assert.equal(model.pricing, null);
  assert.equal(model.pricing_ref, null);
  assert.equal(snapshot.providers[0].models.length, 1);
  assert.deepEqual(snapshot.providers[0].config_keys, ["DEEPGRAM_API_KEY"]);
  assert.equal(snapshot.providers[0].auth.schemes[0].format, "Token ${secret}");
});
