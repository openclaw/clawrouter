import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexCatalog } from "../scripts/codex-catalog.mjs";
import { nativeCodexClient } from "./helpers/native-codex.mjs";

const binary = process.env.CLAWROUTER_CODEX_BINARY;
const producer = process.env.CLAWROUTER_CODEX_CATALOG_BINARY ?? binary;
const model = "gpt-6-astra";
const secret = "native-router-fixture-secret";
const key = `clawrouter-live-fixture-${secret}`;
const limit = 100_000_000;

for (const transport of ["http", "websocket"]) {
  test(`native Codex through workerd: ${transport}, tool continuation, two turns and revocation`, { skip: !binary, timeout: 90_000 }, async (t) => {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const home = await mkdtemp(join(tmpdir(), "clawrouter-native-router-"));
    let mf, client;
    try {
      mf = await startWorkerdFixture(home, routerFixture(), upstreamFixture());
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false };
      const credential = { enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" };
      await kv.put("policies/fixture", JSON.stringify(policy));
      await kv.put("credentials/fixture", JSON.stringify(credential));
      await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
      const origin = await mf.ready;
      const dispatch = (path) => fetch(new URL(path, origin), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      const discovered = await dispatch("/v1/catalog");
      assert.equal(discovered.status, 200);
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: key };
      const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
      // Export the actual credential's discovery projection, never an admin union.
      const exported = buildCodexCatalog(await discovered.json(), bundled, "openai");
      assert.ok(exported.catalog.models.some(({ slug }) => slug === model));
      await writeFile(join(home, "models.json"), JSON.stringify(exported.catalog));
      await writeFile(join(home, "config.toml"), `model = "${model}"
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
service_tier = "priority"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
chatgpt_base_url = "${new URL("/control", origin)}"
[model_providers.fixture]
name = "Fixture"
base_url = "${new URL(exported.nativeBasePath, origin)}"
env_key = "CLAWROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = ${transport === "websocket"}
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 10000
`);
      const toolCalls = [];
      client = nativeCodexClient(t, binary, home, env, (request) => {
        assert.equal(request.method, "item/tool/call");
        assert.equal(request.params.tool, "fixture_echo");
        assert.deepEqual(request.params.arguments, { message: "fixture" });
        toolCalls.push(request.params);
        return { success: true, contentItems: [{ type: "inputText", text: "fixture tool result" }] };
      });
      await client.rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      client.child.stdin.write('{"method":"initialized"}\n');
      assert.equal((await client.rpc("account/read", { refreshToken: false })).requiresOpenaiAuth, false);
      assert.ok((await client.rpc("model/list", {})).data.some((item) => item.model === model));
      const thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", dynamicTools: [{ type: "function", name: "fixture_echo", description: "Echo synthetic fixture text.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } }] });
      async function turn(text) {
        const started = await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text }], serviceTier: "priority" });
        let completed;
        await until(() => {
          assert.deepEqual(client.errors, []);
          completed = client.notifications.find(({ method, params }) => method === "turn/completed" && params.turn.id === started.turn.id);
          return !!completed;
        });
        return completed.params.turn;
      }
      for (const input of ["Call fixture_echo once with message fixture.", "Return fixture complete for the second turn."]) {
        const completed = await turn(input);
        assert.equal(completed.status, "completed", completed.error?.message?.replaceAll(key, "[fixture credential]"));
      }
      assert.equal(toolCalls.length, 1);
      const upstream = await mf.getWorker("upstream");
      const state = () => upstream.fetch("https://fixture.example/state").then((response) => response.json());
      const before = await state();
      const generated = before.requests.filter(({ body }) => body.generate !== false);
      assert.equal(generated.length, 3, "one tool call, its continuation, and a second user turn");
      assert.ok(before.requests.every(({ transport: actual, authorized, lite, body }) => actual === transport && authorized && body.model === model && body.service_tier === "priority" &&
        (transport === "http" ? lite : body.client_metadata?.ws_request_header_x_openai_internal_codex_responses_lite === "true")));
      assert.ok(generated[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "fixture_call" && JSON.stringify(item.output).includes("fixture tool result")));
      if (transport === "websocket") {
        assert.equal(before.connections, 1, "both turns reuse the native WebSocket");
        assert.equal(generated[1].body.previous_response_id, generated[0].responseId);
      }
      let usage;
      await until(async () => {
        usage = await (await dispatch("/v1/usage")).json();
        return usage.usage?.events?.length === before.requests.length;
      });
      const receipts = usage.usage.events;
      assert.equal(new Set(receipts.map(({ request_id }) => request_id)).size, before.requests.length);
      assert.ok(receipts.every((receipt) => receipt.status === "success" && receipt.content_retained === false && receipt.requested_service_tier === "priority" && receipt.served_service_tier === "priority" && receipt.cost_basis === "manifest_pricing"));
      const expected = before.requests.reduce((cost, { body }) => cost + (body.generate === false ? 60 : 1_080), 0);
      assert.equal(usage.usage.summary.actualCostMicros, expected);
      assert.equal(usage.budget.spentMicros, expected);
      const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
      async function ledgerFacts() {
        return Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
          const stub = budgets.get(budgets.idFromName(name));
          const month = new Date().toISOString().slice(0, 7);
          const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
          const unsettled = await (await stub.fetch("https://budget/fixture-unsettled")).json();
          return { spent: status.spentMicros, unsettled: unsettled.count };
        }));
      }
      assert.deepEqual(await ledgerFacts(), [{ spent: expected, unsettled: 0 }, { spent: expected, unsettled: 0 }]);
      const authority = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
      const revoked = await authority.get(authority.idFromName("policy-bindings")).fetch("https://authority/credentials/put", { method: "POST", body: JSON.stringify({ credentialId: "fixture", credential: { ...credential, enabled: false } }) });
      assert.equal(revoked.status, 200);
      const rejected = await turn("This revoked turn must not reach upstream.");
      assert.equal(rejected.status, "failed");
      assert.match(JSON.stringify(rejected), /proxy_key_revoked|proxy key is revoked/);
      assert.equal((await state()).requests.length, before.requests.length);
      assert.deepEqual(await ledgerFacts(), [{ spent: expected, unsettled: 0 }, { spent: expected, unsettled: 0 }]);
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false);
    } finally {
      await client?.close();
      await mf?.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
}

async function until(predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native router fixture timed out");
}

function routerFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-unsettled") return Response.json([...this.fixtureSql.exec("SELECT COUNT(*) AS count FROM budget_reservations WHERE settled = 0")][0]);
    return super.fetch(request);
  }
}
export default handler;
`; }

function upstreamFixture() { return `
const requests = []; let connections = 0, generated = 0;
function respond(body, request, transport) {
  const responseId = 'fixture_response_' + (requests.length + 1);
  requests.push({ body, responseId, transport, authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key', lite: request.headers.get('x-openai-internal-codex-responses-lite') === 'true' });
  const warmup = body.generate === false;
  const output = warmup ? [] : generated++ === 0
    ? [{ id: 'fixture_fc', type: 'function_call', call_id: 'fixture_call', name: 'fixture_echo', arguments: '{"message":"fixture"}' }]
    : [{ id: 'fixture_message_' + generated, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] }];
  const result = { id: responseId, object: 'response', status: 'completed', model: body.model, output, service_tier: 'priority', usage: { input_tokens: warmup ? 3 : 14, output_tokens: warmup ? 0 : 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  return [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }, ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), { type: 'response.completed', response: result }];
}
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/state') return Response.json({ requests, connections });
  if (request.url !== 'https://api.openai.com/v1/responses') return new Response('unexpected upstream route', { status: 400 });
  if (request.headers.get('upgrade') === 'websocket') {
    connections++;
    const pair = new WebSocketPair(); pair[1].accept();
    pair[1].addEventListener('message', ({ data }) => {
      const body = JSON.parse(data);
      for (const event of respond(body, request, 'websocket')) pair[1].send(JSON.stringify({ ...event, ...(body.stream_id ? { stream_id: body.stream_id } : {}) }));
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  if (request.method !== 'POST') return new Response('unexpected upstream method', { status: 405 });
  const events = respond(await request.json(), request, 'http');
  return new Response(events.map(event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
} };
`; }
