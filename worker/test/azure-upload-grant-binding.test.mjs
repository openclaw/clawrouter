import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const source = parse(readFileSync(new URL("../../providers/azure-speech.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/azure-speech/ssml.json", import.meta.url)));
const format = "audio-24khz-48kbitrate-mono-mp3";
// Complete transport bytes, not a synthesis or playability claim.
const audio = Uint8Array.of(0xff, 0xf3, 0x64, 0xc4, 0, 0, 0, 3, 0x48, 0, 0, 0);

async function setup(t, pooled = true) {
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "azure-speech"); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { pooled, providerId: "azure-speech", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([structuredClone(source)]).providers[0]);
  } });
  Object.assign(f.env, { AZURE_SPEECH_REGION: "eastus", AZURE_SPEECH_API_KEY: "synthetic-environment-key" });
  f.upstream = () => new Response(audio, { headers: { "content-type": "audio/mpeg" } });
  const pending = [], drain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await drain(); };
  f.request = (body, manifest) => new Request("https://router.example" + (manifest ? "/v1/proxy/azure-speech/speech" : "/v1/native/azure-speech/cognitiveservices/v1"), {
    method: "POST", body, duplex: "half", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret",
      "content-type": "application/ssml+xml; charset=utf-8", "x-microsoft-outputformat": format },
  });
  f.callRaw = request => worker.fetch(request, f.env, { waitUntil: promise => pending.push(promise) });
  t.after(f.drain); return f;
}

for (const manifest of [false, true]) for (const change of ["disabled", "replaced", "unchanged"]) {
  test(`Azure ${manifest ? "manifest" : "native"} pins the enabled original owner before actual reader acquisition: ${change}`, { timeout: 10_000 }, async t => {
    const f = await setup(t), sequence = [], reading = Promise.withResolvers(); let enabledOwnerObserved = false, enabledAtRead = false;
    overrideHotCacheConfig({ freshMs: 30_000, maxAgeMs: 60_000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
    const owners = f.env.GRANT_CREDENTIALS;
    const owner = owners.objects.get(owners.idFromName(grantKey))?.object;
    assert.ok(owner, "the seeded original grant owner exists");
    const materialize = owner.materialize;
    t.mock.method(owner, "materialize", async function (...args) {
      const value = await materialize.apply(this, args), grant = value?.grant;
      if (grant?.provider === "azure-speech" && grant.enabled === true && !enabledOwnerObserved) {
        enabledOwnerObserved = true; sequence.push("enabled-owner-materialized");
      }
      return value;
    });
    const body = new ReadableStream({ async pull(controller) {
      // A producer can prefetch. It cannot mutate the owner until the handler
      // actually acquires this request's reader after original admission.
      await reading.promise;
      if (change !== "unchanged") {
        await putGrantCredentials(f.env, grantKey, { provider: "azure-speech", kind: "api_key", enabled: change !== "disabled",
          credential: change === "replaced" ? "synthetic-replacement-key" : "synthetic-original-key" });
        sequence.push("owner-" + change);
      }
      controller.enqueue(new TextEncoder().encode(wire.request.body)); controller.close();
    } }, { highWaterMark: 0 });
    const request = f.request(body, manifest), input = request.body, getReader = input.getReader.bind(input);
    t.mock.method(input, "getReader", (...args) => {
      enabledAtRead = enabledOwnerObserved; sequence.push("handler-reader"); reading.resolve(); return getReader(...args);
    });
    const response = await f.callRaw(request), bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(enabledAtRead, true, "actual reader entry must follow successful original-owner materialization");
    assert.deepEqual(sequence.slice(0, 2), ["enabled-owner-materialized", "handler-reader"]);
    await f.drain(); assert.equal(bodyBudgetCharged(), 0);
    if (change === "unchanged") {
      assert.equal(response.status, 200); assert.deepEqual(bytes, audio); assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].headers.get("ocp-apim-subscription-key"), "synthetic-original-key");
      assert.equal((await f.events())[0].actual_cost_micros, 700);
    } else {
      assert.equal(sequence[2], "owner-" + change);
      assert.equal(response.status, change === "disabled" ? 503 : 409);
      const error = JSON.parse(new TextDecoder().decode(bytes)).error;
      assert.equal(error.code, change === "disabled" ? "upstream_grant_pool_unavailable" : "upstream_grant_changed");
      assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
      assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
      assert.doesNotMatch(new TextDecoder().decode(bytes), /synthetic-(?:original|replacement|environment)-key/);
    }
  });
}

for (const manifest of [false, true]) test(`Azure fresh ${manifest ? "manifest" : "native"} environment selection remains valid`, async t => {
  const f = await setup(t, false), response = await f.callRaw(f.request(wire.request.body, manifest));
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("ocp-apim-subscription-key"), "synthetic-environment-key");
  await f.drain(); assert.equal((await f.events())[0].actual_cost_micros, 700); assert.equal(bodyBudgetCharged(), 0);
});
