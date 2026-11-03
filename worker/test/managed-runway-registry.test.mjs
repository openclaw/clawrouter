import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/runway/lifecycle.json", import.meta.url)));

test("Runway selects both native create modes by format, preserving existing protocol registrations", () => {
  const text = managedCreateAdapter("runway.tasks", "runway.text_video");
  const image = managedCreateAdapter("runway.tasks", "runway.image_video");
  assert.ok(text); assert.ok(image); assert.notEqual(text, image);
  assert.equal(managedLifecycleAdapter("runway.tasks"), text);
  assert.equal(managedCreateAdapter("runway.tasks", "runway.video_video"), undefined);
  assert.equal(managedCreateAdapter("runway.tasks", "runway.task_get"), undefined);
  for (const mode of ["text", "image"]) {
    const adapter = managedCreateAdapter("runway.tasks", "runway." + mode + "_video");
    const value = adapter.prepare(wire[mode].body, new Headers({ "x-runway-version": "caller-value" }), {}, new URLSearchParams());
    assert.deepEqual(value.body, wire[mode].body); assert.equal(value.headers.get("x-runway-version"), wire.version);
    assert.equal(value.headers.has("authorization"), false);
  }
  assert.throws(() => text.prepare(wire.image.body, new Headers(), {}, new URLSearchParams()));
  assert.throws(() => image.prepare(wire.text.body, new Headers(), {}, new URLSearchParams()));
  for (const protocol of ["replicate.predictions", "fal.queue", "kie.jobs", "vydra.jobs"]) {
    const adapter = managedLifecycleAdapter(protocol); assert.ok(adapter);
    for (const format of adapter.requestFormats) assert.equal(managedCreateAdapter(protocol, format), adapter);
  }
});

test("both Runway modes share the exact native identity/version and conservative deletion semantics", async () => {
  for (const mode of ["text", "image"]) {
    const adapter = managedCreateAdapter("runway.tasks", "runway." + mode + "_video"), id = wire.created.id;
    const context = { action: "cancel", expectedId: id, requestedVersion: wire[mode].body.model, pathParams: {} };
    assert.equal(adapter.identify("retrieve", { id }, new URLSearchParams()), id);
    for (const action of ["retrieve", "cancel"]) {
      const control = adapter.control(action, wire[action], id, {});
      assert.equal(control.path, "/v1/tasks/" + id); assert.equal(control.headers.get("x-runway-version"), wire.version);
      assert.equal(control.transientHeaders, undefined);
    }
    const ack = await adapter.read(new Response(null, { status: 204 }), context);
    assert.equal(ack.terminal, null); assert.equal(ack.observationUnavailable, "canceled_or_deleted");
    assert.equal(ack.followUp, undefined); assert.equal(ack.actualCostMicros, undefined);
    assert.throws(() => adapter.prepare({ ...wire.image.body, promptImage: "runway://foreign-upload" }, new Headers(), {}, new URLSearchParams()));
  }
});

