import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startWorkerdFixture } from "../test/helpers/workerd.mjs";
import { router, upstream } from "../test/helpers/personal-usage-upgrade.mjs";

// Reuse the existing local fixture and browser. All API bodies come from the
// shipped entrypoint. Only one post-response delivery failure is synthetic.
const root = resolve("."), scratch = join(root, ".openclaw/tmp");
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(scratch, "navigation-runtime-"));
const require = createRequire(await realpath(join(root, "admin/node_modules/@playwright/test/package.json")));
const { chromium } = require("playwright"), { expect } = require("@playwright/test");
const cookie = "clawrouter_session=" + "a".repeat(64), base = "http://127.0.0.1:4329";
const trace = []; let worker, browser, server, stage = "setup", failAfter = null, deliveredFault = false;
const digest = data => createHash("sha256").update(data).digest("hex");
try {
  worker = await startWorkerdFixture(temporary, router(root, true, 0), upstream, { preventEviction: true });
  const read = (path, init = {}) => worker.dispatchFetch("https://router.example" + path, { ...init, headers: { cookie, ...init.headers } });
  const json = async path => { const r = await read(path); const body = await r.text(); assert.equal(r.status, 200, body); return JSON.parse(body); };
  assert.equal((await read("/_proof/setup")).status, 200);
  assert.equal((await worker.dispatchFetch("https://router.example/v1/session/usage/report?days=7")).status, 401);
  for (let i = 0; i < 30; i++) {
    const r = await read("/v1/responses", { method: "POST", headers: { authorization: "Bearer clawrouter-live-owner-synthetic-key", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6.1-sol", input: "synthetic fixture", max_output_tokens: 32 }) });
    assert.equal(r.status, 200); await r.arrayBuffer();
  }
  const deadline = Date.now() + 20000;
  for (;;) { if ((await json("/v1/session/usage/report?days=7")).metrics.calls === 30) break; assert.ok(Date.now() < deadline, "native ingestion did not converge"); await new Promise(r => setTimeout(r, 20)); }
  server = spawn(process.execPath, [join(root, "admin/node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "4329", "--strictPort"], { cwd: join(root, "admin"), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((done, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error("Vite stdout readiness timeout")), 20000); server.once("exit", code => { clearTimeout(timer); reject(new Error("Vite exited " + code)); }); server.stderr.on("data", c => { output += c; }); server.stdout.on("data", c => { output += c; if (output.includes(base)) { clearTimeout(timer); done(); } }); });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC" });
  await page.clock.setFixedTime(new Date());
  await page.route("**/v1/**", async route => {
    const url = new URL(route.request().url()), atStage = stage;
    const r = await read(url.pathname + url.search), bytes = Buffer.from(await r.arrayBuffer());
    let dto; try { dto = JSON.parse(bytes.toString()); } catch { dto = null; }
    const report = url.pathname === "/v1/session/usage/report", events = url.pathname === "/v1/session/usage/events";
    const to = Date.parse(url.searchParams.get("to") ?? "");
    const fault = events && r.status === 200 && failAfter !== null && to > failAfter && !deliveredFault;
    if (fault) deliveredFault = true;
    if (report || events) trace.push({ stage: atStage, route: url.pathname, days: url.searchParams.get("days"), from: url.searchParams.get("from"), to: url.searchParams.get("to"), timezone: url.searchParams.get("timezone"), cursorPresent: url.searchParams.has("cursor"), nativeStatus: r.status, deliveredStatus: fault ? 503 : r.status, ...(report && dto?.range ? { resolvedFrom: dto.range.from, resolvedTo: dto.range.to, generatedAt: dto.generatedAt, groupBy: dto.groupBy } : {}), ...(events && dto?.events ? { events: dto.events.length, nextCursor: Boolean(dto.nextCursor) } : {}) });
    try {
      await route.fulfill(fault ? { status: 503, json: { error: { message: "Synthetic delivery failure after shipped HTTP200" } } } : { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" }, body: bytes });
    } catch (error) { if (!String(error).includes("closed") && !String(error).includes("handled") && !String(error).includes("cancel")) throw error; }
  });
  const calls = () => page.locator(".personalEvents > li");
  stage = "page-one"; await page.goto(base + "/dashboard/my-usage"); await expect(calls()).toHaveCount(25);
  stage = "page-two"; await page.getByRole("button", { name: "Next page", exact: true }).click(); await expect(calls()).toHaveCount(5); await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  const originalTo = trace.find(row => row.route.endsWith("/report")).resolvedTo;
  stage = "catalog-away"; await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.clock.setFixedTime(new Date(Date.now() + 16001)); failAfter = originalTo;
  stage = "expired-cache-return"; await page.getByRole("button", { name: "My usage", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic delivery failure");
  assert.equal(deliveredFault, true);
  const fault = trace.find(row => row.deliveredStatus === 503); assert.equal(fault.cursorPresent, false);
  stage = "retry"; await page.getByRole("button", { name: "Retry recent calls", exact: true }).click(); await expect(calls()).toHaveCount(25);
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  const retry = trace.filter(row => row.stage === "retry" && row.route.endsWith("/events")).at(-1);
  assert.equal(retry.nativeStatus, 200); assert.equal(retry.cursorPresent, false); assert.equal(retry.from, fault.from); assert.equal(retry.to, fault.to);
  assert.ok(trace.filter(row => row.route.endsWith("/report")).at(-1).resolvedTo > originalTo);
  assert.ok(trace.every(row => row.nativeStatus === 200));
  stage = "fully-expired-custom";
  await page.getByText("Custom dates & exact filters", { exact: true }).click();
  await page.getByLabel("Start", { exact: true }).fill("2026-10-01"); await page.getByLabel("End (exclusive)", { exact: true }).fill("2026-10-02"); await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click(); await expect(calls()).toHaveCount(0);
  await expect(page.getByLabel("Start", { exact: true })).toHaveValue("2026-10-01"); await expect(page.getByLabel("End (exclusive)", { exact: true })).toHaveValue("2026-10-02");
  stage = "expired-custom-grouping"; await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("provider");
  await expect(page.locator(".personalRange")).toContainText("2026-10-02"); await expect(calls()).toHaveCount(0);
  stage = "expired-custom-refresh";
  const reportsBeforeRefresh = trace.filter(row => row.route.endsWith("/report")).length;
  await page.getByRole("button", { name: "Refresh report", exact: true }).click();
  await expect.poll(() => trace.filter(row => row.route.endsWith("/report")).length).toBeGreaterThan(reportsBeforeRefresh);
  const refreshed = trace.filter(row => row.stage === "expired-custom-refresh" && row.route.endsWith("/report")).at(-1);
  assert.equal(refreshed.groupBy, "provider");
  await expect(page.locator('time[datetime="' + new Date(refreshed.generatedAt).toISOString() + '"]')).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(calls()).toHaveCount(0);
  await expect(page.getByLabel("Start", { exact: true })).toHaveValue("2026-10-01");
  await expect(page.getByLabel("End (exclusive)", { exact: true })).toHaveValue("2026-10-02");
  const expired = trace.filter(row => row.stage.startsWith("fully-expired") || row.stage.startsWith("expired-custom"));
  assert.ok(expired.filter(row => row.route.endsWith("/report")).length >= 2); assert.ok(expired.every(row => row.route.endsWith("/report")));
  assert.ok(expired.every(row => row.nativeStatus === 200 && row.resolvedFrom === row.resolvedTo));
  const files = ["worker/index.ts", "worker/access.ts", "worker/local-auth.ts", "worker/usage-report-session.ts", "worker/usage-report.ts", "worker/usage-report-range.ts", "worker/usage-report-store.ts", "shared/usage-report.ts", "admin/src/hooks/use-personal-usage.ts", "admin/src/screens/my-usage.tsx", "test/helpers/workerd.mjs", "test/helpers/personal-usage-upgrade.mjs", "scripts/prove-personal-usage-navigation.mjs"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async f => [f, digest(await readFile(join(root, f)))])));
  const assets = (await readdir(join(root, "admin/dist/assets"))).filter(f => /[.](js|css)$/.test(f));
  const assetHashes = Object.fromEntries(await Promise.all(assets.map(async f => [f, digest(await readFile(join(root, "admin/dist/assets", f)))])));
  const proof = { synthetic: true, productionTrafficOrCredentials: false, actualShippedEntryPoint: true, actualAuthenticatedReportEventsRoutes: true, authControl: { noCookieReportStatus: 401, syntheticLocalSession: true }, actualProxySeedCalls: 30, browserActions: ["page1", "page2", "Catalog", "browser cache clock +16001ms", "My usage", "Retry", "fully expired custom", "grouping", "Refresh"], transportFault: "one delivered503 AFTER actual shipped events route returned200; no fixture DTO replaces successful route bodies", assertions: { noNative400: true, newRangeNoOldCursor: true, retrySameResolvedBounds: true, pageAndPreviousStackReset: true, expiredCustomControlsPreserved: true, noEmptyIntervalEventsHttp: true }, sourceHashes, assetHashes, trace, limits: ["Synthetic local session/authority setup and provider wire; not Cloudflare JWT or real billing evidence", "Browser API transport relays exact shipped handler responses; one explicitly labeled post-response delivery fault exercises Retry", "Date clock is advanced in browser to expire cache; Worker clock remains live"] };
  const artifact = resolve(process.argv[2] ?? "docs/proof/personal-usage/navigation-runtime.json"); await writeFile(artifact, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({ artifact, routeReads: trace.length, trace, assertions: proof.assertions }, null, 2));
} finally { await browser?.close(); server?.kill(); await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
