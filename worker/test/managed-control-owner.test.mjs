import assert from "node:assert/strict";
import test from "node:test";
import { fixture, contract, path } from "./managed-runtime-fixture.mjs";
const alternative = "/v1/native/replicate/v1/alternative", id = "fixture-alternative";
const control = `${path}/${id}`;
async function setup(t, options = {}) {
  const f = await fixture(t, { pooled: true, configure(provider) {
    const create = provider.endpoints.find(endpoint => endpoint.id === "predictions");
    const get = provider.endpoints.find(endpoint => endpoint.id === "prediction"), cancel = provider.endpoints.find(endpoint => endpoint.id === "prediction_cancel");
    provider.endpoints.push({ ...structuredClone(create), id: "alternative", path: "/v1/alternative", lifecycle: { protocol: "replicate.predictions", retrieve: options.sharedLink ? "prediction" : "alternative_get", cancel: "alternative_cancel" } });
    if (!options.sharedLink) provider.endpoints.push({ ...structuredClone(get), id: "alternative_get" });
    provider.endpoints.push({ ...structuredClone(cancel), id: "alternative_cancel" });
    provider.capabilities.push({ ...provider.capabilities.find(capability => capability.endpoint === create.id), endpoint: "alternative" });
  } });
  f.upstream = request => Response.json({ ...(request.method === "POST" ? contract.responses.created : contract.responses.succeeded), id });
  return f;
}

for (const sharedLink of [false, true]) test(`native controls resolve original create ownership with ${sharedLink ? "one shared endpoint" : "duplicate native paths"} before and after compaction`, async t => {
  const f = await setup(t, { sharedLink });
  const created = await f.call(alternative); assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created);
  const owner = () => JSON.parse(state.state.db.prepare("SELECT owner_json FROM http_continuations WHERE background_job_id = ?").get(state.id).owner_json);
  assert.equal(owner().endpointId, "alternative");
  const retrieved = await f.call(control, null); assert.equal(retrieved.status, 200, await retrieved.clone().text());
  f.provider.endpoints.reverse(); f.restart();
  await state.alarm(); await f.drain(); assert.equal(state.job().phase, "complete");
  const after = await f.call(control, null); assert.equal(after.status, 200, await after.clone().text());
  assert.equal(owner().endpointId, "alternative"); assert.equal((await f.events()).length, 1); assert.equal(state.job().amount, 700);
  assert.equal(f.sent[0].url, "https://api.replicate.com/v1/alternative");
  assert.ok(f.sent.slice(1).every(request => request.url === `https://api.replicate.com/v1/predictions/${id}`));
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
});

test("explicit manifest controls cannot borrow a different create route, while a declared shared link resolves its owner", async t => {
  const f = await setup(t); assert.equal((await f.call(alternative)).status, 200);
  const wrong = await f.call(`/v1/proxy/replicate/prediction?prediction_id=${id}`, null); assert.equal(wrong.status, 409); assert.equal(f.sent.length, 1);
  const correct = await f.call(`/v1/proxy/replicate/alternative_get?prediction_id=${id}`, null); assert.equal(correct.status, 200, await correct.clone().text());
  const unknown = await f.call(path + "/unknown-job", null); assert.equal(unknown.status, 409); assert.equal(f.sent.length, 2);
});

test("shared manifest endpoint resolves the original create route instead of its first declaration", async t => {
  const f = await setup(t, { sharedLink: true }); assert.equal((await f.call(alternative)).status, 200);
  const result = await f.call(`/v1/proxy/replicate/prediction?prediction_id=${id}`, null); assert.equal(result.status, 200, await result.clone().text());
  assert.equal(f.sent.length, 2);
});

for (const ambiguity of ["protocol", "action", "ordinary-route"]) test(`${ambiguity} collisions fail closed before any original-job control egress`, async t => {
  const f = await setup(t); assert.equal((await f.call(alternative)).status, 200);
  const first = f.provider.endpoints.find(endpoint => endpoint.id === "predictions");
  if (ambiguity === "protocol") first.lifecycle.protocol = "kie.jobs";
  if (ambiguity === "action") { first.lifecycle.result = first.lifecycle.retrieve; delete first.lifecycle.retrieve; }
  if (ambiguity === "ordinary-route") f.provider.endpoints.push({ ...structuredClone(f.provider.endpoints.find(endpoint => endpoint.id === "prediction")), id: "unbound-native-route" });
  const result = await f.call(control, null); assert.equal(result.status, 409); assert.equal(f.sent.length, 1);
});
