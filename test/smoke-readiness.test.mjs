import assert from "node:assert/strict";
import test from "node:test";

import {
  smokeReadinessTimeoutMs,
  waitForHealth,
} from "../scripts/smoke-readiness.mjs";

test("health readiness retries bounded propagation failures before accepting FakeCo", async () => {
  let now = 0;
  let calls = 0;
  const delays = [];
  const logs = [];
  const health = await waitForHealth({
    baseUrl: "https://clawrouter-fakeco.openclaw.ai/",
    expectedEnvironment: "fakeco",
    timeoutMs: 10_000,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://clawrouter-fakeco.openclaw.ai/v1/health");
      assert.equal(init.redirect, "manual");
      if (calls === 1) return new Response("pending", { status: 525 });
      if (calls === 2) {
        return Response.json({ ok: true, environment: "production" });
      }
      return Response.json({ ok: true, environment: "fakeco" });
    },
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
    nowImpl: () => now,
    log: (line) => logs.push(line),
  });
  assert.equal(health.environment, "fakeco");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.match(logs.at(-1), /passed after 3 attempts/);
});

test("health readiness fails with a clear bounded timeout", async () => {
  let now = 0;
  await assert.rejects(
    waitForHealth({
      baseUrl: "https://clawrouter-fakeco.openclaw.ai",
      expectedEnvironment: "fakeco",
      timeoutMs: 3_000,
      fetchImpl: async () => new Response("pending", { status: 503 }),
      sleepImpl: async (delayMs) => {
        now += delayMs;
      },
      nowImpl: () => now,
      log: () => {},
    }),
    /health readiness timed out after 3000ms \(2 attempts\): HTTP 503/,
  );
});

test("health readiness retries a stale deployment until the authenticated probe passes", async () => {
  let now = 0;
  let probes = 0;
  const health = await waitForHealth({
    baseUrl: "https://clawrouter-fakeco.openclaw.ai",
    expectedEnvironment: "fakeco",
    timeoutMs: 5_000,
    fetchImpl: async () => Response.json({ ok: true, environment: "fakeco" }),
    probeImpl: async () => {
      probes += 1;
      if (probes === 1) throw new Error("admin secret not propagated");
    },
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
    nowImpl: () => now,
    log: () => {},
  });
  assert.equal(health.environment, "fakeco");
  assert.equal(probes, 2);
  assert.equal(now, 1_000);
});

test("health readiness aborts a stalled custom probe at the shared deadline", async () => {
  let signal;
  const startedAt = Date.now();
  await assert.rejects(
    waitForHealth({
      baseUrl: "https://clawrouter-fakeco.openclaw.ai",
      expectedEnvironment: "fakeco",
      timeoutMs: 1_000,
      fetchImpl: async () => Response.json({ ok: true, environment: "fakeco" }),
      probeImpl: async (_health, options) => {
        signal = options.signal;
        await new Promise(() => {});
      },
      log: () => {},
    }),
    /health readiness timed out after 1000ms.*readiness probe deadline elapsed/,
  );
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 1_500);
});

test("health readiness timeout configuration is constrained", () => {
  assert.equal(smokeReadinessTimeoutMs({}), 180_000);
  assert.equal(
    smokeReadinessTimeoutMs({ CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS: "45000" }),
    45_000,
  );
  for (const value of ["0", "999", "600001", "1.5", "forever"]) {
    assert.throws(
      () =>
        smokeReadinessTimeoutMs({
          CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS: value,
        }),
      /1000 to 600000/,
    );
  }
});
