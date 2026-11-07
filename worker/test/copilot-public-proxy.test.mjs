import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { copilotPublicEndpoint, copilotPublicInferenceInput, copilotPublicRelay, CopilotPublicOwner, copilotPublicRegistry, copilotPublicObservation, decodeCopilotPublicObservation } = await import("../copilot-public-proxy.ts");
const { copilotPrivateCandidate, grantCredentialPresent } = await import("../grant-eligibility.ts");
const { snapshot } = await import("../providers.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { validateSelectedInput } = await import("../proxy-selection.ts");
const { operationAffordability } = await import("../operation-budget.ts");
const MiB = 1024 * 1024;
const formats = ["openai.chat_completions", "openai.responses", "anthropic.messages"];
const paths = ["/chat/completions", "/responses", "/messages"], capabilities = ["llm.chat", "llm.responses", "llm.messages"];
const profile = { integrationId: "fixture", editorVersion: "Fixture/1", editorPluginVersion: "Fixture/1", userAgent: "Fixture/1", initiator: "agent" };
function provider() {
  const source = structuredClone(snapshot.providers.find(row => row.id === "openai"));
  // Reuse the wire template, not OpenAI's provider-specific product identity.
  delete source.products; delete source.offer_definitions;
  const endpoint = source.endpoints.find(row => row.request_format === formats[0]);
  return { ...source, id: "github-copilot", config_keys: [], optional_config_keys: [], auth: { schemes: [{ type: "oauth", tokenRef: "copilot" }], authorization: null, refresh: null, grantTransports: {} }, routing: { ...source.routing, modelPrefixes: ["github-copilot/"] },
    endpoints: formats.map((format, i) => ({ ...endpoint, id: "api_" + i, path: paths[i], request_format: format, response_format: format,
      method: "POST", methods: ["POST"], native_proxy: true, streaming: "sse", path_params: [], query: {}, headers: {},
      auth: undefined, upstreamPath: undefined, websocket: undefined, lifecycle: undefined, responsesLifecycle: undefined, modelPassthrough: undefined })),
    capabilities: capabilities.map((id, i) => ({ id, endpoint: "api_" + i, methods: ["POST"] })),
    models: [{ id: "github-copilot/fixture-model", upstream: "fixture-model", capabilities, pricing_ref: null, pricing: null }] };
}
function seed(p, i, mode = "native") {
  return { route: { mode, endpointId: p.endpoints[i].id, path: mode === "native" ? "/v1/native/github-copilot" + paths[i] : "/v1/proxy/github-copilot/api_" + i },
    attestation: { revision: crypto.randomUUID(), profile }, selected: { key: "oauth/fixture/copilot", expectedGeneration: 3,
      expectedLineage: "original-lineage-fixture", deviceAttemptId: "original-device-fixture", accountAttemptId: "original-account-fixture",
      runtimeIdentity: { ownerBinding: "a".repeat(64), ...profile }, deadline: Date.now() + 30000,
      authorization: { kind: "public", binding: { proof: {} } } } };
}

for (const [i, format] of formats.entries()) test("public Copilot exact endpoint " + format, () => {
  const p = provider(), endpoint = p.endpoints[i];
  assert.equal(copilotPublicEndpoint(p, endpoint), format);
  for (const patch of [{ path: "/v1" + paths[i] }, { query: { override: "x" } }, { path_params: ["model"] },
    { headers: { authorization: "forged" } }, { upstreamPath: "/foreign" }, { method: "GET" }, { methods: ["POST", "GET"] },
    { response_format: "openai.models" }, { modelPassthrough: true }, { websocket: "openai.responses" }]) {
    assert.throws(() => copilotPublicEndpoint(p, { ...endpoint, ...patch }));
  }
  assert.throws(() => copilotPublicEndpoint({ ...p, id: "copilot" }, endpoint));
  assert.throws(() => copilotPublicEndpoint({ ...p, capabilities: [{ id: "llm.chat", endpoint: "foreign" }] }, endpoint));
  assert.throws(() => copilotPublicEndpoint({ ...p, capabilities: [...p.capabilities, p.capabilities[i]] }, endpoint));
});

for (const mode of ["native", "manifest"]) for (const [i, format] of formats.entries()) test("public preparation retains exact capability and model: " + mode + "/" + format, async t => {
  const p = provider(); snapshot.providers.push(p); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(p), 1));
  const selected = seed(p, i, mode), body = { model: mode === "native" ? "fixture-model" : "github-copilot/fixture-model", stream: true,
    ...(i === 1 ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }), ...(i === 2 ? { max_tokens: 128 } : {}) };
  const prepared = await copilotPublicInferenceInput(mode === "native" ? body : { body }, selected, {});
  assert.equal(prepared.body.model, "fixture-model");
  assert.equal(prepared.accountingSelection.capability, capabilities[i]);
  assert.equal(prepared.accountingSelection.endpoint, p.endpoints[i]);
  assert.equal(prepared.accountingSelection.model.id, p.models[0].id);
  assert.equal(prepared.context.initiator, "agent");
  assert.equal(prepared.selected.selection.format, format);
  await assert.rejects(copilotPublicInferenceInput(mode === "native" ? { ...body, model: "undeclared" } : { body: { ...body, model: "openai/foreign" } }, selected, {}));
  if (mode === "manifest") for (const patch of [{ pathParams: { model: "foreign" } }, { query: { override: true } }, { method: "GET" }, { runtimeIdentity: profile }]) {
    await assert.rejects(copilotPublicInferenceInput({ body, ...patch }, selected, {}));
  }
  assert.throws(() => validateSelectedInput(prepared.accountingSelection), /owner-bound/);
});

test("inactive Copilot candidate never becomes a generic credential or borrowed credential", () => {
  const grant = { provider: "github-copilot", enabled: true, kind: "oauth", credentialStore: "durable_object",
    credentialStatus: "reauth_required", credentialGeneration: 3, credentialLineage: "original-lineage-fixture" };
  assert.equal(copilotPrivateCandidate(grant), true); assert.equal(grantCredentialPresent(grant), false);
  for (const patch of [{ provider: "copilot" }, { kind: "api_key" }, { enabled: false }, { credentialGeneration: 0 },
    { credentialLineage: "short" }, { credentialStore: "kv" }, { credentialStatus: "active" }, { credential: "foreign" },
    { accessToken: "foreign" }, { hasAccessToken: true }, { refreshToken: "foreign" }]) assert.equal(copilotPrivateCandidate({ ...grant, ...patch }), false);
});

test("private owner selection nominates only explicit current policy references without generic materialization", async () => {
  const { resolveGrantCandidates } = await import("../grant-selection.ts");
  const grant = { provider: "github-copilot", enabled: true, kind: "oauth", credentialStore: "durable_object",
    credentialStatus: "reauth_required", credentialGeneration: 3, credentialLineage: "original-lineage-fixture" };
  const records = new Map([["oauth/fixture/explicit", grant], ["oauth/foreign/explicit", grant]]), requested = [];
  const env = { ACCESS_CONTROL: { idFromName: name => name, get: () => ({ async fetch(url, init) {
    assert.equal(new URL(url).pathname, "/grant-pools/resolve"); const body = JSON.parse(init.body);
    assert.ok(body.defaultKeys.every(key => key.startsWith("oauth/fixture/") || key.startsWith("oauth/tenants/default/")));
    return Response.json({ keys: [], states: {} });
  } }) }, POLICY_KV: { async get(keys) { assert.ok(keys.length <= 64); requested.push(...keys); return new Map(keys.map(key => [key, records.get(key) ?? null])); } } };
  const routing = { eligibleGrants: { "github-copilot": ["explicit", "../foreign"] } };
  const privateRows = await resolveGrantCandidates("github-copilot", "fixture", "default", "copilot", env, new Set(), routing, undefined, undefined, undefined, true);
  assert.deepEqual(privateRows.available.map(row => row.key), ["oauth/fixture/explicit"]);
  assert.ok(!requested.includes("oauth/foreign/explicit")); assert.ok(!requested.some(key => key.includes("..")));
  const generic = await resolveGrantCandidates("github-copilot", "fixture", "default", "copilot", env, new Set(), routing);
  assert.deepEqual(generic.available, []); assert.equal(grantCredentialPresent(grant), false);
});

test("frontend relay keeps original read and FIRST cancel ownership independently", async t => {
  const read = Promise.withResolvers(), cancel = Promise.withResolvers(), entered = Promise.withResolvers();
  let cancels = 0, unlocks = 0, locked = false, retired = false;
  const original = { get locked() { return locked; }, getReader(options) {
    assert.equal(options.mode, "byob"); locked = true;
    return { read() { entered.resolve(); return read.promise; }, cancel() { cancels++; return cancel.promise; }, releaseLock() { unlocks++; locked = false; } };
  } };
  const operation = new HttpOperation(), relay = copilotPublicRelay(original, operation, 256 * 1024), allocation = new BodyLease();
  assert.ok(allocation.grow(48 * MiB));
  const reader = relay.stream.getReader(), pending = reader.read(); void pending.catch(() => undefined);
  t.after(async () => { cancel.resolve(); read.reject(new Error("fixture cleanup")); await relay.discard().catch(() => undefined); reader.releaseLock(); allocation.release(); });
  await entered.promise;
  const physical = relay.retired.finally(() => { retired = true; allocation.release(); }); void physical.catch(() => undefined);
  await reader.cancel(); await reader.cancel();
  assert.equal(cancels, 1); assert.equal(retired, false); assert.equal(bodyBudgetCharged(), 96 * MiB);
  const other = new BodyLease(); assert.equal(other.grow(MiB), false); other.release();
  cancel.resolve(); await Promise.resolve(); assert.equal(unlocks, 0);
  read.reject(new Error("original read aborted")); await physical.catch(() => undefined);
  reader.releaseLock(); assert.equal(unlocks, 1); assert.equal(locked, false); assert.equal(bodyBudgetCharged(), 0);
});

test("frontend relay bounds original backing, counts EMPTY plus EOF and preserves final bytes", async () => {
  for (const mode of ["exact", "too-many", "backing", "final-bytes"]) {
    const operation = new HttpOperation(); let reads = 0, cancels = 0, unlocks = 0, locked = false;
    const original = { get locked() { return locked; }, getReader() { locked = true; return {
      async read(view) { reads++;
        if (mode === "backing") return { done: false, value: new Uint8Array(32768).subarray(0, 1) };
        if (mode === "final-bytes") { view[0] = 42; return { done: true, value: view.subarray(0, 1) }; }
        return { done: reads === (mode === "exact" ? 8192 : 8193), value: view.subarray(0, 0) };
      }, async cancel() { cancels++; }, releaseLock() { unlocks++; locked = false; },
    }; } };
    const relay = copilotPublicRelay(original, operation, 256 * 1024);
    const consuming = new Response(relay.stream).arrayBuffer();
    if (mode === "exact") assert.equal((await consuming).byteLength, 0);
    else if (mode === "final-bytes") assert.deepEqual([...new Uint8Array(await consuming)], [42]);
    else await assert.rejects(consuming);
    await relay.retired.catch(() => undefined); operation.stop("complete");
    assert.equal(unlocks, 1); assert.equal(locked, false); assert.equal(cancels, ["exact", "final-bytes"].includes(mode) ? 0 : 1);
    if (mode === "too-many") assert.equal(reads, 8192);
  }
});

test("owner continuation reserves once before intake and retires only after frontend and reply EOF", async () => {
  const retained = [], seen = [], p = provider(), selected = seed(p, 0);
  const value = { id: "a".repeat(32), key: selected.selected.key, expectedGeneration: 3, expectedLineage: selected.selected.expectedLineage,
    deadline: Date.now() + 30000, authorization: selected.selected.authorization, route: selected.route };
  const headers = { "content-type": "application/json", "x-clawrouter-copilot-public-id": value.id,
    "x-clawrouter-copilot-public-key": value.key, "x-clawrouter-copilot-deadline": String(value.deadline) };
  const owner = new CopilotPublicOwner({ async begin() { seen.push("begin"); assert.equal(bodyBudgetCharged(), 96 * MiB); },
    async prepare() { seen.push("prepare"); return selected; }, async execute() { throw Error("unclaimed fixture must not execute"); },
    async close() { seen.push("close"); }, retain(work) { retained.push(work); } });
  const response = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/reserve", { method: "POST", headers, body: JSON.stringify(value) }));
  assert.equal(response.status, 200); assert.deepEqual(seen, ["begin", "prepare"]);
  await response.json(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  const duplicate = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/reserve", { method: "POST", headers, body: JSON.stringify(value) }));
  assert.equal(duplicate.status, 409); await duplicate.arrayBuffer();
  const acknowledgment = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/retire", { method: "POST", headers }));
  assert.equal(bodyBudgetCharged(), 96 * MiB); await acknowledgment.json(); await Promise.all(retained);
  assert.equal(bodyBudgetCharged(), 0); assert.deepEqual(seen, ["begin", "prepare", "close"]);
});


test("aborted public execution disposes its unpublished owner reply before physical admission retirement", async t => {
  const retained = [], selected = seed(provider(), 0), entered = Promise.withResolvers(), reading = Promise.withResolvers();
  const abort = new AbortController(); let cancels = 0, originalResponse, ended = false, acknowledged = false;
  const value = { id: "b".repeat(32), key: selected.selected.key, expectedGeneration: 3, expectedLineage: selected.selected.expectedLineage,
    deadline: Date.now() + 30000, authorization: selected.selected.authorization, route: selected.route };
  const headers = { "content-type": "application/json", "x-clawrouter-copilot-public-id": value.id,
    "x-clawrouter-copilot-public-key": value.key, "x-clawrouter-copilot-deadline": String(value.deadline) };
  const owner = new CopilotPublicOwner({ async begin() {}, async prepare() { return selected; }, async close() {},
    retain(work) { retained.push(work); },
    async execute(request, _seed, admission, retired, completed) {
      originalResponse = await admission.execute(request, {}, {
        retain(work) { retained.push(work); },
        async begin(operation) { entered.resolve(); await reading.promise; operation.signal.throwIfAborted(); },
        async qualify() { throw Error("aborted input must not qualify"); }, async post() { throw Error("aborted input must not dispatch"); },
        async revalidate() {}, async end() { await retired; ended = true; completed(); },
      });
      const getReader = originalResponse.body.getReader.bind(originalResponse.body);
      originalResponse.body.getReader = options => {
        const reader = getReader(options);
        return { read: () => reader.read(), cancel(reason) { cancels++; return reader.cancel(reason); }, releaseLock: () => reader.releaseLock() };
      };
      return originalResponse;
    },
  });
  const reserve = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/reserve", { method: "POST", headers, body: JSON.stringify(value) }));
  assert.equal(reserve.status, 200); await reserve.json();
  const execution = owner.fetch(new Request("https://clawrouter.internal/copilot-public/execute", { method: "POST", headers, body: "{}", signal: abort.signal }));
  t.after(async () => {
    reading.resolve(); abort.abort(); await execution;
    if (originalResponse?.body && !originalResponse.bodyUsed && !originalResponse.body.locked) await originalResponse.body.cancel();
    if (!acknowledged) await (await owner.fetch(new Request("https://clawrouter.internal/copilot-public/retire", { method: "POST", headers }))).arrayBuffer();
    await Promise.allSettled(retained);
  });
  await entered.promise; abort.abort();
  const reply = await execution;
  assert.equal(reply.status, 503); assert.equal(reply.body, null); assert.equal(cancels, 1);
  assert.equal(originalResponse.bodyUsed, true); assert.equal(originalResponse.body.locked, false);
  assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(ended, false);
  const ack = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/retire", { method: "POST", headers }));
  await ack.json(); acknowledged = true; assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(ended, false);
  const other = new BodyLease(); assert.equal(other.grow(MiB), false); other.release();
  reading.resolve(); await Promise.all(retained);
  assert.equal(ended, true); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 0);
});

for (const phase of ["reserve", "observe"]) test("aborted discovery " + phase + " disposes its unpublished reply and joins original work", async t => {
  const retained = [], selected = seed(provider(), 0), entered = Promise.withResolvers(), physical = Promise.withResolvers();
  selected.route = { mode: "catalog", endpointId: "catalog", path: "/v1/catalog" };
  selected.registryDigest = "0".repeat(64);
  const abort = new AbortController(); let closed = 0, acknowledged = false;
  const value = { id: "c".repeat(32), key: selected.selected.key, expectedGeneration: 3, expectedLineage: selected.selected.expectedLineage,
    deadline: Date.now() + 30000, authorization: selected.selected.authorization, route: selected.route, registryDigest: selected.registryDigest };
  const headers = { "content-type": "application/json", "x-clawrouter-copilot-public-id": value.id,
    "x-clawrouter-copilot-public-key": value.key, "x-clawrouter-copilot-deadline": String(value.deadline) };
  const owner = new CopilotPublicOwner({ async begin() {},
    async prepare(_input, operation) { if (phase === "reserve") { entered.resolve(); await physical.promise; operation.signal.throwIfAborted(); } return selected; },
    async observe(_seed, operation) { entered.resolve(); await physical.promise; operation.signal.throwIfAborted(); throw Error("aborted catalog must not publish"); },
    async execute() { throw Error("catalog must not execute"); }, async close() { closed++; }, retain(work) { retained.push(work); },
  });
  let pending = owner.fetch(new Request("https://clawrouter.internal/copilot-public/catalog-reserve", {
    method: "POST", headers, body: JSON.stringify(value), ...(phase === "reserve" ? { signal: abort.signal } : {}),
  }));
  if (phase === "observe") { await (await pending).json(); pending = owner.fetch(new Request("https://clawrouter.internal/copilot-public/observe", { method: "POST", headers, signal: abort.signal })); }
  t.after(async () => {
    physical.resolve(); abort.abort(); const response = await pending;
    if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel();
    if (!acknowledged) await (await owner.fetch(new Request("https://clawrouter.internal/copilot-public/retire", { method: "POST", headers }))).arrayBuffer();
    await Promise.allSettled(retained);
  });
  await entered.promise; abort.abort(); const response = await pending;
  assert.equal(response.status, phase === "reserve" ? 503 : 409); assert.equal(response.body, null);
  assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(closed, 0);
  const acknowledgment = await owner.fetch(new Request("https://clawrouter.internal/copilot-public/retire", { method: "POST", headers }));
  await acknowledgment.json(); acknowledged = true;
  assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(closed, 0);
  const other = new BodyLease(); assert.equal(other.grow(MiB), false); other.release();
  physical.resolve(); await Promise.all(retained);
  assert.equal(bodyBudgetCharged(), 0); assert.equal(closed, 1);
});

test("compact discovery binds exact compiled tariff/route identity and current policy", async () => {
  const { copilotDiscoveryPieces } = await import("../discovery.ts");
  const p = provider(), registry = await copilotPublicRegistry(p), selected = seed(p, 0);
  selected.selected.authorization.binding = { policyId: "fixture", credentialId: "fixture", principalId: null, proof: {} };
  const policy = { enabled: true, generation: "g1", providers: [p.id], models: null, requestCostsMicros: { "llm.chat": 700, "llm.responses": 1100, "llm.messages": 1300 } };
  const connection = { providerId: p.id, enabled: true }, rows = [{ id: "fixture-model", policy: { state: "enabled" }, model_picker_enabled: true, supported_endpoints: paths }];
  const packet = copilotPublicObservation(registry, selected, rows, policy, connection, Date.now(), operationAffordability);
  assert.ok(packet.buffer.byteLength <= 2048);
  const observation = decodeCopilotPublicObservation(packet, registry, selected.attestation.revision, selected.selected.deadline);
  assert.ok([0, 1, 2].every(api => observation.permits(0, api)));
  const view = { registry, observation, policy, connection, auth: { authType: "proxy_key", credentialId: "fixture", principalId: null, policyId: "fixture", policy, contentRetentionDisabled: true } };
  const pieces = [...copilotDiscoveryPieces(view, "catalog")];
  assert.ok(pieces.every(piece => Buffer.byteLength(piece) <= 16384));
  const catalog = JSON.parse(pieces.join(""));
  assert.equal(catalog.providers[0].models.length, 1); assert.equal(catalog.providers[0].offers.length, 3);
  assert.ok(catalog.providers[0].offers.every(offer => offer.eligible && offer.routeKind === "native"));
  assert.equal(catalog.providers[0].openaiCompatible, false);
  assert.equal(catalog.providers[0].models[0].pricing, null);
  const tightened = JSON.parse([...copilotDiscoveryPieces({ ...view, policy: { ...policy, models: [] } }, "catalog")].join(""));
  assert.deepEqual(tightened.providers[0].offers, []);
  const changed = structuredClone(p); changed.models[0].pricing_ref = "changed-tariff";
  assert.notEqual((await copilotPublicRegistry(changed)).digest, registry.digest);
  assert.throws(() => decodeCopilotPublicObservation(packet, { ...registry, digest: "0".repeat(64) }, selected.attestation.revision, selected.selected.deadline));
  assert.throws(() => decodeCopilotPublicObservation(packet, registry, crypto.randomUUID(), selected.selected.deadline));
  const denied = copilotPublicObservation(registry, selected, rows, { ...policy, requestCostsMicros: null, monthlyBudgetMicros: 1 }, connection, Date.now(), operationAffordability);
  assert.ok([0, 1, 2].every(api => !decodeCopilotPublicObservation(denied, registry, selected.attestation.revision, selected.selected.deadline).permits(0, api)));
});

test("maximum compact discovery remains finite and output overflow is detectable before streaming", async () => {
  const { copilotDiscoveryPieces } = await import("../discovery.ts");
  const p = provider(); p.models = Array.from({ length: 4096 }, (_, i) => ({ id: "github-copilot/" + i + "x".repeat(240), upstream: i + "x".repeat(240), capabilities, pricing_ref: null, pricing: null }));
  const registry = await copilotPublicRegistry(p), selected = seed(p, 0);
  selected.selected.authorization.binding = { policyId: "fixture", credentialId: "fixture", principalId: null, proof: {} };
  const policy = { enabled: true, generation: "g1", providers: [p.id], models: null, requestCostMicros: 700 }, connection = { providerId: p.id, enabled: true };
  const packet = copilotPublicObservation(registry, selected, p.models.map(model => ({ id: model.upstream, policy: { state: "enabled" }, model_picker_enabled: true, supported_endpoints: paths })), policy, connection, Date.now(), operationAffordability);
  assert.equal(packet.byteLength, 1611);
  const observation = decodeCopilotPublicObservation(packet, registry, selected.attestation.revision, selected.selected.deadline);
  assert.equal(observation.permits(4095, 2), true);
  let size = 0;
  for (const piece of copilotDiscoveryPieces({ registry, observation, policy, connection, auth: { authType: "proxy_key", credentialId: "fixture", principalId: null, policyId: "fixture", policy, contentRetentionDisabled: true } }, "catalog")) {
    assert.ok(Buffer.byteLength(piece) <= 16384); size += Buffer.byteLength(piece);
    if (size > 4 * MiB) break;
  }
  assert.ok(size > 4 * MiB);
});
