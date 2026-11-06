import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

function fixture() {
  const manifest = parse(readFileSync(new URL("../examples/provider-plugin/example.provider.yaml", import.meta.url), "utf8"));
  manifest.auth.grantTransports = { subscription: { baseUrl: "https://members.example.invalid", allowedEndpoints: ["invoke"] } };
  manifest.products.push({
    id: "membership", displayName: "Example membership", commercialModel: "subscription",
    authenticationMethod: "oauth2", binding: { type: "grant-transport", grantKind: "subscription" }, endpoints: ["invoke"],
  });
  return manifest;
}

function compile(manifest) { return compileProviderSnapshot([manifest]).providers[0]; }

test("products preserve independent authored classifications and leave execution metadata unchanged", () => {
  const manifest = fixture();
  const original = structuredClone(manifest);
  const withProducts = compile(manifest);
  const legacy = structuredClone(manifest);
  delete legacy.products;
  const { products, offer_definitions, ...execution } = withProducts;
  assert.ok(offer_definitions.every(offer => offer.qualification === "declared"));
  assert.deepEqual(execution, compile(legacy));
  assert.equal(products[1].commercialModel, "subscription");
  assert.equal(products[1].authenticationMethod, "oauth2");
  manifest.products[1].commercialModel = "prepaid";
  manifest.products[1].authenticationMethod = "api-key";
  assert.equal(compile(manifest).products[1].commercialModel, "prepaid");
  assert.equal(compile(manifest).products[1].authenticationMethod, "api-key");
  assert.deepEqual(original.products, withProducts.products);
  products[1].binding.grantKind = "oauth";
  products[1].endpoints.push("other");
  assert.deepEqual(manifest.products[1].binding, original.products[1].binding);
  assert.deepEqual(manifest.products[1].endpoints, original.products[1].endpoints);
});

test("product and endpoint ordering is deterministic without mutating input", () => {
  const manifest = fixture();
  manifest.endpoints.other = { ...manifest.endpoints.invoke, path: "/v1/other" };
  manifest.products[0].endpoints.push("other");
  const expected = compile(manifest).products;
  manifest.products.reverse();
  manifest.products.find(product => product.id === "api").endpoints.reverse();
  const before = structuredClone(manifest);
  assert.deepEqual(compile(manifest).products, expected);
  assert.deepEqual(manifest, before);
});

test("products reject duplicate identities and unresolved or excluded bindings", () => {
  const cases = [
    [m => m.products.push(structuredClone(m.products[0])), /duplicate product id/],
    [m => m.products[0].endpoints.push("missing"), /unknown endpoint missing/],
    [m => m.products[0].endpoints.push("constructor"), /unknown endpoint constructor/],
    [m => m.products[1].binding.grantKind = "oauth", /unknown grant transport/],
    [m => { m.endpoints.other = { ...m.endpoints.invoke, path: "/v1/other" }; m.auth.grantTransports.subscription.allowedEndpoints = ["other"]; }, /excluded by grant transport/],
  ];
  for (const [change, error] of cases) {
    const manifest = fixture();
    change(manifest);
    assert.throws(() => compile(manifest), error);
  }
});

test("product schema rejects implicit, malformed and executable metadata", () => {
  const changes = [
    m => m.products = [],
    m => delete m.products[0].commercialModel,
    m => delete m.products[0].authenticationMethod,
    m => m.products[0].commercialModel = "oauth",
    m => m.products[0].authenticationMethod = "rest",
    m => m.products[0].id = "bad/id",
    m => m.products[0].endpoints = [],
    m => m.products[0].endpoints.push("invoke"),
    m => m.products[0].binding.grantKind = "api_key",
    m => delete m.products[1].binding.grantKind,
    m => m.products[1].binding.grantKind = "constructor",
    m => m.products[0].baseUrl = "https://other.example.invalid",
    m => m.products[0].adapter = "unreviewed",
  ];
  for (const change of changes) {
    const manifest = fixture();
    change(manifest);
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});
