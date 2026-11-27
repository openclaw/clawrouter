import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { checkSearchAccounting } from "../scripts/smoke-codex-search-accounting.mjs";

// Synthetic protocol regression; actual native automatic-compaction records
// remain the responsibility of the opt-in paid Codex qualification harness.
test("standalone search interleaves with WS, model switching and a compacted transcript; SQL billing stays capability-specific", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-standalone-search-")), sockets = [];
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
      export * from "./worker/index.ts";
      export class BudgetLedgerObject extends RealBudgetLedger {
        constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
        async fetch(request) {
          if (["/fixture-charges", "/fixture-search-charges"].includes(new URL(request.url).pathname)) return Response.json([...this.fixtureSql.exec("SELECT settled, reserved_micros FROM budget_reservations")]);
          return super.fetch(request);
        }
      }
      export default handler;
    `, upstreamScript, { preventEviction: true });
    const policy = { enabled: true, generation: "g1", providers: ["openai"], models: ["openai/gpt-6-astra", "openai/gpt-6.1-sol"], tenantId: "default", monthlyBudgetMicros: 1_000_000, requestCostMicros: null, requestCostsMicros: { "search.web": 1000 }, retainRequestContent: false };
    const secret = "standalone-fixture-secret", headers = { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json", "x-clawrouter-session-id": "fixture-native-session" };
    const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put("policies/fixture", JSON.stringify(policy));
    await kv.put("credentials/fixture", JSON.stringify(credential));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: 1_000_000 }));
    const origin = await mf.ready, upstream = await mf.getWorker("upstream");
    const dispatch = (path, body) => fetch(new URL(path, origin), { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000) });
    const state = async () => json(await upstream.fetch("https://fixture/state"), "upstream state");
    const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router"), owner = authority.get(authority.idFromName("policy-bindings"));
    async function putPolicy(value) {
      const response = await owner.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: value }) });
      assert.equal(response.status, 200);
    }
    async function connect() {
      const response = await mf.dispatchFetch("https://router.example/v1/native/openai/v1/responses", { headers: { ...headers, upgrade: "websocket", "session-id": "fixture-native-session", "x-openai-internal-codex-responses-lite": "true" } });
      assert.equal(response.status, 101);
      const socket = response.webSocket; socket.accept(); sockets.push(socket);
      const messages = [];
      socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
      return async body => {
        const before = messages.length;
        socket.send(JSON.stringify({ type: "response.create", service_tier: "default", max_output_tokens: 32, ...body }));
        await until(() => messages.slice(before).some(event => ["response.completed", "error"].includes(event.type)));
        const result = messages.slice(before).find(event => ["response.completed", "error"].includes(event.type));
        assert.equal(result.type, "response.completed", JSON.stringify(result));
        return result.response;
      };
    }
    const search = (model, commands) => dispatch("/v1/native/openai/v1/alpha/search", { id: "fixture-search-session", model, commands, settings: { external_web_access: false } });
    const firstSocket = await connect();
    await firstSocket({ model: "gpt-6-astra", input: "synthetic private search task" });
    const firstSearch = await search("gpt-6-astra", { search_query: [{ q: "synthetic private query" }] });
    assert.equal(firstSearch.status, 200);
    const wire = await firstSearch.text();
    assert.equal(wire, searchWire);

    // A custom Codex provider compacts through inference. Replay that boundary:
    // summary includes the old reference, then a new model/socket consumes it.
    const compact = await dispatch("/v1/native/openai/v1/responses", { model: "gpt-6-astra", service_tier: "default", max_output_tokens: 32, input: "Summarize synthetic private history; retain turn0search0" });
    assert.equal(compact.status, 200);
    const summary = (await json(compact, "compaction inference")).output[0].content[0].text;
    sockets[0].close(1000, "resume compacted session");
    const resumed = await connect();
    await resumed({ model: "gpt-6.1-sol", input: [{ role: "user", content: [{ type: "input_text", text: summary }] }] });
    for (const commands of [{ open: [{ ref_id: "turn0search0" }] }, { find: [{ ref_id: "turn0search0", pattern: "fixture" }] }]) {
      const response = await search("gpt-6.1-sol", commands);
      assert.equal(response.status, 200); assert.equal(await response.text(), searchWire);
    }
    const sent = await state();
    assert.equal(new Set(sent.searches.map(body => body.id)).size, 1);
    assert.notEqual(sent.searches[0].id, "fixture-search-session");
    assert.deepEqual(sent.searches.map(body => body.model), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol"]);
    assert.ok(sent.searches.every(body => body.settings.external_web_access === false));
    assert.match(sent.frames[1].input[0].content[0].text, /turn0search0/);

    let snapshot;
    await until(async () => {
      snapshot = await json(await dispatch("/v1/usage"), "usage");
      return snapshot.usage.events.length === 6 && snapshot.budget.spentMicros === 4_188;
    });
    const events = snapshot.usage.events;
    assert.equal(snapshot.usage.summary.actualCostMicros, 4_188);
    assert.equal(new Set(events.map(event => event.request_id)).size, 6);
    for (const event of events) {
      assert.equal(event.content_retained, false);
      assert.doesNotMatch(JSON.stringify(event), /synthetic private|fixture-upstream-key|fixture-ciphertext/);
      assert.equal(event.cost_basis, event.capability === "search.web" ? "policy_fixed" : "manifest_pricing");
      assert.equal(event.actual_cost_micros, event.capability === "search.web" ? 1000 : event.model === "openai/gpt-6-astra" ? 540 : 108);
      if (event.capability === "search.web") { assert.equal(event.reserved_cost_micros, 1000); assert.equal(event.input_tokens, null); }
    }
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    for (const name of ["default:fixture", "provider:openai"]) {
      const rows = await json(await budgets.get(budgets.idFromName(name)).fetch("https://budget/fixture-charges"), "charges");
      assert.equal(rows.length, 6); assert.ok(rows.every(row => row.settled === 1));
      assert.equal(rows.reduce((sum, row) => sum + row.reserved_micros, 0), 4_188);
      assert.equal(rows.filter(row => row.reserved_micros === 1000).length, 3);
    }
    assert.deepEqual(await checkSearchAccounting(mf, headers.authorization.slice(7), [{}, {}, {}, ...sent.searches.map(() => ({ commands: ["fixture"] }))]), { receipts: 6, searches: 3, searchCostMicros: 3000, inferenceCostMicros: 1188, totalCostMicros: 4188, policyAndProviderLedgersAgree: true });
    await putPolicy({ ...policy, monthlyBudgetMicros: 4_188 });
    const denied = await search("gpt-6.1-sol", { open: [{ ref_id: "turn0search0" }] });
    assert.equal(denied.status, 402); assert.equal((await denied.json()).error.code, "budget_exhausted");
    assert.equal((await state()).searches.length, 3, "exhausted search cannot reach upstream");
  } finally {
    for (const socket of sockets) try { socket.close(1000, "fixture complete"); } catch {}
    await mf?.dispose(); await rm(temporary, { recursive: true, force: true });
  }
});

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("standalone search fixture timed out");
}
async function json(response, label) {
  const text = await response.text();
  assert.ok(text, `${label} returns JSON (status ${response.status}, headers ${JSON.stringify(Object.fromEntries(response.headers))})`);
  return JSON.parse(text);
}
const searchWire = '{ "encrypted_output": "fixture-ciphertext", "output": "fixture text 【turn0search0】", "future": {"keep":true} }\n';
const upstreamScript = `
const frames = [], searches = [];
const wire = ${JSON.stringify(searchWire)};
const response = () => ({ id: "resp_fixture_" + frames.length, object: "response", status: "completed", service_tier: "default", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Compacted synthetic private history: retain turn0search0" }] }], usage: { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/state") return Response.json({ frames, searches });
  if (request.headers.get("authorization") !== "Bearer fixture-upstream-key") throw new Error("unexpected fixture authorization");
  if (path === "/v1/alpha/search") {
    if (request.method !== "POST") throw new Error("unexpected search method");
    searches.push(await request.json());
    return new Response(wire, { headers: { "content-type": "application/json" } });
  }
  if (path !== "/v1/responses") throw new Error("unexpected fixture endpoint");
  if (request.headers.get("upgrade") !== "websocket") { await request.json(); return Response.json({ ...response(), id: "resp_http_fixture" }); }
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data); frames.push(frame);
    pair[1].send(JSON.stringify({ type: "response.created", response: { id: "resp_fixture_" + frames.length, status: "in_progress" } }));
    pair[1].send(JSON.stringify({ type: "response.completed", response: response() }));
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };`;
