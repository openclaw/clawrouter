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
const sourceHead = "0bc78154386d7df5d07feefca13441cd582ab3d6";
const sha = value => createHash("sha256").update(value).digest("hex");
const donor = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
assert.equal(sha(donor), "ab514fc2ea8ff572684381413230590e118f7b49826dc1a282736d2e885f6075");
let observerSource = donor.slice(donor.indexOf("type OriginalOperation ="), donor.indexOf("// END ORIGINAL LIFETIME OBSERVERS"));
assert.ok(observerSource.startsWith("type OriginalOperation ="));
// Reuse the existing passive-progress adaptation for Claude 5 quarantine. No
// extra read, cancellation or promise replacement is introduced by this hook.
for (const [before, after] of [
  ["bodySucceeded: () => boolean; current?", "bodySucceeded: () => boolean; readProgress?: (owner: any, value: any) => void; current?"],
  ["if (value?.done === true) row.eof = true;", "if (value?.done === true) row.eof = true; sdk?.readProgress?.(owner, value);"],
]) { assert.equal(observerSource.split(before).length, 2); observerSource = observerSource.replace(before, after); }
const observerCode = stripTypeScriptTypes(observerSource);
const { preserveFailures, createLifetimeObserver, createRequestBindings } = new Function(observerCode + "; return { preserveFailures, createLifetimeObserver, createRequestBindings };")();
// Reuse the landed original-reader/HttpOperation witness, not its prior results.
const responseHarness = readFileSync(new URL("./openclaw-provider-responses.test.mjs", import.meta.url), "utf8");
const outcomeSource = responseHarness.slice(responseHarness.indexOf("const workerOutcomePins ="), responseHarness.indexOf("function assertProof("));
assert.equal(sha(outcomeSource), "7e7419bf3ed4751c823467c32b585f7e9498e20c5995a70d331374ce6e6d50ba");
const { bundleResponsesOutcome } = new Function("assert", "createHash", "createRequire", "readFileSync", "importMetaResolve", outcomeSource.replaceAll("import.meta.resolve", "importMetaResolve") + "; return { bundleResponsesOutcome };")(assert, createHash, createRequire, readFileSync, specifier => import.meta.resolve(specifier));
const fixtureText = readFileSync(new URL("./fixtures/openclaw-opencode-contract.test.ts", import.meta.url), "utf8");
assert.equal(fixtureText.split("/* OWNED_LIFETIME_IMPLEMENTATION */").length, 2);
// Each request still gets a distinct private owner. Repeated transport credentials
// are serial fixture expectations, verified against an authored wire marker below;
// their position alone is never sufficient to accept the request or its receipt.
function createOpenCodeBindings() {
  const bindings = [], seen = new WeakSet();
  return {
    bindings,
    expect(...args) {
      if (bindings.some(row => row.id === args[0] && row.kind === args[1])) throw new Error("duplicate OpenCode expectation");
      const single = createRequestBindings(), row = single.expect(...args); row.binding = single; bindings.push(row); return row;
    },
    claim(input, init, kind) {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input)).href, method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers);
      const identity = request ?? init;
      if (!identity || typeof identity !== "object" || seen.has(identity)) throw new Error("duplicate or unbound OpenCode original input");
      const row = bindings.find(row => !row.claimed && row.kind === kind && row.url === url && row.method === method && headers.get("authorization") === "Bearer " + row.credential);
      if (!row) throw new Error("unbound OpenCode transport");
      const claimed = row.binding.claim(input, init, kind); seen.add(identity); claimed.input = identity; return claimed;
    },
    verify() { for (const row of bindings) row.binding.verify(); },
  };
}
const bindingCode = createOpenCodeBindings.toString();
const assembled = fixtureText.replace("/* OWNED_LIFETIME_IMPLEMENTATION */", observerSource + "\n" + bindingCode);
function credentialFor(id) { return ["replay", "session_conversation"].includes(id) ? "first" : id; }
function assertSessionRelations(calls) {
  const get = id => { const rows = calls.filter(row => row.id === id); assert.equal(rows.length, 1, id); return rows[0]; };
  const first = get("first"), replay = get("replay"), conversation = get("session_conversation"), credential = get("session_credential");
  assert.equal(first.authorization, replay.authorization); assert.equal(first.authorization, conversation.authorization);
  assert.notEqual(first.authorization, credential.authorization);
  assert.equal(first.session, replay.session, "same credential and conversation must retain the derived session");
  assert.notEqual(first.session, conversation.session, "another conversation must not share the derived session");
  assert.notEqual(first.session, credential.session, "another selected credential must not share the derived session");
}
function assertMessagesPrefill(provider, body) {
  if (provider !== "opencode") {
    assert.equal(body.messages.at(-1).role, "assistant", "non-Claude Messages prefill remains labelled");
    return;
  }
  // Claude 5 removes unsupported trailing assistant prefill before transport.
  // Require the original user turn to survive, not merely the absence of an assistant.
  assert.equal(body.messages.length, 1, "Claude 5 must remove only the authored prefill");
  const message = body.messages[0]; assert.equal(message.role, "user");
  const text = typeof message.content === "string" ? message.content : message.content.map(block => {
    assert.equal(block.type, "text"); return block.text;
  }).join("");
  assert.equal(text, "synthetic OpenCode prefill");
}
function assertReasoningReplay(input) {
  const reasons = input.filter(item => item.type === "reasoning"); assert.equal(reasons.length, 1);
  assert.equal(reasons[0].encrypted_content, "synthetic-encrypted");
  assert.equal(reasons[0].id, undefined); assert.deepEqual(reasons[0].summary, []);
}
const formats = { chat: "openai-completions", responses: "openai-responses", messages: "anthropic-messages" };
const suffixes = { chat: "/chat/completions", responses: "/v1/responses", messages: "/v1/messages" };
const models = {
  opencode: { chat: ["glm-5.3", "minimax-m3", "kimi-k3"], responses: ["gpt-5.6-sol"], messages: ["claude-opus-5"] },
  "opencode-go": { chat: ["glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "kimi-k3", "kimi-k2.7-code", "hy3"], responses: ["gpt-5.6-luna"], messages: ["qwen3.8-max"] },
};

function assertProof(proof) {
  assert.equal(proof.accepted, true, JSON.stringify(proof));
  assert.equal(proof.operations, proof.settled); assert.equal(proof.readers, proof.unlocked);
  assert.equal(proof.rejected, proof.qualifiedReadRejections ?? 0);
}

// Complete protocol frames, fragmented by the actual source below. No synthetic
// assistant is injected into replay: the SDK must produce it from these bytes.
function wireFor(protocol, row, model) {
  const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  const data = value => `data: ${JSON.stringify(value)}\n\n`;
  const tool = row.id === "first" || row.id === "dynamic", cancel = row.id === "cancel", error = row.id === "error";
  if (protocol === "chat") {
    const chunk = (delta, finish_reason = null, usage) => data({ id: "chat_synthetic", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
    return chunk(tool ? { role: "assistant", reasoning_content: "synthetic-thinking", tool_calls: [{ index: 0, id: "call_synthetic", type: "function", function: { name: "lookup", arguments: "{}" } }] } : { role: "assistant", content: "synthetic-answer" })
      + (cancel ? "" : error ? data({ error: { message: "synthetic-upstream-error", code: "server_error" } })
        : chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }) + "data: [DONE]\n\n");
  }
  if (protocol === "messages") {
    const parts = tool ? [{ type: "thinking", thinking: "synthetic-thinking", signature: "synthetic-signed-thinking" }, { type: "tool_use", id: "tool_synthetic", name: "lookup", input: {} }] : [{ type: "text", text: "synthetic-answer" }];
    return event({ type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 0 } } })
      + parts.map((part, index) => event({ type: "content_block_start", index, content_block: part.type === "text" ? { type: "text", text: "" } : part.type === "thinking" ? { type: "thinking", thinking: "" } : { ...part, input: {} } })
        + (part.type === "text" ? event({ type: "content_block_delta", index, delta: { type: "text_delta", text: part.text } }) : part.type === "thinking" ? event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part.thinking } }) + event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: part.signature } }) : event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } }))
        + event({ type: "content_block_stop", index })).join("")
      + (cancel ? "" : error ? event({ type: "error", error: { type: "api_error", message: "synthetic-upstream-error" } }) : event({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) + event({ type: "message_stop" }));
  }
  const reason = { type: "reasoning", id: "rs_synthetic", summary: [{ type: "summary_text", text: "synthetic-thinking" }], encrypted_content: "synthetic-encrypted" };
  const call = { type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: row.id === "dynamic" ? "openclaw_web_search" : "lookup", arguments: row.id === "dynamic" ? JSON.stringify({ labels: [{ key: "topic", value: "synthetic" }] }) : "{}", status: "completed" };
  const message = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic-answer", annotations: [] }] };
  const items = tool ? [reason, call] : [message];
  const events = tool ? [
    { type: "response.output_item.added", output_index: 0, item: { ...reason, summary: [] } },
    { type: "response.reasoning_summary_part.added", output_index: 0, item_id: reason.id, summary_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: reason.id, summary_index: 0, delta: "synthetic-thinking" },
    { type: "response.output_item.done", output_index: 0, item: reason },
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: call.id, delta: call.arguments },
    { type: "response.output_item.done", output_index: 1, item: call },
  ] : [{ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } }, { type: "response.content_part.added", output_index: 0, item_id: message.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: "synthetic-answer" }];
  return events.map(data).join("") + (cancel ? "" : error ? data({ error: { message: "synthetic-upstream-error", code: "server_error" } }) : data({ type: "response.completed", response: { id: "resp_synthetic_" + row.id, object: "response", status: "completed", model, output: items, usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } }));
}

for (const [provider, protocols] of Object.entries(models)) for (const [protocol, cards] of Object.entries(protocols)) {
  const phase = provider + ":" + protocol, nativePath = "/v1/native/" + provider + suffixes[protocol];
  const upstreamUrl = "https://opencode.ai/inference" + (provider === "opencode-go" ? "/go" : "") + (protocol === "messages" ? "/anthropic/v1/messages" : protocol === "responses" ? "/openai/v1/responses" : "/openai/v1/chat/completions");
  const cases = [
    ...(provider === "opencode" && protocol === "responses" ? [{ id: "dynamic", model: cards[0], hook: "stream" }, { id: "dynamic_replay", model: cards[0], hook: "stream" }] : []),
    ...(protocol === "messages" ? [{ id: "prefill", model: cards[0], hook: "stream" }] : []),
    ...cards.flatMap((model, i) => ["stream", "simple"].map(hook => ({ id: `card${i}_${hook}`, model, hook }))),
    ...["first", "replay", "session_conversation", "session_credential", "error", "cancel"].map(id => ({ id, model: protocol === "chat" ? "kimi-k3" : cards[0], hook: "stream" })),
    ...(protocol === "messages" ? [] : ["stream", "simple"].map(hook => ({ id: "unified_" + hook, model: cards[0], hook, unified: true }))),
    ...["invalid", "foreign", "budget", "unpriced", "closed"].map(id => ({ id, model: cards[0], hook: "stream", denied: true })),
  ];
  const charged = cases.filter(row => !row.denied), token = id => "clawrouter-live-opencode_" + credentialFor(id) + "-fixture-secret";
  const credentials = cases.filter(row => credentialFor(row.id) === row.id);
  const unifiedPath = protocol === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const payload = JSON.stringify({ phase, provider, protocol, api: formats[protocol], nativePath, unifiedPath, cards, cases });
  function routerFixture(selected = cases) {
    return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
${bindingCode}
const credentialFor = ${credentialFor.toString()};
const cases = ${JSON.stringify(selected)}, ingress = createOpenCodeBindings(), outbound = createOpenCodeBindings(), receipts = [];
let sourceCancellation, acceptedConsumer = false;
const lifetime = createLifetimeObserver(undefined, { ownerId: "opencode_cancel", source: () => acceptedConsumer ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
for (const row of cases) if (!row.denied) { ingress.expect("opencode_" + row.id, "chat", row.unified ? ${JSON.stringify(unifiedPath)} : ${JSON.stringify(nativePath)}, "POST", "clawrouter-live-opencode_" + credentialFor(row.id) + "-fixture-secret"); outbound.expect("opencode_" + row.id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-opencode-" + credentialFor(row.id)); }
const originalFetch = globalThis.fetch;
lifetime.patch(globalThis, "fetch", function (...args) { const owner = outbound.claim(args[0], args[1], "chat"); owner.ingress = ingress.bindings.find(row => row.id === owner.id && row.claimed); if (!owner.ingress) throw new Error("unbound OpenCode outbound"); lifetime.signal(owner, args[1]?.signal ?? args[0]?.signal); return lifetime.invoke("fetch", originalFetch, this, args, owner, response => lifetime.response(response, owner)); });
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => { for (const row of cases) if (row.id !== "invalid" && credentialFor(row.id) === row.id) await putGrantCredentials(env, "oauth/opencode_" + row.id + "/${provider}", { provider: "${provider}", kind: "api_key", enabled: true, credential: "synthetic-opencode-" + row.id }); return new Response(null, { status: 204 }); })();
  if (path === "/fixture/receipts") return Response.json(receipts);
  if (path === "/fixture/retire") return (async () => { let accepted = false; try { await preserveFailures(async () => { const proof = await request.json(); sourceCancellation = proof.sourceCancellation; acceptedConsumer = proof.acceptedConsumer === true; await lifetime.join(); ingress.verify(); outbound.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); } return Response.json({ ...lifetime.summary(), accepted, join: lifetime.joinDiagnostic() }); })();
  const poisoned = { ...env, OPENCODE_API_KEY: "must-not-fallback", OPENCODE_GO_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" };
  if (path === "/v1/catalog" && /opencode_unified_/.test(request.headers.get("authorization") ?? "")) return (async () => {
    const response = await handler.fetch(request, poisoned, context); if (!response.ok) return response;
    const catalog = await response.json();
    // Narrow the real credential-owned offer set; never manufacture eligibility,
    // model metadata, origin, credentials or a new transport.
    for (const row of catalog.providers) if (row.id === ${JSON.stringify(provider)}) row.offers = row.offers.filter(offer => offer.routeKind !== "native");
    return Response.json(catalog, { headers: { "cache-control": "private, no-store" } });
  })();
  if (![${JSON.stringify(nativePath)}, ${JSON.stringify(unifiedPath)}].includes(path)) return handler.fetch(request, poisoned, context);
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = new URL(request.url).origin + row.url;
  const owner = ingress.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); });
  return lifetime.invoke("handler", handler.fetch, handler, [request, poisoned, context], owner, response => { const requestId = response.headers.get("x-clawrouter-request-id"); if (!requestId || receipts.some(row => row.requestId === requestId)) throw new Error("missing or duplicate original request identity"); receipts.push({ id: owner.id.slice(9), requestId }); });
} };`;
  }
  function upstreamFixture(selected = charged) {
    return `${observerCode}
${bindingCode}
const credentialFor = ${credentialFor.toString()};
const wireFor = ${wireFor.toString()}, lifetime = createLifetimeObserver(), bindings = createOpenCodeBindings(), calls = [], owners = new Map();
for (const row of ${JSON.stringify(selected)}) bindings.expect("opencode_" + row.id, "chat", ${JSON.stringify(upstreamUrl)}, "POST", "synthetic-opencode-" + credentialFor(row.id));
async function serve(request, context, owner) {
  const body = await lifetime.invoke("request.json", request.json, request, [], owner), id = owner.id.slice(9), row = ${JSON.stringify(selected)}.find(row => row.id === id);
  if (!JSON.stringify(body).includes("Synthetic instructions opencode_case=" + id + ";")) throw new Error("OpenCode wire invocation mismatch: " + id);
  const call = { id, url: request.url, authorization: request.headers.get("authorization"), session: request.headers.get("x-opencode-session"), routerSession: request.headers.get("x-clawrouter-session-id"), body, cancelled: false, expired: false }; calls.push(call); owners.set(owner, call);
  const bytes = new TextEncoder().encode(wireFor(${JSON.stringify(protocol)}, row, body.model)); let offset = 0, timer, heartbeat, wake, controller, complete = false, resolveProducer, rejectProducer;
  const producer = new Promise((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; }); lifetime.watch("source.completion", producer, owner); context.waitUntil(producer);
  const finish = (failed, error) => { if (complete) return; complete = true; clearTimeout(timer); clearTimeout(heartbeat); wake?.(); if (failed) rejectProducer(error); else resolveProducer(); };
  timer = setTimeout(() => { call.expired = true; const error = new Error("OpenCode source deadline"); finish(true, error); controller?.error(error); }, 10000);
  const source = { start(c) { controller = c; }, pull(c) { if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; return; } if (id !== "cancel") { c.close(); finish(false); return; } return lifetime.watch("source.heartbeat", new Promise(resolve => { wake = resolve; heartbeat = setTimeout(() => { if (!complete) c.enqueue(new TextEncoder().encode(": heartbeat\\n\\n")); resolve(); }, 50); }), owner); }, cancel() { call.cancelled = true; finish(false); } };
  for (const kind of ["pull", "cancel"]) { const original = source[kind]; lifetime.patch(source, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); }); }
  return new Response(new ReadableStream(source, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
export default { fetch(request, env, context) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  if (request.url === "https://fixture.example/retire") return (async () => { let accepted = false; try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); } const owner = bindings.bindings.find(row => row.id === "opencode_cancel"), call = owners.get(owner), ops = lifetime.operations.filter(op => op.owner === owner), cancels = ops.filter(op => op.kind === "source.cancel"); return Response.json({ ...lifetime.summary(), accepted, sourceCancellation: { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.expired === true, cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length, pending: ops.filter(op => op.state === "pending").length, failed: ops.filter(op => !["pending", "fulfilled"].includes(op.state)).length } }); })();
  const owner = bindings.claim(request, undefined, "chat"); lifetime.signal(owner, request.signal); const waitUntil = context.waitUntil; lifetime.patch(context, "waitUntil", function (...args) { lifetime.watch("waitUntil", args[0], owner); return Reflect.apply(waitUntil, context, args); }); return lifetime.invoke("handler", serve, undefined, [request, context, owner], owner);
} };`;
  }
  async function setup(mf, selected = credentials) {
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const row of selected.filter(row => row.id !== "invalid" && credentialFor(row.id) === row.id)) {
      const id = "opencode_" + row.id;
      await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.id === "foreign" ? "google" : provider], models: [provider + "/" + (row.id === "closed" ? provider === "opencode" ? "big-pickle" : "kimi-k2.6" : row.model)], grantRouting: { eligibleGrants: { [provider]: [provider] }, environmentFallback: false }, tenantId: "fixture", monthlyBudgetMicros: row.id === "budget" ? 0 : 1000, budgetMode: "reserve", requestCostMicros: row.id === "unpriced" ? null : 7, retainRequestContent: false }));
      await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: sha("fixture-secret"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/" + provider, JSON.stringify({ providerId: provider, enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, ""); assert.equal((await fetch(origin + "/fixture/grants")).status, 204); return origin;
  }
  async function verify(mf, origin) {
    const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
    assert.deepEqual(calls.map(row => row.id).sort(), charged.map(row => row.id).sort(), phase + " exact original dispatches");
    for (const call of calls) {
      const row = cases.find(row => row.id === call.id); assert.equal(call.url, upstreamUrl); assert.equal(call.authorization, "Bearer synthetic-opencode-" + credentialFor(row.id));
      assert.equal(call.body.model, row.model); assert.equal(call.body.stream, true); assert.equal(call.expired, false);
      assert.match(call.session, /^crs_[a-f0-9]{64}$/); assert.equal(call.routerSession, null);
      if (protocol === "responses") { assert.equal(call.body.store, false); assert.equal(call.body.previous_response_id, undefined); assert.equal(call.body.max_output_tokens, 128); }
      // The pinned simple Anthropic path adds its high-thinking budget to the
      // output allowance for non-adaptive models (128 + 16384), before hooks.
      else assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, protocol === "messages" && provider === "opencode-go" && row.hook === "simple" ? 16512 : 128, row.id);
      if (provider === "opencode-go" && protocol === "chat") {
        if (row.model.startsWith("deepseek-")) { assert.deepEqual(call.body.thinking, { type: "enabled" }, row.id + " native Go thinking contract"); assert.equal(call.body.reasoning_effort, row.model === "deepseek-v4-pro" ? "high" : "low", row.id + " native Go effort contract"); }
        if (row.model === "kimi-k3") { assert.deepEqual(call.body.thinking, { type: "disabled" }, row.id + " native Go K3 thinking-off contract"); assert.equal(call.body.reasoning_effort, undefined); }
      }
      if (provider === "opencode-go" && protocol === "messages") { assert.equal(call.body.thinking, undefined); assert.equal(call.body.output_config, undefined); }
      if (row.id === "dynamic" || row.id === "dynamic_replay") {
        const tool = call.body.tools.find(tool => tool.name === "openclaw_web_search"); assert.ok(tool, "actual Console web_search alias");
        assert.equal(tool.parameters.properties.labels.type, "array", "actual Console dynamic-record rewrite");
        if (row.id === "dynamic_replay") { const callItem = call.body.input.find(item => item.type === "function_call"); assert.equal(callItem.name, "openclaw_web_search"); assert.deepEqual(JSON.parse(callItem.arguments), { labels: [{ key: "topic", value: "synthetic" }] }); }
      }
      if (row.id === "prefill") assertMessagesPrefill(provider, call.body);
      if (row.id === "replay") {
        if (protocol === "messages") {
          const blocks = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
          assert.ok(blocks.some(block => block.type === "thinking" && block.signature === "synthetic-signed-thinking"));
          const use = blocks.find(block => block.type === "tool_use"), result = blocks.find(block => block.type === "tool_result"); assert.ok(use && result); assert.equal(result.tool_use_id, use.id);
        } else if (protocol === "responses") { assertReasoningReplay(call.body.input); const use = call.body.input.find(item => item.type === "function_call"), result = call.body.input.find(item => item.type === "function_call_output"); assert.ok(use && result); assert.equal(use.call_id, result.call_id); }
        else { const assistant = call.body.messages.find(message => message.tool_calls?.length), result = call.body.messages.find(message => message.role === "tool"); assert.ok(assistant && result); assert.equal(assistant.tool_calls[0].id, result.tool_call_id); if (provider === "opencode-go") for (const message of call.body.messages) for (const key of ["reasoning", "reasoning_content", "reasoning_details", "reasoning_text"]) assert.equal(message[key], undefined, "native Go Kimi replay stripping"); }
      }
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|raw-private-session/);
    }
    assertSessionRelations(calls);
    await verifyUsage(mf, origin, cases);
  }
  async function verifyUsage(mf, origin, selected) {
    const receipts = await (await fetch(origin + "/fixture/receipts")).json();
    assert.deepEqual(receipts.map(row => row.id).sort(), selected.filter(row => !row.denied).map(row => row.id).sort());
    assert.equal(new Set(receipts.map(row => row.requestId)).size, selected.filter(row => !row.denied).length);
    for (const row of selected.filter(row => row.id !== "invalid" && credentialFor(row.id) === row.id)) {
      const expected = selected.filter(call => !call.denied && credentialFor(call.id) === row.id);
      let result;
      for (let n = 0; n < 150; n++) { result = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer " + token(row.id) } })).json(); if (row.denied || result.usage.events.length === expected.length && result.budget.spentMicros === 7 * expected.length) break; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(result.usage.events.length, expected.length, phase + "/" + row.id);
      assert.equal(result.budget.spentMicros, 7 * expected.length, row.id);
      if (row.denied) continue;
      for (const request of expected) {
        const receipt = receipts.find(receipt => receipt.id === request.id);
        const matching = result.usage.events.filter(event => event.request_id === receipt.requestId); assert.equal(matching.length, 1, request.id);
        const [event] = matching; assert.equal(event.credential_id, "opencode_" + row.id); assert.equal(event.policy_id, "opencode_" + row.id); assert.equal(event.model, provider + "/" + row.model); assert.equal(event.provider, provider);
        assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.status, request.id === "cancel" ? "client_error" : request.id === "error" ? "provider_error" : "success", request.id);
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["error", "cancel"].includes(request.id) ? [null, null, null] : [11, 3, 14], request.id);
      }
    }
  }
  async function retire(mf, acceptedConsumer) {
    let upstream;
    await preserveFailures(async () => { upstream = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json(); assertProof(upstream); assert.deepEqual(upstream.sourceCancellation, { ownerId: "opencode_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 }); }, [async () => assertProof(await (await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ sourceCancellation: upstream?.sourceCancellation, acceptedConsumer }) })).json())]);
  }
  async function runNative(t, fixture, origin, invoke = runOpenClawConsumer) {
    let canceled = 0, replayed = 0;
    const observed = new Proxy(t, { get(target, key, receiver) { if (key !== "diagnostic") return Reflect.get(target, key, receiver); return text => { const lines = text.split("\n").map(line => line.trim()); canceled += lines.filter(line => line === "OPENCODE_CANCEL_RETIRED " + phase).length; replayed += lines.filter(line => line === "OPENCODE_REPLAY_RETIRED " + phase).length; t.diagnostic(text); }; } });
    await invoke(observed, { source, sourceHead, fixture: pathToFileURL(fixture), testPath: "extensions/clawrouter/worker-opencode-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_OPENCODE_CONTRACT: payload, CLAWROUTER_API_KEY: "", OPENCODE_API_KEY: "must-not-fallback", OPENCODE_GO_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback", ANTHROPIC_API_KEY: "must-not-fallback", NO_COLOR: "1" } });
    assert.equal(canceled, 1, phase + " original cancellation receipt"); assert.equal(replayed, 1, phase + " actual replay receipt");
  }
  test(phase + " runner pins actual product/protocol/key and exact receipts", async () => {
    const invoke = lines => async (context, options) => { assert.equal(options.sourceHead, sourceHead); assert.equal(options.testPath, "extensions/clawrouter/worker-opencode-contract.test.ts"); assert.equal(options.env.CLAWROUTER_OPENCODE_CONTRACT, payload); assert.equal(options.env.CLAWROUTER_API_KEY, ""); assert.equal(options.env.OPENCODE_GO_API_KEY, "must-not-fallback"); lines.forEach(line => context.diagnostic(line)); };
    const lines = ["OPENCODE_CANCEL_RETIRED " + phase, "OPENCODE_REPLAY_RETIRED " + phase];
    await runNative({ diagnostic() {} }, "/synthetic/contract.ts", "https://fixture.example", invoke(lines));
    for (const bad of [[], ["RESPONSES_CANCEL_RETIRED " + phase], [...lines, lines[0]]]) await assert.rejects(runNative({ diagnostic() {} }, "/synthetic/contract.ts", "https://fixture.example", invoke(bad)));
  });
  test(phase + " failed source proof independently attempts router retirement", async () => {
    let attempts = 0; const mf = { async getWorker() { return { fetch() { return Promise.reject(undefined); } }; }, dispatchFetch() { attempts++; return Promise.reject(null); } };
    await assert.rejects(retire(mf, false), error => error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === null); assert.equal(attempts, 1);
  });
  test(phase + " bundles actual Worker owners and joins original source cancellation", { timeout: 20_000 }, async () => {
    assert.ok((await bundleResponsesOutcome(routerFixture())).length > 0);
    const upstream = new Function(upstreamFixture().replace("export default", "return"))(), tails = [];
    const response = await upstream.fetch(new Request(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic-opencode-cancel" }, body: JSON.stringify({ model: cards[0], stream: true, messages: [{ role: "system", content: "Synthetic instructions opencode_case=cancel;" }] }) }), {}, { waitUntil(promise) { tails.push(promise); } });
    assert.equal(tails.length, 1); let completed = false; void tails[0].then(() => { completed = true; });
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); assert.equal(completed, false);
    await reader.cancel(); await reader.closed; reader.releaseLock(); await Promise.all(tails);
    const proof = await (await upstream.fetch(new Request("https://fixture.example/retire"))).json();
    assert.deepEqual(proof.sourceCancellation, { ownerId: "opencode_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 });
    assert.equal(proof.accepted, false, "other original invocations remain missing, never manufactured by retirement");
  });
  test(phase + " shared transport cannot substitute another invocation's wire", async () => {
    const upstream = new Function(upstreamFixture().replace("export default", "return"))();
    await assert.rejects(upstream.fetch(new Request(upstreamUrl, { method: "POST", headers: { authorization: "Bearer synthetic-opencode-first" }, body: JSON.stringify({ model: protocol === "chat" ? "kimi-k3" : cards[0], messages: [{ role: "system", content: "Synthetic instructions opencode_case=replay;" }] }) }), {}, { waitUntil() { throw new Error("no producer should start"); } }), /wire invocation mismatch: first/);
    const proof = await (await upstream.fetch(new Request("https://fixture.example/retire"))).json(); assert.equal(proof.accepted, false); assert.ok(proof.rejected > 0);
  });
  if (protocol === "responses") test(phase + " direct Worker preserves shared-credential response ownership and session isolation", { timeout: 30_000 }, async () => {
    const selected = cases.filter(row => ["first", "replay", "session_conversation", "session_credential"].includes(row.id));
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-opencode-response-owner-")); let mf;
    await preserveFailures(async () => {
      mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture(selected)), upstreamFixture(selected));
      const origin = await setup(mf, selected), requestIds = [];
      for (const row of selected) {
        const response = await fetch(origin + nativePath, { method: "POST", headers: { authorization: "Bearer " + token(row.id), "content-type": "application/json", "x-clawrouter-session-id": row.id === "session_conversation" ? "raw-private-session-other" : "raw-private-session" }, body: JSON.stringify({ model: row.model, stream: true, store: false, max_output_tokens: 128, input: [{ role: "system", content: "Synthetic instructions opencode_case=" + row.id + ";" }, { role: "user", content: "Synthetic ownership control" }] }) });
        assert.equal(response.status, 200); requestIds.push(response.headers.get("x-clawrouter-request-id"));
        const text = await response.text(), events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        const terminal = events.filter(event => event.type === "response.completed"); assert.equal(terminal.length, 1, row.id); assert.equal(terminal[0].response.id, "resp_synthetic_" + row.id);
      }
      assert.ok(requestIds.every(Boolean)); assert.equal(new Set(requestIds).size, selected.length);
      const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
      assertSessionRelations(calls); assert.ok(calls.every(call => !call.expired)); await verifyUsage(mf, origin, selected);
    }, [
      async () => { if (mf) assertProof(await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/retire")).json()); },
      async () => { if (mf) assertProof(await (await mf.dispatchFetch("https://fixture.example/fixture/retire", { method: "POST", body: JSON.stringify({ acceptedConsumer: false }) })).json()); },
      () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true }),
    ]);
  });
  test(phase + " actual registered OpenCode SDK through Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-opencode-sdk-")); let mf, accepted = false;
    await preserveFailures(async () => { mf = await startBundledWorkerdFixture(temporary, await bundleResponsesOutcome(routerFixture()), upstreamFixture()); const origin = await setup(mf); const fixture = join(temporary, "opencode-contract.test.ts"); await writeFile(fixture, assembled, { flag: "wx", mode: 0o600 }); await runNative(t, fixture, origin); await verify(mf, origin); accepted = true; }, [() => mf && retire(mf, accepted), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
  });
}

test("OpenCode assembly preserves 17 finite cards, four closed and both original GLM names", () => {
  assert.doesNotThrow(() => stripTypeScriptTypes(assembled));
  const providers = snapshot.providers.filter(row => row.id === "opencode" || row.id === "opencode-go");
  assert.equal(providers.reduce((n, row) => n + row.models.length, 0), 17);
  assert.equal(providers.flatMap(row => row.models).filter(row => row.capabilities.length).length, 13);
  for (const row of providers) { assert.equal(row.models[0].upstream, "glm-5.3"); assert.equal(row.models[0].displayName, "GLM-5.3"); }
  const workflow = parse(readFileSync(new URL("../.github/workflows/openclaw-contract.yml", import.meta.url), "utf8")); const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length); assert.equal(workflow.jobs.consumer.strategy["max-parallel"], 4);
  assert.deepEqual(rows.filter(row => row.consumer === "opencode"), [{ consumer: "opencode", ref: sourceHead, test: "test/openclaw-opencode.test.mjs" }]);
});

test("OpenCode unexpected SDK claims survive wrapping, including undefined failures", () => {
  const body = fixtureText.slice(fixtureText.indexOf("function claimOwned("), fixtureText.indexOf("// END OPENCODE CLAIM"));
  assert.ok(body.startsWith("function claimOwned("));
  for (const reason of [undefined, null, new Error("synthetic foreign owner")]) {
    const lifetime = { errors: [] }, bindings = { claim() { throw reason; } };
    const claim = new Function("lifetime", "bindings", stripTypeScriptTypes(body) + "; return claimOwned;")(lifetime, bindings);
    let threw = false;
    try { claim("https://fixture.example/foreign", {}, "chat"); } catch (error) { threw = true; assert.equal(error, reason); }
    assert.equal(threw, true); assert.equal(lifetime.errors.length, 1); assert.equal(lifetime.errors[0], reason);
  }
});

test("OpenCode successful transport claims still require the exact current invocation", () => {
  const body = fixtureText.slice(fixtureText.indexOf("function claimOwned("), fixtureText.indexOf("// END OPENCODE CLAIM"));
  const owner = {}, lifetime = { errors: [] }, bindings = { claim() { return owner; } }; let current = owner;
  const claim = new Function("lifetime", "bindings", "invocation", stripTypeScriptTypes(body) + "; return claimOwned;")(lifetime, bindings, { getStore() { return current; } });
  assert.equal(claim("https://fixture.example", {}, "chat"), owner);
  for (current of [undefined, {}]) assert.throws(() => claim("https://fixture.example", {}, "chat"), /foreign OpenCode invocation/);
  assert.equal(lifetime.errors.length, 2);
});

test("OpenCode original acquisition and detached release preserve independent failures", async () => {
  for (const failed of [false, true]) {
    const life = createLifetimeObserver(), owner = {}, receiver = {}, input = {};
    const release = () => failed ? Promise.reject(undefined) : Promise.resolve();
    const result = { response: new Response("synthetic"), release }, original = Promise.resolve(result);
    assert.equal(life.guard(function (arg) { assert.equal(this, receiver); assert.equal(arg, input); return original; }, receiver, [input], owner), original);
    await original; const reader = result.response.body.getReader();
    assert.equal((await reader.read()).done, false); assert.equal((await reader.read()).done, true); await reader.closed; reader.releaseLock();
    const detached = result.release; await detached().catch(() => {});
    if (failed) await assert.rejects(life.join(), error => error.errors.includes(undefined)); else await life.join();
    await life.restore(); assert.equal(result.release, release);
  }
});


test("OpenCode serial repeated credentials keep distinct original request owners", () => {
  const bindings = createOpenCodeBindings(), url = "https://fixture.example/chat";
  const first = bindings.expect("first", "chat", url, "POST", "synthetic-key"), replay = bindings.expect("replay", "chat", url, "POST", "synthetic-key");
  assert.throws(() => bindings.expect("first", "chat", url, "POST", "synthetic-key"));
  const request = () => new Request(url, { method: "POST", headers: { authorization: "Bearer synthetic-key" } });
  const one = request(), two = request();
  assert.equal(bindings.claim(one, undefined, "chat"), first);
  assert.throws(() => bindings.claim(one, undefined, "chat"));
  assert.throws(() => bindings.claim(new Request(url, { method: "POST", headers: { authorization: "Bearer foreign" } }), undefined, "chat"));
  assert.throws(() => bindings.verify());
  assert.equal(bindings.claim(two, undefined, "chat"), replay); assert.notEqual(first.input, replay.input);
  bindings.verify(); assert.throws(() => bindings.claim(request(), undefined, "chat"));
});

test("OpenCode session witness rejects broken continuity and collapsed isolation", () => {
  const rows = [
    { id: "first", authorization: "same-key", session: "one" }, { id: "replay", authorization: "same-key", session: "one" },
    { id: "session_conversation", authorization: "same-key", session: "two" }, { id: "session_credential", authorization: "other-key", session: "three" },
  ];
  assertSessionRelations(rows);
  for (const [index, field, value] of [[1, "session", "different"], [2, "session", "one"], [3, "session", "one"], [1, "authorization", "foreign"], [2, "authorization", "foreign"], [3, "authorization", "same-key"]]) {
    const changed = structuredClone(rows); changed[index][field] = value; assert.throws(() => assertSessionRelations(changed));
  }
  assert.throws(() => assertSessionRelations(rows.slice(1)));
  assert.throws(() => assertSessionRelations([...rows, rows[0]]));
});

test("OpenCode Responses replay requires preserved ciphertext and canonical item metadata", () => {
  const item = { type: "reasoning", encrypted_content: "synthetic-encrypted", summary: [] };
  assertReasoningReplay([item]);
  for (const bad of [[], [item, item], [{ ...item, encrypted_content: undefined }], [{ ...item, encrypted_content: "foreign" }], [{ ...item, id: "rs_synthetic" }], [{ ...item, summary: [{ type: "summary_text", text: "stale" }] }]]) assert.throws(() => assertReasoningReplay(bad));
});


test("OpenCode Responses completion IDs belong to distinct original requests", () => {
  const identities = ["first", "replay", "session_conversation", "session_credential"].map(id => {
    const events = wireFor("responses", { id }, "gpt-5.6-sol").split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const terminal = events.filter(event => event.type === "response.completed"); assert.equal(terminal.length, 1);
    assert.equal(terminal[0].response.id, "resp_synthetic_" + id); return terminal[0].response.id;
  });
  assert.equal(new Set(identities).size, identities.length);
});

test("OpenCode passive original read progress preserves identity and independent falsey faults", async () => {
  for (const fail of [false, true]) {
    const owner = {}, result = { done: true }, promise = Promise.resolve(result), seen = [];
    const reader = { closed: Promise.resolve(), read() { return promise; }, cancel() { return Promise.resolve(); }, releaseLock() {} };
    const body = { getReader() { return reader; }, cancel() { return Promise.resolve(); } };
    const life = createLifetimeObserver({ bindings: [], bodySucceeded: () => true, readProgress(actualOwner, value) { seen.push([actualOwner, value]); if (fail) throw undefined; } });
    life.response({ body }, owner); const actual = body.getReader(); assert.equal(actual.read(), promise); assert.equal(await promise, result);
    assert.deepEqual(seen, [[owner, result]]); actual.releaseLock();
    if (fail) await assert.rejects(life.join(), error => error.errors.includes(undefined)); else await life.join();
    life.restore();
  }
});


test("OpenCode quarantine trigger requires original owned nonempty transport progress", () => {
  const text = fixtureText.slice(fixtureText.indexOf("function observeQuarantinedProgress("), fixtureText.indexOf("// END OPENCODE QUARANTINED PROGRESS"));
  const build = new Function("assert", "contract", "bindings", "lifetime", "cancelController", stripTypeScriptTypes(text) + "; return observeQuarantinedProgress;");
  for (const mode of ["owned", "empty", "eof", "catalog", "other-provider", "foreign-owner", "wrong-caller", "unclaimed", "duplicate-owner"]) {
    const controller = new AbortController(), owner = { id: "cancel", kind: "chat", claimed: true, caller: controller.signal }, bindings = { bindings: [owner] }, seen = [];
    const lifetime = { partial(row) { row.partialDelivery = true; seen.push(row); } };
    const contract = { provider: mode === "other-provider" ? "opencode-go" : "opencode", protocol: "messages" };
    if (mode === "wrong-caller") owner.caller = new AbortController().signal;
    if (mode === "unclaimed") owner.claimed = false;
    if (mode === "catalog") owner.kind = "catalog";
    if (mode === "duplicate-owner") bindings.bindings.push({ ...owner });
    const callback = build(assert, contract, bindings, lifetime, controller), value = { done: mode === "eof", value: new Uint8Array(mode === "empty" ? 0 : 1) };
    const action = () => callback(mode === "foreign-owner" ? { ...owner } : owner, value);
    if (["foreign-owner", "wrong-caller", "unclaimed", "duplicate-owner"].includes(mode)) assert.throws(action); else action();
    assert.equal(controller.signal.aborted, mode === "owned", mode); assert.equal(seen.length, mode === "owned" ? 1 : 0, mode);
    if (mode === "owned") { callback(owner, value); assert.equal(seen.length, 1); }
  }
});


test("OpenCode Claude prefill removal preserves the exact user turn and other Messages contracts", () => {
  const user = { role: "user", content: [{ type: "text", text: "synthetic OpenCode prefill" }] };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Synthetic prefill" }] };
  assertMessagesPrefill("opencode", { messages: [user] });
  assertMessagesPrefill("opencode", { messages: [{ ...user, content: "synthetic OpenCode prefill" }] });
  assertMessagesPrefill("opencode-go", { messages: [user, assistant] });
  for (const messages of [[], [assistant], [user, assistant], [user, user], [{ ...user, content: "foreign" }], [{ ...user, content: [] }], [{ ...user, content: [{ type: "thinking", text: "synthetic OpenCode prefill" }] }]]) {
    assert.throws(() => assertMessagesPrefill("opencode", { messages }));
  }
  assert.throws(() => assertMessagesPrefill("opencode-go", { messages: [user] }));
});
