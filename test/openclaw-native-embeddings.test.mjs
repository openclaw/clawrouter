import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "5964e1f3065337b92a733e42cc248bf5e27a5415";
// The first native slice uses the already-advertised Cohere contract. Other
// native families need their qualified runtime and catalog activation first.
const cases = snapshot.providers.flatMap(provider => provider.endpoints
  .filter(endpoint => endpoint.request_format === "cohere.embed" && endpoint.response_format === "cohere.embed")
  .flatMap(endpoint => provider.models.filter(model => model.upstream === "embed-v4.0" && model.capabilities.includes("llm.embeddings"))
    .map(model => ({ provider, endpoint, model }))))
  .map((entry, index) => ({ ...entry, credential: `native_embed_${index}` }));

test("actual OpenClaw native memory consumer through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(cases.length > 0);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-native-memory-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const { provider, model, credential } of cases) {
      for (const suffix of ["", "_unpriced", "_error", "_eof"]) {
        const id = credential + suffix;
        await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [provider.id], models: [model.id], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: suffix === "_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
        await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put(`connections/${provider.id}`, JSON.stringify({ providerId: provider.id, enabled: true }));
    }
    const origin = String(await mf.ready);
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-native-embeddings-contract.test.ts", import.meta.url),
      testPath: "src/agents/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, ""), CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases.map(({ credential, model }) => ({ credential, model: model.id }))) },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, cases.length * 4, "unpriced hard budgets, rotation and cancellation must not dispatch; failures must not replay");
    for (const { provider, endpoint, model, credential } of cases) {
      const selected = calls.filter(call => call.body.model === model.upstream);
      assert.equal(selected.length, 4);
      for (const call of selected) {
        assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
        assert.equal(call.method, "POST");
        assert.equal(call.headers.authorization, `Bearer fixture-upstream-${provider.id}`);
        assert.deepEqual(Object.keys(call.body).sort(), ["embedding_types", "input_type", "model", "output_dimension", "texts", "truncate"]);
        assert.equal(call.body.output_dimension, 256);
        assert.equal(call.body.truncate, "END");
        assert.deepEqual(call.body.embedding_types, ["float"]);
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      }
      assert.deepEqual(selected.find(call => call.body.texts[0] === "query fixture").body.texts, ["query fixture"]);
      assert.equal(selected.find(call => call.body.texts[0] === "query fixture").body.input_type, "search_query");
      assert.deepEqual(selected.find(call => call.body.texts[0] === "first fixture").body.texts, ["first fixture", "second fixture"]);
      assert.equal(selected.find(call => call.body.texts[0] === "first fixture").body.input_type, "search_document");
      for (const suffix of ["", "_error", "_eof"]) {
        const id = credential + suffix, count = suffix ? 1 : 2;
        let usage;
        for (let attempt = 0; attempt < 100; attempt++) {
          usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
          if (usage.usage.events.length === count) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(usage.usage.events.length, count);
        assert.equal(usage.budget.spentMicros, count * 7);
        for (const event of usage.usage.events) {
          assert.equal(event.provider, provider.id);
          assert.equal(event.model, model.id);
          assert.equal(event.credential_id, id);
          assert.equal(event.policy_id, id);
          assert.equal(event.capability, "llm.embeddings");
          assert.equal(event.status, suffix ? "provider_error" : "success");
          assert.equal(event.cost_basis, "policy_fixed");
          assert.equal(event.actual_cost_micros, 7, "an incomplete or embedded-error response cannot prove a free dispatched request");
          for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null, "billed units do not fabricate observed token counters");
          assert.doesNotMatch(JSON.stringify(event), /query fixture|first fixture|second fixture|fixture-upstream|must-not-fallback/);
        }
      }
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
    if (body.texts[0] === "embedded error") return Response.json({ error: { message: "Synthetic embedding failure" } });
    if (body.texts[0] === "broken EOF") return new Response('{"embeddings":{', { headers: { "content-type": "application/json" } });
    return Response.json({ embeddings: { float: body.texts.map((_, index) => Array.from({ length: 256 }, (_, column) => column === index ? 1 : 0)) }, meta: { billed_units: { input_tokens: 7 } } });
  } };`;
}
