import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { compileCatalogVariant, startCatalogVariantFixture } from "./helpers/openclaw-catalog-variant.mjs";

const directory = new URL("../providers/", import.meta.url);
const manifests = readdirSync(directory).filter(path => path.endsWith(".provider.yaml")).sort()
  .map(path => parse(readFileSync(new URL(path, directory), "utf8")));
const supported = [["cohere", "embed"], ["voyage", "embeddings"], ["elevenlabs", "speech"]];

test("all bundled manifests compile to the exact checked-in catalog snapshot", () => {
  assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
});

for (const [id, endpoint] of supported) test(`${id}: validated manifest configuration changes only its named native preference`, () => {
  const expected = structuredClone(snapshot);
  expected.providers.find(provider => provider.id === id).endpoints.find(row => row.id === endpoint).native_proxy = false;
  assert.deepEqual(compileCatalogVariant([id]), expected);
});

for (const [id, endpoint] of [
  ["google-gemini", "embed_content"], ["google-gemini", "batch_embed_contents"],
  ["google-gemini", "image_generate"], ["google-gemini", "music_generate"], ["gradium", "speech"],
]) test(`${id}/${endpoint}: schema rejects nativeProxy false`, () => {
  const configured = structuredClone(manifests);
  assert.ok(configured.find(provider => provider.id === id).endpoints[endpoint]);
  configured.find(provider => provider.id === id).endpoints[endpoint].nativeProxy = false;
  assert.throws(() => compileProviderSnapshot(configured), /invalid manifest/);
});

test("catalog variant fixture refuses unsupported or duplicate provider selection", () => {
  assert.throws(() => compileCatalogVariant(["google-gemini"]), /unsupported manifest variant/);
  assert.throws(() => compileCatalogVariant(["cohere", "cohere"]), /duplicate variant provider/);
});

test("compiled variants reach the real Worker catalog before module evaluation", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "catalog-variant-"));
  let mf;
  try {
    mf = await startCatalogVariantFixture(temporary,
      'export { default } from "./worker/index.ts"; export * from "./worker/index.ts";',
      'export default { fetch() { throw new Error("catalog discovery must not dispatch upstream"); } };',
      supported.map(([id]) => id),
      { bindings: { COHERE_API_KEY: "fixture-cohere-key", VOYAGE_API_KEY: "fixture-voyage-key", ELEVENLABS_API_KEY: "fixture-elevenlabs-key" } });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const [id, endpoint] of supported) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
      await kv.put(`connections/${id}`, JSON.stringify({ providerId: id, enabled: true }));
      const response = await mf.dispatchFetch("https://fixture.example/v1/catalog", { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } });
      assert.equal(response.status, 200);
      const offers = (await response.json()).providers.find(provider => provider.id === id).offers.filter(offer => offer.endpoint === endpoint);
      assert.ok(offers.some(offer => offer.routeKind === "manifest" && offer.eligible), id);
      assert.ok(offers.every(offer => offer.routeKind === "manifest"), id);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
