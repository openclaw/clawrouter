import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticFixture, createRequestObservation, createSemanticsFixture, fixtureOrigin } from "../scripts/search-semantics-fixture.mjs";

const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const token = "fixture-only-observation-token-00000000000000000";
const control = `${fixtureOrigin}/search-semantics/_control/observations`;
const auth = { authorization: `Bearer ${token}` };
const internalEvent = "https://fixture-observations.internal/event";
const mainEnv = { CF_VERSION_METADATA: { id: "synthetic-main-version" } };
const bucket = (path, method, query, status, count) => ({ path, method, query, status, count });

async function runtime(t, { oldObserver = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "search-observations-test-"));
  const bundle = await build({ stdin: { contents: `
    export { default } from "./worker/fixtures/search-semantics-observe.ts";
    import { SearchSemanticsObject as ObservedObject } from "./worker/fixtures/search-semantics-observe.ts";
    export class SearchSemanticsObject extends ObservedObject {
      constructor(state, env) { super(state, env); this.testStorage = state.storage; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture-expire-observations") {
          const value = await this.testStorage.get("observations"); value.expiresAt = Date.now() - 1;
          await this.testStorage.put("observations", value); return new Response(null);
        }
        if (path === "/fixture-saturate") {
          const value = await this.testStorage.get("observations"); value.counters[0].count = 1000000;
          await this.testStorage.put("observations", value); return new Response(null);
        }
        if (path === "/fixture-fail-records") { await this.testStorage.put("failRecords", true); return new Response(null); }
        if (request.url === "${internalEvent}" && await this.testStorage.get("failRecords")) throw new Error("synthetic observation failure");
        if (path === "/fixture-fire-alarm") { await super.alarm(); return new Response(null); }
        if (path === "/fixture-state") return Response.json({ keys: [...(await this.testStorage.list()).keys()], alarm: await this.testStorage.getAlarm() });
        return super.fetch(request);
      }
    }`, resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  const mainBundle = await build({ stdin: { contents: 'export { default } from "./worker/index.ts";', resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  const oldBundle = oldObserver && await build({ entryPoints: ["worker/fixtures/search-semantics.ts"], write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  let forwards = 0, main;
  const mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: temporary, workers: [{ name: "fixture", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-06-05",
    bindings: { SEARCH_SEMANTICS_ENVIRONMENT: "fakeco", SEARCH_SEMANTICS_CONTROL_SHA256: createHash("sha256").update(token).digest("hex") },
    durableObjects: { SEARCH_SEMANTICS: { className: "SearchSemanticsObject", useSQLite: true, ...(oldObserver ? { scriptName: "old-object" } : {}) } },
    serviceBindings: { SEARCH_SEMANTICS_ROBOTS_ORIGIN: async request => { forwards++; return main.fetch(request); } },
    outboundService: () => { throw new Error("observation fixture must never call an upstream"); },
  }, { name: "main", modules: true, script: mainBundle.outputFiles[0].text, compatibilityDate: "2026-06-05", bindings: mainEnv,
    outboundService: () => { throw new Error("robots must not call an upstream"); },
  }, ...(oldObserver ? [{ name: "old-object", modules: true, script: oldBundle.outputFiles[0].text, compatibilityDate: "2026-06-05",
    durableObjects: { SEARCH_SEMANTICS: { className: "SearchSemanticsObject", useSQLite: true } },
  }] : [])] }));
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  await mf.ready;
  main = await mf.getWorker("main");
  const fetcher = (url, init) => mf.dispatchFetch(url, init);
  const namespace = await mf.getDurableObjectNamespace("SEARCH_SEMANTICS", "fixture");
  const observer = namespace.get(namespace.idFromName("request-observations-v1"));
  const registry = namespace.get(namespace.idFromName("fixture-v1"));
  return { fetcher, observer, registry, main, forwards: () => forwards };
}

test("readiness identifies the observation class without allocating session state", async t => {
  const { fetcher, observer } = await runtime(t);
  const response = await fetcher(`${control}/ready`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawrouter-observation-handler"), "observations-v1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ready: true, protocol: "observations-v1" });
  assert.deepEqual(await (await observer.fetch("https://fixture/fixture-state")).json(), { keys: [], alarm: null });
  const empty = await fetcher(control, { headers: auth });
  assert.equal(empty.status, 404);
  assert.equal(empty.headers.get("x-clawrouter-observation-handler"), "observations-v1", "empty state differs from an old handler");
  for (const [target, headers] of [[`${control}/ready`, {}], [`${control}/ready?query=1`, auth], [`${control}/ready`.replace("https:", "http:"), auth]]) {
    const denied = await fetcher(target, { headers });
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get("x-clawrouter-observation-handler"), null);
  }
});

test("mixed Worker and old object versions stop before observation creation", async t => {
  const { fetcher } = await runtime(t, { oldObserver: true });
  const methods = [];
  await assert.rejects(createRequestObservation({ token, fetcher: (url, init) => { methods.push(init.method); return fetcher(url, init); } }), /control request succeeds \(HTTP 404\)/);
  assert.deepEqual(methods, ["GET"], "a readiness failure must not replay or attempt creation");
  const empty = await fetcher(control, { headers: auth });
  assert.equal(empty.status, 404);
  assert.equal(empty.headers.get("x-clawrouter-observation-handler"), null, "404 alone cannot establish cleared observation storage");
});

test("readiness rejects unknown handlers and failures retain only their HTTP status", async () => {
  for (const [body, headers] of [[{ ready: true, protocol: "observations-v1" }, {}], [{ ready: true, protocol: "unknown" }, { "x-clawrouter-observation-handler": "observations-v1" }]]) {
    let calls = 0;
    await assert.rejects(createRequestObservation({ token, fetcher: async () => { calls++; return Response.json(body, { headers }); } }), /observation handler/);
    assert.equal(calls, 1, "invalid readiness cannot reach POST");
  }
  await assert.rejects(createRequestObservation({ token, fetcher: async () => new Response("SYNTHETIC_PRIVATE_BODY", { status: 503 }) }), error => {
    assert.match(error.message, /HTTP 503/);
    assert.equal(error.message.includes("SYNTHETIC_PRIVATE_BODY"), false);
    return true;
  });
});

test("observation captures robots metadata while forwarding actual main Worker responses unchanged", async t => {
  const { fetcher, forwards, main } = await runtime(t);
  const session = await createRequestObservation({ token, fetcher });
  for (const [path, method] of [["/robots.txt", "GET"], ["/robots.txt", "HEAD"], ["/robots.txt?private=SYNTHETIC_QUERY", "GET"], ["/robots.txt.extra", "POST"]]) {
    const options = { method, headers: { "x-request-id": "SYNTHETIC_ROBOTS_REQUEST", "user-agent": "SYNTHETIC_AGENT", cookie: "SYNTHETIC_COOKIE" }, ...(method === "POST" ? { body: "SYNTHETIC_BODY" } : {}) };
    const expected = await main.fetch(new Request(fixtureOrigin + path, options));
    const actual = await fetcher(fixtureOrigin + path, options);
    assert.equal(actual.status, expected.status);
    // Workers suppress HEAD bodies at the transport boundary.
    assert.equal(await actual.text(), method === "HEAD" ? "" : await expected.text());
    for (const name of ["content-type", "cache-control", "x-clawrouter-request-id", "x-clawrouter-error-code", "x-clawrouter-version-id"]) assert.equal(actual.headers.get(name), expected.headers.get(name));
  }
  assert.equal(forwards(), 4);
  const value = await session.snapshot();
  assert.deepEqual(value.counters, [bucket("robots", "GET", false, 404, 1), bucket("robots", "HEAD", false, 404, 1), bucket("robots", "GET", true, 404, 1), bucket("robots_variant", "POST", false, 404, 1)]);
  for (const text of ["SYNTHETIC_QUERY", "SYNTHETIC_BODY", "SYNTHETIC_AGENT", "SYNTHETIC_COOKIE", "SYNTHETIC_ROBOTS_REQUEST", token, "/robots.txt", "authorization"]) assert.equal(JSON.stringify(value).includes(text), false);
  await session.close();
});

test("observations include rejected fixture variants without changing diagnostic/matrix behavior", async t => {
  const { fetcher } = await runtime(t);
  const matrix = await createSemanticsFixture({ token, fetcher });
  const diagnostic = await createDiagnosticFixture({ token, fetcher });
  const session = await createRequestObservation({ token, fetcher });
  assert.deepEqual(await session.snapshot(), session.initial, "private controls do not count themselves");
  const gets = await Promise.all(Array.from({ length: 20 }, () => fetcher(diagnostic.url)));
  assert.ok((await gets[0].text()).includes(diagnostic.initial.marker));
  for (const init of [{ method: "HEAD" }, { method: "POST", body: "SYNTHETIC_BODY" }]) await fetcher(diagnostic.url, init);
  assert.equal((await fetcher(`${diagnostic.url}?private=SYNTHETIC_QUERY`)).status, 404);
  assert.equal((await fetcher(`${diagnostic.url}/`)).status, 404);
  assert.equal((await fetcher(`${fixtureOrigin}/search-semantics/not-registered`)).status, 404);
  assert.equal((await fetcher(matrix.url("live"))).status, 200);
  const observed = await session.snapshot();
  assert.deepEqual(observed.counters, [bucket("diagnostic", "GET", false, 200, 20), bucket("diagnostic", "HEAD", false, 200, 1), bucket("diagnostic", "POST", false, 404, 1), bucket("diagnostic", "GET", true, 404, 1), bucket("diagnostic_variant", "GET", false, 404, 1), bucket("fixture_other", "GET", false, 404, 1), bucket("matrix", "GET", false, 200, 1)]);
  assert.equal(observed.expiresAt, session.initial.expiresAt, "traffic never extends retention");
  assert.equal(JSON.stringify(observed).includes(diagnostic.initial.marker), false);
  assert.equal(JSON.stringify(observed).includes(matrix.initial.id), false);
  assert.equal((await diagnostic.snapshot()).gets, 20);
  assert.equal((await diagnostic.snapshot()).heads, 1);
  assert.equal((await matrix.snapshot()).pages.live.gets, 1);
  await session.close();
  assert.equal((await diagnostic.snapshot()).gets, 20, "observation deletion preserves diagnostic");
  assert.equal((await matrix.snapshot()).pages.live.gets, 1);
  await diagnostic.close(); await matrix.close();
});

test("observation controls require strict authentication, creation and owned deletion", async t => {
  const { fetcher, observer, forwards } = await runtime(t);
  for (const target of [control, `${control}/anything`, control.replace("https:", "http:"), `${control}?query=1`, control.replace("clawrouter-fakeco", "clawrouter")]) {
    assert.equal((await fetcher(target, { method: "POST", body: '{"ttlSeconds":300}' })).status, 404);
  }
  for (const body of ["{}", "null", '{"ttlSeconds":301}', '{"ttlSeconds":300,"extra":true}', "x".repeat(129)]) assert.equal((await fetcher(control, { method: "POST", headers: auth, body })).status, 400);
  assert.equal((await fetcher(`${control}?query=1`, { method: "POST", headers: auth, body: '{"ttlSeconds":300}' })).status, 404);
  const first = await createRequestObservation({ token, fetcher });
  await assert.rejects(createRequestObservation({ token, fetcher }), /control request succeeds/);
  assert.equal((await fetcher(control, { method: "DELETE", headers: auth })).status, 404);
  assert.equal((await fetcher(`${control}/00000000-0000-0000-0000-000000000000`, { method: "DELETE", headers: auth })).status, 404);
  assert.equal((await fetcher(`${fixtureOrigin}/event`, { method: "POST", body: JSON.stringify(bucket("robots", "GET", false, 200, 1)) })).status, 404);
  assert.equal((await fetcher(control.replace("clawrouter-fakeco", "clawrouter"), { headers: auth })).status, 404);
  assert.deepEqual(await first.snapshot(), first.initial);
  await first.close();
  const second = await createRequestObservation({ token, fetcher });
  await assert.rejects(first.close(), /control request succeeds/);
  await assert.rejects(first.snapshot(), /control request succeeds/);
  assert.deepEqual(await second.snapshot(), second.initial);
  await second.close();
  for (const target of [control, `${control}/${second.initial.id}`]) assert.equal((await fetcher(target, { headers: auth })).status, 404);
  assert.deepEqual(await (await observer.fetch("https://fixture/fixture-state")).json(), { keys: [], alarm: null });
  assert.equal(forwards(), 0);
});

test("observation expiry and alarm are independent of the existing registry", async t => {
  const { fetcher, observer, registry } = await runtime(t);
  const matrix = await createSemanticsFixture({ token, fetcher });
  const diagnostic = await createDiagnosticFixture({ token, fetcher, ttlSeconds: 7200 });
  const session = await createRequestObservation({ token, fetcher });
  const state = async object => (await object.fetch("https://fixture/fixture-state")).json();
  assert.equal((await state(observer)).alarm, session.initial.expiresAt);
  assert.equal((await state(registry)).alarm, matrix.initial.expiresAt);
  await observer.fetch("https://fixture/fixture-expire-observations");
  await assert.rejects(session.snapshot(), /control request succeeds/, "expiry enforced before alarm execution");
  assert.deepEqual(await state(observer), { keys: [], alarm: null });
  const second = await createRequestObservation({ token, fetcher });
  await observer.fetch("https://fixture/fixture-expire-observations");
  await observer.fetch("https://fixture/fixture-fire-alarm");
  await assert.rejects(second.snapshot(), /control request succeeds/);
  assert.deepEqual(await state(observer), { keys: [], alarm: null });
  assert.equal((await state(registry)).alarm, matrix.initial.expiresAt);
  assert.deepEqual(await matrix.snapshot(), matrix.initial);
  assert.deepEqual(await diagnostic.snapshot(), diagnostic.initial);
  await diagnostic.close(); await matrix.close();
});

test("observation schema, counter cardinality and numeric counts remain bounded", async t => {
  const { fetcher, observer } = await runtime(t);
  const session = await createRequestObservation({ token, fetcher });
  for (const event of [{ path: "SYNTHETIC_RAW_PATH", method: "GET", query: false, status: 200 }, { path: "robots", method: "GET", query: "SYNTHETIC_QUERY", status: 200 }, { path: "robots", method: "GET", query: false, status: 200, raw: "SYNTHETIC_HEADER" }]) assert.equal((await observer.fetch(internalEvent, { method: "POST", body: JSON.stringify(event) })).status, 400);
  for (let status = 100; status < 230; status++) await observer.fetch(internalEvent, { method: "POST", body: JSON.stringify({ path: "robots", method: "GET", query: false, status }) });
  const value = await session.snapshot();
  assert.equal(value.counters.length, 128); assert.equal(value.overflow, 2);
  assert.equal(value.expiresAt, session.initial.expiresAt);
  await observer.fetch("https://fixture/fixture-saturate");
  await observer.fetch(internalEvent, { method: "POST", body: JSON.stringify({ path: "robots", method: "GET", query: false, status: 100 }) });
  const saturated = await session.snapshot();
  assert.equal(saturated.counters[0].count, 1_000_000); assert.equal(saturated.saturated, true);
  await session.close();
});

test("inactive observation stores nothing and capture failure preserves public responses", async t => {
  const { fetcher, observer } = await runtime(t);
  assert.equal((await fetcher(`${fixtureOrigin}/robots.txt`)).status, 404);
  assert.equal((await fetcher(`${fixtureOrigin}/search-semantics/unknown`)).status, 404);
  assert.deepEqual(await (await observer.fetch("https://fixture/fixture-state")).json(), { keys: [], alarm: null });
  const session = await createRequestObservation({ token, fetcher });
  await observer.fetch("https://fixture/fixture-fail-records");
  assert.equal((await fetcher(`${fixtureOrigin}/robots.txt`)).status, 404);
  const response = await fetcher(`${fixtureOrigin}/search-semantics/health`);
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.deepEqual(await session.snapshot(), session.initial, "capture failure can leave zero counters; absence is inconclusive");
  await session.close();
});
