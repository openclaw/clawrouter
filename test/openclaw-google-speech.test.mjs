import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { execFile } from "node:child_process";
import { types as nodeTypes, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "ff34cf8e236ca698c7190c63087f2ecd37f94a7e";
const models = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const success = [...models.map((_, i) => `model${i}`), "talk", "unknown", "key_a", "key_b"];
const invalid = ["later", "truncated", "non200", "redirect", "encoding"];
const held = ["abort_headers", "abort_body", "deadline"];
const denied = ["grant", "foreign", "policy", "revoked", "stale_policy", "budget", "key", "voice", "alias", "cutoff0", "cutoff1", "cutoff2"];
const scenarios = [...success, ...invalid, ...held, ...denied];
const modelFor = name => /^model\d$/.test(name) ? models[Number(name.slice(5))] : /^cutoff\d$/.test(name) ? models[Number(name.slice(6))] : models[3];
const text = "Synthetic speech 😀 café";

// The SDK and outer process use this exact closed protocol, not parallel validators.
const sdkText = readFileSync(new URL("./fixtures/openclaw-google-speech-contract.test.ts", import.meta.url), "utf8");
const protocolStart = sdkText.indexOf("// BEGIN google diagnostic protocol."), protocolEnd = sdkText.indexOf("// END google diagnostic protocol.");
assert.ok(protocolStart >= 0 && protocolEnd > protocolStart);
const protocolSource = stripTypeScriptTypes(sdkText.slice(protocolStart, protocolEnd));
const protocol = new Function(protocolSource + "; return googleDiagnosticProtocol;")()(nodeTypes.isProxy);
assert.equal(protocol.pin, sourceHead);
assert.deepEqual([...protocol.ids], scenarios);

function diagnosticSession(write = line => process.stdout.write(line)) {
  const emitter = protocol.emitter(write), failures = [];
  let records = 0, invalid = 0, inputBytes = 0, finished = false;
  function protect(run) { try { run(); } catch (error) { failures.push(error); } }
  function mark(phase, caseId, role, outcome, failed = false, error, fields = {}, route = "none") {
    protect(() => emitter.put(protocol.record({ source: "outer", caseId, route, phase, role, outcome, ...fields }, failed, error)));
  }
  function parse(text) {
    if (typeof text === "string") inputBytes += Buffer.byteLength(text);
    if (inputBytes > 4 * 1024 * 1024) { invalid++; return; }
    const result = protocol.parse(text, row => { if (records >= 512) { invalid++; return; } emitter.put(row); records++; });
    invalid += result.invalid;
  }
  function received(error) {
    const own = key => protocol.own(error, key);
    const code = own("code"), signal = own("signal"), killed = own("killed");
    mark("helper", null, "primary", "rejected", true, error, {
      exitCode: Number.isSafeInteger(code) && code >= 0 && code <= 65535 ? code : null,
      signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT"].includes(signal) ? signal : null,
      killed: typeof killed === "boolean" ? killed : null,
      moduleCode: ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION"].includes(code) ? code : null,
    });
    const pending = [{ value: error, role: "primary" }], seen = new Set(); let nodes = 0;
    while (pending.length) {
      if (++nodes > 32) { invalid++; break; }
      const { value, role } = pending.pop();
      // Never inspect a proxy, getter, prototype error field, message, stack or cause.
      if (value === undefined) mark("report", null, role, "rejected", true, undefined);
      if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !nodeTypes.isNativeError(value) || seen.has(value)) continue;
      seen.add(value);
      for (const key of ["stdout", "stderr"]) parse(protocol.own(value, key));
      const children = protocol.own(value, "errors");
      if (!children || nodeTypes.isProxy(children) || !Array.isArray(children)) continue;
      const length = protocol.own(children, "length");
      if (!Number.isSafeInteger(length) || length < 0 || length > 32) { invalid++; continue; }
      for (let i = length - 1; i >= 0; i--) {
        const entry = Object.getOwnPropertyDescriptor(children, String(i));
        if (!entry || !("value" in entry)) { invalid++; continue; }
        if (pending.length >= 32) { invalid++; break; }
        pending.push({ value: entry.value, role: i === 0 ? role : "cleanup" });
      }
    }
  }
  function report() {
    mark("report", null, "summary", invalid ? "rejected" : records ? "fulfilled" : "unknown", invalid > 0, undefined,
      { records, invalid: Math.min(65535, invalid) });
  }
  return {
    mark,
    diagnostic(text) { protect(() => parse(text)); }, // The helper's successful stdout, never forwarded raw.
    rejected(error) { protect(() => received(error)); report(); protect(() => emitter.checkpoint()); },
    checkpoint() { protect(() => emitter.checkpoint()); },
    finish() {
      if (finished) return []; finished = true;
      if (invalid) failures.push(new Error("invalid fresh Google diagnostics"));
      report();
      if (failures.length) mark("report", null, "primary", "rejected", true, failures[0]);
      protect(() => emitter.flush()); return failures;
    },
  };
}

const diagnosticContext = (changes = {}) => ({ source: "sdk", caseId: "abort_headers", route: "manifest", phase: "body", role: "primary", outcome: "rejected", ...changes });
test("Google diagnostic validator rejects unknown fields, getters, proxies and foreign pins", () => {
  const row = protocol.record(diagnosticContext(), true, undefined);
  assert.equal(row.failurePresent, true); assert.equal(row.reasonDefined, false); assert.equal(row.partialDelivery, null);
  let touched = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack", "stdout", "stderr", "errors"].map(key => [key, { get() { touched++; throw undefined; } }])));
  const proxy = new Proxy({}, { ownKeys() { touched++; throw undefined; }, getPrototypeOf() { touched++; throw undefined; }, getOwnPropertyDescriptor() { touched++; throw undefined; } });
  for (const object of [hostile, proxy]) {
    assert.equal(protocol.own(object, "stdout"), undefined);
    assert.equal(protocol.validate(object), undefined);
    assert.equal(protocol.record(diagnosticContext(), true, object).reasonType, "object");
  }
  for (const changed of [{ pin: "wrong" }, { caseId: "not_a_google_case" }, { route: "url" }, { phase: "foreign" }, { source: "worker" },
    { message: "private" }, { partialDelivery: true }, { closed: true }, { reads: -1 }, { records: 65536 }, { killed: 1 },
    { signal: "foreign" }, { moduleCode: "foreign" }, { reasonDefined: true }, { outcome: "fulfilled" }]) {
    assert.equal(protocol.validate({ ...row, ...changed }), undefined);
  }
  assert.equal(protocol.validate(Object.defineProperty({ ...row }, "phase", { get() { touched++; throw undefined; } })), undefined);
  assert.equal(touched, 0);
  assert.ok(protocol.validate(protocol.record({ ...diagnosticContext(), reads: 65535, closed: null, callerAborted: false }, true, undefined)));
});

test("Google child parser accepts only exact fresh typed records, with bounded input", () => {
  const row = protocol.record(diagnosticContext(), true, undefined), accepted = [], line = protocol.prefix + JSON.stringify(row);
  assert.deepEqual(protocol.parse("unrelated prose\n# " + line + "\n" + line + "\n", value => accepted.push(value)), { records: 1, invalid: 0 });
  assert.deepEqual(accepted, [row]);
  for (const text of ["{", JSON.stringify({ ...row, pin: "wrong" }), JSON.stringify({ ...row, source: "outer" }), "x".repeat(641)]) {
    assert.equal(protocol.parse(protocol.prefix + text, () => assert.fail()).invalid, 1);
  }
  assert.equal(protocol.parse("x".repeat(2 * 1024 * 1024 + 1), () => assert.fail()).invalid, 1);
  assert.deepEqual(protocol.parse((line + "\n").repeat(513), () => {}), { records: 512, invalid: 1 });
});

test("Google own-DATA helper adapter preserves cycles, undefined and independent cleanup", () => {
  const lines = [], session = diagnosticSession(line => lines.push(line));
  const row = protocol.record(diagnosticContext(), true, undefined);
  const child = Object.assign(new Error("synthetic"), { stdout: protocol.prefix + JSON.stringify(row) + "\n", stderr: "unrelated", code: 1, killed: false });
  let touched = 0;
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(child, key, { get() { touched++; throw undefined; } });
  const errors = [child, undefined], aggregate = new AggregateError(errors, "synthetic");
  aggregate.errors.push(aggregate, child);
  session.rejected(aggregate);
  session.mark("worker_dispose", null, "cleanup", "rejected", true, undefined);
  assert.deepEqual(session.finish(), []);
  const rows = lines.map(line => JSON.parse(line.split("::").at(-1)));
  assert.ok(rows.some(value => value.source === "sdk" && value.reasonDefined === false));
  assert.ok(rows.some(value => value.phase === "worker_dispose" && value.reasonDefined === false));
  assert.ok(rows.some(value => value.phase === "report" && value.role === "cleanup" && value.reasonDefined === false));
  assert.equal(touched, 0); assert.equal(aggregate.errors[1], undefined); assert.equal(aggregate.errors[0], child);
});

test("Google primary and original cleanup are visible before outer teardown can stall", () => {
  const lines = [], session = diagnosticSession(line => lines.push(line));
  const primary = protocol.record(diagnosticContext(), true, undefined);
  const cleanup = protocol.record(diagnosticContext({ phase: "original_join", role: "cleanup" }), true, null);
  const child = Object.assign(new Error("synthetic"), { stdout: [primary, cleanup].map(row => protocol.prefix + JSON.stringify(row)).join("\n") });
  session.rejected(child); // No finish: a later original cleanup may be pending.
  const rows = lines.map(line => JSON.parse(line.split("::").at(-1)));
  assert.equal(rows.length, 3);
  assert.ok(rows.some(row => row.phase === "helper"));
  assert.ok(rows.some(row => row.source === "sdk" && row.role === "primary" && row.reasonDefined === false));
  assert.ok(rows.some(row => row.source === "sdk" && row.role === "cleanup" && row.reasonType === "null"));
  assert.deepEqual(session.finish(), []);
});

test("Google malformed fresh diagnostics fail independently without replacing original errors", () => {
  const lines = [], session = diagnosticSession(line => lines.push(line));
  session.diagnostic(protocol.prefix + '{"pin":"foreign"}');
  session.mark("helper", null, "progress", "fulfilled");
  assert.equal(session.finish().length, 1);
  assert.ok(lines.some(line => JSON.parse(line.split("::").at(-1)).invalid === 1));
});

test("Google helper zero records stays unknown; accessors and proxies are never read", () => {
  let touched = 0;
  const child = new Error("synthetic");
  for (const key of ["stdout", "stderr", "errors", "code", "signal", "killed"]) Object.defineProperty(child, key, { get() { touched++; throw undefined; } });
  const lines = [], session = diagnosticSession(line => lines.push(line));
  session.rejected(child); assert.deepEqual(session.finish(), []);
  assert.ok(lines.some(line => { const value = JSON.parse(line.split("::").at(-1)); return value.phase === "report" && value.records === 0 && value.outcome === "unknown"; }));
  const proxied = diagnosticSession(() => {});
  proxied.rejected(new Proxy(child, { getOwnPropertyDescriptor() { touched++; throw undefined; } }));
  assert.deepEqual(proxied.finish(), []); assert.equal(touched, 0);
});

test("Google successful diagnostics and expected read rejection never emit errors", () => {
  const lines = [], session = diagnosticSession(line => lines.push(line));
  session.diagnostic(protocol.prefix + JSON.stringify(protocol.record(diagnosticContext({ phase: "acquisition", role: "progress" }), true, new Error("synthetic"))) + "\n");
  session.mark("helper", null, "progress", "fulfilled");
  assert.deepEqual(session.finish(), []); assert.deepEqual(lines, []);
});

test("Google annotations share nine essential slots plus overflow, route-aware dedup and exact byte caps", () => {
  const lines = [], emitter = protocol.emitter(line => lines.push(line));
  const first = protocol.record(diagnosticContext(), true, undefined);
  emitter.put(first); emitter.put(first); emitter.checkpoint(); emitter.checkpoint();
  emitter.put({ ...first, route: "native" });
  for (const caseId of scenarios) emitter.put(protocol.record(diagnosticContext({ caseId, phase: "original_join", role: "cleanup" }), true, undefined));
  emitter.flush(); const count = lines.length; emitter.flush(); emitter.checkpoint();
  assert.equal(lines.length, count); assert.equal(count, 10);
  assert.ok(lines.every(line => line.startsWith("::error ") && Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  const rows = lines.map(line => JSON.parse(line.split("::").at(-1)));
  assert.equal(rows.filter(row => row.caseId === "abort_headers" && row.phase === "body" && row.route === "manifest").length, 1);
  assert.ok(rows.some(row => row.caseId === "abort_headers" && row.phase === "body" && row.route === "native"));
  assert.equal(rows.at(-1).phase, "capacity"); assert.ok(rows.at(-1).suppressed > 0);
});

test("Google emitter writer failure cannot mask an original undefined failure or retry a command", () => {
  let writes = 0;
  const session = diagnosticSession(() => { writes++; throw undefined; });
  const originalFailures = [undefined];
  session.rejected(undefined);
  originalFailures.push(...session.finish());
  const atFinish = writes; session.finish(); assert.equal(writes, atFinish);
  assert.equal(originalFailures[0], undefined); assert.ok(originalFailures.length >= 2);
  const onlyUndefined = value => value === undefined || value instanceof AggregateError && value.errors.every(onlyUndefined);
  assert.ok(originalFailures.every(onlyUndefined));
});

test("Google observes only existing joined counters and keeps reader.closed unknown", () => {
  const value = protocol.record({ ...diagnosticContext({ phase: "original_join", role: "progress", outcome: "fulfilled" }),
    reads: 65535, readRejected: 65535, cancels: 65535, cancelRejected: 65535, readers: 65535, unlocks: 65535,
    externalCloses: 65535, closeRejected: 65535, releaseReturned: false, guardObserved: true, destroyed: false,
    effectiveAborted: true, closed: null });
  assert.ok(protocol.validate(value));
  const pending = protocol.record(diagnosticContext({ phase: "original_join", role: "progress", outcome: "entered" }));
  assert.equal(pending.outcome, "entered"); assert.equal(pending.closed, undefined);
});

test("Google synthetic reporter child", { skip: process.env.GOOGLE_DIAGNOSTIC_REPORTER_CHILD !== "1" }, () => {
  const emitter = protocol.emitter(line => process.stdout.write(line));
  emitter.put(protocol.record(diagnosticContext(), true, undefined)); emitter.checkpoint(); emitter.flush();
});

test("Google annotations reach column zero through the actual Node 24 default reporter", async () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = await promisify(execFile)(process.execPath,
    ["--test", "--test-name-pattern=^Google synthetic reporter child$", fileURLToPath(import.meta.url)],
    { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...env, GOOGLE_DIAGNOSTIC_REPORTER_CHILD: "1" } });
  assert.ok(result.stdout.split("\n").some(line => line.startsWith("::error title=Google contract diagnostic::")));
});

function compileCatalog() {
  // Same complete, sorted YAML -> compiler path as the 1098 variant helper.
  // Google already declares both real route kinds; no flag variant is needed.
  const dir = new URL("../providers/", import.meta.url);
  const manifests = readdirSync(dir).filter(path => path.endsWith(".provider.yaml")).sort().map(path => parse(readFileSync(new URL(path, dir), "utf8")));
  assert.equal(manifests.length, 87);
  assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
  const provider = snapshot.providers.find(row => row.id === "google-gemini");
  assert.deepEqual(provider.models.filter(row => row.capabilities.includes("audio.speech")).map(row => row.id), models.map(model => `google/${model}`));
  assert.equal(provider.endpoints.find(row => row.id === "speech_generate_content").native_proxy, true);
  assert.equal(provider.endpoints.find(row => row.id === "speech_interactions").native_proxy, false);
  for (const model of provider.models.filter(row => models.includes(row.upstream))) {
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  }
}

test("Google speech uses all 87 compiled manifests and only declared route kinds", compileCatalog);

test("Google speech fixture bundles the unchanged Worker and parses the client fixture", async () => {
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { build, transform } = require("esbuild");
  const bundle = await build({ stdin: { contents: routerFixture(), resolveDir: process.cwd(), loader: "ts" }, write: false,
    bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  assert.ok(bundle.outputFiles[0].text.length > 0);
  const upstream = await build({ stdin: { contents: upstreamFixture("http://127.0.0.1:1"), resolveDir: process.cwd(), loader: "js" }, write: false,
    bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  assert.ok(upstream.outputFiles[0].text.length > 0);
  await transform(readFileSync(new URL("./fixtures/openclaw-google-speech-contract.test.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function barriers() {
  const rows = new Map(held.map(name => [name, { seen: deferred(), closed: deferred(), response: undefined }]));
  const server = createServer(async (request, response) => {
    const match = /^\/(abort_headers|abort_body|deadline)\/(hold|seen|closed)$/.exec(request.url ?? "");
    if (!match || request.method !== "GET" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    const row = rows.get(match[1]);
    if (match[2] === "hold") {
      if (row.response) { response.writeHead(409); response.end(); return; }
      row.response = response; response.once("close", () => row.closed.resolve()); row.seen.resolve();
    } else { await row[match[2]].promise; response.end(match[2]); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const row of rows.values()) row.response?.end("teardown");
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test("published Google TTS and Talk client through real Worker catalog and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const diagnostics = diagnosticSession(), failures = []; let barrier, temporary, mf, phase = "compile", caseId = null;
  try {
    diagnostics.mark(phase, caseId, "progress", "entered");
    compileCatalog(); // Before Worker module evaluation, never patch the snapshot.
    phase = "barrier"; diagnostics.mark(phase, caseId, "progress", "entered");
    barrier = await barriers();
    diagnostics.mark(phase, caseId, "progress", "fulfilled");
    phase = "temporary"; diagnostics.mark(phase, caseId, "progress", "entered");
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-speech-"));
    diagnostics.mark(phase, caseId, "progress", "fulfilled");
    phase = "worker_start"; diagnostics.mark(phase, caseId, "progress", "entered");
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(barrier.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    diagnostics.mark(phase, caseId, "progress", "fulfilled");
    phase = "initialize"; diagnostics.mark(phase, caseId, "progress", "entered");
    const initialized = await fetch(origin + "/__google/init", { method: "POST" });
    assert.equal(initialized.status, 200, await initialized.text());
    diagnostics.mark(phase, caseId, "progress", "fulfilled");
    phase = "helper"; diagnostics.mark(phase, caseId, "progress", "entered");
    await runOpenClawConsumer({ diagnostic: text => diagnostics.diagnostic(text) }, { source, sourceHead, fixture: new URL("./fixtures/openclaw-google-speech-contract.test.ts", import.meta.url),
      testPath: "src/agents/tools/worker-clawrouter-google-speech.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CONTROL: barrier.origin, CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead } });
    diagnostics.mark(phase, caseId, "progress", "fulfilled");
    phase = "upstream"; diagnostics.mark(phase, caseId, "progress", "entered");
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.deepEqual(await (await fetch(origin + "/__google/audit")).json(), []);
    assert.equal(calls.length, success.length + invalid.length + held.length);
    for (const name of scenarios) {
      caseId = name; phase = "upstream"; diagnostics.mark(phase, caseId, "progress", "entered");
      const id = `gs_${name}`, paid = !denied.includes(name), model = modelFor(name), interactions = model.startsWith("gemini-3.8-");
      const selected = calls.filter(call => call.id === id);
      assert.equal(selected.length, paid ? 1 : 0, name);
      if (paid) {
        assert.deepEqual(selected[0].request, { method: "POST", selectedKey: true, noProxySecret: true,
          url: interactions ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          body: interactions ? { model, store: false, input: [{ type: "user_input", content: [{ type: "text", text }] }],
            generation_config: { speech_config: [{ voice: "Kore" }] }, response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 } }
            : { contents: [{ role: "user", parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } } });
        assert.equal(selected[0].finished, true, name);
      }
      diagnostics.mark(phase, caseId, "progress", "fulfilled");
      phase = "worker_retirement"; diagnostics.mark(phase, caseId, "progress", "entered");
      const joined = await (await fetch(`${origin}/__google/join/${id}`)).json();
      assert.equal(joined.calls, paid ? 1 : 0, name); assert.equal(joined.retired, true); assert.equal(joined.charged, 0);
      if (joined.hasBody) {
        assert.equal(joined.activeReads, 0); assert.equal(joined.unlocked, true);
        assert.equal(joined.sourceLocked, false); assert.equal(joined.physicalLocked, false);
        assert.ok(joined.eof || joined.canceled || joined.readRejected);
        assert.equal(joined.readResults.length, joined.readCalls);
        assert.equal(joined.cancelResults.length, joined.cancelCalls);
        assert.ok(joined.cancelResults.every(status => status === "fulfilled"), "join the original cancel promises, not unlock flags");
      }
      diagnostics.mark(phase, caseId, "progress", "fulfilled", false, undefined, { retired: joined.retired,
        activeReads: joined.hasBody ? joined.activeReads : null, unlocked: joined.hasBody ? joined.unlocked : null, closed: null });
      phase = "accounting"; diagnostics.mark(phase, caseId, "progress", "entered");
      const usage = await (await fetch(`${origin}/__google/usage/${id}`)).json();
      if (success.includes(name)) {
        assert.equal(usage.usage.events.length, 1, name);
        const event = usage.usage.events[0];
        assert.equal(event.provider, "google-gemini"); assert.equal(event.model, `google/${model}`);
        assert.equal(event.capability, "audio.speech"); assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.grant_key, `oauth/${id}/google-gemini`);
        assert.equal(event.pricing_ref, null); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
        assert.equal(event.cost_basis, name === "unknown" ? "unpriced_usage" : "policy_fixed");
        // Unknown provider cost is a zero accounting debit, not a free tariff.
        assert.equal(event.actual_cost_micros, name === "unknown" ? 0 : 17);
        assert.equal(event.reporting_known_cost_micros, null);
        if (name !== "unknown") assert.equal(usage.budget.spentMicros, 17);
      } else if (paid) {
        assert.equal(usage.usage.events.length, 1, name);
        const event = usage.usage.events[0], rejected = ["non200", "redirect"].includes(name), debit = rejected ? 0 : 17;
        assert.equal(event.provider, "google-gemini"); assert.equal(event.model, `google/${model}`);
        assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.grant_key, `oauth/${id}/google-gemini`);
        assert.notEqual(event.status, "success", name);
        assert.equal(event.reserved_cost_micros, 17); assert.equal(event.actual_cost_micros, debit);
        assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
        assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
        assert.equal(event.pricing_ref, null); assert.equal(event.reporting_known_cost_micros, null);
        assert.equal(usage.budget.spentMicros, debit, name);
      } else {
        assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
        assert.equal(usage.budget.spentMicros, 0);
      }
      assert.doesNotMatch(JSON.stringify(usage.usage.events), /fixture-secret|managed-gs_|must-not-fallback|Synthetic speech/);
      diagnostics.mark(phase, caseId, "progress", "fulfilled", false, undefined, { events: usage.usage.events.length, spentMicros: usage.budget.spentMicros });
    }
  } catch (error) {
    failures.push(error);
    if (phase === "helper") diagnostics.rejected(error);
    else { diagnostics.mark(phase, caseId, "primary", "rejected", true, error); diagnostics.checkpoint(); }
  }
  finally {
    diagnostics.mark("barrier_close", null, "progress", "entered");
    try { await barrier?.close(); diagnostics.mark("barrier_close", null, "progress", barrier ? "fulfilled" : "unknown"); }
    catch (error) { failures.push(error); diagnostics.mark("barrier_close", null, "cleanup", "rejected", true, error); diagnostics.checkpoint(); }
    diagnostics.mark("worker_dispose", null, "progress", "entered");
    try { await mf?.dispose(); diagnostics.mark("worker_dispose", null, "progress", mf ? "fulfilled" : "unknown"); }
    catch (error) { failures.push(error); diagnostics.mark("worker_dispose", null, "cleanup", "rejected", true, error); diagnostics.checkpoint(); }
    if (temporary !== undefined) {
      diagnostics.mark("scratch_cleanup", null, "progress", "entered");
      try { await rm(temporary, { recursive: true, force: true }); diagnostics.mark("scratch_cleanup", null, "progress", "fulfilled"); }
      catch (error) { failures.push(error); diagnostics.mark("scratch_cleanup", null, "cleanup", "rejected", true, error); }
    }
  }
  failures.push(...diagnostics.finish());
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Google client proof or owned cleanup failed");
});

function routerFixture() {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
import { budgetStatus } from "./worker/ledgers.ts";
const ids = IDS;
// Deterministic qualification date only; no fake timers or shortened deadlines.
const NativeDate = Date, fixtureNow = NativeDate.parse("2026-11-15T12:00:00Z");
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [fixtureNow]); },
  apply() { return new NativeDate(fixtureNow).toString(); },
  get(target, key) { return key === "now" ? () => fixtureNow : Reflect.get(target, key); },
});
const rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = new Map(), inputs = new Map(), ingested = new Map(ids.map(id => [id, deferred()])), violations = [];
function refuse(reason) { violations.push(reason); throw new Error(reason); }
let fixtureEnv;
const policy = id => ({ enabled: true, generation: "fixture", providers: id === "gs_policy" ? ["openai"] : ["google-gemini"], tenantId: "fixture",
  models: null, monthlyBudgetMicros: id === "gs_unknown" ? null : 10000,
  requestCostMicros: ["gs_unknown", "gs_budget"].includes(id) ? null : 17,
  budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/(?:interactions|models\/gemini-[a-z0-9.-]+:generateContent)$/.test(request.url) || request.method !== "POST") refuse("unexpected provider egress");
  const id = /^managed-(gs_[a-z_0-9]+)$/.exec(request.headers.get("x-goog-api-key") ?? "")?.[1];
  if (!ids.includes(id) || inputs.has(id)) refuse("unknown owner or repeated provider egress");
  const proof = { activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, terminal: deferred(),
    readCalls: 0, reads: [], cancelCalls: 0, cancels: [], sourceRejected: false,
    reservedBeforeFetch: (await budgetStatus(fixtureEnv, id, policy(id))).spentMicros };
  inputs.set(id, proof);
  let response;
  try { response = await rawFetch(request); } catch (error) { proof.terminal.resolve(); proof.fetchRejected = true; throw error; }
  const physical = response.body;
  if (!physical) throw new Error("missing real upstream body");
  proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try {
        proof.readCalls++;
        const original = reader.read(); proof.reads.push(original);
        let next;
        try { next = await original; } catch (error) { proof.readRejected = true; throw error; }
        if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
      }
      catch (error) { proof.sourceRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.sourceRejected) unlock(); }
    },
    async cancel(reason) {
      proof.canceled = true; proof.cancelCalls++;
      try { const original = reader.cancel(reason); proof.cancels.push(original); await original; }
      finally { unlock(); }
    },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
async function join(id) {
  const failures = [], cursors = new Map(), reads = [], cancels = [];
  let p, terminalOwner, terminalJoined = false;
  async function settle(originals) {
    return Promise.all(originals.map(async original => {
      // Isolate abrupt registration (including a throwing original then getter)
      // so it cannot prevent subscription to the remaining originals.
      try { return (await Promise.allSettled([original]))[0]; }
      catch (reason) { return { status: "rejected", reason, registrationFailed: true }; }
    }));
  }
  // Cursors belong to this original join invocation. Concurrent/repeated joins
  // retain their existing subscriptions; no original promise is replaced.
  for (;;) {
    for (const record of requests.get(id) ?? []) {
      if (!cursors.has(record)) {
        cursors.set(record, 0);
        try { await record.returned.promise; } catch (error) { failures.push(error); }
      }
      while (cursors.get(record) < record.pending.length) {
        const batch = record.pending.slice(cursors.get(record));
        cursors.set(record, cursors.get(record) + batch.length);
        const outcomes = await settle(batch);
        for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
      }
    }
    p = inputs.get(id);
    if (!terminalJoined || terminalOwner !== p) {
      terminalJoined = true; terminalOwner = p;
      try { await p?.terminal.promise; } catch (error) { failures.push(error); }
    }
    // Join the original native read/cancel promises even after an earlier
    // waitUntil/terminal failure. Keep their existing outcome assertions intact.
    const [nextReads, nextCancels] = await Promise.all([
      settle((p?.reads ?? []).slice(reads.length)),
      settle((p?.cancels ?? []).slice(cancels.length)),
    ]);
    for (const outcome of [...nextReads, ...nextCancels]) if (outcome.registrationFailed) failures.push(outcome.reason);
    reads.push(...nextReads); cancels.push(...nextCancels);
    // Settlement can append work to an earlier record or resource. Revisit only
    // new tails, without subscribing again to an already joined original.
    if ((requests.get(id) ?? []).every(record => cursors.has(record) && cursors.get(record) === record.pending.length)
      && inputs.get(id) === p && reads.length === (p?.reads.length ?? 0) && cancels.length === (p?.cancels.length ?? 0)) break;
  }
  let result;
  try {
    result = { hasBody: !!p?.physical, paths: (requests.get(id) ?? []).map(row => row.path), calls: p ? 1 : 0, retired: true, charged: bodyBudgetCharged(), ...(p?.physical ? {
    activeReads: p.activeReads, eof: p.eof, canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked,
    sourceLocked: p.source.locked, physicalLocked: p.physical.locked, reservedBeforeFetch: p.reservedBeforeFetch,
    readCalls: p.readCalls, readResults: reads.map(result => result.status),
    cancelCalls: p.cancelCalls, cancelResults: cancels.map(result => result.status),
  } : {}) };
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Google original Worker joins or result failed");
  return result;
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    const path = new URL(request.url).pathname;
    if (path === "/__google/audit") return Response.json(violations);
    if (path === "/__google/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", ids.map(policyId => ({ policyId, policy: policy(policyId) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", ids.map(credentialId => ({ credentialId, credential: { enabled: true, secretSha256, policyId: credentialId, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [{ providerId: "google-gemini", enabled: true }]);
      for (const id of ids) if (id !== "gs_grant") await putGrantCredentials(env, "oauth/" + id + "/google-gemini",
        { provider: id === "gs_foreign" ? "openai" : "google-gemini", kind: "api_key", enabled: true, credential: "managed-" + id });
      return Response.json({ ready: true });
    }
    const control = /^\/__google\/(join|usage|revoke|restrict)\/(gs_[a-z_0-9]+)$/.exec(path);
    if (control && ids.includes(control[2])) {
      const [, action, id] = control;
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && id === "gs_revoked" && request.method === "POST") {
        await revokeGrantCredentials(env, "oauth/" + id + "/google-gemini"); return Response.json({ revoked: true });
      }
      if (action === "restrict" && id === "gs_stale_policy" && request.method === "POST") {
        await authorityCall(env, "/policies/put", { policyId: id, policy: { ...policy(id), providers: ["openai"] } });
        return Response.json({ restricted: true });
      }
      if (action === "usage") {
        await join(id); if (inputs.has(id)) await ingested.get(id).promise;
        const response = await worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
        return response;
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-(gs_[a-z_0-9]+)-/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!ids.includes(id)) refuse("unknown client credential");
    if (path !== "/v1/catalog" && path !== "/v1/proxy/google-gemini/speech_interactions" && !/^\/v1\/native\/google-gemini\/v1beta\/models\/gemini-[a-z0-9.-]+:generateContent$/.test(path)) refuse("unexpected client route");
    const records = requests.get(id) ?? []; requests.set(id, records);
    if (records.some(row => row.path === path)) refuse("repeated client route");
    const record = { path, pending: [], returned: deferred() }; records.push(record);
    const ctx = { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } };
    try { return await worker.fetch(request, { ...env, GOOGLE_API_KEY: "must-not-fallback-google" }, ctx); }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) {
    await worker.queue(batch, env);
    for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve();
  },
};
`.replace("IDS", JSON.stringify(scenarios.map(name => `gs_${name}`)));
}

function upstreamFixture(control) {
  return String.raw`
const calls = [];
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const id = /^managed-(gs_[a-z_0-9]+)$/.exec(request.headers.get("x-goog-api-key") ?? "")?.[1];
  const body = await request.json();
  const call = { id, request: { url: request.url, method: request.method, selectedKey: !!id,
    noProxySecret: !request.headers.has("authorization") && !request.headers.has("x-api-key"), body }, finished: false };
  calls.push(call);
  if (!id || request.method !== "POST") return new Response(null, { status: 400 });
  const name = id.slice(3), model = body.model ?? /\/models\/([^/]+):generateContent$/.exec(new URL(request.url).pathname)?.[1];
  const block = { type: "audio", mime_type: "audio/l16;rate=24000", data: "AAD/fw==" };
  const payload = body.model ? { model, status: "completed", steps: [{ type: "model_output", content: [block, { ...block }] }] }
    : { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAD/fw==" } }, { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAD/fw==" } }] } }] };
  const headers = { "content-type": "application/json" };
  if (["abort_headers", "deadline"].includes(name)) {
    try { const held = await fetch(CONTROL + "/" + name + "/hold", { signal: request.signal }); await held.body?.cancel(); throw new Error("held transport ended without original cancellation"); }
    finally { call.finished = true; }
  }
  if (name === "abort_body") {
    let started = false;
    return new Response(new ReadableStream({ async pull(controller) {
      if (started) return; started = true; controller.enqueue(new TextEncoder().encode('{"steps":['));
      try { const held = await fetch(CONTROL + "/abort_body/hold", { signal: request.signal }); await held.body?.cancel(); throw new Error("held body ended without original cancellation"); }
      catch (error) { controller.error(error); }
      finally { call.finished = true; }
    } }, { highWaterMark: 0 }), { headers });
  }
  call.finished = true;
  if (name === "non200") return Response.json({ error: "synthetic unavailable" }, { status: 503 });
  if (name === "redirect") return new Response(null, { status: 307, headers: { ...headers, location: "https://alternate.example/speech" } });
  if (name === "encoding") headers["content-encoding"] = "unsupported";
  if (name === "later") payload.steps[0].content.push({ type: "audio", mime_type: "audio/l16", data: "AAAA" });
  const bytes = new TextEncoder().encode(name === "truncated" ? '{"steps":[' : JSON.stringify(payload));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 17, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers });
} };
`.replaceAll("CONTROL", JSON.stringify(control));
}

// BEGIN Google original join pure tests.
// Extract only the actual generated join; no Worker, SDK or network is started.
function originalJoinFixture(records = [], proof, charged = () => 0) {
  const source = routerFixture();
  const start = source.indexOf("async function join(id) {");
  const end = source.indexOf("\nexport default {", start);
  assert.ok(start >= 0 && end > start);
  const requests = new Map([["gs_model0", records]]), inputs = new Map();
  if (proof) inputs.set("gs_model0", proof);
  const join = new Function("requests", "inputs", "bodyBudgetCharged", source.slice(start, end) + "; return join;")(requests, inputs, charged);
  return { join: () => join("gs_model0"), requests, inputs };
}
function joinDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function joinRecord(pending = [], path = "/v1/catalog") {
  return { path, pending, returned: { promise: Promise.resolve() } };
}
function watchedOriginal(promise, onSubscribe = () => {}) {
  const nativeThen = promise.then;
  let calls = 0;
  Object.defineProperty(promise, "then", { value: function (...args) {
    assert.equal(this, promise); assert.equal(args.length, 2);
    assert.equal(typeof args[0], "function"); assert.equal(typeof args[1], "function");
    calls++; onSubscribe();
    return Reflect.apply(nativeThen, this, args);
  } });
  return { promise, calls: () => calls };
}
function joinOutcome(promise) {
  const observed = { settled: false, rejected: false, value: undefined };
  observed.done = promise.then(value => { observed.settled = true; observed.value = value; }, error => {
    observed.settled = true; observed.rejected = true; observed.value = error;
  });
  return observed;
}
async function flushJoinJobs() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function exactJoinFailures(error, expected) {
  assert.ok(error instanceof AggregateError);
  assert.ok(Array.isArray(error.errors)); assert.equal(error.errors.length, expected.length);
  expected.forEach((value, index) => assert.equal(error.errors[index], value));
}
for (const reason of [{ original: "waitUntil" }, undefined]) {
  test(`Google original join retains ${reason === undefined ? "undefined" : "defined"} failure until held original settles`, async () => {
    const held = joinDeferred(), attached = joinDeferred();
    const watched = watchedOriginal(held.promise, attached.resolve);
    const failed = Promise.reject(reason);
    const fixture = originalJoinFixture([joinRecord([failed, watched.promise])]);
    const result = joinOutcome(fixture.join());
    await attached.promise; await flushJoinJobs();
    const early = result.settled;
    held.resolve(); await result.done;
    assert.equal(early, false); assert.equal(result.rejected, true); assert.equal(result.value, reason);
    assert.equal(watched.calls(), 1);
  });
}
test("Google original join retains ordered failures through terminal, resource and result joins", async () => {
  const first = { first: true }, second = new AggregateError([undefined], "original nested failure"), report = { report: true };
  const heldRead = joinDeferred(), heldCancel = joinDeferred(), attachedRead = joinDeferred(), attachedCancel = joinDeferred();
  const read = watchedOriginal(heldRead.promise, attachedRead.resolve), cancel = watchedOriginal(heldCancel.promise, attachedCancel.resolve);
  const terminal = joinDeferred();
  const proof = { terminal, reads: [read.promise], cancels: [cancel.promise] };
  const records = [joinRecord([Promise.reject(first), Promise.reject(undefined), Promise.reject(second)])];
  const result = joinOutcome(originalJoinFixture(records, proof, () => { throw report; }).join());
  await flushJoinJobs(); terminal.reject(undefined);
  await Promise.all([attachedRead.promise, attachedCancel.promise]); await flushJoinJobs();
  const beforeRead = result.settled;
  heldRead.resolve(); await flushJoinJobs(); const beforeCancel = result.settled;
  heldCancel.resolve(); await result.done;
  assert.equal(beforeRead, false); assert.equal(beforeCancel, false); assert.equal(result.rejected, true);
  exactJoinFailures(result.value, [first, undefined, second, undefined, report]);
  assert.equal(read.calls(), 1); assert.equal(cancel.calls(), 1);
});
test("Google original join revisits earlier records and appended resource tails exactly once", async () => {
  const tail = joinDeferred(), resourceTail = joinDeferred(), tailAttached = joinDeferred(), resourceAttached = joinDeferred();
  const tailWatch = watchedOriginal(tail.promise, tailAttached.resolve), resourceWatch = watchedOriginal(resourceTail.promise, resourceAttached.resolve);
  const first = joinRecord(), second = joinRecord([], "/v1/native/google-gemini/model");
  const proof = { terminal: { promise: Promise.resolve() }, reads: [], cancels: [] };
  const append = watchedOriginal(Promise.resolve(), () => first.pending.push(tailWatch.promise));
  const appendRead = watchedOriginal(Promise.resolve(), () => proof.cancels.push(resourceWatch.promise));
  second.pending.push(append.promise); proof.reads.push(appendRead.promise);
  const result = joinOutcome(originalJoinFixture([first, second], proof).join());
  await resourceAttached.promise; await flushJoinJobs(); const beforeResource = result.settled;
  resourceTail.resolve(); await tailAttached.promise; await flushJoinJobs(); const beforeTail = result.settled;
  tail.resolve(); await result.done;
  assert.equal(beforeResource, false); assert.equal(beforeTail, false); assert.equal(result.rejected, false);
  for (const original of [append, appendRead, tailWatch, resourceWatch]) assert.equal(original.calls(), 1);
});
test("Google original join preserves concurrent and repeated invocation subscriptions", async () => {
  const held = joinDeferred(), original = watchedOriginal(held.promise);
  const record = joinRecord([original.promise]), fixture = originalJoinFixture([record]);
  const first = joinOutcome(fixture.join()), second = joinOutcome(fixture.join());
  await flushJoinJobs(); const early = first.settled || second.settled;
  held.resolve(); await Promise.all([first.done, second.done]);
  assert.equal(early, false); assert.equal(original.calls(), 2);
  await fixture.join(); assert.equal(original.calls(), 3); assert.equal(record.pending[0], original.promise);
});
test("Google original join allows subscription reentry without replacing or self-joining originals", async () => {
  const held = joinDeferred(); let nested, fixture;
  const original = watchedOriginal(held.promise, () => { if (!nested) nested = joinOutcome(fixture.join()); });
  fixture = originalJoinFixture([joinRecord([original.promise])]);
  const outer = joinOutcome(fixture.join());
  await flushJoinJobs(); assert.ok(nested); const early = outer.settled || nested.settled;
  held.resolve(); await Promise.all([outer.done, nested.done]);
  assert.equal(early, false); assert.equal(outer.rejected, false); assert.equal(nested.rejected, false);
  assert.equal(original.calls(), 2);
});
for (const report of [{ report: true }, undefined]) {
  test(`Google original join preserves throwing subscription and ${report === undefined ? "undefined" : "defined"} result failure`, async () => {
    let gets = 0;
    const original = Promise.resolve();
    Object.defineProperty(original, "then", { get() { gets++; throw undefined; } });
    const held = joinDeferred(), attached = joinDeferred(), watched = watchedOriginal(held.promise, attached.resolve);
    const result = joinOutcome(originalJoinFixture([joinRecord([original, watched.promise])], undefined, () => { throw report; }).join());
    await attached.promise; await flushJoinJobs(); const early = result.settled;
    held.resolve(); await result.done;
    assert.equal(early, false); assert.equal(result.rejected, true); exactJoinFailures(result.value, [undefined, report]);
    assert.equal(gets, 1); assert.equal(watched.calls(), 1);
  });
}
test("Google original join preserves resource outcome projection and successful result fields", async () => {
  const error = { native: true };
  const proof = { terminal: { promise: Promise.resolve() }, reads: [Promise.reject(error)], cancels: [Promise.reject(undefined)],
    physical: { locked: false }, source: { locked: false }, activeReads: 0, eof: false, canceled: true,
    readRejected: true, unlocked: true, reservedBeforeFetch: true, readCalls: 1, cancelCalls: 1 };
  const result = await originalJoinFixture([joinRecord()], proof, () => 7).join();
  assert.deepEqual(result, { hasBody: true, paths: ["/v1/catalog"], calls: 1, retired: true, charged: 7,
    activeReads: 0, eof: false, canceled: true, readRejected: true, unlocked: true, sourceLocked: false,
    physicalLocked: false, reservedBeforeFetch: true, readCalls: 1, readResults: ["rejected"],
    cancelCalls: 1, cancelResults: ["rejected"] });
  // Existing caller assertions, not this join, still decide these raw outcomes.
});
test("Google original join retains resource registration faults while joining later resources", async () => {
  const report = { report: true }, held = joinDeferred(), attached = joinDeferred();
  let gets = 0;
  const original = Promise.resolve();
  Object.defineProperty(original, "then", { get() { gets++; throw undefined; } });
  const watched = watchedOriginal(held.promise, attached.resolve);
  const proof = { terminal: { promise: Promise.resolve() }, reads: [original, watched.promise], cancels: [] };
  const result = joinOutcome(originalJoinFixture([], proof, () => { throw report; }).join());
  await attached.promise; await flushJoinJobs(); const early = result.settled;
  held.resolve(); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, true); exactJoinFailures(result.value, [undefined, report]);
  assert.equal(gets, 1); assert.equal(watched.calls(), 1);
});
test("Google original join retains returned failure and joins subsequently appended request records", async () => {
  const originalFailure = { returned: true }, held = joinDeferred(), attached = joinDeferred();
  const watched = watchedOriginal(held.promise, attached.resolve);
  const first = joinRecord(); first.returned.promise = Promise.reject(originalFailure);
  const records = [first];
  first.pending.push(watchedOriginal(Promise.resolve(), () => records.push(joinRecord([watched.promise], "/v1/native/google-gemini/model"))).promise);
  const result = joinOutcome(originalJoinFixture(records).join());
  await attached.promise; await flushJoinJobs(); const early = result.settled;
  held.resolve(); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, true); assert.equal(result.value, originalFailure);
  assert.equal(watched.calls(), 1);
});
test("Google original join retains each later failure after an earlier record rejected", async () => {
  const first = { first: true }, later = { later: true }, report = { report: true };
  const held = joinDeferred(), attached = joinDeferred(), watched = watchedOriginal(held.promise, attached.resolve);
  const late = joinDeferred();
  const records = [joinRecord([Promise.reject(first)]), joinRecord([late.promise, watched.promise], "/v1/native/google-gemini/model")];
  const result = joinOutcome(originalJoinFixture(records, undefined, () => { throw report; }).join());
  await attached.promise; late.reject(later); await flushJoinJobs(); const early = result.settled;
  held.resolve(); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, true); exactJoinFailures(result.value, [first, later, report]);
  assert.equal(watched.calls(), 1);
});
// END Google original join pure tests.

// BEGIN Google ownership pure tests.
function googleOwnershipHelpers() {
  const start = sdkText.indexOf("// BEGIN Google private ownership."), end = sdkText.indexOf("// END Google private ownership.");
  const spyStart = sdkText.indexOf("function spyOwned("), spyEnd = sdkText.indexOf("type Observation =", spyStart);
  const bodyStart = sdkText.indexOf("function observeBody("), bodyEnd = sdkText.indexOf("\nafterEach(", bodyStart);
  assert.ok(start >= 0 && end > start && spyStart > end && bodyEnd > bodyStart);
  const vi = { spyOn(target, key) {
    const before = Object.getOwnPropertyDescriptor(target, key), original = target[key];
    let implementation = original;
    function spy(...args) { spy.mock.calls.push(args); return Reflect.apply(implementation, this, args); }
    spy.mock = { calls: [] };
    spy.mockImplementation = fn => { implementation = fn; return spy; };
    spy.mockRestore = () => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key); };
    Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value: spy });
    return spy;
  } };
  const expect = value => ({ toBeUndefined() { assert.equal(value, undefined); } });
  return new Function("vi", "expect", stripTypeScriptTypes(sdkText.slice(start, end) + sdkText.slice(spyStart, spyEnd) + sdkText.slice(bodyStart, bodyEnd))
    + ";return {googleOwnership,spyOwned,observeBody};")(vi, expect);
}
function googleInertOwner(bindings = new WeakMap()) {
  const helpers = googleOwnershipHelpers(); let current;
  const owner = helpers.googleOwnership(() => current === owner, bindings, nodeTypes.isPromise); current = owner;
  return { ...helpers, owner, replaceGeneration() { current = {}; } };
}
function googleInertRow(owner) { return { owner, invocation: {}, bodies: [], readers: [], closed: [], reads: [], cancels: [] }; }
function googleInertReader(closed, read = Promise.resolve({ done: true }), cancel = Promise.resolve()) {
  const calls = []; let closedGets = 0;
  const reader = { get closed() { closedGets++; return closed; }, read(...args) { calls.push(["read", this, args]); return read; },
    cancel(...args) { calls.push(["cancel", this, args]); return cancel; }, releaseLock(...args) { calls.push(["release", this, args]); } };
  const body = { getReader(...args) { calls.push(["getReader", this, args]); return reader; }, cancel(...args) { calls.push(["bodyCancel", this, args]); return cancel; } };
  return { reader, body, calls, closedGets: () => closedGets };
}
test("Google ownership rejects aliased responses, bodies, readers, promises and stale generations", async () => {
  for (const kind of ["response", "body", "reader", "promise", "dispatcher"]) {
    const bindings = new WeakMap(), first = googleInertOwner(bindings), row = {};
    const value = kind === "promise" ? Promise.resolve() : {};
    first.owner.bind(value, kind, row);
    assert.equal(first.owner.lookup(value, kind), row);
    assert.throws(() => first.owner.bind(value, kind, {}), /aliased/);
    await assert.rejects(first.owner.finish());
    const second = googleInertOwner(bindings);
    assert.throws(() => second.owner.bind(value, kind, row), /aliased/);
    await assert.rejects(second.owner.finish());
  }
  const { owner, replaceGeneration } = googleInertOwner(); replaceGeneration();
  assert.throws(() => owner.use(), /foreign/); await assert.rejects(owner.finish());
});
for (const reason of [{ original: "closed" }, undefined]) {
  test(`Google original C0 captures once and retains ${reason === undefined ? "undefined" : "defined"} outcome before seal`, async () => {
    const { owner, observeBody } = googleInertOwner(), row = googleInertRow(owner);
    const closed = joinDeferred(), read = joinDeferred(), original = googleInertReader(closed.promise, read.promise);
    observeBody(original.body, row); assert.equal(original.body.getReader(), original.reader); assert.equal(original.closedGets(), 1);
    const operand = {};
    assert.equal(original.reader.read(operand), read.promise);
    const first = owner.drain(), second = owner.drain(); assert.equal(first, second);
    const result = joinOutcome(first); read.resolve({ done: true }); await flushJoinJobs(); const early = result.settled;
    closed.reject(reason); await result.done;
    assert.equal(early, false); assert.equal(result.rejected, false);
    assert.equal(row.closed[0].original, closed.promise); assert.equal(row.closed[0].outcome.status, "rejected"); assert.equal(row.closed[0].outcome.reason, reason);
    assert.equal(original.closedGets(), 1); assert.equal(original.calls[1][1], original.reader); assert.equal(original.calls[1][2][0], operand);
    original.reader.releaseLock(); const seal = await owner.finish(); assert.ok(Object.isFrozen(seal)); assert.equal(owner.assertFinal(), seal);
    const rawRead = seal.operations.find(entry => entry.kind === "read");
    assert.equal(rawRead.original, read.promise); assert.equal(rawRead.bindings[0].resource, original.reader);
    assert.equal(rawRead.bindings[0].receiver, original.reader); assert.equal(rawRead.bindings[0].args[0], operand);
    assert.ok(seal.calls.every(call => Object.isFrozen(call) && Object.isFrozen(call.args)));
  });
}
test("Google ownership rejects changed body and repeated reader acquisition", async () => {
  for (const mode of ["body", "reader"]) {
    const { owner, observeBody } = googleInertOwner(), row = googleInertRow(owner), original = googleInertReader(Promise.resolve());
    observeBody(original.body, row); original.body.getReader();
    assert.throws(() => mode === "body" ? observeBody({}, row) : original.body.getReader());
    await assert.rejects(owner.finish()); assert.equal(original.closedGets(), 1);
  }
});
test("Google ownership joins appended observer tails and concurrent reentrant drains", async () => {
  const { owner } = googleInertOwner(), row = {}, original = joinDeferred(), tail = joinDeferred();
  let nested;
  owner.watch(original.promise, row, "read", false, () => { nested = owner.drain(); return tail.promise; });
  const first = owner.drain(), second = owner.drain(); assert.equal(first, second);
  const result = joinOutcome(first); original.resolve(); await flushJoinJobs(); const early = result.settled;
  assert.equal(nested, first); tail.resolve(); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, false);
  await owner.drain(); const seal = await owner.finish(); assert.equal(seal.originals, 2); assert.equal(seal.observers, 2);
});
test("Google ownership joins held originals after undefined observer failure and preserves independent source failure", async () => {
  const { owner } = googleInertOwner(), row = {}, held = joinDeferred(), source = { original: true };
  owner.watch(Promise.resolve(), row, "read", false, () => { throw undefined; });
  owner.watch(held.promise, row, "cancel", true);
  const result = joinOutcome(owner.drain()); await flushJoinJobs(); const early = result.settled;
  held.reject(source); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, true); exactJoinFailures(result.value, [undefined, source]);
  await assert.rejects(owner.finish(), error => { exactJoinFailures(error, [undefined, source]); return true; });
});
test("Google ownership restores independently and rejects descriptor substitution", async () => {
  const { owner } = googleInertOwner(), original = () => {}, replacement = () => {}, foreign = () => {};
  const first = { run: original }, second = { run: original };
  owner.replace(first, "run", replacement); owner.replace(second, "run", replacement); first.run = foreign;
  await assert.rejects(owner.finish(), /custody/);
  assert.equal(first.run, foreign); assert.equal(second.run, original); assert.throws(() => owner.assertFinal());
});
test("Google final seal is permanent, shared, and invalidated by saved late wrappers or late failure", async () => {
  for (const mode of ["operation", "failure"]) {
    const { owner, observeBody } = googleInertOwner(), row = googleInertRow(owner), original = googleInertReader(Promise.resolve());
    observeBody(original.body, row); original.body.getReader(); const late = original.reader.read;
    const first = owner.finish(), second = owner.finish(); assert.equal(first, second); const seal = await first;
    const calls = original.calls.length;
    if (mode === "operation") assert.throws(() => late.call(original.reader), /closed/); else owner.fault(undefined);
    assert.equal(original.calls.length, calls); assert.ok(Object.isFrozen(seal));
    let failed = false; try { owner.assertFinal(); } catch { failed = true; } assert.equal(failed, true);
    await assert.rejects(owner.finish());
  }
});
test("Google restoration preserves undefined failure and still joins restoration-appended work", async () => {
  const { owner } = googleInertOwner(), target = { value: 1 }, row = {}, held = joinDeferred();
  owner.install(target, "value", () => { target.value = 2; }, () => { target.value = 1; owner.watch(held.promise, row, "observer", true); throw undefined; });
  const result = joinOutcome(owner.finish()); await flushJoinJobs(); const early = result.settled;
  held.resolve(); await result.done; assert.equal(early, false); assert.equal(result.rejected, true); assert.equal(result.value, undefined); assert.equal(target.value, 1);
});
test("Google guard association uses exact response and invocation and preserves original P/release operands", async () => {
  const sdkStart = sdkText.indexOf("  const observeGuard = function"), sdkEnd = sdkText.indexOf("  // Registered speech uses", sdkStart);
  const source = stripTypeScriptTypes(sdkText.slice(sdkStart, sdkEnd));
  for (const mode of ["exact", "foreignResponse", "foreignInvocation"]) {
    const { owner, spyOwned, observeBody } = googleInertOwner(), row = googleInertRow(owner);
    const original = googleInertReader(Promise.resolve()), response = { body: original.body }, releaseP = Promise.resolve();
    const releaseCalls = [], result = { response, release(...args) { releaseCalls.push([this, args]); return releaseP; } };
    let guardP;
    const guardContext = { run(token, fn) { row.guardInvocation = mode === "foreignInvocation" ? {} : token; return fn(); } };
    row.response = response; owner.bind(mode === "foreignResponse" ? {} : response, "response", row);
    const guard = new Function("owner", "guardContext", "originalGuard", "performance", "observeBody", "spyOwned", "nodeTypes", "invocationContext", source + ";return observeGuard;")(
      owner, guardContext, function (...args) { assert.equal(this, receiver); assert.equal(args[0], options); guardP = Promise.resolve(result); return guardP; }, { now: () => 0 }, observeBody, spyOwned, nodeTypes, { getStore: () => owner });
    const receiver = {}, options = {}; assert.equal(guard.call(receiver, options), guardP);
    if (mode !== "exact") { await assert.rejects(owner.drain()); await assert.rejects(owner.finish()); continue; }
    await owner.drain(); const operand = {}; assert.equal(result.release(operand), releaseP);
    await owner.drain(); assert.equal(releaseCalls[0][0], result); assert.equal(releaseCalls[0][1][0], operand); assert.equal(row.releaseReturned, true);
    await owner.finish();
  }
});
test("Google close/release forwarding shares its exact P while cross-owner alias remains fatal", async () => {
  const { owner } = googleInertOwner(), row = {}, original = joinDeferred(); let observed = false;
  const first = owner.watch(original.promise, row, "close", true);
  const second = owner.watch(original.promise, row, "release", true, () => { observed = true; });
  assert.equal(first, second); const result = joinOutcome(owner.drain()); await flushJoinJobs(); const early = result.settled;
  original.resolve(null); await result.done; assert.equal(early, false); assert.equal(observed, true);
  assert.throws(() => owner.watch(original.promise, {}, "release", true), /aliased/); await assert.rejects(owner.finish());
});
function googleAcquisitionFixture(runtimeFetch, foreignInvocation = false) {
  const harness = googleInertOwner(), observations = [], undici = {};
  const token = { generation: harness.owner.generation };
  const a = sdkText.indexOf("function observeRequest("), b = sdkText.indexOf("function observeBody(", a);
  const source = stripTypeScriptTypes(sdkText.slice(a, b));
  const Request = class { constructor(input, init) { this.url = input; this.headers = { has: () => false, get: () => init.credential }; } };
  const URL = class { constructor(url) { this.origin = "fixture"; this.pathname = url; this.search = ""; } };
  const observe = new Function("Request", "URL", "origin", "speechPath", "refuse", "observations", "guardContext", "undici", "originalRuntimeFetch", "spyOwned", "reportIdentity", "mark", "nodeTypes", "observeBody", "invocationContext", source + ";return observeRequest;")(
    Request, URL, "fixture", () => true, message => { throw new Error(message); }, observations, { getStore: () => token }, undici,
    runtimeFetch, harness.spyOwned, () => ({ caseId: null, route: "native" }), () => {}, nodeTypes, harness.observeBody, { getStore: () => foreignInvocation ? {} : harness.owner });
  return { ...harness, observations, undici, token, observe: (...args) => observe(harness.owner, ...args) };
}
test("Google original acquisition binds actual receiver, operands, P and returned resource chain", async () => {
  const acquisition = joinDeferred(), closed = joinDeferred(), original = googleInertReader(closed.promise), response = { body: original.body };
  let actualThis, actualArgs;
  const harness = googleAcquisitionFixture(function (...args) { actualThis = this; actualArgs = args; return acquisition.promise; });
  const input = "/v1/native/google-gemini/v1beta/models/gemini-fixture:generateContent", init = { credential: "owned", dispatcher: { close() { return Promise.resolve(null); } } };
  const returned = harness.observe(input, init); acquisition.resolve(response); assert.equal(await returned, response);
  const row = harness.observations[0];
  assert.equal(actualThis, harness.undici); assert.equal(actualArgs[0], input); assert.equal(actualArgs[1], init);
  assert.equal(row.acquisition, acquisition.promise); assert.equal(row.fetchReceiver, actualThis); assert.equal(row.fetchArgs[1], init);
  assert.equal(row.response, response); assert.equal(row.guardInvocation, harness.token); assert.equal(harness.owner.lookup(response, "response"), row);
  assert.equal(original.body.getReader(), original.reader); closed.resolve(); await init.dispatcher.close(); await harness.owner.finish();
});
for (const reason of [{ original: "acquisition" }, undefined]) {
  test(`Google preserves separate expected ${reason === undefined ? "undefined" : "defined"} acquisition failure without borrowing observer status`, async () => {
    const original = joinDeferred(), harness = googleAcquisitionFixture(() => original.promise);
    const init = { credential: "owned", dispatcher: { close() { return Promise.resolve(null); } } };
    const outcome = joinOutcome(harness.observe("/native", init)); original.reject(reason); await outcome.done;
    assert.equal(outcome.rejected, true); assert.equal(outcome.value, reason); assert.equal(harness.observations[0].failedBeforeResponse, true);
    await init.dispatcher.close(); await harness.owner.finish();
  });
}
test("Google acquisition observer failures cannot masquerade as expected fetch failures", async () => {
  const response = { get body() { throw undefined; } }, harness = googleAcquisitionFixture(() => Promise.resolve(response));
  const init = { credential: "owned", dispatcher: { close() { return Promise.resolve(null); } } };
  const result = joinOutcome(harness.observe("/native", init)); await result.done;
  assert.equal(result.rejected, true); assert.equal(result.value, undefined); assert.equal(harness.observations[0].failedBeforeResponse, false);
  await init.dispatcher.close();
  await assert.rejects(harness.owner.finish(), error => { assert.equal(error, undefined); return true; });
});
test("Google failed installation retains original undefined and still restores its owned target", async () => {
  const { owner } = googleInertOwner(), target = { value: 1 }; let restores = 0, caught = false;
  try { owner.install(target, "value", () => { target.value = 2; throw undefined; }, () => { restores++; target.value = 1; }); }
  catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); await assert.rejects(owner.finish(), error => { assert.equal(error, undefined); return true; });
  assert.equal(restores, 1); assert.equal(target.value, 1);
});
test("Google public acquisition refuses foreign invocation before the original fetch", async () => {
  let calls = 0;
  const harness = googleAcquisitionFixture(() => { calls++; return Promise.resolve({}); }, true);
  assert.throws(() => harness.observe("/native", {}), /foreign/); assert.equal(calls, 0); await assert.rejects(harness.owner.finish());
});
test("Google original synchronous undefined failure waits for C0 and retains independent restore failure", async () => {
  const { owner, observeBody } = googleInertOwner(), row = googleInertRow(owner), closed = joinDeferred(), original = googleInertReader(closed.promise);
  const source = function () { throw undefined; }, cleanup = { cleanup: true };
  original.reader.read = source; observeBody(original.body, row); original.body.getReader();
  let caught = false; try { original.reader.read(); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
  owner.install({}, "unused", () => {}, () => { throw cleanup; });
  const result = joinOutcome(owner.finish()); await flushJoinJobs(); const early = result.settled;
  closed.resolve(); await result.done;
  assert.equal(early, false); assert.equal(result.rejected, true); exactJoinFailures(result.value, [undefined, cleanup]);
  assert.equal(original.reader.read, source);
});
// END Google ownership pure tests.
