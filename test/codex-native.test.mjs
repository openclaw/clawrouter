import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeCodexClient } from "./helpers/native-codex.mjs";
import { buildCodexCatalog } from "../scripts/codex-catalog.mjs";

const { providerById } = await import("../worker/providers.ts");
const { catalogModels } = await import("../worker/discovery.ts");

// Opt-in proof uses installed official binaries; normal CI needs no Codex account.
const binary = process.env.CLAWROUTER_CODEX_BINARY;
const producer = process.env.CLAWROUTER_CODEX_CATALOG_BINARY ?? binary;
const routerKey = "synthetic-router-key";
const model = "gpt-6-astra";

for (const mode of ["key-only", "hybrid", "hybrid-missing-key"]) {
  test(`native Codex ${mode}: official metadata and provider-scoped Fast auth`, { skip: !binary, timeout: 60_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-codex-native-"));
    const requests = [];
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      if (request.url !== "/v1/native/openai/v1/responses") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":{"message":"fixture route not found"}}');
        return;
      }
      const body = JSON.parse(text);
      requests.push({ body, authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"], lite: request.headers["x-openai-internal-codex-responses-lite"] });
      const message = { id: "fixture_message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture complete", annotations: [] }] };
      const result = { id: "fixture_response", object: "response", status: "completed", model, service_tier: "priority", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let client;
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn" };
      if (mode !== "hybrid-missing-key") env.CLAWROUTER_API_KEY = routerKey;
      const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }));
      const provider = providerById("openai");
      const endpoints = provider.endpoints.map((endpoint) => endpoint.id);
      const routes = provider.endpoints.filter((endpoint) => endpoint.native_proxy).map((endpoint) => ({ path: endpoint.path, methods: endpoint.methods, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming }));
      const catalog = buildCodexCatalog({ providers: [{ id: provider.id, allowed: true, executable: true, nativeBaseUrl: "/v1/native/openai", routes, models: catalogModels(provider, endpoints, null) }] }, bundled, provider.id).catalog;
      for (const slug of [model, "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) assert.ok(catalog.models.some((entry) => entry.slug === slug), `compiled native catalog must include ${slug}`);
      await writeFile(join(home, "models.json"), JSON.stringify(catalog));
      await writeFile(join(home, "config.toml"), `model = "${model}"\nmodel_provider = "fixture"\nmodel_catalog_json = ${JSON.stringify(join(home, "models.json"))}\nservice_tier = "priority"\nweb_search = "disabled"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "file"\nchatgpt_base_url = "${origin}/control"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${origin}/v1/native/openai/v1"\nenv_key = "CLAWROUTER_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = ${mode !== "key-only"}\nsupports_websockets = false\n`);
      if (mode !== "key-only") {
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const idToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({ email: "fixture@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user" } })}.fixture`;
        await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: idToken, access_token: "synthetic-chatgpt-token", refresh_token: "synthetic-refresh-token", account_id: "fixture-account" }, last_refresh: "2099-01-01T00:00:00Z" }));
      }
      client = nativeCodexClient(t, binary, home, env);
      await client.rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      client.child.stdin.write('{"method":"initialized"}\n');
      const account = await client.rpc("account/read", { refreshToken: false });
      assert.equal(account.requiresOpenaiAuth, mode !== "key-only");
      assert.equal(account.account?.type ?? null, mode === "key-only" ? null : "chatgpt");
      const models = await client.rpc("model/list", {});
      assert.ok(models.data.some((item) => item.model === model));
      const thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
      await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return fixture complete. Do not use tools." }], serviceTier: "priority" });
      const deadline = Date.now() + 30_000;
      while (!client.notifications.some((item) => item.method === "turn/completed") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const completed = client.notifications.find((item) => item.method === "turn/completed");
      assert.ok(completed, "native turn did not finish before its deadline");
      if (mode === "hybrid-missing-key") {
        assert.equal(requests.length, 0);
        assert.equal(completed.params.turn.status, "failed");
        assert.match(JSON.stringify(client.notifications), /CLAWROUTER_API_KEY/);
      } else {
        assert.equal(completed.params.turn.status, "completed");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].authorization, `Bearer ${routerKey}`);
        assert.equal(requests[0].account, undefined);
        assert.equal(requests[0].body.model, model);
        assert.equal(requests[0].body.service_tier, "priority");
        assert.equal(requests[0].lite, "true");
        assert.equal(requests[0].body.tools, undefined);
        assert.equal(requests[0].body.instructions, undefined);
        assert.equal(requests[0].body.input[0].type, "additional_tools");
      }
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false, "native client used fallback model metadata");
    } finally {
      await client?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}

for (const decision of ["allow", "deny"]) {
  test(`native Guardian ${decision}: review decides the isolated MCP call`, { skip: !binary, timeout: 60_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-guardian-native-"));
    const requests = [], unexpected = [];
    let calls = 0, parentRequests = 0, client;
    const assessment = { risk_level: decision === "allow" ? "low" : "high", user_authorization: decision === "allow" ? "high" : "unknown", outcome: decision, rationale: `Synthetic fixture ${decision}s this echo.` };
    const callId = "guardian-fixture-action";
    const server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
        let text = "";
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        if (request.url === "/mcp") {
          if (body.id == null) { response.writeHead(202); response.end(); return; }
          let result;
          if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "guardian-fixture", version: "1.0.0" } };
          else if (body.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo a message.", inputSchema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
          else if (body.method === "tools/call") {
            assert.equal(body.params.name, "echo");
            assert.deepEqual(body.params.arguments, { message: "fixture" });
            calls++;
            result = { content: [{ type: "text", text: "echo: fixture" }], isError: false };
          } else throw new Error(`unexpected MCP method ${body.method}`);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
          return;
        }
        assert.equal(request.url, "/v1/native/openai/v1/responses");
        const reviewer = body.client_metadata?.["x-openai-subagent"] === "guardian";
        if (!reviewer) assert.equal(body.model, model, "ordinary MCP fixture must not introduce classifier traffic");
        requests.push({ body, reviewer, path: request.url, authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"] });
        assert.ok(requests.length <= 6, "unexpected repeated native inference");
        const message = (text) => ({ id: `fixture_message_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
        const output = reviewer ? [message(JSON.stringify(assessment))]
          : parentRequests++ === 0 ? [{ type: "function_call", call_id: callId, namespace: "mcp__guardian_fixture", name: "echo", arguments: JSON.stringify({ message: "fixture" }) }]
          : [message("fixture complete")];
        const result = { id: `fixture_response_${requests.length}`, object: "response", status: "completed", model: body.model, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const events = [{ type: "response.created", response: { ...result, status: "in_progress", output: [] } }];
        events.push({ type: "response.output_item.done", output_index: 0, item: output[0] }, { type: "response.completed", response: result });
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) {
        unexpected.push(error.message);
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":{"message":"fixture contract mismatch"}}');
      }
    });
    server.on("upgrade", (request, socket) => {
      unexpected.push(`unexpected native WebSocket route ${request.url}`);
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "warn", CLAWROUTER_API_KEY: routerKey };
      const bundled = JSON.parse(execFileSync(producer, ["debug", "models", "--bundled"], { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }));
      const provider = providerById("openai"), endpoints = provider.endpoints.map(({ id }) => id);
      const routes = provider.endpoints.filter(({ native_proxy }) => native_proxy).map(endpoint => ({ path: endpoint.path, methods: endpoint.methods, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming }));
      const catalog = buildCodexCatalog({ providers: [{ id: provider.id, allowed: true, executable: true, nativeBaseUrl: "/v1/native/openai", routes, models: catalogModels(provider, endpoints, null) }] }, bundled, provider.id).catalog;
      await writeFile(join(home, "models.json"), JSON.stringify(catalog));
      await writeFile(join(home, "config.toml"), `model = "${model}"
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
web_search = "disabled"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
chatgpt_base_url = "${origin}/control"
[model_providers.fixture]
name = "Fixture"
base_url = "${origin}/v1/native/openai/v1"
env_key = "CLAWROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[features]
guardian_approval = true
[mcp_servers.guardian_fixture]
url = "${origin}/mcp"
default_tools_approval_mode = "prompt"
`);
      client = nativeCodexClient(t, binary, home, env);
      await client.rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      client.child.stdin.write('{"method":"initialized"}\n');
      const thread = await client.rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "read-only" });
      assert.equal(thread.approvalsReviewer, "auto_review");
      const turn = await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Run the synthetic fixture echo once." }], approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
      const deadline = Date.now() + 30_000;
      while (!client.notifications.some(({ method }) => method === "turn/completed") && !client.errors.length && !unexpected.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.deepEqual(unexpected, []);
      assert.deepEqual(client.errors, []);
      const completed = client.notifications.find(({ method }) => method === "turn/completed");
      assert.ok(completed, "native Guardian turn did not complete");
      assert.equal(completed.params.turn.status, "completed");
      assert.equal(completed.params.threadId, thread.thread.id);
      assert.equal(completed.params.turn.id, turn.turn.id);
      const starts = client.notifications.filter(({ method }) => method === "item/autoApprovalReview/started");
      const reviews = client.notifications.filter(({ method }) => method === "item/autoApprovalReview/completed");
      assert.equal(starts.length, 1);
      assert.equal(reviews.length, 1);
      const review = reviews[0].params;
      assert.equal(review.threadId, thread.thread.id);
      assert.equal(review.turnId, turn.turn.id);
      assert.equal(review.targetItemId, callId);
      assert.equal(review.reviewId, starts[0].params.reviewId);
      assert.equal(starts[0].params.threadId, thread.thread.id);
      assert.equal(starts[0].params.turnId, turn.turn.id);
      assert.equal(review.decisionSource, "agent");
      assert.equal(review.action.type, "mcpToolCall");
      assert.equal(review.action.server, "guardian_fixture");
      assert.equal(review.action.toolName, "echo");
      assert.equal(review.review.status, decision === "allow" ? "approved" : "denied");
      assert.equal(review.review.riskLevel, assessment.risk_level);
      assert.equal(review.review.userAuthorization, assessment.user_authorization);
      assert.equal(review.review.rationale, assessment.rationale);
      assert.equal(calls, decision === "allow" ? 1 : 0);
      const reviewers = requests.filter(({ reviewer }) => reviewer);
      assert.equal(reviewers.length, 1);
      assert.equal(parentRequests, 2);
      assert.ok(requests.every(({ body, authorization, account }) => catalog.models.some(({ slug }) => slug === body.model) && authorization === `Bearer ${routerKey}` && account === undefined));
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(client.stderr() + JSON.stringify(client.notifications)), false);
      t.diagnostic(`review model=${reviewers[0].body.model}; classifier requests=0 (path unqualified); decision=${review.review.status}; tool calls=${calls}`);
    } finally {
      await client?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}
