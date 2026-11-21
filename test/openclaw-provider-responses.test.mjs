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
for (const phase of ["xai", "openrouter", "perplexity"]) {
const xai = phase === "xai", perplexity = phase === "perplexity";
const modelId = xai ? "grok-4.7" : perplexity ? "openai/gpt-5.6-sol" : "openai/gpt-6.1-terra";
const cases = [
  ...["stream", "replay", "no_effort", ...(!perplexity ? ["image"] : []), "low", "error", "cancel", ...(xai ? ["priority", "long", "priority_long", "unknown_bill"] : perplexity ? [] : ["chat"])].map(id => ({ id, model: modelId, image: id === "image", max: 128 })),
  ...["invalid", "foreign", "budget", "model_denied", ...(xai ? ["stored", "hosted"] : perplexity ? ["unpriced", "stored", "stale"] : ["unpriced"])].map(id => ({ id, model: modelId, max: 128, denied: true })),
];
const charged = cases.filter(row => !row.denied), ownerId = id => "responses_" + id;
const token = id => id === "invalid" ? "clawrouter-live-responses_stream-invalid" : `clawrouter-live-responses_${id}-fixture-secret`;
const secret = id => "synthetic-responses-" + id;
const upstreamBase = xai ? "https://api.x.ai/v1" : perplexity ? "https://api.perplexity.ai/v1" : "https://openrouter.ai/api/v1";
const upstreamUrl = upstreamBase + "/responses", nativeBase = perplexity ? "/v1" : "/v1/native/" + phase + "/v1";
const nativePath = nativeBase + "/responses";
const pathFor = id => nativeBase + (id === "chat" ? "/chat/completions" : "/responses");
const urlFor = id => upstreamBase + (id === "chat" ? "/chat/completions" : "/responses");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const fixtureText = readFileSync(new URL("./fixtures/openclaw-provider-responses-contract.test.ts", import.meta.url), "utf8");
// One implementation, reused as source. No Qianfan runtime evidence transfers.
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
const observerSource = donor.slice(start, end), observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings };")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
const assembledFixture = fixtureText.replace(marker, observerSource);

const workerOutcomePins = {"proxy.ts": "03aae280d322b27c39f0a39f004bf894dfee39328cb380633d749eddf09f1312", "proxy-response.ts": "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
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
async function bundleResponsesOutcome(contents) {
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

function routerFixture(native = false, agent = false) {
  const ingressBase = agent ? "/v1/native/perplexity/v1" : nativeBase;
  const ingressPath = agent ? ingressBase + "/agent" : nativePath;
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
const cases = ${JSON.stringify(cases)}, ingress = createRequestBindings(), outbound = createRequestBindings();
let sourceCancellation, acceptedConsumer = false;
const lifetime = createLifetimeObserver(undefined, { ownerId: "responses_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of cases) {
  const id = "responses_" + row.id;
  if (!(${perplexity && native} && row.denied && !["stored", "stale"].includes(row.id))) ingress.expect(id, "chat", ${JSON.stringify(ingressBase)} + (row.id === "chat" ? "/chat/completions" : ${JSON.stringify(agent ? "/agent" : "/responses")}), "POST", row.id === "invalid" ? "clawrouter-live-responses_stream-invalid" : "clawrouter-live-" + id + "-fixture-secret");
  if (!row.denied) outbound.expect(id, "chat", ${JSON.stringify(upstreamBase)} + (row.id === "chat" ? "/chat/completions" : ${JSON.stringify(agent ? "/agent" : "/responses")}), "POST", "synthetic-responses-" + row.id);
}
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  const owner = outbound.claim(args[0], args[1], "chat");
  owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
  if (!owner.ingress) throw new Error("unbound Responses outbound request");
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
    for (const row of cases) if (row.id !== "invalid") await putGrantCredentials(env, "oauth/responses_" + row.id + "/${phase}", { provider: "${phase}", kind: "api_key", enabled: true, credential: "synthetic-responses-" + row.id });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/revoke" && ${perplexity}) return (async () => {
    await revokeGrantCredentials(env, "oauth/responses_stale/perplexity", { provider: "perplexity", kind: "api_key" });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (![${JSON.stringify(ingressPath)}, ${JSON.stringify(nativeBase + "/chat/completions")}].includes(path)) return handler.fetch(request, { ...env, XAI_API_KEY: "must-not-fallback", OPENROUTER_API_KEY: "must-not-fallback", PERPLEXITY_API_KEY: "must-not-fallback" }, context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = ingress.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, { ...env, XAI_API_KEY: "must-not-fallback", OPENROUTER_API_KEY: "must-not-fallback", PERPLEXITY_API_KEY: "must-not-fallback" }, context], owner);
} };`;
}

function upstreamFixture(agent = false) {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [], owners = new Map();
for (const row of ${JSON.stringify(charged)}) bindings.expect("responses_" + row.id, "chat", ${JSON.stringify(upstreamBase)} + (row.id === "chat" ? "/chat/completions" : ${JSON.stringify(agent ? "/agent" : "/responses")}), "POST", "synthetic-responses-" + row.id);
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const id = owner.id.slice("responses_".length), call = { id, url: request.url, authorization: request.headers.get("authorization"), body, cancelled: false, expired: false };
  calls.push(call); owners.set(owner, call);
  const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
  const long = id === "long" || id === "priority_long", priority = id === "priority" || id === "priority_long";
  const input = long ? 200000 : 11, cached = long ? 40000 : 4, output = 3;
  const micros = (long ? 680036 : 34) * (priority ? 2 : 1);
  const usage = { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, total_tokens: input + output,
    ...(id === "unknown_bill" || ${!xai} ? {} : { cost_in_usd_ticks: micros * 10000 }) };
  const reasoning = { type: "reasoning", id: "rs_synthetic", summary: [{ type: "summary_text", text: "synthetic-summary" }], encrypted_content: "synthetic-encrypted-reasoning" };
  const tool = { type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: "lookup", arguments: "{}", status: "completed" };
  const message = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic-answer", annotations: [] }] };
  const textEvents = [{ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "synthetic-answer" }];
  const replayEvents = [{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
    { type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: "synthetic-summary" },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: tool.id, output_index: 1, delta: "{}" },
    { type: "response.function_call_arguments.done", item_id: tool.id, output_index: 1, arguments: "{}" },
    { type: "response.output_item.done", output_index: 1, item: tool }];
  const events = id === "stream" ? replayEvents : textEvents;
  const completed = { type: "response.completed", response: { id: "resp_synthetic_" + id, object: "response", model: body.model, status: "completed", output: id === "stream" ? [reasoning, tool] : [message], usage,
    ...(priority ? { service_tier: "priority" } : {}) } };
  const first = id === "chat" ? frame({ id: "chat_synthetic", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })
    : events.map(frame).join("");
  const wire = first + (id === "error" ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
    : id === "cancel" ? "" : id === "chat" ? "data: [DONE]\\n\\n" : (id === "stream" ? "" : frame({ type: "response.output_item.done", output_index: 0, item: message })) + frame(completed));
  const bytes = new TextEncoder().encode(wire); let offset = 0, heartbeat, wake, expiry, controller;
  let resolveProducer, rejectProducer, complete = false;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("Responses source deadline"); finish(true, error); controller?.error(error); }, 10000);
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
    const owner = bindings.bindings.find(row => row.id === "responses_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
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
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "google" : phase],
      models: [phase + "/" + (row.id === "model_denied" ? "other-model" : modelId)],
      grantRouting: { eligibleGrants: { [phase]: [phase] }, environmentFallback: false },
      tenantId: "fixture", monthlyBudgetMicros: row.id === "budget" ? 0 : 100_000_000,
      budgetMode: "reserve", requestCostMicros: xai || row.id === "unpriced" ? null : 7, retainRequestContent: false }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/" + phase, JSON.stringify({ providerId: phase, enabled: true, monthlyBudgetMicros: 200_000_000 }));
  const origin = String(await mf.ready).replace(/\/$/, "");
  assert.equal((await fetch(origin + "/fixture/grants")).status, 204);
  const response = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token("stream") } });
  assert.equal(response.status, 200); const catalog = await response.json(), provider = catalog.providers.find(row => row.id === phase);
  assert.equal(catalog.scope.credentialId, ownerId("stream"));
  assert.deepEqual(provider.models.map(row => row.id), [phase + "/" + modelId]);
  assert.ok(provider.offers.some(row => row.modelId === phase + "/" + modelId && row.routeKind === "native" && row.eligible));
  return origin;
}

async function verifyCallsAndUsage(mf, origin, native, agent = false) {
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
  assert.deepEqual(calls.map(call => call.id).sort(), charged.map(row => row.id).sort(), "actual dispatch count, including SDK recovery, must match original invocations");
  for (const call of calls) {
    const row = cases.find(row => row.id === call.id); assert.ok(row);
    assert.equal(call.url, agent ? upstreamBase + "/agent" : urlFor(row.id)); assert.equal(call.authorization, "Bearer " + secret(row.id));
    assert.equal(call.body.model, modelId); assert.equal(call.body.stream, true); assert.equal(call.expired, false);
    if (row.id === "chat") assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
    else {
      assert.equal(call.body.max_output_tokens, 128); assert.equal(call.body.store, false);
      assert.equal(call.body.previous_response_id, undefined); assert.equal(call.body.conversation, undefined);
      assert.equal(call.body.service_tier, ["priority", "priority_long"].includes(row.id) ? "priority" : undefined);
      if (native) {
        if (xai || row.id !== "no_effort") assert.ok(call.body.include?.includes("reasoning.encrypted_content"));
        if (row.id === "low") assert.equal(call.body.reasoning?.effort, "low");
        if (row.id === "replay") {
          const reason = call.body.input.filter(item => item.type === "reasoning"), tool = call.body.input.filter(item => item.type === "function_call"), result = call.body.input.filter(item => item.type === "function_call_output");
          assert.equal(reason.length, 1); assert.equal(reason[0].encrypted_content, "synthetic-encrypted-reasoning");
          assert.equal(reason[0].id, undefined); assert.deepEqual(reason[0].summary, [], "SDK canonicalization removes clear summary while preserving ciphertext");
          assert.equal(tool.length, 1); assert.equal(result.length, 1); assert.equal(tool[0].call_id, result[0].call_id);
          assert.equal(tool[0].call_id, "call_synthetic"); assert.equal(tool[0].name, "lookup"); assert.equal(tool[0].arguments, "{}");
          assert.equal(result[0].output, "synthetic-tool-result");
        }
        const images = call.body.input.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image").map(part => part.image_url) : []);
        assert.deepEqual(images, row.image ? ["data:image/png;base64," + png] : []);
      }
    }
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
  }
  for (const row of cases.filter(row => row.id !== "invalid")) {
    let usage;
    for (let attempt = 0; attempt < 150; attempt++) {
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(row.id) } })).json();
      if (usage.usage.events.length === 1 || native && perplexity && row.denied && !["stored", "stale"].includes(row.id)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (native && perplexity && row.denied && !["stored", "stale"].includes(row.id)) { assert.equal(usage.usage.events.length, 0, row.id + " catalog denial has no inference attempt"); continue; }
    assert.equal(usage.usage.events.length, 1, row.id + " authenticated attempt receipt");
    const [event] = usage.usage.events;
    assert.equal(event.credential_id, ownerId(row.id)); assert.equal(event.policy_id, ownerId(row.id));
    const incomplete = ["error", "cancel"].includes(row.id), unknown = incomplete || row.id === "unknown_bill";
    const long = ["long", "priority_long"].includes(row.id), priority = ["priority", "priority_long"].includes(row.id);
    const cost = row.denied ? 0 : xai ? unknown ? event.reserved_cost_micros : (long ? 680036 : 34) * (priority ? 2 : 1) : 7;
    assert.equal(event.actual_cost_micros, cost, row.id); assert.equal(usage.budget.spentMicros, cost, row.id);
    if (!row.denied) {
      assert.ok(cost > 0); assert.equal(event.provider, phase); assert.equal(event.model, phase + "/" + modelId);
      assert.equal(event.status, row.id === "error" ? "provider_error" : row.id === "cancel" ? "client_error" : "success");
      assert.equal(event.cost_basis, xai ? unknown ? "manifest_request_reservation" : "provider_reported" : "policy_fixed");
      if (xai) { assert.ok(event.reserved_cost_micros > 50000); assert.equal(event.reserved_output_tokens, 500000); }
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], incomplete ? [null, null, null] : [long ? 200000 : 11, 3, long ? 200003 : 14]);
    } else assert.notEqual(event.status, "success");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|synthetic-responses|fixture-secret|must-not-fallback/);
  }
}

async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "responses_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}

test(phase + " Responses owned cleanup preserves falsey failures and attempts independent retirement", async () => {
  const attempts = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempts.push(1); throw null; }, () => attempts.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempts, [1, 2]);
});

test(phase + " Responses cancellation selects the POST owner despite an earlier same-case catalog request", () => {
  const begin = fixtureText.indexOf("function cancellationOwner("), end = fixtureText.indexOf("// END RESPONSES CANCELLATION OWNER");
  assert.ok(begin >= 0 && end > begin);
  const select = new Function("assert", stripTypeScriptTypes(fixtureText.slice(begin, end)) + "; return cancellationOwner;")(assert);
  const catalog = { id: "cancel", kind: "catalog", method: "GET" }, post = { id: "cancel", kind: "chat", method: "POST" };
  assert.equal(select([catalog, post]), post); assert.equal(select([post, catalog]), post);
  for (const rows of [[], [catalog], [{ ...post, id: "foreign" }], [{ ...post, method: "GET" }], [post, { ...post }]]) assert.throws(() => select(rows));
});

test(phase + " Responses request bindings reject foreign credentials, duplicate claims and missing original calls", () => {
  const bindings = createRequestBindings(); bindings.expect("card", "chat", upstreamUrl, "POST", "synthetic");
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer foreign" } }, "chat"));
  assert.throws(() => bindings.verify());
  bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic" } }, "chat"); bindings.verify();
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic" } }, "chat"));
});

test(phase + " Responses native assembly uses the exact owned observer and a unique pinned workflow row", () => {
  assert.ok(!assembledFixture.includes(marker)); assert.equal(assembledFixture.split(observerSource).length, 2);
  assert.doesNotThrow(() => stripTypeScriptTypes(assembledFixture));
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "provider-responses"), [{ consumer: "provider-responses", ref: sourceHead, test: "test/openclaw-provider-responses.test.mjs" }]);
  assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  const provider = snapshot.providers.find(row => row.id === phase);
  assert.ok(provider.models.some(row => row.upstream === modelId));
  assert.equal(provider.models[0].upstream, xai ? "grok-4.3" : perplexity ? "sonar-pro" : "openrouter/auto");
  assert.equal(cases.length, xai ? 17 : perplexity ? 13 : 13);
});

test(phase + " Responses original reader rejection and independent release errors remain fatal", async () => {
  for (const reason of [undefined, new Error("synthetic independent")]) {
    const life = createLifetimeObserver(), owner = {}, response = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
    life.response(response, owner); const reader = response.body.getReader();
    await reader.read().catch(() => {}); await reader.closed.catch(() => {}); reader.releaseLock();
    await assert.rejects(life.join(), error => error.errors.includes(reason)); life.restore();
  }
});

test(phase + " Responses failed upstream proof still joins router retirement and preserves undefined cleanup", async () => {
  for (const failure of [undefined, new Error("synthetic source failure")]) {
    let routerAttempts = 0;
    const mf = { async getWorker() { return { fetch() { return Promise.reject(failure); } }; },
      dispatchFetch() { routerAttempts++; return Promise.reject(undefined); } };
    await assert.rejects(retire(mf, false), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === undefined);
    assert.equal(routerAttempts, 1);
  }
});

test(phase + " Responses acquisition observation preserves detached release and rejects its independent failure", async () => {
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

test(phase + " Responses source proof joins actual early and pending-pull cancellation without manufacturing completion", { timeout: 20_000 }, async () => {
  for (const mode of ["early", "pending", "expiry"]) {
    const source = new Function(upstreamFixture().replace("export default", "return"))(), tails = [];
    const response = await source.fetch(new Request(upstreamUrl, { method: "POST", headers: { authorization: "Bearer " + secret("cancel") },
      body: JSON.stringify({ model: modelId, messages: [], stream: true }) }), {}, { waitUntil(value) { tails.push(value); } });
    assert.equal(tails.length, 1); let settled = false; void tails[0].then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false, "returning headers does not retire the producer");
    if (mode === "early") await response.body.cancel();
    else {
      const reader = response.body.getReader(); let text = "";
      while (!text.includes("synthetic-answer")) text += new TextDecoder().decode((await reader.read()).value);
      if (mode === "pending") { const reading = reader.read(); await reader.cancel(); await reading; await reader.closed; }
      else await assert.rejects(async () => { for (;;) if ((await reader.read()).done) throw new Error("unexpected EOF instead of expiry"); }, /Responses source deadline/);
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

function requestBody(row) {
  const body = row.id === "chat" ? { model: modelId, messages: [{ role: "user", content: "synthetic Responses fixture" }], stream: true, max_tokens: 128 }
    : { model: perplexity ? phase + "/" + modelId : modelId, input: [{ role: "user", content: [{ type: "input_text", text: "synthetic Responses fixture" }] }], store: false, stream: true, max_output_tokens: 128,
      reasoning: { effort: row.id === "low" ? "low" : "high" }, ...(row.id === "priority" || row.id === "priority_long" ? { service_tier: "priority" } : {}) };
  if (row.id === "stored") body.previous_response_id = "resp_unknown_stored";
  if (row.id === "hosted") body.tools = [{ type: "web_search" }];
  return body;
}

for (const agent of perplexity ? [false, true] : [false]) test(phase + (agent ? " native Agent" : " Responses") + " real Worker pricing, denials, fragmented responses and cancellation retire independently", { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-responses-worker-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture(false, agent)), upstreamFixture(agent)); const origin = await setup(mf);
    for (const row of cases) {
      if (row.id === "stale") {
        const catalog = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token(row.id) } });
        assert.equal(catalog.status, 200); assert.ok(JSON.stringify(await catalog.json()).includes(phase + "/" + modelId));
        assert.equal((await fetch(origin + "/fixture/revoke")).status, 204);
      }
      const controller = new AbortController();
      const response = await fetch(origin + (agent ? "/v1/native/perplexity/v1/agent" : pathFor(row.id)), { method: "POST", signal: controller.signal, headers: { authorization: "Bearer " + token(row.id), "content-type": "application/json" }, body: JSON.stringify(requestBody(row)) });
      if (row.denied) { assert.ok(response.status >= 400, row.id); await response.text(); continue; }
      assert.equal(response.status, 200, row.id);
      if (row.id === "cancel") {
        const reader = response.body.getReader(); let delivered = "";
        while (!delivered.includes('"delta":"synthetic-answer"')) { const next = await reader.read(); assert.equal(next.done, false); delivered += new TextDecoder().decode(next.value); }
        const originalRead = reader.read(); controller.abort(); await Promise.allSettled([originalRead, reader.closed]); reader.releaseLock();
      } else assert.match(await response.text(), row.id === "stream" ? /synthetic-encrypted-reasoning/ : /synthetic-answer/);
    }
    await verifyCallsAndUsage(mf, origin, false, agent); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

async function runNative(t, fixture, origin, invoke = runOpenClawConsumer) {
    let receipts = 0, replays = 0;
    const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
      return text => { receipts += text.split("\n").filter(line => line.trim() === "RESPONSES_CANCEL_RETIRED " + phase).length; replays += text.split("\n").filter(line => line.trim() === "RESPONSES_REPLAY_RETIRED " + phase).length; t.diagnostic(text); };
    } });
    await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/" + (perplexity ? "clawrouter" : phase) + "/worker-responses-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_RESPONSES_PHASE: phase, XAI_API_KEY: "must-not-fallback", OPENROUTER_API_KEY: "must-not-fallback", PERPLEXITY_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", NO_COLOR: "1" } });
    assert.equal(receipts, 1, "actual native cancellation and independent SDK cleanup receipt");
    assert.equal(replays, 1, "actual two-turn registered replay receipt");
}

test(phase + " Responses native runner binds its phase, credentials and exact cancellation receipt", async () => {
  const origin = "https://fixture.example";
  const invoke = lines => async (context, options) => {
    assert.equal(options.sourceHead, sourceHead);
    assert.equal(options.testPath, "extensions/" + (perplexity ? "clawrouter" : phase) + "/worker-responses-contract.test.ts");
    assert.equal(options.env.CLAWROUTER_RESPONSES_PHASE, phase);
    assert.equal(options.env.CLAWROUTER_CONTRACT_ORIGIN, origin);
    assert.equal(options.env.XAI_API_KEY, "must-not-fallback");
    assert.equal(options.env.MISTRAL_API_KEY, undefined);
    assert.equal(options.env.OPENAI_API_KEY, "must-not-fallback");
    for (const line of lines) context.diagnostic(line);
  };
  const receipt = "RESPONSES_CANCEL_RETIRED " + phase;
  const foreign = "RESPONSES_CANCEL_RETIRED " + (xai ? "openrouter" : "xai");
  await runNative({ diagnostic() {} }, "/synthetic/responses.test.ts", origin, invoke([foreign, receipt, "RESPONSES_REPLAY_RETIRED " + phase]));
  for (const lines of [[], [foreign], ["MISTRAL_CANCEL_RETIRED"], [receipt, receipt]])
    await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/responses.test.ts", origin, invoke(lines)));
});

test(phase + " actual registered Responses native SDK through Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-responses-sdk-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture(true)), upstreamFixture()); const origin = await setup(mf);
    const fixture = join(temporary, "responses-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    await runNative(t, fixture, origin);
    await verifyCallsAndUsage(mf, origin, true); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

}
