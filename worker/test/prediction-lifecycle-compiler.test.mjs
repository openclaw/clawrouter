import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

const manifest = parse(readFileSync(new URL("../../providers/replicate.provider.yaml", import.meta.url), "utf8"));
const compile = value => compileProviderSnapshot([value]);

test("Replicate compiles typed prediction links and a bodyless POST cancel endpoint without inventing prices", () => {
  const snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "predictions").lifecycle, {
    protocol: "replicate.predictions", retrieve: "prediction", cancel: "prediction_cancel",
  });
  const cancel = provider.endpoints.find(endpoint => endpoint.id === "prediction_cancel");
  assert.deepEqual(cancel.methods, ["POST"]);
  assert.equal(cancel.path, "/v1/predictions/${prediction_id}/cancel");
  assert.deepEqual(cancel.path_params, ["prediction_id"]);
  assert.equal(cancel.request_format, "replicate.prediction_cancel");
  assert.equal(cancel.response_format, "replicate.prediction");
  assert.equal(cancel.lifecycle, undefined);
  assert.equal(provider.models[0].pricing, null);
  assert.deepEqual(provider.models[0].capabilities, ["media.predict", "media.prediction.read"]);
  assert.ok(Object.values(snapshot.capability_index).flat().every(entry => entry.endpoint !== cancel.id));
});

test("prediction lifecycle links resolve endpoint IDs instead of depending on endpoint names", () => {
  const renamed = structuredClone(manifest);
  renamed.endpoints.inspect = renamed.endpoints.prediction;
  delete renamed.endpoints.prediction;
  renamed.endpoints.stop = renamed.endpoints.prediction_cancel;
  delete renamed.endpoints.prediction_cancel;
  renamed.endpoints.predictions.lifecycle = { protocol: "replicate.predictions", retrieve: "inspect", cancel: "stop" };
  renamed.capabilities.find(capability => capability.id === "media.prediction.read").endpoint = "inspect";
  const result = compile(renamed).providers[0];
  assert.deepEqual(result.endpoints.find(endpoint => endpoint.id === "predictions").lifecycle, renamed.endpoints.predictions.lifecycle);
  const ordinary = structuredClone(manifest);
  delete ordinary.endpoints.predictions.lifecycle;
  assert.ok(compile(ordinary).providers[0].endpoints.every(endpoint => !Object.hasOwn(endpoint, "lifecycle")));
});

const invalidChanges = {
  "missing discriminator": m => { delete m.endpoints.predictions.lifecycle.protocol; },
  "unknown protocol": m => { m.endpoints.predictions.lifecycle.protocol = "other.jobs"; },
  "unknown lifecycle property": m => { m.endpoints.predictions.lifecycle.delete = "prediction_cancel"; },
  "empty link": m => { m.endpoints.predictions.lifecycle.cancel = ""; },
  "inherited link": m => { m.endpoints.predictions.lifecycle.retrieve = "constructor"; },
  "missing link": m => { m.endpoints.predictions.lifecycle.cancel = "missing"; },
  "self link": m => { m.endpoints.predictions.lifecycle.cancel = "predictions"; },
  "shared links": m => { m.endpoints.predictions.lifecycle.cancel = "prediction"; },
  "reused control": m => { m.endpoints.second_create = structuredClone(m.endpoints.predictions); m.capabilities.push({ id: "media.predict", endpoint: "second_create" }); },
  "nested lifecycle": m => { m.endpoints.prediction.lifecycle = structuredClone(m.endpoints.predictions.lifecycle); },
  "wrong provider": m => { m.id = "other"; },
  "wrong create method": m => { m.endpoints.predictions.method = "GET"; },
  "wrong create path": m => { m.endpoints.predictions.path = "/v1/models/example/predictions"; },
  "wrong create format": m => { m.endpoints.predictions.requestFormat = "openai.responses"; },
  "create method broadening": m => { m.capabilities[0].methods.push("GET"); },
  "retrieve method broadening": m => { m.capabilities[1].methods.push("POST"); },
  "cancel capability": m => { m.capabilities.push({ id: "media.predict.cancel", endpoint: "prediction_cancel" }); },
  "generation capability on retrieve": m => { m.capabilities.push({ id: "media.predict", endpoint: "prediction" }); },
  "mixed Responses lifecycle": m => { m.endpoints.predictions.responsesLifecycle = { retrieve: "prediction", cancel: "prediction_cancel" }; },
};
for (const control of ["prediction", "prediction_cancel"]) {
  Object.assign(invalidChanges, {
    [`${control} wrong method`]: m => { m.endpoints[control].method = "DELETE"; },
    [`${control} wrong request format`]: m => { m.endpoints[control].requestFormat = "replicate.prediction_create"; },
    [`${control} wrong response format`]: m => { m.endpoints[control].responseFormat = "other"; },
    [`${control} wrong path`]: m => { m.endpoints[control].path = "/v1/predictions/${prediction_id}/other"; },
    [`${control} wrong parameter`]: m => { m.endpoints[control].pathParams = ["model"]; },
    [`${control} extra parameter`]: m => { m.endpoints[control].pathParams.push("model"); },
    [`${control} unsafe parameter style`]: m => { m.endpoints[control].pathParamStyles = { prediction_id: "relative_path" }; },
    [`${control} passthrough`]: m => { m.endpoints[control].modelPassthrough = {}; },
  });
}
for (const endpoint of ["predictions", "prediction", "prediction_cancel"]) {
  Object.assign(invalidChanges, {
    [`${endpoint} streaming`]: m => { m.endpoints[endpoint].streaming = "sse"; },
    [`${endpoint} websocket`]: m => { m.endpoints[endpoint].websocket = "openai.responses"; },
    [`${endpoint} nonnative`]: m => { m.endpoints[endpoint].nativeProxy = false; },
    [`${endpoint} query override`]: m => { m.endpoints[endpoint].query = { prediction_id: "other" }; },
  });
}
for (const [name, change] of Object.entries(invalidChanges)) {
  test(`prediction lifecycle rejects ${name} before compilation`, () => {
    const invalid = structuredClone(manifest); change(invalid);
    assert.throws(() => compile(invalid), /lifecycle/);
  });
}
