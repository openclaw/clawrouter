import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { policyRequestCost } from "../../shared/request-pricing.ts";
import { fusionAdviserModels } from "../../shared/fusion-strategy.ts";
import { errorMessage, policyCoversProvider } from "../src/domain.ts";

// Execute the hook owner; browser coverage supplies React and the real panel.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/access/use-fusion-admin.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useFusionAdmin", "function useFusionAdmin");
const config = { enabled: true, modelId: "fusion", strategy: "single", adviserModels: [], aggregatorModel: "openai/original", adviserTimeoutMs: 1000, maxOutputTokens: 64, maxInputChars: 1000, maxProposalChars: 256, temperature: 0 };
const event = { preventDefault() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

function mount(initialize = true) {
  const cells = [], requests = [], statuses = [];
  let index = 0, owner;
  const useState = initial => {
    const slot = index++;
    if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial;
    return [cells[slot], value => { cells[slot] = typeof value === "function" ? value(cells[slot]) : value; }];
  };
  const useRef = initial => {
    const slot = index++;
    return cells[slot] ??= { current: initial };
  };
  const hook = new Function("useState", "useRef", "errorMessage", "policyCoversProvider", "policyRequestCost", "fusionAdviserModels", "defaultFusion", "demo", `${source}\nreturn useFusionAdmin;`)
    (useState, useRef, errorMessage, policyCoversProvider, policyRequestCost, fusionAdviserModels, config, { fusion: config });
  const dependencies = {
    allowDemo: false, demoMode: false, gatewayOrigin: "https://router.example", policies: [], selectedPolicyId: "policy_a",
    setStatus: value => statuses.push(value),
    request: (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, body: JSON.parse(init.body), resolve, reject })),
    refresh: async () => {
      const current = render();
      current.hydrate({ ...config, aggregatorModel: "openai/refreshed" }, false, "policy_a", ["policy_a", "policy_b"], current.captureHydration());
    },
  };
  function render() { index = 0; owner = hook(dependencies); return owner; }
  render();
  if (initialize) owner.hydrate(config, false, "policy_a", ["policy_a", "policy_b"], owner.captureHydration());
  return { render, requests, statuses, dependencies };
}

test("the first bootstrap supplies authoritative config before Fusion can write", async () => {
  const f = mount(false), snapshot = f.render().captureHydration();
  f.render().fusion.setConfig(current => ({ ...current, aggregatorModel: "openai/early" }));
  await f.render().fusion.save(event);
  await f.render().fusion.check();
  assert.equal(f.requests.length, 0);
  f.render().hydrate({ ...config, aggregatorModel: "openai/authoritative" }, false, "policy_a", ["policy_a"], snapshot);
  assert.equal(f.render().fusion.config.aggregatorModel, "openai/authoritative");
});

for (const edit of ["config", "policy"]) {
  test(`a pending Fusion save and its refresh preserve a newer ${edit} draft`, async () => {
    const f = mount(), saving = f.render().fusion.save(event);
    f.requests[0].resolve({ executable: true });
    await tick();
    assert.equal(f.requests[1].path, "/v1/admin/fusion");
    assert.equal(f.requests[1].body.aggregatorModel, "openai/original");
    if (edit === "config") f.render().fusion.setConfig(current => ({ ...current, aggregatorModel: "openai/later" }));
    else f.render().fusion.setPolicyId("policy_b");
    f.requests[1].resolve({ ...config, aggregatorModel: "openai/canonical" });
    await saving;
    assert.equal(f.render().fusion.config.aggregatorModel, edit === "config" ? "openai/later" : "openai/original");
    assert.equal(f.render().fusion.policyId, edit === "policy" ? "policy_b" : "policy_a");
    assert.equal(f.render().fusion.readiness, null);
  });
}

test("an unchanged Fusion draft adopts the receipt and rejects an older bootstrap", async () => {
  const f = mount(), snapshot = f.render().captureHydration();
  const saving = f.render().fusion.save(event);
  f.requests[0].resolve({ executable: true });
  await tick();
  f.requests[1].resolve({ ...config, aggregatorModel: "openai/canonical" });
  await saving;
  f.render().hydrate(config, false, "policy_a", ["policy_a"], snapshot);
  assert.equal(f.render().fusion.config.aggregatorModel, "openai/canonical");
});

test("editing during readiness prevents the write and stale readiness publication", async () => {
  const f = mount(), saving = f.render().fusion.save(event);
  f.render().fusion.setConfig(current => ({ ...current, aggregatorModel: "openai/later" }));
  f.requests[0].resolve({ executable: true });
  await saving;
  assert.equal(f.requests.length, 1);
  assert.equal(f.render().fusion.config.aggregatorModel, "openai/later");
  assert.equal(f.render().fusion.readiness, null);
});

test("clean Fusion state follows refresh while unsaved state stays with its editor", () => {
  const f = mount();
  f.render().hydrate({ ...config, aggregatorModel: "openai/refreshed" }, false, "policy_b", ["policy_b"], f.render().captureHydration());
  assert.equal(f.render().fusion.config.aggregatorModel, "openai/refreshed");
  assert.equal(f.render().fusion.policyId, "policy_b");
  f.render().fusion.setConfig(current => ({ ...current, aggregatorModel: "openai/unsaved" }));
  f.render().hydrate(config, false, "policy_a", ["policy_a"], f.render().captureHydration());
  assert.equal(f.render().fusion.config.aggregatorModel, "openai/unsaved");
  assert.equal(f.render().fusion.policyId, "policy_b");
});

test("reset retires an in-flight Fusion receipt", async () => {
  const f = mount(), saving = f.render().fusion.save(event);
  f.requests[0].resolve({ executable: true });
  await tick();
  f.render().reset({ ...config, enabled: false, aggregatorModel: "" });
  f.requests[1].resolve(config);
  await saving;
  assert.equal(f.render().fusion.config.enabled, false);
  assert.equal(f.render().fusion.config.aggregatorModel, "");
  assert.equal(f.render().fusion.policyId, "");
  assert.equal(f.render().fusion.readiness, null);
});

test("Fusion admits one operation while preserving a failed save for retry", async () => {
  const f = mount(), saving = f.render().fusion.save(event);
  const duplicate = f.render().fusion.save(event);
  const check = f.render().fusion.check();
  assert.equal(f.requests.length, 1);
  await Promise.all([duplicate, check]);
  f.requests[0].resolve({ executable: true });
  await tick();
  f.requests[1].reject(new Error("save unavailable"));
  await saving;
  assert.match(f.render().fusion.error, /save unavailable/);
  const retry = f.render().fusion.save(event);
  f.requests[2].resolve({ executable: true });
  await tick();
  f.requests[3].resolve(config);
  await retry;
  assert.equal(f.render().fusion.error, "");
});
