import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { applyTemplateHeaders, resolveHeaderTemplate, resolveTemplate } from "../provider-templates.ts";
import { copyRequestHeaders, providerById } from "../providers.ts";

const provider = {
  ...providerById("openrouter"),
  id: "fixture",
  config_keys: ["FIXTURE_SITE_URL", "FIXTURE_REQUIRED"],
  optional_config_keys: ["FIXTURE_SITE_URL"],
};
const missingRequired = (error) => error.code === "provider_not_configured" && error.status === 503;

test("optional headers omit the whole value while configured and constant headers survive", () => {
  const values = { "http-referer": "prefix ${site_url}", "x-title": "Fixture" };
  const headers = new Headers();
  applyTemplateHeaders(provider, values, {}, headers);
  assert.equal(headers.has("http-referer"), false);
  assert.equal(headers.get("x-title"), "Fixture");
  applyTemplateHeaders(provider, values, { FIXTURE_SITE_URL: "https://client.example" }, headers);
  assert.equal(headers.get("http-referer"), "prefix https://client.example");
  assert.equal(resolveHeaderTemplate(provider, "${site_url}", { FIXTURE_SITE_URL: " " }), null);
});

test("optional header omission never suppresses missing required or undeclared bindings", () => {
  for (const value of ["${required}", "${site_url}/${required}", "${required}/${site_url}", "${undeclared}"]) {
    assert.throws(() => resolveHeaderTemplate(provider, value, {}), missingRequired);
  }
  assert.equal(resolveHeaderTemplate(provider, "${site_url}/${required}", { FIXTURE_REQUIRED: "present" }), null);
  assert.throws(() => resolveTemplate(provider, "https://${site_url}/v1", {}), missingRequired);
  assert.throws(() => resolveTemplate(provider, "${required}", { CLAWROUTER_OPTIONAL_CONFIG_KEYS: "FIXTURE_REQUIRED" }), missingRequired);
  assert.equal(resolveHeaderTemplate(provider, "${required}", { CLAWROUTER_OPTIONAL_CONFIG_KEYS: "FIXTURE_REQUIRED" }), null);
});

test("endpoint headers share optional binding semantics without weakening required headers", () => {
  const endpoint = { request_headers: [], headers: { "x-attribution": "${site_url}", "x-required": "${required}" } };
  const headers = new Headers();
  copyRequestHeaders(new Headers(), provider, endpoint, headers, { FIXTURE_REQUIRED: "configured" });
  assert.equal(headers.has("x-attribution"), false);
  assert.equal(headers.get("x-required"), "configured");
  assert.throws(() => copyRequestHeaders(new Headers(), provider, endpoint, new Headers(), {}), missingRequired);
});
