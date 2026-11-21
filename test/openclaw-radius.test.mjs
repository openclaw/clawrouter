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
const phase = "configured", models = ["tenant/model"];
const cases = [
  {
    "id": "stream",
    "model": "tenant/model",
    "max": 128
  },
  {
    "id": "tools",
    "model": "tenant/model",
    "max": 128
  },
  {
    "id": "off",
    "model": "tenant/model",
    "max": 128,
    "effort": "off"
  },
  {
    "id": "high",
    "model": "tenant/model",
    "max": 128,
    "effort": "high"
  },
  {
    "id": "unpriced",
    "model": "tenant/model",
    "max": 128,
    "denied": true
  },
  {
    "id": "invalid",
    "model": "tenant/model",
    "max": 128,
    "denied": true
  },
  {
    "id": "foreign",
    "model": "tenant/model",
    "max": 128,
    "denied": true
  },
  {
    "id": "depleted",
    "model": "tenant/model",
    "max": 128,
    "denied": true
  },
  {
    "id": "model_denied",
    "model": "tenant/model",
    "max": 128,
    "denied": true
  },
  {
    "id": "error",
    "model": "tenant/model",
    "max": 128
  },
  {
    "id": "cancel",
    "model": "tenant/model",
    "max": 128
  }
];
const charged = cases.filter(row => !row.denied), ownerId = id => "radius_" + id;
const token = id => id === "invalid" ? "clawrouter-live-radius_stream-invalid" : `clawrouter-live-radius_${id}-fixture-secret`;
const secret = id => "synthetic-radius-" + id;
const upstreamUrl = "https://radius.pi.dev/v1/messages";
const nativePath = "/v1/native/radius/messages";
const canonicalModel = row => snapshot.providers.find(provider => provider.id === "radius").models.find(model => model.upstream === row.model)?.id ?? row.model;
const fixtureText = readFileSync(new URL("./fixtures/openclaw-radius-contract.test.ts", import.meta.url), "utf8");
// One implementation, reused as source. No Qianfan runtime evidence transfers.
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const start = donor.indexOf("type OriginalOperation ="), end = donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(start >= 0 && end > start);
const observerSource = donor.slice(start, end), observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings };")();
const marker = "/* OWNED_LIFETIME_IMPLEMENTATION */";
assert.equal(fixtureText.split(marker).length, 2);
const assembledFixture = fixtureText.replace(marker, observerSource);

const workerOutcomePins = {"proxy.ts": "049fcf654ac923e165bdc41baa1bffac4890cbffeb0d79e3b22b0c15f645f656", "proxy-response.ts": "310c94195a2783ed5791a5471944486df33c5eaf781e0dea619a4288ce9d4174", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
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
    // Radius bypasses the ordinary Chat completion wrapper. Its original
    // fetched reader belongs directly to observeUsage, not to a forwarded body.
    edit('  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);',
      '  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);\n  if (responseFormat === "radius.messages") qianfanOutcome.current.bind(operation, response, reader);');
    edit('        const next = await input.read(() => reader.read());',
      '        if (responseFormat === "radius.messages") qianfanOutcome.current.readStart(operation, reader);\n        const next = await input.read(() => reader.read());\n        if (responseFormat === "radius.messages") qianfanOutcome.current.readDone(operation, reader);');
    edit('      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }',
      '      } catch (error) { if (responseFormat === "radius.messages") qianfanOutcome.current.failure(operation, reader, error); if (!finished) { finish("failed", error); controller.error(error); } }');
    edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { qianfanOutcome } from "qianfan-outcome-witness";\n' + text;
}
async function bundleRadiusOutcome(contents) {
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
const lifetime = createLifetimeObserver(undefined, { ownerId: "radius_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of cases) {
  const id = "radius_" + row.id;
  ingress.expect(id, "chat", ${JSON.stringify(nativePath)}, "POST", row.id === "invalid" ? "clawrouter-live-radius_stream-invalid" : "clawrouter-live-" + id + "-fixture-secret");
  if (!row.denied) outbound.expect(id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-radius-" + row.id);
}
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) {
  const owner = outbound.claim(args[0], args[1], "chat");
  owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed);
  if (!owner.ingress) throw new Error("unbound Radius outbound request");
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
    for (const row of cases) if (row.id !== "invalid") await putGrantCredentials(env, "oauth/radius_" + row.id + "/radius", { provider: "radius", kind: "api_key", enabled: true, credential: "synthetic-radius-" + row.id });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retire") return retire(request);
  if (path !== ${JSON.stringify(nativePath)}) return handler.fetch(request, { ...env, RADIUS_API_KEY: "must-not-router-fallback" }, context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = ingress.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, { ...env, RADIUS_API_KEY: "must-not-router-fallback" }, context], owner);
} };`;
}

function upstreamFixture() {
  return `${observerCode}
const lifetime = createLifetimeObserver(), bindings = createRequestBindings(), calls = [], owners = new Map();
for (const row of ${JSON.stringify(charged)}) bindings.expect("radius_" + row.id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-radius-" + row.id);
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner);
  const id = owner.id.slice("radius_".length), call = { id, url: request.url, authorization: request.headers.get("authorization"), body, cancelled: false, expired: false };
  calls.push(call); owners.set(owner, call);
  const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
  const usage = { input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76, cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, total: 396 } };
  const first = frame({ type: "start" }) + frame({ type: "text_start", contentIndex: 0 }) + frame({ type: "text_delta", contentIndex: 0, delta: "synthetic-answer" });
  const textEnd = frame({ type: "text_end", contentIndex: 0, content: "synthetic-answer", contentSignature: "synthetic-text-signature" });
  const reasoning = frame({ type: "thinking_start", contentIndex: 1 }) + frame({ type: "thinking_delta", contentIndex: 1, delta: "synthetic-reasoning" })
    + frame({ type: "thinking_end", contentIndex: 1, content: "synthetic-reasoning", contentSignature: "synthetic-thinking-signature" });
  const tool = frame({ type: "toolcall_start", contentIndex: 2, id: "response-tool", toolName: "lookup" }) + frame({ type: "toolcall_delta", contentIndex: 2, delta: '{"query":"fixture"}' })
    + frame({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "response-tool", name: "lookup", arguments: { query: "fixture" }, thoughtSignature: "synthetic-tool-signature" } });
  const wire = first + (id === "cancel" ? "" : textEnd + (id === "error" ? frame({ type: "error", reason: "error", errorMessage: "synthetic-radius-error", usage })
    : reasoning + tool + frame({ type: "done", reason: "toolUse", usage, responseId: "synthetic-response" })));
  const bytes = new TextEncoder().encode(wire); let offset = 0, heartbeat, wake, expiry, controller;
  let resolveProducer, rejectProducer, complete = false;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
  lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(expiry); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  expiry = setTimeout(() => { call.expired = true; const error = new Error("Radius source deadline"); finish(true, error); controller?.error(error); }, 10000);
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
    const owner = bindings.bindings.find(row => row.id === "radius_cancel"), call = owners.get(owner), owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
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
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "openai" : "radius"],
      models: [row.id === "model_denied" ? "radius/unselected" : canonicalModel(row)],
      grantRouting: { eligibleGrants: { radius: ["radius"] }, environmentFallback: false },
      tenantId: "fixture", monthlyBudgetMicros: row.id === "depleted" ? 0 : 10_000_000,
      budgetMode: "reserve", requestCostMicros: row.id === "unpriced" ? null : 7, retainRequestContent: false }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
  }
  await kv.put("connections/radius", JSON.stringify({ providerId: "radius", enabled: true, monthlyBudgetMicros: 100_000_000 }));
  const origin = String(await mf.ready).replace(/\/$/, "");
  assert.equal((await fetch(origin + "/fixture/grants")).status, 204);
  const response = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer " + token("stream") } });
  assert.equal(response.status, 200); const catalog = await response.json(), provider = catalog.providers.find(row => row.id === "radius");
  assert.equal(catalog.scope.credentialId, ownerId("stream"));
  assert.equal(provider.id, "radius");
  assert.deepEqual(provider.models, [], "explicit tenant model is not a fabricated bundled catalog model");
  return origin;
}

async function verifyCallsAndUsage(mf, origin, native) {
  const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
  assert.deepEqual(calls.map(call => call.id).sort(), charged.map(row => row.id).sort());
  for (const call of calls) {
    const row = cases.find(row => row.id === call.id); assert.ok(row);
    assert.equal(call.url, upstreamUrl); assert.equal(call.authorization, "Bearer " + secret(row.id));
    assert.equal(call.body.model, row.model); assert.equal(call.body.options.maxTokens, row.max); assert.notEqual(call.expired, true);
    assert.deepEqual(Object.keys(call.body).sort(), ["context", "model", "options"]);
    assert.equal(call.body.options.reasoning, row.effort === "off" ? undefined : row.effort);
    if (native) {
      assert.equal(call.body.context.systemPrompt, "Synthetic instructions");
      const prior = call.body.context.messages.find(message => message.role === "assistant"), tool = call.body.context.messages.find(message => message.role === "toolResult");
      assert.ok(prior.content.some(part => part.type === "thinking" && part.thinkingSignature === "synthetic-replay-signature"));
      assert.equal(prior.content.find(part => part.type === "toolCall").id, tool.toolCallId);
      assert.equal(tool.toolCallId, "callfixture"); assert.deepEqual(tool.content, [{ type: "text", text: "synthetic-tool-result" }]);
      assert.equal(call.body.context.tools[0].name, "lookup");
    }
    assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-/);
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
    const incomplete = row.id === "cancel", cost = row.denied ? 0 : 7;
    assert.equal(event.actual_cost_micros, cost, row.id); assert.equal(usage.budget.spentMicros, cost, row.id);
    if (!row.denied) {
      assert.equal(event.reserved_cost_micros, 7); assert.equal(event.provider, "radius"); assert.equal(event.model, canonicalModel(row));
      assert.equal(event.status, row.id === "error" ? "provider_error" : incomplete ? "client_error" : "success");
      assert.equal(event.cost_basis, "policy_fixed");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], incomplete ? [null, null, null] : [64, 12, 76]);
      if (!incomplete) assert.equal(event.cached_input_tokens, 10);
    } else assert.notEqual(event.status, "success");
    assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|synthetic-radius|fixture-secret|must-not-/);
  }
}

async function retire(mf, acceptedConsumer) {
  let upstream;
  await preserveFailures(async () => {
    upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream);
    assert.deepEqual(upstream.sourceCancellation, { ownerId: "radius_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
  }, [async () => {
    const response = await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) });
    assertProof(await response.json());
  }]);
}

test(phase + " Radius owned cleanup preserves falsey failures and attempts independent retirement", async () => {
  const attempts = [];
  await assert.rejects(preserveFailures(() => { throw undefined; }, [() => { attempts.push(1); throw null; }, () => attempts.push(2)]), error => error.errors[0] === undefined && error.errors[1] === null);
  assert.deepEqual(attempts, [1, 2]);
});

test(phase + " Radius request bindings reject foreign credentials, duplicate claims and missing original calls", () => {
  const bindings = createRequestBindings(); bindings.expect("card", "chat", upstreamUrl, "POST", "synthetic");
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer foreign" } }, "chat"));
  assert.throws(() => bindings.verify());
  bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic" } }, "chat"); bindings.verify();
  assert.throws(() => bindings.claim(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic" } }, "chat"));
});

test(phase + " Radius native assembly uses the exact owned observer and a unique pinned workflow row", () => {
  assert.ok(!assembledFixture.includes(marker)); assert.equal(assembledFixture.split(observerSource).length, 2);
  assert.doesNotThrow(() => stripTypeScriptTypes(assembledFixture));
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.consumer === "radius"), [{ consumer: "radius", ref: sourceHead, test: "test/openclaw-radius.test.mjs" }]);
  assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  const provider = snapshot.providers.find(row => row.id === "radius"), chat = provider.endpoints.find(row => row.id === "messages");
  assert.equal(cases.length, 11);
  const fixtureCases = JSON.parse(fixtureText.match(/const cases = (\[[^\n]+\]);/)[1]); assert.deepEqual(fixtureCases, cases);
  assert.ok(assembledFixture.includes('assert.equal(process.env.CLAWROUTER_RADIUS_CONTRACT, "configured")'));
  assert.ok(assembledFixture.includes('console.log("RADIUS_CANCEL_RETIRED configured")'));
  assert.equal(nativePath, "/v1/native/radius" + chat.path); assert.equal(upstreamUrl, provider.base_urls.default + chat.path);
});

test(phase + " Radius original reader rejection and independent release errors remain fatal", async () => {
  for (const reason of [undefined, new Error("synthetic independent")]) {
    const life = createLifetimeObserver(), owner = {}, response = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
    life.response(response, owner); const reader = response.body.getReader();
    await reader.read().catch(() => {}); await reader.closed.catch(() => {}); reader.releaseLock();
    await assert.rejects(life.join(), error => error.errors.includes(reason)); life.restore();
  }
});

test(phase + " Radius failed upstream proof still joins router retirement and preserves undefined cleanup", async () => {
  for (const failure of [undefined, new Error("synthetic source failure")]) {
    let routerAttempts = 0;
    const mf = { async getWorker() { return { fetch() { return Promise.reject(failure); } }; },
      dispatchFetch() { routerAttempts++; return Promise.reject(undefined); } };
    await assert.rejects(retire(mf, false), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === undefined);
    assert.equal(routerAttempts, 1);
  }
});

test(phase + " Radius acquisition observation preserves detached release and rejects its independent failure", async () => {
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

test(phase + " Radius source proof joins actual early and pending-pull cancellation without manufacturing completion", { timeout: 20_000 }, async () => {
  for (const mode of ["early", "pending", "expiry"]) {
    const source = new Function(upstreamFixture().replace("export default", "return"))(), tails = [];
    const response = await source.fetch(new Request(upstreamUrl, { method: "POST", headers: { authorization: "Bearer " + secret("cancel") },
      body: JSON.stringify({ model: models[0], context: { messages: [] } }) }), {}, { waitUntil(value) { tails.push(value); } });
    assert.equal(tails.length, 1); let settled = false; void tails[0].then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false, "returning headers does not retire the producer");
    if (mode === "early") await response.body.cancel();
    else {
      const reader = response.body.getReader(); let text = "";
      while (!text.includes("synthetic-answer")) text += new TextDecoder().decode((await reader.read()).value);
      if (mode === "pending") { const reading = reader.read(); await reader.cancel(); await reading; await reader.closed; }
      else await assert.rejects(async () => { for (;;) if ((await reader.read()).done) throw new Error("unexpected EOF instead of expiry"); }, /Radius source deadline/);
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

test(phase + " Radius real Worker pricing, denials, fragmented responses and cancellation retire independently", { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-radius-worker-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleRadiusOutcome(routerFixture()), upstreamFixture()); const origin = await setup(mf);
    for (const row of cases) {
      const controller = new AbortController();
      const response = await fetch(origin + nativePath, { method: "POST", signal: controller.signal, headers: { authorization: "Bearer " + token(row.id), "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, context: { messages: [{ role: "user", content: "synthetic Radius fixture" }] }, options: { maxTokens: row.max, ...(row.effort ? { reasoning: row.effort } : {}) } }) });
      if (row.denied) { assert.ok(response.status >= 400, row.id); await response.text(); continue; }
      assert.equal(response.status, 200, row.id + (response.status === 200 ? "" : ": " + await response.clone().text()));
      if (row.id === "cancel") {
        const reader = response.body.getReader(); let delivered = "";
        while (!delivered.includes("synthetic-answer")) { const next = await reader.read(); assert.equal(next.done, false); delivered += new TextDecoder().decode(next.value); }
        assert.match(delivered, /synthetic-answer/);
        const originalRead = reader.read(); controller.abort(); await Promise.allSettled([originalRead, reader.closed]); reader.releaseLock();
      } else assert.match(await response.text(), /synthetic-answer/);
    }
    await verifyCallsAndUsage(mf, origin, false); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

async function runNative(t, fixture, origin, invoke = runOpenClawConsumer) {
    let receipts = 0;
    const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver);
      return text => { receipts += text.split("\n").filter(line => line.trim() === "RADIUS_CANCEL_RETIRED " + phase).length; t.diagnostic(text); };
    } });
    await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/radius/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_RADIUS_CONTRACT: phase, RADIUS_API_KEY: "must-not-sdk-fallback", OPENAI_API_KEY: "must-not-openai-fallback", NO_COLOR: "1" } });
    assert.equal(receipts, 1, "actual native cancellation and independent SDK cleanup receipt");
}

test(phase + " Radius native runner binds its phase, credentials and exact cancellation receipt", async () => {
  const origin = "https://fixture.example";
  const invoke = lines => async (context, options) => {
    assert.equal(options.sourceHead, sourceHead);
    assert.equal(options.testPath, "extensions/radius/worker-contract.test.ts");
    assert.equal(options.env.CLAWROUTER_RADIUS_CONTRACT, phase);
    assert.equal(options.env.CLAWROUTER_CONTRACT_ORIGIN, origin);
    assert.equal(options.env.RADIUS_API_KEY, "must-not-sdk-fallback");
    assert.equal(options.env.MISTRAL_API_KEY, undefined);
    assert.equal(options.env.MINIMAX_API_KEY, undefined);
    assert.equal(options.env.OPENAI_API_KEY, "must-not-openai-fallback");
    for (const line of lines) context.diagnostic(line);
  };
  const receipt = "RADIUS_CANCEL_RETIRED " + phase;
  const foreign = "RADIUS_CANCEL_RETIRED foreign";
  await runNative({ diagnostic() {} }, "/synthetic/radius.test.ts", origin, invoke([foreign, receipt]));
  for (const lines of [[], [foreign], ["MISTRAL_CANCEL_RETIRED"], [receipt, receipt]])
    await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/radius.test.ts", origin, invoke(lines)));
});

test(phase + " actual registered Radius native SDK through Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-radius-sdk-")); let mf, accepted = false;
  await preserveFailures(async () => {
    mf = await startBundledWorkerdFixture(temporary, await bundleRadiusOutcome(routerFixture()), upstreamFixture()); const origin = await setup(mf);
    const fixture = join(temporary, "radius-contract.test.ts"); await writeFile(fixture, assembledFixture, { flag: "wx", mode: 0o600 });
    await runNative(t, fixture, origin);
    await verifyCallsAndUsage(mf, origin, true); accepted = true;
  }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});
