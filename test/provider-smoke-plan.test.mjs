import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectSmokeKeyProviderAccess,
  runLiveProviderSmokes,
  selectLiveProviderPlans,
  SmokeKeyInspectionUnavailableError,
} from "../scripts/provider-smoke-plan.mjs";

const plan = {
  providers: [
    {
      id: "openai",
      target: {
        kind: "openai_chat",
        route: "/v1/chat/completions",
        body: { model: "openai/test" },
      },
    },
  ],
};

test("gateway failures do not overwrite provider health", async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ error: { code: "provider_not_allowed" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const recorded = [];
      await assert.rejects(
        runLiveProviderSmokes({
          baseUrl: "https://clawrouter.example",
          smokeKey: "smoke-key",
          plan,
          liveProviders: ["openai"],
          onResult: async (result) => recorded.push(result),
        }),
        /gateway HTTP 403 before upstream response/,
      );
      assert.deepEqual(recorded, []);
    },
  );
});

test("smoke key inspection rejects selected providers outside policy scope", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example/",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://clawrouter.example/v1/key/inspect");
        assert.equal(init.headers.authorization, "Bearer smoke-key");
        assert.equal(init.redirect, "manual");
        return Response.json({
          verified: true,
          verification: "verified",
          providers: ["openrouter"],
        });
      },
    }),
    /smoke key policy does not allow live providers: openai/,
  );
});

test("smoke key inspection accepts explicit and wildcard provider scope", async () => {
  for (const providers of [["openai"], []]) {
    const inspection = await inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      fetchImpl: async () =>
        Response.json({
          verified: true,
          verification: "verified",
          providers,
        }),
    });
    assert.deepEqual(inspection.providers, providers);
  }
});

test("smoke key inspection reports revoked or stale credentials before provider smoke", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      fetchImpl: async () =>
        Response.json({
          verified: false,
          verification: "policy_generation_mismatch",
          providers: null,
        }),
    }),
    /rejected the smoke key: policy_generation_mismatch/,
  );
});

test("smoke key inspection distinguishes unavailable current deployments", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    SmokeKeyInspectionUnavailableError,
  );
});

test("smoke key inspection treats missing policy authority as unavailable", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      fetchImpl: async () =>
        Response.json({
          verified: false,
          verification: "policy_store_unavailable",
          providers: null,
        }),
    }),
    SmokeKeyInspectionUnavailableError,
  );
});

test("smoke key inspection keeps malformed credentials fatal", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "malformed",
      liveProviders: ["openai"],
      fetchImpl: async () =>
        Response.json(
          { error: { code: "invalid_key_syntax", message: "invalid" } },
          { status: 400 },
        ),
    }),
    /failed with 400: invalid_key_syntax/,
  );
});

test("smoke key inspection treats redirects and access challenges as unavailable", async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { location: "https://access.example" } }),
    Response.json({ error: { code: "access_required" } }, { status: 403 }),
    Response.json({ error: { code: "rate_limited" } }, { status: 429 }),
  ]) {
    await assert.rejects(
      inspectSmokeKeyProviderAccess({
        baseUrl: "https://clawrouter.example",
        smokeKey: "smoke-key",
        liveProviders: ["openai"],
        fetchImpl: async () => response,
      }),
      SmokeKeyInspectionUnavailableError,
    );
  }
});

test("all live provider selection expands to concrete provider ids", () => {
  const selected = selectLiveProviderPlans(
    {
      providers: [
        ...plan.providers,
        {
          id: "anthropic",
          target: {
            kind: "openai_chat",
            route: "/v1/chat/completions",
            body: { model: "anthropic/test" },
          },
        },
      ],
    },
    ["all"],
  );
  assert.deepEqual(
    selected.map((provider) => provider.id),
    ["openai", "anthropic"],
  );
});

test("provider transport failures are recorded as provider health", async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ error: { code: "provider_unavailable" } }), {
        status: 502,
        headers: { "x-clawrouter-upstream-provider": "openai" },
      }),
    async () => {
      const recorded = [];
      await assert.rejects(
        runLiveProviderSmokes({
          baseUrl: "https://clawrouter.example",
          smokeKey: "smoke-key",
          plan,
          liveProviders: ["openai"],
          onResult: async (result) => recorded.push(result),
        }),
        /HTTP 502/,
      );
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].providerAttempted, true);
      assert.equal(recorded[0].status, "failed");
    },
  );
});

test("all selected providers run before smoke failures are reported", async () => {
  const multiProviderPlan = {
    providers: [
      ...plan.providers,
      {
        id: "anthropic",
        target: {
          kind: "openai_chat",
          route: "/v1/chat/completions",
          body: { model: "anthropic/test" },
        },
      },
    ],
  };
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: "provider_unavailable" } }), {
          status: 502,
          headers: { "x-clawrouter-upstream-provider": "openai" },
        });
      }
      return new Response("ok", {
        status: 200,
        headers: { "x-clawrouter-upstream-provider": "anthropic" },
      });
    },
    async () => {
      const recorded = [];
      await assert.rejects(
        runLiveProviderSmokes({
          baseUrl: "https://clawrouter.example",
          smokeKey: "smoke-key",
          plan: multiProviderPlan,
          liveProviders: ["openai", "anthropic"],
          onResult: async (result) => recorded.push(result),
        }),
        /openai smoke failed: HTTP 502/,
      );
      assert.equal(calls, 2);
      assert.deepEqual(recorded.map((result) => [result.provider, result.status]), [
        ["openai", "failed"],
        ["anthropic", "verified"],
      ]);
    },
  );
});

test("provider response stream failures are recorded as provider health", async () => {
  await withFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("aborted"));
          },
        }),
        {
          status: 200,
          headers: { "x-clawrouter-upstream-provider": "openai" },
        },
      ),
    async () => {
      const recorded = [];
      await assert.rejects(
        runLiveProviderSmokes({
          baseUrl: "https://clawrouter.example",
          smokeKey: "smoke-key",
          plan,
          liveProviders: ["openai"],
          onResult: async (result) => recorded.push(result),
        }),
        /response body read failure/,
      );
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].providerAttempted, true);
      assert.equal(recorded[0].status, "failed");
    },
  );
});

test("successful upstream responses verify and record provider health", async () => {
  await withFetch(
    () =>
      new Response("ok", {
        status: 200,
        headers: { "x-clawrouter-upstream-provider": "openai" },
      }),
    async () => {
      const recorded = [];
      const results = await runLiveProviderSmokes({
        baseUrl: "https://clawrouter.example",
        smokeKey: "smoke-key",
        plan,
        liveProviders: ["openai"],
        onResult: async (result) => recorded.push(result),
      });
      assert.equal(results.length, 1);
      assert.equal(recorded.length, 1);
      assert.equal(results[0].status, "verified");
    },
  );
});

async function withFetch(fetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
