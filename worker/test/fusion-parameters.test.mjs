import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { providerById } from "../providers.ts";
import { normalizeFusionConfig } from "../fusion.ts";
import { sha256Hex } from "../utils.ts";
const { default: worker } = await import("../index.ts");

// Explicit descriptors isolate the constructor proof from catalog generation.
// The compiler suite separately qualifies the committed manifest and snapshot.
function parameterFacts(t) {
  const openai = providerById("openai");
  for (const id of ["gpt-6-astra", "gpt-5.4", "gpt-4.1-mini"]) {
    const model = openai.models.find((candidate) => candidate.id === `openai/${id}`);
    const original = model.requestParameters;
    model.requestParameters = { chat_completions: {
      sources: ["https://provider.example/models"], checkedAt: "2026-09-23",
      ...(id === "gpt-5.4" ? { defaultReasoningEffort: "none" } : {}),
      temperature: id === "gpt-6-astra" ? "unsupported" : id === "gpt-5.4" ? "requires_reasoning_none" : "supported",
      toolCalling: id === "gpt-6-astra" ? "unsupported" : id === "gpt-5.4" ? "requires_reasoning_none" : "supported",
    } };
    t.after(() => { if (original) model.requestParameters = original; else delete model.requestParameters; });
  }
}

test("Fusion rejects known synthesizer conflicts before reservation or adviser dispatch", async (t) => {
  parameterFacts(t);
  const f = await fixture("openai/gpt-6-astra", ["local/fixture"]);
  let upstream = 0;
  t.mock.method(globalThis, "fetch", async () => { upstream++; throw new Error("must not dispatch"); });
  for (const input of [{ temperature: 0.2 }, { temperature: null }, { tools: [{ type: "function", function: { name: "lookup" } }] }]) {
    const response = await f.call({ ...input });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "model_parameter_unsupported");
    await f.drain();
  }
  assert.equal(upstream, 0);
  assert.deepEqual(f.ledgerCalls, []);
  assert.equal(f.events.length, 3);
  assert.ok(f.events.every((event) => event.compound_request_stage === "fusion_synthesizer" && event.compound_request_size === 1 && event.actual_cost_micros === 0));
});

test("Astra and opaque local advisers omit speculative sampling and reasoning", async (t) => {
  parameterFacts(t);
  const f = await fixture("openai/gpt-4.1-mini", ["openai/gpt-6-astra", "local/fixture"]);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "fixture answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const response = await f.call({ temperature: 0.8 });
  assert.equal(response.status, 200);
  await response.text(); await f.drain();
  assert.equal(sent.length, 3);
  for (const adviser of sent.slice(0, 2)) {
    assert.equal(adviser.temperature, undefined);
    assert.equal(adviser.reasoning_effort, undefined);
  }
  assert.equal(sent.at(-1).temperature, 0.8);
  assert.equal(sent.at(-1).model, "gpt-4.1-mini");
});

test("GPT-5.4 preserves explicit none and sampling, and rejects high before fanout", async (t) => {
  parameterFacts(t);
  const f = await fixture("openai/gpt-5.4", ["openai/gpt-4.1-mini"]), sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "fixture answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  for (const input of [{ temperature: 0.7 }, { temperature: 0.7, reasoning_effort: "none" }]) {
    const response = await f.call(input);
    assert.equal(response.status, 200);
    await response.text(); await f.drain();
    assert.equal(sent.at(-2).temperature, 0.2);
    assert.equal(sent.at(-1).temperature, 0.7);
    assert.equal(sent.at(-1).reasoning_effort, input.reasoning_effort);
  }
  const before = f.ledgerCalls.length;
  const denied = await f.call({ temperature: 0.7, reasoning_effort: "high" });
  assert.equal(denied.status, 400);
  await denied.text(); await f.drain();
  assert.equal(sent.length, 4);
  assert.equal(f.ledgerCalls.length, before);
});

test("direct public, native and manifest requests keep explicit unsupported fields", async (t) => {
  parameterFacts(t);
  const f = await fixture("openai/gpt-6-astra", ["local/fixture"]), sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const body = { model: "openai/gpt-6-astra", messages: [], temperature: 0.7, logprobs: false, tools: [], reasoning_effort: null };
  for (const [path, input] of [["/v1/chat/completions", body], ["/v1/native/openai/v1/chat/completions", body], ["/v1/proxy/openai/chat_completions", { body }]]) {
    const response = await f.callRaw(path, input);
    assert.equal(response.status, 200);
    await response.text(); await f.drain();
    assert.deepEqual(sent.at(-1), { ...body, model: "gpt-6-astra" });
  }
});

test("compiled OpenAI parameter facts govern the actual Fusion handler", async (t) => {
  const openai = providerById("openai"), sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "fixture answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const tools = [{ type: "function", function: { name: "lookup" } }];
  for (const [id, conflict, accepted, adviserTemperature] of [
    ["gpt-6-astra", { temperature: 0.2 }, {}, undefined],
    ["gpt-5.4", { temperature: 0.2, reasoning_effort: "high" }, { temperature: 0.2, reasoning_effort: "none" }, 0.2],
    ...["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((id) => [id, { tools }, { tools, reasoning_effort: "none" }, undefined]),
    ["gpt-4.1-mini", null, { temperature: 0.6 }, 0.2],
  ]) {
    const modelId = `openai/${id}`;
    assert.ok(openai.models.find(({ id }) => id === modelId)?.requestParameters?.chat_completions, `${id} requires compiled facts`);
    const f = await fixture(modelId, ["openai/gpt-4.1-mini"]);
    if (conflict) {
      const before = sent.length, response = await f.call(conflict);
      assert.equal(response.status, 400, id);
      assert.equal((await response.json()).error.code, "model_parameter_unsupported");
      await f.drain();
      assert.equal(sent.length, before, id);
      assert.deepEqual(f.ledgerCalls, [], id);
    }
    const response = await f.call(accepted);
    assert.equal(response.status, 200, id);
    await response.text(); await f.drain();
    assert.equal(sent.at(-1).model, id);
    for (const [field, value] of Object.entries(accepted)) assert.deepEqual(sent.at(-1)[field], value, `${id}:${field}`);

    const adviser = await fixture("openai/gpt-4.1-mini", [modelId]);
    const advised = await adviser.call({});
    assert.equal(advised.status, 200, id);
    await advised.text(); await adviser.drain();
    assert.equal(sent.at(-2).model, id);
    assert.equal(sent.at(-2).temperature, adviserTemperature, id);
    assert.equal(sent.at(-2).reasoning_effort, undefined, id);
  }
});

const hostedModels = [
  ["groq", "gpt-oss-120b", "openai/gpt-oss-120b", ["low", "medium", "high"]],
  ["fireworks", "gpt-oss-120b", "accounts/fireworks/models/gpt-oss-120b", ["low", "medium", "high"]],
  ["fireworks", "glm-5.2", "accounts/fireworks/models/glm-5p2", ["none", "low", "medium", "high", "xhigh", "max"]],
];

test("compiled hosted synthesizer conflicts stop before reservation and adviser fanout", async (t) => {
  let upstream = 0;
  t.mock.method(globalThis, "fetch", async () => { upstream++; throw new Error("must not dispatch"); });
  for (const [provider, id] of hostedModels) {
    const modelId = `${provider}/${id}`, f = await fixture(modelId, ["openai/gpt-4.1-mini"]);
    const conflicts = [
      ...["minimal", "ultra", "adaptive", ...(id === "gpt-oss-120b" ? ["none", "xhigh", "max"] : [])].map((reasoning_effort) => ({ reasoning_effort })),
      ...(provider === "groq" ? [{ logprobs: true }, { logprobs: false }, { logprobs: null }, { top_logprobs: 0 }, { top_logprobs: null }] : []),
    ];
    for (const body of conflicts) {
      const response = await f.call(body);
      assert.equal(response.status, 400, `${modelId}:${JSON.stringify(body)}`);
      assert.equal((await response.json()).error.code, "model_parameter_unsupported");
      await f.drain();
    }
    assert.deepEqual(f.ledgerCalls, [], modelId);
    assert.equal(f.events.length, conflicts.length, modelId);
    assert.ok(f.events.every((event) => event.compound_request_stage === "fusion_synthesizer" && event.actual_cost_micros === 0));
  }
  assert.equal(upstream, 0);
});

test("compiled hosted contracts preserve accepted aliases and unqualified values at dispatch", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "fixture answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  for (const [provider, id, upstream, efforts] of hostedModels) {
    // The fixture's explicit fixed-zero tariff admits the unpriced Fireworks
    // GPT-OSS entry without inventing a model price or proving upstream acceptance.
    const f = await fixture(`${provider}/${id}`, ["openai/gpt-4.1-mini"]);
    for (const body of [{}, ...efforts.map((reasoning_effort) => ({ reasoning_effort })), ...[null, false, 2048].map((reasoning_effort) => ({ reasoning_effort, temperature: 0.7, top_p: 0.9, tools: [] }))]) {
      const before = sent.length, response = await f.call(body);
      assert.equal(response.status, 200, `${provider}/${id}:${JSON.stringify(body)}`);
      await response.text(); await f.drain();
      assert.equal(sent.length, before + 2);
      assert.equal(sent.at(-1).model, upstream);
      assert.equal(Object.hasOwn(sent.at(-1), "reasoning_effort"), Object.hasOwn(body, "reasoning_effort"));
      for (const [field, value] of Object.entries(body)) assert.deepEqual(sent.at(-1)[field], value);
    }
    const adviser = await fixture("openai/gpt-4.1-mini", [`${provider}/${id}`]);
    const response = await adviser.call({});
    assert.equal(response.status, 200);
    await response.text(); await adviser.drain();
    assert.equal(sent.at(-2).model, upstream);
    assert.equal(sent.at(-2).temperature, undefined);
    assert.equal(sent.at(-2).reasoning_effort, undefined);
  }
});

test("hosted parameter facts leave public, native, manifest and opaque passthrough unchanged", async (t) => {
  const sent = [], f = await fixture("openai/gpt-4.1-mini", ["local/fixture"]);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  for (const [provider, id, upstream] of [...hostedModels, ["groq", "fixture-opaque", "fixture-opaque"], ["fireworks", "fixture-opaque", "fixture-opaque"]]) {
    const fields = { messages: [], reasoning_effort: "ultra", temperature: 0.7, logprobs: false, top_logprobs: 0, tools: [] };
    const publicBody = { ...fields, model: `${provider}/${id}` };
    for (const [path, body] of [
      ["/v1/chat/completions", publicBody],
      [`/v1/native/${provider}/v1/chat/completions`, { ...fields, model: upstream }],
      [`/v1/proxy/${provider}/chat_completions`, { body: publicBody }],
    ]) {
      const response = await f.callRaw(path, body);
      assert.equal(response.status, 200, `${provider}/${id}:${path}`);
      await response.text(); await f.drain();
      assert.deepEqual(sent.at(-1), { ...fields, model: upstream });
    }
  }
});

async function fixture(aggregatorModel, adviserModels) {
  const pending = [], events = [], ledgerCalls = [], secret = "fixture-fusion-secret";
  const config = normalizeFusionConfig({ enabled: true, aggregatorModel, adviserModels, maxProposalChars: 256 });
  const policy = { enabled: true, generation: "g1", providers: [], tenantId: "default", monthlyBudgetMicros: 1_000_000, requestCostMicros: 0, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const env = {
    OPENAI_API_KEY: "fixture-upstream-key", GROQ_API_KEY: "fixture-groq-key", FIREWORKS_API_KEY: "fixture-fireworks-key", LOCAL_OPENAI_BASE_URL: "https://local-provider.example",
    POLICY_KV: { get: async (key) => key === "config/fusion" ? config : Array.isArray(key) ? new Map(key.map((item) => [item, null])) : null },
    USAGE_QUEUE: { send: async (event) => { events.push(event); } },
    BUDGET_LEDGER: { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname; ledgerCalls.push(path);
      return Response.json(path === "/reserve" ? { allowed: true } : path === "/dispatch" ? { dispatched: true } : { settled: true });
    } }) },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: JSON.parse(init.body).providerIds.map((providerId) => ({ providerId, enabled: true, monthlyBudgetMicros: null })), missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`unexpected authority call ${path}`);
    } }) },
  };
  const callRaw = (path, body) => worker.fetch(new Request(`https://router.example${path}`, {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  return { events, ledgerCalls, callRaw, call: (body) => callRaw("/v1/chat/completions", { model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture input" }], ...body }),
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}
