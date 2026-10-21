import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// Real workerd sockets; only external authority/storage latency is controlled.
// This isolates ownership races without weakening the full-handler SQL test.
const router = [
  'import { connectRealtime } from "./worker/realtime-websocket.ts";',
  'import { RealtimeSession } from "./worker/realtime-session.ts";',
  'export * from "./worker/index.ts";',
  'let revoked = false, calls = [], creates = 0, funds = 0, lateClosed = 0;',
  'export default { async fetch(request, env, ctx) {',
  ' const url = new URL(request.url);',
  ' if (url.pathname === "/stats") return Response.json({ calls, creates, funds, lateClosed });',
  ' if (url.pathname === "/revoke") { revoked = true; return new Response("ok"); }',
  ' if (url.pathname === "/connect") { const abort = new AbortController(); if (url.searchParams.has("abort")) setTimeout(() => abort.abort(), 5); try { return await connectRealtime(new URL("https://vendor/v1/realtime"), new Headers(), abort.signal, p => ctx.waitUntil(p), async () => { await fetch("https://upstream/hold"); const p = new WebSocketPair(); p[1].accept(); p[1].addEventListener("close", () => { lateClosed++; }); return new Response(null, { status: 101, webSocket: p[0] }); }, 15); } catch (e) { return new Response(e.code, { status: e.status }); } }',
  ' calls = []; creates = funds = 0; revoked = false; const mode = url.searchParams.get("mode");',
  ' const client = new WebSocketPair(), vendor = new WebSocketPair(); client[1].accept(); vendor[0].accept(); vendor[1].accept();',
  ' const send = e => vendor[0].send(JSON.stringify(e));',
  ' vendor[0].addEventListener("message", event => { const e = JSON.parse(event.data);',
  '  if (e.type === "session.update") send({ type: "session.updated", session: e.session });',
  '  if (e.type === "response.create") { creates++; send({ type: "response.created", response: { id: "r1", metadata: e.response.metadata } }); if (mode === "settle" || mode === "fail-settle") send({ type: "response.done", response: { id: "r1", status: "completed" } }); }',
  ' });',
  ' new RealtimeSession(client[1], vendor[1], { waitUntil: p => ctx.waitUntil(p), timing: { guardMs: 30, idleMs: mode === "idle" ? 40 : 5000, durationMs: mode === "duration" ? 60 : 5000 }, expiresAt: mode === "expiry" ? Date.now() + 60 : undefined,',
  '  async guard() { if (revoked) throw Error("fixture revoked"); if (mode === "guard-hang") await new Promise(() => {}); },',
  '  async fund(unit, cap, signal) { funds++; if (mode === "reserve") await fetch("https://upstream/hold"); return { async settle(terminal, sent, rejected, responseId) { calls.push({ terminal: terminal?.type ?? null, sent, rejected, responseId }); if (mode === "settle") await fetch("https://upstream/hold"); if (mode === "fail-settle") throw Error("fixture durable failure"); } }; }',
  ' });',
  ' return new Response(null, { status: 101, webSocket: client[0] });',
  '} };',
].join('\n');
const policy = { type: "realtime", output_modalities: ["audio"], max_output_tokens: 4096, audio: { input: { format: { type: "audio/pcmu" }, turn_detection: null, transcription: null }, output: { format: { type: "audio/pcmu" }, voice: "cedar" } } };
function observe(ws) {
  const events = []; ws.addEventListener("message", e => events.push(JSON.parse(e.data))); ws.accept();
  return { events, send: e => ws.send(JSON.stringify(e)), async until(type) { const deadline = Date.now() + 2000; while (!events.some(e => e.type === type)) { if (Date.now() > deadline) assert.fail("missing " + type + ": " + JSON.stringify(events)); await new Promise(r => setTimeout(r, 5)); } return events.find(e => e.type === type); } };
}
test("workerd socket retirement aborts admission and settles once across storage races", { timeout: 30_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-realtime-races-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, 'export default { async fetch(request) { if (new URL(request.url).pathname !== "/hold") throw Error("unexpected external call"); await new Promise(r => setTimeout(r, 120)); return new Response("released"); } };');
    const control = path => mf.dispatchFetch("https://router" + path);
    const stats = async () => (await control("/stats")).json();
    const waitStats = async match => { const end = Date.now() + 2000; for (;;) { const s = await stats(); if (match(s)) return s; if (Date.now() > end) assert.fail("race not reached: " + JSON.stringify(s)); await new Promise(r => setTimeout(r, 5)); } };
    const open = async mode => { const r = await mf.dispatchFetch("https://router/?mode=" + mode, { headers: { upgrade: "websocket" } }); assert.equal(r.status, 101); const q = observe(r.webSocket); q.send({ type: "session.update", session: policy }); if (mode !== "guard-hang") await q.until("session.updated"); return { ws: r.webSocket, q }; };
    await t.test("connect abort and deadline dispose a late vendor upgrade without returning it", async () => {
      for (const query of ["", "?abort=1"]) { const before = (await stats()).lateClosed; const r = await control("/connect" + query); assert.equal(r.status, 504); assert.equal(await r.text(), "realtime_connect_timeout"); await waitStats(s => s.lateClosed === before + 1); }
    });
    await t.test("close while reserve is pending never forwards chargeable response", async () => { const c = await open("reserve"); c.q.send({ type: "response.create" }); await waitStats(s => s.funds === 1); c.ws.close(1000); await new Promise(r => setTimeout(r, 10)); const s = await waitStats(s => s.calls.length === 1); assert.equal(s.creates, 0); assert.deepEqual(s.calls, [{ terminal: null, sent: false, rejected: false, responseId: null }]); });
    await t.test("close during settlement preserves terminal, no double settlement or later unit", async () => { const c = await open("settle"); c.q.send({ type: "response.create" }); await waitStats(s => s.calls.length === 1); c.ws.close(1000); await new Promise(r => setTimeout(r, 150)); const s = await stats(); assert.equal(s.funds, 1); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].terminal, "response.done"); assert.equal(s.calls[0].sent, true); });
    await t.test("failed durable settlement closes and refuses additional funded work", async () => { const c = await open("fail-settle"); c.q.send({ type: "response.create" }); await c.q.until("error"); assert.equal((await stats()).funds, 1); c.ws.close(1000); });
    await t.test("guard revocation, stuck guard, expiry, idle and duration are bounded independent of queue", async () => { for (const [mode, code] of [["revoke", "authority_revoked"], ["guard-hang", "authority_timeout"], ["expiry", "credential_expired"], ["idle", "idle_limit"], ["duration", "duration_limit"]]) { const c = await open(mode); if (mode === "revoke") await control("/revoke"); assert.equal((await c.q.until("error")).error.code, code); c.ws.close(1000); } });
    await t.test("binary frames, oversize JSON and queued bursts retire deterministically", async () => { for (const frame of [new Uint8Array([1, 2]), " ".repeat(65537)]) { const c = await open("normal"); c.ws.send(frame); assert.equal((await c.q.until("error")).error.code, "frame_limit"); c.ws.close(1000); } const c = await open("reserve"); c.q.send({ type: "response.create" }); await waitStats(s => s.funds === 1); for (let i = 0; i < 25; i++) c.q.send({ type: "response.cancel" }); assert.equal((await c.q.until("error")).error.code, "queue_limit"); assert.equal((await waitStats(s => s.calls.length === 1)).creates, 0); c.ws.close(1000); });
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
