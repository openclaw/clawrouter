import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { startLocalSearchFixture } from "../scripts/search-semantics-local-fixture.mjs";
import { hostname, target, ownedFunnel, startFunnelExperiment, loadProbeKey } from "../scripts/search-semantics-funnel.mjs";

const markerFrom = text => text.match(/ClawRouterFunnel[a-f0-9]{48}/)?.[0];
const mapping = () => ({ Foreground: { "fixture-session": { TCP: { "443": { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [`${hostname}:443`]: true } } } });
const summary = { status: 200, markerReturned: true, internalError: false, referenceError: false, fetchError: false };
const noWait = async () => {};
const connectedNode = { BackendState: "Running", CurrentTailnet: { MagicDNSEnabled: true }, Self: { DNSName: `${hostname}.`, Capabilities: ["funnel", "https"] }, CertDomains: [hostname] };
async function armed(t) {
  const fixture = await startLocalSearchFixture({ port: 0 });
  t.after(() => fixture.close());
  const url = `http://127.0.0.1:${fixture.port}/`;
  fixture.confirmWitness(markerFrom(await (await fetch(url)).text()));
  fixture.arm();
  return { fixture, url };
}

test("loopback fixture has no HTTP controls, exact routes, fresh rotation and private counters", async t => {
  const fixture = await startLocalSearchFixture({ port: 0 });
  t.after(() => fixture.close());
  const url = `http://127.0.0.1:${fixture.port}/`;
  assert.throws(() => fixture.arm());
  const initial = await fetch(url), oldMarker = markerFrom(await initial.text());
  assert.equal(initial.headers.get("cache-control"), "no-store, max-age=0");
  assert.ok(oldMarker);
  assert.throws(() => fixture.confirmWitness("incorrect"));
  fixture.confirmWitness(oldMarker);
  assert.equal(fixture.arm().counts.rootGet, 0);
  const newMarker = markerFrom(await (await fetch(url)).text());
  assert.notEqual(newMarker, oldMarker);
  assert.equal(await (await fetch(url, { method: "HEAD" })).text(), "");
  for (const path of ["control", "reset", "?marker=ignored", "robots.txt?x=1"]) assert.equal((await fetch(`${url}${path}`)).status, 404);
  assert.equal((await fetch(url, { method: "POST", body: "ignored" })).status, 404);
  assert.match(await (await fetch(`${url}robots.txt`)).text(), /Allow: \//);
  assert.deepEqual(fixture.snapshot().counts, { rootGet: 1, rootHead: 1, robots: 1, rejected: 5, overflow: false });
  assert.doesNotMatch(JSON.stringify(fixture.snapshot()), new RegExp(`${oldMarker}|${newMarker}|ignored`));
  assert.throws(() => fixture.arm(), /outside-tailnet/);
  await assert.rejects(fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, probe: () => assert.fail("must not dispatch") }), /uncontaminated/);
});

test("fresh retrieval needs both marker and origin GET, marker never enters request or receipt, one attempt only", async t => {
  const { fixture, url } = await armed(t);
  let seenMarker;
  const result = await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, settle: noWait, probe: async args => {
    seenMarker = markerFrom(await (await fetch(url)).text());
    assert.equal(args.marker, seenMarker);
    assert.ok(!JSON.stringify(args.body).includes(seenMarker));
    assert.deepEqual(args.body.commands, { open: [{ ref_id: `https://${hostname}/` }], response_length: "short" });
    assert.equal(args.body.settings.external_web_access, true);
    return { summary, value: { output: seenMarker, encrypted_output: "fixture-private-ciphertext" } };
  } });
  assert.equal(result.freshRetrieval, true);
  assert.equal(result.immediate.counts.rootGet, 1);
  assert.ok(result.late.firstGet >= result.dispatchedAt);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${seenMarker}|fixture-private|fixture-only-key`));
  await assert.rejects(fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/` }), /one search/);
});

test("actual direct-search helper and local fixture compose without a live provider call", async t => {
  const { fixture, url } = await armed(t);
  const originFetch = globalThis.fetch;
  let requests = 0, measuredMarker;
  t.mock.method(globalThis, "fetch", async (address, init) => {
    requests++;
    assert.equal(address, "https://api.openai.com/v1/alpha/search");
    assert.equal(init.headers.get("authorization"), "Bearer fixture-only-key");
    measuredMarker = markerFrom(await (await originFetch(url)).text());
    assert.ok(!init.body.includes(measuredMarker));
    return Response.json({ output: `Retrieved current marker ${measuredMarker}`, encrypted_output: "fixture-private-ciphertext" }, { headers: { "x-request-id": "req_fixture" } });
  });
  const result = await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, settle: noWait });
  assert.equal(requests, 1);
  assert.equal(result.freshRetrieval, true);
  assert.equal(result.summary.requestId, "req_fixture");
  assert.equal(result.summary.hasUsage, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${measuredMarker}|fixture-private|fixture-only-key`));
});

test("missing GET, missing marker, HTTP-200 tool errors and transport failure cannot qualify", async t => {
  for (const scenario of ["missing-get", "missing-marker", "internal-error", "transport-error"]) {
    await t.test(scenario, async t => {
      const { fixture, url } = await armed(t);
      const result = await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, settle: noWait, probe: async () => {
        if (scenario !== "missing-get") await fetch(url);
        if (scenario === "transport-error") throw new Error("private upstream detail");
        return { summary: { ...summary, markerReturned: scenario !== "missing-marker", internalError: scenario === "internal-error" } };
      } });
      assert.equal(result.freshRetrieval, false);
      assert.doesNotMatch(JSON.stringify(result), /private upstream/);
    });
  }
});

test("measurement accepts a late GET", async t => {
  const { fixture, url } = await armed(t);
  const result = await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, probe: async () => ({ summary }), settle: async () => { await fetch(url); } });
  assert.equal(result.immediate.counts.rootGet, 0);
  assert.equal(result.late.counts.rootGet, 1);
  assert.equal(result.freshRetrieval, true);
});

test("closing during measurement prevents qualification and close is idempotent", async t => {
  const { fixture, url } = await armed(t);
  const result = await fixture.measure({ key: "fixture-only-key", url: `https://${hostname}/`, probe: async () => { await fetch(url); return { summary }; }, settle: () => fixture.close() });
  assert.equal(result.freshRetrieval, false);
  assert.equal(fixture.snapshot().phase, "closed");
  await fixture.close();
});

function fakeOperator({ remainingAfterExit = false, replaceSession = false, serve = {} } = {}) {
  let config = {}, fixtureClosed = false, keyReads = 0, measureCalls = 0;
  const calls = [], child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; if (!remainingAfterExit) config = {}; if (replaceSession) config = { Foreground: { other: Object.values(mapping().Foreground)[0] } }; child.emit("exit"); return true; };
  const fixture = { close: async () => { fixtureClosed = true; }, snapshot: () => ({ phase: "armed" }), confirmWitness: value => value, arm: () => ({}), measure: async args => { assert.equal(args.key, "fixture-only-key"); measureCalls++; return { freshRetrieval: false }; } };
  return {
    calls, child, get fixtureClosed() { return fixtureClosed; }, get keyReads() { return keyReads; }, get measureCalls() { return measureCalls; },
    options: { approved: true, startFixture: async () => fixture, readKey: async () => { keyReads++; return "fixture-only-key"; },
      launch: (file, args, options) => { calls.push({ file, args, options }); config = mapping(); return child; },
      run: async (file, args) => { calls.push({ file, args }); if (args.at(-1) === "off") config = {}; return { stdout: JSON.stringify(args[0] === "status" ? connectedNode : args[0] === "serve" ? serve : config) }; },
    },
  };
}

test("exposure and paid gates are separate, foreground only, cleanup is idempotent and verified", async () => {
  const fake = fakeOperator();
  await assert.rejects(startFunnelExperiment({ ...fake.options, approved: false }), /authorization/);
  assert.equal(fake.calls.length, 0);
  const experiment = await startFunnelExperiment(fake.options);
  assert.ok(fake.calls.some(call => JSON.stringify(call.args) === JSON.stringify(["funnel", "--https=443", target]) && call.options.stdio.every(value => value === "ignore")));
  assert.equal(fake.keyReads, 0);
  await assert.rejects(experiment.measure(), /separate/);
  assert.equal(fake.keyReads, 0);
  await experiment.measure({ approved: true });
  assert.equal(fake.measureCalls, 1);
  assert.deepEqual(await experiment.stop(), { fixtureClosed: true, funnelEmpty: true, serveEmpty: true });
  const count = fake.calls.length;
  await experiment.stop();
  assert.equal(fake.calls.length, count);
  assert.equal(fake.fixtureClosed, true);
  assert.ok(!fake.calls.some(call => call.args.includes("reset") || call.args.includes("--bg")));
});

test("stale foreground or replaced configuration is reported without configuration writes", async () => {
  for (const replaceSession of [false, true]) {
    const fake = fakeOperator({ remainingAfterExit: true, replaceSession });
    const experiment = await startFunnelExperiment(fake.options);
    const result = await experiment.stop();
    assert.equal(fake.calls.some(call => call.args.at(-1) === "off"), false);
    assert.equal(result.funnelEmpty, false);
  }
});

test("nonempty preflight, failed launch, and unexpected Serve cleanup are reported safely", async () => {
  const fake = fakeOperator();
  await assert.rejects(startFunnelExperiment({ ...fake.options, run: async (file, args) => ({ stdout: JSON.stringify(args[0] === "status" ? connectedNode : mapping()) }) }), /must be empty/);
  assert.equal(fake.calls.length, 0);
  await assert.rejects(startFunnelExperiment({ ...fake.options, launch: () => { throw new Error("fixture startup error"); } }), /startup failed/);
  assert.equal(fake.fixtureClosed, true);
  const remaining = fakeOperator({ serve: { unrelated: true } });
  assert.equal((await (await startFunnelExperiment(remaining.options)).stop()).serveEmpty, false);
});

test("disconnected or different node fails before fixture startup or mutation", async () => {
  for (const status of [{ ...connectedNode, BackendState: "NeedsLogin" }, { ...connectedNode, Self: { ...connectedNode.Self, DNSName: "other.ts.net." } }, { ...connectedNode, CertDomains: [] }]) {
    const fake = fakeOperator();
    let fixtureStarted = false;
    await assert.rejects(startFunnelExperiment({ ...fake.options, startFixture: async () => { fixtureStarted = true; }, run: async () => ({ stdout: JSON.stringify(status) }) }));
    assert.equal(fixtureStarted, false);
    assert.equal(fake.calls.length, 0);
  }
});

test("cancellation during read-only preflight prevents fixture acquisition and child launch", async () => {
  const controller = new AbortController(), fake = fakeOperator();
  const run = fake.options.run;
  let started = false;
  await assert.rejects(startFunnelExperiment({ ...fake.options, signal: controller.signal,
    startFixture: async () => { started = true; },
    run: async (...args) => { controller.abort(); return run(...args); },
  }), { name: "AbortError" });
  assert.equal(started, false);
  assert.equal(fake.calls.some(call => call.args.includes(target)), false);
});

test("cancellation while fixture is acquired closes it before launching Funnel", async () => {
  const controller = new AbortController(), fake = fakeOperator();
  const startFixture = fake.options.startFixture;
  await assert.rejects(startFunnelExperiment({ ...fake.options, signal: controller.signal,
    startFixture: async () => { const fixture = await startFixture(); controller.abort(); return fixture; },
  }), /startup failed/);
  assert.equal(fake.fixtureClosed, true);
  assert.equal(fake.calls.some(call => call.args.includes(target)), false);
});

test("termination during foreground readiness closes fixture and terminates the owned child", async () => {
  const controller = new AbortController(), fake = fakeOperator();
  const run = fake.options.run;
  let started = false;
  await assert.rejects(startFunnelExperiment({ ...fake.options, signal: controller.signal,
    launch: (...args) => { started = true; return fake.options.launch(...args); },
    run: async (...args) => { if (started) controller.abort(); return run(...args); },
  }), /startup failed/);
  assert.equal(fake.fixtureClosed, true);
  assert.equal(fake.child.signalCode, "SIGTERM");
  assert.equal(fake.calls.at(-1).args[0], "serve");
  assert.equal(fake.keyReads, 0);
});

test("deadline and child exit independently trigger automatic cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fake = fakeOperator();
  const experiment = await startFunnelExperiment({ ...fake.options, ttlMs: 120_000 });
  t.mock.timers.tick(120_001);
  assert.equal((await experiment.cleaned).funnelEmpty, true);
  await assert.rejects(experiment.measure({ approved: true }), /insufficient/);
  assert.equal(fake.keyReads, 0);
  const exited = fakeOperator();
  const second = await startFunnelExperiment(exited.options);
  exited.child.emit("exit");
  assert.equal((await second.cleaned).fixtureClosed, true);
});

test("Funnel ownership rejects background, additional mappings, and arbitrary handlers", () => {
  assert.equal(ownedFunnel(mapping()), true);
  for (const change of [value => { value.TCP = {}; }, value => { value.Foreground.other = {}; }, value => { value.Foreground["fixture-session"].Web[`${hostname}:443`].Handlers["/"].Path = "/private"; }]) {
    const value = mapping(); change(value); assert.equal(ownedFunnel(value), false);
  }
  assert.equal(ownedFunnel({}), false);
});

test("key access uses canonical reference only after metadata checks; instructions and ambiguity fail closed", async () => {
  for (const metadata of ["field=ACCESS_INSTRUCTIONS type=STRING state=set\nfield=OPENAI_API_KEY type=CONCEALED state=set", "field=OPENAI_API_KEY type=CONCEALED state=empty", "field=OPENAI_API_KEY type=CONCEALED state=set\nfield=OPENAI_API_KEY type=CONCEALED state=set"]) {
    const calls = [];
    await assert.rejects(loadProbeKey(async (file, args) => { calls.push({ file, args }); return { stdout: metadata }; }));
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const result = await loadProbeKey(async (file, args) => { calls.push({ file, args }); return { stdout: calls.length === 1 ? "field=OPENAI_API_KEY type=CONCEALED state=set" : "fixture-only-key\n" }; });
  assert.equal(result, "fixture-only-key");
  assert.deepEqual(calls[1].args, ["read", "op://Agent Secrets/OpenAI/OPENAI_API_KEY"]);
});

test("an occupied fixture port is refused without disturbing its owner", async t => {
  const owner = createServer();
  await new Promise(resolve => owner.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => owner.close(resolve)));
  await assert.rejects(startLocalSearchFixture({ port: owner.address().port }), { code: "EADDRINUSE" });
  assert.equal(owner.listening, true);
});
