import assert from "node:assert/strict";
import test from "node:test";
import { minimaxSpeechBinding, readNativeMediaBinding } from "../../shared/native-media-binding.ts";

test("native media authorization requires the complete exact versioned owner binding", () => {
  assert.deepEqual(readNativeMediaBinding(minimaxSpeechBinding), minimaxSpeechBinding);
  for (const field of Object.keys(minimaxSpeechBinding)) {
    const absent = { ...minimaxSpeechBinding }; delete absent[field];
    assert.equal(readNativeMediaBinding(absent), null);
    assert.equal(readNativeMediaBinding({ ...minimaxSpeechBinding, [field]: "unqualified" }), null);
  }
  for (const value of [null, true, [], { ...minimaxSpeechBinding, authorized: true },
    { ...minimaxSpeechBinding, origin: "https://api.minimaxi.com" }, { ...minimaxSpeechBinding, credentialKind: "oauth" }])
    assert.equal(readNativeMediaBinding(value), null);
});
