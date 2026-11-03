import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "1c72f546f839d2790168cd15a9f9d18afaf014ff";
const knownFormats = new Set(["tavily.search", "brave.search", "exa.search", "parallel.search", "searxng.search"]);
const cases = snapshot.providers.flatMap(provider => provider.endpoints
  .filter(endpoint => knownFormats.has(endpoint.request_format) && endpoint.response_format === endpoint.request_format)
  .map(endpoint => ({ provider, endpoint })));

test("actual OpenClaw search registration through Worker admission, upstream and SQLite settlement", { skip: !source, timeout: 300_000 }, async t => {
  assert.equal(process.env.CI, "true", "the public client receives its own native install in ephemeral CI only");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sourceHead);
  assert.ok(cases.length > 0);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-search-"));
  const clientTest = join(resolve(source), "extensions/clawrouter/worker-contract.test.ts");
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf, copied = false;
  try {
    await copyFile(new URL("./fixtures/openclaw-search-contract.test.ts", import.meta.url), clientTest, constants.COPYFILE_EXCL);
    copied = true;
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const { provider } of cases) {
      const policy = { enabled: true, generation: "fixture", providers: [provider.id], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
      for (const [id, price] of [[provider.id, 7], [`unpriced_${provider.id}`, null]]) {
        await kv.put(`policies/${id}`, JSON.stringify({ ...policy, requestCostMicros: price }));
        const credentialId = id === provider.id ? `search_${id}` : id;
        await kv.put(`credentials/${credentialId}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(`fixture-${provider.id}`).digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put(`connections/${provider.id}`, JSON.stringify({ providerId: provider.id, enabled: true }));
    }
    const origin = String(await mf.ready);
    const started = performance.now();
    const result = await promisify(execFile)("pnpm", ["test", "extensions/clawrouter/worker-contract.test.ts", "--maxWorkers=1"], {
      // The native runner compiles its own SDK worker graph on a cold CI host.
      cwd: source, timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "true", CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, ""), CLAWROUTER_CONTRACT_PROVIDERS: cases.map(({ provider }) => provider.id).join(",") },
    });
    t.diagnostic(`OpenClaw ${sourceHead}; native test wall time ${Math.round(performance.now() - started)}ms\n${result.stdout}`);
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, cases.length, "only successful searches may reach an upstream");
    for (const { provider, endpoint } of cases) {
      const call = calls.find(call => call.provider === provider.id);
      assert.ok(call, provider.id);
      assert.equal(call.method, endpoint.method);
      const expected = new URL(provider.base_urls.default.startsWith("https:") ? provider.base_urls.default : "https://fixture-searxng.example");
      assert.equal(new URL(call.url).origin, expected.origin);
      assert.equal(new URL(call.url).pathname, expected.pathname.replace(/\/$/, "") + endpoint.path);
      for (const auth of provider.auth.schemes) assert.equal(call.headers[auth.header.toLowerCase()], auth.type === "bearer" ? `Bearer fixture-upstream-${provider.id}` : `fixture-upstream-${provider.id}`);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      if (endpoint.method === "GET") assert.equal(new URL(call.url).searchParams.get("q"), "synthetic contract query");
      else assert.equal(call.body.query ?? call.body.search_queries?.[0], "synthetic contract query");
      let usage;
      for (let attempt = 0; attempt < 100; attempt++) {
        usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-search_${provider.id}-fixture-${provider.id}` } })).json();
        if (usage.usage.events.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1, "one search produces one caller-scoped receipt");
      const [event] = usage.usage.events;
      assert.equal(event.provider, provider.id);
      assert.equal(event.credential_id, `search_${provider.id}`);
      assert.equal(event.policy_id, provider.id);
      assert.equal(event.status, "success");
      assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.actual_cost_micros, 7);
      assert.equal(usage.budget.spentMicros, 7);
      assert.doesNotMatch(JSON.stringify(event), /synthetic contract query|Fixture snippet|fixture-upstream/);
    }
  } finally {
    await mf?.dispose();
    if (copied) await rm(clientTest);
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  const config = Object.fromEntries(cases.flatMap(({ provider }) => provider.config_keys.map(name => [name, /(?:URL|ENDPOINT)$/.test(name) ? "https://fixture-searxng.example" : `fixture-upstream-${provider.id}`])));
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
export default { ...handler, fetch(request, env, context) { return handler.fetch(request, { ...env, ...${JSON.stringify(config)} }, context); } };`;
}

function upstreamFixture() {
  const routes = cases.map(({ provider, endpoint }) => ({ provider: provider.id, origin: new URL(provider.base_urls.default.startsWith("https:") ? provider.base_urls.default : "https://fixture-searxng.example").origin, path: endpoint.path }));
  return `const routes = ${JSON.stringify(routes)}, calls = [];
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.origin === "https://fixture.example" && url.pathname === "/state") return Response.json(calls);
  const selected = routes.find(route => route.origin === url.origin && route.path === url.pathname);
  if (!selected) return new Response("unexpected synthetic upstream", { status: 502 });
  calls.push({ provider: selected.provider, url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.json() : null });
  const results = ["https://example.com/result", "javascript:alert(1)"].map(url => ({ url, title: "Synthetic result", content: "Fixture snippet", description: "Fixture snippet", highlights: ["Fixture snippet"], excerpts: ["Fixture snippet"] }));
  return Response.json(selected.provider === "brave" ? { web: { results } } : { results });
} };`;
}
