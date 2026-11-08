import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };
import { resolveProviderOffer } from "../provider-offers.ts";
import { grantSupports } from "../provider-auth.ts";
import { sha256Hex } from "../utils.ts";

const { catalogResponse } = await import("../discovery.ts");

const provider = snapshot.providers.find(provider => provider.id === "anthropic");
const api = { provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-api" };
const subscription = { provider: "anthropic", kind: "subscription", enabled: true, accessToken: "fixture-subscription" };

test("bundled Anthropic offers retain API and subscription transport boundaries without I/O", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("offer resolution must not call upstream"); });
  for (const offer of provider.offer_definitions) {
    const member = offer.productId === "claude-subscription";
    assert.equal(resolveProviderOffer(provider, offer.id, member ? subscription : api, { mode: "http" })?.definition.id, offer.id);
    assert.equal(resolveProviderOffer(provider, offer.id, member ? api : subscription, { mode: "http" }), null);
    assert.equal(resolveProviderOffer(provider, offer.id, member ? subscription : api, { mode: "websocket" }), null);
    assert.equal(resolveProviderOffer(provider, offer.id, member ? subscription : api, { mode: "http", managedLifecycle: true }), null);
  }
  for (const endpoint of provider.endpoints) {
    const supported = grantSupports({ provider, endpoint, mode: "http" }, subscription);
    assert.equal(supported, ["messages", "count_tokens"].includes(endpoint.id), endpoint.id);
    assert.equal(provider.products.find(product => product.id === "claude-subscription").endpoints.includes(endpoint.id), supported);
  }
});

test("Anthropic catalog products follow caller grants, policy selection and cooldown", async t => {
  const secret = "fixture-anthropic-discovery";
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const policy = { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const grants = new Map(), states = {};
  const env = {
    ANTHROPIC_API_KEY: "fixture-environment-key",
    POLICY_KV: { async get(key) { return Array.isArray(key) ? new Map(key.map(item => [item, grants.get(item) ?? null])) : grants.get(key) ?? null; } },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async url => {
      assert.equal(new URL(url).pathname, "/admission/resolve", "catalog must not select a grant or mutate authority");
      return Response.json({ credential: { credentialId: "fixture", credential }, policy: { policyId: "fixture", policy }, owner: null,
        connections: [{ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }],
        pools: { anthropic: { keys: [...grants.keys()], states } } });
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("catalog must not refresh or probe upstream"); });
  async function view(expected) {
    const response = await catalogResponse(new Request("https://router.example/v1/catalog", {
      headers: { authorization: `Bearer clawrouter-live-fixture-${secret}` },
    }), env);
    assert.equal(response.status, 200);
    const row = (await response.json()).providers.find(row => row.id === "anthropic");
    assert.deepEqual(row.products?.map(product => product.id) ?? [], expected);
    const references = row.offers.flatMap(offer => offer.productOffers ?? []);
    assert.deepEqual([...new Set(references.map(reference => reference.productId))].sort(), expected);
    if (expected.length) assert.ok(references.length > 0);
    return row;
  }
  const apiCatalog = await view(["platform-api"]);
  assert.ok(apiCatalog.offers.filter(offer => offer.endpoint.startsWith("models_")).every(offer => !offer.eligible && offer.productOffers === undefined));
  const key = "oauth/fixture/subscription";
  grants.set(key, subscription);
  delete env.ANTHROPIC_API_KEY;
  const subscribed = await view(["claude-subscription"]);
  assert.ok(subscribed.offers.filter(offer => offer.endpoint.startsWith("models_")).every(offer => !offer.eligible && offer.productOffers === undefined));
  assert.ok(subscribed.offers.filter(offer => offer.productOffers?.length).every(offer => ["messages", "count_tokens"].includes(offer.endpoint)));
  assert.ok(subscribed.offers.some(offer => offer.endpoint === "count_tokens" && offer.productOffers?.length));
  env.ANTHROPIC_API_KEY = "fixture-environment-key";
  grants.set("oauth/fixture/api", api);
  const mixed = await view(["claude-subscription", "platform-api"]);
  assert.ok(mixed.offers.some(offer => offer.endpoint === "models_list" && offer.productOffers?.some(reference => reference.productId === "platform-api")));
  policy.grantRouting = { eligibleGrants: { anthropic: ["subscription"] } };
  await view(["claude-subscription"]);
  states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60000).toISOString(), windows: [] };
  const cooling = await view([]);
  assert.ok(cooling.offers.every(offer => !offer.eligible && offer.productOffers === undefined));
  delete states[key];
  subscription.enabled = false;
  await view([]);
});
