import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// Actual GA server-bridge shape: PCMU, mini ASR, VAD auto flags, functions,
// no explicit output cap. Synthetic sockets only; real router, authority and SQL.
const vad = { type: "server_vad", threshold: .5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true };
const native = { type: "realtime", model: "gpt-realtime-2.1", output_modalities: ["audio"], audio: { input: { format: { type: "audio/pcmu" }, noise_reduction: null, transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: vad }, output: { format: { type: "audio/pcmu" }, voice: "marin" } }, tools: [{ type: "function", name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }], tool_choice: "auto" };
const router = [
  'import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";',
  'export * from "./worker/index.ts";',
  'export class BudgetLedgerObject extends RealBudgetLedger { constructor(state) { super(state); this.sql = state.storage.sql; } async fetch(r) { if (new URL(r.url).pathname === "/fixture-rows") return Response.json({ reservations: [...this.sql.exec("SELECT reservation_id, settled, dispatch_started, reserved_micros FROM budget_reservations")] }); return super.fetch(r); } }',
  'export default handler;',
].join('\n');
const upstream = [
  'let mode = "normal", connects = 0, appends = 0, creates = 0, cancels = 0, results = 0, policy;',
  'const usage = { input_tokens: 100, output_tokens: 12, total_tokens: 112, input_token_details: { text_tokens: 20, audio_tokens: 80, cached_tokens: 15, cached_tokens_details: { text_tokens: 5, audio_tokens: 10 } }, output_token_details: { text_tokens: 2, audio_tokens: 10 } };',
  'export default { async fetch(r) { const u = new URL(r.url); if (u.pathname === "/fixture-config") { mode = await r.text(); return new Response("ok"); } if (u.pathname === "/fixture-stats") return Response.json({ connects, appends, creates, cancels, results, policy }); connects++;',
  'if (u.pathname !== "/v1/realtime" || u.search !== "?model=gpt-realtime-2.1" || r.headers.get("authorization") !== "Bearer fixture-upstream-key") throw Error("wrong route");',
  "const p = new WebSocketPair(), ws = p[1]; ws.accept(); let active, segment = 0, deferred = [], socketResults = 0, socketCreates = 0, updates = 0; const send = e => ws.send(JSON.stringify(e));",
  'const stt = id => ({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: "synthetic input", usage: { type: "tokens", input_tokens: 10, input_token_details: { audio_tokens: 8, text_tokens: 2 }, output_tokens: 2, total_tokens: 12 } });',
  'const done = (status = "completed", output = []) => { send({ type: "response.done", response: { id: active, status, output, usage } }); };',
  'send({ type: "session.created", session: { type: "realtime", model: "gpt-realtime-2.1" } }); send({ type: "conversation.created", conversation: { id: "conv_auto" } });',
  'ws.addEventListener("message", ev => { const e = JSON.parse(ev.data);',
  "if (e.type === \"session.update\") { if (mode === \"hold-update\" && updates++ > 0) return; policy = e.session; send({ type: \"session.updated\", session: mode === \"unsafe\" ? { ...policy, audio: { ...policy.audio, input: { ...policy.audio.input, turn_detection: { ...policy.audio.input.turn_detection, create_response: true } } } } : policy }); }",
  "else if (e.type === \"input_audio_buffer.clear\") { if (mode !== \"clear-delayed\") { if (mode === \"clear-inflight\") { send({ type: \"input_audio_buffer.speech_started\", item_id: \"clear_speech\", audio_start_ms: 0 }); send({ type: \"input_audio_buffer.speech_stopped\", item_id: \"clear_speech\", audio_end_ms: 100 }); } send({ type: \"input_audio_buffer.cleared\" }); if (mode === \"clear-duplicate\") send({ type: \"input_audio_buffer.cleared\" }); } }",
  "else if (e.type === \"input_audio_buffer.append\") { appends++; if (mode === \"delayed-manual-vad\") { const id = \"input_\" + (++segment); send({ type: \"input_audio_buffer.speech_started\", item_id: id, audio_start_ms: segment === 1 ? 0 : 900 }); send({ type: \"input_audio_buffer.speech_stopped\", item_id: id, audio_end_ms: segment === 1 ? 900 : 1100 }); send({ type: \"input_audio_buffer.committed\", item_id: id }); if (policy.audio.input.transcription) send(stt(id)); return; } if ([\"stream\", \"clear-delayed\", \"clear-duplicate\", \"clear-inflight\", \"manual-vad\"].includes(mode)) { send({ type: \"rate_limits.updated\", rate_limits: [] }); return; } if (mode === \"delayed-vad\") { if (++segment === 1) { send({ type: \"rate_limits.updated\", rate_limits: [] }); return; } for (let n = 1; n <= 2; n++) { const id = \"input_\" + n; send({ type: \"input_audio_buffer.speech_started\", item_id: id, audio_start_ms: (n - 1) * 100 }); send({ type: \"input_audio_buffer.speech_stopped\", item_id: id, audio_end_ms: n * 100 }); send({ type: \"input_audio_buffer.committed\", item_id: id }); } send(stt(\"input_2\")); send(stt(\"input_1\")); return; } const id = \"input_\" + (++segment); send({ type: \"input_audio_buffer.speech_started\", item_id: id, audio_start_ms: (segment - 1) * 100 }); if (mode.startsWith(\"cancel-race\") && segment === 2) done(); send({ type: \"input_audio_buffer.speech_stopped\", item_id: id, audio_end_ms: mode === \"future-vad\" ? 9999 : segment * 100 }); send({ type: \"input_audio_buffer.committed\", item_id: id }); send({ type: \"conversation.item.added\", item: { id, type: \"message\", role: \"user\", content: [{ type: \"input_audio\" }] } }); if (!policy.audio.input.transcription) return; if (mode === \"asr-disconnect\") { ws.close(1011); return; } if (mode === \"reverse-asr\") { deferred.push(stt(id)); if (deferred.length === 2) { send(deferred[1]); send(deferred[0]); } } else { const t = stt(id); if (mode === \"malformed-asr\") t.usage.total_tokens++; if (mode === \"asr-overflow\") { t.usage.input_tokens = 0; t.usage.output_tokens = t.usage.total_tokens = Math.floor(Number.MAX_SAFE_INTEGER / 10); t.usage.input_token_details = { audio_tokens: 0, text_tokens: 0 }; } if (mode === \"asr-failed\") { t.type = \"conversation.item.input_audio_transcription.failed\"; delete t.usage; } send(t); if (mode === \"duplicate-asr\" || mode === \"conflict-asr\") send(mode === \"duplicate-asr\" ? t : { ...t, usage: { ...t.usage, output_tokens: 3, total_tokens: 13 } }); } }",
  "else if (e.type === \"input_audio_buffer.commit\") { const id = \"input_\" + (++segment); send({ type: \"input_audio_buffer.committed\", item_id: id }); if (policy.audio.input.transcription) send(stt(id)); }",
  'else if (e.type === "conversation.item.create") { if (e.item.type === "function_call_output") { results++; socketResults++; } send({ type: "conversation.item.added", item: e.item }); }',
  "else if (e.type === \"response.create\") { creates++; socketCreates++; active = \"auto_response_\" + creates; if (!e.response.metadata.clawrouter_unit || e.response.max_output_tokens > 4096) throw Error(\"unowned response\"); send({ type: \"response.created\", response: { id: active, metadata: e.response.metadata } }); if (mode === \"unknown\") { send({ type: \"response.hosted_tool.started\", response_id: active }); return; }",
  'if (["tool", "tool-cancelled", "tool-provisional", "delayed-manual-vad"].includes(mode) && socketResults === 0) { const item = { id: "function_1", type: "function_call", name: "lookup", call_id: "call_1", arguments: "{\\"key\\":\\"fixture\\"}", status: "completed" }; send({ type: "response.output_item.added", response_id: active, item: { ...item, arguments: "", status: "in_progress" } }); send({ type: "response.function_call_arguments.delta", response_id: active, item_id: item.id, call_id: item.call_id, delta: item.arguments }); send({ type: "response.function_call_arguments.done", response_id: active, item_id: item.id, call_id: item.call_id, arguments: item.arguments }); send({ type: "response.output_item.done", response_id: active, item }); if (mode !== "tool-provisional") done(mode === "tool-cancelled" ? "cancelled" : "completed", [item]); return; }',
  "const id = \"assistant_\" + creates; send({ type: \"response.output_item.added\", response_id: active, item: { id, type: \"message\", role: \"assistant\" } }); send({ type: \"response.output_audio.delta\", response_id: active, item_id: id, delta: btoa(String.fromCharCode(...new Uint8Array(800))) }); send({ type: \"response.output_audio_transcript.delta\", response_id: active, item_id: id, delta: \"synthetic reply\" }); if (mode !== \"hold\" && !(mode.startsWith(\"cancel-race\") && socketCreates === 1)) done();",
  "} else if (e.type === \"response.cancel\") { cancels++; if (mode.startsWith(\"cancel-race\")) send({ type: \"error\", error: { type: \"invalid_request_error\", code: \"response_cancel_not_active\", message: \"Cancellation failed: no active response found\", event_id: mode === \"cancel-race-unknown\" ? \"unowned_cancel\" : e.event_id } }); else done(\"cancelled\"); } }); return new Response(null, { status: 101, webSocket: p[0] }); } };",
].join('\n');
function inbox(ws) {
  const events = [], waits = []; let closed = false;
  const flush = () => { for (const w of [...waits]) { const i = events.findIndex(e => e.type === w.type); if (i >= 0 || closed) { waits.splice(waits.indexOf(w), 1); clearTimeout(w.timer); if (i >= 0) w.resolve(events.splice(i, 1)[0]); else w.reject(Error("closed: " + JSON.stringify(events))); } } };
  ws.addEventListener("message", e => { events.push(JSON.parse(e.data)); flush(); }); ws.addEventListener("close", () => { closed = true; flush(); });
  return { send: e => ws.send(JSON.stringify(e)), next: type => new Promise((resolve, reject) => { const w = { type, resolve, reject, timer: setTimeout(() => { waits.splice(waits.indexOf(w), 1); reject(Error("missing " + type + ": " + JSON.stringify(events))); }, 5000) }; waits.push(w); flush(); }) };
}
test("native GA default VAD, input ASR and functions retain isolated ledger ownership", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-auto-stt-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), svc = await mf.getWorker("upstream");
    const secret = "auto-stt-fixture-secret", headers = { authorization: "Bearer clawrouter-live-fixture-" + secret };
    const ns = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router"), authority = ns.get(ns.idFromName("policy-bindings"));
    const policy = async (extra = {}) => { const r = await authority.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], budgetMode: "soft", monthlyBudgetMicros: 100_000_000, retainRequestContent: false, ...extra } }) }); assert.equal(r.status, 200); };
    await policy(); await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" })); await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: 100_000_000 }));
    const stats = async () => (await svc.fetch("https://upstream/fixture-stats")).json();
    const open = async (mode = "normal", session = native, ready = true) => {
      await svc.fetch("https://upstream/fixture-config", { method: "POST", body: mode });
      const r = await mf.dispatchFetch("https://router/v1/realtime?model=gpt-realtime-2.1", { headers: { ...headers, upgrade: "websocket" } }); assert.equal(r.status, 101, r.status === 101 ? "" : await r.text());
      const ws = r.webSocket, q = inbox(ws); ws.accept(); q.send({ type: "session.update", session }); if (ready) await q.next("session.updated"); return { ws, q };
    };
    const append = c => c.q.send({ type: "input_audio_buffer.append", audio: Buffer.alloc(800, 255).toString("base64") });
    const events = async count => { let u; for (let i = 0; i < 200; i++) { u = await (await mf.dispatchFetch("https://router/v1/usage", { headers })).json(); if (u.usage?.events.length >= count) return u.usage.events; await new Promise(r => setTimeout(r, 20)); } assert.fail(JSON.stringify(u)); };
    let count = 0;
    await t.test("actual native default transcribes, auto responds, and meters two different models", async () => {
      const c = await open(); append(c); assert.equal((await c.q.next("conversation.item.input_audio_transcription.completed")).transcript, "synthetic input"); await c.q.next("response.output_audio.delta"); assert.equal((await c.q.next("response.output_audio_transcript.delta")).delta, "synthetic reply"); await c.q.next("response.done");
      const rows = await events(count += 2), asr = rows.find(e => e.capability === "audio.transcription"); assert.equal(asr.model, "openai/gpt-4o-mini-transcribe"); assert.equal(asr.total_tokens, 12); assert.equal(asr.actual_cost_micros, 23); assert.equal(asr.realtime_usage.item_id, "input_1"); assert.equal(rows[0].content_retained, false); assert.equal(rows.find(e => e.capability === "audio.realtime").actual_cost_micros, 2994);
      const wire = (await stats()).policy; assert.equal(wire.audio.input.turn_detection.create_response, false); assert.equal(wire.audio.input.turn_detection.interrupt_response, false); assert.equal(wire.max_output_tokens, 4096); c.ws.close(1000);
    });
    await t.test("native terminal function boundary, output and immediate VAD-suppression patch continue", async () => {
      const c = await open("tool"); append(c); await c.q.next("response.function_call_arguments.delta"); const done = await c.q.next("response.done"); assert.equal(done.response.output[0].name, "lookup");
      c.q.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ result: "fixture" }) } });
      c.q.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { ...vad, create_response: false } } } } }); c.q.send({ type: "response.create" });
      await c.q.next("response.output_audio.delta"); await c.q.next("response.done"); assert.equal((await stats()).results, 1); c.ws.close(1000); await events(count += 3);
    });
    await t.test("barge-in cancels once, waits for retirement, then automatically funds next turn", async () => {
      const c = await open("hold"), before = await stats(); append(c); await c.q.next("response.created"); append(c); await c.q.next("input_audio_buffer.speech_started"); c.q.send({ type: "response.cancel" });
      assert.equal((await c.q.next("response.done")).response.status, "cancelled"); await c.q.next("response.created"); c.q.send({ type: "response.cancel" }); await c.q.next("response.done"); const after = await stats(); assert.equal(after.cancels, before.cancels + 2); assert.equal(after.creates, before.creates + 2); c.ws.close(1000); await events(count += 4);
    });
    await t.test("ASR items settle out of order and identical duplicate terminals cannot double charge", async () => {
      const c = await open("reverse-asr"); append(c); await c.q.next("response.done"); append(c); await c.q.next("response.done"); const one = await c.q.next("conversation.item.input_audio_transcription.completed"), two = await c.q.next("conversation.item.input_audio_transcription.completed"); assert.deepEqual([one.item_id, two.item_id], ["input_2", "input_1"]); c.ws.close(1000); await events(count += 4);
      const d = await open("duplicate-asr"); append(d); await d.q.next("response.done"); d.ws.close(1000); assert.equal((await events(count += 2)).length, count);
    });
    await t.test("hard ASR has no invented bound, including fixed zero; malformed ACK and unknown billable events close", async () => {
      for (const requestCostMicros of [null, 0]) { await policy({ budgetMode: "hard", requestCostMicros }); const before = await stats(), c = await open("normal", native, false); assert.equal((await c.q.next("error")).error.code, "pricing_required"); assert.deepEqual((await stats()).policy, before.policy); c.ws.close(1000); }
      await policy(); const c = await open("unsafe", native, false); assert.equal((await c.q.next("error")).error.code, "realtime_unsafe_ack"); c.ws.close(1000);
      const d = await open("unknown"); append(d); assert.equal((await d.q.next("error")).error.code, "realtime_upstream_event_unsupported"); d.ws.close(1000); await events(count += 2);
    });
    await t.test("native media chunks do not consume control identities; revoked ASR allowlist and zero budget stop before append", async () => {
      const c = await open("stream"), before = await stats();
      for (let i = 0; i < 270; i++) { append(c); await c.q.next("rate_limits.updated"); }
      assert.equal((await stats()).appends, before.appends + 270); c.ws.close(1000); await events(++count);
      await policy({ models: ["openai/gpt-realtime-2.1"] }); const b = await stats(), d = await open("normal", native, false); assert.equal((await d.q.next("error")).error.code, "model_not_allowed"); assert.equal((await stats()).appends, b.appends); d.ws.close(1000);
      await policy(); const e = await open(); await policy({ models: ["openai/gpt-realtime-2.1"] }); const baseline = (await stats()).appends; append(e); assert.equal((await e.q.next("error")).error.code, "model_not_allowed"); assert.equal((await stats()).appends, baseline); e.ws.close(1000);
      await policy(); const f = await open(); await policy({ monthlyBudgetMicros: 0 }); append(f); assert.equal((await f.q.next("error")).error.code, "budget_exhausted"); assert.equal((await stats()).appends, baseline); f.ws.close(1000); await events(++count); await policy();
    });
    await t.test("continuing admitted ASR media refreshes soft budget within bounded freshness", async () => {
      const c = await open("stream"); append(c); await c.q.next("rate_limits.updated"); const before = (await stats()).appends; await policy({ monthlyBudgetMicros: 0 }); await new Promise(resolve => setTimeout(resolve, 110)); append(c); assert.equal((await c.q.next("error")).error.code, "budget_exhausted"); assert.equal((await stats()).appends, before); c.ws.close(1000); await events(++count); await policy();
    });
    await t.test("unknown tool output, cancelled-call result and conflicting ASR terminal cannot escape or double charge", async () => {
      const c = await open(), before = (await stats()).results; c.q.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "not_owned", output: "{}" } }); assert.equal((await c.q.next("error")).error.code, "realtime_tool_result"); assert.equal((await stats()).results, before); c.ws.close(1000);
      const d = await open("tool-cancelled"); append(d); await d.q.next("response.done"); d.q.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "{}" } }); assert.equal((await d.q.next("error")).error.code, "realtime_tool_result"); assert.equal((await stats()).results, before); d.ws.close(1000); await events(count += 2);
      const p = await open("tool-provisional"); append(p); await p.q.next("response.function_call_arguments.done"); p.q.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "{}" } }); assert.equal((await p.q.next("error")).error.code, "realtime_turn_busy"); assert.equal((await stats()).results, before); p.ws.close(1000); await events(count += 2);
      const e = await open("conflict-asr"); append(e); assert.equal((await e.q.next("error")).error.code, "realtime_conflicting_transcription"); e.ws.close(1000); assert.equal((await events(count += 2)).length, count);
    });
    await t.test("PCM native default and cancel-after-terminal remain usable for an explicit retry", async () => {
      const pcm = structuredClone(native); pcm.audio.input.format = pcm.audio.output.format = { type: "audio/pcm", rate: 24000 }; const c = await open("normal", pcm);
      c.q.send({ type: "input_audio_buffer.append", audio: Buffer.alloc(4800).toString("base64") }); await c.q.next("response.done"); c.q.send({ type: "response.cancel", event_id: "cancel_retired" }); const err = await c.q.next("error"); assert.equal(err.error.code, "response_cancel_not_active"); assert.equal(err.error.event_id, "cancel_retired"); assert.equal(err.error.message, "Cancellation failed: no active response found");
      c.q.send({ type: "response.create", event_id: "explicit_retry" }); await c.q.next("response.done"); c.ws.close(1000); await events(count += 3);
    });
    await t.test("clear ACK retires exactly its input unit; delayed and duplicate ACK races cannot retire new media", async () => {
      const c = await open("stream"); append(c); await c.q.next("rate_limits.updated"); c.q.send({ type: "input_audio_buffer.clear" }); await c.q.next("input_audio_buffer.cleared"); append(c); await c.q.next("rate_limits.updated"); c.ws.close(1000); await events(count += 2);
      const d = await open("clear-delayed"); append(d); await d.q.next("rate_limits.updated"); const before = (await stats()).appends; d.q.send({ type: "input_audio_buffer.clear" }); append(d); assert.equal((await d.q.next("error")).error.code, "realtime_turn_busy"); assert.equal((await stats()).appends, before); d.ws.close(1000); await events(++count);
      const e = await open("clear-duplicate"); append(e); await e.q.next("rate_limits.updated"); e.q.send({ type: "input_audio_buffer.clear" }); await e.q.next("input_audio_buffer.cleared"); assert.equal((await e.q.next("error")).error.code, "realtime_unsolicited_clear"); e.ws.close(1000); await events(++count);
    });
    await t.test("uncertain ASR disconnect, malformed usage and failures are attributed unpriced, not free success", async () => {
      for (const mode of ["asr-disconnect", "malformed-asr", "asr-failed", "asr-overflow"]) { const c = await open(mode); append(c); if (mode === "asr-disconnect") await c.q.next("error"); else await c.q.next("response.done"); c.ws.close(1000); const rows = await events(count += mode === "asr-disconnect" ? 1 : 2); const row = rows.find(e => e.capability === "audio.transcription"); assert.equal(row.cost_basis, "unpriced_usage"); assert.equal(row.actual_cost_micros, 0); assert.equal(row.input_tokens, null); }
      const ledgers = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"); for (const name of ["default:fixture", "provider:openai"]) { const rows = await (await ledgers.get(ledgers.idFromName(name)).fetch("https://ledger/fixture-rows")).json(); assert.equal(rows.reservations.length, count); assert.ok(rows.reservations.every(row => row.reservation_id.startsWith("charge:") && row.settled === 1 && row.dispatch_started === 1)); }
    });
    await t.test("delayed VAD commits retain trailing already-forwarded audio and separate ASR receipts", async () => {
      const session = structuredClone(native); session.audio.input.turn_detection.create_response = false; const c = await open("delayed-vad", session); append(c); await c.q.next("rate_limits.updated"); append(c);
      const b = await c.q.next("conversation.item.input_audio_transcription.completed"), a = await c.q.next("conversation.item.input_audio_transcription.completed"); assert.deepEqual([b.item_id, a.item_id], ["input_2", "input_1"]); c.q.send({ type: "response.create" }); await c.q.next("response.done"); c.ws.close(1000); const rows = await events(count += 3); assert.equal(rows.slice(0, 3).filter(e => e.capability === "audio.transcription").length, 2); assert.equal(new Set(rows.slice(0, 3).map(e => e.realtime_usage.unit_id)).size, 3);
    });
    await t.test("manual VAD continuation and tools preserve trailing media across responses", async () => {
      for (const [codec, asr] of [["audio/pcmu", true], ["audio/pcm", true], ["audio/pcmu", false]]) {
        await policy({ budgetMode: asr ? "soft" : "hard" });
        const session = structuredClone(native), bytesPerMs = codec === "audio/pcm" ? 48 : 8;
        session.audio.input.format = session.audio.output.format = codec === "audio/pcm" ? { type: codec, rate: 24000 } : { type: codec };
        session.audio.input.turn_detection.create_response = false;
        if (!asr) session.audio.input.transcription = null;
        const c = await open("delayed-manual-vad", session), before = (await stats()).creates;
        c.q.send({ type: "input_audio_buffer.append", audio: Buffer.alloc(1000 * bytesPerMs).toString("base64") });
        assert.equal((await c.q.next("input_audio_buffer.committed")).item_id, "input_1");
        if (asr) assert.equal((await c.q.next("conversation.item.input_audio_transcription.completed")).item_id, "input_1");
        assert.equal((await stats()).creates, before);
        c.q.send({ type: "response.create" });
        const tool = await c.q.next("response.done"); assert.equal(tool.response.output[0].call_id, "call_1");
        c.q.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "{\"result\":\"fixture\"}" } });
        c.q.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { create_response: false } } } } });
        assert.equal((await c.q.next("session.updated")).session.audio.input.turn_detection.create_response, false);
        c.q.send({ type: "response.create" }); await c.q.next("response.output_audio.delta"); await c.q.next("response.done");
        // The first response cleared commitReady; its tool continuation must
        // still leave the separately owned 100ms trailing ASR buffer intact.
        c.q.send({ type: "input_audio_buffer.append", audio: Buffer.alloc(100 * bytesPerMs).toString("base64") });
        assert.equal((await c.q.next("input_audio_buffer.committed")).item_id, "input_2");
        if (asr) assert.equal((await c.q.next("conversation.item.input_audio_transcription.completed")).item_id, "input_2");
        c.q.send({ type: "response.create" }); await c.q.next("response.done");
        assert.equal((await stats()).creates, before + 3); c.ws.close(1000);
        const added = asr ? 5 : 3, rows = (await events(count += added)).slice(0, added), input = rows.filter(e => e.capability === "audio.transcription");
        assert.equal(input.length, asr ? 2 : 0); assert.deepEqual(input.map(e => e.realtime_usage.item_id).sort(), asr ? ["input_1", "input_2"] : []);
        assert.ok(input.every(e => e.actual_cost_micros === 23 && e.cost_basis === "realtime_input_transcription_usage"));
        const responses = rows.filter(e => e.capability === "audio.realtime"); assert.equal(responses.length, 3); assert.ok(responses.every(e => e.actual_cost_micros === 2994 && e.reserved_cost_micros === (asr ? 0 : 4358144))); assert.equal(new Set(rows.map(e => e.realtime_usage.unit_id)).size, added);
      }
      await policy();
      // No-VAD media still needs an explicit commit; the exception is not a
      // blanket allowance to bypass that protocol or create unsolicited work.
      const session = structuredClone(native); session.audio.input.turn_detection = null; session.audio.input.transcription = null;
      const c = await open("stream", session), before = (await stats()).creates; append(c); await c.q.next("rate_limits.updated"); c.q.send({ type: "response.create" });
      assert.equal((await c.q.next("error")).error.code, "realtime_turn_busy"); assert.equal((await stats()).creates, before); c.ws.close(1000);
    });
    await t.test("effective ACK advertises proxy-owned automatic VAD behavior", async () => {
      const c = await open("normal", native, false); const logical = (await c.q.next("session.updated")).session.audio.input.turn_detection; assert.equal(logical.create_response, true); assert.equal(logical.interrupt_response, true); const wire = (await stats()).policy.audio.input.turn_detection; assert.equal(wire.create_response, false); assert.equal(wire.interrupt_response, false); c.ws.close(1000);
    });
    await t.test("partial VAD merge preserves nondefault settings and ACKs logical flags, never vendor flags", async () => {
      const session = structuredClone(native); Object.assign(session.audio.input.turn_detection, { threshold: .7, silence_duration_ms: 700, create_response: false, interrupt_response: false }); const c = await open("normal", session);
      c.q.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { type: "server_vad", interrupt_response: true } } } } }); const one = (await c.q.next("session.updated")).session.audio.input.turn_detection; assert.equal(one.threshold, .7); assert.equal(one.silence_duration_ms, 700); assert.equal(one.create_response, false); assert.equal(one.interrupt_response, true);
      c.q.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { type: "server_vad", create_response: true } } } } }); const two = (await c.q.next("session.updated")).session.audio.input.turn_detection; assert.equal(two.create_response, true); assert.equal(two.interrupt_response, true); assert.equal((await stats()).policy.audio.input.turn_detection.create_response, false); append(c); await c.q.next("response.done"); c.ws.close(1000); await events(count += 2);
    });
    await t.test("pending full session update cannot acknowledge and then overwrite a later local toggle", async () => {
      const c = await open("hold-update"); c.q.send({ type: "session.update", session: { ...native, instructions: "new fixture instructions" } }); c.q.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { ...vad, create_response: false } } } } }); assert.equal((await c.q.next("error")).error.code, "realtime_session_busy"); c.ws.close(1000);
    });
    await t.test("clear drains already-in-flight VAD notifications until its acknowledgement", async () => {
      const c = await open("clear-inflight"); append(c); await c.q.next("rate_limits.updated"); c.q.send({ type: "input_audio_buffer.clear" }); await c.q.next("input_audio_buffer.speech_started"); await c.q.next("input_audio_buffer.speech_stopped"); await c.q.next("input_audio_buffer.cleared"); append(c); await c.q.next("rate_limits.updated"); c.ws.close(1000); await events(count += 2);
    });
    await t.test("explicit commit under server VAD does not create an automatic response", async () => {
      const c = await open("manual-vad"), before = (await stats()).creates; append(c); await c.q.next("rate_limits.updated"); c.q.send({ type: "input_audio_buffer.commit" }); await c.q.next("input_audio_buffer.committed"); await c.q.next("conversation.item.input_audio_transcription.completed"); assert.equal((await stats()).creates, before); c.q.send({ type: "response.create" }); await c.q.next("response.done"); assert.equal((await stats()).creates, before + 1); c.ws.close(1000); await events(count += 2);
    });
    await t.test("correlated late automatic cancellation is nonterminal; unknown cancellation errors still close", async () => {
      const c = await open("cancel-race"), before = (await stats()).cancels; append(c); await c.q.next("response.created"); append(c); await c.q.next("response.done"); await c.q.next("response.done"); c.q.send({ type: "response.create" }); await c.q.next("response.done"); assert.equal((await stats()).cancels, before + 1); c.ws.close(1000); await events(count += 5);
      const d = await open("cancel-race-unknown"); append(d); await d.q.next("response.created"); append(d); assert.equal((await d.q.next("error")).error.code, "upstream_error"); d.ws.close(1000); await events(count += 4);
    });
    await t.test("future VAD audio boundaries cannot consume unforwarded media", async () => {
      const c = await open("future-vad"); const before = (await stats()).creates; append(c); assert.equal((await c.q.next("error")).error.code, "realtime_vad_order"); assert.equal((await stats()).creates, before); c.ws.close(1000); await events(++count);
    });
    await t.test("hard VAD without ASR reserves a full response bound and settles both SQL legs once", async () => {
      await policy({ budgetMode: "hard" }); const session = structuredClone(native); session.audio.input.transcription = null; const c = await open("hold", session); append(c); await c.q.next("response.created"); const ledgers = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"); for (const name of ["default:fixture", "provider:openai"]) { const state = await (await ledgers.get(ledgers.idFromName(name)).fetch("https://ledger/fixture-rows")).json(); const pending = state.reservations.filter(row => row.settled === 0); assert.equal(pending.length, 1); assert.equal(pending[0].reserved_micros, 4358144); assert.equal(pending[0].dispatch_started, 1); } c.q.send({ type: "response.cancel" }); await c.q.next("response.done"); c.ws.close(1000); const rows = await events(++count); assert.equal(rows[0].capability, "audio.realtime"); assert.equal(rows[0].reserved_cost_micros, 4358144); assert.equal(rows[0].actual_cost_micros, 2994);
      for (const name of ["default:fixture", "provider:openai"]) { const state = await (await ledgers.get(ledgers.idFromName(name)).fetch("https://ledger/fixture-rows")).json(); const hard = state.reservations.filter(row => !row.reservation_id.startsWith("charge:")); // Three earlier delayed manual/tool responses plus this cancelled response.
        assert.equal(hard.length, 4); assert.ok(hard.every(row => row.settled === 1 && row.dispatch_started === 1 && row.reserved_micros === 2994)); }
    });
    const finalRows = await events(count); assert.equal(finalRows.length, count); assert.equal(new Set(finalRows.map(e => e.id)).size, count); const units = finalRows.filter(e => e.realtime_usage); assert.equal(units.length, count - 1); assert.equal(new Set(units.map(e => e.realtime_usage.unit_id)).size, count - 1); const denied = finalRows.filter(e => !e.realtime_usage); assert.equal(denied.length, 1); assert.equal(denied[0].actual_cost_micros, 0); assert.equal(denied[0].cost_basis, "none"); assert.equal(denied[0].status, "provider_error");
    const finalLedger = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    for (const name of ["default:fixture", "provider:openai"]) { const rows = await (await finalLedger.get(finalLedger.idFromName(name)).fetch("https://ledger/fixture-rows")).json(); assert.equal(rows.reservations.length, count); assert.ok(rows.reservations.every(row => row.settled === 1 && row.dispatch_started === 1)); assert.equal(new Set(rows.reservations.map(row => row.reservation_id)).size, count); assert.equal(rows.reservations.reduce((n, row) => n + row.reserved_micros, 0), finalRows.reduce((n, row) => n + row.actual_cost_micros, 0)); }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
