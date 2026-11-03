import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
import { managedMediaEnvelopeBytes } from "../managed-media-json.ts";

const load = path => JSON.parse(readFileSync(new URL("../../providers/_fixtures/" + path, import.meta.url), "utf8"));
const contracts = load("media/managed-routes.json");
const cases = contracts.protocols.map(route => ({ route, wire: load(route.fixture), adapter: managedLifecycleAdapter(route.protocol) }));
const item = protocol => cases.find(c => c.route.protocol === protocol);
const id = ({ wire }) => wire.requestId ?? wire.submission?.data?.taskId ?? wire.submission?.id ?? wire.responses.created.id;
const context = (c, action) => ({ action, ...(action === "create" ? {} : { expectedId: id(c) }),
  requestedVersion: c.wire.endpointId ?? c.wire.request.body.version ?? c.wire.request.body.model ?? c.wire.request.body.workflow,
  pathParams: c.route.pathParams });
const response = (body, status = 200) => Response.json(body, { status });
const publicPaths = { retrieve: "/v1/native/fixture/jobs/job_fixture",
  result: "/v1/native/fixture/jobs/job_fixture/result", cancel: "/v1/native/fixture/jobs/job_fixture/cancel" };

test("managed registry requires both explicit protocol and matching create format", () => {
  for (const { route, adapter } of cases) {
    assert.equal(managedCreateAdapter(route.protocol, route.requestFormat), adapter);
    assert.equal(managedCreateAdapter(route.protocol, "openai.chat_completions"), undefined);
    assert.equal(adapter.supportsResult, !!route.result);
    assert.equal(adapter.supportsCancel, !!route.cancel);
  }
  for (const protocol of ["unknown", "__proto__", "kie.market-jobs", "comfy.jobs"]) assert.equal(managedLifecycleAdapter(protocol), undefined);
});

test("managed preparation strips caller transport credentials and replay hints", () => {
  const headers = new Headers({ authorization: "Bearer synthetic-caller", prefer: "wait=60", "idempotency-key": "synthetic-retry" });
  for (const c of cases) {
    const body = c.wire.submit?.body ?? c.wire.request.body;
    const prepared = c.adapter.prepare(body, headers, c.route.pathParams, new URLSearchParams());
    assert.deepEqual(prepared.body, body);
    assert.deepEqual(prepared.pathParams, c.route.pathParams);
    for (const name of ["authorization", "prefer", "idempotency-key"]) assert.equal(prepared.headers.has(name), false);
    assert.throws(() => c.adapter.prepare(body, headers, c.route.pathParams, new URLSearchParams("webhook=https://callback.example")), /query/);
  }
  const fal = item("fal.queue");
  assert.equal(fal.adapter.prepare(fal.wire.submit.body, headers, fal.route.pathParams, new URLSearchParams()).headers.get("X-Fal-No-Retry"), "1");
});

test("managed controls use only qualified methods, paths and original route fields", () => {
  for (const c of cases) for (const action of ["retrieve", "result", "cancel"]) {
    const endpoint = c.route[action];
    if (!endpoint) {
      assert.throws(() => c.adapter.control(action, { method: "GET", path: "/arbitrary" }, id(c), c.route.pathParams));
      continue;
    }
    const control = c.adapter.control(action, endpoint, id(c), c.route.pathParams);
    const expected = c.route.protocol === "fal.queue" ? c.wire.controls[action === "retrieve" ? "status" : action].path
      : c.route.protocol === "replicate.predictions" ? c.wire.controls[action === "retrieve" ? "get" : action].path
      : c.wire[action === "retrieve" ? "read" : "cancel"].path;
    assert.equal(control.path + (control.query.size ? "?" + control.query : ""), expected);
    assert.throws(() => c.adapter.control(action, { ...endpoint, path: "https://untrusted.example/" }, id(c), c.route.pathParams));
    assert.throws(() => c.adapter.control(action, { ...endpoint, method: "PATCH" }, id(c), c.route.pathParams));
    assert.throws(() => c.adapter.control(action, endpoint, "../foreign", c.route.pathParams));
  }
});

test("managed native identity parsing rejects duplicate query IDs and unrelated fields", () => {
  const identities = {
    "replicate.predictions": { prediction_id: id(item("replicate.predictions")) },
    "fal.queue": { owner: "fal-ai", app: "flux", request_id: id(item("fal.queue")) },
    "vydra.jobs": { job_id: id(item("vydra.jobs")) },
  };
  for (const c of cases) {
    const params = identities[c.route.protocol] ?? {};
    const query = c.route.protocol === "kie.jobs" ? new URLSearchParams({ taskId: id(c) }) : new URLSearchParams();
    assert.equal(c.adapter.identify("retrieve", params, query), id(c));
    assert.throws(() => c.adapter.identify("retrieve", { ...params, url: "untrusted" }, query));
    const extra = new URLSearchParams(query); extra.append("redirect", "untrusted");
    assert.throws(() => c.adapter.identify("retrieve", params, extra));
  }
  const kie = item("kie.jobs");
  assert.throws(() => kie.adapter.identify("retrieve", {}, new URLSearchParams("taskId=a&taskId=b")));
  assert.throws(() => kie.adapter.identify("cancel", {}, new URLSearchParams({ taskId: id(kie) })), /unsupported_kie_control/);
});

test("Replicate wrapper keeps aborted terminal with absent metrics and partial output open", async () => {
  const c = item("replicate.predictions");
  const aborted = await c.adapter.read(response(c.wire.responses.aborted), context(c, "retrieve"));
  assert.equal(aborted.terminal, "aborted");
  assert.equal(aborted.followUp, undefined);
  assert.equal((await c.adapter.read(response(c.wire.responses.partial), context(c, "retrieve"))).terminal, null);
  assert.equal(contracts.accounting.actualUpstreamCostMicros, null);
});

test("fal submit binds an ID before status; COMPLETED requests a scoped result instead of success", async () => {
  const c = item("fal.queue");
  const created = await c.adapter.read(response({ request_id: id(c) }, 202), context(c, "create"));
  assert.equal(created.followUp, "retrieve"); assert.equal(created.terminal, null);
  const completed = await c.adapter.read(response(c.wire.observations.completed), context(c, "retrieve"));
  assert.equal(completed.followUp, "result"); assert.equal(completed.terminal, null);
  const failed = await c.adapter.read(response(c.wire.observations.failed), context(c, "retrieve"));
  assert.equal(failed.terminal, "failed");
  const success = await c.adapter.read(response(c.wire.results.success), context(c, "result"));
  assert.equal(success.id, id(c)); assert.equal(success.terminal, "succeeded");
  const rejected = await c.adapter.read(response({ detail: [{ msg: "Synthetic invalid input" }] }, 422), context(c, "result"));
  assert.equal(rejected.terminal, "failed");
  for (const status of [401, 404, 429, 500, 503]) {
    await assert.rejects(c.adapter.read(response({ error: "Synthetic transient control failure" }, status), context(c, "result")));
  }
});

test("fal cancel distinguishes removed queued jobs from acknowledged or uncertain in-progress cancellation", async () => {
  const c = item("fal.queue");
  for (const ack of c.wire.cancelAcks) {
    const observed = await c.adapter.read(response(ack.body, ack.httpStatus), context(c, "cancel"));
    assert.equal(observed.terminal, ack.queueTerminal ? "canceled" : null);
    assert.equal(observed.followUp, ack.observeStatus ? "retrieve" : undefined);
  }
});

test("Kie preserves pending and known terminal states without unsupported cancellation", async () => {
  const c = item("kie.jobs");
  assert.equal((await c.adapter.read(response(c.wire.submission), context(c, "create"))).followUp, "retrieve");
  for (const name of ["waiting", "queuing", "partial"]) assert.equal((await c.adapter.read(response(c.wire.responses[name]), context(c, "retrieve"))).terminal, null);
  assert.equal((await c.adapter.read(response(c.wire.responses.success), context(c, "retrieve"))).terminal, "succeeded");
  assert.equal((await c.adapter.read(response(c.wire.responses.failed), context(c, "retrieve"))).terminal, "failed");
  for (const name of ["authError", "foreignTask"]) await assert.rejects(c.adapter.read(response(c.wire.responses[name]), context(c, "retrieve")));
  await assert.rejects(c.adapter.read(response({ success: true }), context(c, "cancel")), /unsupported_kie_control/);
});

test("Vydra immediate create and DELETE acknowledgement require GET; later success wins the observed cancel race", async () => {
  const c = item("vydra.jobs");
  const created = await c.adapter.read(response({ ...c.wire.submission, status: "completed" }), context(c, "create"));
  assert.equal(created.terminal, null); assert.equal(created.followUp, "retrieve");
  const ack = await c.adapter.read(response(c.wire.cancel.response), context(c, "cancel"));
  assert.equal(ack.terminal, null); assert.equal(ack.followUp, "retrieve");
  assert.equal((await c.adapter.read(response(c.wire.responses.partial), context(c, "retrieve"))).terminal, null);
  assert.equal((await c.adapter.read(response(c.wire.responses.completed), context(c, "retrieve"))).terminal, "succeeded");
  assert.equal((await c.adapter.read(response(c.wire.responses.failed), context(c, "retrieve"))).terminal, "failed");
  assert.equal((await c.adapter.read(response(c.wire.responses.cancelled), context(c, "retrieve"))).terminal, "canceled");
});

test("managed reads reject mismatched and missing bound identities without upstream IO", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("wrapper attempted upstream IO"); });
  for (const c of cases) {
    const body = c.wire.observations?.running ?? c.wire.responses.partial;
    await assert.rejects(c.adapter.read(response(body), { ...context(c, "retrieve"), expectedId: "foreign_job" }));
    await assert.rejects(c.adapter.read(response(body), { ...context(c, "retrieve"), expectedId: undefined }));
  }
});

test("managed media readers cancel oversized streams and reject malformed UTF-8, content types and redirects", async () => {
  for (const c of cases) {
    let canceled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(managedMediaEnvelopeBytes + 1)); }, cancel() { canceled = true; } });
    await assert.rejects(c.adapter.read(new Response(stream, { headers: { "content-type": "application/json" } }), context(c, "retrieve")));
    assert.equal(canceled, true);
    await assert.rejects(c.adapter.read(new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), context(c, "retrieve")));
    await assert.rejects(c.adapter.read(new Response("{}"), context(c, "retrieve")));
    await assert.rejects(c.adapter.read(new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }), context(c, "retrieve")));
  }
});

test("managed rewriting removes upstream control URLs while leaving media outputs transient", async () => {
  for (const c of cases) {
    const native = c.wire.observations?.hostileUrls ?? c.wire.responses.hostileUrls ?? c.wire.responses.completed ?? c.wire.responses.success;
    const observed = await c.adapter.read(response(native), context(c, "retrieve"));
    observed.body = { ...observed.body, _links: { self: "https://untrusted.example/control" } };
    const rewritten = c.adapter.rewrite(observed, publicPaths);
    assert.equal(rewritten._links, undefined);
    assert.equal(JSON.stringify(rewritten).includes("https://untrusted.example/control"), false);
    if (c.route.protocol === "fal.queue") {
      assert.equal(rewritten.status_url, publicPaths.retrieve);
      assert.throws(() => c.adapter.rewrite(observed, { ...publicPaths, retrieve: "//untrusted.example" }));
    }
    if (c.route.protocol === "vydra.jobs") assert.deepEqual(rewritten.output, observed.body.output);
  }
});
