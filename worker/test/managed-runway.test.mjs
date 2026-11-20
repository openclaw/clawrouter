import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRunwayManagedAdapter, runwayModels, runwayApiVersion } from "../managed-runway.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/runway/lifecycle.json", import.meta.url), "utf8"));
const adapter = createRunwayManagedAdapter("text"), id = wire.created.id;
const context = { action: "retrieve", expectedId: id, requestedVersion: "gen4.5", pathParams: {} };
const prepare = (mode, body) => createRunwayManagedAdapter(mode).prepare(body, new Headers({ authorization: "Bearer synthetic-caller", "x-runway-version": "unsafe-latest" }), {}, new URLSearchParams());
const observe = value => adapter.read(Response.json({ id, ...value }), context);

test("Runway keeps three distinct frozen create shapes and the required native version", () => {
  for (const mode of ["text", "image", "video"]) {
    const result = prepare(mode, wire[mode].body);
    assert.equal(result.body, wire[mode].body);
    assert.equal(result.requestedVersion, wire[mode].body.model);
    assert.equal(result.headers.get("x-runway-version"), runwayApiVersion);
    assert.equal(result.headers.get("authorization"), null);
  }
  assert.deepEqual(runwayModels.video, ["gen4_aleph"]);
  assert.throws(() => prepare("text", { ...wire.text.body, model: "gen4_turbo" }));
  assert.throws(() => prepare("video", { ...wire.video.body, model: "aleph2" }));
  assert.throws(() => prepare("video", { ...wire.video.body, duration: 5 }));
  assert.throws(() => prepare("text", { ...wire.text.body, ratio: "960:960" }));
  assert.throws(() => prepare("text", { ...wire.text.body, callback: "https://example.com" }));
});

test("Runway validates prompt/duration bounds and rejects unbound upload references", () => {
  assert.throws(() => prepare("text", { ...wire.text.body, promptText: "😀".repeat(501) }));
  for (const duration of [1, 11, 2.5, "5"]) assert.throws(() => prepare("text", { ...wire.text.body, duration }));
  for (const model of ["veo3.1", "veo3.1_fast"]) {
    assert.throws(() => prepare("text", { ...wire.text.body, model }), /invalid_runway_veo_shape/);
    prepare("text", { ...wire.text.body, model, duration: 6 });
    assert.throws(() => prepare("image", { ...wire.image.body, model, duration: 6 }), /invalid_runway_veo_shape/);
  }
  prepare("image", { ...wire.image.body, promptImage: "data:image/png;base64,AAAA" });
  prepare("video", { ...wire.video.body, videoUri: "data:video/mp4;base64,AAAA" });
  for (const promptImage of ["runway://synthetic-upload", "http://media.example/image.png", "https://user:synthetic@media.example/image.png", "data:video/mp4;base64,AAAA", "data:image/png;base64,AAA", "invalid synthetic URI"]) assert.throws(() => prepare("image", { ...wire.image.body, promptImage }));
});

test("Runway terminal states do not depend on metrics or output completeness", async () => {
  const created = await adapter.read(Response.json(wire.created), { ...context, action: "create", expectedId: undefined });
  assert.equal(created.id, id); assert.equal(created.followUp, "retrieve"); assert.equal(created.terminal, null);
  for (const item of wire.observations) assert.equal((await observe(item.native)).terminal, item.terminal);
  assert.equal((await observe({ status: "SUCCEEDED" })).terminal, "succeeded");
  assert.equal((await observe({ status: "FAILED" })).terminal, "failed");
});

test("Runway DELETE acknowledgement freezes inaccessible observation without claiming refund or stopped generation", async () => {
  const value = await adapter.read(new Response(null, { status: wire.cancel.status }), { ...context, action: "cancel" });
  assert.equal(value.id, id);
  assert.equal(value.terminal, null);
  assert.equal(value.nativeStatus, null);
  assert.equal(value.observationUnavailable, "canceled_or_deleted");
  assert.equal(value.followUp, undefined);
  assert.equal(wire.cancel.guaranteesStoppedExecution, false);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  for (const status of [200, 400, 404, 409, 500]) await assert.rejects(() => adapter.read(Response.json({ status: "CANCELLED" }, { status }), { ...context, action: "cancel" }));
});

test("Runway scoped controls pin method, path and version without raw URL or ID pass-through", () => {
  for (const action of ["retrieve", "cancel"]) {
    const endpoint = wire[action], value = adapter.control(action, endpoint, id, {});
    assert.equal(value.path, "/v1/tasks/" + id); assert.equal(value.query.size, 0);
    assert.equal(value.headers.get("x-runway-version"), runwayApiVersion);
    assert.equal(value.headers.get("authorization"), null);
    assert.equal(adapter.identify(action, { id }, new URLSearchParams()), id);
  }
  assert.equal(adapter.supportsResult, false);
  assert.throws(() => adapter.control("result", wire.retrieve, id, {}));
  assert.throws(() => adapter.control("cancel", wire.retrieve, id, {}));
  assert.throws(() => adapter.identify("retrieve", { id }, new URLSearchParams("id=other")));
  for (const invalid of ["../id", "a".repeat(128), "", id + "?x=1"]) assert.throws(() => adapter.validateId(invalid));
});

test("Runway does not settle foreign identities, API errors, unknown status or truncated bytes", async () => {
  for (const value of [{ id: "00000000-0000-4000-8000-000000000002", status: "SUCCEEDED" }, { status: "DONE" }, { status: "FAILED", error: "Synthetic" }]) await assert.rejects(() => observe(value));
  await assert.rejects(() => adapter.read(new Response('{"id":', { headers: { "content-type": "application/json" } }), context));
  await assert.rejects(() => adapter.read(Response.json({ id, status: "FAILED" }, { status: 404 }), context));
  await assert.rejects(() => adapter.read(new Response(" ", { headers: { "content-type": "application/json", "content-length": "1048577" } }), context));
});

test("Runway response rewriting removes controls while leaving expiring media URLs opaque", async () => {
  const output = ["https://media.example/result.mp4?synthetic_signature=value"];
  const value = adapter.rewrite(await observe({ status: "SUCCEEDED", output, urls: { cancel: "https://untrusted.example/control" } }), { retrieve: "/v1/native/runway/v1/tasks/" + id });
  assert.equal(value.urls, undefined); assert.deepEqual(value.output, output);
});
