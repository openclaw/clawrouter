import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "60e29ff604075d6961e19469a60530782fb644f7";
// Finite, activated contracts only. Bedrock and asynchronous file batches retain
// their own runtime and consumer qualification gates. Google memory prefers batch
// when both real endpoints are offered; single-endpoint Worker tests are separate.
const modelsByFormat = {
  "cohere.embed": ["embed-v4.0"],
  "voyage.embeddings": ["voyage-4", "voyage-4-large", "voyage-4-lite"],
  "google.batch_embed_contents": ["gemini-embedding-001", "gemini-embedding-2"],
};
const cases = snapshot.providers.flatMap(provider => provider.endpoints
  .filter(endpoint => endpoint.request_format === endpoint.response_format && modelsByFormat[endpoint.request_format])
  .flatMap(endpoint => provider.models.filter(model => modelsByFormat[endpoint.request_format].includes(model.upstream) && model.capabilities.includes("llm.embeddings"))
    .flatMap(model => (endpoint.request_format.startsWith("google.") ? ["native"] : ["native", "manifest"]).map(dispatch => ({ provider, endpoint, model, dispatch })))))
  .map((entry, index) => ({ ...entry, credential: `native_embed_${index}` }));
const successCalls = () => 2;
const inputTexts = body => body.texts ?? body.input ?? (body.requests ?? [body]).map(item => item.content.parts.filter(part => part.text).map(part => part.text).join("\n"));

for (const dispatch of ["native", "manifest"]) test(`actual OpenClaw ${dispatch} memory consumer through workerd and SQLite`, { skip: !source, timeout: 300_000 }, async t => {
  const selectedCases = cases.filter(entry => entry.dispatch === dispatch);
  for (const format of Object.keys(modelsByFormat)) assert.ok(cases.some(entry => entry.endpoint.request_format === format), `missing activated ${format}`);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-native-memory-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    if (dispatch === "manifest") {
      const { startCatalogVariantFixture } = await import("./helpers/openclaw-catalog-variant.mjs");
      mf = await startCatalogVariantFixture(temporary, routerFixture(selectedCases), upstreamFixture(), ["cohere", "voyage"]);
    } else mf = await startWorkerdFixture(temporary, routerFixture(selectedCases), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const { provider, model, credential } of selectedCases) {
      for (const suffix of ["", "_unpriced", "_error", "_eof", "_invalid"]) {
        const id = credential + suffix;
        await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [provider.id], models: [model.id], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: suffix === "_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
        await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      }
      await kv.put(`connections/${provider.id}`, JSON.stringify({ providerId: provider.id, enabled: true }));
    }
    const origin = String(await mf.ready);
    for (const { provider, endpoint, model, credential } of selectedCases) {
      const response = await fetch(new URL("/v1/catalog", origin), { headers: { authorization: `Bearer clawrouter-live-${credential}-fixture-secret` } });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      const offered = catalog.providers.find(row => row.id === provider.id)?.offers;
      assert.ok(offered?.some(offer => offer.endpoint === endpoint.id && offer.modelId === model.id && offer.routeKind === dispatch && offer.eligible), `${model.id}: real ${dispatch} offer must precede client execution`);
      if (provider.id === "google-gemini") {
        for (const format of ["google.embed_content", "google.batch_embed_contents"]) {
          const original = provider.endpoints.find(row => row.request_format === format);
          assert.ok(offered.some(offer => offer.endpoint === original.id && offer.modelId === model.id && offer.routeKind === "native" && offer.eligible));
          assert.ok(offered.filter(offer => offer.endpoint === original.id).every(offer => offer.routeKind !== "manifest"));
        }
      } else if (dispatch === "manifest") assert.ok(offered.filter(offer => offer.endpoint === endpoint.id).every(offer => offer.routeKind !== "native"));
    }
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-native-embeddings-contract.test.ts", import.meta.url),
      testPath: "src/agents/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin.replace(/\/$/, ""), CLAWROUTER_CONTRACT_CASES: JSON.stringify(selectedCases.map(({ credential, model, endpoint, dispatch }) => ({ credential, model: model.id, format: endpoint.request_format, dispatch }))) },
    });
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, selectedCases.reduce((count, entry) => count + successCalls(entry) + 3, 0), "denied/aborted calls never dispatch; failed requests never replay");
    for (const entry of selectedCases) {
      const { provider, endpoint, model, credential } = entry;
      const selected = calls.filter(call => inputTexts(call.body).some(text => new RegExp(`fixture ${credential}\\b`).test(text)));
      assert.equal(selected.length, successCalls(entry) + 3, `${credential}: dispatch count`);
      for (const call of selected) {
        const path = (endpoint.upstreamPath ?? endpoint.path).replaceAll("${model}", encodeURIComponent(model.upstream));
        assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + path);
        assert.equal(call.method, "POST");
        if (endpoint.request_format.startsWith("google.")) {
          assert.equal(call.headers["x-goog-api-key"], `fixture-upstream-${provider.id}`);
          assert.equal(call.headers.authorization, undefined);
          for (const item of call.body.requests ?? [call.body]) {
            assert.equal(item.outputDimensionality, 256);
            if (call.body.requests) assert.equal(item.model, `models/${model.upstream}`);
            if (model.upstream === "gemini-embedding-2") assert.equal(item.taskType, undefined);
            else assert.equal(item.taskType, inputTexts(call.body)[0].startsWith("query fixture") ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT");
          }
        } else {
          assert.equal(call.headers.authorization, `Bearer fixture-upstream-${provider.id}`);
          assert.equal(call.body.model, model.upstream);
          assert.equal(call.body.output_dimension, 256);
          const query = inputTexts(call.body)[0].startsWith("query fixture");
          assert.equal(call.body.input_type, endpoint.request_format === "cohere.embed" ? (query ? "search_query" : "search_document") : (query ? "query" : "document"));
          if (endpoint.request_format === "cohere.embed") {
            assert.equal(call.body.truncate, "END");
            assert.deepEqual(call.body.embedding_types, ["float"]);
          }
        }
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      }
      for (const suffix of ["", "_error", "_eof", "_invalid"]) {
        const id = credential + suffix, count = suffix ? 1 : successCalls(entry);
        let usage;
        for (let attempt = 0; attempt < 100; attempt++) {
          usage = await (await fetch(new URL("/v1/usage", origin), { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
          if (usage.usage.events.length === count) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(usage.usage.events.length, count, `${id}: exactly one settlement per dispatch`);
        assert.equal(usage.budget.spentMicros, count * 7);
        for (const event of usage.usage.events) {
          assert.equal(event.provider, provider.id);
          assert.equal(event.model, model.id);
          assert.equal(event.credential_id, id);
          assert.equal(event.policy_id, id);
          assert.equal(event.capability, "llm.embeddings");
          // Google validates the full vector at the Worker boundary. Other
          // protocols leave shape validation to the actual memory consumer.
          const invalidAtWorker = suffix === "_invalid" && endpoint.request_format.startsWith("google.");
          assert.equal(event.status, suffix && suffix !== "_invalid" || invalidAtWorker ? "provider_error" : "success");
          assert.equal(event.cost_basis, "policy_fixed");
          assert.equal(event.actual_cost_micros, 7, "invalid or incomplete output cannot prove free dispatched work");
          const tokens = endpoint.request_format === "cohere.embed" || suffix === "_error" || suffix === "_eof" || invalidAtWorker ? null : 7;
          const evidence = `${dispatch}/${endpoint.request_format}/${model.id}/${id}`;
          // Voyage's qualified total-only receipt describes input with zero output.
          assert.equal(event.output_tokens, endpoint.request_format === "voyage.embeddings" && tokens !== null ? 0 : null, `${evidence}: output tokens`);
          assert.equal(event.input_tokens, tokens, `${evidence}: input tokens`);
          assert.equal(event.total_tokens, tokens, `${evidence}: total tokens`);
          assert.doesNotMatch(JSON.stringify(event), /query fixture|first fixture|second fixture|fixture-upstream|must-not-fallback/);
        }
      }
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture(selectedCases) {
  const config = Object.fromEntries(selectedCases.flatMap(({ provider }) => provider.config_keys.map(name => [name, `fixture-upstream-${provider.id}`])));
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
export default { ...handler, fetch(request, env, context) {
  return handler.fetch(request, { ...env, ...${JSON.stringify(config)} }, context);
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json();
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
    const texts = body.texts ?? body.input ?? (body.requests ?? [body]).map(item => item.content.parts.filter(part => part.text).map(part => part.text).join("\\n"));
    if (texts.some(text => text.includes("embedded error fixture"))) return Response.json({ error: { message: "Synthetic embedding failure" } });
    if (texts.some(text => text.includes("broken EOF fixture"))) return new Response('{"embeddings":{', { headers: { "content-type": "application/json" } });
    const vectors = texts.map(text => Array.from({ length: text.includes("invalid vector fixture") ? 255 : 256 }, (_, column) => column === (text.includes("second fixture") ? 1 : 0) ? 1 : 0));
    if (body.texts) return Response.json({ embeddings: { float: vectors }, meta: { billed_units: { input_tokens: 7 } } });
    if (body.input) return Response.json({ object: "list", data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })).reverse(), usage: { total_tokens: 7 } });
    return Response.json({ ...(body.requests ? { embeddings: vectors.map(values => ({ values })) } : { embedding: { values: vectors[0] } }), usageMetadata: { promptTokenCount: 7 } });
  } };`;
}
