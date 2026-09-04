import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../private-entry.ts");
const { sha256Hex } = await import("../utils.ts");
const target = "SYNTHETIC_PRIVATE_TARGET", fallbackTarget = "SYNTHETIC_FALLBACK_TARGET", apiKey = "SYNTHETIC_PRIVATE_API_CREDENTIAL";
const credential = "private-workload-SYNTHETIC_API_WORKLOAD_123456789";

async function fixture() {
  const policy = { version: 1, enabled: true, alias: { id: "internal", name: "Codex" }, auth: { mode: "workload", credentialSha256: await sha256Hex(credential) } };
  const upstream = { version: 1, transport: "openai-api", target, apiKey };
  const env = { PRIVATE_CODEX_POLICY: { get: async () => JSON.stringify(policy) }, PRIVATE_CODEX_UPSTREAM: { get: async () => JSON.stringify(upstream) } };
  const run = (body = {}, headers = {}) => worker.fetch(new Request("https://private.invalid/private/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "internal", store: false, input: "synthetic input", ...body }),
  }), env);
  return { policy, upstream, run };
}
const completed = (model, output = []) => Response.json({ id: "resp-synthetic", object: "response", status: "completed", model, output });

test("private API transport pins the endpoint and preserves native facts and output limits", async (t) => {
  const { run } = await fixture(); let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(options.redirect, "manual");
    assert.equal(options.headers.get("authorization"), `Bearer ${apiKey}`);
    assert.equal(options.headers.has("chatgpt-account-id"), false);
    assert.equal(options.headers.get("originator"), "codex_cli_rs");
    assert.equal(options.headers.get("x-openai-internal-codex-responses-lite"), "true");
    const body = JSON.parse(options.body);
    assert.equal(body.model, target); assert.equal(body.max_output_tokens, 512); assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: "high" });
    return completed(target);
  });
  const response = await run({ max_output_tokens: 512, reasoning: { effort: "high" } }, { originator: "codex_cli_rs", "x-openai-internal-codex-responses-lite": "true" });
  assert.equal(response.status, 200); assert.equal(response.headers.has("x-clawrouter-ignored-parameters"), false);
  assert.equal((await response.json()).model, "internal"); assert.equal(calls, 1);
});

test("private API credentials are contained and rejected transports cannot mix credential kinds", async (t) => {
  const state = await fixture(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return completed(target, [{ type: "message", content: [{ type: "output_text", text: apiKey }] }]); });
  const response = await state.run(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /SYNTHETIC/);
  for (const extra of [{ transport: "arbitrary" }, { accountId: "SYNTHETIC_ACCOUNT" }, { accessToken: "SYNTHETIC_TOKEN" }, { expiresAt: Date.now() + 3600_000 }, { apiKey: "" }, { apiKey: "invalid\ncredential" }, { url: "https://elsewhere.invalid" }]) {
    const other = await fixture(); Object.assign(other.upstream, extra);
    assert.equal((await other.run()).status, 404);
  }
  assert.equal(calls, 1);
});

test("private API fallback retains its credential and continuation while revocation and rotation stop reuse", async (t) => {
  const state = await fixture(); state.upstream.fallbackTarget = fallbackTarget; const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(options.headers.get("authorization"), `Bearer ${apiKey}`);
    const body = JSON.parse(options.body); calls.push(body);
    return calls.length === 1 ? Response.json({ error: { code: "server_error" } }, { status: 503 }) : completed(fallbackTarget);
  });
  const first = await state.run(); const id = (await first.json()).id;
  const next = await state.run({ previous_response_id: id }); assert.equal(next.status, 200); await next.text();
  assert.deepEqual(calls.map(x => x.model), [target, fallbackTarget, fallbackTarget]); assert.equal(calls[2].previous_response_id, "resp-synthetic");
  state.upstream.apiKey = "SYNTHETIC_ROTATED_API_CREDENTIAL";
  assert.equal((await state.run({ previous_response_id: id })).status, 400); assert.equal(calls.length, 3);
  state.policy.enabled = false;
  assert.equal((await state.run()).status, 404); assert.equal(calls.length, 3);
});

test("private API transport never falls through an auth denial to another model or credential kind", async (t) => {
  for (const status of [401, 403]) {
    const state = await fixture(); state.upstream.fallbackTarget = fallbackTarget; let calls = 0;
    t.mock.method(globalThis, "fetch", async url => {
      calls++; assert.equal(url, "https://api.openai.com/v1/responses");
      return Response.json({ error: { code: "unauthorized", message: apiKey } }, { status });
    });
    const result = await state.run(); assert.equal(result.status, status); assert.doesNotMatch(await result.text(), /SYNTHETIC/); assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});
