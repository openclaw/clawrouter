import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const { prepareNativeOpenRouterMusic: prepare } = await import("../native-openrouter-music.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { observeUsage } = await import("../proxy-response.ts");
const { HttpOperation } = await import("../http-operation.ts");
// Existing offline, decoder-verified 24 kHz mono MP3 test tone; not provider synthesis.
const fixture = {"base64":"//PExABJDAo0AVx4ATRqNNGo80mmzUqvNbr01yqzRJJMGJA4FKD5vVPz+M+juz0eFOxzs4a2zVZ9MrjsxaITFwkMQB4w8IDEQkMRB4w0FjCQOMEAQtYBjAdwBOAAwAWARgqxMzLOgtgtgmgmg9BcFBEvDT5pmmh6vj0f7gMDI8pl+yRNXvvEB4r399+937OrGR5SlHjxkV7O/fv379+zqxkePHjx48ZFer379+/fv2dWKx48ePHjxkV7O/fv379+/VjI8ePHjx48Z379+/fv379kePHjx48ePGd+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379/HePHjx48ePIj9+/fv37+94kB48ePKUpe8N+/uHhgAAAAAqAADAYMBYUabTMHxGMSRaeJYUwcBIwvF8yPcI9yRQlSc+pHIw4ZY2if0z7JoxREYWChiBiwXBgyN5gC5lB5jCIYcZunQbbCSzhC1QFFpi//PExE5krDpgX53QAMstFCCD10K8M03Ea4qnzIJUxUhXCXcsNImmL8nnEMPoEUk3VsxNIGN31clrMSf52m8nn4eS0/BspZi4gEVmsfmLcABDKYy/s1Go1VbyXO48lM/DyG8nmXjGKUm4imZfGMQm0eymM1qamq0tLlTPxCKaHIRTQ5IDGojCDTPIzGnjCBzOHzGmDCAzNG6amxxx1llvHHVM/EIpn4hFM/EgrQ5IDMpDIBzUJTMnjJAzTITMmgElNIdMyWByU0RmmtY0uOsst48/L/+tDk5WhycrRSirRS9Wll6sY0QJETJCzGhBYiZISY0EPETIBTGgCYiZAGAjRWKMcBBRrX/v/y3+Osq28auWVbHGlll65LOXJZy5LOXJZ9yxu5YzuWCIoAjoONDxQDGQg0NFAUZDDQsUBxkONCRQIKiRoOKBhUaNBhQOIjxorFUwhDGRJAY0i6Y4mEGTBqjo7D78jaDTGsDeuDTjkbzFDwgiIRBlzxjA6CqXqAVB//PExC5O7Do0Cdp4ANYK9SCYssEhFxHpE1FxOFJCTAphcTRNEnJOUJXQ3g1ROVCnTRNFQrogwhRcWVhQ00VS3EqE2NFxgp1DUJXQkwOYlrjBTpoqFeEmCPFxmynTRUK8N4NUXGJthOVQrxbh6lDTcFWsrUW4epQ0jQVaytRbh6lDJGlVrK1FuHqUMkaVWsrUX4epQyPssLLIX4gyhkfZYWWQvxOlTCZrsLLIX4nSphM12FlkL8TpUtzNdhZZC/E6VLczXYWWQvxOlS3M13rLIX4nSpbldt69kOYnSpbldO9eyHMTplYldO9eyHMTplYldO9eyHMTplYldPBeyHMTplYldPBeyHMTplYlFPBeyHMTpxYlFGgvZDmJ0kxBTUU0LjCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","bytes":1152,"sha256":"9048e9affe6127656a008c1d51225ef0283fc1ac439d59b1bc3a6f083c5e550c","decodedPcmBytes":3456};
const mp3 = Buffer.from(fixture.base64, "base64");
// Generated test-only PCM WAV: 96 silent signed-16 samples at 24 kHz, mono.
// Both containers were decoded offline; these bytes prove transport, not music quality.
const wav = Buffer.alloc(44 + 192);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(192, 40);
const models = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
const provider = { id: "openrouter", base_urls: { default: "https://openrouter.ai/api" } };
const endpoint = { method: "POST", path: "/v1/chat/completions", request_format: "openai.chat_completions",
  response_format: "openai.chat_completions", path_params: [], query: {}, streaming: "sse" };
function selection(model = models[0], format = "mp3") {
  return { provider, endpoint, model: { upstream: model, capabilities: ["music.generate"] }, capability: "music.generate",
    method: "POST", pathParams: {}, body: { model, messages: [{ role: "user", content: "Synthetic instrumental." }],
      modalities: ["text", "audio"], audio: { format }, stream: true } };
}
const data = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const frame = (audio, model = models[0], extra = {}) => ({ id: "gen-synthetic-123", model,
  choices: [{ index: 0, delta: { audio }, finish_reason: null }], ...extra });
function wire(audio = mp3, model = models[0]) {
  const encoded = audio.toString("base64");
  return data(frame({ data: encoded.slice(0, 3), transcript: "A " }, model))
    + data(frame({ data: encoded.slice(3), transcript: "synthetic track." }, model))
    + data({ id: "gen-synthetic-123", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + data({ id: "gen-synthetic-123", model, choices: [], usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } })
    + data("[DONE]");
}
function response(value = wire(), headers = {}, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } });
}
async function read(upstream = response(), selected = selection(), signal = new AbortController().signal) {
  const native = prepare(selected), lease = native.acquire();
  try { return await native.read(upstream, signal); } finally { lease.release(); }
}
const invalid = { message: "invalid_native_openrouter_music_response" };
function chunks(values, onCancel = () => {}) {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index === values.length) controller.close(); else controller.enqueue(values[index++]);
  }, cancel: onCancel }, { highWaterMark: 0 });
}

test("both frozen models preserve complete MP3/WAV native SSE bytes and diagnostic usage", async () => {
  assert.equal(mp3.length, fixture.bytes); assert.equal(createHash("sha256").update(mp3).digest("hex"), fixture.sha256);
  for (const model of models) for (const [format, audio] of [["mp3", mp3], ["wav", wav]]) {
    const selected = selection(model, format), before = structuredClone(selected), native = prepare(selected);
    assert.deepEqual(selected, before);
    for (const key of ["body", "headers", "query", "tariff"]) assert.equal(native[key], undefined);
    const original = wire(audio, model), result = await read(response(original), selected);
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.response.headers.get("content-type"), "text/event-stream");
    assert.equal(result.response.headers.get("content-length"), String(Buffer.byteLength(original)));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    const delivered = await result.response.text(); assert.equal(delivered, original);
    const payloads = delivered.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
    assert.equal(payloads.pop(), "[DONE]");
    const decoded = Buffer.from(payloads.map(value => JSON.parse(value).choices[0]?.delta.audio?.data ?? "").join(""), "base64");
    assert.deepEqual(decoded, audio);
    assert.equal(JSON.parse(payloads.at(-1)).usage.cost, 12.34);
  }
});

test("decoder-verified near-cap test audio keeps the requested MP3/WAV identity and SSE header", async () => {
  // Repeated test MP3 frames: 2,096,640 bytes -> 6,289,920 decoded PCM bytes.
  // Generated PCM WAV at the exact 2 MiB cap -> 2,097,108 decoded PCM bytes.
  const largeMp3 = Buffer.concat(Array(1820).fill(mp3)), largeWav = Buffer.alloc(2 * 1024 * 1024);
  wav.copy(largeWav, 0, 0, 44);
  largeWav.writeUInt32LE(largeWav.length - 8, 4); largeWav.writeUInt32LE(largeWav.length - 44, 40);
  for (const [format, audio] of [["mp3", largeMp3], ["wav", largeWav]]) {
    const encoded = audio.toString("base64"), parts = [];
    for (let offset = 0; offset < encoded.length; offset += 65535)
      parts.push(data(frame({ data: encoded.slice(offset, offset + 65535) })));
    const original = parts.join("") + data("[DONE]");
    assert.ok(Buffer.byteLength(original) < 4 * 1024 * 1024);
    const result = await read(response(original), selection(models[0], format));
    assert.equal(result.response.headers.get("content-type"), "text/event-stream");
    assert.equal(await result.response.text(), original); assert.equal(result.usage.tokens, null);
  }
});

test("absent native usage still succeeds without invented counters, prices or receipts", async () => {
  const original = data(frame({ data: fixture.base64 })) + data("[DONE]");
  const result = await read(response(original));
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(await result.response.text(), original);
  await assert.rejects(read(response(data({ choices: [], usage: { cost: 0 } }) + data("[DONE]"))), invalid);
});

test("selection binds music capability, exact model, fixed /api destination and SSE before generic Chat", () => {
  const native = prepare(selection());
  assert.doesNotThrow(() => assertNativeResponseDestination(native, new URL("https://openrouter.ai/api/v1/chat/completions")));
  for (const url of ["https://openrouter.ai/v1/chat/completions", "https://openrouter.ai/api/api/v1/chat/completions",
    "https://other.example/api/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions?model=other",
    "https://openrouter.ai/api/v1/chat/completions#fragment"])
    assert.throws(() => assertNativeResponseDestination(native, new URL(url)));
  for (const patch of [{ provider: { ...provider, base_urls: { default: "https://openrouter.ai" } } },
    { model: null }, { model: { upstream: models[0], capabilities: ["llm.chat"] } }, { capability: "llm.chat" },
    { method: "GET" }, { pathParams: { model: models[0] } }, { nativeQuery: {} }]) assert.throws(() => prepare({ ...selection(), ...patch }));
  for (const patch of [{ method: "GET" }, { path: "/api/v1/chat/completions" }, { request_format: "google.music_generate" },
    { response_format: "audio.binary" }, { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { stream: true } },
    { streaming: undefined }, { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => prepare({ ...selection(), endpoint: { ...endpoint, ...patch } }));
  assert.equal(prepare({ ...selection(), provider: { ...provider, id: "google" } }), undefined);
  const chat = selection("other/chat"); chat.capability = "llm.chat"; assert.equal(prepare(chat), undefined);
  chat.body.model = models[0]; assert.throws(() => prepare(chat));
});

test("prompt-only body retains exact codec constraints and denies assets, aliases and unbounded JSON", () => {
  for (const model of ["openrouter/auto", "google/lyria-3", "other/model"]) assert.throws(() => prepare(selection(model)));
  for (const patch of [{ model: models[1] }, { stream: false }, { stream: undefined }, { audio: { format: "pcm" } },
    { audio: {} }, { modalities: ["audio"] }, { messages: [] }, { tools: [] }, { max_tokens: 10 }, { provider: { only: ["google"] } },
    { extra: "x".repeat(256 * 1024) }]) assert.throws(() => prepare({ ...selection(), body: { ...selection().body, ...patch } }));
  for (const content of ["", " ", "\ud800", "a".repeat(32769), "😀".repeat(16385),
    [{ type: "text", text: "test" }, { type: "image_url", image_url: { url: "https://media.example/test.png" } }],
    [{ type: "text", text: "test" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]]) {
    const selected = selection(); selected.body.messages[0].content = content; assert.throws(() => prepare(selected));
  }
  for (const content of ["a".repeat(32768), "😀".repeat(16384), "\u0001".repeat(32768)]) {
    const selected = selection(); selected.body.messages[0].content = content; assert.ok(prepare(selected));
  }
});

test("capacity is acquired before dispatch and charged with ingress in the actual 96 MiB pool", () => {
  assert.equal(bodyBudgetBytes, 96 * 1024 * 1024);
  const baseline = bodyBudgetCharged(), ingress = new BodyLease(); assert.ok(ingress.grow(8 * 1024 * 1024));
  const lease = prepare(selection()).acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  assert.throws(() => prepare(selection()).acquire(), /capacity is busy/);
  lease.release(); ingress.release(); assert.equal(bodyBudgetCharged(), baseline);
});

test("one-byte fragmentation and CRLF keep split base64 and UTF-8 unchanged", async () => {
  const original = wire().replace("A ", "音 ").replaceAll("\n", "\r\n");
  const bytes = Buffer.from(original);
  const delivered = await read(response(chunks([...bytes].map(byte => Uint8Array.of(byte)))));
  assert.equal(await delivered.response.text(), original);
  const tail = wire().replaceAll("\n", "\r\n"), padding = 65537 - Buffer.byteLength(tail);
  const boundary = ":" + "a".repeat(padding - 5) + "\r\n\r\n" + tail;
  assert.equal(Buffer.byteLength(boundary), 65537);
  assert.equal(await (await read(response(boundary))).response.text(), boundary);
});

test("native DONE cancels a still-open upstream without waiting for socket EOF", async () => {
  let pulls = 0, canceled = false;
  const upstream = new ReadableStream({ pull(controller) { pulls++; if (pulls === 1) controller.enqueue(Buffer.from(wire())); },
    cancel() { canceled = true; } }, { highWaterMark: 0 });
  const delivered = await read(response(upstream));
  assert.equal(await delivered.response.text(), wire()); assert.equal(pulls, 1); assert.equal(canceled, true);
});

test("no partial SSE is exposed before terminal; missing DONE, truncation and stream failure reject atomically", async () => {
  for (const original of [wire().replace(data("[DONE]"), ""), data("[DONE]"), wire().slice(0, -1),
    wire() + data(frame({ data: "AAAA" })), wire() + ": late\n\n"]) await assert.rejects(read(response(original)), invalid);
  let controller, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const upstream = new ReadableStream({ start(value) { controller = value; controller.enqueue(Buffer.from(wire().replace(data("[DONE]"), ""))); },
    pull() { ready(); } }, { highWaterMark: 0 });
  let resolved = false;
  const pending = read(response(upstream)).then(value => { resolved = true; return value; });
  await entered; assert.equal(resolved, false); controller.error(new Error("synthetic interruption"));
  await assert.rejects(pending, invalid);
});

test("cancel before read or while stalled cancels the sole upstream and exposes no audio", async () => {
  let canceled = 0; const before = new AbortController(); before.abort();
  await assert.rejects(read(response(new ReadableStream({ cancel() { canceled++; } })), selection(), before.signal), invalid);
  assert.equal(canceled, 1);
  let ready; const entered = new Promise(resolve => { ready = resolve; }), abort = new AbortController();
  const upstream = new ReadableStream({ pull() { ready(); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const pending = read(response(upstream), selection(), abort.signal); await entered; abort.abort();
  await assert.rejects(pending, invalid); assert.equal(canceled, 2);
});

test("native errors, identity changes, invalid usage, filtered output and invalid base64 are sanitized failures", async () => {
  const good = frame({ data: fixture.base64 });
  for (const bad of [
    { ...good, error: { message: "synthetic private diagnostic" } }, { ...good, error: null },
    { ...good, model: models[1] }, { ...good, id: "bad/id" }, { ...good, usage: { cost: -1 } },
    { ...good, choices: [{ index: 0, delta: { audio: { data: fixture.base64 } }, finish_reason: "length" }] },
    frame({ data: "%%%=" }), frame({ data: "AB==" }), frame({ data: fixture.base64, transcript: "\ud800" }),
  ]) await assert.rejects(read(response(data(bad) + data("[DONE]"))), invalid);
  await assert.rejects(read(response(data(good) + data({ ...good, id: "gen-other" }) + data("[DONE]"))), invalid);
  await assert.rejects(read(response(data(good) + data({ ...good, choices: [{ delta: {}, finish_reason: "stop" }] })
    + data(good) + data("[DONE]"))), invalid);
});

test("reject client-incompatible framing, malformed UTF-8, oversized frames and error-event relabeling", async () => {
  const value = JSON.stringify(frame({ data: fixture.base64 }));
  for (const original of ["data: " + value.slice(0, 20) + "\ndata: " + value.slice(20) + "\n\n" + data("[DONE]"),
    wire().replaceAll("\n", "\r"), "event: error\n" + wire(), "unknown: field\n" + wire(),
    ":" + "a".repeat(256 * 1024) + "\n\n" + wire(),
    ": header\n".repeat(33) + wire(), ":" + "a".repeat(2 * 1024 * 1024) + "\n\n" + wire()])
    await assert.rejects(read(response(original)), invalid);
  await assert.rejects(read(response(Buffer.concat([Buffer.from("data: "), Buffer.from([0xff]), Buffer.from("\n\n" + wire())]))), invalid);
  await assert.rejects(read(response(Buffer.concat([Buffer.from(wire()), Buffer.from([0xff])]))), invalid);
});

test("HTTP status, MIME, redirect, range and encoding cannot bypass complete wire validation", async () => {
  for (const status of [201, 206, 302, 422, 500]) await assert.rejects(read(response(wire(), {}, status)), invalid);
  for (const headers of [{ "content-type": "audio/mpeg" }, { "content-type": "application/json" }, { "content-range": "bytes 0-4/20" },
    { "content-encoding": "gzip" }, { "content-encoding": "" }, { "content-encoding": "identity,gzip" },
    { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "x" }, { "content-length": String(4 * 1024 * 1024 + 1) }])
    await assert.rejects(read(response(wire(), headers)), invalid);
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(read(redirected), invalid); await assert.rejects(read(new Response(null)), invalid);
  for (const encoding of [undefined, "identity"]) {
    const headers = encoding ? { "content-encoding": encoding } : {}, size = Buffer.byteLength(wire());
    const upstream = response(wire(), { ...headers, "content-length": String(size) });
    assert.equal(await (await read(upstream)).response.text(), wire());
    assert.equal(upstream.headers.get("content-encoding"), encoding ?? null);
    for (const length of [size - 1, size + 1]) await assert.rejects(read(response(wire(), { ...headers, "content-length": String(length) })), invalid);
  }
});

test("all reads and all events, including empty reads and heartbeats, are bounded", async () => {
  let reads = 0, canceled = false;
  const endless = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); },
    cancel() { canceled = true; } }, { highWaterMark: 0 });
  await assert.rejects(read(response(endless)), invalid);
  assert.equal(reads, 8192); assert.equal(canceled, true);
  await assert.rejects(read(response(": heartbeat\n\n".repeat(8193) + wire())), invalid);
  await assert.rejects(read(response("\n".repeat(8193) + wire())), invalid);
});

test("wire, encoded audio and transcript budgets reject before releasing any SSE", async () => {
  const heartbeat = Buffer.from(":" + "a".repeat(128 * 1024 - 3) + "\n\n");
  await assert.rejects(read(response(chunks([...Array(32).fill(heartbeat), Buffer.from(wire())]))), invalid);
  const encoded = Buffer.alloc(2 * 1024 * 1024 + 3).toString("base64");
  const parts = [];
  for (let index = 0; index < encoded.length; index += 128 * 1024) parts.push(data(frame({ data: encoded.slice(index, index + 128 * 1024) })));
  await assert.rejects(read(response(parts.join("") + data("[DONE]"))), invalid);
  await assert.rejects(read(response(data(frame({ data: fixture.base64, transcript: "a".repeat(128 * 1024 + 1) })) + data("[DONE]"))), invalid);
  await assert.rejects(read(response(data(frame({ data: fixture.base64, transcript: "音".repeat(43691) })) + data("[DONE]"))), invalid);
});

test("delivery observer preserves null usage rather than treating native audio diagnostics as token pricing", async () => {
  const native = prepare(selection()), baseline = bodyBudgetCharged(), lease = native.acquire();
  const validated = await native.read(response(), new AbortController().signal);
  const observed = observeUsage(validated.response, new HttpOperation(), undefined, "openai.chat_completions", undefined, validated.usage);
  const accounting = observed.result.finally(() => lease.release());
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  assert.equal(await observed.response.text(), wire());
  const result = await accounting;
  assert.equal(result.tokens, null); assert.equal(result.outcome, "success"); assert.equal(result.delivery, "complete");
  assert.equal(result.requestCostReceipt, undefined); assert.equal(result.nonbillable, undefined);
  assert.equal(bodyBudgetCharged(), baseline);
});

test("canceling quarantined replay stays a canceled delivery, never a free rejection or a reconnect", async () => {
  const native = prepare(selection()), baseline = bodyBudgetCharged(), lease = native.acquire();
  const validated = await native.read(response(), new AbortController().signal);
  const observed = observeUsage(validated.response, new HttpOperation(), undefined, "openai.chat_completions", undefined, validated.usage);
  const accounting = observed.result.finally(() => lease.release());
  await observed.response.body.cancel();
  const result = await accounting;
  assert.equal(result.delivery, "canceled"); assert.equal(result.tokens, null); assert.equal(result.nonbillable, undefined);
  assert.equal(result.requestCostReceipt, undefined); assert.equal(bodyBudgetCharged(), baseline);
});
