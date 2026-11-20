import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProviderConformanceScenario, ProviderConformanceContractError } from "../packages/provider-plugin-contract/src/index.ts";
import { createProviderPlugin } from "../scripts/create-provider-plugin.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../examples/provider-plugin/fixtures/request.json", import.meta.url), "utf8"));

test("scaffolding emits a valid scenario with the generated provider identity", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-conformance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createProviderPlugin("acme-ai", join(root, "acme-ai"));
  const parsed = parseProviderConformanceScenario(JSON.parse(readFileSync(join(root, "acme-ai/fixtures/request.json"), "utf8")));
  assert.equal(parsed.providerId, "acme-ai");
  assert.equal(parsed.endpoint, "invoke");
  assert.equal(parsed.capability, "tool.invoke");
  assert.equal(parsed.response.status, 200);
});

test("JSON exchange fixture preserves opaque identities and detaches all mutable data", () => {
  const input = fixture();
  input.model = "gateway/vendor/model";
  input.request.headers = { "content-type": "application/json" };
  input.request.body.items = [{ value: 1 }];
  const parsed = parseProviderConformanceScenario(input);
  assert.deepEqual(parsed, input);
  input.request.headers["content-type"] = "changed";
  input.request.body.items[0].value = 2;
  input.upstream.response.body.output = "changed";
  assert.equal(parsed.model, "gateway/vendor/model");
  assert.equal(parsed.request.headers["content-type"], "application/json");
  assert.equal(parsed.request.body.items[0].value, 1);
  assert.equal(parsed.upstream.response.body.output, "example");
});

test("missing bodies, JSON null and upstream errors remain distinct", () => {
  const input = fixture();
  input.request = { method: "GET", path: "/v1/models?limit=1" };
  input.upstream.request = { method: "GET", path: "/models?limit=1" };
  input.upstream.response = { status: 429, body: { error: "synthetic quota failure" } };
  input.response = { status: 503, headers: { "retry-after": "1" }, body: null };
  const parsed = parseProviderConformanceScenario(input);
  assert.deepEqual(parsed, input);
  assert.equal(Object.hasOwn(parsed.request, "body"), false);
  assert.equal(Object.hasOwn(parsed.response, "body"), true);
});

test("contract rejects unsupported schemas, kinds and hidden executable fields", () => {
  for (const [key, value] of [["schema", "clawrouter.provider-conformance.v2"], ["kind", "stream"], ["id", "Bad ID"], ["providerId", "../provider"], ["endpoint", ""], ["capability", null], ["model", "model\n"]]) {
    assert.throws(() => parseProviderConformanceScenario({ ...fixture(), [key]: value }), error => error instanceof ProviderConformanceContractError && error.pointer === `/${key}`);
  }
  for (const location of ["root", "request", "upstream", "response"]) {
    const input = fixture();
    const target = location === "root" ? input : input[location];
    target.script = "do not execute";
    assert.throws(() => parseProviderConformanceScenario(input), /script: unknown field/);
  }
});

test("HTTP envelopes reject remote URLs, malformed headers and nonfinal statuses", () => {
  for (const path of ["https://api.example.invalid/invoke", "//api.example.invalid/invoke", "relative", "/a#fragment", "/a\\b", "/a b", "/a\r\n"]) {
    const input = fixture();
    input.upstream.request.path = path;
    assert.throws(() => parseProviderConformanceScenario(input), /\/upstream\/request\/path/);
  }
  for (const headers of [{ Authorization: "synthetic" }, { authorization: "synthetic\r\ninjected: true" }, { bad: ["a", "b"] }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, ""]))]) {
    const input = fixture();
    input.request.headers = headers;
    assert.throws(() => parseProviderConformanceScenario(input), /\/request\/headers/);
  }
  for (const status of [101, 199, 600, 200.5, "200", null]) {
    const input = fixture();
    input.response.status = status;
    assert.throws(() => parseProviderConformanceScenario(input), /\/response\/status/);
  }
  const input = fixture();
  input.request.method = "CONNECT";
  assert.throws(() => parseProviderConformanceScenario(input), /\/request\/method/);
});

test("JSON bodies reject non-JSON values, cycles and excessive size or depth", () => {
  const cycle = {};
  cycle.self = cycle;
  let deep = null;
  for (let i = 0; i < 34; i++) deep = [deep];
  for (const body of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cycle, deep, Array(10000).fill(0), [, 1]]) {
    const input = fixture();
    input.request.body = body;
    assert.throws(() => parseProviderConformanceScenario(input), ProviderConformanceContractError);
  }
});

test("JSON object keys remain data and errors use escaped JSON pointers", () => {
  const input = fixture();
  input.response.body = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
  const parsed = parseProviderConformanceScenario(input);
  assert.equal(Object.hasOwn(parsed.response.body, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed.response.body), Object.prototype);
  assert.equal({}.polluted, undefined);
  input.response.body = { "a/b~c": NaN };
  assert.throws(() => parseProviderConformanceScenario(input), error => error.pointer === "/response/body/a~1b~0c");
});
