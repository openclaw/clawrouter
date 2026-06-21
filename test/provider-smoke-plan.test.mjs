import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderSmokePlan,
  compileProviderSnapshot,
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

test("bundled OpenAI smoke target uses the catalog default model", () => {
  const provider = buildProviderSmokePlan(compileProviderSnapshot(), {}).providers.find(
    (entry) => entry.id === "openai",
  );
  assert.equal(provider.target.body.model, "openai/gpt-4.1-mini");
});

test("Firecrawl uses keyless mode without a configured API key", () => {
  const provider = buildProviderSmokePlan(compileProviderSnapshot(), {}).providers.find(
    (entry) => entry.id === "firecrawl",
  );
  assert.equal(provider.configPresent, true);
  assert.deepEqual(provider.requiredConfig, []);
  assert.deepEqual(provider.optionalConfig, ["FIRECRAWL_API_KEY"]);
  assert.deepEqual(provider.target.envelope.body, {
    url: "https://example.com",
    formats: ["markdown"],
  });
});

test("Anthropic count_tokens smoke omits messages-only max_tokens", () => {
  const provider = buildProviderSmokePlan(compileProviderSnapshot(), {}).providers.find(
    (entry) => entry.id === "anthropic",
  );
  assert.equal(provider.target.kind, "manifest_proxy");
  assert.equal(provider.target.endpoint, "count_tokens");
  assert.equal(provider.target.envelope.body.max_tokens, undefined);
  assert.equal(provider.target.envelope.body.model, "claude-sonnet-4-5-20250929");
});

test("newly budgeted provider defaults compile with dated pricing", () => {
  const snapshot = compileProviderSnapshot();
  const expectations = {
    deepseek: [140000, 280000],
    "google-gemini": [300000, 2500000],
    groq: [50000, 80000],
    minimax: [300000, 1200000],
    together: [300000, 300000],
    xai: [1250000, 2500000],
  };
  for (const [providerId, [input, output]] of Object.entries(expectations)) {
    const model = snapshot.providers.find((provider) => provider.id === providerId).models[0];
    assert.equal(model.pricing.effectiveAt, "2026-06-21");
    assert.equal(model.pricing.inputMicrosPerMillion, input);
    assert.equal(model.pricing.outputMicrosPerMillion, output);
  }
  const xai = snapshot.providers.find((provider) => provider.id === "xai").models[0];
  assert.equal(xai.pricing.source, "https://api.x.ai/v1/models/grok-4.3");
  assert.equal(xai.pricing.longContext.thresholdInputTokens, 200000);
  assert.equal(xai.pricing.longContext.inputMicrosPerMillion, 2500000);
  assert.equal(xai.pricing.longContext.outputMicrosPerMillion, 5000000);
});

test("live provider defaults compile to current upstream models and transports", () => {
  const snapshot = compileProviderSnapshot();
  const upstreams = {
    "google-gemini": "gemini-2.5-flash",
    groq: "llama-3.1-8b-instant",
    huggingface: "meta-llama/Llama-3.1-8B-Instruct",
    xai: "grok-4.3",
  };
  for (const [providerId, upstream] of Object.entries(upstreams)) {
    const provider = snapshot.providers.find((entry) => entry.id === providerId);
    assert.equal(provider.models[0].upstream, upstream);
  }
  const huggingface = buildProviderSmokePlan(snapshot, {}).providers.find(
    (provider) => provider.id === "huggingface",
  );
  assert.equal(huggingface.target.kind, "openai_chat");
  assert.equal(huggingface.target.body.model, "huggingface/default");
});

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

test("smoke key inspection bounds requests and treats timeouts as unavailable", async () => {
  await assert.rejects(
    inspectSmokeKeyProviderAccess({
      baseUrl: "https://clawrouter.example",
      smokeKey: "smoke-key",
      liveProviders: ["openai"],
      timeoutMs: 1,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          assert.equal(init.signal instanceof AbortSignal, true);
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
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
