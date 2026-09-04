import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { privateCodex } = await import("../private-codex.ts");
const { privateHeadersRejection, privateProtocolBodyRejection } = await import("../private-codex-protocol.ts");
const { sha256Hex } = await import("../utils.ts");

const alias = "codex-latest";
const credential = "private-workload-SYNTHETIC_TELEMETRY_CREDENTIAL_0123456789";
const target = "SYNTHETIC_TELEMETRY_TARGET";
const encoder = new TextEncoder();

async function environment() {
  const policy = {
    version: 1,
    enabled: true,
    alias: { id: alias, name: "Codex (Latest)" },
    auth: { mode: "workload", credentialSha256: await sha256Hex(credential) },
  };
  const upstream = {
    version: 1,
    target,
    accountId: "SYNTHETIC_TELEMETRY_ACCOUNT",
    accessToken: "SYNTHETIC_TELEMETRY_TOKEN",
    expiresAt: Date.now() + 3_600_000,
  };
  return {
    PRIVATE_CODEX_POLICY: { get: async () => JSON.stringify(policy) },
    PRIVATE_CODEX_UPSTREAM: { get: async () => JSON.stringify(upstream) },
  };
}

function request(body, headers = {}, path = "/private/v1/responses") {
  return new Request(`https://synthetic.invalid${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...headers },
    body,
  });
}

function expected(predicate, requestBytes) {
  return { predicate, request_bytes: requestBytes };
}

test("local rejection telemetry contains only a fixed predicate and exact consumed bytes", async (context) => {
  const env = await environment();
  const events = [];
  context.mock.method(console, "info", (event) => events.push(event));
  context.mock.method(globalThis, "fetch", () => assert.fail("locally rejected request reached upstream"));

  const preBody = request("{}", { "content-type": "text/plain", "content-length": "999999999" });
  assert.equal((await privateCodex(preBody, env)).status, 400);
  assert.deepEqual(events.pop(), expected("request.content_type", null));

  const invalidJson = "{";
  assert.equal((await privateCodex(request(invalidJson), env)).status, 400);
  assert.deepEqual(events.pop(), expected("body.json", encoder.encode(invalidJson).byteLength));

  const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
  assert.equal((await privateCodex(request(invalidUtf8), env)).status, 400);
  assert.deepEqual(events.pop(), expected("body.utf8", invalidUtf8.byteLength));

  const wrongModel = JSON.stringify({ model: "synthetic-other", store: false });
  assert.equal((await privateCodex(request(wrongModel), env)).status, 400);
  assert.deepEqual(events.pop(), expected("request.model_alias", encoder.encode(wrongModel).byteLength));

  const badProtocol = JSON.stringify({ model: alias, store: false, client_metadata: { "x-codex-turn-metadata": "{" } });
  assert.equal((await privateCodex(request(badProtocol), env)).status, 400);
  assert.deepEqual(events.pop(), expected("protocol.turn_metadata", encoder.encode(badProtocol).byteLength));

  const body = JSON.stringify({ model: alias, store: false, service_tier: "priority" });
  assert.equal((await privateCodex(request(body, { "x-codex-routing-hint": `model=${alias}` }), env)).status, 400);
  assert.deepEqual(events.pop(), expected("headers.routing_tier", encoder.encode(body).byteLength));

  assert.equal(events.length, 0);
});

test("header and protocol validators expose distinct fixed owning predicates", () => {
  assert.equal(privateHeadersRejection(new Headers({ "content-encoding": "gzip" }), alias), "headers.content_encoding");
  assert.equal(privateHeadersRejection(new Headers({ "transfer-encoding": "chunked" }), alias), "headers.transfer_encoding");
  assert.equal(privateHeadersRejection(new Headers({ "x-model-override": "synthetic" }), alias), "headers.selector");
  assert.equal(privateHeadersRejection(new Headers({ "x-codex-unknown": "true" }), alias), "headers.namespace");
  assert.equal(privateHeadersRejection(new Headers({ "x-openai-memgen-request": "maybe" }), alias), "headers.boolean");
  assert.equal(privateHeadersRejection(new Headers({ "x-codex-turn-metadata": "{" }), alias), "headers.turn_metadata");
  assert.equal(privateHeadersRejection(new Headers({ "x-codex-routing-hint": "model=synthetic-other" }), alias), "headers.routing_hint");

  assert.equal(privateProtocolBodyRejection({ client_metadata: [] }), "protocol.metadata_object");
  assert.equal(privateProtocolBodyRejection({ client_metadata: { unknown: "value" } }), "protocol.metadata_key");
  assert.equal(privateProtocolBodyRejection({ client_metadata: { "x-codex-window-id": 1 } }), "protocol.metadata_value_type");
  assert.equal(privateProtocolBodyRejection({ client_metadata: { "x-codex-window-id": "x".repeat(8193) } }), "protocol.metadata_value_limit");
  assert.equal(privateProtocolBodyRejection({ stream_options: [] }), "protocol.stream_options_object");
  assert.equal(privateProtocolBodyRejection({ stream_options: {} }), "protocol.stream_options_keys");
  assert.equal(privateProtocolBodyRejection({ stream: true, stream_options: { reasoning_summary_delivery: "other" } }), "protocol.stream_options_delivery");
  assert.equal(privateProtocolBodyRejection({ stream: false, stream_options: { reasoning_summary_delivery: "sequential_cutoff" } }), "protocol.stream_options_stream");
  assert.equal(privateProtocolBodyRejection({ access_programs: [] }), "protocol.access_programs_object");
  assert.equal(privateProtocolBodyRejection({ access_programs: {} }), "protocol.access_programs_keys");
  assert.equal(privateProtocolBodyRejection({ access_programs: { cyber: 1 } }), "protocol.access_programs_type");
  assert.equal(privateProtocolBodyRejection({ access_programs: { cyber: "NOT_VALID" } }), "protocol.access_programs_value");
});

test("hidden routes, upstream responses and successful calls emit no rejection telemetry", async (context) => {
  const env = await environment();
  const events = [];
  context.mock.method(console, "info", (event) => events.push(event));

  assert.equal((await privateCodex(request("{}", {}, "/private/v1/unknown"), env)).status, 404);
  assert.deepEqual(events, []);

  for (const status of [200, 400, 502]) {
    context.mock.method(globalThis, "fetch", () => status === 200
      ? Response.json({ id: "synthetic-response", object: "response", model: target, status: "completed", output: [] })
      : Response.json({ error: { code: "synthetic-upstream" } }, { status }));
    const body = JSON.stringify({ model: alias, input: "synthetic", store: false });
    assert.equal((await privateCodex(request(body), env)).status, status);
    assert.deepEqual(events, []);
    context.mock.restoreAll();
    context.mock.method(console, "info", (event) => events.push(event));
  }
});

test("telemetry sink failures do not change the local rejection response", async (context) => {
  const env = await environment();
  context.mock.method(console, "info", () => { throw new Error("synthetic sink failure"); });
  const response = await privateCodex(request("{}", { "content-type": "text/plain" }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "invalid_request", message: "Unsupported private request." } });
});
