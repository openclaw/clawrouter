import assert from "node:assert/strict";
import test from "node:test";
import { createVertexAssertion, decodeVertexAccessToken, importVertexServiceAccountKey, prepareVertexAnthropicRequest, vertexAnthropicUrl, vertexScope, vertexTokenRequest, vertexTokenUrl } from "../provider-vertex.ts";

const now = 1_800_000_000;
const binding = { project: "fixture-project", location: "us-east5" };
const token = { accessToken: "synthetic-access-token", expiresAt: now + 3600 };

test("service-account assertion has a verified RS256 signature, pinned audience/scope and bounded lifetime", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const pem = "-----BEGIN PRIVATE KEY-----\n" + Buffer.from(der).toString("base64") + "\n-----END PRIVATE KEY-----\n";
  const imported = await importVertexServiceAccountKey(pem);
  assert.equal(imported.extractable, false);
  const assertion = await createVertexAssertion("fixture@fixture-project.iam.gserviceaccount.com", imported, now, "synthetic-key-id");
  const [header, payload, signature] = assertion.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT", kid: "synthetic-key-id" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iss: "fixture@fixture-project.iam.gserviceaccount.com", scope: vertexScope, aud: vertexTokenUrl, iat: now, exp: now + 3600 });
  assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`)), true);
  const request = vertexTokenRequest(assertion);
  assert.equal(request.url, vertexTokenUrl);
  assert.equal(request.redirect, "manual");
  const fields = new URLSearchParams(await request.text());
  assert.equal(fields.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(fields.get("assertion"), assertion);
  await assert.rejects(createVertexAssertion("user@example.com", imported, now), /invalid_vertex_service_account/);
  await assert.rejects(createVertexAssertion("fixture@fixture-project.iam.gserviceaccount.com", keys.publicKey, now), /invalid_vertex_signing_key/);
});

test("credential errors are stable and never include supplied material", async () => {
  await assert.rejects(importVertexServiceAccountKey("synthetic-private-material"), error => error.message === "invalid_vertex_private_key");
  assert.throws(() => vertexTokenRequest("synthetic-invalid-assertion"), error => error.message === "invalid_vertex_assertion");
});

test("token response requires explicit lifetime and cloud-platform scope when supplied", () => {
  const value = { access_token: token.accessToken, token_type: "Bearer", expires_in: 3600, scope: vertexScope };
  assert.deepEqual(decodeVertexAccessToken(value, now), token);
  for (const patch of [{ expires_in: undefined }, { expires_in: 0 }, { expires_in: 7200 }, { expires_in: 1.5 }, { token_type: "Other" }, { access_token: "value\r\nx-injected: 1" }, { scope: "unrelated-scope" }]) {
    assert.throws(() => decodeVertexAccessToken({ ...value, ...patch }, now), /invalid_vertex/);
  }
});

test("global, multi-region and regional locations select their own resource URLs", () => {
  for (const [location, host] of [["global", "aiplatform.googleapis.com"], ["us", "aiplatform.us.rep.googleapis.com"], ["eu", "aiplatform.eu.rep.googleapis.com"], ["us-east5", "us-east5-aiplatform.googleapis.com"]]) {
    const url = new URL(vertexAnthropicUrl({ ...binding, location }, "claude-opus-4-5@20251101", true));
    assert.equal(url.host, host);
    assert.equal(url.pathname, `/v1/projects/fixture-project/locations/${location}/publishers/anthropic/models/claude-opus-4-5%4020251101:streamRawPredict`);
  }
  for (const patch of [{ project: "../other" }, { location: "us-east5.evil.example" }]) assert.throws(() => vertexAnthropicUrl({ ...binding, ...patch }, "model", false), /invalid_vertex/);
  assert.throws(() => vertexAnthropicUrl(binding, "../models/other?token=x", false), /invalid_vertex_model/);
});

test("Vertex Messages bind project/model/token and preserve native tools without direct Anthropic auth", async () => {
  const body = { model: "caller-alias", messages: [{ role: "user", content: "synthetic request" }], max_tokens: 20, stream: true, thinking: { type: "enabled", budget_tokens: 10 }, tools: [{ name: "forecast", input_schema: { type: "object" } }] };
  const before = structuredClone(body);
  const request = prepareVertexAnthropicRequest(body, binding, "selected-model", token, now);
  assert.equal(request.redirect, "manual");
  assert.match(request.url, /selected-model:streamRawPredict$/);
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-access-token");
  assert.equal(request.headers.get("x-api-key"), null);
  assert.equal(request.headers.get("anthropic-version"), null);
  const { model, ...expected } = body;
  assert.deepEqual(await request.json(), { ...expected, anthropic_version: "vertex-2023-10-16" });
  assert.deepEqual(body, before);
  assert.throws(() => prepareVertexAnthropicRequest(body, binding, "selected-model", { ...token, expiresAt: now + 60 }, now), /invalid_vertex_expired_token/);
  assert.throws(() => prepareVertexAnthropicRequest({ ...body, anthropic_version: "caller-version" }, binding, "selected-model", token, now), /invalid_vertex_version/);
});
