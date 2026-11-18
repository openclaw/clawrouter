import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { manageCodex } from "../scripts/codex-connect.mjs";
import { nativeCodexClient } from "./helpers/native-codex.mjs";
import { requireBaselineCommit } from "./helpers/personal-usage-baseline.mjs";
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import { cleanupFixture } from "./helpers/fixture-cleanup.mjs";

// Latest stable release at introduction. Execute its real writer, not a receipt
// reconstructed with the candidate's schema or hand-edited optional fields.
const baseline = "608050e4e4dae5ebc93919e0759ffb4bf0664528"; // v0.5.0
const binary = process.env.CLAWROUTER_CODEX_REMOTE_BINARY;
const secret = "synthetic-remote-upgrade-client";
const key = `clawrouter-live-fixture-${secret}`;
const parse = text => getStaticTOMLValue(parseTOML(text));
const router = 'export { default } from "./worker/index.ts"; export * from "./worker/index.ts";';

function upstream(models) { return `
const metadata = ${JSON.stringify({ models })};
const observations = { metadata: [], inference: [] };
export default { async fetch(request) {
 const url = new URL(request.url);
 if (url.origin === 'https://fixture.example' && url.pathname === '/observations') return Response.json(observations);
 if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/models' && request.method === 'GET') {
  observations.metadata.push({ version: url.searchParams.get('client_version'), authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key' });
  return Response.json(metadata, { headers: { 'cache-control': 'no-store' } });
 }
 if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses' || request.method !== 'POST') return new Response('Unexpected fixture outbound request', { status: 500 });
 const body = await request.json();
 observations.inference.push({ model: body.model, authorized: request.headers.get('authorization') === 'Bearer fixture-upstream-key' });
 const item = { id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic upgrade complete.', annotations: [] }] };
 const response = { id: 'synthetic-' + crypto.randomUUID(), object: 'response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
 return new Response([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].map(event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
} };`; }

for (const target of ["cli", "desktop"]) for (const existing of [false, true]) {
  test(`remote catalog through actual workerd and Codex: ${target}, ${existing ? "v0.5.0 connection upgrade" : "fresh connection"}`, { skip: !binary, timeout: 120_000 }, async t => {
    if (existing && !requireBaselineCommit(t, baseline)) return;
    const scratch = resolve(".wrangler/codex-remote-proof");
    await mkdir(scratch, { recursive: true });
    const temporary = await mkdtemp(join(scratch, "case-")), home = join(temporary, "home");
    let mf, client;
    const primary = { failed: false, error: undefined };
    try {
      await mkdir(home);
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "off", CLAWROUTER_API_KEY: key };
      const bundled = JSON.parse(execFileSync(binary, ["debug", "models", "--bundled"], { env: { ...env, CLAWROUTER_API_KEY: undefined }, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }));
      const model = bundled.models.find(model => model.slug === "gpt-6-sol");
      assert.ok(model);
      const tier = model.service_tiers.find(tier => tier.id === "priority");
      assert.ok(tier);
      const current = { ...model, display_name: "Current synthetic remote Sol",
        available_access_programs: { cyber: ["standard", "daybreak_blue"] },
        service_tiers: [tier, { ...tier, id: "unpriced" }], additional_speed_tiers: ["fast", "unpriced"] };
      mf = await startWorkerdFixture(temporary, router, upstream([current, { ...current, slug: "unauthorized-model" }]));
      const origin = (await mf.ready).origin;
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      // Exercise the ordinary persisted key/policy/connection admission path.
      await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], models: ["openai/gpt-6-sol"], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: 1, retainRequestContent: false }));
      await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
      await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: null }));
      const root = `# unrelated settings survive\ncli_auth_credentials_store = "file"\nchatgpt_base_url = "${origin}/control"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n`;
      const auth = '{"OPENAI_API_KEY":null}\n';
      await writeFile(join(home, "config.toml"), root);
      await writeFile(join(home, "auth.json"), auth);
      const common = ["--target", target, "--codex-home", home, "--codex", binary];
      const connect = ["connect", "--router-url", origin, "--provider", "openai", "--model", "gpt-6-sol", ...common];
      const profile = join(home, target === "cli" ? "clawrouter.config.toml" : "config.toml");
      const run = (command, ...args) => manageCodex([command, ...common, ...args], env);
      const observations = async () => (await (await mf.getWorker("upstream")).fetch("https://fixture.example/observations")).json();
      const execute = async remote => {
        const before = await observations();
        const execution = promisify(execFile)(binary, [...(target === "cli" ? ["--profile", "clawrouter"] : []), "-c", "features.plugins=false", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "Return Synthetic upgrade complete. without tools."], { cwd: home, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        execution.child.stdin.end();
        const result = await execution;
        assert.ok(result.stdout.includes("Synthetic upgrade complete."));
        const after = await observations();
        assert.equal(after.inference.length, before.inference.length + 1);
        assert.deepEqual(after.inference.at(-1), { model: "gpt-6-sol", authorized: true });
        if (remote) assert.ok(after.metadata.length > before.metadata.length, "native Codex must retrieve metadata through the actual Worker route");
        else assert.equal(after.metadata.length, before.metadata.length, "released local catalogs still suppress remote discovery");
        assert.equal(await readFile(join(home, "auth.json"), "utf8"), auth);
      };
      if (existing) {
        const legacy = join(temporary, "stable"); await mkdir(legacy);
        for (const name of ["codex-connect.mjs", "codex-catalog.mjs"]) await writeFile(join(legacy, name), execFileSync("git", ["show", `${baseline}:scripts/${name}`]));
        const old = await import(pathToFileURL(join(legacy, "codex-connect.mjs")).href);
        await old.manageCodex(connect, env);
        const bytes = await readFile(profile, "utf8"), prefix = target === "cli" ? "# clawrouter-connect-v1 " : "# clawrouter-desktop-v1 ";
        assert.ok(bytes.startsWith(prefix));
        const receipt = JSON.parse(bytes.slice(prefix.length, bytes.indexOf("\n")));
        assert.equal(receipt.catalogMode, undefined);
        assert.equal(receipt.webSearch, undefined);
        assert.equal((await run("verify")).status, "verified");
        assert.equal(await readFile(profile, "utf8"), bytes, "verification must not rewrite released receipts");
        await run("update");
        const upgraded = parse(await readFile(profile, "utf8"));
        assert.ok(upgraded.model_catalog_json);
        assert.equal(upgraded.model_providers[target === "cli" ? "clawrouter_clawrouter" : "clawrouter.desktop"].model_catalog_url, undefined, "legacy connections remain local");
        await execute(false);
        await run("remove");
        assert.deepEqual(parse(await readFile(join(home, "config.toml"), "utf8")), parse(root));
      }
      await manageCodex([...connect, "--catalog-mode", "remote", "--web-search", "disabled"], env);
      const config = parse(await readFile(profile, "utf8"));
      assert.equal(config.model_catalog_json, undefined);
      assert.equal(config.model_providers[target === "cli" ? "clawrouter_clawrouter" : "clawrouter.desktop"].model_catalog_url, origin + "/v1/codex/models");
      const response = await fetch(origin + "/v1/codex/models?client_version=0.169.0", { headers: { authorization: `Bearer ${key}` } });
      assert.equal(response.status, 200);
      const projected = await response.json();
      assert.deepEqual(projected.models.map(model => model.slug), ["gpt-6-sol"]);
      assert.deepEqual(projected.models[0].service_tiers.map(tier => tier.id), ["priority"]);
      assert.deepEqual(projected.models[0].available_access_programs, current.available_access_programs);
      await execute(true);
      if (target === "desktop") {
        client = nativeCodexClient(t, binary, home, env);
        await client.rpc("initialize", { clientInfo: { name: "remote_upgrade_proof", version: "1" }, capabilities: { experimentalApi: true } });
        const models = await client.rpc("model/list", {}), discovered = models.data.find(model => model.model === "gpt-6-sol");
        assert.equal(discovered?.displayName, current.display_name);
        assert.deepEqual(discovered.availableAccessPrograms, { cyber: ["standard", "daybreakBlue"] });
        await client.close(); client = null;
      }
      await run("verify"); await run("update"); await run("remove");
      assert.deepEqual(parse(await readFile(join(home, "config.toml"), "utf8")), parse(root));
      if (target === "cli") assert.equal(await readFile(join(home, "config.toml"), "utf8"), root);
      assert.equal(await readFile(join(home, "auth.json"), "utf8"), auth);
      const observed = await observations();
      assert.ok(observed.metadata.every(request => request.authorized && request.version === "0.169.0"));
      t.diagnostic(JSON.stringify({ target, connection: existing ? "latest-stable-upgrade" : "fresh", baseline: existing ? baseline : null, actualWorkerAndNativeClient: true,
        legacyReceiptVerifiedWithoutRewrite: existing, legacyModePreserved: existing, filteredModels: 1, accessProgramsPreserved: true, nativeFetchedCatalog: true,
        authAndUnrelatedConfigPreserved: true, metadataRequests: observed.metadata.length, syntheticInferenceRequests: observed.inference.length, productionEvidence: false }));
    } catch (error) { primary.failed = true; primary.error = error; throw error; }
    finally { await cleanupFixture([() => client?.close(), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })], primary); }
  });
}
