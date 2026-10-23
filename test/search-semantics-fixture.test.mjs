import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticFixture, createSemanticsFixture, fixtureControlToken, fixtureOrigin, prepareSemanticsCredential, startHostedSearchOrigin } from "../scripts/search-semantics-fixture.mjs";

const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const token = "fixture-only-control-token-00000000000000000000";

async function runtime(t) {
  const temporary = await mkdtemp(join(tmpdir(), "search-semantics-test-"));
  const bundle = await build({ stdin: { contents: `
    export { default } from "./worker/fixtures/search-semantics.ts";
    import { SearchSemanticsObject as RealObject } from "./worker/fixtures/search-semantics.ts";
    export class SearchSemanticsObject extends RealObject {
      constructor(state) { super(state); this.fixtureStorage = state.storage; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture-expire") {
          const runs = await this.fixtureStorage.get("runs");
          runs[0].expiresAt = Date.now() - 1;
          await this.fixtureStorage.put("runs", runs);
          return new Response(null);
        }
        if (path === "/fixture-expire-diagnostic") {
          const diagnostic = await this.fixtureStorage.get("diagnostic");
          diagnostic.expiresAt = Date.now() - 1;
          await this.fixtureStorage.put("diagnostic", diagnostic);
          return new Response(null);
        }
        if (path === "/fixture-fire-alarm") { await super.alarm(); return new Response(null); }
        if (path === "/fixture-registry") return Response.json({ alarm: await this.fixtureStorage.getAlarm(), diagnosticStored: !!(await this.fixtureStorage.get("diagnostic")) });
        return super.fetch(request);
      }
    }`, resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  const mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, workers: [{ name: "fixture", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-06-05",
    bindings: { SEARCH_SEMANTICS_ENVIRONMENT: "fakeco", SEARCH_SEMANTICS_CONTROL_SHA256: createHash("sha256").update(token).digest("hex") },
    durableObjects: { SEARCH_SEMANTICS: { className: "SearchSemanticsObject", useSQLite: true } },
    outboundService: () => { throw new Error("fixture must never call an upstream"); },
  }] }));
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  await mf.ready;
  const fetcher = (url, init) => mf.dispatchFetch(url, init);
  const fixture = await createSemanticsFixture({ token, fetcher });
  return { mf, fetcher, fixture };
}

test("workerd fixture: hidden markers, concurrent durable counters, rotation, links and deletion", async t => {
  const { fixture, fetcher } = await runtime(t);
  const initial = fixture.initial;
  assert.deepEqual(Object.values(initial.pages).map(page => page.gets), [0, 0, 0, 0], "control readiness never primes pages");
  assert.equal(new Set(Object.values(initial.pages).map(page => page.marker)).size, 4);
  assert.ok(!fixture.url("live").includes(initial.pages.live.marker));
  const responses = await Promise.all(Array.from({ length: 25 }, () => fetcher(fixture.url("live"))));
  assert.ok(responses.every(response => response.status === 200));
  const html = await responses[0].text();
  assert.ok(html.includes(initial.pages.live.marker));
  assert.ok(html.includes(fixture.url("child")));
  assert.equal(responses[0].headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(responses[0].headers.get("cache-control"), "public, max-age=3600");
  const head = await fetcher(fixture.url("live"), { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal((await fixture.snapshot()).pages.live.gets, 25);
  assert.equal((await fixture.snapshot()).pages.live.heads, 1);
  await fetcher(fixture.url("warm"));
  const rotated = await fixture.rotate();
  assert.notEqual(rotated.pages.warm.marker, initial.pages.warm.marker);
  assert.equal(rotated.pages.warm.id, initial.pages.warm.id);
  assert.equal(rotated.pages.warm.gets, 1);
  assert.equal(rotated.pages.warm.revisionGets, 0);
  assert.equal(rotated.pages.warm.revision, 2);
  const changed = await fetcher(fixture.url("warm"));
  assert.ok((await changed.text()).includes(rotated.pages.warm.marker));
  assert.equal((await fixture.snapshot()).pages.warm.revisionGets, 1);
  await fixture.close();
  assert.equal((await fetcher(fixture.url("live"))).status, 404);
});

test("fixture rejects alternate hosts, query strings, unauthorized control, unregistered IDs, unsafe input and excess runs", async t => {
  const { fixture, fetcher } = await runtime(t);
  const controlUrl = `${fixtureOrigin}/search-semantics/_control/runs`;
  for (const headers of [{}, { authorization: "Bearer incorrect-fixture-token-0000000000000000000" }]) {
    assert.equal((await fetcher(controlUrl, { method: "POST", headers, body: "{}" })).status, 404);
  }
  assert.equal((await fetcher(fixture.url("live").replace("clawrouter-fakeco.openclaw.ai", "clawrouter.openclaw.ai"))).status, 404);
  assert.equal((await fetcher(`${fixture.url("live")}?cachebust=1`)).status, 404);
  assert.equal((await fetcher(`${fixtureOrigin}/v1/admin/policies`)).status, 404);
  assert.equal((await fetcher(fixture.url("live"), { method: "POST" })).status, 404);
  assert.equal((await fetcher(`${fixtureOrigin}/search-semantics/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000`)).status, 404);
  const headers = { authorization: `Bearer ${token}` };
  for (const body of ["null", "{}".repeat(100), '{"ttlSeconds":59}', '{"ttlSeconds":7201}', '{"marker":"override"}']) {
    assert.equal((await fetcher(controlUrl, { method: "POST", headers, body })).status, 400);
  }
  for (let index = 0; index < 15; index++) assert.equal((await fetcher(controlUrl, { method: "POST", headers, body: "{}" })).status, 201);
  assert.equal((await fetcher(controlUrl, { method: "POST", headers, body: "{}" })).status, 409);
  assert.equal((await fixture.snapshot()).pages.live.gets, 0);
});

test("expired runs are inaccessible even before their scheduled alarm executes", async t => {
  const { mf, fixture, fetcher } = await runtime(t);
  const namespace = await mf.getDurableObjectNamespace("SEARCH_SEMANTICS", "fixture");
  await namespace.get(namespace.idFromName("fixture-v1")).fetch("https://fixture/fixture-expire");
  assert.equal((await fetcher(fixture.url("live"))).status, 404);
  await assert.rejects(fixture.snapshot(), /control request succeeds/);
});

test("stable HTML diagnostic: unprimed marker, concurrent GET/HEAD counters, timestamps and cleanup", async t => {
  const { fixture, fetcher } = await runtime(t);
  const diagnostic = await createDiagnosticFixture({ token, fetcher });
  assert.equal(diagnostic.url, `${fixtureOrigin}/search-semantics/diagnostic`);
  assert.ok(!diagnostic.url.includes(diagnostic.initial.id));
  assert.ok(!diagnostic.url.includes(diagnostic.initial.marker));
  assert.deepEqual([diagnostic.initial.gets, diagnostic.initial.heads, diagnostic.initial.lastGetAt, diagnostic.initial.lastHeadAt], [0, 0, null, null]);
  assert.deepEqual(await diagnostic.snapshot(), diagnostic.initial, "private reads do not prime the public page");
  const heads = await Promise.all(Array.from({ length: 3 }, () => fetcher(diagnostic.url, { method: "HEAD" })));
  for (const response of heads) { assert.equal(response.status, 200); assert.equal(await response.text(), ""); }
  assert.equal((await diagnostic.snapshot()).gets, 0, "HEAD alone does not establish content retrieval");
  const responses = await Promise.all(Array.from({ length: 25 }, () => fetcher(diagnostic.url)));
  const html = await responses[0].text();
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<title>FakeCo retrieval diagnostic<\/title>/);
  assert.ok(html.includes(diagnostic.initial.marker));
  assert.ok(!html.includes(diagnostic.initial.id));
  for (const response of [...heads, ...responses]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    for (const header of ["cache-control", "cloudflare-cdn-cache-control", "cdn-cache-control"]) assert.equal(response.headers.get(header), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), null, "ordinary synthetic HTML control has no noindex variable");
    assert.ok(!JSON.stringify([...response.headers]).includes(diagnostic.initial.marker));
  }
  const observed = await diagnostic.snapshot();
  assert.equal(observed.gets, 25); assert.equal(observed.heads, 3);
  assert.ok(observed.lastGetAt >= observed.lastHeadAt);
  assert.equal(observed.marker, diagnostic.initial.marker);
  assert.equal((await fixture.snapshot()).pages.live.gets, 0, "existing matrix run remains independent");
  await diagnostic.close();
  for (const method of ["GET", "HEAD"]) assert.equal((await fetcher(diagnostic.url, { method })).status, 404);
  await assert.rejects(diagnostic.snapshot(), /control request succeeds/);
});

test("diagnostic requires authenticated bounded creation and generation-scoped deletion", async t => {
  const { fetcher } = await runtime(t);
  const url = `${fixtureOrigin}/search-semantics/diagnostic`;
  const control = `${fixtureOrigin}/search-semantics/_control/diagnostic`;
  const headers = { authorization: `Bearer ${token}` };
  for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) assert.equal((await fetcher(url, { method })).status, 404);
  assert.equal((await fetcher(control, { headers })).status, 404, "public requests cannot provision a generation");
  for (const body of ["{}", '{"ttlSeconds":60}']) assert.equal((await fetcher(control, { method: "POST", body })).status, 404);
  for (const body of ["null", "{}".repeat(100), '{"ttlSeconds":59}', '{"ttlSeconds":7201}', '{"marker":"override"}']) {
    assert.equal((await fetcher(control, { method: "POST", headers, body })).status, 400);
  }
  const first = await createDiagnosticFixture({ token, fetcher });
  assert.equal((await fetcher(control, { headers })).status, 200);
  await assert.rejects(createDiagnosticFixture({ token, fetcher }), /control request succeeds/);
  assert.equal((await fetcher(`${control}/00000000-0000-0000-0000-000000000000`, { method: "DELETE", headers })).status, 404);
  assert.equal((await fetcher(control, { method: "DELETE", headers })).status, 404, "collection deletion is never allowed");
  for (const target of [url.replace("clawrouter-fakeco", "clawrouter"), url.replace("https:", "http:"), `${url}?q=1`, `${url}/`]) {
    assert.equal((await fetcher(target)).status, 404);
  }
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetcher(url, { method })).status, 404);
  assert.deepEqual(await first.snapshot(), first.initial, "rejected requests and failed creation leave the owned generation unchanged");
  await first.close();
  const second = await createDiagnosticFixture({ token, fetcher });
  assert.equal(second.url, first.url);
  assert.notEqual(second.initial.id, first.initial.id);
  assert.notEqual(second.initial.marker, first.initial.marker);
  await assert.rejects(first.close(), /control request succeeds/, "stale cleanup cannot delete a replacement generation");
  await assert.rejects(first.snapshot(), /control request succeeds/);
  assert.deepEqual(await second.snapshot(), second.initial);
  await second.close();
});

test("diagnostic expiry and the shared alarm preserve existing runs and clear both registries", async t => {
  const { mf, fixture, fetcher } = await runtime(t);
  const namespace = await mf.getDurableObjectNamespace("SEARCH_SEMANTICS", "fixture");
  const object = namespace.get(namespace.idFromName("fixture-v1"));
  const inspect = async () => (await object.fetch("https://fixture/fixture-registry")).json();
  const first = await createDiagnosticFixture({ token, fetcher, ttlSeconds: 60 });
  await fixture.snapshot();
  assert.equal((await inspect()).alarm, first.initial.expiresAt, "reading an existing run cannot postpone diagnostic expiry");
  await object.fetch("https://fixture/fixture-expire-diagnostic");
  assert.equal((await fetcher(first.url, { method: "HEAD" })).status, 404, "expired content is unavailable before an alarm");
  await assert.rejects(first.snapshot(), /control request succeeds/);
  assert.deepEqual(await inspect(), { alarm: fixture.initial.expiresAt, diagnosticStored: false });
  const second = await createDiagnosticFixture({ token, fetcher, ttlSeconds: 60 });
  await object.fetch("https://fixture/fixture-expire-diagnostic");
  await object.fetch("https://fixture/fixture-fire-alarm");
  assert.equal((await fetcher(second.url)).status, 404);
  assert.deepEqual(await fixture.snapshot(), fixture.initial);
  assert.deepEqual(await inspect(), { alarm: fixture.initial.expiresAt, diagnosticStored: false });
  await fixture.close();
  assert.equal((await inspect()).alarm, null);
  const alone = await createDiagnosticFixture({ token, fetcher });
  assert.equal((await inspect()).alarm, alone.initial.expiresAt, "diagnostic expires even without matrix runs");
  await alone.close();
  assert.deepEqual(await inspect(), { alarm: null, diagnosticStored: false });
});

test("native adapter counts HEAD as origin activity and derives a purpose-separated control token", async t => {
  const { fetcher } = await runtime(t);
  const native = await startHostedSearchOrigin("cached", { token, fetcher });
  assert.equal(await native.count(), 0);
  await fetcher(native.url, { method: "HEAD" });
  assert.deepEqual(await native.observations(), { requests: 1, gets: 0 });
  await native.close();
  const admin = "fixture-only-admin-".repeat(4);
  assert.match(fixtureControlToken(admin), /^[a-f0-9]{64}$/);
  assert.equal(fixtureControlToken(admin), fixtureControlToken(admin));
  assert.notEqual(fixtureControlToken(admin), createHash("sha256").update(admin).digest("hex"));
  const credential = prepareSemanticsCredential(admin, undefined, 0);
  const secret = credential.key.split("-").at(-1);
  assert.notEqual(secret, fixtureControlToken(admin));
  assert.equal(credential.registration.secretSha256, createHash("sha256").update(secret).digest("hex"));
  assert.equal(credential.registration.expiresAt, "1970-01-01T02:00:00.000Z");
  assert.ok(!JSON.stringify(credential.registration).includes(secret));
  assert.notEqual(prepareSemanticsCredential(admin, "codex_search_semantics_fresh_20261022").key, credential.key);
});
