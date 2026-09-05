import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../index.ts");
const { default: privateWorker } = await import("../private-entry.ts");
const { containResponse } = await import("../private-codex-output.ts");
const { privateResponseHeaders } = await import("../private-codex-protocol.ts");
const { sha256Hex } = await import("../utils.ts");
const alias = "codex-latest", target = "SYNTHETIC_TARGET_ABABAC", reported = "SYNTHETIC_REPORT_ABABAC";
const accountId = "SYNTHETIC_ACCOUNT_ABABAC", accessToken = "SYNTHETIC_TOKEN_ABABAC";
const credential = "private-workload-SYNTHETIC_ACCEPTANCE_CREDENTIAL_123456789";
const upstream = () => ({ version: 1, target, accountId, accessToken, expiresAt: Date.now() + 3600_000 });
const enc = new TextEncoder();
const done = (extra = {}) => ({ type: "response.completed", response: { id: "synthetic-response", model: target, status: "completed", ...extra } });
const created = () => ({ type: "response.created", response: { id: "synthetic-response", model: reported } });
const textDelta = (delta, extra = {}) => ({ type: "response.output_text.delta", item_id: "synthetic-text", content_index: 0, delta, ...extra });
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const wire = (events) => enc.encode(events.map(frame).join("") + "data: [DONE]\n\n");
const events = (text) => [...text.matchAll(/^data: (.+)$/gm)].filter((m) => m[1] !== "[DONE]").map((m) => JSON.parse(m[1]));
function contained(text) {
  for (const value of [target, reported, accountId, accessToken]) assert.equal(text.includes(value), false);
}
function failed(text) {
  contained(text); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed|\[DONE\]/);
}
function chunkSizes(seed) {
  let state = seed;
  return Array.from({ length: 19 }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return 1 + state % 97; });
}
function source(bytes, sizes = [bytes.length]) {
  let offset = 0, chunk = 0;
  const observed = { canceled: false, pulls: 0 };
  const body = new ReadableStream({ pull(controller) {
    observed.pulls++;
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + sizes[chunk++ % sizes.length]);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  }, cancel() { observed.canceled = true; } }, { highWaterMark: 0 });
  return { body, observed };
}
async function streamResult(bytes, sizes, headers = {}) {
  const { body, observed } = source(bytes, sizes);
  let aborts = 0;
  const result = await containResponse(new Response(body, { headers: { "content-type": "text/event-stream", ...headers } }), alias, upstream(), true, new AbortController().signal, () => { aborts++; });
  const text = await result.text();
  return { result, text, observed, aborts };
}
async function fixture() {
  const state = { policy: { version: 1, enabled: true, alias: { id: alias, name: "Codex (Latest)" }, auth: { mode: "workload", credentialSha256: await sha256Hex(credential) } }, upstream: upstream(), policies: 0, secrets: 0 };
  const env = {
    PRIVATE_CODEX_POLICY: { get: async () => { state.policies++; return JSON.stringify(state.policy); } },
    PRIVATE_CODEX_UPSTREAM: { get: async () => { state.secrets++; return JSON.stringify(state.upstream); } },
  };
  return { env, state };
}
function request(path = "/private/v1/responses", options = {}) {
  const method = options.method ?? (path.endsWith("/responses") ? "POST" : "GET");
  return new Request(`https://synthetic.invalid${path}`, { method,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...options.headers },
    ...(method === "POST" ? { body: JSON.stringify({ model: alias, store: false }) } : {}),
  });
}
const run = (req, env) => worker.fetch(req, env, { waitUntil() { assert.fail("Private work entered background accounting"); } });
test.beforeEach((context) => context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network call in offline acceptance")));

test("adversarial blank and duplicate authentication contexts never resolve private secrets", async () => {
  const { env, state } = await fixture();
  for (const headers of [
    { "cf-access-jwt-assertion": "" }, { "cf-access-jwt-assertion": " \t " },
    { "x-api-key": "" }, { "proxy-authorization": "" }, { "cf-access-client-id": "" },
    { authorization: `Bearer ${credential}, Bearer ${credential}` },
  ]) {
    const response = await run(request("/private/v1/models", { headers }), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: "route_not_found", message: "route not found" } });
  }
  assert.equal(state.secrets, 0);
});

test("adversarial discarded observations cannot conceal protocol identity or safety envelopes", async () => {
  for (const type of ["codex.rate_limits", "responsesapi.websocket_timing"]) {
    for (const envelope of [
      { headers: { "OpenAI-Model": "SYNTHETIC_ALTERNATE_TARGET" } },
      { headers: { "OpenAI-Model": target } },
      { headers: { "x-codex-safety-buffering-enabled": "true" } },
      { headers: { "x-oai-attestation": "synthetic-required" } },
      { response: { model: reported, headers: { "x-openai-model": reported } } },
      { safety_buffering: { use_cases: ["synthetic"], reasons: [], retry_model: "SYNTHETIC_ALTERNATE_TARGET" } },
      { safety_buffering: { use_cases: ["synthetic"], reasons: [], retry_model: null } },
    ]) {
      for (const sizes of [[1], chunkSizes(7), [65536]]) {
        const result = await streamResult(wire([created(), { type, ...envelope }, done({ model: reported })]), sizes);
        failed(result.text); assert.ok(result.aborts > 0);
      }
    }
    const pure = { type, metered_limit_name: target, metadata: { model: target }, headers: { "x-codex-primary-used-percent": "1" } };
    const result = await streamResult(wire([pure, created(), done({ model: reported })]), chunkSizes(13));
    assert.deepEqual(events(result.text), [{ ...created(), response: { id: "synthetic-response", model: alias } }, done({ model: alias })]);
  }
});

test("adversarial seeded chunkings preserve CRLF multiline SSE, UTF-8 and intact tool protocol", async (context) => {
  const args = '{"model":"synthetic-data","error":null,"value":"\\u0061"}';
  const input = "synthetic freeform\n🦞";
  const data = [created(), textDelta("safe 🦞 text"),
    { type: "response.function_call_arguments.delta", item_id: "synthetic-tool", delta: args.slice(0, 13) },
    { type: "response.function_call_arguments.delta", item_id: "synthetic-tool", delta: args.slice(13) },
    { type: "response.function_call_arguments.done", item_id: "synthetic-tool", arguments: args },
    { type: "response.custom_tool_call_input.delta", call_id: "synthetic-custom-call", delta: input.slice(0, 8) },
    { type: "response.custom_tool_call_input.delta", call_id: "synthetic-custom-call", item_id: "synthetic-custom-item", delta: input.slice(8) },
    { type: "response.output_item.done", item: { type: "custom_tool_call", id: "synthetic-custom-item", call_id: "synthetic-custom-call", input } },
    { type: "response.metadata", metadata: { openai_verification_recommendation: ["synthetic-required"], openai_chatgpt_moderation_metadata: { required: true } } },
    done({ model: reported }),
  ];
  const bytes = enc.encode(data.map((event) => `: discarded ${target}\r\nevent: ${event.type}\r\n${JSON.stringify(event, null, 1).split("\n").map((line) => `data: ${line}\r\n`).join("")}\r\n`).join("") + "data: [DONE]\r\n\r\n");
  const expected = [{ ...created(), response: { id: "synthetic-response", model: alias } }, ...data.slice(1, -1), done({ model: alias })];
  const layouts = [[bytes.length], [1], [2, 3, 5, 7, 11], ...Array.from({ length: 24 }, (_, i) => chunkSizes(i + 1))];
  for (const sizes of layouts) {
    const result = await streamResult(bytes, sizes);
    contained(result.text); assert.deepEqual(events(result.text), expected);
  }
  context.diagnostic(`${layouts.length} deterministic network layouts`);
});

test("adversarial three-part and empty logical deltas contain every known canary in each supported family", async (context) => {
  const families = ["output_text", "refusal", "reasoning_text", "reasoning_summary_text", "function_call_arguments", "custom_tool_call_input"];
  let cases = 0;
  for (const secret of [target, reported, accountId, accessToken]) {
    for (const family of families) {
      for (const split of [1, Math.floor(secret.length / 2), secret.length - 2]) {
        const fragments = [secret.slice(0, split), "", secret.slice(split, split + 1), secret.slice(split + 1)];
        if (family === "function_call_arguments") { fragments[0] = '{"value":"' + fragments[0]; fragments[3] += '"}'; }
        const deltas = fragments.map((delta) => ({ type: `response.${family}.delta`, item_id: `synthetic-${family}`, content_index: 0, summary_index: 0, delta }));
        for (const sizes of [[1], chunkSizes(split)]) {
          const result = await streamResult(wire([created(), ...deltas, done({ model: reported })]), sizes);
          failed(result.text); assert.equal(events(result.text).some((event) => event.type.endsWith(".delta")), false);
          cases++;
        }
      }
    }
  }
  context.diagnostic(`${cases} canary/family/logical split/network combinations`);
});

test("adversarial UTF-8 errors never become successful SSE at any injection chunk boundary", async () => {
  for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
    const prefix = enc.encode(frame(created()));
    const bytes = new Uint8Array([...prefix, ...invalid]);
    for (const sizes of [[1], [prefix.length, 1], chunkSizes(31), [bytes.length]]) {
      const result = await streamResult(bytes, sizes);
      failed(result.text); assert.ok(result.aborts > 0);
    }
  }
});

test("adversarial frame, response-header and total-stream limits hold at their actual byte boundaries", async () => {
  for (const [size, valid] of [[256 * 1024, true], [256 * 1024 + 1, false]]) {
    const result = await streamResult(enc.encode(":" + "x".repeat(size - 1) + "\n\n" + frame(done()) + "data: [DONE]\n\n"), [65536]);
    if (valid) assert.deepEqual(events(result.text), [done({ model: alias })]); else failed(result.text);
  }
  const multibyte = await streamResult(enc.encode(":" + "🦞".repeat(65536) + "\n\n" + frame(done())), [65536]);
  failed(multibyte.text);
  const secretValues = [target, accountId, accessToken];
  assert.doesNotThrow(() => privateResponseHeaders([["x-reasoning-included", "a".repeat(8192)]], alias, target, secretValues));
  assert.throws(() => privateResponseHeaders([["x-reasoning-included", "a".repeat(8193)]], alias, target, secretValues));
  const entries = Array.from({ length: 128 }, (_, i) => [`x-synthetic-${i}`, "safe"]);
  assert.deepEqual({ ...privateResponseHeaders(entries, alias, target, secretValues) }, {});
  assert.throws(() => privateResponseHeaders([...entries, ["x-synthetic-extra", "safe"]], alias, target, secretValues));
  assert.throws(() => privateResponseHeaders([["OpenAI-Model", target], ["openai-model", alias]], alias, target, secretValues));
  const fullHeaders = Array.from({ length: 8 }, (_, i) => { const key = `x-synthetic-${i}`; return [key, "s".repeat(8192 - key.length)]; });
  assert.deepEqual({ ...privateResponseHeaders(fullHeaders, alias, target, secretValues) }, {});
  fullHeaders[7][1] += "s";
  assert.throws(() => privateResponseHeaders(fullHeaders, alias, target, secretValues));
  const total = 64 * 1024 * 1024, tail = enc.encode(frame(done()) + "data: [DONE]\n\n");
  for (const extra of [0, 1]) {
    let remaining = total - tail.length + extra, emitted = 0, canceled = false;
    const body = new ReadableStream({ pull(controller) {
      if (remaining) {
        const length = Math.min(65536, remaining);
        controller.enqueue(enc.encode(":" + "x".repeat(length - 3) + "\n\n")); remaining -= length; emitted += length;
      } else if (emitted < total + extra) { controller.enqueue(tail); emitted += tail.length; }
      else controller.close();
    }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const result = await containResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), alias, upstream(), true, new AbortController().signal, () => {});
    const text = await result.text();
    assert.equal(emitted, total + extra);
    if (extra) { failed(text); assert.equal(canceled, true); } else assert.deepEqual(events(text), [done({ model: alias })]);
  }
});

test("private requests preserve input through 8 MiB and cancel the next byte before egress", async (context) => {
  const empty = JSON.stringify({ model: alias, store: false, input: "" });
  const limit = 8 * 1024 * 1024;
  const logs = [];
  context.mock.method(console, "info", (event) => logs.push(event));
  for (const [entry, transport] of [[worker, "subscription"], [privateWorker, "openai-api"]]) {
    const { env, state } = await fixture();
    if (transport === "openai-api") state.upstream = { version: 1, transport, target, apiKey: accessToken };
    for (const size of [1024 * 1024 + 1, limit - 1, limit, limit + 1]) {
      const inputBytes = size - enc.encode(empty).length;
      const input = "🦞".repeat(Math.floor(inputBytes / 4)) + "x".repeat(inputBytes % 4);
      const bytes = enc.encode(JSON.stringify({ model: alias, store: false, input }));
      assert.equal(bytes.length, size);
      let calls = 0;
      context.mock.method(globalThis, "fetch", (url, options) => {
        calls++;
        assert.equal(url, transport === "openai-api" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses");
        const outgoing = JSON.parse(options.body);
        assert.equal(outgoing.model, target); assert.ok(outgoing.input === input);
        return Response.json({ object: "response", id: "synthetic-response", status: "completed", model: target });
      });
      // Split multibyte characters across chunks; a false length must not bypass the byte cap.
      const { body, observed } = source(bytes, [65535]);
      const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json", ...(size > limit ? { "content-length": "1" } : {}) };
      const response = await entry.fetch(new Request("https://synthetic.invalid/private/v1/responses", { method: "POST", headers, body, duplex: "half" }), env);
      assert.equal(response.status, size > limit ? 400 : 200); contained(await response.text());
      assert.equal(calls, size > limit ? 0 : 1);
      assert.deepEqual(logs.splice(0), size > limit ? [{ predicate: "body.limit", request_bytes: size }] : []);
      if (size > limit) assert.equal(observed.canceled, true);
    }
  }
});

test("adversarial response structure limits accept the boundary but not the next unit", async () => {
  const metadataCases = [];
  for (const depth of [47, 48]) {
    let value = "safe";
    for (let i = 0; i < depth; i++) value = { nested: value };
    metadataCases.push([value, depth === 47]);
  }
  // Root + five keys + four scalar values + the metadata array use eleven nodes.
  for (const length of [49_989, 49_990]) metadataCases.push([Array(length).fill("safe"), length === 49_989]);
  for (const [metadata, valid] of metadataCases) {
    const body = { object: "response", id: "synthetic-response", status: "completed", model: target, metadata };
    const response = await containResponse(Response.json(body), alias, upstream(), false, new AbortController().signal, () => {});
    assert.equal(response.status, valid ? 200 : 502); contained(await response.text());
  }
});

test("adversarial cancellation while tool holdback waits discards all pending protocol data", async () => {
  const waiting = Promise.withResolvers(); let canceled = false, aborts = 0, pulls = 0;
  const body = new ReadableStream({ pull(controller) {
    pulls++;
    if (pulls === 1) controller.enqueue(enc.encode(frame(created())));
    else if (pulls === 2) controller.enqueue(enc.encode(frame({ type: "response.custom_tool_call_input.delta", item_id: "synthetic-tool", delta: reported.slice(0, 10) })));
    else waiting.resolve();
  }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const result = await containResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), alias, upstream(), true, new AbortController().signal, () => { aborts++; });
  const reader = result.body.getReader();
  const first = await reader.read(); contained(new TextDecoder().decode(first.value));
  const pending = reader.read(); await waiting.promise; await reader.cancel();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(canceled, true); assert.ok(aborts > 0); assert.equal(pulls, 3);
});

test("adversarial paused uploads fail closed across policy, credential, binding and expiry races", async () => {
  const changes = [
    (state) => { state.policy.enabled = false; },
    (state) => { state.policy.auth.credentialSha256 = "0".repeat(64); },
    (state) => { state.policy.alias.name = "Synthetic changed alias"; },
    (state) => { state.policy.alias.supportedReasoningEfforts = ["high"]; },
    (state) => { state.policy.auth = { mode: "access", issuer: "https://synthetic-owner.cloudflareaccess.com", githubAccountId: 123456, identityProviderId: "synthetic-github-idp", audience: "synthetic-aud" }; },
    (state) => { state.upstream.target = "SYNTHETIC_ROTATED_TARGET"; },
    (state) => { state.upstream.accountId = "SYNTHETIC_ROTATED_ACCOUNT"; },
    (state) => { state.upstream.accessToken = "SYNTHETIC_ROTATED_ACCESS_TOKEN"; },
    (state) => { state.upstream.expiresAt = Date.now() + 29_000; },
  ];
  for (const change of changes) {
    const { env, state } = await fixture(); const waiting = Promise.withResolvers(); let controller;
    const body = new ReadableStream({ start(c) { controller = c; }, pull() { waiting.resolve(); } }, { highWaterMark: 0 });
    const req = new Request("https://synthetic.invalid/private/v1/responses", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body, duplex: "half" });
    const pending = run(req, env); await waiting.promise;
    assert.equal(state.secrets, 1);
    change(state);
    controller.enqueue(enc.encode(JSON.stringify({ model: alias, store: false }))); controller.close();
    const result = await pending; assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
  }
});

test("adversarial aborted and malformed uploads cancel their reader before inference", async () => {
  for (const abortRequest of [false, true]) {
    const { env } = await fixture(); const waiting = Promise.withResolvers(); const abort = new AbortController();
    let controller, canceled = false;
    const body = new ReadableStream({ start(c) { controller = c; }, pull() { waiting.resolve(); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const pending = run(new Request("https://synthetic.invalid/private/v1/responses", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body, duplex: "half", signal: abort.signal }), env);
    await waiting.promise;
    if (abortRequest) abort.abort(); else controller.enqueue(new Uint8Array([0xff]));
    const result = await pending; assert.equal(result.status, 400); assert.equal(canceled, true); contained(await result.text());
  }
});

test("adversarial workload rotation is fresh on every request and never becomes a public or admin grant", async (context) => {
  const { env, state } = await fixture();
  const rotated = "private-workload-SYNTHETIC_ROTATED_CREDENTIAL_123456789";
  assert.equal((await run(request("/private/v1/models"), env)).status, 200);
  state.policy.auth.credentialSha256 = await sha256Hex(rotated);
  const reads = state.secrets;
  assert.equal((await run(request("/private/v1/models"), env)).status, 404); assert.equal(state.secrets, reads);
  assert.equal((await run(request("/private/v1/models", { headers: { authorization: `Bearer ${rotated}` } }), env)).status, 200);
  const admin = "SYNTHETIC_ADMIN_ACCEPTANCE_TOKEN";
  const publicEnv = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(admin) };
  const before = state.secrets;
  const logs = [];
  for (const name of ["log", "info", "warn", "error"]) context.mock.method(console, name, (...args) => logs.push(args));
  for (const token of [rotated, admin]) {
    for (const path of ["/v1/providers", "/v1/catalog", "/v1/models", "/v1/routes", "/v1/admin/private-codex", "/v1/native/private/v1/responses", "/v1/proxy/private/responses"]) {
      const result = await run(request(path, { headers: { authorization: `Bearer ${token}` } }), publicEnv);
      const text = await result.text(); contained(text); assert.equal(text.includes(alias), false);
    }
  }
  assert.equal(state.secrets, before); contained(JSON.stringify(logs));
});
