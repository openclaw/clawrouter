import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

export const fixtureOrigin = "https://clawrouter-fakeco.openclaw.ai";
const prefix = "/search-semantics/";
export function fixtureControlToken(adminToken) {
  assert.ok(typeof adminToken === "string" && adminToken.length >= 40, "inject the FakeCo admin token");
  return createHmac("sha256", adminToken).update("clawrouter/fakeco/search-semantics/control/v1").digest("hex");
}

// Preparation only: caller keeps `key` in memory and uploads only the digest.
// A fresh ID is mandatory if this candidate ID already exists remotely.
export function prepareSemanticsCredential(adminToken, id = "codex_search_semantics_20261022", now = Date.now()) {
  assert.match(id, /^codex_search_semantics_[a-zA-Z0-9_]{8,64}$/);
  assert.ok(typeof adminToken === "string" && adminToken.length >= 40, "inject the FakeCo admin token");
  const secret = createHmac("sha256", adminToken).update(`clawrouter/fakeco/search-semantics/credential/v1/${id}`).digest("hex");
  return { id, key: `clawrouter-live-${id}-${secret}`, registration: {
    enabled: true, policyId: id, secretSha256: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(now + 2 * 60 * 60_000).toISOString(),
  } };
}

function fixtureControl(token, fetcher) {
  assert.match(token ?? "", /^[a-zA-Z0-9_-]{40,128}$/, "inject SEARCH_SEMANTICS_CONTROL_TOKEN");
  return async function control(path, method = "GET", body) {
    assert.match(path, /^(?:runs(?:\/[a-f0-9-]{36}(?:\/pages\/warm)?)?|(?:diagnostic|observations)(?:\/[a-f0-9-]{36})?)$/);
    const response = await fetcher(`${fixtureOrigin}${prefix}_control/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, "fixture control request succeeds");
    let text = "", bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; assert.ok(bytes <= 16_384, "fixture response is bounded"); text += Buffer.from(chunk).toString("utf8");
    }
    let value; try { value = JSON.parse(text); } catch { throw new Error("fixture response is invalid JSON"); }
    return value;
  };
}

export async function createSemanticsFixture({ token, fetcher = fetch, ttlSeconds = 3600 }) {
  const control = fixtureControl(token, fetcher);
  const initial = await control("runs", "POST", { ttlSeconds });
  const id = initial.id;
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "fixture run ID is valid");
  const valid = run => {
    assert.equal(run.id, id, "fixture run identity preserved");
    assert.ok(Number.isSafeInteger(run.expiresAt) && run.expiresAt > Date.now() + 30_000, "fixture has at least 30 seconds remaining");
    for (const name of ["cached", "live", "warm", "child"]) {
      const page = run.pages?.[name];
      assert.match(page?.id ?? "", /^[a-f0-9-]{36}$/, "fixture page ID valid");
      assert.match(page?.marker ?? "", /^ClawRouterProbe[a-f0-9]{32}$/, "fixture marker valid");
      assert.ok([page.revision, page.gets, page.heads, page.revisionGets].every(Number.isSafeInteger), "fixture counters valid");
    }
    return run;
  };
  valid(initial);
  return {
    initial,
    url: name => `${fixtureOrigin}${prefix}${id}/${initial.pages[name].id}`,
    snapshot: async () => valid(await control(`runs/${id}`)),
    rotate: async () => valid(await control(`runs/${id}/pages/warm`, "POST")),
    close: async () => { assert.equal((await control(`runs/${id}`, "DELETE")).deleted, true, "fixture run cleanup confirmed"); },
  };
}

// Stable public URL; one bounded generation, created only by authenticated control.
// Keep initial/snapshot markers in memory. Public requests alone never create it.
export async function createDiagnosticFixture({ token, fetcher = fetch, ttlSeconds = 300 }) {
  const control = fixtureControl(token, fetcher);
  const initial = await control("diagnostic", "POST", { ttlSeconds });
  const id = initial.id;
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "diagnostic generation ID valid");
  const valid = value => {
    assert.equal(value.id, id, "diagnostic generation identity preserved");
    assert.match(value.marker ?? "", /^ClawRouterProbe[a-f0-9]{32}$/, "diagnostic marker valid");
    assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() + 30_000, "diagnostic has at least 30 seconds remaining");
    assert.ok([value.gets, value.heads].every(count => Number.isSafeInteger(count) && count >= 0), "diagnostic counters valid");
    for (const [count, time] of [[value.gets, value.lastGetAt], [value.heads, value.lastHeadAt]]) {
      assert.ok(count === 0 ? time === null : Number.isSafeInteger(time) && time > 0, "diagnostic request timestamp valid");
    }
    return value;
  };
  valid(initial);
  return {
    initial,
    url: `${fixtureOrigin}${prefix}diagnostic`,
    snapshot: async () => valid(await control(`diagnostic/${id}`)),
    close: async () => { assert.equal((await control(`diagnostic/${id}`, "DELETE")).deleted, true, "diagnostic cleanup confirmed"); },
  };
}

// Temporary observation entrypoint only; no public request or diagnostic creation.
export async function createRequestObservation({ token, fetcher = fetch }) {
  const control = fixtureControl(token, fetcher);
  const initial = await control("observations", "POST", { ttlSeconds: 300 });
  const id = initial.id;
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "observation ID valid");
  const valid = value => {
    assert.equal(value.id, id, "observation identity preserved");
    assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() + 30_000, "observation has at least 30 seconds remaining");
    assert.ok(Array.isArray(value.counters) && value.counters.length <= 128, "observation counters bounded");
    assert.ok(Number.isSafeInteger(value.overflow) && value.overflow >= 0 && value.overflow <= 1_000_000 && typeof value.saturated === "boolean", "observation limits valid");
    return value;
  };
  valid(initial);
  return { initial, snapshot: async () => valid(await control(`observations/${id}`)),
    close: async () => { assert.equal((await control(`observations/${id}`, "DELETE")).deleted, true, "observation cleanup confirmed"); } };
}

// Adapter for the native harness. No request primes the unique public page.
export async function startHostedSearchOrigin(mode, options) {
  const fixture = await createSemanticsFixture(options);
  const page = fixture.initial.pages[mode];
  return { url: fixture.url(mode), marker: page.marker, count: async () => (await fixture.snapshot()).pages[mode].gets,
    observations: async () => { const pages = Object.values((await fixture.snapshot()).pages); return { requests: pages.reduce((sum, item) => sum + item.gets + item.heads, 0), gets: pages.reduce((sum, item) => sum + item.gets, 0) }; },
    robots: () => null, close: fixture.close };
}
