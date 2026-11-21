import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const phase = "mythos5", models = ["claude-mythos-5"];
const cases = [
  ...["stream", "simple", "low", "medium", "high", "xhigh", "max", "minimal", "global", "us", "missing_geo", "image", "seed", "replay", "cross", "error", "refusal", "cancel"].map(id => ({ id, model: models[0], max: 128 })),
  ...["invalid", "foreign", "budget", "model_denied", "fast", "priority", "bad_geo", "revoked"].map(id => ({ id, model: models[0], max: 128, denied: true })),
  { id: "count", model: models[0], max: 0, count: true },
];
const charged = cases.filter(row => !row.denied), ownerId = id => "mythos_" + id;
const token = id => id === "invalid" ? "clawrouter-live-mythos_stream-invalid" : `clawrouter-live-mythos_${id}-fixture-secret`;
const secret = id => "synthetic-mythos-" + id;
const upstreamUrl = "https://api.anthropic.com/v1/messages";
const nativePath = "/v1/native/anthropic/v1/messages";
const pathFor = (row, base) => base + (row.count ? "/count_tokens" : "");
const modifiers = id => id === "fast" ? { speed: "fast" } : id === "priority" ? { service_tier: "priority" } : id === "bad_geo" ? { inference_geo: "future" } : ["us", "global"].includes(id) ? { inference_geo: id } : {};
const fixtureText = readFileSync(new URL("./fixtures/openclaw-mythos5-contract.test.ts", import.meta.url), "utf8");
// One implementation, reused as source. No Qianfan runtime evidence transfers.
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
// Adapt only credential framing and a passive read-result observation. The
// original promise, result, receiver, operands and strict retirement remain.
const adaptations = [
  ['actual.headers.get("authorization")', 'actual.headers.get("x-api-key")'],
  ['authorization === "Bearer " + row.credential', 'authorization === row.credential'],
  ['bodySucceeded: () => boolean; current?', 'bodySucceeded: () => boolean; readProgress?: (owner: any, value: any) => void; current?'],
  ['if (value?.done === true) row.eof = true;', 'if (value?.done === true) row.eof = true; sdk?.readProgress?.(owner, value);'],
];
let observerSource = donor.slice(start, end);
for (const [before, after] of adaptations) {
  assert.equal(observerSource.split(before).length, 2, "exact observer adaptation preimage");
  observerSource = observerSource.replace(before, after);
}
const observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings };")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
const assembledFixture = fixtureText.replace(marker, observerSource);

const workerOutcomePins = {"proxy.ts": "0257510ec1373baab447c1bdcad82b36e6341fce55027c8627af3fccf6e794de", "proxy-response.ts": "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
function workerOutcomeOverlay(text, name = "proxy-response.ts") {
  assert.equal(createHash("sha256").update(text).digest("hex"), workerOutcomePins[name]);
  const edit = (before, after, count = 1) => { assert.equal(text.split(before).length, count + 1, before); text = text.replaceAll(before, after); };
  if (name === "proxy.ts") {
    // Thread the already-held operation to the original source owner; the
    // forwarded/normalized reader is deliberately NOT used as its identity.
    edit('function ownOrdinaryResponse(response: Response, completion: ProxyCompletion): Response {',
      'function ownOrdinaryResponse(response: Response, completion: ProxyCompletion, operation: HttpOperation): Response {');
    edit('ownOrdinaryResponse(response, completion)', 'ownOrdinaryResponse(response, completion, operation)', 2);
    edit('    const reader = response.body!.getReader(), input = inputRetirement(reader);',
      '    const reader = response.body!.getReader(), input = inputRetirement(reader);\n    qianfanOutcome.current.bind(operation, response, reader);');
    edit('              const next = await input.read(() => reader.read());',
      '              qianfanOutcome.current.readStart(operation, reader);\n              const next = await input.read(() => reader.read());\n              qianfanOutcome.current.readDone(operation, reader);');
    edit('            } catch (error) {\n              if (!stopped)',
      '            } catch (error) {\n              qianfanOutcome.current.failure(operation, reader, error);\n              if (!stopped)');
  } else {
    assert.equal(name, "proxy-response.ts");
    // Embeddings bypass the ordinary Chat completion wrapper. Their original
    // fetched reader belongs directly to observeUsage, not to a forwarded body.
    edit('  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);',
      '  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);\n  if (responseFormat === "openai.embeddings") qianfanOutcome.current.bind(operation, response, reader);');
    edit('        const next = await input.read(() => reader.read());',
      '        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readStart(operation, reader);\n        const next = await input.read(() => reader.read());\n        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readDone(operation, reader);');
    edit('      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }',
      '      } catch (error) { if (responseFormat === "openai.embeddings") qianfanOutcome.current.failure(operation, reader, error); if (!finished) { finish("failed", error); controller.error(error); } }');
    edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { qianfanOutcome } from "qianfan-outcome-witness";\n' + text;
}
async function bundleMythosOutcome(contents) {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "qianfan-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "qianfan-first-outcome", setup(build) {
      build.onResolve({ filter: /^qianfan-outcome-witness$/ }, () => ({ path: "witness", namespace: "qianfan" }));
      build.onLoad({ filter: /.*/, namespace: "qianfan" }, () => ({ contents: "export const qianfanOutcome = { current: undefined };", loader: "js" }));
      build.onLoad({ filter: /[/\\]worker[/\\](?:proxy|proxy-response|http-operation)\.ts$/ }, args => {
        const name = args.path.split(/[/\\]/).at(-1), source = readFileSync(args.path, "utf8");
        assert.equal(createHash("sha256").update(source).digest("hex"), workerOutcomePins[name]);
        return { contents: name !== "http-operation.ts" ? workerOutcomeOverlay(source, name) : source, loader: "ts" };
      });
    } }],
  });
  return bundle.outputFiles[0].text;
}


function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof));
  assert.equal(proof.settled, proof.operations); assert.equal(proof.readers, proof.unlocked);
  assert.equal(proof.rejected, proof.qualifiedReadRejections ?? 0);
}

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
const cases = ${JSON.stringify(cases)}, ingress = createRequestBindings(), outbound = createRequestBindings();
let sourceCancellation, acceptedConsumer = false;
const lifetime = createLifetimeObserver(undefined, { ownerId: "mythos_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of cases) {
  const id = "mythos_" + row.id;
  ingress.expect(id, "chat", ${JSON.stringify(nativePath)} + (row.count ? "/count_tokens" : ""), "POST", row.id === "invalid" ? "clawrouter-live-mythos_stream-invalid" : "clawrouter-live-" + id + "-fixture-secret");
  if (!row.denied) outbound.expect(id, "chat", ${JSON.stringify(upstreamUrl)} + (row.count ? "/count_tokens" : ""), "POST", "synthetic-mythos-" + row.id);
}
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  const owner = outbound.claim(args[0], args[1], "chat");
  owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
  if (!owner.ingress) throw new Error("unbound Mythos outbound request");
  lifetime.signal(owner, args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined));
  return lifetime.invoke("fetch", originalFetch, this, args, owner, response => lifetime.response(response, owner));
});
async function retire(request) {
  let accepted = false;
  try { await preserveFailures(async () => {
    const proof = await request.json(); sourceCancellation = proof.sourceCancellation; acceptedConsumer = proof.acceptedConsumer === true;
    await lifetime.join(); ingress.verify(); outbound.verify();
  }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
  return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() });
}
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const row of cases) if (row.id !== "invalid") await putGrantCredentials(env, "oauth/mythos_" + row.id + "/anthropic", { provider: "anthropic", kind: "api_key", enabled: true, credential: "synthetic-mythos-" + row.id });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/revoke") return (async () => {
    await putGrantCredentials(env, "oauth/mythos_revoked/anthropic", { provider: "anthropic", kind: "api_key", enabled: false, credential: "synthetic-mythos-revoked" });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (![${JSON.stringify(nativePath)}, ${JSON.stringify(nativePath + "/count_tokens")}].includes(path)) return handler.fetch(request, { ...env, ANTHROPIC_API_KEY: "must-not-fallback" }, context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = ingress.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, { ...env, ANTHROPIC_API_KEY: "must-not-fallback" }, context], owner);
} };`;
}

function upstreamFixture() {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [], owners = new Map();
for (const row of ${JSON.stringify(charged)}) bindings.expect("mythos_" + row.id, "chat", ${JSON.stringify(upstreamUrl)} + (row.count ? "/count_tokens" : ""), "POST", "synthetic-mythos-" + row.id);
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const id = owner.id.slice("mythos_".length), call = { id, url: request.url, authorization: request.headers.get("x-api-key"), body, cancelled: false, expired: false };
  calls.push(call); owners.set(owner, call);
  if (id === "count") return Response.json({ input_tokens: 17 });
  const frame = value => "event: " + value.type + "\\ndata: " + JSON.stringify(value) + "\\n\\n";
  const geo = id === "missing_geo" ? {} : { inference_geo: id === "global" ? "global" : "us" };
  const usage = { input_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 }, output_tokens: 0, service_tier: "standard", ...geo };
  const events = [
    { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic reasoning" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "synthetic-answer" } },
    { type: "content_block_stop", index: 1 },
    ...(id === "error" ? [{ type: "error", error: { type: "api_error", message: "synthetic-upstream-error" } }] : id === "cancel" ? [] : [
      ...(id === "seed" ? [{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"index":2}' } }, { type: "content_block_stop", index: 2 }] : []),
      { type: "message_delta", delta: { stop_reason: id === "refusal" ? "refusal" : id === "seed" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { ...usage, output_tokens: 10 } },
      { type: "message_stop" },
    ]),
  ];
  const wire = events.map(frame).join("");
  const bytes = new TextEncoder().encode(wire); let offset = 0, heartbeat, wake, expiry, controller;
  let resolveProducer, rejectProducer, complete = false;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("Mythos source deadline"); finish(true, error); controller?.error(error); }, 10000);
  const streamSource = {
    start(value) { controller = value; },
    pull(value) {
      if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); value.enqueue(bytes.slice(offset, end)); offset = end; return; }
      if (id !== "cancel") { value.close(); finish(false); return; }
      // A bounded yielding pull is distinct from the retained producer promise.
      const pending = new Promise(resolve => { wake = resolve; heartbeat = setTimeout(() => { if (!complete) value.enqueue(new TextEncoder().encode(": heartbeat\\n\\n")); resolve(); }, 50); });
      return lifetime.watch("source.heartbeat", pending, owner);
    },
    cancel() { call.cancelled = true; finish(false); },
  };
  for (const kind of ["pull", "cancel"]) { const original = streamSource[kind]; lifetime.patch(streamSource, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(streamSource, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
export default { fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => {
    let accepted = false;
    try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
    const owner = bindings.bindings.find(row => row.id === "mythos_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
    const sourceCancellation = { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true,
      cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: owned.filter(op => op.state === "pending").length,
      failed: owned.filter(op => !["pending", "fulfilled"].includes(op.state)).length };
    return Response.json({ ...lifetime.summary(), accepted, sourceCancellation });
  })();
  const owner = bindings.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
}

async function setup(mf) {
  const kv = await mf.getKVNamespace("POLICY_KV", "router");
  for (const row of cases.filter(row => row.id !== "invalid")) {
    const id = ownerId(row.id);
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "openai" : "anthropic"],
      models: [row.id === "model_denied" ? "anthropic/claude-sonnet-5-5" : "anthropic/claude-mythos-5"],
      grantRouting: { eligibleGrants: { anthropic: ["anthropic"] }, environmentFallback: false },
      tenantId: "fixture", monthlyBudgetMicros: row.id === "budget" ? 0 : 10_000_000,
      budgetMode: "reserve", requestCostMicros: null, retainRequestContent: false }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: 100_000_000 }));
  const origin = String(await mf.ready).replace(/\/$/, "");
  assert.equal((await fetch(origin + "/fixture/grants")).status, 204);
  const response = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token("stream") } });
  assert.equal(response.status, 200); const catalog = await response.json(), provider = catalog.providers.find(row => row.id === "anthropic");
  assert.equal(catalog.scope.credentialId, ownerId("stream"));
  assert.deepEqual(provider.models.map(row => row.id), ["anthropic/claude-mythos-5"]);
  assert.ok(provider.offers.some(row => row.modelId === "anthropic/claude-mythos-5" && row.routeKind === "native" && row.eligible));
  return origin;
}

async function countTokens(origin) {
  const response = await fetch(origin + nativePath + "/count_tokens", { method: "POST", headers: { "x-api-key": token("count"), "content-type": "application/json" },
    body: JSON.stringify({ model: models[0], messages: [{ role: "user", content: "Synthetic count" }] }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { input_tokens: 17 });
}

async function verifyCallsAndUsage(mf, origin, native) {
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
  assert.deepEqual(calls.map(call => call.id).sort(), charged.map(row => row.id).sort());
  for (const call of calls) {
    const row = cases.find(row => row.id === call.id); assert.ok(row);
    assert.equal(call.url, pathFor(row, upstreamUrl)); assert.equal(call.authorization, secret(row.id));
    assert.equal(call.body.model, row.model); assert.notEqual(call.expired, true);
    if (!row.count) {
      assert.equal(call.body.max_tokens, row.max); assert.equal(call.body.stream, true);
      assert.equal(call.body.inference_geo, modifiers(row.id).inference_geo);
      if (native) {
        assert.equal(call.body.thinking.type, "adaptive");
        assert.equal(call.body.output_config.effort, ["low", "medium", "high", "xhigh", "max"].includes(row.id) ? row.id : row.id === "minimal" ? "low" : "high");
        const blocks = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        if (["replay", "cross"].includes(row.id)) {
          const thinking = blocks.filter(block => block.type === "thinking");
          assert.equal(thinking.length, row.id === "replay" ? 1 : 0);
          if (thinking.length) assert.equal(thinking[0].signature, "synthetic-signature");
          const tool = blocks.find(block => block.type === "tool_use"), result = blocks.find(block => block.type === "tool_result");
          assert.equal(tool.id, "tool_fixture"); assert.deepEqual(tool.input, { index: 2 }); assert.equal(result.tool_use_id, tool.id);
        }
        const images = blocks.filter(block => block.type === "image");
        assert.equal(images.length, row.id === "image" ? 1 : 0);
        if (images.length) assert.equal(images[0].source.media_type, "image/png");
      }
    } else assert.equal(call.body.stream, undefined);
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
  }
  for (const row of cases.filter(row => row.id !== "invalid")) {
    let usage;
    for (let attempt = 0; attempt < 150; attempt++) {
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(row.id) } })).json();
      if (usage.usage.events.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(usage.usage.events.length, 1, row.id + " authenticated attempt receipt");
    const [event] = usage.usage.events;
    assert.equal(event.credential_id, ownerId(row.id)); assert.equal(event.policy_id, ownerId(row.id));
    const incomplete = ["error", "cancel"].includes(row.id);
    const cost = row.denied || row.count ? 0 : incomplete ? event.reserved_cost_micros : row.id === "global" ? 13100 : 14410;
    assert.equal(event.actual_cost_micros, cost, row.id); assert.equal(usage.budget.spentMicros, cost, row.id);
    if (!row.denied) {
      assert.equal(event.provider, "anthropic"); assert.equal(event.model, "anthropic/claude-mythos-5");
      if (!row.count) {
        assert.ok(cost > 0); assert.equal(event.status, row.id === "error" ? "provider_error" : row.id === "cancel" ? "client_error" : "success");
        assert.equal(event.cost_basis, incomplete ? "manifest_reservation" : "manifest_pricing");
        if (!incomplete) assert.deepEqual([event.input_tokens, event.cached_input_tokens, event.cache_write_input_tokens, event.output_tokens], [1000,100,500,10]);
      } else { assert.equal(event.status, "success"); assert.equal(event.reserved_cost_micros, 0); }
    } else assert.notEqual(event.status, "success");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|synthetic-mythos|fixture-secret|must-not-fallback/);
  }
}

async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "mythos_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}

test(phase + " Mythos owned cleanup preserves falsey failures and attempts independent retirement", async () => {
  const attempts = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempts.push(1); throw null; }, () => attempts.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempts, [1, 2]);
});

test(phase + " Mythos request bindings reject foreign credentials, duplicate claims and missing original calls", () => {
  const bindings = createRequestBindings(); bindings.expect("card", "chat", upstreamUrl, "POST", "synthetic");
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { "x-api-key": "foreign" } }, "chat"));
  assert.throws(() => bindings.verify());
  bindings.claim(upstreamUrl, { method: "POST", headers: { "x-api-key": "synthetic" } }, "chat"); bindings.verify();
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { "x-api-key": "synthetic" } }, "chat"));
});

test(phase + " Mythos native assembly uses the exact owned observer and a unique pinned workflow row", () => {
  assert.ok(!assembledFixture.includes(marker)); assert.equal(assembledFixture.split(observerSource).length, 2);
  assert.doesNotThrow(() => stripTypeScriptTypes(assembledFixture));
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "mythos5"), [{ consumer: "mythos5", ref: sourceHead, test: "test/openclaw-mythos5.test.mjs" }]);
  assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  const provider = snapshot.providers.find(row => row.id === "anthropic");
  assert.ok(provider.models.some(row => row.upstream === models[0]));
  assert.equal(cases.length, 27);
  assert.ok(assembledFixture.includes('assert.equal(process.env.CLAWROUTER_MYTHOS_CONTRACT, "mythos5")'));
  assert.ok(assembledFixture.includes('console.log("MYTHOS_CANCEL_RETIRED mythos5")'));
  const chat = provider.endpoints.find(row => row.id === "messages");
  assert.equal(nativePath, "/v1/native/anthropic" + chat.path);
  assert.equal(upstreamUrl, provider.base_urls.default + chat.path);
});

test(phase + " Mythos fixture admits the actual registered named Anthropic catalog by reference", () => {
  const start = fixtureText.indexOf("function registeredMythosCatalog("), end = fixtureText.indexOf("async function start(", start);
  assert.ok(start >= 0 && end > start);
  const read = new Function("assert", stripTypeScriptTypes(fixtureText.slice(start, end)) + ";return registeredMythosCatalog;")(assert);
  const provider = { api: "anthropic-messages", models: [] };
  assert.equal(read({ providers: { anthropic: provider } }), provider);
  for (const value of [undefined, null, {}, { provider }, { provider: null }]) assert.throws(() => read(value));
});

test(phase + " Mythos replay negative binds both requested and actual serving identities", () => {
  const begin = fixtureText.indexOf("function replayAssistant("), end = fixtureText.indexOf("async function start(", begin);
  const replay = new Function(stripTypeScriptTypes(fixtureText.slice(begin, end)) + ";return replayAssistant;")();
  const content = [{ type: "thinking", thinkingSignature: "synthetic-signature" }];
  const original = Object.freeze({ model: models[0], responseModel: models[0], content });
  assert.equal(replay(original, false), original);
  const foreign = replay(original, true);
  assert.equal(foreign.model, "claude-sonnet-4-6"); assert.equal(foreign.responseModel, foreign.model);
  assert.equal(foreign.content, content); assert.equal(original.responseModel, models[0]);
});

test(phase + " Mythos original reader rejection and independent release errors remain fatal", async () => {
  for (const reason of [undefined, new Error("synthetic independent")]) {
    const life = createLifetimeObserver(), owner = {}, response = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
    life.response(response, owner); const reader = response.body.getReader();
    await reader.read().catch(() => {}); await reader.closed.catch(() => {}); reader.releaseLock();
    await assert.rejects(life.join(), error => error.errors.includes(reason)); life.restore();
  }
});

test(phase + " Mythos passive read progress preserves original identity and falsey observer faults", async () => {
  for (const fail of [false, true]) {
    const owner = {}, value = { done: true }, original = Promise.resolve(value), seen = [];
    const reader = { closed: Promise.resolve(), read() { assert.equal(this, reader); return original; }, cancel() {}, releaseLock() {} };
    const response = { body: { locked: false, getReader() { return reader; }, cancel() {} } };
    const life = createLifetimeObserver({ bindings: [], bodySucceeded: () => true, readProgress(actualOwner, actualValue) {
      seen.push([actualOwner, actualValue]); if (fail) throw undefined;
    } });
    life.response(response, owner); const acquired = response.body.getReader();
    assert.equal(acquired.read(), original); assert.equal(await original, value); await Promise.resolve();
    assert.deepEqual(seen, [[owner, value]]); acquired.releaseLock();
    if (fail) await assert.rejects(life.join(), error => error.errors.includes(undefined)); else await life.join();
    life.restore();
  }
});

test(phase + " Mythos failed upstream proof still joins router retirement and preserves undefined cleanup", async () => {
  for (const failure of [undefined, new Error("synthetic source failure")]) {
    let routerAttempts = 0;
    const mf = { async getWorker() { return { fetch() { return Promise.reject(failure); } }; },
      dispatchFetch() { routerAttempts++; return Promise.reject(undefined); } };
    await assert.rejects(retire(mf, false), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === undefined);
    assert.equal(routerAttempts, 1);
  }
});

test(phase + " Mythos acquisition observation preserves detached release and rejects its independent failure", async () => {
  for (const failed of [false, true]) {
    const lifetime = createLifetimeObserver(), owner = {}, receiver = {}, operand = {};
    const release = () => failed ? Promise.reject(undefined) : Promise.resolve();
    const result = { response: new Response("synthetic"), release }, original = Promise.resolve(result);
    assert.equal(lifetime.guard(function (arg) { assert.equal(this, receiver); assert.equal(arg, operand); return original; }, receiver, [operand], owner), original);
    const actual = await original, reader = actual.response.body.getReader();
    assert.equal((await reader.read()).done, false); assert.equal((await reader.read()).done, true); reader.releaseLock();
    const detached = actual.release; await detached().catch(() => {});
    if (failed) await assert.rejects(lifetime.join(), error => error.errors.includes(undefined)); else await lifetime.join();
    lifetime.restore(); assert.equal(actual.release, release);
  }
});

test(phase + " Mythos source proof joins actual early and pending-pull cancellation without manufacturing completion", { timeout: 20_000 }, async () => {
  for (const mode of ["early", "pending", "expiry"]) {
    const source = new Function(upstreamFixture().replace("export default", "return"))(), tails = [];
    const response = await source.fetch(new Request(upstreamUrl, { method: "POST", headers: { "x-api-key": secret("cancel") },
      body: JSON.stringify({ model: models[0], messages: [], stream: true }) }), {}, { waitUntil(value) { tails.push(value); } });
    assert.equal(tails.length, 1); let settled = false; void tails[0].then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false, "returning headers does not retire the producer");
    if (mode === "early") await response.body.cancel();
    else {
      const reader = response.body.getReader(); let text = "";
      while (!text.includes("synthetic-answer")) text += new TextDecoder().decode((await reader.read()).value);
      if (mode === "pending") { const reading = reader.read(); await reader.cancel(); await reading; await reader.closed; }
      else await assert.rejects(async () => { for (;;) if ((await reader.read()).done) throw new Error("unexpected EOF instead of expiry"); }, /Mythos source deadline/);
      await reader.closed.catch(() => {}); reader.releaseLock();
    }
    const outcomes = await Promise.allSettled(tails);
    const proof = await (await source.fetch(new Request("https://fixture.example/retire"))).json();
    assert.equal(proof.sourceCancellation.pending, 0);
    assert.equal(outcomes[0].status, mode === "expiry" ? "rejected" : "fulfilled");
    assert.equal(proof.sourceCancellation.expired, mode === "expiry");
    assert.equal(proof.sourceCancellation.cancelCalls, mode === "expiry" ? 0 : 1);
    assert.equal(proof.sourceCancellation.cancelReturned, mode === "expiry" ? 0 : 1);
    assert.equal(proof.sourceCancellation.failed > 0, mode === "expiry");
    // Other expected requests are deliberately absent in this negative control.
    assert.equal(proof.accepted, false);
  }
});

test(phase + " Mythos real Worker pricing, denials, fragmented responses and cancellation retire independently", { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-mythos-worker-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleMythosOutcome(routerFixture()), upstreamFixture()); const origin = await setup(mf);
    for (const row of cases.filter(row => !row.count)) {
      if (row.id === "revoked") assert.equal((await fetch(origin + "/fixture/revoke", { method: "POST" })).status, 204);
      const controller = new AbortController();
      const response = await fetch(origin + nativePath, { method: "POST", signal: controller.signal, headers: { "x-api-key": token(row.id), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, messages: [{ role: "user", content: "synthetic Mythos fixture" }], stream: true, max_tokens: row.max, ...modifiers(row.id) }) });
      if (row.denied) { assert.ok(response.status >= 400, row.id); await response.text(); continue; }
      assert.equal(response.status, 200, row.id);
      if (row.id === "cancel") {
        const reader = response.body.getReader(); let delivered = "";
        while (!delivered.includes("synthetic-answer")) { const next = await reader.read(); assert.equal(next.done, false); delivered += new TextDecoder().decode(next.value); }
        assert.match(delivered, /synthetic-answer/);
        const originalRead = reader.read(); controller.abort(); await Promise.allSettled([originalRead, reader.closed]); reader.releaseLock();
      } else assert.match(await response.text(), /synthetic-answer/);
    }
    await countTokens(origin);
    await verifyCallsAndUsage(mf, origin, false); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

async function runNative(t, fixture, origin, invoke = runOpenClawConsumer) {
    let receipts = 0;
    const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
      return text => { receipts += text.split("\n").filter(line => line.trim() === "MYTHOS_CANCEL_RETIRED " + phase).length; t.diagnostic(text); };
    } });
    await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/anthropic/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_MYTHOS_CONTRACT: phase, ANTHROPIC_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", NO_COLOR: "1" } });
    assert.equal(receipts, 1, "actual native cancellation and independent SDK cleanup receipt");
}

test(phase + " Mythos native runner binds its phase, credentials and exact cancellation receipt", async () => {
  const origin = "https://fixture.example";
  const invoke = lines => async (context, options) => {
    assert.equal(options.sourceHead, sourceHead);
    assert.equal(options.testPath, "extensions/anthropic/worker-contract.test.ts");
    assert.equal(options.env.CLAWROUTER_MYTHOS_CONTRACT, phase);
    assert.equal(options.env.CLAWROUTER_CONTRACT_ORIGIN, origin);
    assert.equal(options.env.ANTHROPIC_API_KEY, "must-not-fallback");
    assert.equal(options.env.FIREWORKS_API_KEY, undefined);
    assert.equal(options.env.MINIMAX_API_KEY, undefined);
    assert.equal(options.env.OPENAI_API_KEY, "must-not-fallback");
    for (const line of lines) context.diagnostic(line);
  };
  const receipt = "MYTHOS_CANCEL_RETIRED " + phase;
  const foreign = "MYTHOS_CANCEL_RETIRED foreign";
  await runNative({ diagnostic() {} }, "/synthetic/mythos.test.ts", origin, invoke([foreign, receipt]));
  for (const lines of [[], [foreign], ["MISTRAL_CANCEL_RETIRED"], [receipt, receipt]])
    await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/mythos.test.ts", origin, invoke(lines)));
});

test(phase + " actual registered Mythos native SDK through Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-mythos-sdk-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleMythosOutcome(routerFixture()), upstreamFixture()); const origin = await setup(mf);
    const fixture = join(temporary, "mythos-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    await runNative(t, fixture, origin);
    await countTokens(origin);
    await verifyCallsAndUsage(mf, origin, true); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
