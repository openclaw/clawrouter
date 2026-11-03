import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
const links = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/managed-files.json", import.meta.url)));
const adapter = managedCreateAdapter("google.omni_video", "google.omni_video_create");

test("the registry resolves the actual Omni contract and never aliases retired Veo or raw file formats", () => {
  assert.equal(adapter, managedLifecycleAdapter("google.omni_video")); assert.equal(adapter.files.protocol, adapter.protocol);
  for (const protocol of ["google.veo", "google.veo3", "google.interactions"]) assert.equal(managedLifecycleAdapter(protocol), undefined);
  for (const format of ["google.omni_video_get", "google.omni_video_file_download", "google.veo_create", "google.generate_content"]) assert.equal(managedCreateAdapter("google.omni_video", format), undefined);
  assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, true);
});

test("registered create, observation and file factory preserve original flags, identity and selected origin", async () => {
  const prepared = adapter.prepare(wire.requests[2], new Headers({ "x-goog-api-key": "synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(prepared.pathParams, { background: "true", store: "true" }); assert.equal(prepared.headers.has("x-goog-api-key"), false);
  const context = { action: "retrieve", expectedId: wire.pending.id, requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams };
  const observed = await adapter.read(Response.json(wire.completed), context), files = adapter.files.describe(observed, links.selectedBase);
  assert.deepEqual(files, [links.descriptor]); assert.equal(observed.actualCostMicros, undefined);
  const metadata = adapter.files.control("metadata", links.metadata, files[0], links.selectedBase);
  assert.equal(metadata.path, "/v1beta/files/fixture-video"); assert.equal(metadata.headers, undefined);
  const active = await adapter.files.readState(Response.json(wire.active), files[0]);
  assert.equal(adapter.files.control("download", links.download, files[0], links.selectedBase, active).query.toString(), "alt=media");
  assert.throws(() => adapter.files.control("download", links.download, files[0], links.selectedBase), /not_active/);
  assert.throws(() => adapter.files.describe(observed, "https://other.example"), /file_origin/);
  const publicBody = adapter.files.rewrite(adapter.rewrite(observed, { retrieve: "/v1/native/google-gemini/v1beta/interactions/v1_fixture", cancel: "/v1/native/google-gemini/v1beta/interactions/v1_fixture/cancel" }), [links.publicPaths]);
  assert.equal(publicBody.steps[2].content[0].uri, links.publicPaths.download);
  await assert.rejects(adapter.read(Response.json({ ...wire.completed, id: "foreign" }), context), /identity_mismatch/);
});

test("registered per-job permission and unavailable observations do not invent polling, cancellation or refunds", async () => {
  for (const [background, store, allowed] of [[false, false, []], [false, true, ["retrieve"]], [true, true, ["retrieve", "cancel"]]]) {
    const prepared = adapter.prepare({ ...wire.requests[0], background, store }, new Headers(), {}, new URLSearchParams());
    assert.deepEqual(adapter.allowedControls(prepared.pathParams), allowed);
    if (!background) assert.throws(() => adapter.control("cancel", { method: "POST", path: "/v1beta/interactions/${interaction_id}/cancel" }, wire.pending.id, prepared.pathParams));
    if (!store) assert.throws(() => adapter.control("retrieve", { method: "GET", path: "/v1beta/interactions/${interaction_id}" }, wire.pending.id, prepared.pathParams));
  }
  for (const status of ["incomplete", "requires_action", "requires_continuation"]) {
    const observed = await adapter.read(Response.json({ ...wire.pending, status }), { action: "retrieve", expectedId: wire.pending.id, requestedVersion: wire.pending.model, pathParams: { background: "true", store: "true" } });
    assert.equal(observed.terminal, null); assert.equal(observed.followUp, undefined); assert.equal(observed.observationUnavailable, "expired_or_unknown");
    assert.deepEqual(adapter.files.describe(observed, links.selectedBase), []); assert.equal(observed.actualCostMicros, undefined);
  }
});
