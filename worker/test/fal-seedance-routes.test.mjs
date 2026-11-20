import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
import { mediaPublicPath } from "../managed-media-json.ts";
import { falSeedanceModels, prepareFalSeedance } from "../fal-seedance.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/seedance.json", import.meta.url)));
const adapter = managedCreateAdapter("fal.queue", "fal.queue_submit");
const params = model => {
  const [owner, app, variant, subvariant] = model.split("/");
  return { owner, app, variant, ...(subvariant === undefined ? {} : { subvariant }) };
};
const prepare = (row, pathParams = params(row.model)) => adapter.prepare(row.body, new Headers({ authorization: "Key synthetic-caller" }), pathParams, new URLSearchParams());
const root = `/v1/native/fal${wire.expectedControlRoot}`;
const paths = { retrieve: root + "/status", result: root, cancel: root + "/cancel" };
const endpoint = action => ({ method: action === "cancel" ? "PUT" : "GET", path: "/${owner}/${app}/requests/${request_id}" + (action === "retrieve" ? "/status" : action === "cancel" ? "/cancel" : "") });

test("all six published Seedance bodies pass the actual registry with exact original create parameters", () => {
  assert.deepEqual(wire.requests.map(row => row.model), [...falSeedanceModels]);
  for (const row of wire.requests) {
    const prepared = prepare(row), codec = prepareFalSeedance(row.model, row.body);
    assert.equal(prepared.requestedVersion, row.model); assert.deepEqual(prepared.body, codec.body);
    assert.deepEqual(prepared.pathParams, params(row.model)); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(prepared.headers.get("x-fal-no-retry"), "1"); assert.equal(codec.upstreamCostMicros, null);
  }
});
test("the exact dotted root identifies a control but cannot substitute for retained create parameters", () => {
  assert.equal(adapter.identify("retrieve", { owner: "bytedance", app: "seedance-2.0", request_id: wire.requestId }, new URLSearchParams()), wire.requestId);
  for (const row of wire.requests) for (const action of ["retrieve", "result", "cancel"]) {
    // Serialization exercises the wrapper contract, not real Worker restart proof.
    const retained = JSON.parse(JSON.stringify(prepare(row).pathParams));
    assert.equal(adapter.control(action, endpoint(action), wire.requestId, retained).path,
      wire.expectedControlRoot + (action === "retrieve" ? "/status" : action === "cancel" ? "/cancel" : ""));
  }
  assert.throws(() => adapter.control("retrieve", endpoint("retrieve"), wire.requestId, { owner: "bytedance", app: "seedance-2.0" }));
});
test("unknown dotted apps, fifth segments, encoded traversal and invented Seedance modes stay denied", () => {
  const row = wire.requests[0];
  for (const change of [{ app: "seedance-2.1" }, { owner: "foreign" }, { variant: "turbo" }, { subvariant: "extend" },
    { extra: "fifth" }, { app: ".." }, { app: "seedance%2e2.0" }, { app: "seedance-2.0/other" }, { subvariant: "text-to-video\n" }]) {
    assert.throws(() => prepare(row, { ...params(row.model), ...change }));
  }
  for (const app of ["seedance-2.1", "seedance-2.0/other", "seedance%2e0", ".", ".."]) {
    assert.throws(() => adapter.identify("retrieve", { owner: "bytedance", app, request_id: wire.requestId }, new URLSearchParams()));
  }
  assert.throws(() => adapter.identify("retrieve", { owner: "bytedance", app: "seedance-2.0", request_id: "foreign/path" }, new URLSearchParams()));
  assert.throws(() => adapter.identify("retrieve", { owner: "bytedance", app: "seedance-2.0", request_id: wire.requestId }, new URLSearchParams("key=synthetic")));
});
test("registered bodies use the existing native codec and never enable remote assets or unsupported options", () => {
  for (const row of wire.requests) assert.throws(() => prepare({ ...row, body: { ...row.body, size: "1280x720" } }));
  for (const row of wire.requests.filter(row => row.model.endsWith("/image-to-video"))) {
    assert.throws(() => prepare({ ...row, body: { ...row.body, image_url: "https://assets.example/unowned.png" } }));
  }
  for (const row of wire.requests.filter(row => row.model.endsWith("/reference-to-video"))) {
    assert.throws(() => prepare({ ...row, body: { ...row.body, image_urls: ["https://assets.example/unowned.png"] } }));
  }
});
test("only the exact fal Seedance public control root escapes the generic no-dot rule", async () => {
  const row = wire.requests[0], observed = await adapter.read(Response.json(wire.submit), { action: "create", requestedVersion: row.model, pathParams: params(row.model) });
  const rewritten = adapter.rewrite(observed, paths);
  assert.equal(rewritten.status_url, paths.retrieve); assert.equal(rewritten.response_url, paths.result); assert.equal(rewritten.cancel_url, paths.cancel);
  assert.throws(() => mediaPublicPath(paths.retrieve), /invalid_managed_media_public_path/, "other wrappers retain the strict generic validator");
  for (const retrieve of [root.replace("seedance-2.0", "seedance-2.1"), root.replace("bytedance", "foreign"), root.replace("/fal/", "/foreign/"),
    root + "/extra", root + "/status?key=synthetic", root + "/../status", root + "/%2e%2e/status", root + "/status\n",
    "https://queue.fal.run" + wire.expectedControlRoot, "//untrusted.example/seedance-2.0", undefined]) {
    assert.throws(() => adapter.rewrite(observed, { ...paths, retrieve }));
  }
});
test("completion requires a scoped result; cancel acknowledgement and missing observations do not become free terminal jobs", async () => {
  const row = wire.requests[0], context = action => ({ action, requestedVersion: row.model, pathParams: params(row.model), expectedId: wire.requestId });
  assert.equal((await adapter.read(Response.json(wire.running), context("retrieve"))).terminal, null);
  const complete = await adapter.read(Response.json(wire.completed), context("retrieve"));
  assert.equal(complete.terminal, null); assert.equal(complete.followUp, "result");
  const ack = await adapter.read(Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 }), context("cancel"));
  assert.equal(ack.terminal, null); assert.equal(ack.followUp, "retrieve");
  const done = await adapter.read(Response.json(wire.result), context("result"));
  assert.equal(done.terminal, "succeeded"); assert.equal(done.followUp, undefined);
  assert.equal(prepareFalSeedance(row.model, row.body).upstreamCostMicros, null);
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
  await assert.rejects(adapter.read(Response.json({ error: "unavailable" }, { status: 404 }), context("retrieve")));
});
test("wrapper preparation and bound controls have no I/O or remote POST replay", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper fetch"); });
  for (const row of wire.requests) {
    const prepared = prepare(row);
    assert.equal(adapter.control("retrieve", endpoint("retrieve"), wire.requestId, prepared.pathParams).path, wire.expectedControlRoot + "/status");
  }
});
