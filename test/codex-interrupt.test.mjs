import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeCodexClient } from "./helpers/native-codex.mjs";

const binary = process.env.CLAWROUTER_CODEX_BINARY;
const model = "gpt-6.1-sol";
const secret = "interrupt-fixture-secret", key = `clawrouter-live-fixture-${secret}`;
const limit = 1_000_000_000;

// The bridge schedules a real transport race; routing, authorization,
// continuation binding, reservations and usage run in the complete Worker.
for (const completionRace of [false, true]) test(`native Codex steering through workerd (completion race=${completionRace})`, { skip: !binary, timeout: 60_000 }, async t => {
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { WebSocketServer } = createRequire(require.resolve("miniflare"))("ws");
  const home = await mkdtemp(join(tmpdir(), "clawrouter-native-interrupt-"));
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ server });
  let mf, client, connections = 0;
  const frames = [], output = [], bridges = [], bridgeErrors = [];
  try {
    mf = await startWorkerdFixture(home, routerFixture(), upstreamFixture(), { preventEviction: true });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const upstream = await mf.getWorker("upstream");
    const state = () => upstream.fetch("https://fixture.example/state").then(response => response.json());
    wss.on("connection", (socket, request) => {
      connections++;
      const ready = (async () => {
        const opened = await mf.dispatchFetch(`https://router.example${request.url}`, { headers: { ...request.headers, authorization: `Bearer ${key}` } });
        assert.equal(opened.status, 101);
        const worker = opened.webSocket; worker.accept();
        worker.addEventListener("message", ({ data }) => { output.push(JSON.parse(data).type); if (socket.readyState === 1) socket.send(data); });
        worker.addEventListener("close", () => socket.close());
        socket.on("close", () => { try { worker.close(); } catch {} });
        return worker;
      })();
      bridges.push(ready.catch(error => { bridgeErrors.push(error); socket.close(); }));
      socket.on("message", data => {
          const text = data.toString(), frame = JSON.parse(text);
          // No prompts/completions are retained by this fixture's trace.
          frames.push({ type: frame.type, background: frame.background, response_id: frame.response_id, mode: frame.mode });
          const deliver = async () => {
            const worker = await ready;
            if (completionRace && frame.type === "response.interrupt") {
              await upstream.fetch("https://fixture.example/release", { method: "POST" });
              await until(async () => (await state()).generated === 2);
            }
            worker.send(text);
          };
          bridges.push(deliver().catch(error => { bridgeErrors.push(error); socket.close(); }));
        });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: key };
    // Keep the entire installed catalogue: Codex may query fallback metadata.
    const catalog = JSON.parse(execFileSync(binary, ["debug", "models", "--bundled"], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }));
    assert.equal(catalog.models.find(entry => entry.slug === model)?.use_responses_lite, true);
    await writeFile(join(home, "models.json"), JSON.stringify(catalog));
    await writeFile(join(home, "config.toml"), `model = "${model}"
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
features.instant_interrupt = true
[model_providers.fixture]
name = "Interrupt fixture"
base_url = "${origin}/v1/native/openai/v1"
env_key = "CLAWROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
request_max_retries = 0
stream_max_retries = 0
`);
    client = nativeCodexClient(t, binary, home, env);
    await client.rpc("initialize", { clientInfo: { name: "clawrouter_interrupt_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    client.child.stdin.write('{"method":"initialized"}\n');
    const thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    const turn = await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Synthetic fixture: respond without tools." }] });
    await until(async () => (await state()).generated === 1 && output.filter(type => type === "response.created").length >= 2);
    await new Promise(resolve => setTimeout(resolve, 150));
    await client.rpc("turn/steer", { threadId: thread.thread.id, expectedTurnId: turn.turn.id, input: [{ type: "text", text: "Synthetic steering input: finish." }] });
    let completed;
    await until(() => {
      assert.deepEqual(client.errors, []); assert.deepEqual(bridgeErrors, []);
      completed = client.notifications.find(item => item.method === "turn/completed" && item.params.turn.id === turn.turn.id);
      return !!completed;
    });
    assert.equal(completed.params.turn.status, "completed", completed.params.turn.error?.message);
    assert.equal(connections, 1, "native successor uses the original socket");
    assert.equal(output.includes("error"), false);
    const observed = await state();
    assert.equal(observed.connections, 1);
    assert.equal(observed.generated, 2);
    const interrupt = frames.find(frame => frame.type === "response.interrupt");
    assert.ok(interrupt); assert.equal(interrupt.mode, "discard_partial_items");
    assert.ok(frames.every(frame => frame.background !== true));
    assert.deepEqual(observed.interrupts, [interrupt.response_id]);
    assert.equal(observed.lateInterrupt, completionRace);
    assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr()), false);
    assert.equal(client.notifications.some(item => item.method === "error"), false);
    const dispatch = path => mf.dispatchFetch(`https://router.example${path}`, { headers: { authorization: `Bearer ${key}` } }).then(response => response.json());
    let usage;
    await until(async () => { usage = await dispatch("/v1/usage"); return usage.usage?.events?.length === observed.creates; });
    assert.equal(new Set(usage.usage.events.map(event => event.request_id)).size, observed.creates);
    assert.ok(usage.usage.events.every(event => event.status === "success" && event.cost_basis === "manifest_pricing" && event.content_retained === false), JSON.stringify(usage.usage.events.map(({status, cost_basis, content_retained}) => ({status, cost_basis, content_retained}))));
    const total = usage.usage.events.reduce((sum, event) => sum + event.actual_cost_micros, 0);
    assert.equal(total, (observed.creates - 2) * 2 + 2 * 12, "default model pricing: prewarm input and two generated responses");
    assert.equal(usage.usage.summary.actualCostMicros, total);
    assert.equal(usage.budget.spentMicros, total);
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"), month = new Date().toISOString().slice(0, 7);
    for (const [name, policyId] of [["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]]) {
      const ledger = budgets.get(budgets.idFromName(name));
      const status = await (await ledger.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
      assert.equal(status.spentMicros, total);
      assert.deepEqual(await (await ledger.fetch("https://budget/fixture-unsettled")).json(), { total: observed.creates, count: 0 });
    }
    t.diagnostic(JSON.stringify({ codex: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), completionRace, connections, frames, upstream: observed, receipts: usage.usage.events.length, totalCostMicros: total }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ frames, output, bridgeErrors: bridgeErrors.map(error => error.message), notifications: client?.notifications.map(item => item.method), clientErrors: client?.errors }));
    throw error;
  } finally {
    await client?.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) { server.close(); await once(server, "close"); }
    await Promise.allSettled(bridges);
    await mf?.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("native interrupt fixture timed out");
}

function routerFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.sql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.sql.exec("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN settled = 0 THEN 1 ELSE 0 END), 0) AS count FROM budget_reservations")][0]);
    return super.fetch(request);
  }
}
export default handler;
`; }

function upstreamFixture() { return `
const state = { connections: 0, creates: 0, generated: 0, interrupts: [], lateInterrupt: false };
let release, releaseRequested = false;
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/state") return Response.json(state);
  if (path === "/release") { releaseRequested = true; return new Response("ok"); }
  if (request.headers.get("upgrade") !== "websocket") return new Response("unexpected HTTP", { status: 500 });
  state.connections++;
  const pair = new WebSocketPair(); pair[1].accept();
  let heldId, heldComplete = false;
  const send = frame => pair[1].send(JSON.stringify(frame));
  pair[1].addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === "response.interrupt") {
      state.interrupts.push(frame.response_id); state.lateInterrupt = heldComplete;
      if (frame.response_id !== heldId) throw new Error("foreign interrupt");
      send({ type: "response.interrupt.accepted", response_id: heldId }); release(); return;
    }
    if (frame.type !== "response.create") throw new Error("unexpected control");
    state.creates++;
    const warmup = frame.generate === false, index = warmup ? 0 : ++state.generated;
    const id = "resp_interrupt_" + state.creates;
    const result = { id, object: "response", model: "${model}", status: "in_progress", output: [], service_tier: "default", usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: warmup ? 0 : 1, total_tokens: warmup ? 1 : 2 } };
    send({ type: "response.created", response: result });
    const finish = () => {
      if (index > 1) {
        const item = { id: "msg_interrupt_" + state.creates, type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Synthetic fixture complete.", annotations: [] }] };
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        send({ type: "response.output_item.done", output_index: 0, item }); result.output = [item];
      }
      send({ type: "response.completed", response: { ...result, status: "completed" } });
    };
    if (index === 1) {
      heldId = id;
      const poll = setInterval(() => { if (releaseRequested) release(); }, 10);
      release = () => { if (!heldComplete) { heldComplete = true; clearInterval(poll); finish(); } };
      pair[1].addEventListener("close", () => clearInterval(poll));
    }
    else if (index > 1) setTimeout(finish, 250);
    else finish();
  });
  pair[1].addEventListener("close", () => { try { pair[1].close(); } catch {} });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };
`; }
