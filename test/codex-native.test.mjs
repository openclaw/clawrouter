import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
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
    let child;
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
      child = spawn(binary, ["app-server", "--listen", "stdio://"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-32_768); });
      const pending = new Map(), notifications = [];
      const rejectPending = (error) => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
      };
      child.once("error", () => rejectPending(new Error("native Codex failed to start")));
      child.once("exit", () => rejectPending(new Error("native Codex exited before its RPC response")));
      t.signal.addEventListener("abort", () => rejectPending(new Error("native fixture timed out")), { once: true });
      let nextId = 0;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id != null && pending.has(message.id)) {
          const { resolve, reject, timer } = pending.get(message.id);
          clearTimeout(timer);
          pending.delete(message.id);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        } else notifications.push(message);
      });
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native RPC ${method} timed out`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      await rpc("initialize", { clientInfo: { name: "clawrouter_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
      const account = await rpc("account/read", { refreshToken: false });
      assert.equal(account.requiresOpenaiAuth, mode !== "key-only");
      assert.equal(account.account?.type ?? null, mode === "key-only" ? null : "chatgpt");
      const models = await rpc("model/list", {});
      assert.ok(models.data.some((item) => item.model === model));
      const thread = await rpc("thread/start", { model, modelProvider: "fixture", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
      await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return fixture complete. Do not use tools." }], serviceTier: "priority" });
      const deadline = Date.now() + 30_000;
      while (!notifications.some((item) => item.method === "turn/completed") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const completed = notifications.find((item) => item.method === "turn/completed");
      assert.ok(completed, "native turn did not finish before its deadline");
      if (mode === "hybrid-missing-key") {
        assert.equal(requests.length, 0);
        assert.equal(completed.params.turn.status, "failed");
        assert.match(JSON.stringify(notifications), /CLAWROUTER_API_KEY/);
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
      assert.equal(/fallback model metadata|model metadata.*not found/i.test(stderr + JSON.stringify(notifications)), false, "native client used fallback model metadata");
    } finally {
      if (child?.pid && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await exited;
        clearTimeout(force);
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}
