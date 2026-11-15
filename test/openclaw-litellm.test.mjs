import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { parse } from "yaml";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { selected, withGateway } from "../worker/test/litellm-model-discovery.test.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const cases = [
  ...["eof", "preabort", "partial_abort", "provider_error"].map(control => ({ id: "sdk_" + control, mode: control === "eof" || control === "preabort" ? "table" : control, unrestricted: true, control })),
  ...["stream", "streamSimple"].flatMap(action => [false, true].flatMap(versioned => ["table", "measured"].map(mode => ({ id: `sdk_${action.toLowerCase()}_${versioned ? "v1" : "root"}_${mode}`, mode, action, versioned, unrestricted: true })))),
  ...["table", "empty", "loose", "malformed", "truncated", "oversized", "error401", "error403", "redirect", "missing", "invalid_owner", "foreign"].map(mode => ({ id: "sdk_catalog_" + mode, mode, action: "catalog" })),
  { id: "sdk_warm_a", mode: "table", expectedGets: 2 }, { id: "sdk_warm_b", mode: "empty" },
  ...["narrow", "broaden", "revoke"].map(action => ({ id: "sdk_held_" + action, mode: "held", action })),
  { id: "sdk_waiter_abort", mode: "held" },
  { id: "sdk_auth_metadata", mode: "table" }, { id: "sdk_auth_inference", mode: "table", unrestricted: true },
];
const fixture = "test/fixtures/openclaw-litellm-contract.test.ts";
const fixtureText = readFileSync(fixture, "utf8");
const transformed = stripTypeScriptTypes(fixtureText, { mode: "transform" });
function actualDrain() {
  const raise = transformed.slice(transformed.indexOf("function raise("), transformed.indexOf("function observeBody("));
  return new Function(raise + "; return drainOriginals;")();
}
test("LiteLLM row pins the actual native client and retains a complete unique case roster", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8"));
  const rows = workflow.jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.equal(rows.filter(row => row.consumer === "litellm").length, 1);
  assert.deepEqual(rows.find(row => row.consumer === "litellm"), { consumer: "litellm", ref: sourceHead, test: "test/openclaw-litellm.test.mjs" });
  assert.match(fixtureText, new RegExp(sourceHead));
  assert.equal(new Set(cases.map(row => row.id)).size, cases.length);
  assert.equal(cases.length, 32);
  assert.equal(cases.filter(row => row.control).length, 4);
  assert.equal(cases.filter(row => row.action === "stream" || row.action === "streamSimple").length, 8);
  assert.ok(!fixtureText.includes("closeProviderTransportDispatcherPool("));
});
test("actual SDK drain joins late cancel and retirement originals and retains undefined rejection", async () => {
  const drain = actualDrain(); let unlock, close;
  const held = new Promise(resolve => { unlock = resolve; }), retirement = new Promise(resolve => { close = resolve; });
  const records = [{ kind: "closed", promise: held.then(() => { records.push({ kind: "cancel", promise: retirement }); }) }];
  let finished = false; const original = drain(records).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); unlock(); await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); close(); await original;
  const rejected = await drain([{ kind: "cancel", promise: Promise.reject(undefined) }]).then(() => ({ failed: false }), error => ({ failed: true, error }));
  assert.deepEqual(rejected, { failed: true, error: undefined });
});
test("actual Worker unknown-price admission denies inference before any paid POST", { timeout: 60000 }, async () => {
  await withGateway([{ id: "dollar", mode: "unpriced", unrestricted: true }], async f => {
    const response = await f.call("dollar", "/v1/native/litellm/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: selected, messages: [{ role: "user", content: "synthetic fixture" }], stream: true }) });
    const result = await response.json(); assert.ok(response.status >= 400); assert.equal(result.error.code, "pricing_required");
    assert.equal((await f.state("dollar")).calls.length, 0); assert.equal((await f.control("retire", "dollar")).retired, true);
    const usage = await f.control("usage", "dollar"); assert.equal(usage.events.length, 0);
  });
});
test("actual LiteLLM registered catalog, native stream/streamSimple and original retirement through Worker SQLite", { skip: !source, timeout: 300000 }, async t => {
  await withGateway(cases, async f => {
    const failures = [];
    try {
      await runOpenClawConsumer(t, { source, sourceHead, fixture, testPath: "extensions/litellm/worker-contract.test.ts", env: {
        CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead, CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases),
      } });
    } catch (error) { failures.push(error); }
    // A failed SDK suite never becomes a pass because its Worker retired.
    // Join every row independently and preserve all body/cleanup failures.
    for (const row of cases) {
      try {
        const proof = await f.control("retire", row.id); assert.equal(proof.retired, true); assert.equal(proof.unlocked, true);
        const state = await f.state(row.id); assert.equal(state.active, 0); assert.equal(state.expired, 0);
        const denied = ["missing", "invalid_owner", "foreign"].includes(row.mode);
        const post = row.action === "stream" || row.action === "streamSimple" || ["eof", "partial_abort", "provider_error"].includes(row.control) || row.id === "sdk_auth_inference";
        const gets = row.id === "sdk_auth_inference" || denied ? 0 : row.expectedGets ?? 1;
        assert.equal(state.calls.length, gets + Number(post)); assert.equal(proof.calls.length, state.calls.length);
        assert.equal(state.calls.filter(call => call.method === "POST").length, Number(post));
        for (const call of state.calls) {
          assert.equal(call.authorization, "Bearer fixture-upstream-" + row.id);
          assert.equal(call.url, "https://gateway.example/team/v1/" + (call.method === "GET" ? "models" : "chat/completions"));
          if (call.method === "POST") { assert.equal(call.body.model, selected); assert.equal(call.body.stream, true); }
          else assert.equal(call.body, null);
        }
        if (row.control === "partial_abort") { assert.equal(state.canceled, 1); assert.ok(state.aborted >= 1); }
        const usage = await f.control("usage", row.id);
        const inference = usage.events.filter(event => event.reserved_cost_micros === 7);
        assert.equal(inference.length, Number(post));
        for (const event of usage.events) {
          assert.equal(event.credential_id, row.id); assert.equal(event.policy_id, row.id); assert.equal(event.provider, "litellm");
          if (event.reserved_cost_micros === 0) { assert.equal(event.actual_cost_micros, 0); continue; }
          assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
          if (row.mode === "measured") { assert.equal(event.input_tokens, 4); assert.equal(event.output_tokens, 3); }
          else { assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); }
          if (row.control === "partial_abort") assert.equal(event.status, "client_error");
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "LiteLLM SDK, Worker or SQLite proof failed");
  });
});
