import assert from "node:assert/strict";
import test from "node:test";
import { grantCoolingDown, grantQuotaRatio, observeGrantQuota, observeGrantQuotaProbe, shouldFailoverGrant } from "../grant-quota.ts";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");

test("quota observations normalize provider-neutral request and token windows", () => {
  const state = observeGrantQuota(response(200, {
    "x-ratelimit-limit-requests": "1000",
    "x-ratelimit-remaining-requests": "250",
    "x-ratelimit-reset-requests": "60",
    "anthropic-ratelimit-tokens-limit": "20000",
    "anthropic-ratelimit-tokens-remaining": "1000",
    "anthropic-ratelimit-tokens-reset": "2m",
  }), NOW);
  assert.equal(state?.status, "limited");
  assert.deepEqual(state?.windows.map(({ kind, remaining, limit }) => ({ kind, remaining, limit })), [
    { kind: "requests", remaining: 250, limit: 1000 },
    { kind: "tokens", remaining: 1000, limit: 20000 },
  ]);
  assert.equal(grantQuotaRatio(state, NOW), 0.05);
});

test("rate limits and authentication failures produce bounded cooldowns", () => {
  const rateLimited = observeGrantQuota(response(429, { "retry-after": "90" }), NOW);
  assert.equal(rateLimited?.cooldownUntil, "2026-07-06T12:01:30.000Z");
  assert.equal(rateLimited?.lastSignal, "rate_limited");
  assert.equal(grantCoolingDown(rateLimited, NOW), true);

  const authentication = observeGrantQuota(response(401), NOW);
  assert.equal(authentication?.cooldownUntil, "2026-07-06T12:05:00.000Z");
  assert.equal(authentication?.lastSignal, "authentication");
});

test("exhausted windows cool down until reset and stale windows stop ranking", () => {
  const state = observeGrantQuota(response(200, { "ratelimit-limit": "100", "ratelimit-remaining": "0", "ratelimit-reset": "30" }), NOW);
  assert.equal(state?.status, "cooldown");
  assert.equal(state?.cooldownUntil, "2026-07-06T12:00:30.000Z");
  assert.equal(grantQuotaRatio(state, NOW + 31_000), null);
});

test("cooldown waits for the last exhausted quota window", () => {
  const state = observeGrantQuota(response(200, {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "60",
    "x-ratelimit-limit-tokens": "1000",
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-tokens": "120",
  }), NOW);
  assert.equal(state?.cooldownUntil, "2026-07-06T12:02:00.000Z");
});

test("malformed or oversized quota values are ignored", () => {
  assert.equal(observeGrantQuota(response(200, { "x-ratelimit-limit": "infinite", "x-ratelimit-remaining": "-1", "x-ratelimit-reset": "not-a-date" }), NOW), null);
  assert.doesNotThrow(() => observeGrantQuota(response(200, { "x-ratelimit-reset": String(Number.MAX_SAFE_INTEGER) }), NOW));
  assert.equal(observeGrantQuota(response(200, { "x-ratelimit-reset": String(Number.MAX_SAFE_INTEGER) }), NOW), null);
  const state = observeGrantQuota(response(429, { "retry-after": "999999999" }), NOW);
  assert.equal(state?.cooldownUntil, "2026-07-07T12:00:00.000Z");
});

test("failover is bounded to retryable grant responses and safe routes", () => {
  assert.equal(shouldFailoverGrant(429, "POST", "llm.chat", "oauth/policy/openai"), true);
  assert.equal(shouldFailoverGrant(401, "GET", "search.query", "oauth/policy/tavily"), true);
  assert.equal(shouldFailoverGrant(429, "POST", "image.generate", "oauth/policy/replicate"), false);
  assert.equal(shouldFailoverGrant(500, "POST", "llm.chat", "oauth/policy/openai"), false);
  assert.equal(shouldFailoverGrant(429, "POST", "llm.chat", null), false);
});

test("provider-declared headers preserve distinct input, output, and subscription windows", () => {
  const config = { responseHeaders: [
    { id: "itpm", kind: "input_tokens", unit: "token", window: "minute", fixedLimit: null, limitHeaders: ["provider-input-limit"], remainingHeaders: ["provider-input-remaining"], usedHeaders: [], resetHeaders: ["provider-input-reset"] },
    { id: "primary", kind: "subscription", unit: "percent", window: "5h", fixedLimit: 100, limitHeaders: [], remainingHeaders: [], usedHeaders: ["provider-used-percent"], resetHeaders: ["provider-reset"] },
  ], probes: [] };
  const state = observeGrantQuota(response(200, { "provider-input-limit": "2000", "provider-input-remaining": "1200", "provider-input-reset": "60", "provider-used-percent": "35", "provider-reset": "3600" }), config, NOW);
  assert.deepEqual(state?.windows.map(({ id, kind, remaining, limit }) => ({ id, kind, remaining, limit })), [
    { id: "itpm", kind: "input_tokens", remaining: 1200, limit: 2000 },
    { id: "primary", kind: "subscription", remaining: 65, limit: 100 },
  ]);
});

test("fixed limits require a dynamic collector signal", () => {
  const config = { responseHeaders: [
    { id: "primary", kind: "subscription", unit: "percent", window: "5h", fixedLimit: 100, limitHeaders: [], remainingHeaders: [], usedHeaders: ["provider-used-percent"], resetHeaders: ["provider-reset"] },
  ], probes: [] };
  assert.equal(observeGrantQuota(response(200), config, NOW), null);

  const probe = { grantKinds: ["subscription"], url: "https://provider.example/usage", method: "GET", headers: {}, windows: [
    { id: "weekly", kind: "subscription", unit: "percent", window: "7d", fixedLimit: 100, limitPointer: null, remainingPointer: null, usedPointer: "/weekly/used", resetPointer: "/weekly/reset" },
  ] };
  assert.equal(observeGrantQuotaProbe({}, probe, NOW), null);
});

test("quota probes normalize provider JSON without exposing provider payloads", () => {
  const probe = { grantKinds: ["subscription"], url: "https://provider.example/usage", method: "GET", headers: {}, windows: [
    { id: "weekly", kind: "subscription", unit: "percent", window: "7d", fixedLimit: 100, limitPointer: null, remainingPointer: null, usedPointer: "/weekly/used", resetPointer: "/weekly/reset" },
    { id: "credits", kind: "credits", unit: "credit", window: null, fixedLimit: null, limitPointer: null, remainingPointer: "/credits/balance", usedPointer: null, resetPointer: null },
  ] };
  const state = observeGrantQuotaProbe({ weekly: { used: 80, reset: 1783342800 }, credits: { balance: "12.5" }, ignored: "private" }, probe, NOW);
  assert.equal(state?.source, "provider_probe");
  assert.deepEqual(state?.windows.map(({ id, remaining, limit }) => ({ id, remaining, limit })), [
    { id: "weekly", remaining: 20, limit: 100 },
    { id: "credits", remaining: 12.5, limit: null },
  ]);
});

function response(status, headers = {}) { return new Response(null, { status, headers }); }
