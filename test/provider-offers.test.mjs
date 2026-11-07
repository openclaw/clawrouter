import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

function fixture() {
  const manifest = parse(readFileSync(new URL("../examples/provider-plugin/example.provider.yaml", import.meta.url), "utf8"));
  manifest.endpoints.chat = { path: "/v1/chat", requestFormat: "example.chat", responseFormat: "example.chat" };
  manifest.capabilities = [
    { id: "llm.decisions", endpoint: "invoke", methods: ["POST"] },
    { id: "llm.chat", endpoint: "chat", methods: ["POST"] },
  ];
  manifest.models = { entries: [
    { id: "example/vendor/model", upstream: "vendor/model", capabilities: ["llm.decisions"] },
    { id: "example/chat", upstream: "chat", capabilities: ["llm.chat"] },
  ] };
  manifest.products[0].endpoints.push("chat");
  manifest.products[0].offers = [
    { endpoint: "invoke", capability: "llm.decisions", models: ["example/vendor/model"] },
    { endpoint: "chat", capability: "llm.chat", models: ["example/chat"] },
  ];
  manifest.auth.grantTransports = { subscription: { baseUrl: "https://members.example.invalid", allowedEndpoints: ["invoke"] } };
  manifest.products.push({
    id: "membership", displayName: "Membership", commercialModel: "subscription", authenticationMethod: "oauth2",
    binding: { type: "grant-transport", grantKind: "subscription" }, endpoints: ["invoke"],
    offers: [{ endpoint: "invoke", capability: "llm.decisions", models: ["example/vendor/model"] }],
  });
  return manifest;
}

function compile(manifest) { return compileProviderSnapshot([manifest]).providers[0]; }

test("explicit offers preserve product identity, opaque model references and decision capabilities", () => {
  const provider = compile(fixture());
  assert.equal(provider.offer_definitions.length, 3);
  const decisions = provider.offer_definitions.filter(offer => offer.capability === "llm.decisions");
  assert.deepEqual(decisions.map(offer => offer.productId), ["api", "membership"]);
  assert.notEqual(decisions[0].id, decisions[1].id);
  for (const offer of decisions) {
    assert.deepEqual(offer.model, { id: "example/vendor/model", upstream: "vendor/model" });
    assert.equal(offer.qualification, "declared");
    assert.deepEqual(JSON.parse(offer.id.slice("clawrouter.offer.v1:".length)),
      ["example", offer.productId, "invoke", "llm.decisions", "example/vendor/model"]);
  }
  assert.ok(!provider.offer_definitions.some(offer => offer.model?.id === "example/vendor/model" && offer.capability === "llm.chat"));
});

test("model-free offers require explicit null and omitted declarations generate nothing", () => {
  const manifest = parse(readFileSync(new URL("../examples/provider-plugin/example.provider.yaml", import.meta.url), "utf8"));
  const [offer] = compile(manifest).offer_definitions;
  assert.equal(offer.model, null);
  assert.equal(offer.capability, "tool.invoke");
  delete manifest.products[0].offers;
  assert.ok(!Object.hasOwn(compile(manifest), "offer_definitions"));
  delete manifest.products;
  assert.ok(!Object.hasOwn(compile(manifest), "offer_definitions"));
});

test("offer ordering and identity do not depend on declaration order or display labels", () => {
  const manifest = fixture();
  manifest.models.entries.push({ id: "example/second", upstream: "other/path", capabilities: ["llm.decisions"] });
  manifest.products[0].offers[0].models.push("example/second");
  const expected = compile(manifest);
  manifest.products.reverse();
  manifest.products.forEach(product => {
    product.offers.reverse();
    product.offers.forEach(offer => offer.models?.reverse());
    product.displayName = "New label";
  });
  const before = structuredClone(manifest);
  const actual = compile(manifest);
  assert.deepEqual(actual.offer_definitions, expected.offer_definitions);
  assert.deepEqual(manifest, before);
  actual.offer_definitions[0].model.upstream = "mutated";
  assert.deepEqual(manifest, before);
});

test("offers cannot select undeclared endpoints, bindings, models or capabilities", () => {
  const cases = [
    [m => m.products[1].offers[0].endpoint = "chat", /not in the product/],
    [m => m.products[0].offers[0].capability = "llm.chat", /not bound to endpoint/],
    [m => m.products[0].offers[0].models = ["unknown/vendor/model"], /unknown model/],
    [m => m.products[0].offers[0].models = ["example/chat"], /does not declare llm.decisions/],
    [m => m.products[0].offers.push({ ...m.products[0].offers[0], models: null }), /duplicate binding/],
  ];
  for (const [change, error] of cases) {
    const manifest = fixture();
    change(manifest);
    assert.throws(() => compile(manifest), error);
  }
});

test("offer schema rejects implicit model selection, empty lists, duplicates and extra authority", () => {
  const changes = [
    m => delete m.products[0].offers[0].models,
    m => m.products[0].offers = [],
    m => m.products[0].offers[0].models = [],
    m => m.products[0].offers[0].models.push("example/vendor/model"),
    m => m.products[0].offers[0].models = "*",
    m => m.products[0].offers[0].eligible = true,
    m => m.products[0].offers[0].price = 0,
    m => m.products[0].offers[0].protocol = "unshipped.adapter",
  ];
  for (const change of changes) {
    const manifest = fixture();
    change(manifest);
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

test("offer declarations leave all existing execution metadata unchanged", () => {
  const manifest = fixture();
  const { products, offer_definitions, ...execution } = compile(manifest);
  assert.ok(products && offer_definitions);
  delete manifest.products;
  assert.deepEqual(execution, compile(manifest));
});
