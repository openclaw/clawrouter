import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const { prepareNativeXaiSpeech } = await import("../native-xai-speech.ts");
const { xaiSpeechFormats } = await import("../xai-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
// Offline generated 440 Hz test tone, 24000 Hz mono, not native synthesis.
// MP3 is 128 kbps. All five fixtures were fully decoded with ffmpeg; raw PCM is
// s16le and G.711 inputs used explicit codec/rate/channels. No Worker transcoder.
const fixtures = {
  mp3: { base64: "//PExABJDAo0AVx4ATRqNNGo80mmzUqvNbr01yqzRJJMGJA4FKD5vVPz+M+juz0eFOxzs4a2zVZ9MrjsxaITFwkMQB4w8IDEQkMRB4w0FjCQOMEAQtYBjAdwBOAAwAWARgqxMzLOgtgtgmgmg9BcFBEvDT5pmmh6vj0f7gMDI8pl+yRNXvvEB4r399+937OrGR5SlHjxkV7O/fv379+zqxkePHjx48ZFer379+/fv2dWKx48ePHjxkV7O/fv379+/VjI8ePHjx48Z379+/fv379kePHjx48ePGd+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379/HePHjx48ePIj9+/fv37+94kB48ePKUpe8N+/uHhgAAAAAqAADAYMBYUabTMHxGMSRaeJYUwcBIwvF8yPcI9yRQlSc+pHIw4ZY2if0z7JoxREYWChiBiwXBgyN5gC5lB5jCIYcZunQbbCSzhC1QFFpi//PExE5krDpgX53QAMstFCCD10K8M03Ea4qnzIJUxUhXCXcsNImmL8nnEMPoEUk3VsxNIGN31clrMSf52m8nn4eS0/BspZi4gEVmsfmLcABDKYy/s1Go1VbyXO48lM/DyG8nmXjGKUm4imZfGMQm0eymM1qamq0tLlTPxCKaHIRTQ5IDGojCDTPIzGnjCBzOHzGmDCAzNG6amxxx1llvHHVM/EIpn4hFM/EgrQ5IDMpDIBzUJTMnjJAzTITMmgElNIdMyWByU0RmmtY0uOsst48/L/+tDk5WhycrRSirRS9Wll6sY0QJETJCzGhBYiZISY0EPETIBTGgCYiZAGAjRWKMcBBRrX/v/y3+Osq28auWVbHGlll65LOXJZy5LOXJZ9yxu5YzuWCIoAjoONDxQDGQg0NFAUZDDQsUBxkONCRQIKiRoOKBhUaNBhQOIjxorFUwhDGRJAY0i6Y4mEGTBqjo7D78jaDTGsDeuDTjkbzFDwgiIRBlzxjA6CqXqAVB//PExC5O7Do0Cdp4ANYK9SCYssEhFxHpE1FxOFJCTAphcTRNEnJOUJXQ3g1ROVCnTRNFQrogwhRcWVhQ00VS3EqE2NFxgp1DUJXQkwOYlrjBTpoqFeEmCPFxmynTRUK8N4NUXGJthOVQrxbh6lDTcFWsrUW4epQ0jQVaytRbh6lDJGlVrK1FuHqUMkaVWsrUX4epQyPssLLIX4gyhkfZYWWQvxOlTCZrsLLIX4nSphM12FlkL8TpUtzNdhZZC/E6VLczXYWWQvxOlS3M13rLIX4nSpbldt69kOYnSpbldO9eyHMTplYldO9eyHMTplYldO9eyHMTplYldPBeyHMTplYldPBeyHMTplYlFPBeyHMTpxYlFGgvZDmJ0kxBTUU0LjCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", bytes: 1152, sha256: "9048e9affe6127656a008c1d51225ef0283fc1ac439d59b1bc3a6f083c5e550c", decodedPcmBytes: 3456 },
  wav: { base64: "UklGRuQDAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YcADAAAAALICWgXwB2wKxAzxDusQqxIsFGkVXRYGF2AXaxcmF5MWsxWKFBsTaxGAD2ANEwuhCBEGbAO8AAr+XvvC+D723POj8Zrvye027Obq3ukg6bHokOi/6D3pCOoe63rsGe717wfySPSx9jr52fuH/joB6QOKBhUJgQvHDd0PvhFiE8UU4RWzFjgXbxdVF+0WNxY1FesTXhKTEI8OWgz7CXoH3wQ1AoL/0vws+pr3JPXT8q/wv+4K7ZXrZep+6eTomOic6O/okOl96rTrL+3q7t/wCPNc9dX3afoQ/cH/cwIdBbUHMwqPDMAOvxCFEgwUTxVKFvoWWxdtFzAXpBbLFagUPxOVEa8PlA1LC9sITgarA/sASf6c+/74ePYS9NTxx+/x7VjsAuvz6S/puOiQ6LjoL+nz6QLrWOzx7cfv1PES9Hj2/vic+0n++wCrA04G2whLC5QNrw+VET8TqBTLFaQWMBdtF1sX+hZKFk8VDBSFEr8QwA6PDDMKtQcdBXMCwf8Q/Wn61fdc9Qjz3/Dq7i/ttOt96pDp7+ic6Jjo5Oh+6WXqlesK7b/ur/DT8iT1mvcs+tL8gv81At8Eegf7CVoMjw6TEF4S6xM1FTcW7RZVF28XOBezFuEVxRRiE74R3Q/HDYELFQmKBukDOgGH/tn7Ovmx9kj0B/L17xnueuwe6wjqPem/6JDosegg6d7p5uo27Mntmu+j8dzzPvbC+F77Cv68AGwDEQahCBMLYA2AD2sRGxOKFLMVkxYmF2sXYBcGF10WaRUsFKsS6xDxDsQMbArwB1oFsgIAAE79pvoQ+JT1PPMP8RXvVe3U65fqo+n66KDoleja6G3pTep26+Xsle6A8KDy7fRf9+/5lPxE//YBogQ+B8IJJAxdDmYQNxLKExoVIhbgFk8XcBdBF8MW+BXiFIYT5xELEPkNuAtPCcYGJwR5Acb+F/x2+ev2f/Q58iPwQu6e7DvrH+pN6cjokeir6BPpyenL6hXsou1t73HxpvMF9ob4IfvL/X4ALgPUBWYI3AotDVEPQRH2EmsUmxWCFhwXaBdkFxEXcBaDFUwU0RIWESEP+AykCisIlwXwAj8Ajf3j+kv4zfVx80DxQe977fTrseq26QbppeiT6NDoXOk16ljrwexr7lHwbPK19CX3svlV/AX/twFkBAIHiAnuCywOORAPEqgT/hQNFtEWSBdwF0gX0RYNFv4UqBMPEjkQLA7uC4gJAgdkBLcBBf9V/LL5Jfe19GzyUfBr7sHsWOs16lzp0OiT6KXoBuk=", bytes: 1004, sha256: "5fb64d8f80a049c065e15b165c2607506cff25f713695a6614e038f5bcf49a98", decodedPcmBytes: 960 },
  pcm: { base64: "AACyAloF8AdsCsQM8Q7rEKsSLBRpFV0WBhdgF2sXJheTFrMVihQbE2sRgA9gDRMLoQgRBmwDvAAK/l77wvg+9tzzo/Ga78ntNuzm6t7pIOmx6JDov+g96QjqHut67Bnu9e8H8kj0sfY6+dn7h/46AekDigYVCYELxw3dD74RYhPFFOEVsxY4F28XVRftFjcWNRXrE14SkxCPDloM+wl6B98ENQKC/9L8LPqa9yT10/Kv8L/uCu2V62Xqfunk6JjonOjv6JDpfeq06y/t6u7f8AjzXPXV92n6EP3B/3MCHQW1BzMKjwzADr8QhRIMFE8VShb6FlsXbRcwF6QWyxWoFD8TlRGvD5QNSwvbCE4GqwP7AEn+nPv++Hj2EvTU8cfv8e1Y7ALr8+kv6bjokOi46C/p8+kC61js8e3H79TxEvR49v74nPtJ/vsAqwNOBtsISwuUDa8PlRE/E6gUyxWkFjAXbRdbF/oWShZPFQwUhRK/EMAOjwwzCrUHHQVzAsH/EP1p+tX3XPUI89/w6u4v7bTrfeqQ6e/onOiY6OTofull6pXrCu2/7q/w0/Ik9Zr3LPrS/IL/NQLfBHoH+wlaDI8OkxBeEusTNRU3Fu0WVRdvFzgXsxbhFcUUYhO+Ed0Pxw2BCxUJigbpAzoBh/7Z+zr5sfZI9Afy9e8Z7nrsHusI6j3pv+iQ6LHoIOne6ebqNuzJ7Zrvo/Hc8z72wvhe+wr+vABsAxEGoQgTC2ANgA9rERsTihSzFZMWJhdrF2AXBhddFmkVLBSrEusQ8Q7EDGwK8AdaBbICAABO/ab6EPiU9TzzD/EV71Xt1OuX6qPp+uig6JXo2uht6U3qduvl7JXugPCg8u30X/fv+ZT8RP/2AaIEPgfCCSQMXQ5mEDcSyhMaFSIW4BZPF3AXQRfDFvgV4hSGE+cRCxD5DbgLTwnGBicEeQHG/hf8dvnr9n/0OfIj8ELunuw76x/qTenI6JHoq+gT6cnpy+oV7KLtbe9x8abzBfaG+CH7y/1+AC4D1AVmCNwKLQ1RD0ER9hJrFJsVghYcF2gXZBcRF3AWgxVMFNESFhEhD/gMpAorCJcF8AI/AI394/pL+M31cfNA8UHve+3067HqtukG6aXok+jQ6FzpNepY68Hsa+5R8GzytfQl97L5VfwF/7cBZAQCB4gJ7gssDjkQDxKoE/4UDRbRFkgXcBdIF9EWDRb+FKgTDxI5ECwO7guICQIHZAS3AQX/Vfyy+SX3tfRs8lHwa+7B7FjrNepc6dDok+il6Abp", bytes: 960, sha256: "3e5f8972a69f7290c136581ccad885c3d78543c6544cdc1c4e8b34aab99dbc69", decodedPcmBytes: 960 },
  mulaw: { base64: "/9bIv7q1sa6sq6qpqKioqKipqqyusLS4vcXQ61xLQDs2Mi8tKyopKCgoKCgpKistLzI3PEJNYOTOw7y3s6+trKqpqKioqKipqqutrrG2u8DK2m9SRj45NDAuLCspKCgoKCgpKSssLjA1OT5HVHfYyb+6tbGurKuqqaioqKioqaqsra+zuL3Ez+heTEE7NzIvLSsqKSgoKCgoKSorLS8yNztBTF7oz8S9uLOvrayqqaioqKioqaqrrK6xtbq/ydh3VEc+OTUwLiwrKSkoKCgoKCkrLC4wNDk+RlJv2srAu7axrq2rqqmoqKioqKmqrK2vs7e8w87kYE1CPDcyLy0rKikoKCgoKCkqKy0vMjY7QEtc69DFvbi0sK6sqqmoqKioqKmqq6yusbW6v8jW/1ZIPzo1MS4sKyopKCgoKCgpKiwuMDQ4PUVQa9zLwLu2sq+tq6qpqKioqKipqqutr7O3vMLN4GNOQzw3My8tLCopKCgoKCgpKistLjE2OkBKWvDSxr65tLCurKupqKioqKipqausrrC1ub7H1PdYST86NTEuLCsqKSgoKCgoKSosLS8zOD1ET2fezMG7t7KvrauqqaioqKioqaqrra+yt7vBzN5nT0Q9ODMvLSwqKSgoKCgo", bytes: 480, sha256: "7e9dc5ad8ae07cc90a52384f75ef72fd98c90d527f513e756f3d63168c491b2e", decodedPcmBytes: 960 },
  alaw: { base64: "1fDg6pGcmIWHgYCDgoKCgoOAgYaEmp+TlO3+3kpnaBYdGQUHBgADAwICAgMAAQYEGh4SF25lQsb675eSnpqEhoGAg4KCgoODgIaHhZidlujm9F18YhUQHxsEBwEAAwICAgIDAAEHBBscEBVjclH24euRnJiFh4GAg4OCgoKDgIGGhJqek5Ts+NpOZGkWEhkFBwYAAwMCAgIDAwAGBwUZEhZpZE7a+OyUk56ahIaBgIOCgoKDg4CBh4WYnJHr4fZRcmMVEBwbBAcBAAMCAgICAwABBwQbHxAVYnxd9Obolp2YhYeGgIODgoKCg4CBhoSanpKX7/rGQmVuFxIeGgQGAQADAgICAwMABgcFGR0WaGdK3v7tlJOfmoSGgYCDgoKCgoOAgYeFmJyR6uDw1XBgahEcGAUHAQADAgICAgMAAQYEGh8TFG1+Xsrn6ZadmYWHhoCDg4KCgoOAgYaEmp6Sl+7lwkZ6bxcSHhoEBgEAAwICAgMDAAYHBRgdFmhmdNL84pWQn5uEh4GAg4KCgoKDgIGHhJuckJXj8tZ2YWsRHBgFBwEAAwMCAgIDAAEGBBoeExRseFrO5OmWkpmFh4aBg4OCgoKDg4GGh4WZkpbp5M5aeGwUEx4aBAYBAAMCAgID", bytes: 480, sha256: "c4cd777b0fb2beffc7563e3447b71bd070180084f3520df8c8373a8c146d3a19", decodedPcmBytes: 960 },
};
const provider = { id: "xai", base_urls: { default: "https://api.x.ai" } };
const endpoint = { id: "speech", method: "POST", path: "/v1/tts", path_params: [], query: {}, streaming: null,
  request_format: "xai.tts", response_format: "audio.binary" };
function selection(codec = "mp3", body = { text: "Synthetic [pause] speech", voice_id: "eve", language: "en", output_format: { codec }, speed: 1 }) {
  return { provider, endpoint, model: null, capability: "audio.speech", body, pathParams: {}, method: "POST" };
}
const native = (selected = selection()) => prepareNativeXaiSpeech(selected);
const audio = codec => Buffer.from(fixtures[codec].base64, "base64");
function response(codec = "mp3", headers = {}, bytes = audio(codec), status = 200) {
  return new Response(bytes, { status, headers: { "content-type": xaiSpeechFormats[codec], ...headers } });
}
async function read(upstream = response(), selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("xAI unary leaf preserves all five documented codec MIME pairs and decoder-verified test bytes", async () => {
  assert.deepEqual(Object.keys(fixtures), Object.keys(xaiSpeechFormats));
  for (const codec of Object.keys(fixtures)) {
    const bytes = audio(codec), selected = selection(codec), before = structuredClone(selected), prepared = native(selected);
    assert.equal(bytes.length, fixtures[codec].bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtures[codec].sha256);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, "/v1/tts");
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    const result = await read(response(codec), selected);
    assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), bytes);
    assert.equal(result.response.headers.get("content-type"), xaiSpeechFormats[codec]);
    assert.equal(result.response.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined);
  }
});

test("xAI unary leaf requires model null and the exact native format, capability and fixed origin", () => {
  const prepared = native();
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?voice_id=eve", prepared.origin + "/v1/audio/speech",
    "https://other.example/v1/tts", "https://api.x.ai/v1/tts#synthetic"])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  for (const change of [{ provider: { ...provider, id: "xai-portal" } }, { provider: { ...provider, base_urls: { default: "https://api.x.ai/v1" } } },
    { model: undefined }, { model: { upstream: "tts-1" } }, { capability: "llm.chat" }, { method: "GET" },
    { pathParams: { voice: "eve" } }, { nativeQuery: {} }]) assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1/tts/voices" }, { response_format: "binary" },
    { upstreamPath: endpoint.path }, { path_params: ["voice"] }, { query: { voice_id: "eve" } }, { streaming: "sse" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "openai.audio_speech" } }), undefined);
});

test("xAI unary input retains native voice and markup without model, fallback or new options", () => {
  const body = selection().body;
  for (const voice_id of ["ara", "eve", "leo", "rex", "sal", "native_voice-1"]) {
    const selected = selection("mp3", { ...body, voice_id, language: "pt-BR", text: "Synthetic <whisper>speech</whisper>" });
    native(selected); assert.equal(selected.body.voice_id, voice_id); assert.equal(selected.body.language, "pt-BR");
  }
  for (const change of [{ model: "tts-1" }, { model: undefined }, { voice_id: undefined }, { voice_id: "" }, { voice_id: "x".repeat(129) },
    { language: "en?synthetic" }, { language: undefined }, { speed: 0.6 }, { speed: 1.6 }, { speed: "1" },
    { text: "" }, { text: "x".repeat(60001) }, { text: String.fromCharCode(0xd800) },
    { output_format: { codec: "opus" } }, { output_format: { codec: "pcm", sample_rate: 8000 } },
    { with_timestamps: true }, { stream: false }, { api_key: "synthetic" }, { reference: "https://media.example/audio" },
    { extra: "x".repeat(512 * 1024 + 1) }])
    assert.throws(() => native(selection("mp3", { ...body, ...change })));
  for (const text of ["x".repeat(60000), "😀".repeat(30000), String.fromCharCode(1).repeat(60000)])
    assert.ok(native(selection("mp3", { ...body, text })));
});

test("xAI speech lease charges 64 MiB alongside ingress in the actual 96 MiB capacity", () => {
  assert.equal(bodyBudgetBytes, 96 * 1024 * 1024);
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  assert.throws(() => native().acquire(), /capacity is busy/);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
});

test("xAI identity encoding preserves exact Content-Length enforcement without changing upstream headers", async () => {
  for (const codec of Object.keys(fixtures)) {
    const bytes = audio(codec), headers = { "content-encoding": "identity", "content-length": String(bytes.length) }, upstream = response(codec, headers);
    const result = await read(upstream, selection(codec)); assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), bytes);
    assert.equal(upstream.headers.get("content-encoding"), "identity");
    assert.equal(upstream.headers.get("content-length"), String(bytes.length));
    for (const length of [bytes.length - 1, bytes.length + 1])
      await assert.rejects(read(response(codec, { ...headers, "content-length": String(length) }), selection(codec)),
        { message: "invalid_native_xai_speech_response" });
  }
});

test("xAI rejects unsupported encodings, wrong or parameterized MIME, ranges, redirects and HTTP errors", async () => {
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "audio/mpeg; charset=utf-8" },
    { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }, { "content-encoding": "br" }, { "content-encoding": "" },
    { "content-encoding": "identity, gzip" }, { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" },
    { "content-length": "0" }, { "content-length": String(16 * 1024 * 1024 + 1) }]) await assert.rejects(read(response("mp3", headers)));
  const missing = response(); missing.headers.delete("content-type"); await assert.rejects(read(missing));
  for (const status of [201, 202, 206, 302, 422, 500]) await assert.rejects(read(response("mp3", {}, audio("mp3"), status)));
  for (const encoding of [undefined, "identity"]) {
    const redirected = response("mp3", encoding ? { "content-encoding": encoding } : {});
    Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  for (const codec of Object.keys(fixtures)) {
    await assert.rejects(read(response(codec, { "content-type": codec === "wav" ? "audio/mpeg" : "audio/wav" }), selection(codec)));
    await assert.rejects(read(response(codec, {}, new Uint8Array()), selection(codec)));
  }
});

test("xAI bounds decoded binary bytes at 16 MiB and retains PCM whole-sample validation", async () => {
  // Silent raw PCM is a byte-bound fixture; this is not duration or invoice evidence.
  const bytes = new Uint8Array(16 * 1024 * 1024);
  const result = await read(response("pcm", { "content-length": String(bytes.length) }, bytes), selection("pcm"));
  assert.equal((await result.response.arrayBuffer()).byteLength, bytes.length);
  await assert.rejects(read(response("pcm", {}, new Uint8Array(bytes.length + 2)), selection("pcm")));
  await assert.rejects(read(response("pcm", {}, new Uint8Array(3)), selection("pcm")));
});

test("xAI counts every transport chunk including empty chunks before retaining codec buffers", async () => {
  async function chunked(emptyChunks) {
    let count = 0;
    const stream = new ReadableStream({ pull(controller) {
      if (count++ < emptyChunks) controller.enqueue(new Uint8Array());
      else if (count === emptyChunks + 1) controller.enqueue(audio("mp3"));
      else controller.close();
    } });
    const pending = read(new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    return { pending };
  }
  const exact = await chunked(8191); assert.deepEqual(Buffer.from(await (await exact.pending).response.arrayBuffer()), audio("mp3"));
  const overflow = await chunked(8192); await assert.rejects(overflow.pending, { message: "invalid_native_xai_speech_response" });
});

test("xAI rejects an endless empty-chunk stream at the finite limit and cancels its producer", async () => {
  let reads = 0, canceled = false;
  const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } });
  await assert.rejects(read(new Response(stream, { headers: { "content-type": "audio/mpeg" } })));
  await new Promise(setImmediate); assert.equal(canceled, true); assert.ok(reads <= 8194);
});

test("xAI complete bytes remain private until EOF and interrupted delivery never succeeds", async () => {
  const bytes = audio("mp3"), headers = { "content-type": "audio/mpeg" }; let controller, settled = false;
  const pending = read(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers }))
    .then(result => { settled = true; return result; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(Buffer.from(await (await pending).response.arrayBuffer()), bytes);
  const broken = new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_xai_speech_response" });
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers: { ...headers, "content-length": String(bytes.length) } })));
});

test("xAI cancellation and timeout stop stalled or pre-aborted readers and release capacity", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort(new DOMException("synthetic", name));
    const pending = read(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "audio/mpeg" } }),
      selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending); await new Promise(setImmediate);
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("xAI output strips upstream headers, returns no fabricated usage and performs no fetch or replay", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const result = await read(response("mp3", { "set-cookie": "synthetic", "x-private-upstream": "synthetic", "x-billed-characters": "123" }));
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.response.headers.get("cache-control"), "no-store"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  for (const header of ["set-cookie", "x-private-upstream", "x-billed-characters", "content-encoding"]) assert.equal(result.response.headers.get(header), null);
  await assert.rejects(read(response("mp3", {}, audio("mp3"), 500)));
  assert.equal(fetch.mock.callCount(), 0);
});

for (const mode of ["headers", "abort", "cleanup-rejection"]) test(`source retirement holds capacity through ${mode}, including reentrant cancellation`, { timeout: 5000 }, async t => {
  const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const abort = new AbortController(), baseline = bodyBudgetCharged();
  let cancels = 0, completed = false;
  const source = new ReadableStream({
    pull() { ready.resolve(); },
    cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const prepared = native(), lease = prepared.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = prepared.read(response("mp3", mode === "headers" ? { "content-type": "application/json" } : {}, source), abort.signal)
    .finally(() => { completed = true; lease.release(); });
  const rejected = assert.rejects(result);
  if (mode !== "headers") { await ready.promise; abort.abort(); }
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(cancels, 1); assert.equal(completed, false); assert.equal(source.locked, true);
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  const competing = new BodyLease();
  assert.equal(competing.grow(17 * 1024 * 1024), false); competing.release();
  if (mode === "cleanup-rejection") cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
  await rejected;
  assert.equal(cancels, 1); assert.equal(source.locked, false);
  assert.equal(bodyBudgetCharged(), baseline);
  lease.release(); assert.equal(bodyBudgetCharged(), baseline);
});

test("a rejected counting transform retains its original pipe until source cancellation settles", { timeout: 5000 }, async t => {
  const canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  let sent = false, complete = false, cancels = 0;
  const source = new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue("invalid binary chunk"); } },
    cancel() { cancels++; canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const prepared = native(), baseline = bodyBudgetCharged(), lease = prepared.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = prepared.read(response("mp3", {}, source), new AbortController().signal)
    .finally(() => { complete = true; lease.release(); });
  const rejected = assert.rejects(result);
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(complete, false); assert.equal(source.locked, true); assert.equal(cancels, 1);
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  cleanup.reject(new Error("synthetic source cleanup rejection")); await rejected;
  assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), baseline); assert.equal(cancels, 1);
});
