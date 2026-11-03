import assert from "node:assert/strict";
import test from "node:test";
import { googleContinuationFixture as setup, googleOriginalRequest as original, googleContinuationResponse as output, googleContinuationToken as token } from "./google-continuation-fixture.mjs";
import { grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const next = () => ({ ...structuredClone(original), continuationToken: token });
async function denied(response, code = "google_continuation_owner_unavailable") {
  const value = await response.json(); assert.ok(response.status >= 400, JSON.stringify(value));
  if (code) assert.equal(value.error.code, code);
  assert.doesNotMatch(JSON.stringify(value), /c3ludGhldGljLW9yaWdpbmFsLXN0YXRl|synthetic-original-key|synthetic-google-environment|Synthetic original request/);
}

for (const stream of [false, true]) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Google ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"}/${pooled ? "pooled" : "environment"} preserves original owner through restart and separately settles each hop`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { stream, manifest, pooled }); await f.initial();
    const bindings = f.continuations(); assert.equal(bindings.length, 1);
    assert.doesNotMatch(JSON.stringify(bindings), /c3ludGhldGljLW9yaWdpbmFsLXN0YXRl|Synthetic original request|synthetic-original-key|synthetic-google-environment/);
    f.restart(); const response = await f.request(next()); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), f.wire()); await f.drain();
    assert.equal(f.sent.length, 2); assert.ok(f.sent.every(request => request.headers.get("x-goog-api-key") === (pooled ? "synthetic-original-key" : "synthetic-google-environment")));
    assert.ok(f.sent.every(request => request.redirect === "manual"));
    assert.deepEqual(await f.sent[1].clone().json(), next()); assert.deepEqual(f.continuations(), bindings);
    const events = await f.events(); assert.equal(events.length, 2); assert.ok(events.every(event => event.actual_cost_micros === 700 && event.cost_basis === "policy_fixed"));
    assert.ok(events.every(event => event.input_tokens === 12 && event.output_tokens === 5));
    const rows = f.reservations(); assert.equal(rows.length, 4); assert.ok(rows.every(row => row.settled === 1 && row.dispatch_started === 1 && row.reserved_micros === 700));
  });
}
for (const malformed of ["unknown", "", 5, {}, "Zml4dHVyZQ==\n", "x".repeat(16 * 1024 + 1)]) test(`Google unowned or malformed token ${typeof malformed}/${String(malformed).length} is zero-egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t); await denied(await f.request({ ...original, continuationToken: malformed }));
  assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
});
for (const change of ["contents", "system", "generation", "selected-id", "endpoint", "environment", "grant", "credential", "principal", "generation-policy"]) {
  test(`Google ${change} change cannot borrow the original continuation owner`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled: change === "grant" }); await f.initial(); const body = next(), options = {};
    if (change === "contents") body.contents[0].parts[0].text = "Different original request";
    if (change === "system") body.systemInstruction = { parts: [{ text: "Changed system input" }] };
    if (change === "generation") body.generationConfig.maxOutputTokens = 99;
    if (change === "selected-id") f.model.id += "-synthetic-alias";
    if (change === "endpoint") options.stream = true;
    if (change === "environment") f.env.GOOGLE_API_KEY = "synthetic-replacement";
    if (change === "grant") await putGrantCredentials(f.env, grantKey, { provider: "google-gemini", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
    if (change === "credential" || change === "principal") {
      const credential = { ...f.credential, ...(change === "principal" ? { principalId: "second@example.com" } : {}) };
      await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential });
      options.headers = { authorization: "Bearer clawrouter-live-second-fixture-secret" };
    }
    if (change === "generation-policy") { f.policy.generation = "g2"; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    await denied(await f.request(body, options), change === "generation-policy" ? null : undefined);
    assert.equal(f.sent.length, 1); assert.equal(f.reservations().length, 2);
  });
}
test("Google ProtoJSON token aliases are last-wins, including explicit null", { timeout: 10_000 }, async t => {
  const f = await setup(t); await f.initial();
  const request = { ...original, continuationToken: "unknown", continuation_token: token };
  const response = await f.request(request); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  await denied(await f.request({ ...original, continuation_token: token, continuationToken: "unknown" }));
  const plain = await f.request({ ...original, continuationToken: "unknown", continuation_token: null }); assert.equal(plain.status, 200);
  await plain.text(); assert.equal(f.sent.length, 3);
});
for (const stream of [false, true]) for (const evidence of ["wrong-reason", "nested-token", "malformed", "missing-eof", "unqualified-mime"]) {
  test(`Google ${stream ? "SSE" : "JSON"} ${evidence} does not qualify a returned token`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { stream });
    if (evidence === "wrong-reason") f.output.candidates[0].finishReason = "STOP";
    if (evidence === "nested-token") { delete f.output.candidates[0].continuationToken; f.output.candidates[0].content.parts[0].continuationToken = token; }
    if (evidence === "malformed") f.upstream = () => new Response(stream ? 'data: {"candidates":\n\n' : '{"candidates":', { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    if (evidence === "unqualified-mime") f.upstream = () => new Response(f.wire(), { headers: { "content-type": "text/plain" } });
    if (evidence === "missing-eof") f.upstream = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(f.wire()));
      // A complete JSON/frame followed by a read error is still not EOF.
    }, pull(controller) { controller.error(new Error("synthetic interruption")); } }), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    const response = await f.request(); assert.equal(response.status, 200);
    if (evidence === "missing-eof") await assert.rejects(response.text()); else await response.text();
    await f.drain(); assert.equal(f.continuations().length, 0); await denied(await f.request(next())); assert.equal(f.sent.length, 1);
    const event = (await f.events()).find(event => event.actual_cost_micros === 700); assert.ok(event);
  });
}
test("Google SSE trailing incomplete data and event:error cannot publish a prior candidate token", { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream: true });
  for (const suffix of ['data: {"partial":', 'event: error\ndata: {"message":"synthetic failure"}\n\n']) {
    f.upstream = () => new Response(f.wire() + suffix, { headers: { "content-type": "text/event-stream" } });
    const response = await f.request(); await response.text(); assert.equal(f.continuations().length, 0);
  }
});
test("Google terminal publication failure preserves the dispatched charge and never replays create", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  f.env.ACCESS_CONTROL.beforeFetch = async (scope, request) => {
    if (scope.startsWith("http-continuations:") && (await request.clone().json()).action === "register") throw new Error("synthetic unavailable authority");
  };
  const response = await f.request(); assert.equal(response.status, 200); await assert.rejects(response.text()); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.continuations().length, 0);
  assert.equal((await f.events())[0].actual_cost_micros, 700); assert.ok(f.reservations().every(row => row.settled === 1 && row.reserved_micros === 700));
});
for (const stream of [false, true]) test(`Google fragmented ${stream ? "SSE" : "JSON"} publishes only after completed delivery`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream }), bytes = new TextEncoder().encode(f.wire()); let offset = 0;
  f.upstream = () => new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 3, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
  const response = await f.request(); assert.equal(response.status, 200); assert.equal(f.continuations().length, 0);
  assert.equal(await response.text(), f.wire()); assert.equal(f.continuations().length, 1);
});
test("plain Google output keeps its wire and creates no continuation-authority record", { timeout: 10_000 }, async t => {
  const f = await setup(t); delete f.output.candidates[0].continuationToken; f.output.candidates[0].finishReason = "STOP";
  f.upstream = () => {
    assert.ok([...f.env.ACCESS_CONTROL.objects.keys()].every(name => !name.startsWith("http-continuations:")));
    return Response.json(f.output);
  };
  const response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), f.output);
  assert.equal(f.continuations().length, 0); assert.equal(f.sent.length, 1);
});
