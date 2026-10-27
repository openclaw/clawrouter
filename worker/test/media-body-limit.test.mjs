import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { usageEnv, proxyKey } from "./usage-budget-fixture.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { authorityCall } from "../authority.ts";
import { sha256Hex } from "../utils.ts";
import { bodyBudgetCharged } from "../body-budget.ts";
const { default: handler } = await import("../index.ts");

const MiB = 1024 * 1024;
const image = (mib, model = "openai/gpt-5.6") => ({ model, stream: false, input: [{ type: "message", role: "user", content: [
  { type: "input_text", text: "compare" },
  ...Array.from({ length: mib }, (_, n) => ({ type: "input_image", image_url: `data:image/png;base64,${String(n % 10).repeat(MiB)}` })),
] }] });

// Streams the encoded body; `hold` pauses delivery until released.
function upload(body, hold = Infinity) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let offset = 0, release;
  const released = new Promise(resolve => { release = resolve; });
  const stream = new ReadableStream({ async pull(controller) {
    if (offset >= hold) await released;
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset += 65536));
  } }, { highWaterMark: 0 });
  return { stream, release, length: bytes.length };
}

async function env(t) {
  const value = usageEnv([], { budgetMode: "soft", fixedCost: null, retainContent: false, limit: 1e12 });
  value.OPENAI_API_KEY = "fixture-openai-key";
  value.USAGE_QUEUE = { send: async () => undefined };
  const authority = createGrantAuthority(undefined, value);
  value.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: async (url, init) => new URL(url).pathname === "/http-continuations"
    ? Response.json(JSON.parse(init.body).action === "register" ? { outcome: "stored", claim: "owned" } : { outcome: "qualified" })
    : authority.fetch(url, init) }) };
  await authorityCall(value, "/policies/initialize-all", [{ policyId: "maintainer_access", policy: { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 1e12, budgetMode: "soft", retainRequestContent: false } }]);
  await authorityCall(value, "/credentials/initialize-all", [{ credentialId: "maintainer_key", credential: { enabled: true, secretSha256: await sha256Hex("abcdefgh"), policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" } }]);
  await authorityCall(value, "/users/initialize-all", [{ email: "owner@example.com", record: { enabled: true } }]);
  await authorityCall(value, "/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 1e12 }]);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const text = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    sent.push({ url: String(url), text });
    return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } });
  });
  return { env: value, sent };
}

async function call(environment, path, body) {
  const pending = [], response = await handler.fetch(new Request(`https://router.example${path}`, {
    method: "POST", duplex: "half", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: body.stream instanceof ReadableStream ? body.stream : JSON.stringify(body),
  }), environment, { waitUntil: promise => pending.push(promise) });
  const text = await response.text();
  await Promise.all(pending);
  return { status: response.status, retry: response.headers.get("retry-after"), json: text ? JSON.parse(text) : null };
}

for (const [path, model] of [["/v1/responses", "openai/gpt-5.6"], ["/v1/native/openai/v1/responses", "gpt-5.6"]]) {
  test(`${path} forwards a 20 MiB image turn exactly within the media envelope`, async t => {
    const { env: environment, sent } = await env(t);
    const body = image(20, model);
    const response = await call(environment, path, body);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(sent.length, 1);
    const forwarded = JSON.parse(sent[0].text);
    assert.equal(forwarded.input[0].content.length, 21);
    assert.deepEqual(forwarded.input[0].content.slice(1).map(part => part.image_url.length), Array(20).fill(MiB + 22));
    assert.equal(bodyBudgetCharged(), 0, "the lease returns after the response");
  });
}

test("routes without media formats keep the 8 MiB limit", async t => {
  const { env: environment, sent } = await env(t);
  const response = await call(environment, "/v1/embeddings", { model: "openai/text-embedding-3-small", input: "x".repeat(9 * MiB) });
  assert.equal(response.status, 413);
  assert.equal(sent.length, 0);
});

test("fusion never fans out an expanded body", async t => {
  const { env: environment, sent } = await env(t);
  const response = await call(environment, "/v1/chat/completions", { model: "clawrouter/fusion", messages: [{ role: "user", content: "x".repeat(9 * MiB) }] });
  assert.equal(response.status, 413);
  assert.equal(sent.length, 0);
});

test("a large body past the isolate budget is refused retryably and the budget recovers", async t => {
  const { env: environment, sent } = await env(t);
  const first = upload(image(28), 27 * MiB);
  const pendingFirst = call(environment, "/v1/responses", first);
  while (bodyBudgetCharged() < 50 * MiB) await new Promise(resolve => setTimeout(resolve, 5));
  const denied = await call(environment, "/v1/responses", image(24));
  assert.equal(denied.status, 503);
  assert.equal(denied.retry, "1");
  assert.equal(denied.json.error.code, "server_overloaded");
  assert.equal((await call(environment, "/v1/responses", { model: "openai/gpt-5.6", input: "small" })).status, 200, "small bodies lease nothing");
  first.release();
  assert.equal((await pendingFirst).status, 200);
  assert.equal(bodyBudgetCharged(), 0);
  assert.equal((await call(environment, "/v1/responses", image(24))).status, 200);
  assert.equal(sent.filter(item => item.text.length > MiB).length, 2);
});
