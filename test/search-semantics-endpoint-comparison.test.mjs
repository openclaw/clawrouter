import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { startLocalSearchFixture } from "../scripts/search-semantics-local-fixture.mjs";
import { startFunnelExperiment, hostname, target } from "../scripts/search-semantics-funnel.mjs";
import { startEndpointComparison, comparisonOutcome } from "../scripts/search-semantics-endpoint-comparison.mjs";

const originFetch = globalThis.fetch;
const markerFrom = text => text.match(/ClawRouterFunnel[a-f0-9]{48}/)?.[0];
const responseValue = marker => ({ status: "completed", output: [
  { type: "web_search_call", status: "completed", action: { type: "open_page", url: `https://${hostname}/` } },
  { type: "message", content: [{ type: "output_text", text: marker ?? "Internal Error" }] },
], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });

async function harness(t, { scenario = "both", responseFailure, settle = async () => {}, signal } = {}) {
  let config = {}, keyReads = 0, fixture, localUrl;
  const calls = [], markers = [], child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; config = {}; child.emit("exit"); return true; };
  const startExperiment = options => startFunnelExperiment({ ...options,
    run: async (file, args) => ({ stdout: JSON.stringify(args[0] === "status" ? { BackendState: "Running", CurrentTailnet: { MagicDNSEnabled: true }, Self: { DNSName: `${hostname}.`, Capabilities: ["funnel", "https"] }, CertDomains: [hostname] } : config) }),
    launch: () => { config = { Foreground: { fixture: { TCP: { "443": { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [`${hostname}:443`]: true } } } }; return child; },
    startFixture: async options => { assert.equal(options.maxMeasurements, 2); fixture = await startLocalSearchFixture({ ...options, port: 0 }); localUrl = `http://127.0.0.1:${fixture.port}/`; return fixture; },
  });
  t.mock.method(globalThis, "fetch", async (address, init) => {
    const endpoint = address === "https://api.openai.com/v1/responses" ? "responses" : "alpha";
    assert.ok(address === "https://api.openai.com/v1/responses" || address === "https://api.openai.com/v1/alpha/search");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-only-key");
    assert.equal(fixture.snapshot().generation, endpoint === "responses" ? 1 : 2);
    assert.equal(fixture.snapshot().counts.rootGet, 0, "each endpoint starts with reset counters");
    calls.push({ endpoint, body: JSON.parse(init.body) });
    if (endpoint === "responses" && responseFailure) return responseFailure();
    const successful = endpoint === "responses" ? ["both", "responses-only"].includes(scenario) : ["both", "alpha-only"].includes(scenario);
    let marker;
    if (successful || endpoint === "alpha" && scenario === "responses-only") {
      marker = markerFrom(await (await originFetch(localUrl)).text());
      markers.push(marker);
      assert.ok(!init.body.includes(marker));
    }
    if (endpoint === "responses") return Response.json(responseValue(marker), { headers: { "x-request-id": "req_responses_fixture" } });
    return Response.json({ output: successful ? marker : scenario === "responses-only" ? markers[0] : "Internal Error", encrypted_output: "fixture-private-ciphertext" }, { headers: { "x-request-id": "req_alpha_fixture" } });
  });
  const experiment = await startEndpointComparison({ approved: true, startExperiment, readKey: async () => { keyReads++; return "fixture-only-key"; }, settle, signal });
  t.after(() => experiment.stop());
  const calibration = markerFrom(await (await originFetch(localUrl)).text());
  experiment.confirmWitness(calibration); experiment.arm();
  return { experiment, calls, markers, get keyReads() { return keyReads; }, fixture, child, localUrl };
}

test("actual helpers compare independent generations, reuse one key, cap requests and always clean up", async t => {
  const h = await harness(t);
  assert.equal(h.keyReads, 0); assert.equal(h.calls.length, 0);
  await assert.rejects(h.experiment.measure(), /separate approval/);
  assert.equal(h.keyReads, 0);
  const result = await h.experiment.measure({ approved: true });
  assert.equal(result.outcome, "both-observed"); assert.equal(result.stopReason, "complete");
  assert.equal(h.keyReads, 1); assert.deepEqual(h.calls.map(call => call.endpoint), ["responses", "alpha"]);
  assert.notEqual(h.markers[0], h.markers[1]);
  assert.equal(h.calls[0].body.model, h.calls[1].body.model);
  assert.equal(h.calls[0].body.tools[0].external_web_access, h.calls[1].body.settings.external_web_access);
  assert.ok(h.calls[0].body.input.includes(h.calls[1].body.commands.open[0].ref_id));
  assert.equal(h.calls[0].body.max_tool_calls, 3); assert.equal(h.calls[0].body.max_output_tokens, 2048);
  assert.deepEqual(result.rows.map(row => row.late.counts.rootGet), [1, 1]);
  assert.deepEqual(result.rows.map(row => row.late.generation), [1, 2]);
  assert.deepEqual(result.cleanup, { fixtureClosed: true, funnelEmpty: true, serveEmpty: true });
  assert.equal(h.fixture.snapshot().phase, "closed"); assert.equal(h.child.signalCode, "SIGTERM");
  for (const marker of h.markers) assert.ok(!JSON.stringify(result).includes(marker));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|fixture-only-key/);
  await assert.rejects(h.experiment.measure({ approved: true }), /one comparison/);
  assert.equal(h.calls.length, 2);
});

test("comparison distinguishes endpoint evidence and rejects the previous generation's marker", async t => {
  for (const scenario of ["responses-only", "alpha-only", "neither"]) await t.test(scenario, async t => {
    const h = await harness(t, { scenario });
    const result = await h.experiment.measure({ approved: true });
    assert.equal(result.outcome, `${scenario}-observed`);
    assert.equal(result.rows.length, 2); assert.equal(h.keyReads, 1);
    if (scenario === "responses-only") {
      assert.equal(result.rows[1].late.counts.rootGet, 1);
      assert.equal(result.rows[1].summary.markerReturned, false);
      assert.notEqual(h.markers[0], h.markers[1]);
    }
  });
});

test("invalid Responses control stops before alpha with no fallback or retry", async t => {
  for (const responseFailure of [
    () => Response.json({ error: { message: "fixture-private-error" } }, { status: 401 }),
    () => new Response("fixture-private-malformed"),
    () => Response.json({ status: "completed", output: [] }),
    () => Response.json({ ...responseValue(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    () => { throw new Error("fixture-private-transport"); },
  ]) await t.test("unavailable control", async t => {
    const h = await harness(t, { responseFailure });
    const result = await h.experiment.measure({ approved: true });
    assert.equal(result.outcome, "incomplete"); assert.equal(result.stopReason, "responses-control-unavailable");
    assert.equal(h.calls.length, 1); assert.equal(result.rows.length, 1);
    assert.equal(result.cleanup.fixtureClosed, true); assert.equal(result.cleanup.funnelEmpty, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  });
});

test("insufficient time and pre-dispatch contamination cannot send provider traffic", async t => {
  await t.test("insufficient lifetime", async t => {
    const h = await harness(t);
    t.mock.method(Date, "now", () => Date.parse(h.experiment.expiresAt) - 249_000);
    const result = await h.experiment.measure({ approved: true });
    assert.equal(result.outcome, "incomplete"); assert.equal(h.calls.length, 0); assert.equal(h.keyReads, 0);
    assert.equal(result.cleanup.fixtureClosed, true);
  });
  await t.test("contamination", async t => {
    const h = await harness(t); await originFetch(h.localUrl);
    const result = await h.experiment.measure({ approved: true });
    assert.equal(result.outcome, "incomplete"); assert.equal(h.calls.length, 0);
    assert.equal(result.cleanup.fixtureClosed, true);
  });
});

test("cancellation during the first observation window prevents the second endpoint call", async t => {
  const controller = new AbortController();
  const h = await harness(t, { signal: controller.signal, settle: async () => controller.abort() });
  const result = await h.experiment.measure({ approved: true });
  assert.equal(h.calls.length, 1); assert.equal(result.rows.length, 1);
  assert.equal(result.outcome, "incomplete"); assert.equal(result.rows[0].freshRetrieval, false);
  assert.equal(result.cleanup.fixtureClosed, true); assert.equal(result.cleanup.funnelEmpty, true);
});

test("classification never promotes a partial pair into endpoint comparison evidence", () => {
  assert.equal(comparisonOutcome([]), "incomplete");
  assert.equal(comparisonOutcome([{ freshRetrieval: true }]), "incomplete");
});

test("fixture permits exactly two complete generations only when explicitly configured", async t => {
  await assert.rejects(startLocalSearchFixture({ port: 0, maxMeasurements: 3 }), /one two-endpoint/);
  const fixture = await startLocalSearchFixture({ port: 0, maxMeasurements: 2 });
  t.after(() => fixture.close());
  const url = `http://127.0.0.1:${fixture.port}/`;
  fixture.confirmWitness(markerFrom(await (await originFetch(url)).text()));
  for (const generation of [1, 2]) {
    assert.equal(fixture.arm().generation, generation);
    await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, probe: async () => ({ summary: { status: 200, markerReturned: false } }), settle: async () => {} });
  }
  assert.throws(() => fixture.arm(), /measurement limit/);
});
