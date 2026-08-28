import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const { privateSubscriptionBody } = await import("../private-codex.ts");

const target = "SYNTHETIC_PRIVATE_TARGET_7Q";
const accessToken = "SYNTHETIC_SUBSCRIPTION_TOKEN_4P";
const accountId = "SYNTHETIC_ACCOUNT_9R";
const credential = "private-workload-SYNTHETIC_WORKLOAD_CREDENTIAL_0123456789";
const alias = "codex-latest";
const enc = new TextEncoder();
const fixture = () => ({ version: 1, target, accessToken, accountId, expiresAt: Date.now() + 3600_000 });
const workloadPolicy = async () => ({ version: 1, enabled: true, alias: { id: alias, name: "Codex (Latest)" }, auth: { mode: "workload", credentialSha256: await sha256Hex(credential) } });

async function environment() {
  const state = { policy: await workloadPolicy(), upstream: fixture(), policyReads: 0, secretReads: 0, genericReads: [] };
  const env = new Proxy({
    PRIVATE_CODEX_POLICY: { get: async () => { state.policyReads++; return JSON.stringify(state.policy); } },
    PRIVATE_CODEX_UPSTREAM: { get: async () => { state.secretReads++; return JSON.stringify(state.upstream); } },
  }, { get(object, key) {
    if (Object.hasOwn(object, key)) return object[key];
    state.genericReads.push(key);
    throw new Error(`SYNTHETIC_FORBIDDEN_GENERIC_BINDING_${String(key)}`);
  } });
  return { env, state };
}

function request(path = "/private/v1/responses", options = {}) {
  const method = options.method ?? (path.endsWith("/responses") ? "POST" : "GET");
  return new Request(`https://private.example.invalid${path}`, {
    method, signal: options.signal,
    headers: { authorization: `Bearer ${credential}`, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...options.headers },
    ...(method === "POST" ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? { model: alias, input: "SYNTHETIC_INPUT", store: false }) } : {}),
  });
}
const run = (req, env) => worker.fetch(req, env, { waitUntil() { assert.fail("Private work must not enqueue accounting or retention"); } });
const responseObject = (extra = {}) => ({ id: "synthetic-response", object: "response", model: target, status: "completed", output: [], ...extra });
const jsonResponse = (extra = {}, headers = {}) => Response.json(responseObject(extra), { headers });
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const textDelta = (delta, extra = {}) => ({ type: "response.output_text.delta", item_id: "synthetic-item", output_index: 0, content_index: 0, delta, ...extra });
const completed = (extra = {}) => ({ type: "response.completed", response: responseObject(extra) });
function sse(events, chunkSize = 19, ending = true) {
  const text = events.map((event) => typeof event === "string" ? event : frame(event)).join("") + (ending ? "data: [DONE]\n\n" : "");
  const bytes = enc.encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + chunkSize);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { "content-type": "text/event-stream", "x-synthetic-secret": target } });
}
function assertContained(text) {
  for (const secret of [target, accessToken, accountId]) assert.equal(text.includes(secret), false);
}
async function withFetch(mock, action) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test("private unauthorized callers are indistinguishable; no target resolution or upstream call", async () => {
  const { env, state } = await environment();
  const attempts = [
    {}, { authorization: "Bearer SYNTHETIC_ADMIN_TOKEN" }, { authorization: "Bearer clawrouter-live-synthetic-key-secret" },
    { "x-api-key": credential }, { cookie: "clawrouter_session=SYNTHETIC_LOCAL_LOGIN" },
    { "cf-access-authenticated-user-email": "owner@example.invalid", "x-user-id": "synthetic-owner", "session-id": "synthetic-owner-session" },
    { authorization: `Bearer ${credential}`, "x-api-key": "synthetic-shared" },
    { authorization: `Bearer ${credential}`, "cf-access-jwt-assertion": "synthetic.forged.jwt" },
    { authorization: `Bearer ${credential}`, "cf-access-client-secret": "synthetic" },
  ];
  await withFetch(() => assert.fail("Unauthorized upstream fetch"), async () => {
    for (const headers of attempts) {
      for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses", "/private/v1/unknown"]) {
        const req = request(path); req.headers.delete("authorization");
        for (const [key, value] of Object.entries(headers)) req.headers.set(key, value);
        const result = await run(req, env);
        assert.equal(result.status, 404);
        assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
      }
    }
  });
  assert.equal(state.secretReads, 0);
  assert.deepEqual(state.genericReads, []);
});

test("provider, admin and proxy bearers cannot authenticate even with a matching workload digest", async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwtShaped = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: "synthetic-owner", account_id: accountId })}.${encode("synthetic-signature")}`;
  await withFetch(() => assert.fail("Non-workload bearer reached a network endpoint"), async () => {
    for (const token of [accessToken, jwtShaped, "SYNTHETIC_ADMIN_TOKEN", "clawrouter-live-synthetic-key-secret"]) {
      for (const mode of ["workload", "access"]) {
        const { env, state } = await environment();
        state.policy.auth = mode === "workload" ? { mode, credentialSha256: await sha256Hex(token) }
          : { mode, issuer: "https://synthetic-owner.cloudflareaccess.com", githubAccountId: 123456, identityProviderId: "synthetic-github-idp", audience: "synthetic-audience" };
        for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"]) {
          const result = await run(request(path, { headers: { authorization: `Bearer ${token}` } }), env);
          assert.equal(result.status, 404);
          assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
        }
        assert.equal(state.secretReads, 0); assert.deepEqual(state.genericReads, []);
      }
    }
  });
});

test("account selection stays broker-only and OAuth rotation leaves workload authentication independent", async () => {
  const { env, state } = await environment();
  await withFetch(() => assert.fail("Caller account selection reached upstream"), async () => {
    for (const name of ["chatgpt-account-id", "x-chatgpt-account-id", "chatgpt_account_id", "openai-account-id", "x-account-id"]) {
      for (const value of [accountId, "SYNTHETIC_OTHER_ACCOUNT", "", `${accountId}, ${accountId}`]) {
        for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"]) {
          const result = await run(request(path, { headers: { [name]: value } }), env);
          assert.equal(result.status, 400); assertContained(await result.text());
        }
      }
    }
    for (const path of ["/private/backend-api/codex/models", "/private/v1/models/upstream", "/private/v1/oauth/refresh"]) {
      assert.equal((await run(request(path), env)).status, 404);
    }
  });
  assert.equal(state.secretReads, 0);
  const digest = state.policy.auth.credentialSha256;
  let calls = 0;
  await withFetch((_, init) => {
    calls++;
    assert.equal(init.headers.get("authorization"), `Bearer ${state.upstream.accessToken}`);
    assert.notEqual(init.headers.get("authorization"), `Bearer ${credential}`);
    assert.equal(init.headers.get("chatgpt-account-id"), accountId);
    assert.equal(JSON.parse(init.body).model, target);
    return jsonResponse();
  }, async () => {
    for (const token of [accessToken, `${accessToken}_ROTATED`]) {
      state.upstream.accessToken = token;
      const result = await run(request(), env);
      assert.equal(result.status, 200); assertContained(await result.text());
      assert.equal(state.policy.auth.credentialSha256, digest);
    }
  });
  assert.equal(calls, 2); assert.deepEqual(state.genericReads, []);
});

test("safe authorized discovery uses only alias metadata; binding absent from every public inventory", async () => {
  const { env, state } = await environment();
  await withFetch(() => assert.fail("Discovery must not fetch upstream"), async () => {
    const models = await run(request("/private/v1/models"), env);
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data, [{ id: alias, object: "model", owned_by: "private", display_name: "Codex (Latest)", capabilities: ["llm.responses"] }]);
    const catalog = await run(request("/private/v1/catalog"), env);
    const body = await catalog.text(); assertContained(body);
    const provider = JSON.parse(body).providers[0];
    const model = provider.models[0];
    // OpenClaw validates the native namespace even when selecting unified Responses.
    assert.equal(provider.nativeBaseUrl, "/v1/native/private");
    assert.equal(provider.openaiCompatible, true);
    assert.deepEqual(provider.routes, [{ endpoint: "responses", methods: ["POST"], path: "/v1/responses", requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse" }]);
    assert.deepEqual(model.capabilities, ["llm.responses"]);
    assert.equal(model.upstream, alias); assert.equal(model.displayName, "Codex (Latest)");
    assert.equal(body.includes("accountId"), false); assert.equal(body.includes("credentialSha256"), false);
    assert.match(catalog.headers.get("cache-control"), /no-store/);
    assert.equal(catalog.headers.get("access-control-allow-origin"), null);
    assert.equal(catalog.headers.get("x-request-id"), null);
  });
  const reads = state.secretReads;
  const publicEnv = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: "0".repeat(64) };
  for (const path of ["/v1/providers", "/v1/routes", "/v1", "/v1/models", "/v1/catalog", "/v1/admin/bootstrap"]) {
    const result = await run(request(path), publicEnv);
    const text = await result.text(); assertContained(text); assert.equal(text.includes(alias), false);
  }
  assert.equal(state.secretReads, reads);
  assert.deepEqual(state.genericReads, []);
});

test("private reasoning capabilities are explicit, optional and projected only as approved descriptors", async () => {
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  await withFetch(() => assert.fail("Private discovery called upstream"), async () => {
    for (const supported of [undefined, ...efforts.map((effort) => [effort]), efforts, ["low", "medium", "high", "xhigh", "max"], ["high", "low"]]) {
      for (const id of [alias, "synthetic-opaque"]) {
        const { env, state } = await environment();
        state.policy.alias.id = id;
        if (supported !== undefined) state.policy.alias.supportedReasoningEfforts = supported;
        for (const path of ["/private/v1/models", "/private/v1/catalog"]) {
          const result = await run(request(path), env);
          assert.equal(result.status, 200);
          const text = await result.text(); assertContained(text);
          assert.doesNotMatch(text, /credentialSha256|accountId|accessToken|expiresAt|contextWindow|maxTokens|ModelInfo/);
          const value = JSON.parse(text);
          const capabilities = supported === undefined ? {} : { supportedReasoningEfforts: supported };
          if (path.endsWith("/models")) assert.deepEqual(value.data, [{ id, object: "model", owned_by: "private", display_name: "Codex (Latest)", capabilities: ["llm.responses"], ...capabilities }]);
          else {
            assert.deepEqual(value.providers[0].models, [{ id, displayName: "Codex (Latest)", upstream: id, capabilities: ["llm.responses"], pricing_ref: null, pricing: null, ...capabilities }]);
            assert.equal(value.providers[0].nativeBaseUrl, "/v1/native/private");
            assert.equal(value.providers[0].routes[0].path, "/v1/responses");
          }
        }
        assert.deepEqual(state.genericReads, []);
      }
    }
  });
});

test("private reasoning lists reject malformed, duplicate, unsupported and oversized policy values before secrets", async () => {
  await withFetch(() => assert.fail("Malformed reasoning policy reached upstream"), async () => {
    for (const supportedReasoningEfforts of [null, false, "high", {}, [], ["high", "high"], ["HIGH"], [" high"], ["off"], ["synthetic-unsupported-effort"], [target], [accountId], [accessToken], [1], [null], [["high"]], ["low", {}], Array(8).fill("high"), Array(20_000).fill("high")]) {
      const { env, state } = await environment();
      state.policy.alias.supportedReasoningEfforts = supportedReasoningEfforts;
      for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"]) {
        const result = await run(request(path), env);
        assert.equal(result.status, 404);
        assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
      }
      assert.equal(state.secretReads, 0); assert.deepEqual(state.genericReads, []);
    }
    for (const extra of [{ reasoning: true }, { target }, { accountId }, { pricing: {} }, { maxTokens: 1 }]) {
      const { env, state } = await environment();
      state.policy.alias = { ...state.policy.alias, supportedReasoningEfforts: ["high"], ...extra };
      assert.equal((await run(request("/private/v1/catalog"), env)).status, 404);
      assert.equal(state.secretReads, 0);
    }
  });
});

test("private reasoning descriptors remain absent for unauthorized callers and public discovery", async () => {
  const { env, state } = await environment();
  state.policy.alias.supportedReasoningEfforts = ["low", "high"];
  await withFetch(() => assert.fail("Discovery/auth rejection reached upstream"), async () => {
    for (const headers of [{}, { authorization: "Bearer SYNTHETIC_ADMIN_TOKEN" }, { authorization: "Bearer clawrouter-live-synthetic-secret" }, { "cf-access-jwt-assertion": "synthetic.forged.jwt" }, { "x-user-id": "synthetic-owner" }, { authorization: `Bearer ${credential}`, "cf-access-jwt-assertion": "synthetic.forged.jwt" }]) {
      for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"]) {
        const req = request(path); req.headers.delete("authorization");
        for (const [key, value] of Object.entries(headers)) req.headers.set(key, value);
        const result = await run(req, env); assert.equal(result.status, 404);
        assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
      }
    }
    assert.equal(state.secretReads, 0);
    const publicEnv = { ...env };
    for (const path of ["/v1/models", "/v1/catalog", "/v1/providers", "/v1/routes", "/v1/admin/bootstrap"]) {
      const result = await run(request(path), publicEnv);
      const text = await result.text(); assertContained(text); assert.equal(text.includes(alias), false);
    }
    assert.equal(state.secretReads, 0);
    const allowed = await run(request("/private/v1/catalog"), env);
    assert.equal(allowed.status, 200);
    assert.deepEqual((await allowed.json()).providers[0].models[0].supportedReasoningEfforts, ["low", "high"]);
    state.policy.alias.supportedReasoningEfforts = ["medium"];
    assert.deepEqual((await (await run(request("/private/v1/models"), env)).json()).data[0].supportedReasoningEfforts, ["medium"]);
  });
});

test("only the alias is accepted and all routing/encoding/auth overrides fail before fetch", async () => {
  const { env } = await environment();
  await withFetch(() => assert.fail("Rejected request reached provider"), async () => {
    for (const model of [target, `private/${alias}`, `openai/${alias}`, "synthetic-other", null, [alias]]) {
      assert.equal((await run(request(undefined, { body: { model, store: false } }), env)).status, 400);
    }
    for (const key of ["provider", "base_url", "baseUrl", "upstream", "headers", "auth", "account_id", "model_override"]) {
      assert.equal((await run(request(undefined, { body: { model: alias, store: false, [key]: "synthetic-override" } }), env)).status, 400);
    }
    for (const headers of [
      { "content-type": "application/json; charset=utf-16" }, { "content-encoding": "gzip" },
      { "x-model": "synthetic" }, { "openai-organization": "synthetic" }, { "chatgpt-account-id": accountId },
      { "x-base-url": "https://elsewhere.invalid" }, { "x-codex-attestation": "synthetic-proof" },
    ]) assert.equal((await run(request(undefined, { headers }), env)).status, 400);
    for (const body of ["{", "[]", JSON.stringify({ model: alias }), JSON.stringify({ model: alias, store: true }), JSON.stringify({ model: alias, store: false, background: true }), JSON.stringify({ model: alias, store: false, stream: "true" })]) {
      assert.equal((await run(request(undefined, { body }), env)).status, 400);
    }
    for (const path of ["/private/v1/responses/compact", "/private/v1/chat/completions", "/private/v1/usage", "/private/v1/native/openai/responses", "/private/v1/native/private/v1/responses", "/private/v1/responses?model=synthetic", "/private/v1/%72esponses", "/private/v1/responses%2f..%2fmodels", "/private/v1/responses/", "/private//v1/models", "/%70rivate/v1/models"]) {
      assert.equal((await run(request(path, { method: "POST" }), env)).status, 404);
    }
    assert.equal((await run(request("/private/v1/responses", { method: "GET" }), env)).status, 404);
    assert.equal((await run(request("/private/v1/models", { method: "OPTIONS" }), env)).status, 404);
  });
});

test("request rewriting is confined to egress; preserve genuine metadata, tool protocol and safe output", async () => {
  const { env, state } = await environment();
  state.policy.alias.supportedReasoningEfforts = ["high"];
  const input = { model: alias, store: false, input: "SYNTHETIC_INPUT", instructions: "SYNTHETIC_INSTRUCTIONS", metadata: { approval: "required", review: "synthetic-review", attestation: "synthetic-attestation" }, tools: [{ type: "function", name: "synthetic_tool", parameters: { type: "object", properties: { model: { type: "string" } } } }], include: ["reasoning.encrypted_content"] };
  let calls = 0;
  await withFetch(async (url, init) => {
    calls++;
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body), { ...input, model: target });
    assert.equal(init.headers.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(init.headers.get("chatgpt-account-id"), accountId);
    assert.equal(init.headers.get("originator"), "synthetic-genuine-client");
    assert.equal(init.headers.get("session-id"), "synthetic-session");
    assert.equal(init.headers.get("user-agent"), "synthetic-client/1");
    assert.equal(init.headers.get("x-user-id"), null);
    return jsonResponse({ nested: { model: "synthetic-data-model" }, output: [{ type: "reasoning", encrypted_content: "synthetic-opaque-ciphertext" }, { type: "function_call", name: "synthetic_tool", arguments: '{"value":"synthetic-safe"}', call_id: "synthetic-call" }], metadata: input.metadata, usage: { input_tokens: 11, output_tokens: 7 } }, { "x-secret": target, "set-cookie": accessToken, "location": `https://example.invalid/${target}`, "x-request-id": target });
  }, async () => {
    const result = await run(request(undefined, { body: input, headers: { originator: "synthetic-genuine-client", "session-id": "synthetic-session", "user-agent": "synthetic-client/1", "x-user-id": "synthetic-forged-human" } }), env);
    assert.equal(result.status, 200);
    const text = await result.text(); assertContained(text);
    const value = JSON.parse(text);
    assert.equal(value.model, alias); assert.equal(value.nested.model, "synthetic-data-model");
    assert.equal(value.output[0].encrypted_content, "synthetic-opaque-ciphertext");
    assert.equal(value.output[1].arguments, '{"value":"synthetic-safe"}');
    assert.deepEqual(value.metadata, input.metadata); assert.deepEqual(value.usage, { input_tokens: 11, output_tokens: 7 });
    assert.deepEqual([...result.headers.keys()].sort(), ["cache-control", "content-type", "x-clawrouter-accounting", "x-clawrouter-content-retention", "x-content-type-options"]);
    assert.equal(result.headers.get("x-clawrouter-accounting"), "private-unmetered");
  });
  assert.equal(input.model, alias); assert.equal(calls, 1); assert.deepEqual(state.genericReads, []);
});

test("subscription output option adaptation omits only the top-level field and discloses the unenforced limit", async () => {
  const marker = "x-clawrouter-ignored-parameters";
  function freeze(value) {
    if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
  }
  for (const streaming of [false, true]) {
    for (const max of [undefined, 1, 32768, Number.MAX_SAFE_INTEGER]) {
      const { env } = await environment();
      const input = {
        ...nativeBody(), stream: streaming, service_tier: "priority", temperature: 0.4, top_p: 0.8, prompt_cache_retention: "24h",
        metadata: { approval: "required", review: "synthetic-review", attestation: "synthetic-attestation", max_output_tokens: 17 },
        text: { verbosity: "low", format: { type: "json_object" } },
        tools: [{ type: "function", name: "synthetic_tool", parameters: { type: "object", properties: { max_output_tokens: { type: "integer" } } } }],
        ...(max === undefined ? {} : { max_output_tokens: max }),
      };
      if (!streaming) delete input.stream_options;
      const original = structuredClone(input); freeze(input);
      const { max_output_tokens: ignored, ...retained } = input;
      const expected = { ...retained, model: target };
      const projected = privateSubscriptionBody(input, target);
      assert.notEqual(projected, input); assert.deepEqual(projected, expected); assert.deepEqual(input, original);
      const headers = { originator: "synthetic-genuine-client", "user-agent": "synthetic-client/1", version: "0.0.0-synthetic", "x-codex-routing-hint": `model=${alias};tier=priority`, "x-oai-attestation": "synthetic-host-attestation", [marker]: "synthetic-caller-forgery" };
      let calls = 0;
      await withFetch((_, init) => {
        calls++; assert.equal(init.body, JSON.stringify(expected));
        assert.equal(init.headers.get("x-codex-routing-hint"), `model=${target};tier=priority`);
        for (const name of ["originator", "user-agent", "version", "x-oai-attestation"]) assert.equal(init.headers.get(name), headers[name]);
        assert.equal(init.headers.get(marker), null);
        const response = streaming ? sse([completed()]) : jsonResponse();
        response.headers.set(marker, "synthetic-upstream-forgery");
        return response;
      }, async () => {
        const req = request(undefined, { body: input, headers });
        const originalWire = req.clone();
        const result = await run(req, env);
        assert.equal(result.status, 200);
        assert.equal(result.headers.get(marker), max === undefined ? null : "max_output_tokens");
        assert.equal(result.headers.get("x-clawrouter-accounting"), "private-unmetered");
        const text = await result.text(); assertContained(text); assert.doesNotMatch(text, /private_upstream_error|synthetic-.*-forgery/);
        assert.equal(await originalWire.text(), JSON.stringify(original));
      });
      assert.equal(calls, 1); assert.deepEqual(input, original);
    }
  }
});

test("subscription output option rejects malformed values before upstream without echoing them", async () => {
  const { env } = await environment();
  await withFetch(() => assert.fail("Invalid output option reached upstream"), async () => {
    for (const value of [null, true, false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", "synthetic-invalid-limit", target, accountId, accessToken, [], [1], {}, { value: 1 }]) {
      const result = await run(request(undefined, { body: { model: alias, store: false, max_output_tokens: value } }), env);
      assert.equal(result.status, 400); assert.equal(result.headers.get("x-clawrouter-ignored-parameters"), null);
      assert.deepEqual(await result.json(), { error: { code: "invalid_request", message: "Unsupported private request." } });
    }
    const result = await run(request(undefined, { body: `{"model":"${alias}","store":false,"max_output_tokens":1e309}` }), env);
    assert.equal(result.status, 400); assert.equal(result.headers.get("x-clawrouter-ignored-parameters"), null);
  });
});

test("subscription output option disclosure survives provider denials, transport and late SSE failures", async () => {
  const { env } = await environment();
  const body = { model: alias, store: false, max_output_tokens: 12345 };
  for (const code of [400, 403, 404, 429, 500]) {
    await withFetch(() => new Response(target, { status: code }), async () => {
      const result = await run(request(undefined, { body }), env);
      assert.equal(result.status, code < 500 ? code : 502);
      assert.equal(result.headers.get("x-clawrouter-ignored-parameters"), "max_output_tokens");
      const text = await result.text(); assertContained(text); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /12345/);
    });
  }
  for (const make of [() => { throw new Error(target); }, () => new Response(target, { headers: { "content-type": "text/html" } }), () => jsonResponse({ output: [{ text: target }] })]) {
    await withFetch(make, async () => {
      const result = await run(request(undefined, { body }), env);
      assert.equal(result.status, 502); assert.equal(result.headers.get("x-clawrouter-ignored-parameters"), "max_output_tokens"); assertContained(await result.text());
    });
  }
  await withFetch(() => sse([textDelta("safe"), { type: "error", error: { message: target } }]), async () => {
    const result = await run(request(undefined, { body: { ...body, stream: true } }), env);
    assert.equal(result.headers.get("x-clawrouter-ignored-parameters"), "max_output_tokens");
    const text = await result.text(); assertContained(text); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed/);
  });
});

test("subscription output option disclosure neither authenticates callers nor escapes reporting-name containment", async () => {
  const { env, state } = await environment();
  const marker = "x-clawrouter-ignored-parameters";
  await withFetch(() => assert.fail("Unauthorized output option reached upstream"), async () => {
    for (const authorization of ["Bearer SYNTHETIC_ADMIN_TOKEN", "Bearer clawrouter-live-synthetic-key", "Bearer synthetic.forged.jwt"]) {
      const result = await run(request(undefined, { body: { model: alias, store: false, max_output_tokens: 1 }, headers: { authorization, [marker]: "max_output_tokens" } }), env);
      assert.equal(result.status, 404); assert.equal(result.headers.get(marker), null);
      assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
    }
    assert.equal(state.secretReads, 0);
    for (const path of ["/private/v1/models", "/private/v1/catalog"]) {
      const result = await run(request(path, { headers: { [marker]: "max_output_tokens" } }), env);
      assert.equal(result.status, 200); assert.equal(result.headers.get(marker), null);
    }
  });
  // A protocol reporting name can collide with even a fixed local header value.
  await withFetch(() => assert.fail("Unsafe disclosure reached upstream"), async () => {
    for (const key of ["target", "accountId", "accessToken"]) {
      const { env, state } = await environment(); state.upstream[key] = "max_output_tokens";
      const result = await run(request(undefined, { body: { model: alias, store: false, max_output_tokens: 1 } }), env);
      assert.equal(result.status, 502); assert.equal(result.headers.get(marker), null);
      assert.equal((await result.text()).includes("max_output_tokens"), false);
    }
  });
  for (const stream of [false, true]) {
    await withFetch(() => stream ? sse([completed({ model: "max_output_tokens" })]) : jsonResponse({ model: "max_output_tokens" }), async () => {
      const result = await run(request(undefined, { body: { model: alias, store: false, stream, max_output_tokens: 1 } }), env);
      assert.equal(result.status, 502); assert.equal(result.headers.get(marker), null);
      assert.equal((await result.text()).includes("max_output_tokens"), false);
    });
  }
});

test("missing, malformed, revoked, expired or rotated configuration fails closed", async () => {
  await withFetch(() => assert.fail("Invalid config reached provider"), async () => {
    for (const patch of [null, {}, { enabled: false }, { version: 2 }, { extra: true }, { auth: { mode: "local" } }, { auth: { mode: "workload", credentialSha256: credential } }]) {
      const { env, state } = await environment();
      state.policy = patch === null ? null : { ...state.policy, ...patch };
      if (patch && !Object.keys(patch).length) state.policy = {};
      assert.equal((await run(request("/private/v1/models"), env)).status, 404);
      assert.equal(state.secretReads, 0);
    }
    for (const patch of [{ target: "" }, { target: alias }, { accountId: "" }, { accessToken: "" }, { expiresAt: 1 }, { expiresAt: "tomorrow" }, { extra: "invalid" }]) {
      const { env, state } = await environment(); state.upstream = { ...state.upstream, ...patch };
      assert.equal((await run(request(), env)).status, 404);
    }
    const { env, state } = await environment();
    env.PRIVATE_CODEX_POLICY.get = async () => { state.policyReads++; return JSON.stringify({ ...state.policy, enabled: state.policyReads === 1 }); };
    assert.equal((await run(request(), env)).status, 404);
    env.PRIVATE_CODEX_POLICY.get = async () => JSON.stringify(state.policy);
    env.PRIVATE_CODEX_UPSTREAM.get = async () => JSON.stringify({ ...state.upstream, accessToken: `${accessToken}_${state.secretReads++}` });
    assert.equal((await run(request(), env)).status, 404);
    env.PRIVATE_CODEX_UPSTREAM.get = async () => { throw new Error(target); };
    const failed = await run(request(), env); assert.equal(failed.status, 404); assertContained(await failed.text());
  });
});

test("provider failures, redirects and transport exceptions do not retry or leak", async () => {
  for (const code of [301, 401, 403, 429, 500]) {
    const { env } = await environment(); let calls = 0;
    await withFetch(() => { calls++; return new Response(target, { status: code, headers: { location: `https://elsewhere.invalid/${target}` } }); }, async () => {
      const result = await run(request(), env); assert.equal(result.status, code >= 400 && code < 500 ? code : 502); assertContained(await result.text());
    });
    assert.equal(calls, 1);
  }
  const { env } = await environment();
  await withFetch(() => { throw new Error(target); }, async () => { const result = await run(request(), env); assert.equal(result.status, 502); assertContained(await result.text()); });
});

test("JSON containment decodes escapes, rejects leaks and reroutes, and preserves refusal semantics", async () => {
  const { env } = await environment();
  const escaped = [...target].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const wire = JSON.stringify(responseObject()).replace(target, escaped);
  await withFetch(() => new Response(wire, { headers: { "content-type": "application/json" } }), async () => {
    const result = await run(request(), env); assert.equal(result.status, 200); assert.equal((await result.json()).model, alias);
  });
  for (const extra of [
    { output: [{ text: target }] }, { nested: { model: target } }, { headers: { "OpenAI-Model": "synthetic-rerouted-model" } }, { error: { message: target } },
    { output: [{ arguments: `{"value":"${escaped}"}` }] }, { output: [{ encrypted_content: target }] },
    { metadata: { [target]: true } }, { output: [{ text: accessToken }] }, { output: [{ text: accountId }] },
  ]) await withFetch(() => jsonResponse(extra), async () => { const result = await run(request(), env); assert.equal(result.status, 502); assertContained(await result.text()); });
  await withFetch(() => jsonResponse({ output: [{ type: "refusal", refusal: "SYNTHETIC_UPSTREAM_DENIAL" }], metadata: { review_required: true } }), async () => {
    const result = await run(request(), env); assert.equal(result.status, 200);
    const value = await result.json(); assert.equal(value.output[0].refusal, "SYNTHETIC_UPSTREAM_DENIAL"); assert.equal(value.metadata.review_required, true);
  });
});

test("SSE handles byte/chunk boundaries and preserves complete, done, tool and review events", async () => {
  const { env } = await environment();
  const toolBase = { item_id: "synthetic-tool", output_index: 1 };
  const events = [
    { type: "response.created", response: responseObject({ status: "in_progress" }) },
    textDelta("Safe 🦞 text"),
    { type: "response.output_text.done", item_id: "synthetic-item", output_index: 0, content_index: 0, text: "Safe 🦞 text" },
    { type: "response.function_call_arguments.delta", ...toolBase, delta: '{"safe":' },
    { type: "response.function_call_arguments.delta", ...toolBase, delta: '"value"}' },
    { type: "response.function_call_arguments.done", ...toolBase, arguments: '{"safe":"value"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", arguments: '{"safe":"value"}', call_id: "synthetic-call", name: "synthetic-tool" } },
    completed({ metadata: { review_required: true }, output: [{ type: "reasoning", encrypted_content: "synthetic-opaque" }] }),
  ];
  await withFetch(() => sse(events, 1), async () => {
    const result = await run(request(undefined, { body: { model: alias, stream: true, store: false } }), env);
    const text = await result.text(); assertContained(text); assert.doesNotMatch(text, /private_upstream_error/);
    const parsed = [...text.matchAll(/^data: (.+)$/gm)].filter((match) => match[1] !== "[DONE]").map((match) => JSON.parse(match[1]));
    const safeEvents = JSON.parse(JSON.stringify(events).replaceAll(target, alias));
    assert.deepEqual(parsed, safeEvents);
    assert.equal(result.headers.get("x-synthetic-secret"), null);
  });
});

test("SSE split text/tool leaks are held back across events, including interleaved logical streams", async () => {
  const { env } = await environment();
  for (let split = 1; split < target.length; split++) {
    const first = target.slice(0, split), rest = target.slice(split);
    const events = [textDelta("safe preface "), textDelta(first), textDelta("safe other item", { output_index: 1, item_id: "synthetic-other" }), textDelta(rest), completed()];
    await withFetch(() => sse(events), async () => {
      const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
      const text = await result.text(); assertContained(text);
      assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed/);
      assert.equal(text.includes(JSON.stringify({ ...textDelta(first) }).slice(1, -1)), false);
    });
  }
  const escaped = [...target].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  for (const argumentsText of [`{"value":"${target}"}`, `{"value":"${escaped}"}`]) {
    const base = { item_id: "synthetic-tool", output_index: 0 };
    const events = [...argumentsText].map((delta) => ({ type: "response.function_call_arguments.delta", ...base, delta }));
    events.push({ type: "response.function_call_arguments.done", ...base, arguments: argumentsText }, completed());
    await withFetch(() => sse(events), async () => {
      const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
      const text = await result.text(); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /function_call_arguments.delta/); assertContained(text);
    });
  }
});

test("SSE late errors, malformed/unsupported frames, mismatched identities and incomplete streams fail sanitized", async () => {
  const { env } = await environment();
  const badStreams = [
    [textDelta("safe"), { type: "error", message: target }],
    [textDelta("safe"), { type: "response.failed", response: { error: { message: target } } }],
    [textDelta("safe"), completed({ output: [{ text: target }] })],
    [textDelta("safe"), { type: "response.output_text.done", item_id: "synthetic-item", output_index: 0, content_index: 0, text: target }],
    [textDelta(target.slice(0, 5)), textDelta(target.slice(5), { item_id: "synthetic-spoof" })],
    [textDelta(target.slice(0, 5)), textDelta(target.slice(5), { output_index: 1 })],
    ["data: {invalid}\n\n"], ["id: synthetic\ndata: {}\n\n"], ["data: [DONE]\n\n"],
    [textDelta("safe")], ["event: response.created\ndata: {\"type\":\"response.completed\"}\n\n"],
    [{ type: "response.unsupported.delta", delta: target.slice(0, 3) }],
    [completed(), { type: "error", message: target }],
  ];
  for (const events of badStreams) await withFetch(() => sse(events, 19, false), async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
    const text = await result.text(); assertContained(text); assert.match(text, /private_upstream_error/);
  });
});

test("bounded request/JSON/SSE and unsupported content cancel upstream without exposure", async () => {
  const { env } = await environment();
  await withFetch(() => assert.fail("Oversized request reached upstream"), async () => {
    assert.equal((await run(request(undefined, { body: { model: alias, store: false, input: "x".repeat(1024 * 1024) } }), env)).status, 400);
  });
  for (const make of [
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    () => jsonResponse({}, { "content-encoding": "gzip" }),
    () => jsonResponse({}, { "x-codex-attestation": "synthetic-attestation" }),
    () => jsonResponse({}, { "x-review-required": "true" }),
    () => jsonResponse({}, { "x-upstream-model": "synthetic-reroute" }),
    () => jsonResponse({}, { "x-safety-required": "true" }),
    () => new Response(target, { headers: { "content-type": "text/html" } }),
    () => jsonResponse({ output: ["x".repeat(4 * 1024 * 1024)] }),
  ]) await withFetch(make, async () => { const result = await run(request(), env); assert.equal(result.status, 502); assertContained(await result.text()); });
  await withFetch(() => sse([textDelta("x".repeat(300 * 1024)), completed()]), async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
    const text = await result.text(); assert.match(text, /private_upstream_error/); assert.ok(text.length < 1024);
  });
});

test("client cancellation and request abort cancel the provider stream", async () => {
  const { env } = await environment();
  for (const abortRequest of [false, true]) {
    let canceled = false, upstreamSignal;
    const abort = new AbortController();
    const started = Promise.withResolvers();
    await withFetch((_, init) => {
      upstreamSignal = init.signal;
      started.resolve();
      return new Response(new ReadableStream({ pull(controller) { if (!abortRequest) controller.enqueue(enc.encode(frame(textDelta("safe")))); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    }, async () => {
      const pending = run(request(undefined, { signal: abort.signal, body: { model: alias, store: false, stream: true } }), env);
      await started.promise;
      if (abortRequest) abort.abort();
      const result = await pending;
      const reader = result.body.getReader();
      await reader.read();
      if (!abortRequest) await reader.cancel();
      assert.equal(upstreamSignal.aborted, true); assert.equal(canceled, true);
    });
  }
});

test("Access auth pins verified GitHub account/IdP, never email/admin/local identity", async () => {
  const { env, state } = await environment();
  state.policy.auth = { mode: "access", issuer: "https://synthetic-owner.cloudflareaccess.com", audience: "synthetic-audience", githubAccountId: 123456, identityProviderId: "synthetic-github-idp" };
  state.policy.alias.supportedReasoningEfforts = ["low", "high"];
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "synthetic-key" };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  async function jwt(patch = {}, forged = false) {
    const payload = { iss: state.policy.auth.issuer, sub: "synthetic-owner-subject", aud: state.policy.auth.audience, exp: Math.floor(Date.now() / 1000) + 300, email: "synthetic-owner@example.invalid", ...patch };
    const unsigned = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode(payload)}`;
    const signed = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, enc.encode(unsigned));
    return `${unsigned}.${forged ? "c3ludGhldGlj" : Buffer.from(signed).toString("base64url")}`;
  }
  let inference = 0;
  await withFetch((url, init) => {
    if (String(url) === "https://synthetic-owner.cloudflareaccess.com/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
    if (String(url) === "https://synthetic-owner.cloudflareaccess.com/cdn-cgi/access/get-identity") {
      const payload = JSON.parse(Buffer.from(new Headers(init.headers).get("cookie").split(".")[1], "base64url").toString());
      return Response.json({ email: payload.email, id: 123456, idp: { type: "github", id: "synthetic-github-idp" } });
    }
    inference++; return jsonResponse();
  }, async () => {
    for (const [patch, forged] of [
      [{ email: undefined }, false], [{ email: "" }, false], [{ iss: "https://synthetic-other.cloudflareaccess.com" }, false],
      [{ aud: "synthetic-other-audience" }, false], [{ exp: 1 }, false], [{ exp: "99999999999" }, false],
      [{ nbf: 99999999999 }, false], [{ iat: 99999999999 }, false], [{}, true],
    ]) {
      for (const path of ["/private/v1/models", "/private/v1/catalog", "/private/v1/responses"]) {
        const req = request(path); req.headers.delete("authorization"); req.headers.set("cf-access-jwt-assertion", await jwt(patch, forged));
        const result = await run(req, env); assert.equal(result.status, 404);
        assert.deepEqual(await result.json(), { error: { code: "route_not_found", message: "route not found" } });
      }
    }
    assert.equal(state.secretReads, 0); assert.equal(inference, 0);
    const req = request(undefined, { body: { model: alias, store: false, max_output_tokens: 256 } }); req.headers.delete("authorization"); req.headers.set("cf-access-jwt-assertion", await jwt({ email: "synthetic-changed@example.invalid", sub: "synthetic-changed-subject" }));
    const accepted = await run(req, env);
    assert.equal(accepted.status, 200); assert.equal(accepted.headers.get("x-clawrouter-ignored-parameters"), "max_output_tokens"); assert.equal(inference, 1);
    for (const path of ["/private/v1/models", "/private/v1/catalog"]) {
      const owner = request(path); owner.headers.delete("authorization"); owner.headers.set("cf-access-jwt-assertion", await jwt());
      const result = await run(owner, env); assert.equal(result.status, 200);
      const text = await result.text(); assertContained(text);
      const body = JSON.parse(text);
      const descriptor = path.endsWith("/models") ? body.data[0] : body.providers[0].models[0];
      assert.deepEqual(descriptor.supportedReasoningEfforts, ["low", "high"]);
    }
    assert.equal(inference, 1);
    const conflict = request(); conflict.headers.set("cf-access-jwt-assertion", await jwt());
    assert.equal((await run(conflict, env)).status, 404); assert.equal(inference, 1);
    conflict.headers.set("authorization", "");
    assert.equal((await run(conflict, env)).status, 404); assert.equal(inference, 1);
    const accountOverride = request(); accountOverride.headers.delete("authorization");
    accountOverride.headers.set("cf-access-jwt-assertion", await jwt()); accountOverride.headers.set("chatgpt-account-id", accountId);
    assert.equal((await run(accountOverride, env)).status, 400); assert.equal(inference, 1);
  });
  assert.deepEqual(state.genericReads, []);
});

test("private workload credentials cannot execute generic proxy, native, manifest or Fusion paths", async () => {
  const { env, state } = await environment();
  const publicEnv = { ...env };
  await withFetch(() => assert.fail("Private credential escaped the facade"), async () => {
    for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/proxy/openai/responses", "/v1/native/openai/v1/responses", "/v1/native/private/v1/responses"]) {
      const result = await run(request(path, { method: "POST", body: { model: "clawrouter/fusion", store: false } }), publicEnv);
      assert.ok(result.status >= 400);
      assertContained(await result.text());
    }
  });
  assert.equal(state.secretReads, 0); assert.equal(state.policyReads, 0);
});

test("no private failures or request metadata enter application logs", async (context) => {
  const { env } = await environment(); const logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) context.mock.method(console, method, (...values) => logs.push(values));
  await withFetch(() => { throw new Error(target); }, async () => {
    const result = await run(request(undefined, { headers: { "x-request-id": target, "traceparent": accessToken } }), env);
    assert.equal(result.status, 502); assertContained(await result.text());
  });
  env.PRIVATE_CODEX_UPSTREAM.get = async () => { throw new Error(accessToken); };
  assert.equal((await run(request(), env)).status, 404);
  assert.deepEqual(logs, []);
});

test("holdback disambiguates overlapping prefixes and safely ends incomplete Responses", async () => {
  const { env, state } = await environment();
  state.upstream.target = "SYNTHETIC_ABABABAC";
  const text = "SYNTHETIC_ABABABAB is safe";
  const events = [...text].map((delta) => textDelta(delta));
  events.push({ type: "response.incomplete", response: { ...responseObject(), model: state.upstream.target, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
  await withFetch(() => sse(events, 7, false), async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
    const output = await result.text(); assert.doesNotMatch(output, /private_upstream_error/);
    const parsed = [...output.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    assert.equal(parsed.filter((event) => event.type.endsWith(".delta")).map((event) => event.delta).join(""), text);
    assert.equal(parsed.at(-1).response.model, alias);
    assert.equal(parsed.at(-1).response.incomplete_details.reason, "max_output_tokens");
  });
});

test("logical stream and pending-event limits fail closed without flushing held fragments", async () => {
  const { env } = await environment();
  const cases = [
    Array.from({ length: 129 }, (_, index) => textDelta(target.slice(0, 3), { output_index: index, item_id: `synthetic-item-${index}` })),
    [textDelta(target.slice(0, 3)), ...Array.from({ length: 1024 }, () => ({ type: "response.in_progress", response: { model: target } }))],
    [{ type: "response.function_call_arguments.delta", item_id: "synthetic-tool", output_index: 0, delta: '{"value":1}' }, { type: "response.function_call_arguments.done", item_id: "synthetic-tool", output_index: 0, arguments: '{"value":2}' }],
  ];
  for (const events of cases) await withFetch(() => sse([...events, completed()], 4096), async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
    const text = await result.text(); assert.match(text, /private_upstream_error/); assertContained(text);
    assert.doesNotMatch(text, /response.output_text.delta|response.function_call_arguments.delta/);
  });
});

function nativeBody() {
  return {
    model: alias, input: [{ type: "additional_tools", role: "developer", tools: [] }, { type: "message", role: "developer", content: [{ type: "input_text", text: "Synthetic base instructions" }] }],
    tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "high", summary: "auto" }, store: false, stream: true,
    include: ["reasoning.encrypted_content"], prompt_cache_key: "synthetic-thread", text: { verbosity: "low" },
    stream_options: { reasoning_summary_delivery: "sequential_cutoff" }, access_programs: { cyber: "standard" },
    client_metadata: {
      "x-codex-installation-id": "synthetic-installation", session_id: "synthetic-session", thread_id: "synthetic-thread", turn_id: "synthetic-turn",
      "x-codex-window-id": "synthetic-window", "x-codex-parent-thread-id": "synthetic-parent", parent_turn_id: "synthetic-parent-turn", root_turn_id: "synthetic-root-turn", "x-openai-subagent": "review",
      "x-codex-turn-metadata": JSON.stringify({ sandbox: "workspace-write", sandbox_mode: "workspace-write", auto_review_enabled: false, node_repl_auto_review_required: false, request_kind: "turn", tool_namespaces_info: { synthetic_tools: ["synthetic_tool"] } }),
    },
  };
}

test("source-shaped native Lite request reaches egress with metadata, real header slots and no fabricated identity", async () => {
  const { env, state } = await environment(); const body = nativeBody();
  const headers = {
    "x-openai-internal-codex-responses-lite": "true", "x-codex-beta-features": "synthetic_beta_one,synthetic_beta_two",
    "x-codex-turn-state": "synthetic-affinity-token", "x-codex-turn-metadata": JSON.stringify({ sandbox_mode: "workspace-write", auto_review_enabled: false }),
    "x-codex-parent-thread-id": "synthetic-parent", "x-codex-window-id": "synthetic-window", "x-oai-attestation": "synthetic-opaque-host-attestation",
    "x-openai-subagent": "review", "x-openai-memgen-request": "false", "x-responsesapi-include-timing-metrics": "true",
    "session-id": "synthetic-session", "thread-id": "synthetic-thread", "originator": "codex_cli_rs", "user-agent": "codex_cli_rs/0.0.0 (synthetic)", "version": "0.0.0-synthetic",
    "openai-beta": "responses=experimental", "x-codex-routing-hint": `model=${alias}`, "traceparent": "00-11111111111111111111111111111111-1111111111111111-01",
  };
  let calls = 0;
  await withFetch((_, init) => {
    calls++; assert.deepEqual(JSON.parse(init.body), { ...body, model: target });
    assert.equal(init.headers.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(init.headers.get("chatgpt-account-id"), accountId);
    for (const [name, value] of Object.entries(headers)) assert.equal(init.headers.get(name), name === "x-codex-routing-hint" ? `model=${target}` : value);
    assert.ok(state.policyReads >= 2); assert.ok(state.secretReads >= 2);
    return sse([{ type: "response.completed", response: { id: "synthetic-response", end_turn: true } }]);
  }, async () => {
    const result = await run(request(undefined, { body, headers }), env);
    assert.equal(result.status, 200); assert.doesNotMatch(await result.text(), /private_upstream_error|invalid_request/);
  });
  assert.equal(calls, 1); assert.equal(body.model, alias); assert.equal(headers["x-codex-routing-hint"], `model=${alias}`);
});

test("native SSE without a content type tolerates discarded repeated cookies and still validates frames", async () => {
  const { env } = await environment();
  for (const valid of [true, false]) {
    await withFetch(() => {
      const source = valid ? sse([textDelta("safe"), completed()]) : new Response(`<html>${target}</html>`);
      const headers = new Headers(source.headers);
      headers.delete("content-type");
      headers.append("set-cookie", "synthetic-one=value; Secure");
      headers.append("set-cookie", "synthetic-two=value; Secure");
      return new Response(source.body, { headers });
    }, async () => {
      const result = await run(request(undefined, { body: { model: alias, store: false, stream: true } }), env);
      assert.equal(result.status, 200);
      assert.equal(result.headers.has("set-cookie"), false);
      const output = await result.text(); assertContained(output);
      assert.equal(output.includes("response.completed"), valid);
      assert.equal(output.includes("private_upstream_error"), !valid);
    });
  }
});

test("OpenClaw originator stays truthful and genuine upstream HTTP400 is never labeled local rejection", async () => {
  const { env } = await environment();
  for (const lite of [false, true]) {
    let calls = 0;
    await withFetch((_, init) => {
      calls++;
      assert.equal(init.headers.get("originator"), "openclaw"); assert.equal(init.headers.get("user-agent"), "OpenClaw/0.0.0-synthetic");
      assert.equal(init.headers.get("x-openai-internal-codex-responses-lite"), lite ? "true" : null);
      assert.equal(init.headers.get("x-oai-attestation"), null); assert.equal(init.headers.get("x-codex-routing-hint"), null);
      return new Response(JSON.stringify({ error: { message: target, code: "synthetic-denial" } }), { status: 400, headers: { "openai-model": target } });
    }, async () => {
      const result = await run(request(undefined, { body: nativeBody(), headers: { originator: "openclaw", "user-agent": "OpenClaw/0.0.0-synthetic", ...(lite ? { "x-openai-internal-codex-responses-lite": "true" } : {}) } }), env);
      assert.equal(result.status, 400); const text = await result.text(); assertContained(text);
      assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /invalid_request|Unsupported private request/);
    });
    assert.equal(calls, 1);
  }
});

test("optional automatic-review facts are neither required nor rewritten", async () => {
  const { env } = await environment();
  for (const autoReview of [undefined, false, true]) {
    const metadata = { sandbox_mode: "workspace-write", ...(autoReview === undefined ? {} : { auto_review_enabled: autoReview }) };
    const body = { model: alias, store: false, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) }, access_programs: null };
    await withFetch((_, init) => {
      assert.deepEqual(JSON.parse(init.body), { ...body, model: target });
      assert.equal(init.headers.get("x-oai-attestation"), null); assert.equal(init.headers.get("originator"), null);
      return jsonResponse({}, { "x-reasoning-included": "" });
    }, async () => {
      const result = await run(request(undefined, { body }), env); assert.equal(result.status, 200); assert.equal(result.headers.get("x-reasoning-included"), "");
    });
  }
});

test("routing hints are alias-only, agree with service tier and never authenticate a caller", async () => {
  const { env, state } = await environment();
  await withFetch(() => assert.fail("Invalid routing hint reached upstream"), async () => {
    for (const hint of [`model=${target}`, "model=synthetic-other", `model=${alias};model=${alias}`, `model=${alias};provider=synthetic`, `model=${alias};tier=priority`, `model=${alias}%3Btier=priority`, `model=${alias},model=synthetic-other`]) {
      assert.equal((await run(request(undefined, { body: nativeBody(), headers: { "x-codex-routing-hint": hint } }), env)).status, 400);
    }
    const req = request(undefined, { body: nativeBody(), headers: { "x-codex-routing-hint": `model=${alias}` } }); req.headers.delete("authorization");
    const reads = state.secretReads; assert.equal((await run(req, env)).status, 404); assert.equal(state.secretReads, reads);
  });
  await withFetch((_, init) => { assert.equal(init.headers.get("x-codex-routing-hint"), `model=${target};tier=priority`); return jsonResponse(); }, async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, service_tier: "priority" }, headers: { "x-codex-routing-hint": `model=${alias};tier=priority` } }), env);
    assert.equal(result.status, 200);
  });
});

test("new protocol fields remain bounded and unknown semantic protocol still fails before egress", async () => {
  const { env } = await environment();
  await withFetch(() => assert.fail("Malformed native protocol reached upstream"), async () => {
    for (const patch of [
      { client_metadata: [] }, { client_metadata: { "x-codex-routing-hint": `model=${alias}` } },
      { client_metadata: { "x-codex-window-id": 123 } }, { client_metadata: { "x-codex-window-id": "x".repeat(8193) } },
      { client_metadata: { "x-codex-turn-metadata": "{" } },
      { stream_options: { reasoning_summary_delivery: "synthetic-unknown" } }, { stream_options: { model: alias } },
      { access_programs: { cyber: "standard", model: alias } }, { access_programs: { cyber: ["standard"] } }, { access_programs: { cyber: "model=synthetic" } },
    ]) assert.equal((await run(request(undefined, { body: { ...nativeBody(), ...patch } }), env)).status, 400);
    for (const headers of [
      { "x-openai-internal-codex-responses-lite": "synthetic" }, { "x-openai-internal-unknown": "true" }, { "x-codex-turn-metadata": "{" },
      { "x-oai-attestation": "x".repeat(8193) }, { "x-codex-attestation": "synthetic" }, { "x-codex-review-override": "false" },
      { "x-codex-turn-state": Buffer.from(JSON.stringify({ model: "synthetic-other" })).toString("base64url") },
    ]) assert.equal((await run(request(undefined, { body: nativeBody(), headers }), env)).status, 400);
  });
});

test("subscription quota headers are stripped without rejecting success; exact model and affinity are contained", async () => {
  const { env } = await environment();
  const upstreamHeaders = {
    "OpenAI-Model": target, "x-codex-turn-state": "synthetic-affinity-token", "x-reasoning-included": "true",
    "x-codex-primary-used-percent": "12.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "9999999999",
    "x-codex-secondary-used-percent": "19", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": "9999999999",
    "x-codex-plan-type": "synthetic-plan", "x-codex-primary-over-secondary-limit-percent": "10",
    "x-codex-primary-reset-after-seconds": "60", "x-codex-secondary-reset-after-seconds": "120",
    "x-codex-synthetic-limit-name": target, "x-codex-synthetic-primary-used-percent": "1", "x-codex-active-limit": target,
    "x-codex-credits-has-credits": "true", "x-codex-credits-unlimited": "false", "x-codex-credits-balance": "42",
    "x-codex-promo-message": target, "x-codex-rate-limit-reached-type": "synthetic-quota", "x-models-etag": target,
    "x-codex-safety-buffering-enabled": "false", "x-codex-safety-buffering-faster-model": target,
  };
  for (const streaming of [false, true]) await withFetch(() => {
    const result = streaming ? sse([completed()]) : jsonResponse();
    for (const [name, value] of Object.entries(upstreamHeaders)) result.headers.set(name, value);
    return result;
  }, async () => {
    const result = await run(request(undefined, { body: { model: alias, store: false, stream: streaming } }), env);
    assert.equal(result.status, 200); assert.equal(result.headers.get("openai-model"), alias);
    assert.equal(result.headers.get("x-codex-turn-state"), "synthetic-affinity-token");
    assert.equal(result.headers.get("x-codex-safety-buffering-enabled"), "false"); assert.equal(result.headers.get("x-codex-safety-buffering-faster-model"), alias);
    assert.equal(result.headers.get("x-reasoning-included"), "true"); assert.equal(result.headers.get("x-codex-primary-used-percent"), null);
    assertContained(JSON.stringify([...result.headers])); const text = await result.text(); assertContained(text); assert.doesNotMatch(text, /private_upstream_error/);
  });
  for (const headers of [
    { "openai-model": "synthetic-reroute" }, { "openai-model": `${target}, ${target}` },
    { "x-codex-safety-buffering-faster-model": "synthetic-reroute" }, { "x-codex-safety-buffering-enabled": "synthetic" },
    { "x-oai-attestation": "synthetic-unknown-response-attestation" }, { "x-codex-unknown-safety-protocol": "synthetic" },
  ]) await withFetch(() => jsonResponse({}, headers), async () => { const result = await run(request(), env); assert.equal(result.status, 502); assertContained(await result.text()); });
});

test("affinity round trips unchanged, while literal and encoded private identities fail closed", async () => {
  const { env } = await environment();
  for (const value of [target, JSON.stringify({ value: target }), encodeURIComponent(JSON.stringify({ value: target })), Buffer.from(JSON.stringify({ value: target })).toString("base64url"), `synthetic.${Buffer.from(JSON.stringify({ model: "synthetic-other" })).toString("base64url")}.signature`]) {
    await withFetch(() => jsonResponse({}, { "x-codex-turn-state": value }), async () => { const result = await run(request(), env); assert.equal(result.status, 502); assertContained(await result.text()); });
    await withFetch(() => assert.fail("Unsafe affinity reached upstream"), async () => { assert.equal((await run(request(undefined, { headers: { "x-codex-turn-state": value } }), env)).status, 400); });
  }
  const state = Buffer.from(JSON.stringify({ affinity: "synthetic-cell", turn: "synthetic-turn" })).toString("base64url");
  await withFetch((_, init) => { assert.equal(init.headers.get("x-codex-turn-state"), state); return jsonResponse({}, { "x-codex-turn-state": state }); }, async () => {
    const result = await run(request(undefined, { headers: { "x-codex-turn-state": state } }), env); assert.equal(result.status, 200); assert.equal(result.headers.get("x-codex-turn-state"), state);
  });
});

test("source-shaped SSE metadata preserves moderation, verification, safety and sparse Lite event identities", async () => {
  const { env } = await environment();
  const events = [
    { type: "codex.rate_limits", metered_limit_name: target, rate_limits: { primary: { used_percent: 1 } } },
    { type: "responsesapi.websocket_timing", synthetic_timing_ms: 1 },
    { type: "response.created", response: { id: "synthetic-response", headers: { "OpenAI-Model": [target], "x-codex-primary-used-percent": "1" } } },
    { type: "response.metadata", headers: { "openai-model": target, "x-codex-turn-state": "synthetic-affinity" }, metadata: { openai_verification_recommendation: ["synthetic-verification"], openai_chatgpt_moderation_metadata: { synthetic_moderation: true } }, safety_buffering: { use_cases: ["synthetic-case"], reasons: ["synthetic-reason"], retry_model: null } },
    { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "Safe summary" },
    { type: "response.reasoning_summary_text.done", item_id: "synthetic-reasoning", summary_index: 0, text: "Safe summary" },
    { type: "response.output_text.delta", delta: "Safe native text" },
    { type: "response.custom_tool_call_input.delta", item_id: "synthetic-custom", call_id: "synthetic-call", delta: "synthetic " },
    { type: "response.custom_tool_call_input.delta", item_id: "synthetic-custom", call_id: "synthetic-call", delta: "tool input" },
    { type: "response.output_item.done", item: { id: "synthetic-custom", type: "custom_tool_call", call_id: "synthetic-call", name: "synthetic_tool", input: "synthetic tool input" } },
    { type: "response.custom_tool_call_input.delta", call_id: "synthetic-call-only", delta: "synthetic " },
    { type: "response.custom_tool_call_input.delta", call_id: "synthetic-call-only", item_id: "synthetic-later-item", delta: "input" },
    { type: "response.output_item.done", item: { id: "synthetic-later-item", type: "custom_tool_call", call_id: "synthetic-call-only", name: "synthetic_tool", input: "synthetic input" } },
    { type: "response.function_call_arguments.done", item_id: "synthetic-function", arguments: '{"value":"safe"}' },
    { type: "codex.response.metadata", metadata: { synthetic_metadata: true } },
    { type: "response.completed", response: { id: "synthetic-response", end_turn: true, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ];
  await withFetch(() => sse(events, 1), async () => {
    const result = await run(request(undefined, { body: nativeBody() }), env);
    const text = await result.text(); assertContained(text); assert.doesNotMatch(text, /private_upstream_error/);
    const actual = [...text.matchAll(/^data: (.+)$/gm)].filter((match) => match[1] !== "[DONE]").map((match) => JSON.parse(match[1]));
    const expected = JSON.parse(JSON.stringify(events.slice(2)).replaceAll(target, alias)); delete expected[0].response.headers["x-codex-primary-used-percent"];
    assert.deepEqual(actual, expected);
  });
});

test("new SSE protocol cannot leak via model headers, safety reroutes or sparse/custom deltas", async () => {
  const { env } = await environment();
  const custom = { type: "response.custom_tool_call_input.delta", item_id: "synthetic-custom" };
  const cases = [
    [{ type: "response.metadata", headers: { "openai-model": "synthetic-reroute" } }],
    [{ type: "response.unknown_safety_protocol", synthetic_required: true }],
    [{ type: "response.created", response: { headers: { "X-OpenAI-Model": "synthetic-reroute" } } }],
    [{ type: "response.metadata", metadata: { type: "safety_buffering", use_cases: [], reasons: [], retry_model: "synthetic-reroute" } }],
    [{ type: "response.metadata", headers: { "x-codex-turn-state": Buffer.from(target).toString("base64url") } }],
    [{ type: "response.output_text.delta", delta: target.slice(0, 9) }, { type: "response.output_text.delta", delta: target.slice(9) }],
    [textDelta(target.slice(0, 9)), textDelta(target.slice(9), { item_id: "synthetic-second", output_index: 1 })],
    [{ ...custom, delta: target.slice(0, 9) }, { ...custom, delta: target.slice(9) }],
    [{ ...custom, delta: target.slice(0, 9) }, { ...custom, item_id: undefined, call_id: "synthetic-call", delta: target.slice(9) }],
    [{ ...custom, call_id: "synthetic-call", delta: target.slice(0, 9) }, { ...custom, call_id: "synthetic-call", item_id: "synthetic-spoof", delta: target.slice(9) }],
  ];
  for (const events of cases) await withFetch(() => sse([...events, completed()]), async () => {
    const result = await run(request(undefined, { body: nativeBody() }), env); const text = await result.text(); assertContained(text); assert.match(text, /private_upstream_error/); assert.doesNotMatch(text, /response.completed/);
  });
});

test("native SSE policy denials keep recognized failure semantics without leaking provider messages", async () => {
  const { env } = await environment();
  for (const code of ["cyber_policy", "misalignment_policy_violation", "bio_policy", "invalid_prompt", "context_length_exceeded", "insufficient_quota", "usage_not_included", "rate_limit_exceeded"]) {
    await withFetch(() => sse([textDelta("safe text"), { type: "response.failed", response: { id: target, error: { code, message: target, misalignment: { private_detail: accessToken } } } }], 19, false), async () => {
      const result = await run(request(undefined, { body: nativeBody() }), env);
      const text = await result.text(); assertContained(text); assert.match(text, /event: response.failed/); assert.doesNotMatch(text, /response.completed|private_detail/);
      const failed = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])).at(-1);
      assert.equal(failed.response.error.code, code); assert.equal(failed.response.status, "failed");
    });
  }
});
