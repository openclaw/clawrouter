import assert from "node:assert/strict";
import test from "node:test";
import { miniMaxSearchBinding, readMiniMaxSearchBinding } from "../../shared/minimax-search-binding.ts";
for (const region of ["global", "cn"]) test(`Search ${region} authority is closed and round trips without another product`, () => {
  const binding = miniMaxSearchBinding(region); assert.ok(Object.isFrozen(binding));
  assert.deepEqual(readMiniMaxSearchBinding(JSON.parse(JSON.stringify(binding))), binding);
  for (const patch of [{ operation: "minimax.music" }, { product: "payg" }, { model: "search" }, { credentialKind: "oauth" },
    { credentialSource: "environment" }, { origin: region === "global" ? "https://api.minimaxi.com" : "https://api.minimax.io" },
    { version: "future" }, { extra: true }, { region: "GLOBAL" }]) assert.equal(readMiniMaxSearchBinding({ ...binding, ...patch }), null);
  for (const key of Object.keys(binding)) { const incomplete = { ...binding }; delete incomplete[key]; assert.equal(readMiniMaxSearchBinding(incomplete), null); }
});
