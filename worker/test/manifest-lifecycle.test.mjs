import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: handler } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");

const providerId = "manifest-lab";
const chatModel = `${providerId}/10-dialogue`, embedModel = `${providerId}/00-vector`;
const manifest = {
  schema: "clawrouter.service-provider.v1", id: providerId, displayName: "Manifest Lab", status: "stable", class: "openai_compatible",
  service: { platform: providerId, kind: "model_provider", configKeys: ["MANIFEST_LAB_API_KEY"] },
  auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
  baseUrls: { default: "https://manifest-upstream.example" },
  routing: { nativePrefixes: [`clawrouter-${providerId}`], modelPrefixes: [`${providerId}/`] },
  adapter: { request: "openai", response: "openai", stream: "openai_sse", error: "openai_error" },
  capabilities: [
    { id: "llm.chat", endpoint: "dialogue_port", methods: ["POST"] },
    { id: "llm.embeddings", endpoint: "vector_port", methods: ["POST"] },
    { id: "tool.invoke", endpoint: "lookup_port", methods: ["POST"] },
  ],
  endpoints: {
    dialogue_port: { path: "/lab/dialogue", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions" },
    vector_port: { path: "/lab/vector", requestFormat: "openai.embeddings", responseFormat: "openai.embeddings" },
    lookup_port: { path: "/lab/lookup", requestFormat: "manifest_lab.lookup", responseFormat: "manifest_lab.lookup" },
  },
  // The first model is deliberately incompatible with Chat and the model-free route.
  models: { entries: [
    { id: embedModel, upstream: "vector-native", capabilities: ["llm.embeddings"] },
    { id: chatModel, upstream: "dialogue-native", capabilities: ["llm.chat"] },
  ] },
  billing: { meter: "clawrouter.requests", dimensions: ["provider", "model", "key"] },
};

test("manifest-only add/remove reaches Worker discovery, session catalogs and every dispatch surface", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-manifest-lifecycle-"));
  const file = join(directory, "manifest-lab.provider.yaml");
  const files = readdirSync("providers").filter(file => file.endsWith(".provider.yaml")).sort().map(file => `providers/${file}`);
  const original = { ...snapshot };
  const fixture = await environment();
  const sent = [], events = [], pending = [];
  fixture.env.USAGE_QUEUE = { send: async event => events.push(event) };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).origin, manifest.baseUrls.default);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-upstream-key");
    const body = JSON.parse(init.body);
    sent.push({ path: new URL(url).pathname, body });
    return Response.json({ fixture: "delivered", usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  async function call(path, body, mode = "key") {
    const response = await handler.fetch(new Request(`https://router.example${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...fixture.headers[mode], "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), fixture.env, { waitUntil: promise => pending.push(promise) });
    const result = await response.json();
    await Promise.all(pending.splice(0));
    return { status: response.status, body: result };
  }
  async function inventory(added) {
    const providers = await call("/v1/providers"), routes = await call("/v1/routes");
    assert.equal(providers.status, 200);
    assert.deepEqual(providers.body, snapshot);
    const native = routes.body.manifestProxy.filter(route => route.provider === providerId);
    const unified = routes.body.openaiCompatible.find(route => route.provider === providerId);
    if (added) {
      assert.deepEqual(native.map(route => [route.endpoint, route.sampleModel, route.models.map(model => model.id)]), [
        ["dialogue_port", chatModel, [chatModel]], ["lookup_port", null, []], ["vector_port", embedModel, [embedModel]],
      ]);
      assert.deepEqual(unified.models.map(model => [model.id, model.endpoints]), [[embedModel, ["/v1/embeddings"]], [chatModel, ["/v1/chat/completions"]]]);
    } else { assert.deepEqual(native, []); assert.equal(unified, undefined); }
    for (const mode of ["key", "session"]) {
      const catalog = await call("/v1/catalog", undefined, mode), models = await call("/v1/models", undefined, mode);
      assert.equal(catalog.status, 200); assert.equal(models.status, 200);
      const provider = catalog.body.providers.find(provider => provider.id === providerId);
      assert.deepEqual(models.body.data.map(model => model.id), added ? [embedModel, chatModel] : []);
      if (added) {
        assert.equal(provider.executable, true);
        assert.deepEqual(provider.models.map(model => [model.id, model.capabilities]), [[embedModel, ["llm.embeddings"]], [chatModel, ["llm.chat"]]]);
        assert.deepEqual(provider.routes.map(route => route.endpoint), ["dialogue_port", "lookup_port", "vector_port"]);
      } else assert.equal(provider, undefined);
    }
    for (const surface of ["session", "entitlements"]) {
      const result = await call(`/v1/${surface}`, undefined, "session");
      assert.equal(result.status, 200);
      assert.equal(result.body.entitlementsError, undefined);
      const rows = result.body.entitlements?.providers ?? result.body.providers;
      const provider = rows.find(row => row.provider === providerId);
      if (added) { assert.equal(provider.allowed, true); assert.equal(provider.readiness.executable, true); }
      else assert.equal(provider, undefined);
    }
  }
  const dispatches = [
    ["/v1/chat/completions", { model: chatModel, messages: [] }, "/lab/dialogue", { model: "dialogue-native", messages: [] }],
    ["/v1/embeddings", { model: embedModel, input: "fixture" }, "/lab/vector", { model: "vector-native", input: "fixture" }],
    [`/v1/native/${providerId}/lab/dialogue`, { model: "dialogue-native", messages: [] }, "/lab/dialogue", { model: "dialogue-native", messages: [] }],
    [`/v1/native/${providerId}/lab/vector`, { model: "vector-native", input: "fixture" }, "/lab/vector", { model: "vector-native", input: "fixture" }],
    [`/v1/proxy/${providerId}/dialogue_port`, { body: { model: chatModel, messages: [] } }, "/lab/dialogue", { model: "dialogue-native", messages: [] }],
    [`/v1/proxy/${providerId}/vector_port`, { body: { model: embedModel, input: "fixture" } }, "/lab/vector", { model: "vector-native", input: "fixture" }],
    [`/v1/native/${providerId}/lab/lookup`, { query: "fixture" }, "/lab/lookup", { query: "fixture" }],
    [`/v1/proxy/${providerId}/lookup_port`, { body: { query: "fixture" } }, "/lab/lookup", { query: "fixture" }],
  ];
  async function absentDispatches() {
    const before = sent.length;
    for (const [path, body] of dispatches) {
      const result = await call(path, body);
      assert.equal(result.status, 404, path);
      assert.equal(result.body.error.code, path.includes("/proxy/") ? "route_not_found" : path.includes("/native/") ? "provider_not_found" : "model_not_found", path);
    }
    assert.equal(sent.length, before, "removed routes must not dispatch using retained policy or credentials");
  }
  try {
    const controlText = compile(files), control = JSON.parse(controlText);
    Object.assign(snapshot, control);
    await inventory(false); await absentDispatches();
    writeFileSync(file, JSON.stringify(manifest));
    const addedText = compile([...files, file]), added = JSON.parse(addedText);
    assert.equal(compile([file, ...files.toReversed()]), addedText, "compiler ordering is independent of CLI argument order");
    assert.equal(added.providers.length, control.providers.length + 1);
    const additions = Object.fromEntries(Object.entries(added.model_index).filter(([id]) => id.startsWith(`${providerId}/`)));
    assert.deepEqual(Object.keys(additions), [embedModel, chatModel]);
    for (const [capability, endpoint] of [["llm.chat", "dialogue_port"], ["llm.embeddings", "vector_port"], ["tool.invoke", "lookup_port"]]) {
      assert.deepEqual(added.capability_index[capability].filter(row => row.provider === providerId), [{ provider: providerId, endpoint, methods: ["POST"] }]);
    }
    Object.assign(snapshot, added);
    await inventory(true);
    assert.equal(sent.length, 0, "catalog and session discovery never call upstream");
    for (const [path, body, upstreamPath, upstreamBody] of dispatches) {
      const result = await call(path, body);
      assert.equal(result.status, 200, path);
      assert.equal(result.body.fixture, "delivered");
      assert.deepEqual(sent.at(-1), { path: upstreamPath, body: upstreamBody });
      assert.equal(events.at(-1).provider, providerId);
      if (upstreamPath === "/lab/lookup") assert.equal(events.at(-1).model, null, "model-free operations cannot borrow the first catalog model");
    }
    const before = sent.length;
    for (const [path, body] of [
      ["/v1/chat/completions", { model: embedModel }], ["/v1/embeddings", { model: chatModel }],
      [`/v1/native/${providerId}/lab/dialogue`, { model: "vector-native" }],
      [`/v1/native/${providerId}/lab/vector`, { model: "dialogue-native" }],
      [`/v1/proxy/${providerId}/dialogue_port`, { body: { model: embedModel } }],
      [`/v1/proxy/${providerId}/vector_port`, { body: { model: chatModel } }],
      [`/v1/proxy/${providerId}/lookup_port`, { body: { model: embedModel } }],
    ]) {
      const result = await call(path, body);
      assert.equal(result.status, 400, path);
      assert.equal(result.body.error.code, "model_capability_unsupported");
    }
    assert.equal(sent.length, before, "incompatible models are rejected before upstream dispatch");
    rmSync(file);
    const removedText = compile(files);
    assert.equal(removedText, controlText, "removal restores every compiled provider and index byte");
    Object.assign(snapshot, JSON.parse(removedText));
    await inventory(false); await absentDispatches();
    assert.equal(sent.length, dispatches.length, "removal discovery and rejected calls add no egress");
  } finally {
    // Node's test runner isolates this file. Restore its shared imported object
    // even on failure; neither production code nor the generated file is changed.
    Object.assign(snapshot, original);
    rmSync(directory, { recursive: true, force: true });
  }
});

function compile(files) {
  return execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...files], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: "pipe" });
}

async function environment() {
  const secret = "fixture-manifest-proxy", session = "c".repeat(64), email = "fixture@example.com";
  const policy = { enabled: true, generation: "g1", providers: [providerId], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: 0, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const records = new Map([[`local/sessions/${await sha256Hex(session)}`, { email, role: "user", expiresAtMs: Date.now() + 60_000 }]]);
  const env = {
    MANIFEST_LAB_API_KEY: "fixture-upstream-key", CLAWROUTER_LOCAL_AUTH: "enabled",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(item => [item, records.get(item) ?? null])) : records.get(key) ?? null; },
      async list({ prefix }) { return { keys: [...records.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [{ email, record: { enabled: true, role: "user", tenantId: "default", groups: [] } }], missingEmails: [] });
      if (path === "/resolve") return Response.json({ initialized: true, bindings: [{ policyId: "fixture", priority: 0, enabled: true, principalType: "user", principalId: email }], missingPrincipals: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: body.providerIds.map(providerId => ({ providerId, enabled: true, monthlyBudgetMicros: null })), missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`unexpected authority call: ${path}`);
    } }) },
  };
  return { env, headers: { key: { authorization: `Bearer clawrouter-live-fixture-${secret}` }, session: { cookie: `clawrouter_session=${session}` } } };
}
