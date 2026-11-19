import assert from "node:assert/strict";
import test from "node:test";
import { minimaxSpeechBinding, minimaxMusicBinding, minimaxMusicCoverBinding, readNativeMediaBinding } from "../../shared/native-media-binding.ts";

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


test("cover is an exact additive profile, never a V1 music or speech upgrade", () => {
  assert.equal(JSON.stringify(minimaxMusicBinding), '{"version":"clawrouter.native-media.v1","product":"native-media","region":"global","origin":"https://api.minimax.io","operation":"minimax.music","credentialKind":"api_key","credentialSource":"credential"}');
  assert.deepEqual(readNativeMediaBinding(minimaxMusicCoverBinding), minimaxMusicCoverBinding);
  for (const key of Object.keys(minimaxMusicCoverBinding)) {
    const value = { ...minimaxMusicCoverBinding }; delete value[key];
    assert.equal(readNativeMediaBinding(value), null);
    assert.equal(readNativeMediaBinding({ ...minimaxMusicCoverBinding, [key]: "foreign" }), null);
  }
  for (const value of [{ ...minimaxMusicCoverBinding, permission: true }, { ...minimaxMusicBinding, model: "music-cover" },
    { ...minimaxMusicCoverBinding, origin: "https://api.minimax.cn" }, { ...minimaxMusicCoverBinding, model: "music-2.6" },
    { ...minimaxMusicCoverBinding, credentialSource: "environment" }]) assert.equal(readNativeMediaBinding(value), null);
});
