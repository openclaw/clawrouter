import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import wranglerMetadata from "wrangler/package.json" with { type: "json" };
import { renderSelfHostConfig, startContentCleanup } from "../deploy/self-host/entrypoint.mjs";

const wrangler = fileURLToPath(new URL(wranglerMetadata.bin.wrangler, import.meta.resolve("wrangler/package.json")));
const scratch = mkdtempSync(join(tmpdir(), "clawrouter-content-cleanup-"));
const persistence = join(scratch, "state"), config = join(scratch, "wrangler.toml");
const port = await availablePort(), base = `http://127.0.0.1:${port}`;
const assets = join(scratch, "assets");
mkdirSync(assets);
writeFileSync(join(assets, "index.html"), "synthetic fixture assets");
const rendered = renderSelfHostConfig(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"))
  .replace(/^main = .*$/m, `main = ${JSON.stringify(fileURLToPath(new URL("../worker/test/content-cleanup.fixture.mjs", import.meta.url)))}`)
  .replace(/^directory = .*$/m, `directory = ${JSON.stringify(assets)}`);
const previousConfig = rendered
  .replace(/\n\[\[durable_objects.bindings\]\]\nname = "CONTENT_CLEANUP"\nclass_name = "ContentArchiveCleanupObject"\n/, "")
  .replace(/\n\[\[migrations\]\]\ntag = "v5"\nnew_sqlite_classes = \["ContentArchiveCleanupObject"\]\n/, "");
assert.match(previousConfig, /tag = "v4"/);
assert.doesNotMatch(previousConfig, /CONTENT_CLEANUP|ContentArchiveCleanupObject/);
assert.match(rendered, /tag = "v5"/);
writeFileSync(config, previousConfig);
const adminToken = "synthetic-cleanup-admin", proxySecret = "synthetic-cleanup-proxy";
const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
let child, stopCleanup, output = "";
const fresh = "synthetic-cleanup-fresh-body", expired = "synthetic-cleanup-expired-body";

try {
  await start();
  await json("/v1/admin/keys/cleanup_fixture", { method: "PUT", headers: adminHeaders, body: JSON.stringify({
    enabled: true, providers: ["firecrawl"], allProviders: false, tenantId: "cleanup-fixture",
    secretSha256: sha256(proxySecret), requestCostMicros: 1,
  }) });
  const originalAuthority = await authorityState();
  assert.equal(originalAuthority.policy.policyId, "cleanup_fixture");
  assert.equal(originalAuthority.credential.active, true);
  await seed([
    { key: "v1/000-fresh", expiry: String(Date.now() + 86_400_000), body: fresh },
    { key: "v1/001-legacy", body: "synthetic-legacy-body" },
    ...Array.from({ length: 205 }, (_, index) => ({ key: `v1/expired-${String(index).padStart(3, "0")}`, expiry: "1", body: `${expired}-${index}` })),
    { key: "unrelated/expired", expiry: "1", body: "synthetic-unrelated-body" },
    { key: "fixture/pause" },
    { key: "fixture/fail-delete" },
  ]);
  await stop();
  assert.equal(blobCount(fresh), 1, "fixture must observe real persisted R2 blob bytes");
  // Add the real v5 binding to an existing v4 volume, preserving every previous
  // production class identity. Only fixture entrypoint and asset paths differ.
  writeFileSync(config, rendered);

  // A failed native tick must persist its retry state without advancing the
  // cursor or removing any objects, then recover through the same startup path.
  await start({ drive: true });
  await waitFor(async () => (await json("/fixture/status"))?.failed, "delete failure was not recorded");
  const failed = await json("/fixture/status");
  assert.deepEqual(await authorityState(), originalAuthority, "v5 must preserve the existing policy, credential and scoped catalog");
  assert.equal(failed.cursor, null);
  assert.equal(failed.scanned, 0);
  assert.equal(failed.deleted, 0);
  assert.equal((await json("/fixture/keys")).filter((key) => key.startsWith("v1/expired-")).length, 205);
  await stop();
  await start();
  assert.deepEqual(await json("/fixture/status"), failed, "failure checkpoint must survive restart");
  assert.equal((await fetch(`${base}/fixture/object?key=fixture/fail-delete`, { method: "DELETE" })).status, 204);
  await stop();

  // No new capture or usage events: the production driver's startup kick owns
  // cleanup. Fixture reads only observe the pause after the first R2 delete.
  await start({ drive: true });
  await waitFor(async () => (await fetch(`${base}/fixture/object?key=fixture/paused`)).ok, "startup sweep did not delete its first page");
  assert.deepEqual(await json("/fixture/status"), failed, "interruption must precede a successful checkpoint");
  const afterInterruptedDelete = await json("/fixture/keys");
  assert.equal(afterInterruptedDelete.filter((key) => key.startsWith("v1/expired-")).length, 107);
  await stop();

  await start();
  await fetch(`${base}/fixture/object?key=fixture/pause`, { method: "DELETE" });
  assert.deepEqual(await json("/fixture/keys"), afterInterruptedDelete.filter((key) => key !== "fixture/pause"));
  stopCleanup = startContentCleanup(child, base);
  await waitFor(async () => (await json("/fixture/status"))?.cursor, "first resumed page did not checkpoint");
  const checkpoint = await json("/fixture/status");
  assert.equal(checkpoint.failed, false, "the successful retry must clear the recorded failure");
  assert.equal(checkpoint.scanned, 100, "Miniflare metadata pages are shorter than the requested 1000");
  assert.equal((await json("/fixture/keys")).filter((key) => key.startsWith("v1/expired-")).length, 9);
  await stop();

  await start({ drive: true });
  await waitFor(async () => (await json("/fixture/status"))?.lastCompletedAt, "restart did not resume the persisted cursor");
  const completed = await json("/fixture/status");
  assert.equal(completed.cursor, null);
  assert.equal(completed.scanned, 109, "restart must continue instead of rescanning the first page");
  assert.deepEqual((await json("/fixture/keys")).filter((key) => key.startsWith("v1/")), ["v1/000-fresh", "v1/001-legacy"]);
  const futureTrigger = await fetch(`${base}/cdn-cgi/local/scheduled?format=json&time=${Date.now() + 365 * 86_400_000}`);
  assert.equal(futureTrigger.status, 200);
  assert.equal((await futureTrigger.json()).outcome, "ok");
  assert.equal(await (await fetch(`${base}/fixture/object?key=v1/000-fresh`)).text(), fresh);
  await seed([{ key: "v1/000-added-after-eof", expiry: "1", body: expired }]);
  stopCleanup();
  stopCleanup = startContentCleanup(child, base, { intervalMs: 20 });
  await waitFor(async () => !(await json("/fixture/keys")).includes("v1/000-added-after-eof"), "EOF reset did not revisit an earlier key");
  await stop();
  assert.equal(blobCount(fresh), 1);
  const rawExpiredBlobsAfterInterruption = blobCount(expired);

  // Advance only the fixture Worker's wall clock to exercise upload-age fallback
  // against actual persisted legacy objects with no expiresAt metadata.
  await start({ drive: true, ageDays: 31 });
  await waitFor(async () => !(await json("/fixture/keys")).some((key) => key.startsWith("v1/")), "legacy upload-age fallback did not expire the archive");
  assert.ok((await json("/fixture/keys")).includes("unrelated/expired"));
  await waitFor(() => blobCount(fresh) === 0, "completed deletion did not reclaim the fixture blob while the runtime was alive");
  assert.deepEqual(await authorityState(), originalAuthority, "authority state must survive cleanup and every restart");
  await stop();
  assert.equal(blobCount(fresh), 0, "ordinary completed deletion must reclaim the fixture blob after shutdown");
  console.log(JSON.stringify({ contentCleanup: "ok", productionConfigUpgrade: true, authorityPreserved: true, startupWithoutCaptures: true, deleteFailureRecovered: true, interruptedBeforeCheckpoint: true, resumedBetweenPages: true, eofRevisited: true, legacyUploadExpiry: true, freshPreserved: true, rawExpiredBlobsAfterInterruption }));
} catch (error) {
  throw new Error(`${error.message}\nWrangler fixture output:\n${output}`, { cause: error });
} finally {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
}

async function start({ drive = false, ageDays = 0 } = {}) {
  child = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistence, "--config", config, "--var", `CLAWROUTER_ADMIN_TOKEN_SHA256:${sha256(adminToken)}`, "--var", `FIXTURE_AGE_DAYS:${ageDays}`, "--log-level", "warn"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  if (drive) stopCleanup = startContentCleanup(child, base);
  await waitFor(async () => { try { return (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, "fixture Worker did not start");
}

async function stop() {
  stopCleanup?.(); stopCleanup = undefined;
  if (!child) return;
  const current = child; child = undefined;
  if (current.exitCode !== null || current.signalCode !== null) return;
  const exited = once(current, "exit");
  current.kill("SIGTERM");
  const timer = setTimeout(() => { try { process.kill(-current.pid, "SIGKILL"); } catch { /* fixture already stopped */ } }, 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function json(path, options = {}) { const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5_000) }); assert.equal(response.status, 200); return response.json(); }
async function authorityState() {
  const { policies } = await json("/v1/admin/policies", { headers: adminHeaders });
  const { credentials } = await json("/v1/admin/credentials", { headers: adminHeaders });
  const catalog = await json("/v1/catalog", { headers: { authorization: `Bearer clawrouter-live-cleanup_fixture-${proxySecret}` } });
  const providers = catalog.providers.map(({ id }) => id);
  assert.deepEqual(providers, ["firecrawl"]);
  return { policy: policies.find(({ policyId }) => policyId === "cleanup_fixture"), credential: credentials.find(({ credentialId }) => credentialId === "cleanup_fixture"), providers };
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function seed(records) { const response = await fetch(`${base}/fixture/seed`, { method: "POST", body: JSON.stringify(records), signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200); }
async function waitFor(predicate, message) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`fixture exited: ${child.exitCode}`);
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}
function availablePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function blobCount(marker) {
  let count = 0;
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.includes("/blobs/")) {
        try { if (readFileSync(file).includes(Buffer.from(marker))) count++; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  visit(persistence);
  return count;
}
