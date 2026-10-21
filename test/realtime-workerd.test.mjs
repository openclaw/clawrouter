import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const BOUND = 4_358_144;
const router = [
  'import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";',
  'export * from "./worker/index.ts";',
  'import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";',
  'let failPersistence = false;',
  'export class BudgetLedgerObject extends RealBudgetLedger {',
  ' constructor(state) { super(state); this.sqlFixture = state.storage.sql; }',
  ' async fetch(request) { const path = new URL(request.url).pathname; if (path === "/fixture-fail") { this.failFixture = await request.text() === "on"; return new Response("ok"); } if (path === "/settle" && this.failFixture) return new Response("fixture unavailable", { status: 503 }); if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.sqlFixture.exec("SELECT settled, dispatch_started, reserved_micros FROM budget_reservations")]); return super.fetch(request); }',
  '}', 'export default { async fetch(request, env, ctx) { if (new URL(request.url).pathname === "/fixture-persist") { failPersistence = await request.text() === "on"; return new Response("ok"); } if (new URL(request.url).pathname === "/fixture-grant") { if (await request.text() === "revoke") await revokeGrantCredentials(env, "oauth/fixture/openai"); else await putGrantCredentials(env, "oauth/fixture/openai", { enabled: true, provider: "openai", kind: "api_key", credential: "fixture-upstream-key" }); return new Response("ok"); } return handler.fetch(request, failPersistence ? { ...env, USAGE_QUEUE: { async send() { throw Error("fixture queue unavailable"); } } } : env, ctx); }, queue: handler.queue };',
].join('\n');
const upstream = [
  'let mode = "normal", creates = 0, connects = 0, appends = 0, items = 0, truncates = 0, lastSession;',
  'const usage = { input_tokens: 100, output_tokens: 12, total_tokens: 112, input_token_details: { text_tokens: 20, audio_tokens: 80, cached_tokens: 15, cached_tokens_details: { text_tokens: 5, audio_tokens: 10 } }, output_token_details: { text_tokens: 2, audio_tokens: 10 } };',
  'export default { async fetch(request) {',
  ' const url = new URL(request.url);',
  ' if (url.pathname === "/fixture-config") { mode = await request.text(); return new Response("ok"); }',
  ' if (url.pathname === "/fixture-stats") return Response.json({ creates, connects, appends, items, truncates, lastSession });',
  ' connects++;',
  ' if (mode === "401" || mode === "429") return new Response("synthetic rejection", { status: Number(mode) });',
  ' if (url.pathname !== "/v1/realtime" || url.search !== "?model=gpt-realtime-2.1" || request.headers.get("authorization") !== "Bearer fixture-upstream-key" || request.headers.has("openai-beta")) throw Error("wrong model or authentication provenance");',
  ' const pair = new WebSocketPair(), ws = pair[1]; ws.accept(); let active, codec;',
  ' const send = e => ws.send(JSON.stringify(e));',
  ' send({ type: "session.created", session: { type: "realtime", model: "gpt-realtime-2.1" } });',
  ' send({ type: "conversation.created", conversation: { id: "conv_fixture", object: "realtime.conversation" } });',
  ' const terminal = status => { const e = { type: "response.done", response: { id: active, status, ...(mode === "absent" ? {} : { usage: mode === "malformed" ? { ...usage, total_tokens: 999 } : usage }) } }; send(e); if (mode === "duplicate") send(e); if (mode === "conflict") send({ ...e, response: { ...e.response, status: "failed" } }); };',
  ' ws.addEventListener("message", event => { const e = JSON.parse(event.data);',
  ' if (e.type === "session.update") { lastSession = e.session; codec = e.session.audio.output.format; send({ type: "session.updated", session: mode === "unsafe-ack" ? { ...e.session, max_output_tokens: "inf" } : e.session }); }',
  ' else if (e.type === "input_audio_buffer.append") appends++;',
  ' else if (e.type === "conversation.item.create") { items++; send({ type: "conversation.item.created", item: e.item }); send({ type: "conversation.item.done", item: e.item }); }',
  ' else if (e.type === "input_audio_buffer.commit") { send({ type: "input_audio_buffer.committed", item_id: "user_" + appends }); send({ type: "conversation.item.created", item: { type: "message", role: "user", id: "user_" + appends } }); }',
  ' else if (e.type === "input_audio_buffer.clear") send({ type: "input_audio_buffer.cleared" });',
  ' else if (e.type === "conversation.item.delete") { send({ type: "conversation.item.deleted", item_id: e.item_id }); if (mode === "delete-race") { send({ type: "response.output_audio.delta", response_id: active, item_id: e.item_id, delta: btoa(String.fromCharCode(...new Uint8Array(4800))) }); send({ type: "response.output_item.done", response_id: active, item: { type: "message", role: "assistant", id: e.item_id } }); terminal("completed"); } }',
  ' else if (e.type === "conversation.item.truncate") { truncates++; send({ type: "conversation.item.truncated", item_id: e.item_id }); if (mode === "fragmented") terminal("completed"); }',
  ' else if (e.type === "response.create") {',
  '  creates++; active = "response_" + creates;',
  '  if (e.response.max_output_tokens > 4096 || e.response.output_modalities.join() !== "audio" || !e.response.metadata.clawrouter_unit) throw Error("missing finite owner");',
  '  if (mode === "reject") { send({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", event_id: e.event_id } }); return; }',
  '  if (mode === "outoforder") { terminal("completed"); return; }',
  '  send({ type: "response.created", response: { id: active, metadata: e.response.metadata } });',
  '  if (mode === "disconnect") { ws.close(1011, "synthetic disconnect"); return; }',
  '  const item_id = "assistant_" + creates;',
  '  send({ type: "response.output_item.added", response_id: active, item: { type: "message", role: "assistant", id: item_id } });',
  '  const audio = btoa(String.fromCharCode(...new Uint8Array(mode === "fragmented" ? 1024 : codec.type === "audio/pcm" ? 4800 : 800)));',
  '  for (let i = 0; i < (mode === "fragmented" ? 6 : 1); i++) send({ type: "response.output_audio.delta", response_id: active, item_id, delta: audio });',
  '  send({ type: "response.output_audio_transcript.delta", response_id: active, item_id, delta: "synthetic generated speech" });',
  '  if (mode === "burst") { for (let i = 0; i < 1500; i++) send({ type: "response.output_audio.delta", response_id: active, item_id, delta: audio }); return; }',
  '  if (mode !== "cancel" && mode !== "hold" && mode !== "delete-race" && mode !== "fragmented") terminal("completed");',
  ' } else if (e.type === "response.cancel") terminal("cancelled");',
  ' });',
  ' return new Response(null, { status: 101, webSocket: pair[0] });',
  '} };',
].join('\n');

function inbox(ws) {
  const events = [], waiting = []; let closed = false;
  ws.addEventListener("message", e => { events.push(JSON.parse(e.data)); flush(); });
  ws.addEventListener("close", () => { closed = true; flush(); });
  function flush() { for (const w of [...waiting]) { const i = events.findIndex(w.match); if (i >= 0) { waiting.splice(waiting.indexOf(w), 1); clearTimeout(w.timer); w.resolve(events.splice(i, 1)[0]); } else if (closed) { waiting.splice(waiting.indexOf(w), 1); clearTimeout(w.timer); w.reject(Error("socket closed")); } } }
  return { isClosed: () => closed, next(type, timeout = 4000) { return new Promise((resolve, reject) => { const w = { match: e => e.type === type, resolve, reject, timer: setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(Error("missing " + type + ": " + events.map(e => e.type + ":" + e.error?.code).join())); }, timeout) }; waiting.push(w); flush(); }); }, send(e) { ws.send(JSON.stringify(e)); } };
}
const policy = { type: "realtime", output_modalities: ["audio"], max_output_tokens: 4096, audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, transcription: null }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" } } };

test("manual Realtime owns real workerd audio turns and durable per-response capacity", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-realtime-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), service = await mf.getWorker("upstream");
    const secret = "realtime-fixture-secret", headers = { authorization: "Bearer clawrouter-live-fixture-" + secret };
    let limit = 100_000_000;
    const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
    const authorityNS = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router"), authority = authorityNS.get(authorityNS.idFromName("policy-bindings"));
    const mutate = async (path, body) => { const r = await authority.fetch("https://authority" + path, { method: "POST", body: JSON.stringify(body) }); assert.equal(r.status, 200); return r; };
    const setCredential = c => mutate("/credentials/mutate", { operation: "put", credentialId: "fixture", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.invalid" }, credential: c });
    const setPolicy = extra => mutate("/policies/put", { policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false, ...extra } });
    await setPolicy(); await kv.put("credentials/fixture", JSON.stringify(credential));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const config = mode => service.fetch("https://upstream/fixture-config", { method: "POST", body: mode });
    const stats = async () => (await service.fetch("https://upstream/fixture-stats")).json();
    const open = async (mode = "normal", session = policy) => {
      await config(mode);
      const r = await mf.dispatchFetch("https://router/v1/realtime?model=openai/gpt-realtime-2.1", { headers: { ...headers, upgrade: "websocket" } });
      assert.equal(r.status, 101, await (r.status === 101 ? Promise.resolve("") : r.text()));
      assert.equal(r.headers.get("x-clawrouter-realtime-policy"), "manual-no-input-transcription-v1");
      const ws = r.webSocket, q = inbox(ws); ws.accept(); q.send({ type: "session.update", session });
      return { ws, q };
    };
    const ready = async (mode = "normal", session = policy) => { const c = await open(mode, session); await c.q.next("session.updated"); return c; };
    const turn = async c => { c.q.send({ type: "input_audio_buffer.append", audio: Buffer.alloc(4800).toString("base64") }); c.q.send({ type: "input_audio_buffer.commit" }); await c.q.next("input_audio_buffer.committed"); c.q.send({ type: "response.create", response: { max_output_tokens: 4096 } }); };
    const usage = async count => {
      const deadline = Date.now() + 5000; let value;
      do { value = await (await mf.dispatchFetch("https://router/v1/usage", { headers })).json(); if (value.usage?.events.length >= count) return value; await new Promise(r => setTimeout(r, 20)); } while (Date.now() < deadline);
      assert.fail("durable usage count " + count + ": " + JSON.stringify(value));
    };
    let count = 0;
    await t.test("auth precedes upstream upgrade; GA model, header and manual ACK", async () => {
      const before = await stats();
      const r = await mf.dispatchFetch("https://router/v1/realtime?model=openai/gpt-realtime-2.1", { headers: { upgrade: "websocket" } }); assert.equal(r.status, 401); assert.equal((await stats()).connects, before.connects);
      const c = await ready(); assert.equal((await c.q.next("session.created")).session.model, "gpt-realtime-2.1"); assert.equal((await c.q.next("conversation.created")).conversation.id, "conv_fixture");
      for (let i = 0; i < 2; i++) {
        await turn(c); assert.equal((await c.q.next("conversation.item.created")).item.role, "user"); assert.equal((await c.q.next("response.output_audio.delta")).delta, Buffer.alloc(4800).toString("base64"));
        assert.equal((await c.q.next("response.output_audio_transcript.delta")).delta, "synthetic generated speech");
        assert.equal((await c.q.next("response.done")).response.status, "completed");
      }
      const u = await usage(count += 2), rows = u.usage.events;
      for (const e of rows) { assert.equal(e.reserved_cost_micros, BOUND); assert.equal(e.actual_cost_micros, 2994); assert.equal(e.cost_basis, "realtime_modality_usage"); assert.equal(e.input_tokens, 100); assert.equal(e.realtime_usage.cached_audio_input_tokens, 10); assert.equal(e.content_retained, false); }
      assert.notEqual(rows[0].realtime_usage.unit_id, rows[1].realtime_usage.unit_id);
      assert.notEqual(rows[0].realtime_usage.response_id, rows[1].realtime_usage.response_id);
      c.q.send({ type: "conversation.item.truncate", item_id: "assistant_2", content_index: 0, audio_end_ms: 50 }); await c.q.next("conversation.item.truncated");
      c.q.send({ type: "conversation.item.delete", item_id: "assistant_2" }); await c.q.next("conversation.item.deleted");
      c.ws.close(1000);
      const ns = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
      for (const name of ["default:fixture", "provider:openai"]) { const rows = await (await ns.get(ns.idFromName(name)).fetch("https://ledger/fixture-reservations")).json(); assert.equal(rows.length, 2); assert.ok(rows.every(e => e.settled === 1 && e.dispatch_started === 1 && e.reserved_micros === 2994)); }
    });
    await t.test("PCMU 8k clear/commit returns native audio; explicit input ASR is rejected", async () => {
      const pcmu = { ...policy, audio: { input: { format: { type: "audio/pcmu" }, turn_detection: null, transcription: null }, output: { format: { type: "audio/pcmu" }, voice: "marin" } } };
      const c = await ready("normal", pcmu), audio = Buffer.alloc(800, 255).toString("base64");
      c.q.send({ type: "input_audio_buffer.append", audio }); c.q.send({ type: "input_audio_buffer.clear" }); await c.q.next("input_audio_buffer.cleared");
      c.q.send({ type: "input_audio_buffer.append", audio }); c.q.send({ type: "input_audio_buffer.commit" }); await c.q.next("input_audio_buffer.committed");
      c.q.send({ type: "response.create", response: { max_output_tokens: 512 } });
      assert.equal((await c.q.next("response.output_audio.delta")).delta, Buffer.alloc(800).toString("base64")); await c.q.next("response.done"); c.ws.close(1000);
      const u = await usage(++count); assert.equal(u.usage.events[0].realtime_usage.output_cap, 512); assert.equal(u.usage.events[0].actual_cost_micros, 2994);
      const d = await open("normal", { ...policy, audio: { ...policy.audio, input: { ...policy.audio.input, transcription: { model: "gpt-transcribe" } } } });
      assert.equal((await d.q.next("error")).error.code, "realtime_auto_stt_unsupported"); d.ws.close(1000);
    });
    await t.test("cancelled response bills nonzero usage; identical terminal is idempotent", async () => {
      const c = await ready("cancel"); await turn(c); const created = await c.q.next("response.created"); c.q.send({ type: "response.cancel", response_id: created.response.id }); assert.equal((await c.q.next("response.done")).response.status, "cancelled"); c.ws.close(1000); await usage(++count);
      const d = await ready("duplicate"); await turn(d); await d.q.next("response.done"); await turn(d); await d.q.next("response.done"); d.ws.close(1000);
      const u = await usage(count += 2); assert.equal(u.usage.events.length, count); assert.ok(u.usage.events.every(e => e.actual_cost_micros === 2994));
    });
    await t.test("finite safe user text item keeps native identity; privileged items never leave the router", async () => {
      const c = await ready(), before = (await stats()).items;
      c.q.send({ type: "conversation.item.create", item: { id: "text_fixture", type: "message", role: "user", content: [{ type: "input_text", text: "synthetic user input" }] } });
      assert.equal((await c.q.next("conversation.item.created")).item.id, "text_fixture"); assert.equal((await c.q.next("conversation.item.done")).item.content[0].text, "synthetic user input");
      c.q.send({ type: "response.create" }); await c.q.next("response.done"); c.ws.close(1000); await usage(++count);
      const d = await ready(); d.q.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "unsupported privilege" }] } });
      assert.equal((await d.q.next("error")).error.code, "realtime_item"); assert.equal((await stats()).items, before + 1); d.ws.close(1000);
    });
    await t.test("delete ACK during active audio preserves in-flight output and exact terminal settlement", async () => {
      const c = await ready("delete-race"); await turn(c); const item = (await c.q.next("response.output_item.added")).item.id;
      c.q.send({ type: "conversation.item.delete", item_id: item }); await c.q.next("conversation.item.deleted");
      await c.q.next("response.output_item.done"); assert.equal((await c.q.next("response.done")).response.status, "completed");
      c.ws.close(1000); assert.equal((await usage(++count)).usage.events[0].actual_cost_micros, 2994);
    });
    await t.test("fragmented PCM and PCMU truncation admits exact duration but rejects the next millisecond", async () => {
      const pcmu = { ...policy, audio: { input: { format: { type: "audio/pcmu" }, turn_detection: null, transcription: null }, output: { format: { type: "audio/pcmu" }, voice: "marin" } } };
      for (const [session, end] of [[policy, 128], [pcmu, 768]]) {
        for (const extra of [0, 1]) {
          const c = await ready("fragmented", session), before = (await stats()).truncates; await turn(c);
          let item;
          for (let i = 0; i < 6; i++) { const delta = await c.q.next("response.output_audio.delta"); assert.equal(Buffer.from(delta.delta, "base64").length, 1024); item = delta.item_id; }
          c.q.send({ type: "conversation.item.truncate", item_id: item, content_index: 0, audio_end_ms: end + extra });
          if (extra) {
            assert.equal((await c.q.next("error")).error.code, "realtime_truncate"); assert.equal((await stats()).truncates, before);
          } else {
            assert.equal((await c.q.next("conversation.item.truncated")).item_id, item); assert.equal((await c.q.next("response.done")).response.status, "completed"); assert.equal((await stats()).truncates, before + 1);
          }
          c.ws.close(1000); const event = (await usage(++count)).usage.events[0]; assert.equal(event.actual_cost_micros, extra ? BOUND : 2994); assert.equal(event.cost_basis, extra ? "realtime_full_context_bound" : "realtime_modality_usage");
        }
      }
    });
    await t.test("missing usage and disconnect retain bound; correlated preexecution rejection releases", async () => {
      for (const mode of ["absent", "malformed", "disconnect", "reject"]) { const c = await ready(mode); await turn(c); if (["absent", "malformed"].includes(mode)) await c.q.next("response.done"); else await c.q.next("error"); c.ws.close(1000); const u = await usage(++count); assert.equal(u.usage.events[0].actual_cost_micros, mode === "reject" ? 0 : BOUND); }
    });
    await t.test("default VAD/transcription, unsafe ACK and invalid codec fail closed before audio", async () => {
      const before = (await stats()).appends;
      for (const [mode, s] of [["normal", { ...policy, audio: { ...policy.audio, input: { ...policy.audio.input, turn_detection: { type: "server_vad", create_response: true } } } }], ["unsafe-ack", policy]]) { const c = await open(mode, s); await c.q.next("error"); c.ws.close(1000); }
      const c = await ready(); c.q.send({ type: "input_audio_buffer.append", audio: "AA==" }); assert.equal((await c.q.next("error")).error.code, "realtime_audio_alignment"); c.ws.close(1000); assert.equal((await stats()).appends, before);
    });
    await t.test("per-turn fresh capacity and credential checks deny before response.create egress", async () => {
      const c = await ready(), before = (await stats()).creates;
      const u = await usage(count); limit = u.budget.spentMicros + BOUND - 1; await setPolicy();
      c.q.send({ type: "response.create" }); assert.equal((await c.q.next("error")).error.code, "budget_exhausted"); assert.equal((await stats()).creates, before); c.ws.close(1000); await usage(++count);
      limit = 100_000_000; await setPolicy(); const d = await ready(); await setCredential({ ...credential, enabled: false }); d.q.send({ type: "response.create" }); assert.equal((await d.q.next("error")).error.code, "realtime_authority_revoked"); assert.equal((await stats()).creates, before); d.ws.close(1000); await setCredential(credential);
    });
    await t.test("upgrade 401/429 remain HTTP failures and unknown terminal/burst closes", async () => {
      for (const status of [401, 429]) { await config(String(status)); const r = await mf.dispatchFetch("https://router/v1/realtime?model=openai/gpt-realtime-2.1", { headers: { ...headers, upgrade: "websocket" } }); assert.equal(r.status, status); }
      for (const mode of ["outoforder", "conflict", "burst"]) { const c = await ready(mode); await turn(c); await c.q.next("error"); c.ws.close(1000); assert.equal((await usage(++count)).usage.events[0].actual_cost_micros, mode === "conflict" ? 2994 : BOUND); }
    });
    await t.test("missing native usage retains qualified bound even under fixed-zero policy", async () => {
      await setPolicy({ requestCostMicros: 0 }); const c = await ready("absent"); await turn(c); await c.q.next("response.done"); c.ws.close(1000);
      const event = (await usage(++count)).usage.events[0]; assert.equal(event.actual_cost_micros, BOUND); assert.equal(event.cost_basis, "realtime_full_context_bound"); await setPolicy();
    });
    await t.test("real ledger and queue persistence failure closes without releasing capacity or funding another turn", async () => {
      const ns = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"), ledgers = ["default:fixture", "provider:openai"].map(name => ns.get(ns.idFromName(name)));
      for (const ledger of ledgers) assert.equal((await ledger.fetch("https://ledger/fixture-fail", { method: "POST", body: "on" })).status, 200);
      assert.equal((await mf.dispatchFetch("https://router/fixture-persist", { method: "POST", body: "on" })).status, 200);
      try {
        const before = (await stats()).creates, c = await ready(); await turn(c); assert.equal((await c.q.next("error")).error.code, "realtime_accounting_unavailable");
        assert.equal((await stats()).creates, before + 1); try { c.q.send({ type: "response.create" }); } catch { /* Closing socket can reject synchronously. */ }
        const deadline = Date.now() + 2000; while (!c.q.isClosed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(c.q.isClosed(), true);
        for (const ledger of ledgers) { const rows = await (await ledger.fetch("https://ledger/fixture-reservations")).json(); assert.ok(rows.some(row => row.settled === 0 && row.dispatch_started === 1 && row.reserved_micros === BOUND)); }
        assert.equal((await stats()).creates, before + 1); await usage(++count); c.ws.close(1000);
      } finally {
        await mf.dispatchFetch("https://router/fixture-persist", { method: "POST", body: "off" });
        for (const ledger of ledgers) await ledger.fetch("https://ledger/fixture-fail", { method: "POST", body: "off" });
      }
    });
    await t.test("pinned canonical API grant revision and revocation cannot reconnect or replay", async () => {
      const grant = async action => { const r = await mf.dispatchFetch("https://router/fixture-grant", { method: "POST", body: action }); assert.equal(r.status, 200, await r.text()); };
      await grant("put"); const c = await ready(); await turn(c); await c.q.next("response.done"); const before = await stats();
      await grant("rotate"); c.q.send({ type: "response.create" }); const changed = await c.q.next("error"); assert.match(changed.error.code, /grant|route/); assert.equal((await stats()).creates, before.creates); c.ws.close(1000);
      const d = await ready("hold"); await turn(d); await d.q.next("response.created"); const admitted = await stats(); await grant("revoke");
      assert.equal((await d.q.next("error", 12000)).error.code, "authority_revoked"); assert.equal((await stats()).connects, admitted.connects); assert.equal((await stats()).creates, admitted.creates); d.ws.close(1000);
    });
    await t.test("caller principal and tenant reassignment retires retained conversation before provider I/O or new SQL holds", async () => {
      // Real authority admin PUT preserves key secret, policy ID and generation.
      // Upstream provenance remains unchanged while caller ownership changes.
      assert.equal((await mf.dispatchFetch("https://router/fixture-grant", { method: "POST", body: "put" })).status, 200);
      const ns = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
      const rows = async name => (await ns.get(ns.idFromName(name)).fetch("https://ledger/fixture-reservations")).json();
      const names = ["default:fixture:alice@example.invalid", "default:fixture:bob@example.invalid", "other:fixture:alice@example.invalid", "provider:openai"];
      for (const kind of ["principal", "tenant"]) {
        let c;
        try {
          await setCredential({ ...credential, principalId: "alice@example.invalid" });
          await setPolicy({ budgetScope: "principal", tenantId: null });
          c = await ready();
          // null and default are the SAME normalized tenant, not a revocation.
          await setPolicy({ budgetScope: "principal", tenantId: "default" });
          await turn(c); await c.q.next("response.done"); await usage(kind === "principal" ? 1 : 2);
          const before = await stats(), baseline = await Promise.all(names.map(rows));
          assert.ok(baseline[0].some(row => row.settled === 1 && row.reserved_micros === 2994));
          if (kind === "principal") await setCredential({ ...credential, principalId: "bob@example.invalid" });
          else await setPolicy({ budgetScope: "principal", tenantId: "other" });
          c.q.send({ type: "response.create" });
          assert.equal((await c.q.next("error")).error.code, "realtime_caller_changed");
          const deadline = Date.now() + 2000;
          while (!c.q.isClosed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
          assert.equal(c.q.isClosed(), true);
          const after = await stats(); assert.equal(after.creates, before.creates); assert.equal(after.connects, before.connects);
          for (let i = 0; i < names.length; i++) assert.deepEqual(await rows(names[i]), baseline[i], "no new reservation or charge after " + kind + " reassignment: " + names[i]);
          assert.equal((await rows(names[1])).length, 0); assert.equal((await rows(names[2])).length, 0);
        } finally { c?.ws.close(1000); await setCredential(credential); await setPolicy(); }
      }
    });
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
