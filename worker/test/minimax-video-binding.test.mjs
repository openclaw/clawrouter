import assert from "node:assert/strict";
import test from "node:test";
import { miniMaxVideoBinding, miniMaxT2VModels, readMiniMaxVideoBinding } from "../../shared/minimax-video-binding.ts";

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
