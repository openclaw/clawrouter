import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { affectsOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "0eed32b19ce3eb54b38c7dde1b88d0cf2f9613cd";
// Public PR #192301's registered memory provider, not the raw AWS SDK. These are
// its nine text contracts; it does not expose base64 or typed-float v3 requests.
const specs = [
  ["amazon.titan-embed-text-v2:0", "titan-v2", [256, 512, 1024], 1024],
  ["amazon.titan-embed-text-v1", "titan-v1", [1536], 1536],
  ["amazon.titan-embed-g1-text-02", "titan-v1", [1536], 1536],
  ["cohere.embed-english-v3", "cohere-v3", [1024], 1024],
  ["cohere.embed-multilingual-v3", "cohere-v3", [1024], 1024],
  ["cohere.embed-v4:0", "cohere-v4", [256, 512, 1024, 1536], 1536],
  ["amazon.nova-2-multimodal-embeddings-v1:0", "nova", [256, 384, 1024, 3072], 1024],
  ["us.twelvelabs.marengo-embed-2-7-v1:0", "marengo-2", [1024], 1024],
  ["twelvelabs.marengo-embed-3-0-v1:0", "marengo-3", [512], 512],
];
const cases = specs.map(([upstream, family, dimensions, defaultDimensions], index) => ({
  upstream, family, dimensions, defaultDimensions, model: `bedrock/${upstream}`, credential: `bedrock_memory_${index}`,
}));
// Compile the actual complete manifest set before any Worker module evaluation.
const manifests = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort()
  .map(path => parse(readFileSync(join("providers", path), "utf8")));
const compiled = compileProviderSnapshot(manifests);
assert.deepEqual(compiled, snapshot);
const provider = compiled.providers.find(row => row.id === "aws-bedrock");
const isBatch = entry => entry.family.startsWith("cohere-");
const successes = entry => (entry.dimensions.length + 1) * (isBatch(entry) ? 2 : 3);
const texts = body => body.texts ?? [body.inputText ?? body.text?.inputText ?? body.singleEmbeddingParams?.text.value];
const secretHash = secret => createHash("sha256").update(secret).digest("hex");
const token = (id, secret = "fixture-secret") => `clawrouter-live-${id}-${secret}`;

test("Bedrock memory pin matches all nine compiled native cards and selects the complete consumer matrix", () => {
  assert.equal(manifests.length, 87);
  assert.deepEqual(provider.models.filter(row => row.capabilities.includes("llm.embeddings")).map(row => row.id).sort(), cases.map(row => row.model).sort());
  const endpoint = provider.endpoints.find(row => row.id === "embed_text");
  assert.equal(endpoint.path, "/model/${model}/invoke");
  assert.equal(endpoint.request_format, "aws_bedrock.invoke");
  assert.equal(endpoint.response_format, "aws_bedrock.invoke");
  const workflow = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.ok(rows.length >= 39, "later consumers must remain selected alongside this row");
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "bedrock-memory"), [{ consumer: "bedrock-memory", ref: sourceHead, test: "test/openclaw-bedrock-memory.test.mjs" }]);
  for (const path of ["test/openclaw-bedrock-memory.test.mjs", "test/fixtures/openclaw-bedrock-memory-contract.test.ts", ".github/workflows/openclaw-contract.yml"])
    assert.equal(affectsOpenClawContract(path), true);
});

test("Bedrock memory fixtures bundle with Wrangler's locked compiler without executing the SDK", async () => {
  const { build } = createRequire(import.meta.resolve("wrangler/package.json"))("esbuild");
  for (const contents of [routerFixture(), upstreamFixture()]) {
    const result = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
    assert.equal(result.outputFiles.length, 1);
  }
});

test("actual OpenClaw Bedrock memory through the native Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-bedrock-memory-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const entry of cases) for (const suffix of ["", "_unpriced", "_denied", "_stale", "_error", "_eof", "_invalid", "_later"]) {
      const id = entry.credential + suffix;
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["aws-bedrock"], models: suffix === "_denied" ? ["bedrock/not-granted"] : [entry.model], tenantId: "fixture", monthlyBudgetMicros: 100_000, requestCostMicros: suffix === "_unpriced" ? null : 700, budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { "aws-bedrock": ["bedrock"] }, environmentFallback: false } }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: secretHash("fixture-secret"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/aws-bedrock", JSON.stringify({ providerId: "aws-bedrock", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    for (const entry of cases) for (const suffix of ["", "_unpriced", "_denied", "_stale", "_error", "_eof", "_invalid", "_later"]) {
      const response = await fetch(`${origin}/v1/admin/upstream-grants/policies/${entry.credential}${suffix}/bedrock`, {
        method: "PUT", headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" },
        body: JSON.stringify({ provider: "aws-bedrock", kind: "api_key", enabled: true,
          credentials: { accessKeyId: "fixture-aws-access", secretAccessKey: "fixture-aws-secret", sessionToken: "fixture-aws-session" } }),
      });
      assert.equal(response.status, 200, await response.text());
    }
    for (const entry of cases) {
      const response = await fetch(`${origin}/v1/catalog`, { headers: { authorization: `Bearer ${token(entry.credential)}` } });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.equal(catalog.scope.authType, "proxy_key");
      const actual = catalog.providers.find(row => row.id === "aws-bedrock");
      assert.equal(actual.nativeBaseUrl, "/v1/native/aws-bedrock");
      assert.ok(actual.offers.some(offer => offer.modelId === entry.model && offer.endpoint === "embed_text" && offer.routeKind === "native" && offer.eligible));
      assert.ok(actual.offers.filter(offer => offer.endpoint === "embed_text").every(offer => offer.routeKind !== "manifest"));
    }
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-bedrock-memory-contract.test.ts", import.meta.url), testPath: "src/agents/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases) },
    });
    const upstream = await mf.getWorker("upstream");
    const state = await (await upstream.fetch("https://fixture.example/state")).json();
    for (const entry of cases) {
      const selected = state.calls.filter(call => texts(call.body).some(text => text.includes(`fixture ${entry.credential} `)));
      const extra = entry === cases[0] ? 2 : 0; // rotated-key success and the genuinely aborted held body
      assert.equal(selected.length, successes(entry) + 3 + (isBatch(entry) ? 1 : 2) + extra, `${entry.model}: no retry, fallback or denied egress`);
      for (const call of selected) verifyWire(entry, call);
      for (const suffix of ["", "_error", "_eof", "_invalid", "_later"]) {
        const count = suffix === "" ? successes(entry) + extra : suffix === "_later" && !isBatch(entry) ? 2 : 1;
        const id = entry.credential + suffix;
        let usage;
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer ${token(id, id === cases[0].credential ? "rotated-secret" : "fixture-secret")}` } });
          assert.equal(response.status, 200);
          usage = await response.json();
          if (usage.usage.events.length === count) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(usage.usage.events.length, count, `${id}: one receipt per dispatch`);
        assert.equal(usage.budget.spentMicros, count * 700, `${id}: dispatched malformed work has no invented refund`);
        for (const event of usage.usage.events) {
          assert.equal(event.provider, "aws-bedrock"); assert.equal(event.model, entry.model);
          assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
          assert.equal(event.capability, "llm.embeddings"); assert.equal(event.cost_basis, "policy_fixed");
          assert.equal(event.actual_cost_micros, 700);
          assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
          assert.equal(event.input_tokens, event.status === "success" && entry.family.startsWith("titan-") ? 7 : null);
          assert.doesNotMatch(JSON.stringify(event), /fixture bedrock_memory|fixture-aws|must-not-fallback/);
        }
        if (suffix) assert.ok(usage.usage.events.some(event => event.status === "provider_error"), `${id}: actual Worker validation failed`);
      }
    }
    assert.equal(state.held, 0, "the fixture's original stream was canceled or explicitly closed; this alone is not a host-join proof");
    assert.equal(state.calls.length, cases.reduce((count, entry) => count + successes(entry) + 3 + (isBatch(entry) ? 1 : 2), 2));
  } finally {
    // The SDK helper joins its original process. Dispose joins the genuine fixture;
    // neither a zero counter nor a returned vector substitutes for these awaits.
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function verifyWire(entry, call) {
  assert.equal(call.url, `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(entry.upstream)}/invoke`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers.accept, "application/json");
  const rotated = texts(call.body).some(text => text.includes("rotated key") || text.includes("held body"));
  const access = rotated ? "fixture-aws-rotated" : "fixture-aws-access";
  assert.match(call.headers.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=${access}/\\d{8}/us-east-1/bedrock/aws4_request, SignedHeaders=[a-z;-]+, Signature=[0-9a-f]{64}$`));
  assert.equal(call.headers["x-amz-security-token"], rotated ? "fixture-aws-rotated-session" : "fixture-aws-session");
  assert.equal(call.headers["x-amz-content-sha256"], secretHash(JSON.stringify(call.body)));
  assert.match(call.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|fixture-aws-secret/);
  const body = call.body, query = texts(body)[0].startsWith("query");
  const dimension = entry.family === "titan-v2" ? body.dimensions : entry.family === "cohere-v4" ? body.output_dimension : entry.family === "nova" ? body.singleEmbeddingParams.embeddingDimension : entry.defaultDimensions;
  assert.ok(entry.dimensions.includes(dimension));
  if (isBatch(entry)) {
    assert.equal(body.input_type, query ? "search_query" : "search_document");
    assert.equal(body.truncate, entry.family === "cohere-v4" ? "RIGHT" : "END");
    assert.deepEqual(body.embedding_types, entry.family === "cohere-v4" ? ["float"] : undefined);
  } else if (entry.family === "titan-v2") assert.equal(body.normalize, true);
  else if (entry.family === "nova") {
    assert.equal(body.taskType, "SINGLE_EMBEDDING");
    assert.equal(body.singleEmbeddingParams.embeddingPurpose, "GENERIC_INDEX");
    assert.equal(body.singleEmbeddingParams.text.truncationMode, "END");
  } else if (entry.family.startsWith("marengo-")) assert.equal(body.inputType, "text");
}

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
export default { ...handler, async fetch(request, env, context) {
  env = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: ${JSON.stringify(secretHash("fixture-admin"))}, AWS_REGION: "us-east-1" };
  const admin = async (path, method, body) => {
    const response = await handler.fetch(new Request("https://fixture.example/v1/admin/" + path, {
      method, headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, context);
    const result = await response.text();
    if (!response.ok) throw new Error("fixture authority mutation failed: " + response.status);
    return result;
  };
  const url = new URL(request.url);
  if (url.pathname.startsWith("/fixture/") && request.headers.get("x-fixture-control") === "bedrock-memory") {
    if (url.pathname === "/fixture/rotate") {
      await admin("credentials/bedrock_memory_0/rotate", "POST", { secretSha256: ${JSON.stringify(secretHash("rotated-secret"))} });
      await admin("upstream-grants/policies/bedrock_memory_0/bedrock", "PUT", { provider: "aws-bedrock", kind: "api_key", enabled: true,
        credentials: { accessKeyId: "fixture-aws-rotated", secretAccessKey: "fixture-aws-secret", sessionToken: "fixture-aws-rotated-session" } });
      return Response.json({ rotated: true });
    }
    return fetch("https://fixture.example/" + url.pathname.slice("/fixture/".length));
  }
  const response = await handler.fetch(request, env, context);
  // Revoke real authority after the original catalog is produced. Return that
  // exact response: the client sees an eligible offer but dispatch must refuse.
  const match = /^Bearer clawrouter-live-(bedrock_memory_\\d+_stale)-fixture-secret$/.exec(request.headers.get("authorization") ?? "");
  if (url.pathname === "/v1/catalog" && match && response.ok) {
    await admin("credentials/" + match[1] + "/revoke", "POST");
  }
  return response;
} };`;
}

function upstreamFixture() {
  return `const calls = []; const held = new Set(); const specs = ${JSON.stringify(cases)};
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json({ calls, held: held.size });
  if (request.url === "https://fixture.example/release") {
    for (const controller of held) controller.close(); held.clear(); return Response.json({ released: true });
  }
  const body = await request.json();
  calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
  const model = decodeURIComponent(new URL(request.url).pathname.split("/")[2]);
  const spec = specs.find(row => row.upstream === model);
  if (!spec) return new Response("unqualified fixture model", { status: 400 });
  const texts = body.texts ?? [body.inputText ?? body.text?.inputText ?? body.singleEmbeddingParams?.text.value];
  if (texts.some(text => text.includes("held body"))) {
    let controller;
    return new Response(new ReadableStream({ start(value) { controller = value; held.add(value); value.enqueue(new TextEncoder().encode('{"embedding":[')); }, cancel() { held.delete(controller); } }), { headers: { "content-type": "application/json" } });
  }
  if (texts.some(text => text.includes("embedded error"))) return Response.json({ error: { message: "Synthetic Bedrock failure" } });
  if (texts.some(text => text.includes("broken EOF"))) return new Response('{"embedding":[', { headers: { "content-type": "application/json" } });
  const dimensions = body.dimensions ?? body.output_dimension ?? body.singleEmbeddingParams?.embeddingDimension ?? spec.defaultDimensions;
  const vectors = texts.map(text => Array.from({ length: text.includes("invalid vector") ? dimensions - 1 : dimensions }, (_, column) => column === (text.startsWith("second") ? 1 : 0) ? 1 : 0));
  if (spec.family === "cohere-v3") return Response.json({ embeddings: vectors });
  if (spec.family === "cohere-v4") return Response.json({ embeddings: { float: vectors } });
  if (spec.family === "nova") return Response.json({ embeddings: [{ embeddingType: "TEXT", embedding: vectors[0] }] });
  if (spec.family.startsWith("marengo-")) return Response.json({ data: [{ embedding: vectors[0] }] });
  return Response.json({ embedding: vectors[0], inputTextTokenCount: 7 });
} };`;
}
