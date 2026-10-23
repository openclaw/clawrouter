import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli-args.mjs";
import { startSearchOrigin } from "./smoke-codex-search-origin.mjs";
import { startHostedSearchOrigin } from "./search-semantics-fixture.mjs";
import { liveUpstream } from "./smoke-codex-search-upstream.mjs";
import { checkSearchAccounting } from "./smoke-codex-search-accounting.mjs";
import { deployedSearch, deployedSearchOptions } from "./smoke-codex-search-deployed.mjs";
import { manageCodex } from "./codex-connect.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs [--model SLUG] [--switch-model SLUG] [--web-search live|cached] [--transport http|websocket] [--compact] [--origin-check] [--origin-only] [--direct-replay] [--hosted-origin]\nLocal fixture requires injected OPENAI_API_KEY. Deployed mode: --router-url ORIGIN --expected-environment NAME, injected CLAWROUTER_SMOKE_KEY; optional --search-cost-micros (default 1000), --max-budget-micros (default 5000000). Deployed origin checks require --origin-only --hosted-origin and SEARCH_SEMANTICS_CONTROL_TOKEN; no direct replay. Hosted runs create/delete synthetic fixture data. At most 32 routed operations, at most 4096 output tokens per inference. Defaults: gpt-6-astra, live, HTTP.");
  process.exit(0);
}
for (const name of Object.keys(args)) assert.ok(["model", "switch-model", "web-search", "transport", "compact", "origin-check", "origin-only", "direct-replay", "hosted-origin", "router-url", "expected-environment", "search-cost-micros", "max-budget-micros"].includes(name), "unknown qualification option");
for (const name of ["compact", "origin-check", "origin-only", "direct-replay", "hosted-origin"]) assert.ok(args[name] === undefined || args[name] === true, "qualification flags do not accept values");
assert.ok(!args["hosted-origin"] || args["origin-only"] && !args["direct-replay"], "hosted origin requires --origin-only without direct replay");
assert.ok(!args["direct-replay"] || args["origin-only"], "direct replay requires --origin-only");
const model = args.model ?? "gpt-6-astra", switchedModel = args["switch-model"] ?? model, mode = args["web-search"] ?? "live", transport = args.transport ?? "http";
assert.ok([model, switchedModel].every(value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)));
assert.ok(["live", "cached"].includes(mode)); assert.ok(["http", "websocket"].includes(transport));
// Explicit live qualification only. Credential remains in this process's memory;
// neither the Worker fixture nor Codex receives the real upstream credential.
if (process.env.CLAWROUTER_SEARCH_LIVE !== "1") throw new Error("set CLAWROUTER_SEARCH_LIVE=1 to authorize bounded live OpenAI inference/search requests");
const upstreamKey = process.env.OPENAI_API_KEY;
const deployedOptions = args["router-url"] === undefined ? null : deployedSearchOptions(args);
if (deployedOptions) {
  assert.ok(!args["direct-replay"] && !args["origin-check"] && (!args["origin-only"] || args["hosted-origin"]), "deployed origin checks require the hosted fixture and exclude replay");
  if (args["hosted-origin"]) assert.equal(deployedOptions.routerUrl, "https://clawrouter-fakeco.openclaw.ai", "hosted origin deployed target is FakeCo");
}
else {
  assert.ok(["expected-environment", "search-cost-micros", "max-budget-micros"].every(name => args[name] === undefined), "deployed options require --router-url");
  if (!upstreamKey?.trim()) throw new Error("inject OPENAI_API_KEY through the credential helper");
}
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "clawrouter-search-live-")), home = join(temporary, "codex");
const clientSecret = randomUUID(), key = `clawrouter-live-fixture-${clientSecret}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const probeState = { replay: !!args["direct-replay"] }, events = [], models = [...new Set([model, switchedModel])];
const upstream = deployedOptions ? deployedSearch({ ...deployedOptions, models, mode, transport, clientKey: key, probe: probeState }) : liveUpstream({ probe: probeState, key: upstreamKey, models, mode, transport });
const { calls, sessions } = upstream;
let mf, origin, originCheck = null, compactionEvidence = null, qualification;
const codex = process.env.CLAWROUTER_CODEX_BIN ?? "codex";
const clientEnv = { PATH: process.env.PATH, HOME: temporary, CODEX_HOME: home, CLAWROUTER_API_KEY: key };
async function run(args) {
  const child = spawn(codex, ["--profile", "search", "-c", "features.plugins=false", "-c", "model_reasoning_effort=\"low\"", ...(transport === "http" ? ["-c", "model_providers.clawrouter_search.supports_websockets=false"] : []), ...args], { cwd: temporary, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] });
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
async function checkOrigin(threadId) {
  origin = args["hosted-origin"] ? await startHostedSearchOrigin(mode, { token: process.env.SEARCH_SEMANTICS_CONTROL_TOKEN }) : await startSearchOrigin(temporary); Object.assign(probeState, origin);
  const before = calls.length;
  await run(["exec", ...(threadId ? ["resume"] : []), "--model", switchedModel, "--json", "--skip-git-repo-check", ...(threadId ? [threadId] : []), `Use web.run to open this controlled synthetic page: ${origin.url} . Find the word ClawRouterProbe on that page and report the full generated marker shown there. Do not run local commands. Report whether it was found, with a source URL.`]);
  const probeCalls = calls.slice(before).filter(call => call.commands);
  assert.ok(probeCalls.some(call => call.opensControlledOrigin), "native CLI opened the controlled origin");
  const result = { nativeOpen: true, externalWebAccess: mode === "live", originRequests: await origin.count(), robotsRequests: origin.robots(), contentReturned: probeCalls.some(call => call.probeContentReturned), fetchError: probeCalls.some(call => call.probeFetchError) };
  result.retrieved = result.originRequests > 0 && result.contentReturned;
  if (args["hosted-origin"]) {
    const counters = await origin.observations();
    result.originRequests = counters.requests;
    result.retrieved = counters.gets > 0 && result.contentReturned && !result.fetchError && !probeCalls.some(call => call.probeInternalError);
    result.semantics = mode === "cached" ? counters.requests > 0 || result.contentReturned ? "violation" : "inconclusive" : result.retrieved ? "observed" : "inconclusive";
  }
  if (args["direct-replay"]) {
    const beforeReplay = origin.count();
    result.directReplay = await upstream.replayOrigin();
    result.directReplayOriginRequests = origin.count() - beforeReplay;
  }
  console.error(JSON.stringify({ phase: "origin-checked", ...result }));
  return result;
}

try {
  await mkdir(home);
  if (deployedOptions) {
    console.error(JSON.stringify({ phase: "deployed-preflight", ...await upstream.preflight() }));
    mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, host: "127.0.0.1", port: 0, workers: [{ name: "router", modules: true,
      script: "export default { fetch(request) { return fetch(request); } };", compatibilityDate: "2026-06-05", outboundService: upstream.outbound }] }));
  } else {
  const bundle = await build({ stdin: { contents: `
    export {default,PolicyBindingIndexObject,UsageLedgerObject,GrantCredentialObject} from "./worker/index.ts";
    import { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
    export class BudgetLedgerObject extends RealBudgetLedger {
      constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
      async fetch(request) {
        if (new URL(request.url).pathname === "/fixture-search-charges") return Response.json([...this.fixtureSql.exec("SELECT settled, reserved_micros FROM budget_reservations")]);
        return super.fetch(request);
      }
    }
  `, resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, host: "127.0.0.1", port: 0, workers: [{ name: "router", modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-06-05", compatibilityFlags: ["enable_request_signal"], bindings: { OPENAI_API_KEY: "fixture-upstream-only" }, kvNamespaces: ["POLICY_KV"],
    durableObjects: Object.fromEntries([["ACCESS_CONTROL", "PolicyBindingIndexObject"], ["BUDGET_LEDGER", "BudgetLedgerObject"], ["USAGE_LEDGER", "UsageLedgerObject"], ["GRANT_CREDENTIALS", "GrantCredentialObject"]].map(([name,className]) => [name,{className,useSQLite:true,unsafePreventEviction:true}])),
    queueProducers: { USAGE_QUEUE: "usage" }, queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } },
    outboundService: upstream.outbound,
  }] }));
  await mf.ready;
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  console.error(JSON.stringify({ phase: "worker-ready" }));
  await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], models: [...new Set([model, switchedModel])].map(slug => `openai/${slug}`), tenantId: "default", monthlyBudgetMicros: 100000000, requestCostMicros: null, requestCostsMicros: { "search.web": 1000 }, retainRequestContent: false }));
  await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: digest(clientSecret), policyId: "fixture", policyGeneration: "g1" }));
  await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: 100000000 }));
  }
  const base = (await mf.ready).origin;
  await manageCodex(["connect", "--profile", "search", "--router-url", base, "--provider", "openai", "--model", model, "--web-search", mode, "--codex-home", home, "--codex", codex], clientEnv);
  const { producer } = await manageCodex(["verify", "--profile", "search", "--codex-home", home, "--codex", codex], clientEnv);
  console.error(JSON.stringify({ phase: "profile-ready", model, producer }));
  if (args["origin-only"]) {
    originCheck = await checkOrigin(); upstream.check();
    qualification = { qualified: originCheck.retrieved && (!args["hosted-origin"] || mode === "live"), model, mode, transport, originCheck, producer, calls };
    if (!qualification.qualified) process.exitCode = 1;
  } else {
    const first = await run(["exec", "--json", "--skip-git-repo-check", "Use web.run to search for the official OpenAI homepage, open a returned search reference, then click a numbered link in the opened page, then find the word OpenAI in the clicked page. Perform each operation, then answer one sentence with a source link. Use only web.run; do not run local commands."]);
    const threadId = first.find(event => event.type === "thread.started")?.thread_id;
    assert.ok(threadId && upstream.firstReference, "native session and upstream search reference");
    const commands = calls.flatMap(call => call.commands ?? []);
    for (const name of ["search_query", "open", "click", "find"]) assert.ok(commands.includes(name), `missing native ${name}`);
    const answer = first.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => event.item.text).join("\n");
    assert.ok(/https:\/\/(?:www\.)?openai\.com|cite|\]\(https:\/\//.test(answer), "native answer includes a source link or citation");
    const count = calls.length;
    await run([...(args.compact ? ["-c", "model_auto_compact_token_limit=1000"] : []), "exec", "resume", "--model", switchedModel, "--json", "--skip-git-repo-check", threadId, `Use web.run to open ${upstream.firstReference} from the prior search, then give its source URL in one sentence. Do not run local commands.`]);
    assert.ok(calls.slice(count).some(call => call.opensOriginalReference), "native resume opens the original reference");
    assert.equal(sessions.size, 1, "search namespace survives native resume");
    const rollouts = (await readdir(join(home, "sessions"), { recursive: true })).filter(path => path.endsWith(".jsonl"));
    let compacted = 0, openedAfterCompaction = false;
    for (const path of rollouts) {
      const text = await readFile(join(home, "sessions", path), "utf8");
      const items = text.split("\n").filter(Boolean).map(line => JSON.parse(line));
      let seenCompaction = false;
      for (const item of items) {
        if (item.type === "compacted") { compacted++; seenCompaction = true; }
        const payload = item.payload;
        if (seenCompaction && item.type === "response_item" && /call$/.test(payload?.type ?? "") && JSON.stringify(payload).includes(upstream.firstReference)) openedAfterCompaction = true;
      }
    }
    compactionEvidence = { compacted, openedAfterCompaction };
    if (args.compact) assert.ok(compacted > 0 && openedAfterCompaction, "native rollout records automatic compaction followed by opening the original reference");
    if (switchedModel !== model) assert.ok(calls.slice(count).some(call => call.model === switchedModel && call.opensOriginalReference), "changed model reuses the original search namespace");
    if (transport === "websocket") assert.ok(calls.some(call => call.transport === "websocket" && !call.warmup), "native inference actually uses WebSockets");
    console.error(JSON.stringify({ phase: "session-checked", ...compactionEvidence }));
    if (args["origin-check"]) originCheck = await checkOrigin(threadId);
    assert.equal(sessions.size, 1, "origin checks retain the same search namespace");
    upstream.check();
    assert.ok(calls.every(call => call.status === 200), "upstream requests succeed");
    qualification = { qualified: true, model, switchedModel, mode, transport, automaticCompaction: !!args.compact, compactions: compacted, originCheck, producer, calls, resumed: true, searchNamespaces: sessions.size, searchNamespaceSha256: upstream.searchNamespace, nativeWebSearchItems: events.filter(event => event.type === "item.completed" && /web.*search/i.test(event.item?.type ?? "")).length, citedAnswer: true };
  }
  qualification.accounting = deployedOptions ? await upstream.accounting() : await checkSearchAccounting(mf, key, calls);
  qualification.target = deployedOptions ? { kind: "deployed", environment: deployedOptions.environment } : { kind: "local-fixture" };
} catch (error) {
  qualification = undefined;
  // Never print raw model output, credentialed transport diagnostics, or secrets.
  console.error(JSON.stringify({ qualified: false, model, category: error.name, check: error instanceof assert.AssertionError ? error.message.split("\n")[0] : /^live WebSocket (?:handshake failed|frame validation failed|response validation failed|transport failed|time limit)$/.test(error.message) ? error.message : "runtime_failure", compactionEvidence, originCheck, calls }));
  process.exitCode = 1;
} finally {
  upstream.close();
  const cleanup = await Promise.allSettled([origin?.close(), mf?.dispose()]);
  cleanup.push(...await Promise.allSettled([rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]));
  if (cleanup.some(result => result.status === "rejected")) {
    console.error(JSON.stringify({ qualified: false, check: "fixture_cleanup_failed" })); process.exitCode = 1;
  } else if (qualification) console.log(JSON.stringify(qualification));
}
