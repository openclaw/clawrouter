import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { musicWave } from "../worker/test/openrouter-music-runtime-fixture.mjs";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { startBundledWorkerdFixture } from "./helpers/workerd.mjs";

// Provisional published source, NOT a qualified client release. Its manifest
// model envelope needs the separately owned SDK correction before this can pass.
const sourceHead = "49743aff29c4adf37188725b130325026d3dad18";
const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const root = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = resolve(root, "worker/generated/provider-snapshot.json");
const models = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
const target = "https://openrouter.ai/api/v1/chat/completions";
const positives = models.flatMap((model, index) => ["wav", "mp3"].map(format => ({ id: `m${index}_${format}`, model, format, kind: "success" })));
const negativeKinds = ["reference", "options", "preabort", "missing", "foreign", "revoked", "unpriced", "stalegrant",
  "empty", "eof", "json", "utf8", "base64", "ambiguous", "partial", "error", "redirect", "wire", "audio", "transcript", "abort_headers", "abort_body", "deadline_body"];
const cases = [...positives, ...negativeKinds.map(kind => ({ id: kind, kind, model: models[0], format: "wav" }))];
const unsent = new Set(["reference", "options", "preabort", "missing", "foreign", "revoked", "unpriced", "stalegrant"]);
const key = id => `clawrouter-live-orm_${id}-fixture-secret`;
const headers = id => ({ authorization: `Bearer ${key(id)}`, "content-type": "application/json", "accept-encoding": "identity" });
const body = row => ({ model: row.model, messages: [{ role: "user", content: `Synthetic ${row.id}` }], modalities: ["text", "audio"], audio: { format: row.format }, stream: true });

function compiled(route) {
  const inputs = readdirSync(join(root, "providers")).filter(name => name.endsWith(".provider.yaml")).sort()
    .map(name => parse(readFileSync(join(root, "providers", name), "utf8")));
  assert.equal(inputs.length, 87);
  const baseline = compileProviderSnapshot(inputs);
  assert.deepEqual(baseline, JSON.parse(readFileSync(snapshotPath, "utf8")));
  if (route === "native") return baseline;
  assert.equal(route, "manifest");
  const expected = structuredClone(baseline);
  inputs.find(provider => provider.id === "openrouter").endpoints.music_generate.nativeProxy = false;
  expected.providers.find(provider => provider.id === "openrouter").endpoints.find(endpoint => endpoint.id === "music_generate").native_proxy = false;
  const variant = compileProviderSnapshot(inputs);
  assert.deepEqual(variant, expected, "only the schema-validated music native_proxy setting differs");
  return variant;
}

// Serialized into the actual Worker. Observe originals without adding reads,
// cancellation, release, response replacement or a competing cleanup operation.
function observeBody(response, signal, owner) {
  const body = response.body;
  if (!body) throw new Error("original response body missing");
  const rows = [], getReader = body.getReader;
  body.getReader = function(...args) {
    const reader = Reflect.apply(getReader, this, args);
    const row = { reader, closed: reader.closed, operations: [], errors: [], unlocks: 0, returned: 0 };
    rows.push(row);
    void row.closed.catch(() => {});
    for (const kind of ["read", "cancel"]) {
      const original = reader[kind];
      reader[kind] = function(...operands) {
        try {
          const pending = Reflect.apply(original, this, operands);
          row.operations.push({ kind, pending });
          void pending.catch(() => {});
          return pending;
        } catch (reason) { row.errors.push(reason); throw reason; }
      };
    }
    const release = reader.releaseLock;
    reader.releaseLock = function(...args) {
      row.unlocks++;
      try { const result = Reflect.apply(release, this, args); row.returned++; return result; }
      catch (reason) { row.errors.push(reason); throw reason; }
    };
    return reader;
  };
  owner.join = async () => {
    const failures = [];
    if (!rows.length) failures.push(new Error("missing original reader"));
    for (const row of rows) {
      const results = await Promise.allSettled(row.operations.map(operation => operation.pending));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected" && !(row.operations[index].kind === "read" && signal?.aborted && signal.reason !== undefined && result.reason === signal.reason)) failures.push(result.reason);
      }
      const closed = await Promise.allSettled([row.closed]);
      if (closed[0].status === "rejected") failures.push(closed[0].reason);
      failures.push(...row.errors);
      if (row.unlocks !== 1 || row.returned !== 1 || body.locked) failures.push(new Error("original reader not physically released"));
    }
    if (failures.length) throw new AggregateError(failures, "original Worker body retirement failed");
    return { readers: rows.length, operations: rows.reduce((n, row) => n + row.operations.length, 0), unlocked: !body.locked };
  };
}

function routerScript() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const rows = ${JSON.stringify(cases)}, target = ${JSON.stringify(target)}, inputs = [], requests = [], tasks = [], failures = [];
const originalFetch = globalThis.fetch;
${observeBody.toString()}
globalThis.fetch = function(input, init) {
  const url = input instanceof Request ? input.url : String(input);
  const pending = Reflect.apply(originalFetch, this, [input, init]);
  if (url === target) {
    const proof = { pending }; inputs.push(proof);
    proof.observed = pending.then(response => observeBody(response, init?.signal ?? (input instanceof Request ? input.signal : undefined), proof));
    void proof.observed.catch(() => {});
  }
  return pending;
};
async function retire() {
  const errors = [...failures];
  let cursor = 0;
  while (cursor < tasks.length) { const batch = tasks.slice(cursor); cursor = tasks.length; for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") errors.push(result.reason); }
  const joined = [];
  for (const input of inputs) {
    try { await input.observed; if (!input.join) throw new Error("acquired input unobserved"); joined.push(await input.join()); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "original Worker operations failed");
  return { joined, requests, tasks: tasks.length };
}
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") {
    for (const row of rows) if (row.kind !== "missing") await putGrantCredentials(env, "oauth/orm_" + row.id + "/openrouter", { provider: "openrouter", enabled: true, kind: "api_key", credential: "fixture-upstream-" + row.id });
    return new Response(null, { status: 204 });
  }
  if (path === "/fixture/revoke") { const id = new URL(request.url).searchParams.get("id"); if (!rows.some(row => row.id === id)) return new Response(null, { status: 400 }); await revokeGrantCredentials(env, "oauth/orm_" + id + "/openrouter"); return new Response(null, { status: 204 }); }
  if (path === "/fixture/retire") return Response.json(await retire());
  if (path === "/fixture/state") return originalFetch("https://fixture.example/state");
  if (path === "/fixture/started") return originalFetch("https://fixture.example/started?id=" + new URL(request.url).searchParams.get("id"));
  if (path === "/fixture/alternate") { requests.push({ path }); return new Response("unexpected alternate", { status: 500 }); }
  if (path.startsWith("/v1/") && path !== "/v1/usage") requests.push({ path, method: request.method, authorization: request.headers.get("authorization"), body: request.method === "POST" ? await request.clone().json() : null });
  try { return await handler.fetch(request, { ...env, OPENROUTER_API_KEY: "must-not-fallback" }, { waitUntil(pending) { tasks.push(pending); context.waitUntil(pending); } }); }
  catch (error) { failures.push(error); throw error; }
} };`;
}

function upstreamScript(audio) {
  return `const calls = [], audio = ${JSON.stringify(audio)}, rows = ${JSON.stringify(cases)}, waiting = new Map();
const event = value => "data: " + JSON.stringify(value) + "\\n\\n";
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === "fixture.example") {
    if (url.pathname === "/state") return Response.json(calls);
    const id = url.searchParams.get("id");
    if (!calls.some(call => call.id === id)) await new Promise(resolve => waiting.set(id, resolve));
    return new Response(null, { status: 204 });
  }
  const row = rows.find(row => request.headers.get("authorization") === "Bearer fixture-upstream-" + row.id);
  if (!row) return new Response("unknown fixture credential", { status: 401 });
  const body = await request.json(), call = { id: row.id, url: request.url, method: request.method, redirect: request.redirect, authorization: request.headers.get("authorization"), body, aborted: request.signal.aborted, canceled: false, expired: false };
  calls.push(call); waiting.get(row.id)?.(); waiting.delete(row.id);
  request.signal.addEventListener("abort", () => { call.aborted = true; }, { once: true });
  if (row.kind === "abort_headers") { await new Promise(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener("abort", resolve, { once: true }); }); return new Response(null, { status: 499 }); }
  if (row.kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://alternate.example/paid" } });
  if (row.kind === "error") return Response.json({ error: { message: "synthetic refusal" } }, { status: 429 });
  const frame = delta => ({ model: row.model, choices: [{ index: 0, delta, finish_reason: null }] });
  const encoded = audio[row.format];
  let wire = event(frame({ audio: { data: encoded.slice(0, 3), transcript: "café " } })) + event(frame({ audio: { data: encoded.slice(3), transcript: "synthetic music" } })) + event({ model: row.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + event({ choices: [], usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } }) + "data: [DONE]\\n\\n";
  if (row.kind === "empty") wire = event(frame({ audio: { transcript: "no audio" } })) + "data: [DONE]\\n\\n";
  if (row.kind === "eof") wire = wire.replace("data: [DONE]\\n\\n", "");
  if (row.kind === "json") wire = "data: {broken\\n\\n";
  if (row.kind === "base64") wire = event(frame({ audio: { data: "ZE==" } })) + "data: [DONE]\\n\\n";
  if (row.kind === "ambiguous") wire = event({ choices: [{}, {}] }) + "data: [DONE]\\n\\n";
  if (row.kind === "partial") wire = event({ choices: [{ delta: {}, finish_reason: "length" }] });
  if (row.kind === "wire") wire = ":" + "x".repeat(32 * 1024 * 1024) + "\\n\\n";
  if (row.kind === "audio") wire = event(frame({ audio: { data: "AAAA".repeat(Math.ceil((16 * 1024 * 1024 + 3) / 3)) } })) + "data: [DONE]\\n\\n";
  if (row.kind === "transcript") wire = event(frame({ audio: { data: encoded, transcript: "x".repeat(1024 * 1024 + 1) } })) + "data: [DONE]\\n\\n";
  const held = row.kind === "abort_body" || row.kind === "deadline_body";
  const bytes = row.kind === "utf8" ? new Uint8Array([255, 10]) : new TextEncoder().encode(held ? ": waiting\\n\\n" : wire);
  let offset = 0;
  return new Response(new ReadableStream({ type: "bytes", pull(controller) {
    if (offset < bytes.length) { const chunk = bytes.slice(offset, offset + 16384); offset += chunk.length; controller.enqueue(chunk); }
    else if (!held) controller.close();
  }, cancel() { call.canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
} };`;
}

async function start(route, audio) {
  const snapshot = compiled(route), temporary = await mkdtemp(join(tmpdir(), "clawrouter-openrouter-music-"));
  let mf;
  try {
    const require = createRequire(import.meta.resolve("wrangler/package.json"));
    let replacements = 0;
    const bundle = await require("esbuild").build({ stdin: { contents: routerScript(), resolveDir: root, sourcefile: "openrouter-music-fixture.ts", loader: "ts" },
      write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
      plugins: [{ name: "validated-music-snapshot", setup(build) { build.onLoad({ filter: /provider-snapshot\.json$/ }, args => {
        if (args.path !== snapshotPath) return; replacements++; return { contents: JSON.stringify(snapshot), loader: "json" };
      }); } }] });
    assert.equal(replacements, 1);
    mf = await startBundledWorkerdFixture(temporary, bundle.outputFiles[0].text, upstreamScript(audio), { directRouter: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const row of cases) {
      await kv.put(`policies/orm_${row.id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: row.kind === "foreign" ? ["openai"] : ["openrouter"],
        models: models.map(model => `openrouter/${model}`), tenantId: "fixture", monthlyBudgetMicros: 10000, requestCostMicros: row.kind === "unpriced" ? null : 700,
        grantRouting: { eligibleGrants: { openrouter: ["openrouter"] }, environmentFallback: false }, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/orm_${row.id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `orm_${row.id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/openrouter", JSON.stringify({ providerId: "openrouter", enabled: true }));
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    return { mf, origin, async close() {
      const failures = [];
      try { await mf.dispose(); } catch (error) { failures.push(error); }
      try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "fixture disposal failed");
    } };
  } catch (error) {
    const errors = [error];
    try { await mf?.dispose(); } catch (failure) { errors.push(failure); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (failure) { errors.push(failure); }
    throw errors.length === 1 ? error : new AggregateError(errors, "fixture acquisition and cleanup failed");
  }
}

async function retirement(origin) {
  const response = await fetch(origin + "/fixture/retire", { method: "POST" });
  assert.equal(response.status, 200, "original work must retire before disposal");
  const result = await response.json();
  assert.ok(result.joined.every(row => row.readers > 0 && row.operations > 0 && row.unlocked));
  return result;
}
async function usage(origin, id) {
  const response = await fetch(origin + "/v1/usage", { headers: headers(id) });
  assert.equal(response.status, 200); return response.json();
}
async function cleanup(f, failures) {
  try { await retirement(f.origin); } catch (error) { failures.push(error); }
  try { await f.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "music contract and cleanup failed");
}

test("all real manifests produce native-only shipping music and a single-setting manifest variant", () => {
  const native = compiled("native"), manifest = compiled("manifest");
  assert.equal(native.providers.find(p => p.id === "openrouter").endpoints.find(e => e.id === "music_generate").native_proxy, true);
  assert.equal(manifest.providers.find(p => p.id === "openrouter").endpoints.find(e => e.id === "music_generate").native_proxy, false);
});

for (const route of ["native", "manifest"]) {
  test(`real ${route} catalog, complete music, unknown-budget refusal and SQLite`, { timeout: 60000 }, async () => {
    const wav = Buffer.from(musicWave()).toString("base64"), f = await start(route, { wav, mp3: wav }), failures = [];
    try {
      const catalog = await (await fetch(f.origin + "/v1/catalog", { headers: headers("m0_wav") })).json();
      const offers = catalog.providers.find(p => p.id === "openrouter").offers.filter(offer => offer.endpoint === "music_generate");
      assert.ok(offers.every(offer => offer.routeKind === route));
      assert.deepEqual(offers.filter(offer => offer.modelId !== null).map(offer => offer.modelId).sort(), models.map(model => `openrouter/${model}`).sort());
      assert.ok(offers.filter(offer => offer.modelId !== null).every(offer => offer.eligible));
      if (route === "manifest") {
        // SDK497's uncorrected envelope is deliberately not rewritten by this
        // fixture. The real complete index distinguishes Google from OpenRouter.
        const refused = await fetch(f.origin + "/v1/proxy/openrouter/music_generate", { method: "POST", headers: headers("m0_mp3"), body: JSON.stringify({ body: body(positives[0]) }) });
        assert.equal(refused.status, 400); assert.equal((await refused.json()).error.code, "model_provider_mismatch");
        assert.deepEqual(await (await fetch(f.origin + "/fixture/state")).json(), []);
      }
      for (const row of positives.filter(row => row.format === "wav")) {
        const path = route === "native" ? "/v1/native/openrouter/v1/chat/completions" : "/v1/proxy/openrouter/music_generate";
        const request = body(row);
        const response = await fetch(f.origin + path, { method: "POST", headers: headers(row.id), body: JSON.stringify(route === "native" ? request : { body: { ...request, model: `openrouter/${row.model}` } }) });
        assert.equal(response.status, 200); const wire = await response.text(); assert.match(wire, /data: \[DONE\]/); assert.match(wire, /café/);
        await retirement(f.origin);
        const receipt = await usage(f.origin, row.id), [event] = receipt.usage.events;
        assert.equal(receipt.usage.events.length, 1); assert.equal(receipt.budget.spentMicros, 700);
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(event.status, "success");
        assert.equal(event.model, `openrouter/${row.model}`); assert.equal(event.capability, "music.generate");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
      }
      const before = await (await fetch(f.origin + "/fixture/state")).json(), request = body(cases.find(row => row.id === "unpriced"));
      const response = await fetch(f.origin + (route === "native" ? "/v1/native/openrouter/v1/chat/completions" : "/v1/proxy/openrouter/music_generate"), {
        method: "POST", headers: headers("unpriced"), body: JSON.stringify(route === "native" ? request : { body: { ...request, model: `openrouter/${request.model}` } }) });
      assert.equal((await response.json()).error.code, "pricing_required");
      assert.deepEqual(await (await fetch(f.origin + "/fixture/state")).json(), before);
      assert.equal((await usage(f.origin, "unpriced")).budget.spentMicros, 0);
    } catch (error) { failures.push(error); }
    await cleanup(f, failures);
  });
}

test("actual registered OpenRouter music client through both real configurations", { skip: !source, timeout: 600000 }, async t => {
  const mp3 = readFileSync(join(source, "test/fixtures/media/lyria-silence.mp3"));
  assert.equal(createHash("sha256").update(mp3).digest("hex"), "94bf451427043b32a9893976aefdea79d784323e5422f1f986fb22548615162b");
  for (const route of ["native", "manifest"]) {
    const audio = { wav: Buffer.from(musicWave()).toString("base64"), mp3: mp3.toString("base64") }, f = await start(route, audio), failures = [];
    try {
      await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-openrouter-music-contract.test.ts", import.meta.url),
        testPath: "src/agents/tools/worker-openrouter-music-contract.test.ts",
        env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_ROUTE: route, CLAWROUTER_CONTRACT_AUDIO: JSON.stringify(audio), CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases) } });
      const physical = await retirement(f.origin), calls = await (await fetch(f.origin + "/fixture/state")).json();
      assert.equal(physical.requests.filter(row => row.path === "/fixture/alternate").length, 0);
      for (const row of cases) {
        const matched = calls.filter(call => call.id === row.id), receipt = await usage(f.origin, row.id);
        if (unsent.has(row.kind)) { assert.equal(matched.length, 0, row.id); assert.equal(receipt.budget.spentMicros, 0, row.id); continue; }
        assert.equal(matched.length, 1, row.id); const [call] = matched;
        assert.equal(call.url, target); assert.equal(call.method, "POST"); assert.equal(call.redirect, "manual");
        assert.equal(call.authorization, `Bearer fixture-upstream-${row.id}`); assert.equal(call.body.model, row.model);
        assert.equal(call.body.stream, true); assert.equal(call.body.audio.format, row.format);
        if (row.kind.startsWith("abort") || row.kind === "deadline_body") { assert.ok(call.aborted || call.canceled); assert.equal(call.expired, false); }
        assert.equal(receipt.usage.events.length, 1); const [event] = receipt.usage.events;
        assert.equal(event.credential_id, `orm_${row.id}`); assert.equal(event.policy_id, `orm_${row.id}`);
        assert.equal(event.model, `openrouter/${row.model}`); assert.equal(event.provider, "openrouter"); assert.equal(event.capability, "music.generate");
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700); assert.equal(receipt.budget.spentMicros, 700);
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
        assert.equal(event.status, row.kind === "success" ? "success" : row.kind.startsWith("abort") || row.kind === "deadline_body" ? "client_error" : "provider_error");
      }
    } catch (error) { failures.push(error); }
    await cleanup(f, failures);
  }
});

test("reader observer joins the original cancel and rejects cleanup failure including undefined", async () => {
  const cause = new Error("owned cleanup failure");
  for (const reason of [cause, undefined]) {
    const response = new Response(new ReadableStream({ cancel() { return Promise.reject(reason); } }));
    const proof = {};
    observeBody(response, undefined, proof);
    const reader = response.body.getReader();
    const original = reader.cancel(reason);
    await assert.rejects(original, error => error === reason);
    reader.releaseLock();
    await assert.rejects(proof.join(), error => error instanceof AggregateError && error.errors.some(value => value === reason));
  }
});
