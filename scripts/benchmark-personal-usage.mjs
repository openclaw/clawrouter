// Local synthetic metadata only. No provider calls, credentials, or production storage.
import { mkdir, mkdtemp, writeFile, rm, readFile, stat, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { startWorkerdFixture } from "../test/helpers/workerd.mjs";
// Run from repository root. BROWSER=1 expects baseline/candidate dist already built.
const root = resolve(".openclaw/tmp"); await mkdir(root, { recursive: true });
const sourcePaths = ["worker/usage-report-cost.ts", "worker/ledgers.ts", "worker/usage-report.ts", "worker/usage-report-store.ts", "worker/usage-report-range.ts", "shared/usage-report.ts", "scripts/benchmark-personal-usage.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
const temporary = await mkdtemp(join(root, "usage-benchmark-"));
const perShard = Number(process.env.EVENTS_PER_SHARD ?? 50000), shardCount = 4;
const seedProjection = process.env.PROJECTION !== "0";
if (!Number.isSafeInteger(perShard) || perShard < 5) throw new Error("EVENTS_PER_SHARD must be an integer >= 5");
const evidenceDir = resolve(process.env.EVIDENCE_DIR ?? "docs/performance/personal-usage");
const summaries = values => { const sorted = [...values].sort((a, b) => a - b); return { samplesMs: values, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }; };
let worker;
try {
  worker = await startWorkerdFixture(temporary, `
    export { BudgetLedgerObject, PolicyBindingIndexObject, GrantCredentialObject } from "./worker/index.ts";
    import { UsageLedgerObject as BaseLedger, usageSnapshots, usageStub } from "./worker/ledgers.ts";
    import { insertUsageReportEvent } from "./worker/usage-report-store.ts";
    import { personalUsage } from "./worker/usage-report.ts";
    export class UsageLedgerObject extends BaseLedger {
      async fetch(request) {
        const u = new URL(request.url);
        if (u.pathname !== "/seed") return super.fetch(request);
        const count = Number(u.searchParams.get("count")), shard = Number(u.searchParams.get("shard")), now = Number(u.searchParams.get("now"));
        this.state.storage.transactionSync(() => {
          for (let i = 0; i < count; i++) {
            const event = { id: "s" + shard + "-" + String(i).padStart(8, "0"), type: "clawrouter.usage.v1", occurred_at_ms: now - 1 - i * (29 * 86400000 / count), tenant_id: "synthetic-tenant", policy_id: "policy-" + shard, provider: i % 3 ? "openai" : "anthropic", model: "model-" + i % 12, capability: "llm.responses", request_format: "openai.responses", credential_id: "key-" + i % 8, key_id: "key-" + i % 8, principal_id: i % 5 ? "other-" + i % 20 + "@example.test" : "owner@example.test", grant_lane: i % 3 ? "api_key" : "subscription", status: i % 19 ? "success" : "provider_error", status_code: i % 19 ? 200 : 502, input_tokens: 1000, output_tokens: 200, total_tokens: 1200, cached_input_tokens: 400, cache_write_input_tokens: 0, reasoning_output_tokens: i % 2 ? 120 : null, actual_cost_micros: i % 7 ? 3240 : 0, cost_basis: i % 7 ? "manifest_pricing" : "unpriced_usage", metadata: "x".repeat(1024) };
            event.occurred_at_ms = Math.floor(event.occurred_at_ms);
            this.sql.exec("INSERT INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, status_code, input_tokens, output_tokens, total_tokens, actual_cost_micros, event_json, principal_id, principal_key, credential_id, cost_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", event.id, event.occurred_at_ms, event.tenant_id, event.policy_id, event.provider, event.status, event.status_code, event.input_tokens, event.output_tokens, event.total_tokens, event.actual_cost_micros, JSON.stringify(event), event.principal_id, event.principal_id, event.credential_id, event.cost_basis);
            if (${seedProjection ? "true" : "false"}) insertUsageReportEvent(this.sql, event);
          }
          this.sql.exec("UPDATE usage_report_migration SET upper_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM usage_events), complete = ? WHERE id = 1", ${seedProjection ? 1 : 0});
          this.sql.exec("UPDATE usage_attribution_migration SET complete = 1 WHERE id = 1");
        });
        return Response.json({ seeded: count });
      }
    }
    const policies = Array.from({ length: 4 }, (_, i) => ({ tenantId: "synthetic-tenant", policyId: "policy-" + i }));
    export default { async fetch(request, env) {
      const u = new URL(request.url);
      if (u.pathname === "/seed") return usageStub(env, "synthetic-tenant", "policy-" + u.searchParams.get("shard")).fetch(request);
      if (u.pathname === "/legacy") return Response.json(await usageSnapshots(env, policies, { kind: "principal", id: "owner@example.test" }));
      return Response.json(await personalUsage(env, policies, "owner@example.test", u.searchParams, u.pathname === "/events"));
    }};
  `, 'export default { fetch() { throw new Error("Unexpected network access"); } };', { preventEviction: true });
  const url = await worker.ready, now = Date.now();
  for (let shard = 0; shard < shardCount; shard++) {
    const response = await fetch(new URL("/seed?count=" + perShard + "&shard=" + shard + "&now=" + now, url));
    if (!response.ok) throw new Error(await response.text());
    console.error("seeded shard", shard);
  }
  const results = {};
  const range7 = "from=" + encodeURIComponent(new Date(now - 7 * 86400000).toISOString()) + "&to=" + encodeURIComponent(new Date(now).toISOString());
  const range30 = "from=" + encodeURIComponent(new Date(now - 30 * 86400000).toISOString()) + "&to=" + encodeURIComponent(new Date(now).toISOString());
  for (const [name, path] of Object.entries({ legacy30: "/legacy", report7: "/report?" + range7, report30: "/report?" + range30, filtered7: "/report?" + range7 + "&provider=openai&groupBy=key", events25: "/events?" + range7 + "&limit=25" })) {
    const samples = []; let payloadBytes = 0, parsed;
    for (let i = 0; i < 12; i++) {
      const start = performance.now(), response = await fetch(new URL(path, url)), body = await response.text();
      if (!response.ok) throw new Error(body);
      parsed = JSON.parse(body); payloadBytes = new TextEncoder().encode(body).byteLength;
      samples.push(performance.now() - start);
    }
    const firstMs = samples.shift();
    results[name] = { firstMs, ...summaries(samples), payloadBytes, calls: parsed.metrics?.calls ?? parsed.personal?.summary.requestCount ?? parsed.events?.length };
  }
  const expectedOwnerEvents = Math.ceil(perShard / 5) * shardCount;
  if (results.legacy30.calls !== expectedOwnerEvents || results.report30.calls !== expectedOwnerEvents) throw new Error("30-day owner totals differ from seeded volume");
  if (results.events25.calls !== Math.min(25, results.report7.calls)) throw new Error("Event page size differs from report volume/limit");
  const output = { generatedAt: new Date().toISOString(), sourceHashes, runtime: process.version, environment: { os: platform(), release: release(), architecture: process.arch, cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() }, transport: "loopback HTTP -> Worker -> four SQLite Durable Objects -> merge -> JSON (synthetic authority; excludes Access verification)", volume: { totalEvents: perShard * shardCount, eventsPerShard: perShard, ownerEvents: Math.ceil(perShard / 5) * shardCount, ownerShare: "20% (every fifth event)", reportingProjectionSeeded: seedProjection, days: 29, eventPaddingBytes: 1024 }, methodology: { api: "Each query: first request followed by 11 sequential warm requests; timing includes Node fetch, body read and JSON.parse. No artificial delay. Seeded DOs are already resident; first is not disk/process cold.", backend: "Current repository usageSnapshots and personalUsage functions, four SQLite DO shards; " + (seedProjection ? "seed inserts raw and reporting rows and marks projection complete" : "seed inserts canonical owner-attributed raw rows only, with reporting projection empty/incomplete") + ". Legacy function is not an archived implementation.", limits: ["Synthetic owner and policy authority; no Cloudflare Access verification, policy resolution, budget lookup, provider call, network WAN or production storage", "Local workerd co-schedules objects and disables idle eviction; not production Cloudflare topology", "Shared development host, no CPU/network throttling, no performance acceptance target", "Per-call token/cost metadata and provider/model/key distribution are synthetic; no prompt/completion content", "API and browser first samples run after seeding; browser measurements additionally follow API warmup"] }, results };
  if (process.env.BROWSER === "1") output.browser = await browserBenchmark(url, now);
  // Keep full per-request traces local. Committed proof contains raw latency samples
  // plus request-class counts, without thousands of duplicated query strings.
  await writeFile(join(root, "personal-usage-benchmark-full.json"), JSON.stringify(output, null, 2));
  if (output.browser) {
    const classify = rows => {
      const counts = { reports: 0, events: 0, budgetOnly: 0, legacyScans: 0 };
      for (const row of rows) {
        if (row.path.includes('/usage/report?')) counts.reports++;
        else if (row.path.includes('/usage/events?')) counts.events++;
        else if (row.path.startsWith('/v1/session/usage')) {
          if (row.path.includes('budgets_only=true')) counts.budgetOnly++; else counts.legacyScans++;
        }
      }
      return counts;
    };
    const variants = [...new Set(output.browser.requests.map(row => row.variant))];
    output.browser.requestCounts = Object.fromEntries(variants.map(variant => [variant, classify(output.browser.requests.filter(row => row.variant === variant))]));
    output.browser.navigationSamples = output.browser.navigationSamples.map(({ requests, ...sample }) => ({ ...sample, requests: classify(requests) }));
    for (const action of Object.values(output.browser.interactions)) action.samples = action.samples.map(({ ms, requests }) => ({ ms, requests: classify(requests) }));
    delete output.browser.requests;
  }
  const json = JSON.stringify(output, null, 2);
  await writeFile(join(root, "personal-usage-benchmark.json"), json);
  if (process.env.BROWSER === "1" || process.env.EVIDENCE_DIR) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, "measurements.json"), json + "\n"); }
  console.log(json);
} finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }

async function browserBenchmark(backendUrl, now) {
  const require = createRequire(resolve('admin/package.json'));
  const { chromium } = require('@playwright/test');
  const baselineRoot = resolve(process.env.BASELINE_UI ?? '.openclaw/tmp/baseline-ui/admin');
  const candidateRoot = resolve('admin');
  // Freeze assets: another agent may rebuild admin/dist during this run.
  const frozenCandidate = join(temporary, 'candidate-dist');
  await cp(join(candidateRoot, 'dist'), frozenCandidate, { recursive: true });
  const vite = resolve('admin/node_modules/vite/bin/vite.js');
  const previews = [], contexts = [], requests = [], errors = [], screenshots = [];
  let browser;
  await mkdir(evidenceDir, { recursive: true });
  async function preview(cwd, port, outDir) {
    const child = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', ...(outDir ? ['--outDir', outDir] : [])], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    previews.push(child);
    let log = ''; child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Preview exited: ${log}`);
      if (log.includes(origin)) { const response = await fetch(origin); if (response.ok) return origin; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Preview readiness timeout: ${log}`);
  }
  async function assets(cwd, dist = join(cwd, 'dist')) {
    const html = await readFile(join(dist, 'index.html'), 'utf8');
    const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
    return Promise.all(paths.map(async path => { const bytes = await readFile(join(dist, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }));
  }
  const emptyUsage = { ledger: 'ready', summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  const session = { authenticated: true, auth: 'cloudflare_access', role: 'user', email: 'owner@example.test', tenantId: 'synthetic-tenant', entitlements: { providers: [], policies: [] } };
  async function makePage(variant, origin, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(now));
    await page.addInitScript(() => localStorage.setItem('clawrouter-theme', 'light'));
    page.on('pageerror', error => errors.push({ variant, kind: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ variant, kind: 'console', message: message.text() }); });
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url()), started = performance.now();
      let body, backendPath = null, contentType = 'application/json';
      const metadata = { '/v1/session': session, '/v1/providers': { providers: [] }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] }, '/v1/session/credentials': { credentials: [] }, '/v1/entitlements': { session, providers: [], policies: [], catalog: [], contentRetention: { enabled: false, retentionDays: 30, policyEnabled: false, userExempt: false } } };
      if (url.pathname === '/v1/session/usage') {
        if (url.searchParams.get('budgets_only') === 'true') body = JSON.stringify({ session, policies: [], usage: emptyUsage });
        else { backendPath = '/legacy'; const response = await fetch(new URL(backendPath, backendUrl)); if (!response.ok) throw new Error(await response.text()); body = JSON.stringify({ session, policies: [], usage: await response.json() }); }
      } else if (url.pathname === '/v1/session/usage/report' || url.pathname === '/v1/session/usage/events') {
        backendPath = (url.pathname.endsWith('/events') ? '/events' : '/report') + url.search;
        const response = await fetch(new URL(backendPath, backendUrl)); body = await response.text();
        if (!response.ok) throw new Error(`Backend ${response.status}: ${body}`);
      } else if (url.pathname === '/v1/session/avatar') { body = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>'; contentType = 'image/svg+xml'; }
      else if (metadata[url.pathname]) body = JSON.stringify(metadata[url.pathname]);
      else { errors.push({ variant, kind: 'unexpected-request', message: url.pathname + url.search }); await route.fulfill({ status: 404, json: {} }); return; }
      requests.push({ variant, path: url.pathname + url.search, backendPath, backendAndBridgeMs: performance.now() - started, payloadBytes: Buffer.byteLength(body) });
      await route.fulfill({ status: 200, contentType, body });
    });
    return { page, origin, variant };
  }
  async function paint(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function reportReady(page, groupBy) {
    await page.waitForFunction(() => Boolean(document.querySelector('.personalCallStats dd')?.textContent?.match(/[0-9]/)) && ![...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('Loading your usage report')));
    if (groupBy) await page.getByRole('heading', { name: `By ${groupBy}`, exact: true }).waitFor();
    await paint(page);
  }
  async function eventsReady(page) {
    await page.waitForFunction(() => document.querySelectorAll('.personalEvents > li').length > 0 && ![...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('Loading recent model calls')));
    await paint(page);
  }
  async function connected(page) { await page.waitForFunction(() => document.querySelector('.connectionMeta strong')?.textContent === 'Connected'); }
  async function screenshot(page, filename) {
    await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; });
    await page.screenshot({ path: join(evidenceDir, filename), fullPage: true, animations: 'disabled' });
    screenshots.push({ path: join(evidenceDir, filename), bytes: (await stat(join(evidenceDir, filename))).size, viewport: page.viewportSize(), metadataOnly: true });
  }
  try {
    const baselineOrigin = await preview(baselineRoot, 4321), candidateOrigin = await preview(candidateRoot, 4322, frozenCandidate);
    browser = await chromium.launch({ headless: true });
    const before = await makePage('baseline', baselineOrigin), after = await makePage('candidate', candidateOrigin);
    const nav = { baseline: [], candidate: [] }, navEvidence = [];
    for (let sample = 0; sample < 8; sample++) {
      for (const target of sample % 2 ? [after, before] : [before, after]) {
        const requestStart = requests.length, start = performance.now();
        await target.page.goto(target.origin + '/dashboard/home', { waitUntil: 'domcontentloaded' });
        await connected(target.page);
        if (target.variant === 'baseline') { await target.page.waitForFunction(() => document.querySelector('.dashboardStats') && !document.querySelector('.usageFreshness')); await paint(target.page); }
        else await reportReady(target.page);
        nav[target.variant].push(performance.now() - start);
        // Excluded from timing: drain detached quota/event reads before next trial.
        await target.page.waitForLoadState('networkidle');
        navEvidence.push({ variant: target.variant, sample, navigationMs: nav[target.variant].at(-1), domNodes: await target.page.locator('*').count(), requests: requests.slice(requestStart).filter(row => row.variant === target.variant) });
      }
    }
    await screenshot(before.page, 'baseline-home-desktop.png');
    await screenshot(after.page, 'candidate-home-desktop.png');
    const opening = [], openingReport = [];
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      await after.page.getByRole('button', { name: 'Open My usage', exact: true }).click();
      await after.page.getByRole('heading', { name: 'My usage', exact: true }).waitFor();
      await reportReady(after.page, 'model'); openingReport.push(performance.now() - start);
      await eventsReady(after.page); opening.push(performance.now() - start);
      if (sample !== 5) { await after.page.getByRole('button', { name: 'Dashboard', exact: true }).click(); await after.page.getByRole('button', { name: 'Open My usage', exact: true }).waitFor(); }
    }
    const direct = await makePage('candidate-direct', candidateOrigin), directReport = [], directEvents = [];
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      await direct.page.goto(candidateOrigin + '/dashboard/my-usage', { waitUntil: 'domcontentloaded' });
      await connected(direct.page); await reportReady(direct.page, 'model'); directReport.push(performance.now() - start);
      await eventsReady(direct.page); directEvents.push(performance.now() - start);
      await direct.page.waitForLoadState('networkidle');
    }
    const interactions = {};
    async function interaction(name, action, ready) {
      const startRequests = requests.length, start = performance.now();
      await action(); await ready();
      (interactions[name] ??= []).push({ ms: performance.now() - start, requests: requests.slice(startRequests).filter(row => row.variant === 'candidate') });
    }
    for (let sample = 0; sample < 6; sample++) {
      for (const group of ['provider', 'key', 'model']) await interaction(`group-${group}`, () => after.page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption(group), () => reportReady(after.page, group));
      for (const [group, value] of [['model', 'model-0'], ['provider', 'openai'], ['key', 'key-0']]) {
        if (group !== 'model') { await after.page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption(group); await reportReady(after.page, group); }
        await interaction(`filter-${group}`, () => after.page.getByRole('button', { name: value, exact: true }).click(), () => reportReady(after.page, group));
        const details = after.page.locator('.personalAdvanced');
        if ((await details.getAttribute('open')) === null) await after.page.getByText('Custom dates & exact filters', { exact: true }).click();
        await interaction(`clear-${group}-filter`, () => after.page.getByRole('button', { name: 'Clear filters', exact: true }).click(), () => reportReady(after.page, group));
      }
      await after.page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('model'); await reportReady(after.page, 'model');
      await interaction('refresh-model-report', () => after.page.getByRole('button', { name: 'Refresh report', exact: true }).click(), () => reportReady(after.page, 'model'));
    }
    for (let sample = 0; sample < 6; sample++) {
      for (const days of [30, 7]) await interaction(`range-${days}d`, () => after.page.getByRole('button', { name: `Last ${days} days`, exact: true }).click(), () => reportReady(after.page, 'model'));
    }
    await eventsReady(after.page);
    await screenshot(after.page, 'candidate-my-usage-desktop.png');
    const mobile = await makePage('candidate-mobile', candidateOrigin, { width: 393, height: 851 });
    await mobile.page.goto(candidateOrigin + '/dashboard/my-usage'); await reportReady(mobile.page, 'model'); await eventsReady(mobile.page);
    await screenshot(mobile.page, 'candidate-my-usage-mobile.png');
    const mobileOverflow = await mobile.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    return {
      chromium: browser.version(), baselineCommit: '6fceb88', assets: { baseline: await assets(baselineRoot), candidate: await assets(candidateRoot, frozenCandidate) },
      methodology: { bridge: 'Playwright intercepts /v1 metadata only; report/events and non-budgets-only usage perform real Node loopback HTTP to the same seeded workerd. No mock report values/delays. Empty budgets-only metadata bypasses legacy scan only when requested by UI.', navigation: '8 navigations/frontend, alternating baseline/candidate. First = fresh browser context; warm = 7 reloads. Routing disables browser HTTP cache. Backend already API-warm. Baseline usable = Connected + loaded legacy usage; candidate usable = Connected + personal summary rendered. Both end after two animation frames. Detached requests drain to networkidle outside timing before the next trial; no cross-trial backend overlap. Candidate assets are frozen at browser-run start.', interaction: 'Click/select through report-render-ready plus two animation frames. First/repeated samples remain separate; firstFetchedReport and requests identify frontend cache misses. Refresh clears report cache; matching grouping/filter repeats may hit it. No assertion of process/disk-cold backend. Full My usage separately records report-ready and events-ready.', auth: 'Controlled synthetic authenticated owner metadata; actual Cloudflare Access verification and policy/budget metadata resolution are excluded.' },
      home: Object.fromEntries(Object.entries(nav).map(([key, values]) => [key, { firstFreshContextMs: values[0], warm: summaries(values.slice(1)) }])), navigationSamples: navEvidence,
      openMyUsage: { reportReady: { firstMs: openingReport[0], warm: summaries(openingReport.slice(1)) }, eventsReady: { firstMs: opening[0], warm: summaries(opening.slice(1)) } },
      directMyUsage: { reportReady: { firstFreshContextMs: directReport[0], warmReloads: summaries(directReport.slice(1)) }, eventsReady: { firstFreshContextMs: directEvents[0], warmReloads: summaries(directEvents.slice(1)) } },
      interactions: Object.fromEntries(Object.entries(interactions).map(([key, values]) => [key, { firstMs: values[0].ms, firstFetchedReport: values[0].requests.some(row => row.path.includes('/report?')), repeated: summaries(values.slice(1).map(row => row.ms)), samples: values }])),
      screenshots, mobileOverflow, errors, requests,
    };
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {}))); await browser?.close();
    await Promise.all(previews.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); })));
  }
}
