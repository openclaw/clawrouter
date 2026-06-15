import assert from "node:assert/strict";
import test from "node:test";

import { runLiveProviderSmokes } from "../scripts/provider-smoke-plan.mjs";

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
