import assert from "node:assert/strict";
import test from "node:test";
import "./managed-runtime-fixture.mjs";
const { beginMiniMaxMusicCoverInput, claimMiniMaxMusicCoverInput, claimMiniMaxMusicCoverUpload,
  consumeMiniMaxMusicCoverResponse, transferMiniMaxMusicCoverResponse } = await import("../minimax-music-cover-input.ts");
const { runInactiveMiniMaxMusicCoverUpload, MusicCoverUploadSource, musicCoverUploadLimits } = await import("../minimax-music-cover-upload.ts");
const { runMiniMaxMusicCoverControls } = await import("../minimax-music-cover-control.ts");
const { MiniMaxMusicCoverJson, musicCoverResponseLimits } = await import("../minimax-music.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const MiB = 1024 * 1024;
const destination = "https://api.minimax.io/v1/music_generation";
const envelope = audio => '{"base_resp":{"status_code":0},"data":{"status":2,"audio":"' + audio + '"}}';
function bytes(text, size = 1024) {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text; let offset = 0;
  return new ReadableStream({ type: "bytes", pull(c) {
    if (offset === data.length) { c.close(); c.byobRequest?.respond(0); return; }
    const end = Math.min(data.length, offset + size); c.enqueue(data.slice(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
}
function reply(text = envelope("0011ff"), options = {}) {
  const r = new Response(bytes(text), { headers: { "content-type": "application/json", ...options.headers }, status: options.status ?? 200 });
  Object.defineProperty(r, "url", { value: options.url ?? destination }); return r;
}
async function begin(route = "native", deadline = 30000) {
  const controller = new AbortController(), document = { model: "music-cover", prompt: 'Synthetic "style"', lyrics: "Synthetic lyrics", audio_base64: "AAECA/8=" };
  const input = beginMiniMaxMusicCoverInput({ body: bytes(JSON.stringify(route === "native" ? document : { body: document })),
    signal: controller.signal, deadlineAt: Date.now() + deadline, route, contentType: "application/json" });
  return { input, sealed: await input.result, controller, document };
}
async function drain(body) { const reader = body.getReader(); let text = ""; try { for (;;) { const p = await reader.read(); if (p.done) return text;
  assert.ok(p.value.buffer.byteLength <= 16384); text += new TextDecoder().decode(p.value); } } finally { reader.releaseLock(); } }
async function entry(entered, flow) {
  await Promise.race([entered.promise, flow.result.then(() => { throw Error("fixture completed before held boundary"); },
    () => { throw Error("fixture rejected before held boundary"); })]);
}
async function cleanup(f, flow) { f.controller.abort(); await flow?.retired.catch(() => {}); await f.input.discard().catch(() => {}); assert.equal(bodyBudgetCharged(), 0); }

test("inactive serializer binds sealed bytes/scalars and transfers 96 = 32 + 64 without a second acquire", async () => {
  for (const route of ["native", "manifest"]) {
    const f = await begin(route); let posts = 0, uploaded;
    const flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (url, init) => {
      posts++; assert.equal(url, destination); assert.equal(init.redirect, "manual");
      assert.equal(bodyBudgetCharged(), 96 * MiB); uploaded = await drain(init.body);
      assert.equal(Buffer.byteLength(uploaded), Number(new Headers(init.headers).get("content-length"))); return reply();
    });
    try {
      const response = await flow.result;
      assert.deepEqual(JSON.parse(uploaded), { model: "music-cover", prompt: f.document.prompt, lyrics: f.document.lyrics,
        stream: false, output_format: "hex", audio_base64: f.document.audio_base64 });
      assert.equal(bodyBudgetCharged(), 96 * MiB);
      const contender = new BodyLease(); try { assert.equal(contender.grow(MiB), false); } finally { contender.release(); }
      assert.deepEqual(await response.json(), JSON.parse(envelope("0011ff")));
      await flow.retired; await f.input.retired;
      assert.equal(posts, 1); assert.equal(flow.snapshot().ordinary, 1); assert.equal(flow.snapshot().postAttempts, 1);
      assert.equal(bodyBudgetCharged(), 0);
    } finally { await cleanup(f, flow); }
  }
});

test("copied inputs, phases, successors and metadata-only claims cannot mint upload ownership", async () => {
  const f = await begin();
  try {
    assert.throws(() => runInactiveMiniMaxMusicCoverUpload({ ...f.sealed }, async () => reply()), { code: "used" });
    assert.throws(() => claimMiniMaxMusicCoverUpload({}), { code: "used" });
    assert.throws(() => consumeMiniMaxMusicCoverResponse({ kind: "music-cover-response.v1" }), { code: "used" });
    claimMiniMaxMusicCoverInput(f.sealed);
    assert.throws(() => runInactiveMiniMaxMusicCoverUpload(f.sealed, async () => reply()), { code: "used" });
  } finally { await cleanup(f); }
});

test("same dispatched source: early headers wait for held LAST pull, cleared references and atomic split", async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers(), original = MusicCoverUploadSource.prototype.produce;
  let source, posted = 0, reads = 0, upload;
  MusicCoverUploadSource.prototype.produce = async function(c) { source = this;
    if (this.emitted + 2 === this.length) { entered.resolve(); await held.promise; } return original.call(this, c); };
  t.after(() => { MusicCoverUploadSource.prototype.produce = original; });
  const f = await begin(), flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (_url, init) => {
    posted++; upload = drain(init.body); void upload.catch(() => {});
    const response = reply(), get = response.body.getReader.bind(response.body);
    response.body.getReader = options => { const reader = get(options); return {
      read(view) { reads++; return reader.read(view); }, cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock() }; };
    return response;
  });
  try {
    await entry(entered, flow); assert.equal(posted, 1); assert.equal(reads, 0); assert.equal(bodyBudgetCharged(), 96 * MiB);
    assert.equal(source.snapshot().pending, true); held.resolve();
    const response = await flow.result; await upload;
    assert.equal(source.snapshot().references, 0); assert.equal(source.snapshot().pending, false);
    assert.equal(bodyBudgetCharged(), 96 * MiB); await response.body.cancel();
    await flow.retired; await f.input.retired; assert.equal(bodyBudgetCharged(), 0);
  } finally { held.resolve(); await cleanup(f, flow); await upload?.catch(() => {}); }
});

test("failed transfer disposes unread response and keeps original 96 MiB until FIRST cancellation settles", async t => {
  const original = BodyLease.prototype.splitCharges, entered = Promise.withResolvers(), held = Promise.withResolvers();
  BodyLease.prototype.splitCharges = () => null; t.after(() => { BodyLease.prototype.splitCharges = original; });
  const f = await begin(); let reads = 0, cancels = 0;
  const flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (_url, init) => {
    await drain(init.body); const r = reply(), get = r.body.getReader.bind(r.body);
    r.body.getReader = options => { const reader = get(options); return { read(view) { reads++; return reader.read(view); },
      async cancel(reason) { cancels++; await reader.cancel(reason); entered.resolve(); await held.promise; }, releaseLock: () => reader.releaseLock() }; }; return r;
  });
  try {
    await entry(entered, flow); assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 96 * MiB);
    await assert.rejects(flow.result); assert.equal(bodyBudgetCharged(), 96 * MiB);
    held.resolve(); await flow.retired; await f.input.retired; assert.equal(bodyBudgetCharged(), 0);
  } finally { held.resolve(); await cleanup(f, flow); }
});

test("protocol rejection is separate from rejected FIRST cancellation; late bodies are owned", async () => {
  for (const mode of ["headers", "cancel-reject", "late"]) {
    const f = await begin(); let cancels = 0, unlocks = 0, reads = 0;
    const flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (_url, init) => {
      await drain(init.body); if (mode === "late") f.controller.abort();
      const r = reply(envelope("00"), { headers: { "content-type": "text/event-stream" } }), get = r.body.getReader.bind(r.body);
      r.body.getReader = options => { const reader = get(options); return { read(view) { reads++; return reader.read(view); },
        async cancel(reason) { cancels++; await reader.cancel(reason); if (mode === "cancel-reject") throw Error("synthetic cleanup failure"); },
        releaseLock() { unlocks++; reader.releaseLock(); } }; }; return r;
    });
    try {
      await assert.rejects(flow.result);
      if (mode === "cancel-reject") await assert.rejects(flow.retired); else await flow.retired;
      assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(unlocks, 1);
      assert.equal(flow.snapshot().cleanupFailed, mode === "cancel-reject");
    } finally { await cleanup(f, flow); }
  }
});

test("original deadline owns unclaimed delivery without a new leaf acquisition", async () => {
  const f = await begin("native", 100), flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (_url, init) => { await drain(init.body); return reply(); });
  try {
    const response = await flow.result; assert.equal(bodyBudgetCharged(), 96 * MiB);
    await flow.retired; await f.input.retired;
    await assert.rejects(response.text()); assert.equal(bodyBudgetCharged(), 0);
  } finally { await cleanup(f, flow); }
});

function scan(text, chunk = 1) { const parser = new MiniMaxMusicCoverJson(); try {
  for (let offset = 0; offset < text.length; offset += chunk) parser.push(text.slice(offset, offset + chunk));
  return parser.finish();
} finally { parser.discard(); } }
test("unary scanner validates complete EOF, bounded metadata and HEX without a model echo", () => {
  assert.deepEqual([...scan(envelope("aAbB00"))], [170, 187, 0]);
  const valid = envelope("00");
  for (const bad of [valid + "x", valid + valid, valid.slice(0, -1), valid.replace('"audio":"00"', '"audio":"0"'),
    valid.replace('"audio":"00"', '"audio":"\\u0030\\u0030"'), valid.replace('"status":2', '"status":"2"'),
    valid.replace('"status_code":0', '"status_code":1'), valid.replace('"audio":"00"', '"audio":"00","audio":"00"'),
    valid.replace('"status":2', '"status":2,"url":"https://example.invalid"'), valid.replace('"data":', '"error":null,"data":'),
    valid.replace('"data":', '"discard":' + "[".repeat(9) + "0" + "]".repeat(9) + ',"data":'),
    valid.replace('"data":', '"discard":[' + Array(257).fill("0").join(",") + '],"data":'),
    valid.replace('"data":', '"discard":"' + "x".repeat(32769) + '","data":'), valid + " ".repeat(65536)]) assert.throws(() => scan(bad));
  const maximum = envelope("ab".repeat(musicCoverResponseLimits.audio));
  const audio = scan(maximum, 1024); assert.equal(audio.length, 4 * MiB); assert.equal(audio.buffer.byteLength, 4 * MiB);
  assert.throws(() => scan(envelope("ab".repeat(musicCoverResponseLimits.audio + 1)), 1024));
  assert.equal(musicCoverUploadLimits.inventoryKiB.reduce((a,b) => a+b), 440);
});

test("PRIMITIVE reserved POST ticket is one-use, hard/soft ceilings 17/13; no registered authority count claim", async () => {
  for (const soft of [false, true]) {
    const f = await begin(), flow = runMiniMaxMusicCoverControls(f.sealed, async owner => {
      owner.setBudgetMode(soft); const cap = claimMiniMaxMusicCoverUpload(owner.phase);
      assert.throws(() => transferMiniMaxMusicCoverResponse(cap), { code: "used" });
      for (let i = 0; i < (soft ? 12 : 16); i++) owner.ticket(false);
      assert.throws(() => owner.ticket(false));
      await owner.post(cap, async () => ({ value: null, retired: Promise.resolve() }));
      assert.throws(() => owner.post(cap, async () => ({ value: null, retired: Promise.resolve() })));
      assert.equal(owner.snapshot().ordinary, soft ? 13 : 17);
    });
    try { await flow.result; await flow.retired; } finally { await cleanup(f, flow); }
  }
});

test("genuine successor consumption and upload transfer are independently single-use", async () => {
  const f = await begin(), flow = runMiniMaxMusicCoverControls(f.sealed, async owner => {
    const cap = claimMiniMaxMusicCoverUpload(owner.phase);
    assert.throws(() => new MusicCoverUploadSource(cap, { ...owner.phase }));
    const source = new MusicCoverUploadSource(cap, owner.phase);
    await drain(source.body); await source.retired;
    assert.equal(source.snapshot().references, 0);
    const successor = transferMiniMaxMusicCoverResponse(cap);
    assert.equal(bodyBudgetCharged(), 96 * MiB);
    assert.throws(() => transferMiniMaxMusicCoverResponse(cap), { code: "used" });
    const release = consumeMiniMaxMusicCoverResponse(successor);
    assert.throws(() => consumeMiniMaxMusicCoverResponse(successor), { code: "used" });
    release(); release(); assert.equal(bodyBudgetCharged(), 32 * MiB);
  });
  try { await flow.result; await flow.retired; } finally { await cleanup(f, flow); }
});

test("transport causes are sanitized and FIRST discard stays memoized after terminal cleanup", async t => {
  const original = MusicCoverUploadSource.prototype.disposeSource;
  for (const asynchronous of [false, true]) for (const cleanupReject of [false, true]) {
    const entered = Promise.withResolvers(), held = Promise.withResolvers(); let source, discards = 0;
    MusicCoverUploadSource.prototype.disposeSource = async function() {
      source = this; discards++; await original.call(this); entered.resolve(); await held.promise;
      if (cleanupReject) throw Error("synthetic FIRST discard rejection");
    };
    const f = await begin(), raw = new Error("synthetic transport", { cause: { retained: new Uint8Array(100000) } });
    const flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, () => {
      if (asynchronous) return Promise.reject(raw); throw raw;
    });
    try {
      await assert.rejects(flow.result, error => error !== raw && error.cause === undefined && error.message === "music cover inactive transport failed");
      await entered.promise;
      assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(flow.snapshot().ordinaryActive, 1);
      assert.equal(Object.values(source).includes(raw), false); assert.equal(Object.values(source).includes(raw.cause), false);
      assert.equal(discards, 1); held.resolve();
      if (cleanupReject) await assert.rejects(flow.retired); else await flow.retired;
      assert.equal(flow.snapshot().cleanupFailed, cleanupReject); assert.equal(source.snapshot().references, 0);
      const terminal = source.discard(); assert.equal(source.discard(), terminal);
      if (cleanupReject) await assert.rejects(terminal); else await terminal;
      assert.equal(discards, 1);
    } finally { held.resolve(); await cleanup(f, flow); MusicCoverUploadSource.prototype.disposeSource = original; }
  }
});

test("established bounded public cancellation remains separate from cleanup failure", async () => {
  const f = await begin(), reason = Object.assign(new Error("fixture caller abort", { cause: { boundedFixture: true } }), { cleanupFailed: true });
  const flow = runInactiveMiniMaxMusicCoverUpload(f.sealed, async (_url, init) => {
    await drain(init.body); f.controller.abort(reason); return reply();
  });
  try {
    await assert.rejects(flow.result, error => error === "cover control stopped"); await flow.retired; await f.input.retired;
    assert.equal(flow.snapshot().cleanupFailed, false); assert.equal(bodyBudgetCharged(), 0);
  } finally { await cleanup(f, flow); }
});

test("prestart interval retires the actual slot without classifying caller-owned cleanup flags", async () => {
  for (const directOperationFault of [false, true]) {
    const f = await begin(), reason = Object.assign(new Error("synthetic prestart reason"), { cleanupFailed: true });
    let started = 0, entered = 0;
    const flow = runMiniMaxMusicCoverControls(f.sealed, async owner => {
      const cap = claimMiniMaxMusicCoverUpload(owner.phase), slot = owner.slot.bind(owner);
      owner.slot = async ticket => {
        await slot(ticket); entered++;
        // The ordinary caller path retains its established bounded reason.
        // Direct operation.cancel is a separate PRIVATE fault injection: it
        // places an adversarial raw reason at the catch being hardened, and
        // would make the old structural classification report cleanup failure.
        if (directOperationFault) owner.operation.cancel(reason);
        else f.controller.abort(reason);
      };
      await owner.post(cap, async () => { started++; return { value: null, retired: Promise.resolve() }; });
    });
    try {
      await assert.rejects(flow.result, error => directOperationFault ? error === reason : error === "cover control stopped");
      await flow.retired; await f.input.retired;
      assert.equal(entered, 1); assert.equal(started, 0);
      assert.equal(flow.snapshot().cleanupFailed, false); assert.equal(flow.snapshot().ordinaryActive, 0);
      assert.equal(flow.snapshot().ordinary, 1); assert.equal(flow.snapshot().postAttempts, 1);
      assert.equal(bodyBudgetCharged(), 0);
    } finally { await cleanup(f, flow); }
  }
});
