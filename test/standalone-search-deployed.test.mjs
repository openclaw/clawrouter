import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { deployedSearch, deployedSearchOptions } from "../scripts/smoke-codex-search-deployed.mjs";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { WebSocketServer } = require("ws");
const key = "clawrouter-live-deployed-fixture-secret", clientKey = "fixture-client-only";
const options = { key, clientKey, environment: "fakeco", searchCostMicros: 1000, maxBudgetMicros: 5_000_000, models: ["gpt-6.1-sol", "gpt-6-astra"], mode: "cached", transport: "websocket" };

async function fixture(t) {
  t.mock.method(console, "error", () => {});
  const events = [], requests = [], sockets = new Set();
  const state = { report: true, output: "Official site 【turn0search0】 OpenAI", retained: false, extraSpend: 0, limitMicros: 5_000_000, environment: "fakeco" };
  const budget = () => ({ configured: true, ledger: "durable_object", windowKey: "fixture-month", limitMicros: state.limitMicros, spentMicros: events.reduce((sum, event) => sum + event.actual_cost_micros, state.extraSpend), remainingMicros: 4_000_000 });
  const inspection = { verified: true, providers: ["openai"], budgetScope: "policy", requestCostMicros: null, requestCostsMicros: { "search.web": 1000 } };
  function record(headers, body, search) {
    assert.equal(headers.authorization, `Bearer ${key}`);
    assert.equal(headers["x-clawrouter-client"], "codex-search-smoke");
    assert.ok(headers["x-clawrouter-session-id"].startsWith("codex-search-smoke-"));
    events.push({ session_id: headers["x-clawrouter-session-id"], request_id: `fixture-${events.length}`, model: `openai/${body.model}`, provider: "openai", capability: search ? "search.web" : "llm.responses", cost_basis: search ? "policy_fixed" : "manifest_pricing", reserved_cost_micros: search ? 1000 : 500, actual_cost_micros: search ? 1000 : 500, input_tokens: search ? null : 10, content_retained: state.retained, status: "success", status_code: 200 });
  }
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url !== "/v1/health") assert.equal(req.headers.authorization, `Bearer ${key}`);
    let value;
    if (req.url === "/v1/health") value = { ok: true, environment: state.environment, observability: { requestContentRetentionDefault: false } };
    else if (req.url === "/v1/key/inspect") value = { ...inspection, budget: budget() };
    else if (req.url === "/v1/usage") value = { budget: budget(), usage: { events: state.report ? events : [], summary: { actualCostMicros: events.reduce((sum, event) => sum + event.actual_cost_micros, 0), requestCount: events.length } } };
    else if (req.url === "/v1/catalog") value = { fixtureCatalog: true };
    else {
      assert.ok(["/v1/native/openai/v1/alpha/search", "/v1/native/openai/v1/responses"].includes(req.url));
      const search = req.url.endsWith("/search"); record(req.headers, body, search);
      value = search ? { output: state.output, encrypted_output: "fixture-encrypted-output" } : { output: [] };
      res.setHeader("x-clawrouter-content-retention", state.retained ? "on" : "off");
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    sockets.add(ws); ws.on("close", () => sockets.delete(ws));
    assert.equal(req.url, "/v1/native/openai/v1/responses");
    ws.on("message", data => {
      const body = JSON.parse(data); requests.push({ path: req.url, headers: req.headers, body });
      record(req.headers, body, false);
      ws.send(JSON.stringify({ type: "response.completed", response: { id: `response-${events.length}`, status: "completed", output: [] } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const routerUrl = `http://127.0.0.1:${server.address().port}`;
  const adapter = deployedSearch({ ...options, routerUrl });
  let mf;
  t.after(async () => { adapter.close(); await mf?.dispose(); for (const ws of sockets) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { state, events, requests, inspection, adapter, async relay() {
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "router", modules: true, script: "export default { fetch(request) { return fetch(request); } };", compatibilityDate: "2026-06-05", outboundService: adapter.outbound }] }));
    await mf.ready; return mf;
  } };
}
const searchRequest = () => new Request("https://relay/v1/native/openai/v1/alpha/search", { method: "POST", headers: { authorization: `Bearer ${clientKey}` }, body: JSON.stringify({ id: "native-session", model: "gpt-6.1-sol", commands: { search_query: [{ q: "official fixture" }] }, settings: { external_web_access: false } }) });

test("deployed relay carries HTTP search and WS inference, preserves output, and reconciles remote receipts without a real key in the client", async t => {
  const f = await fixture(t); await f.adapter.preflight(); const mf = await f.relay();
  const catalog = await mf.dispatchFetch("https://relay/v1/catalog", { headers: { authorization: `Bearer ${clientKey}` } });
  assert.deepEqual(await catalog.json(), { fixtureCatalog: true });
  const request = searchRequest();
  const response = await mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { output: f.state.output, encrypted_output: "fixture-encrypted-output" });
  assert.equal(f.adapter.firstReference, "turn0search0");
  const upgrade = await mf.dispatchFetch("https://relay/v1/native/openai/v1/responses", { headers: { authorization: `Bearer ${clientKey}`, upgrade: "websocket" } });
  assert.equal(upgrade.status, 101); const socket = upgrade.webSocket; socket.accept();
  for (const model of options.models) {
    const completed = new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(event.data)), { once: true }));
    socket.send(JSON.stringify({ type: "response.create", model, input: [], max_output_tokens: 9000 }));
    assert.equal((await completed).type, "response.completed");
  }
  f.adapter.check();
  assert.deepEqual(await f.adapter.accounting(100), { receipts: 3, searches: 1, searchCostMicros: 1000, inferenceCostMicros: 1000, totalCostMicros: 2000, policyBudgetAgrees: true, providerLedgerInspected: false });
  assert.equal(f.requests.filter(req => req.body?.type === "response.create").every(req => req.body.max_output_tokens === 4096), true);
  assert.equal(f.adapter.sessions.size, 1); socket.close();
});

test("deployed preflight refuses uncapped, globally fixed-price, or wrong-target credentials before paid traffic", async t => {
  const f = await fixture(t);
  f.inspection.requestCostMicros = 1; await assert.rejects(f.adapter.preflight(), /token pricing/);
  f.inspection.requestCostMicros = null; f.inspection.budgetScope = "principal"; await assert.rejects(f.adapter.preflight(), /dedicated policy/);
  f.inspection.budgetScope = "policy"; f.state.limitMicros = null; await assert.rejects(f.adapter.preflight(), /dedicated budget/);
  f.state.limitMicros = 5_000_001; await assert.rejects(f.adapter.preflight(), /dedicated budget/);
  f.state.limitMicros = 5_000_000; f.state.environment = "production"; await assert.rejects(f.adapter.preflight(), /environment matches/);
  assert.equal(f.events.length, 0);
});

test("deployed accounting fails on missing queue receipts, retained content, and concurrent policy spend", async t => {
  const f = await fixture(t); await f.adapter.preflight(); await f.adapter.outbound(searchRequest());
  f.state.report = false; await assert.rejects(f.adapter.accounting(1), /one deployed usage receipt/);
  f.state.report = true; f.events[0].content_retained = true; await assert.rejects(f.adapter.accounting(1), /not retained/);
  f.events[0].content_retained = false; f.state.extraSpend = 1; await assert.rejects(f.adapter.accounting(1), /policy authority spend/);
});

test("deployed transport keeps HTTP-200 tool failures latched after a successful retry", async t => {
  const f = await fixture(t); await f.adapter.preflight();
  f.state.output = "Internal Error"; await assert.rejects(f.adapter.outbound(searchRequest()), /tool error/);
  f.state.output = "Successful fixture 【turn0search0】"; await f.adapter.outbound(searchRequest());
  assert.throws(() => f.adapter.check(), /tool error/);
});

test("deployed transport refuses HTTP inference fallback and bounds requests even after retries", async t => {
  const f = await fixture(t); await f.adapter.preflight();
  await assert.rejects(f.adapter.outbound(new Request("https://relay/v1/native/openai/v1/responses", { method: "POST", headers: { authorization: `Bearer ${clientKey}` }, body: JSON.stringify({ model: "gpt-6.1-sol" }) })), /cannot silently fall back/);
  for (let i = 0; i < 32; i++) await f.adapter.outbound(searchRequest());
  await assert.rejects(f.adapter.outbound(searchRequest()), /request ceiling/);
  assert.equal(f.events.length, 32);
});

test("deployed options reject unsafe URLs and require an explicit environment and bounded positive tariff", () => {
  const args = { "router-url": "https://router.example", "expected-environment": "fakeco" };
  const env = { CLAWROUTER_SMOKE_KEY: key };
  assert.equal(deployedSearchOptions(args, env).maxBudgetMicros, 5_000_000);
  for (const url of ["http://router.example", "https://user:secret@router.example", "https://router.example/v1", "https://router.example/?key=secret"]) assert.throws(() => deployedSearchOptions({ ...args, "router-url": url }, env));
  for (const patch of [{ "expected-environment": undefined }, { "search-cost-micros": 0 }, { "max-budget-micros": "9007199254740992" }]) assert.throws(() => deployedSearchOptions({ ...args, ...patch }, env));
  assert.throws(() => deployedSearchOptions(args, {}), /dedicated CLAWROUTER_SMOKE_KEY/);
});
