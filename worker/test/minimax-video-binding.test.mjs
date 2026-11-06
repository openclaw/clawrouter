import assert from "node:assert/strict";
import test from "node:test";
import { miniMaxInlineVideoBinding, miniMaxVideoBinding, miniMaxT2VModels, readMiniMaxVideoBinding, miniMaxSixModelVideoBinding, miniMaxFrozenVideoModels, miniMaxVideoBindingModel, miniMaxVideoRequiresInline } from "../../shared/minimax-video-binding.ts";

for (const region of ["global", "cn"]) {
  test(`Hailuo ${region} binding preserves only explicit regional T2V authority`, () => {
    const binding = miniMaxVideoBinding(region);
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.models));
    assert.deepEqual(readMiniMaxVideoBinding(JSON.parse(JSON.stringify(binding))), binding);
    for (const patch of [{ product: "speech" }, { operation: "minimax.music" }, { credentialKind: "oauth" },
      { credentialSource: "environment" }, { models: ["MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02"] },
      { models: [...miniMaxT2VModels].reverse() }, { models: [...miniMaxT2VModels, "I2V-01"] },
      { models: new Array(2) }, { origin: "https://api.minimax.cn" }, { version: "future" }, { extra: true },
      { origin: region === "global" ? "https://api.minimaxi.com" : "https://api.minimax.io" }])
      assert.equal(readMiniMaxVideoBinding({ ...binding, ...patch }), null);
    for (const key of Object.keys(binding)) {
      const missing = { ...binding }; delete missing[key]; assert.equal(readMiniMaxVideoBinding(missing), null);
    }
  });
}


test("inline first-frame authority is a strict explicit global V2 union", () => {
  const value = miniMaxInlineVideoBinding();
  assert.deepEqual(readMiniMaxVideoBinding(JSON.parse(JSON.stringify(value))), value);
  assert.equal(value.version, "clawrouter.minimax-video.v2");
  for (const patch of [{ region: "cn" }, { origin: "https://api.minimaxi.com" }, { inputProfile: undefined },
    { inputProfile: "url" }, { version: "clawrouter.minimax-video.v1" }, { extra: true }])
    assert.equal(readMiniMaxVideoBinding({ ...value, ...patch }), null);
  assert.equal(readMiniMaxVideoBinding({ ...miniMaxVideoBinding("global"), inputProfile: value.inputProfile }), null);
});


test("GLOBAL V3 is a closed six-model attestation, never an upgrade of V1 or V2", () => {
  const binding = miniMaxSixModelVideoBinding();
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.models));
  assert.deepEqual(readMiniMaxVideoBinding(JSON.parse(JSON.stringify(binding))), binding);
  for (const patch of [{ version: "clawrouter.minimax-video.v2" }, { region: "cn" }, { origin: "https://api.minimax.cn" },
    { models: miniMaxT2VModels }, { models: [...binding.models].reverse() }, { models: [...binding.models, "MiniMax-Hailuo-H3"] },
    { inputProfile: "url" }, { extra: true }, { credentialKind: "oauth" }]) assert.equal(readMiniMaxVideoBinding({ ...binding, ...patch }), null);
  for (const model of miniMaxFrozenVideoModels) {
    assert.equal(miniMaxVideoBindingModel(binding, model), true);
    assert.equal(miniMaxVideoRequiresInline(model), !miniMaxT2VModels.includes(model));
    for (const previous of [miniMaxVideoBinding("global"), miniMaxVideoBinding("cn"), miniMaxInlineVideoBinding()])
      assert.equal(miniMaxVideoBindingModel(previous, model), miniMaxT2VModels.includes(model));
  }
  for (const model of [null, "I2V-01 ", "minimax/I2V-01", "i2v-01", "MiniMax-Hailuo-H3"])
    assert.equal(miniMaxVideoBindingModel(binding, model), false);
});
