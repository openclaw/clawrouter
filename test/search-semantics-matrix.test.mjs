import assert from "node:assert/strict";
import test from "node:test";
import { searchSemanticsMatrix } from "../scripts/search-semantics-matrix.mjs";
import { searchProbeSummary, directSearchProbe } from "../scripts/standalone-search-probe.mjs";

function harness({ liveAvailable = true, cachedFetch = false, cachedWarmFetch = false, lateCachedFetch = false, leakedMarker = false, headOnly = false, warmMiss = false } = {}) {
  const initial = { id: "fixture-run", pages: Object.fromEntries(["cached", "live", "warm", "child"].map(name => [name, { marker: `hidden-${name}-A`, revision: 1, gets: 0, heads: 0, revisionGets: 0 }])) };
  let run = structuredClone(initial);
  const fixture = { initial, url: name => `https://synthetic.invalid/${name}`, snapshot: async () => structuredClone(run), rotate: async () => {
    run.pages.warm.marker = "hidden-warm-B"; run.pages.warm.revision++; run.pages.warm.revisionGets = 0;
    return structuredClone(run);
  } };
  const bodies = [];
  async function probe({ body, marker }) {
    bodies.push(body);
    assert.ok(!JSON.stringify(body).includes("hidden-"), "commands never reveal markers");
    const mode = body.settings.external_web_access ? "live" : "cached";
    const pageName = body.commands.click || body.commands.find ? "child" : body.commands.open[0].ref_id.split("/").at(-1);
    const page = run.pages[pageName];
    const fetching = mode === "live" ? liveAvailable : cachedFetch || cachedWarmFetch && pageName === "warm";
    if (lateCachedFetch && pageName === "live") run.pages.cached.heads++;
    let output = "Internal Error";
    if (fetching) {
      if (headOnly) page.heads++; else { page.gets++; page.revisionGets++; }
      output = `${page.marker} 【turn0view0】 \u30101\u2020Controlled child page\u3011`;
    } else if (mode === "cached" && pageName === "warm" && !warmMiss) output = initial.pages.warm.marker;
    else if (leakedMarker) output = page.marker;
    const value = { output };
    return { value, summary: searchProbeSummary(new Response(null), value, marker) };
  }
  return { fixture, probe, bodies, settle: async () => {} };
}

test("independent fresh sessions, warm-cache rotation, live refresh, click/find produce closed evidence", async () => {
  const fixture = harness();
  const result = await searchSemanticsMatrix({ ...fixture, model: "gpt-6.1-sol" });
  assert.equal(result.status, "observed");
  for (const name of ["liveControl", "cacheOnlyObserved", "warmCacheObserved", "liveRefreshObserved", "navigationObserved"]) assert.equal(result[name], true, name);
  assert.equal(fixture.bodies.length, 7);
  assert.equal(new Set(fixture.bodies.slice(0, 5).map(body => body.id)).size, 5, "mode stages cannot reuse server session history");
  assert.equal(fixture.bodies[4].id, fixture.bodies[5].id, "navigation retains its own reference session");
  assert.doesNotMatch(JSON.stringify(result), /hidden-|synthetic\.invalid/);
});

test("two modes failing HTTP-200 is inconclusive and stops after two operations", async () => {
  const fixture = harness({ liveAvailable: false });
  const result = await searchSemanticsMatrix({ ...fixture, model: "gpt-6-astra" });
  assert.equal(result.status, "inconclusive"); assert.equal(result.cacheOnlyObserved, false);
  assert.equal(fixture.bodies.length, 2);
});

test("cached origin fetch or unseen-marker return is a violation; HEAD alone cannot qualify live retrieval", async () => {
  for (const options of [{ cachedFetch: true }, { leakedMarker: true }]) {
    const result = await searchSemanticsMatrix({ ...harness(options), model: "gpt-6.1-sol" });
    assert.equal(result.status, "violation");
  }
  const result = await searchSemanticsMatrix({ ...harness({ headOnly: true }), model: "gpt-6.1-sol" });
  assert.equal(result.status, "inconclusive");
});

test("warm-cache miss is weaker than stale-content evidence and reported separately", async () => {
  const result = await searchSemanticsMatrix({ ...harness({ warmMiss: true }), model: "gpt-6.1-sol" });
  assert.equal(result.status, "observed");
  assert.equal(result.cacheOnlyObserved, true); assert.equal(result.warmCacheObserved, false);
});

test("warm cached origin access and late fresh cached HEAD requests remain violations", async () => {
  for (const options of [{ cachedWarmFetch: true }, { lateCachedFetch: true }]) {
    const result = await searchSemanticsMatrix({ ...harness(options), model: "gpt-6.1-sol" });
    assert.equal(result.status, "violation"); assert.equal(result.cacheOnlyObserved, false);
  }
});

test("routed probe locks destination, requires retention off and preserves explicit mode", async () => {
  const body = { model: "gpt-6.1-sol", settings: { external_web_access: false } };
  const fetcher = async (url, init) => {
    assert.equal(url, "https://clawrouter-fakeco.openclaw.ai/v1/native/openai/v1/alpha/search");
    assert.deepEqual(JSON.parse(init.body), body);
    return Response.json({ output: "Synthetic output" }, { headers: { "x-clawrouter-content-retention": "off" } });
  };
  await directSearchProbe({ key: "fixture-only-key", body, routerUrl: "https://clawrouter-fakeco.openclaw.ai", fetcher });
  await assert.rejects(directSearchProbe({ key: "fixture-only-key", body, routerUrl: "https://clawrouter.openclaw.ai", fetcher }), /must be FakeCo/);
  await assert.rejects(directSearchProbe({ key: "fixture-only-key", body, routerUrl: "https://clawrouter-fakeco.openclaw.ai", fetcher: async () => Response.json({ output: "test" }) }), /retention is off/);
});
