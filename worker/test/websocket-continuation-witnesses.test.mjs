import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { HttpContinuation, continuationScope, identityKey } from "../http-continuation.ts";
import { WebSocketContinuationWitnesses, websocketContinuationWitnessLimit } from "../websocket-continuation-witnesses.ts";

const owner = { providerId: "openai", endpointId: "responses", grantKey: "oauth/fixture/account", lineage: "lineage-1", routeSha256: "a".repeat(64), policyGeneration: "g1" };
const pin = { providerId: "openai", endpointId: "responses", key: owner.grantKey, revision: "revision-1" };
const auth = { authType: "proxy_key", policyId: "fixture", credentialId: "fixture", principalId: "fixture", policy: { tenantId: "default", generation: "g1" } };
const selection = body => ({ capability: "llm.responses", provider: { id: "openai", capabilities: [] }, endpoint: { id: "responses" }, body });
const restart = error => error.status === 409 && error.code === "continuation_restart_required";

function fixture(t) {
  const env = {};
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  const witnesses = new WebSocketContinuationWitnesses();
  const f = { env, witnesses, resolves: 0, intercept: null };
  env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    const body = await request.clone().json();
    if (body.action === "resolve") f.resolves++;
    await f.intercept?.(body);
  };
  f.resolve = (body = {}, options = {}) => HttpContinuation.resolve(
    new Request("https://fixture/responses", { headers: options.headers, signal: options.signal }),
    { ...selection(body), ...options.selection }, options.auth ?? auth, env, options.transport ?? "websocket",
    { witnesses: options.witnesses ?? witnesses, pin: options.pin ?? pin },
  );
  f.producer = async (id = "parent", input = {}) => {
    const producer = await f.resolve(input);
    producer.bind(owner);
    await producer.publishFrame([{ kind: "response", value: id }, { kind: "turn", value: `turn-${id}` }], { type: "response.created", response: { id } });
    return producer;
  };
  f.finish = async (producer, id = "parent") => {
    await producer.publishFrame([{ kind: "response", value: id }], { type: "response.completed", response: { id, output: [] } });
    producer.rememberWebSocket(witnesses, pin);
  };
  return f;
}

for (const knowledge of ["token_only", "hosted_tool_fee", "unknown"]) test(`same-socket witness preserves durable ${knowledge} pricing and owner for every carrier`, async t => {
  const f = fixture(t);
  const input = knowledge === "token_only" ? {} : { input: [{ type: "additional_tools", tools: knowledge === "hosted_tool_fee" ? [{ type: "web_search" }] : [{ type: "future_tool" }] }] };
  const producer = await f.producer("parent", input); await f.finish(producer);
  for (const body of [{ previous_response_id: "parent" }, { client_metadata: { "x-codex-turn-state": "turn-parent" } }, { previous_response_id: "parent", client_metadata: { "x-codex-turn-state": "turn-parent" } }]) {
    const child = await f.resolve(body);
    assert.deepEqual(child.pinned, { key: owner.grantKey, lineage: owner.lineage });
    assert.equal(child.parentTools, body.previous_response_id ? knowledge : "token_only");
  }
  assert.equal(f.resolves, 0);
  const scope = await continuationScope(auth), key = await identityKey({ kind: "response", value: "parent" });
  const stored = await (await f.env.ACCESS_CONTROL.get(scope).fetch("https://fixture/http-continuations", { method: "POST", body: JSON.stringify({ action: "resolve", keys: [key] }) })).json();
  assert.deepEqual(f.witnesses.resolve([{ kind: "response", value: "parent" }], scope, "g1", "openai", "responses", pin), stored);
});

for (const change of ["other socket", "HTTP", "generation", "scope", "provider", "endpoint", "grant key", "grant revision", "closed", "evicted", "unknown identity", "mixed identities"]) test(`witness falls back to authority: ${change}`, async t => {
  const f = fixture(t), producer = await f.producer(); await f.finish(producer);
  let body = { previous_response_id: "parent" }, options = {};
  if (change === "other socket") options.witnesses = new WebSocketContinuationWitnesses();
  if (change === "HTTP") options.transport = "http";
  if (change === "generation") options.auth = { ...auth, policy: { ...auth.policy, generation: "g2" } };
  if (change === "scope") options.auth = { ...auth, principalId: "other" };
  if (change === "provider") options.selection = { provider: { id: "other" } };
  if (change === "endpoint") options.selection = { endpoint: { id: "other" } };
  if (change === "grant key") options.pin = { ...pin, key: "oauth/fixture/other" };
  if (change === "grant revision") options.pin = { ...pin, revision: "revision-2" };
  if (change === "closed") { f.witnesses.close(); producer.rememberWebSocket(f.witnesses, pin); }
  if (change === "evicted") for (let index = 0; index < websocketContinuationWitnessLimit; index++) {
    const id = `new-${index}`, next = await f.producer(id); await f.finish(next, id);
  }
  if (change === "unknown identity") body.previous_response_id = "unknown";
  if (change === "mixed identities") body.client_metadata = { "x-codex-turn-state": "unknown" };
  const rejected = ["generation", "scope", "provider", "endpoint", "unknown identity", "mixed identities"].includes(change);
  if (rejected) await assert.rejects(f.resolve(body, options), restart);
  else assert.equal((await f.resolve(body, options)).parentTools, "token_only");
  assert.equal(f.resolves, 1);
});

for (const phase of ["register", "qualify"]) for (const failure of [false, true]) test(`${phase} ${failure ? "failure" : "pending write"} never creates a witness`, async t => {
  const f = fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  t.after(() => gate.resolve());
  const producer = phase === "qualify" ? await f.producer() : await f.resolve();
  if (phase === "register") producer.bind(owner);
  f.intercept = async body => { if (body.action === phase) { entered.resolve(); await gate.promise; if (failure) throw new Error("fixture write failed"); } };
  const write = phase === "register" ? producer.publishFrame([{ kind: "response", value: "parent" }], { type: "response.created", response: { id: "parent" } }) : f.finish(producer);
  const caught = write.catch(error => error);
  await entered.promise;
  producer.rememberWebSocket(f.witnesses, pin);
  if (phase === "register") await assert.rejects(f.resolve({ previous_response_id: "parent" }), restart);
  else assert.equal((await f.resolve({ previous_response_id: "parent" })).parentTools, "unknown");
  assert.equal(f.resolves, 1);
  gate.resolve(); await caught;
  if (failure) {
    producer.rememberWebSocket(f.witnesses, pin);
    if (phase === "register") await assert.rejects(f.resolve({ previous_response_id: "parent" }), restart);
    else assert.equal((await f.resolve({ previous_response_id: "parent" })).parentTools, "unknown");
    assert.equal(f.resolves, 2);
  }
});

test("conflicting header and metadata tokens reject before any lookup, including witnessed tokens", async t => {
  const f = fixture(t), producer = await f.producer(); await f.finish(producer);
  await assert.rejects(f.resolve({ previous_response_id: "parent", client_metadata: { "x-codex-turn-state": "turn-parent" } }, { headers: { "x-codex-turn-state": "other" } }), restart);
  assert.equal(f.resolves, 0);
});

test("a lost qualification ACK falls back to the committed durable proof", async t => {
  const f = fixture(t), producer = await f.producer();
  const get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  f.env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
    const response = await get(name).fetch(url, init);
    if (JSON.parse(init.body).action === "qualify") throw new Error("fixture lost ACK after commit");
    return response;
  } });
  await f.finish(producer);
  assert.equal((await f.resolve({ previous_response_id: "parent" })).parentTools, "token_only");
  assert.equal(f.resolves, 1);
});

test("a witness still rejects a changed prepared owner lineage", async t => {
  const f = fixture(t), producer = await f.producer(); await f.finish(producer);
  const child = await f.resolve({ previous_response_id: "parent" });
  assert.throws(() => child.bind({ ...owner, lineage: "lineage-2" }), restart);
  assert.equal(f.resolves, 0);
});
