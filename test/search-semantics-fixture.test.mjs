import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemanticsFixture, fixtureControlToken, fixtureOrigin, prepareSemanticsCredential, startHostedSearchOrigin } from "../scripts/search-semantics-fixture.mjs";

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
        if (new URL(request.url).pathname === "/fixture-expire") {
          const runs = await this.fixtureStorage.get("runs");
          runs[0].expiresAt = Date.now() - 1;
          await this.fixtureStorage.put("runs", runs);
          return new Response(null);
        }
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
