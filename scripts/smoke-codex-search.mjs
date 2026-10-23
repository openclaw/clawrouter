import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageCodex } from "./codex-connect.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs [--model UPSTREAM_SLUG]\nRequires injected OPENAI_API_KEY; defaults to gpt-6-astra. Each invocation makes at most 16 upstream requests with at most 4096 output tokens each.");
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== "--model" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(args[1]))) throw new Error("use --model UPSTREAM_SLUG or --help");
const model = args[1] ?? "gpt-6-astra";
// Explicit live qualification only. Credential remains in this process's memory;
// neither the Worker fixture nor Codex receives the real upstream credential.
if (process.env.CLAWROUTER_SEARCH_LIVE !== "1") throw new Error("set CLAWROUTER_SEARCH_LIVE=1 to authorize bounded live OpenAI inference/search requests");
const upstreamKey = process.env.OPENAI_API_KEY;
if (!upstreamKey?.trim()) throw new Error("inject OPENAI_API_KEY through the credential helper");
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "clawrouter-search-live-")), home = join(temporary, "codex");
const key = "clawrouter-live-fixture-search-fixture-secret";
const digest = value => createHash("sha256").update(value).digest("hex");
const calls = [], sessions = new Set(), events = [];
let mf, firstReference, searchNamespace, attempts = 0;
const codex = process.env.CLAWROUTER_CODEX_BIN ?? "codex";
const clientEnv = { PATH: process.env.PATH, HOME: temporary, CODEX_HOME: home, CLAWROUTER_API_KEY: key };
async function boundedText(response, limit = 2 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error("live fixture response limit exceeded"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
async function outbound(request) {
  const url = new URL(request.url);
  assert.equal(url.origin, "https://api.openai.com");
  assert.ok(["/v1/responses", "/v1/alpha/search"].includes(url.pathname));
  assert.equal(request.method, "POST");
  assert.ok(++attempts <= 16, "live qualification request ceiling");
  const body = JSON.parse(await boundedText(request));
  assert.equal(body.model, model, "upstream request uses the selected qualification model");
  const search = url.pathname.endsWith("/search");
  const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${upstreamKey}`);
  headers.delete("content-length"); headers.delete("host");
  if (search) { sessions.add(body.id); searchNamespace ??= digest(body.id); }
  body.max_output_tokens = Math.min(body.max_output_tokens ?? 4096, 4096);
  const entry = { model, path: url.pathname, ...(search ? { commands: Object.keys(body.commands ?? {}).filter(name => name !== "response_length"), opensOriginalReference: !!firstReference && !!body.commands?.open?.some(operation => operation.ref_id === firstReference) } : {}), status: null };
  calls.push(entry);
  let response;
  try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(90000) }); }
  catch (error) { entry.failure = error.name; entry.cause = error.cause?.code ?? null; throw new Error("live upstream transport failed"); }
  entry.status = response.status;
  console.error(JSON.stringify({ phase: "upstream", ...entry }));
  const responseHeaders = new Headers(response.headers); responseHeaders.delete("content-length"); responseHeaders.delete("content-encoding");
  if (!search) return new Response(response.body, { status: response.status, headers: responseHeaders });
  const text = await boundedText(response);
  if (response.ok) {
    const output = JSON.parse(text).output;
    assert.ok(typeof output === "string" && output.length, "search returns text output");
    assert.ok(!/invalid ref(?:erence|_id)|unable to resolve (?:open|find|click) call/i.test(output), "search output has no reference/tool error");
    firstReference ??= output.match(/turn\d+search\d+/)?.[0];
  }
  return new Response(text, { status: response.status, headers: responseHeaders });
}
async function run(args) {
  const child = spawn(codex, ["--profile", "search", "-c", "features.plugins=false", "-c", "model_reasoning_effort=\"low\"", ...args], { cwd: temporary, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderrBytes = 0, forceKill;
  const stop = () => { child.kill("SIGTERM"); forceKill ??= setTimeout(() => child.kill("SIGKILL"), 2000); };
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) stop(); });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
  const timeout = setTimeout(stop, 180000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", () => reject(new Error("native Codex launch failed"))); child.once("exit", resolve); });
    assert.equal(code, 0, `native Codex exited ${code}; suppressed stderr bytes=${stderrBytes}`);
    const parsed = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    events.push(...parsed);
    return parsed;
  } finally { clearTimeout(timeout); clearTimeout(forceKill); if (child.exitCode === null) child.kill("SIGKILL"); }
}
try {
  await mkdir(home);
  const bundle = await build({ stdin: { contents: 'export {default,PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from "./worker/index.ts";', resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, host: "127.0.0.1", port: 0, workers: [{ name: "router", modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"], bindings: { OPENAI_API_KEY: "fixture-upstream-only" }, kvNamespaces: ["POLICY_KV"],
    durableObjects: Object.fromEntries([["ACCESS_CONTROL", "PolicyBindingIndexObject"], ["BUDGET_LEDGER", "BudgetLedgerObject"], ["USAGE_LEDGER", "UsageLedgerObject"], ["GRANT_CREDENTIALS", "GrantCredentialObject"]].map(([name,className]) => [name,{className,useSQLite:true,unsafePreventEviction:true}])),
    outboundService: outbound,
  }] }));
  const base = (await mf.ready).origin, kv = await mf.getKVNamespace("POLICY_KV", "router");
  console.error(JSON.stringify({ phase: "worker-ready" }));
  await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], models: [`openai/${model}`], tenantId: "default", monthlyBudgetMicros: 100000, requestCostMicros: 1000, retainRequestContent: false }));
  await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: digest("search-fixture-secret"), policyId: "fixture", policyGeneration: "g1" }));
  await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: 100000 }));
  await manageCodex(["connect", "--profile", "search", "--router-url", base, "--provider", "openai", "--model", model, "--web-search", "live", "--codex-home", home, "--codex", codex], clientEnv);
  const { producer } = await manageCodex(["verify", "--profile", "search", "--codex-home", home, "--codex", codex], clientEnv);
  console.error(JSON.stringify({ phase: "profile-ready", model, producer }));
  const first = await run(["exec", "--json", "--skip-git-repo-check", "Use web.run to search for the official OpenAI homepage, open a returned search reference, then find the word OpenAI in the opened page. Perform each operation, then answer one sentence with a source link. Use only web.run; do not run local commands."]);
  const threadId = first.find(event => event.type === "thread.started")?.thread_id;
  assert.ok(threadId && firstReference, "native session and upstream search reference");
  const commands = calls.flatMap(call => call.commands ?? []);
  for (const name of ["search_query", "open", "find"]) assert.ok(commands.includes(name), `missing native ${name}`);
  const answer = first.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => event.item.text).join("\n");
  assert.ok(/https:\/\/(?:www\.)?openai\.com|cite|\]\(https:\/\//.test(answer), "native answer includes a source link or citation");
  const count = calls.length;
  await run(["exec", "resume", "--json", "--skip-git-repo-check", threadId, `Use web.run to open ${firstReference} from the prior search, then give its source URL in one sentence. Do not run local commands.`]);
  assert.ok(calls.slice(count).some(call => call.opensOriginalReference), "native resume opens the original reference");
  assert.equal(sessions.size, 1, "search namespace survives native resume");
  assert.ok(calls.every(call => call.status === 200), "upstream requests succeed");
  console.log(JSON.stringify({ qualified: true, model, producer, calls, resumed: true, searchNamespaces: sessions.size, searchNamespaceSha256: searchNamespace, nativeWebSearchItems: events.filter(event => event.type === "item.completed" && /web.*search/i.test(event.item?.type ?? "")).length, citedAnswer: true }));
} catch (error) {
  // Never print raw model output, credentialed transport diagnostics, or secrets.
  console.error(JSON.stringify({ qualified: false, model, category: error.name, check: error instanceof assert.AssertionError ? error.message.split("\n")[0] : "runtime_failure", calls }));
  process.exitCode = 1;
} finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
