import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "9d2be9d82c2a6973ae1b025eac4a636964397c28";
// Only concrete models in the client's qualified format. Azure's deployment
// placeholder and native Voyage/Cohere/Google/Bedrock formats need separate proof.
const cases = snapshot.providers.flatMap(provider => provider.endpoints
  .filter(endpoint => endpoint.request_format === "openai.embeddings" && endpoint.response_format === "openai.embeddings")
  .flatMap(endpoint => provider.models.filter(model => model.capabilities.includes("llm.embeddings") && !model.upstream.includes("${"))
    .map(model => ({ provider, endpoint, model }))))
  .map((entry, index) => ({ ...entry, credential: `embedding_${index}` }));

test("actual OpenClaw memory embeddings through workerd, scoped usage and SQLite settlement", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(cases.length > 0);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-embeddings-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const { provider, model, credential } of cases) {
      await kv.put(`policies/${credential}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [provider.id], models: [model.id], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${credential}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: credential, policyGeneration: "fixture" }));
      await kv.put(`connections/${provider.id}`, JSON.stringify({ providerId: provider.id, enabled: true }));
    }
    const origin = String(await mf.ready);
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-embeddings-contract.test.ts", import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, ""), CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases.map(({ credential, model }) => ({ credential, model: model.id }))) },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, cases.length, "rotation, cancellation and unsupported inputs must not dispatch");
    for (const { provider, endpoint, model, credential } of cases) {
      const call = calls.find(call => call.body.model === model.upstream);
      assert.ok(call, model.id);
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.method, "POST");
      assert.deepEqual(call.body, { model: model.upstream, input: ["first fixture text", "second fixture text"] });
      for (const auth of provider.auth.schemes) assert.equal(call.headers[auth.header.toLowerCase()], auth.type === "bearer" ? `Bearer fixture-upstream-${provider.id}` : `fixture-upstream-${provider.id}`);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let attempt = 0; attempt < 100; attempt++) {
        usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-${credential}-fixture-secret` } })).json();
        if (usage.usage.events.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1);
      const [event] = usage.usage.events;
      assert.equal(event.provider, provider.id);
      assert.equal(event.model, model.id);
      assert.equal(event.credential_id, credential);
      assert.equal(event.policy_id, credential);
      assert.equal(event.status, "success");
      assert.equal(event.input_tokens, 4);
      assert.equal(event.total_tokens, 4);
      assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.actual_cost_micros, 7);
      assert.equal(usage.budget.spentMicros, 7);
      assert.doesNotMatch(JSON.stringify(event), /fixture text|fixture-upstream/);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  const config = Object.fromEntries(cases.flatMap(({ provider }) => provider.config_keys.map(name => [name, `fixture-upstream-${provider.id}`])));
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
export default { ...handler, fetch(request, env, context) { return handler.fetch(request, { ...env, ...${JSON.stringify(config)} }, context); } };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json();
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
    return Response.json({ object: "list", model: body.model, data: [{ object: "embedding", index: 1, embedding: [3, 4] }, { object: "embedding", index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
  } };`;
}
