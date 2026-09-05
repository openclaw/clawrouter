// Controlled workerd proof with synthetic bindings and native loopback egress.
// node scripts/proof-private-affinity.mjs BASE TOOL_PREFIX OUTPUT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE TOOL_PREFIX OUTPUT");
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(out, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base = git("rev-parse", `${baseRef}^{commit}`);
const head = git("rev-parse", "HEAD");
const sourceFile = "worker/private-codex-response.ts";
const cases = ["json", "sse-top", "sse-response"].flatMap(envelope =>
  ["x-codex-turn-state", "X-Codex-Turn-State"].flatMap(key => [false, true].map(array => ({ envelope, key, array }))));
const target = "SYNTHETIC_PRIMARY_TARGET", fallback = "SYNTHETIC_FALLBACK_TARGET";
const secret = "SYNTHETIC_SUBSCRIPTION_TOKEN", account = "SYNTHETIC_ACCOUNT";
const receipt = { base, head, working_tree_dirty: Boolean(git("status", "--porcelain")),
  node: process.version, workerd: require("workerd/package.json").version, sources: {}, results: {},
  limits: "Actual private Worker with synthetic workload authentication and native HTTP upstream fixture. No live inference, production bindings, or deployment. Client-visible traces contain only statuses, shapes and route slots." };

for (const variant of ["baseline", "candidate"]) {
  const dir = path.join(out, variant);
  mkdirSync(dir);
  execFileSync("tar", ["-x", "-C", dir], { input: execFileSync("git", ["archive", variant === "baseline" ? base : head], { maxBuffer: 64 * 1024 * 1024 }) });
  if (variant === "candidate") copyFileSync(path.join(root, sourceFile), path.join(dir, sourceFile));
  receipt.sources[variant] = createHash("sha256").update(readFileSync(path.join(dir, sourceFile))).digest("hex");
  const calls = new Map();
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/backend-api/codex/responses");
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const id = Number(body.input.slice("fixture-".length));
    const scenario = cases[id]; assert.ok(scenario);
    const route = body.model === target ? 0 : body.model === fallback ? 1 : -1;
    assert.notEqual(route, -1);
    const observed = calls.get(id) ?? []; calls.set(id, observed);
    observed.push({ route, affinity: request.headers["x-codex-turn-state"], previous: body.previous_response_id });
    response.setHeader("content-type", "application/json");
    if (observed.length === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { code: "server_error", message: "Synthetic availability failure" } }));
      return;
    }
    const affinity = `fixture-affinity-${id}`;
    const headers = { [scenario.key]: scenario.array ? [affinity] : affinity };
    const result = { id: `fixture-response-${id}`, object: "response", model: body.model, status: "completed", output: [] };
    if (scenario.envelope === "json") response.end(JSON.stringify({ ...result, headers }));
    else {
      response.setHeader("content-type", "text/event-stream");
      const event = scenario.envelope === "sse-top"
        ? { type: "response.completed", response: result, headers }
        : { type: "response.completed", response: { ...result, headers } };
      response.end(`data: ${JSON.stringify(event)}\n\n`);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const credential = `private-workload-${randomBytes(32).toString("hex")}`;
  const policy = { version: 1, enabled: true, alias: { id: "internal", name: "Codex" },
    auth: { mode: "workload", credentialSha256: createHash("sha256").update(credential).digest("hex") } };
  const upstream = { version: 1, target, fallbackTarget: fallback, accountId: account, accessToken: secret, expiresAt: Date.now() + 3600000 };
  const entry = path.join(dir, "proof-worker.ts");
  writeFileSync(entry, `
import worker from "./worker/private-entry.ts";
const policy = ${JSON.stringify(JSON.stringify(policy))};
const upstream = ${JSON.stringify(JSON.stringify(upstream))};
export default { fetch(request, env, ctx) {
  return worker.fetch(request, {
    PRIVATE_CODEX_POLICY: { async get() { return policy; } },
    PRIVATE_CODEX_UPSTREAM: { async get() { return upstream; } },
  }, ctx);
} };
`);
  let mf;
  try {
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*", "cloudflare:*"] });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-08", compatibilityFlags: ["nodejs_compat"],
      outboundService: { external: { address: `127.0.0.1:${server.address().port}`, http: {} } },
    });
    const workerUrl = await mf.ready;
    receipt.results[variant] = [];
    for (const [id, scenario] of cases.entries()) {
      const send = (body = {}, headers = {}) => {
        const payload = JSON.stringify({ model: "internal", input: `fixture-${id}`, store: false, stream: scenario.envelope !== "json", ...body });
        return fetch(new URL("/private/v1/responses", workerUrl), {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)), ...headers },
        body: payload,
      });
      };
      const first = await send();
      const raw = await first.text(); contained(raw);
      const parsed = scenario.envelope === "json" ? JSON.parse(raw)
        : raw.trim().split("\n\n").flatMap(frame => frame.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))).find(event => event.type === "response.completed");
      const projected = scenario.envelope === "json" ? parsed : parsed?.response;
      const headers = scenario.envelope === "sse-top" ? parsed?.headers : projected?.headers;
      const value = headers?.[scenario.key];
      const clientStatuses = [first.status];
      let outcome = "response_rejected";
      if (value !== undefined) {
        assert.equal(Array.isArray(value), scenario.array);
        const affinity = scenario.array ? value[0] : value;
        outcome = affinity.startsWith("cr1.") ? "wrapped" : "unwrapped";
        for (const body of [{}, { previous_response_id: projected.id }]) {
          const next = await send(body, { "x-codex-turn-state": affinity });
          clientStatuses.push(next.status); contained(await next.text());
        }
      }
      const observed = calls.get(id);
      assert.ok(observed, `${variant}/${id} did not reach the fixture; HTTP ${first.status}`);
      const routes = observed.map(call => call.route);
      if (variant === "candidate" || (!scenario.array && scenario.key === "x-codex-turn-state")) {
        assert.equal(outcome, "wrapped");
        assert.deepEqual(clientStatuses, [200, 200, 200]);
        assert.deepEqual(routes, [0, 1, 1, 1]);
        assert.equal(observed[2].affinity, `fixture-affinity-${id}`);
        assert.equal(observed[3].previous, `fixture-response-${id}`);
      } else if (scenario.key === "x-codex-turn-state") assert.equal(outcome, "response_rejected");
      else {
        assert.equal(outcome, "unwrapped");
        assert.deepEqual(routes, [0, 1, 0]);
        assert.deepEqual(clientStatuses, [200, 200, 400]);
      }
      receipt.results[variant].push({ ...scenario, outcome, clientStatuses, routes });
    }
  } finally {
    try { await mf?.dispose(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
writeFileSync(path.join(out, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));

function contained(text) {
  for (const value of [target, fallback, secret, account]) assert.equal(text.includes(value), false);
}
