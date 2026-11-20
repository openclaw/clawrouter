import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { installMusicAdmin, musicAdmin } from "./minimax-music-admin-fixture.mjs";
import { byteBody, syntheticTransport, jsonResponse } from "./minimax-search-byte-fixture.mjs";
const { qualifyMusicCoverWave } = await import("../minimax-music-cover-audio.ts");
const { beginMiniMaxMusicCoverInput, beginMiniMaxMusicCoverWaveInput, isMiniMaxMusicCoverWave } = await import("../minimax-music-cover-input.ts");
const { composePrivateMiniMaxMusicCover } = await import("../minimax-music-cover-authority.ts");
const { MiniMaxMusicCoverControl, musicCoverControlHeader, musicCoverControlVersion } = await import("../minimax-music-cover-control.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const headers = new Headers({ authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
const MiB = 1024 * 1024;
function wave(bytes = 576044, channels = 1, extras = 0) {
  const value = Buffer.alloc(bytes), dataOffset = 36 + extras * 8;
  value.write("RIFF", 0); value.writeUInt32LE(bytes - 8, 4); value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(channels, 22);
  value.writeUInt32LE(48000, 24); value.writeUInt32LE(48000 * channels * 2, 28);
  value.writeUInt16LE(channels * 2, 32); value.writeUInt16LE(16, 34);
  for (let i = 0; i < extras; i++) value.write("JUNK", 36 + i * 8);
  value.write("data", dataOffset); value.writeUInt32LE(bytes - dataOffset - 8, dataOffset + 4);
  return value;
}
function input(bytes = wave(), route = "native", opaque = false) {
  const document = { audio_base64: bytes.toString("base64"), model: "music-cover", prompt: "Synthetic cover style" };
  return (opaque ? beginMiniMaxMusicCoverInput : beginMiniMaxMusicCoverWaveInput)({
    body: byteBody(JSON.stringify(route === "manifest" ? { body: document } : document)),
    signal: new AbortController().signal, deadlineAt: Date.now() + 30000, contentType: "application/json", route,
  });
}

test("local WAVE profile: full decimal 50M stereo, integer duration, exact chunks and no borrowed view escape", () => {
  const maximum = wave(50_000_000, 2), format = qualifyMusicCoverWave(maximum);
  assert.deepEqual(format, { profile: "wave-pcm16-48k.v1", bytes: 50_000_000, channels: 2, frames: 12_499_989, chunks: 2 });
  assert.ok(Object.isFrozen(format)); assert.equal(Object.values(format).some(value => ArrayBuffer.isView(value)), false);
  maximum.writeUInt16LE(1, 22); maximum.writeUInt32LE(96000, 28); maximum.writeUInt16LE(2, 32);
  assert.throws(() => qualifyMusicCoverWave(maximum)); // 50M mono exceeds 360 seconds.
  assert.equal(qualifyMusicCoverWave(wave(34_560_044)).frames, 360 * 48000);
  assert.throws(() => qualifyMusicCoverWave(wave(34_560_046)));
  assert.throws(() => qualifyMusicCoverWave(wave(576042)));
  assert.equal(qualifyMusicCoverWave(wave(576044 + 30 * 8, 1, 30)).chunks, 32);
  assert.throws(() => qualifyMusicCoverWave(wave(576044 + 31 * 8, 1, 31)));
  for (const mutate of [b => b.write("RF64", 0), b => b.writeUInt32LE(1, 4), b => b.writeUInt16LE(3, 20),
    b => b.writeUInt16LE(3, 22), b => b.writeUInt32LE(44100, 24), b => b.writeUInt32LE(1, 28),
    b => b.writeUInt16LE(1, 32), b => b.writeUInt16LE(24, 34), b => b.writeUInt32LE(0xffffffff, 40),
    b => b.write("fmt ", 36), b => b.write("data", 12)]) {
    const bytes = wave(); mutate(bytes); assert.throws(() => qualifyMusicCoverWave(bytes));
  }
});

test("WAVE attestation is additive, private and hash-bound; invalid formats deny before hash", async () => {
  const opaque = input(wave(), "native", true);
  try { assert.equal(isMiniMaxMusicCoverWave(await opaque.result), false); }
  finally { await opaque.discard(); }
  const qualified = input();
  try {
    const sealed = await qualified.result;
    assert.equal(isMiniMaxMusicCoverWave(sealed), true);
    assert.equal(isMiniMaxMusicCoverWave({ ...sealed, validated: true }), false);
  } finally { await qualified.discard(); }
  const bad = wave(); bad.writeUInt16LE(8, 34);
  const rejected = input(bad);
  try { await assert.rejects(rejected.result); }
  finally { await rejected.discard(); }
  assert.equal(rejected.snapshot().digestStarted, false); assert.equal(bodyBudgetCharged(), 0);
});

async function setup(t, { soft = false, unknown = false, unmetered = false } = {}) {
  const f = await fixture(t, { providerId: "minimax", fixed: 700 }); await installMusicAdmin(t, f);
  f.policy.models = ["minimax/music-cover"]; f.policy.budgetMode = soft ? "soft" : "reserve";
  f.policy.dailyBudgetMicros = f.policy.weeklyBudgetMicros = 10000;
  f.policy.grantRouting = { eligibleGrants: { minimax: ["replicate"] }, environmentFallback: false, failover: false };
  if (unknown) f.policy.requestCostMicros = null;
  if (unmetered) f.policy.monthlyBudgetMicros = f.policy.dailyBudgetMicros = f.policy.weeklyBudgetMicros = null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  if (unmetered) await f.authority("/connections/put", { providerId: "minimax", monthlyBudgetMicros: null });
  f.put = body => f.musicPut({ provider: "minimax", kind: "api_key", enabled: true, accountId: "cover-account",
    credential: "synthetic-cover-key", nativeMediaAuthorization: "minimax-global-music-cover-inline-audio", ...body });
  await f.put(); f.calls = []; f.posts = 0; f.before = async () => {}; f.after = async (_entry, response) => response;
  f.messages = [];
  f.env.USAGE_QUEUE = { async send(message) {
    f.messages.push(structuredClone(message));
    if ("type" in message) {
      const response = await f.env.USAGE_LEDGER.get("fixture").fetch("https://usage/ingest", { method: "POST", body: JSON.stringify(message) });
      assert.equal(response.status, 200); await response.body?.cancel();
    }
  } };
  for (const name of ["ACCESS_CONTROL", "GRANT_CREDENTIALS", "BUDGET_LEDGER", "USAGE_LEDGER"]) {
    const namespace = f.env[name], get = namespace.get.bind(namespace);
    namespace.get = id => { const stub = get(id); return { async fetch(url, init) {
      const cover = new Headers(init?.headers).get(musicCoverControlHeader) === musicCoverControlVersion;
      const entry = { name, path: new URL(url).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
      if (cover) { f.calls.push(entry); await f.before(entry); }
      const response = await stub.fetch(url, cover && typeof init?.body === "string" ? { ...init, body: byteBody(init.body), duplex: "half" } : init);
      return cover ? f.after(entry, await syntheticTransport(response)) : response;
    } }; };
  }
  const originalFetch = globalThis.fetch;
  f.transport = async (_url, init) => {
    const request = new Request("https://api.minimax.io/v1/music_generation", { ...init, duplex: "half" });
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-cover-key");
    const value = await request.json(); assert.equal(value.model, "music-cover"); assert.equal(value.output_format, "hex");
    assert.equal(value.stream, false); assert.equal(Buffer.from(value.audio_base64, "base64").length, 576044);
    const response = jsonResponse({ base_resp: { status_code: 0 }, data: { status: 2, audio: "00ff80" } });
    Object.defineProperty(response, "url", { value: request.url }); return response;
  };
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url) !== "https://api.minimax.io/v1/music_generation") return originalFetch(url, init);
    f.posts++; return f.transport(url, init);
  });
  f.start = async (route = "native", opaque = false) => {
    const op = input(wave(), route, opaque), sealed = await op.result;
    try { return { op, flow: composePrivateMiniMaxMusicCover(f.env, headers, sealed) }; }
    catch (error) { await op.discard(); throw error; }
  };
  f.run = async route => {
    const { op, flow } = await f.start(route);
    try { const response = await flow.result; const value = await response.json(); return { value, snapshot: flow.snapshot() }; }
    finally { await flow.retired; await op.retired; }
  };
  t.after(f.drain); return f;
}

for (const soft of [false, true]) for (const route of ["native", "manifest"])
test(`private cover ${route}/${soft ? "soft" : "hard"}: real admission, one POST, independent publication and original-ID settlement`, async t => {
  const f = await setup(t, { soft }), { op, flow } = await f.start(route);
  try {
    const response = await flow.result;
    assert.equal(flow.snapshot().ordinary, soft ? 13 : 17); assert.equal(f.posts, 1);
    assert.equal(f.calls.filter(x => ["/settle", "/charge"].includes(x.path)).length, 0);
    assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(flow.snapshot().ordinaryActive, 1);
    assert.equal((await response.json()).data.audio, "00ff80");
  } finally { await flow.retired; await op.retired; }
  const terminal = f.calls.filter(x => x.path === (soft ? "/charge" : "/settle"));
  assert.equal(terminal.length, 4); assert.equal(flow.snapshot().mandatory, 5);
  assert.ok(terminal.every(x => (soft ? x.body.amountMicros : x.body.actualCostMicros) === 700));
  if (!soft) assert.deepEqual(terminal.map(x => x.body.reservationId), f.calls.filter(x => x.path === "/reserve").map(x => x.body.reservationId));
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].status, "success"); assert.equal(events[0].input_tokens, null);
  assert.equal(bodyBudgetCharged(), 0);
});

for (const asyncFailure of [false, true]) test(`invocation ${asyncFailure ? "rejection" : "throw"} is potentially paid, never replayed`, async t => {
  const f = await setup(t); f.transport = () => {
    const error = new Error("synthetic transport", { cause: { boundedAway: "x".repeat(100000) } });
    if (asyncFailure) return Promise.reject(error); throw error;
  };
  const { op, flow } = await f.start();
  try { await assert.rejects(flow.result); } finally { await flow.retired; await op.retired; }
  assert.equal(f.posts, 1); assert.equal(bodyBudgetCharged(), 0);
  assert.ok(f.calls.filter(x => x.path === "/settle").every(x => x.body.actualCostMicros === 700));
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].status, "provider_error");
});

for (const change of ["price", "budget", "rotate", "revoke"]) test("final prepared tail denies " + change + " before POST", async t => {
  const f = await setup(t); let changed = false;
  f.before = async entry => {
    if (entry.path !== "/authorization/snapshot" || changed || f.calls.filter(x => x.path === entry.path).length !== 2) return;
    changed = true;
    if (change === "rotate") await f.put({ credential: "synthetic-cover-rotated" });
    else if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, musicAdmin);
    else { if (change === "price") f.policy.requestCostMicros = 900; else f.policy.dailyBudgetMicros = 500;
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  };
  await assert.rejects(f.run()); assert.ok(changed); assert.equal(f.posts, 0);
  assert.ok(f.calls.filter(x => x.path === "/settle").every(x => x.body.actualCostMicros === 0));
  assert.equal(bodyBudgetCharged(), 0);
});

test("opaque-only input and unknown hard pricing deny before authority/materialization respectively", async t => {
  const f = await setup(t, { unknown: true });
  await assert.rejects(f.start("native", true), { status: 403 }); assert.equal(f.calls.length, 0);
  await assert.rejects(f.run(), { code: "pricing_required" });
  assert.equal(f.calls.filter(x => x.path === "/materialize").length, 0); assert.equal(f.posts, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("unmetered unknown USD remains explicitly unknown after invocation", async t => {
  const f = await setup(t, { unknown: true, unmetered: true }); await f.run();
  const [event] = await f.events(); assert.equal(event.cost_basis, "unpriced_request"); assert.equal(event.reporting_known_cost_micros, null);
  assert.equal(event.input_tokens, null); assert.equal(f.posts, 1); assert.equal(bodyBudgetCharged(), 0);
});

for (const fault of ["busy", "copied-read", "copied-capsule"]) test("private handoff fault injection denies " + fault + " without a manufactured RPC", async t => {
  const f = await setup(t), handoff = MiniMaxMusicCoverControl.prototype.tryPostHandoff;
  t.mock.method(MiniMaxMusicCoverControl.prototype, "tryPostHandoff", function(cap, read, ...rest) {
    if (fault === "busy") this.queues[0].push(() => {});
    try { return handoff.call(this, fault === "copied-capsule" ? { ...cap } : cap, fault === "copied-read" ? { ...read } : read, ...rest); }
    finally { if (fault === "busy") this.queues[0].pop(); }
  });
  await assert.rejects(f.run()); assert.equal(f.posts, 0); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(f.calls.filter(x => x.path === "/reserve").length, 4);
});
