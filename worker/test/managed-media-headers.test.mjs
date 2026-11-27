import assert from "node:assert/strict";
import test from "node:test";
import { managedHeaderIdentity, managedProbeId } from "../managed-dispatch.ts";
import { createPixVerseManagedAdapter } from "../managed-pixverse.ts";
import { createRunwayManagedAdapter, runwayApiVersion } from "../managed-runway.ts";

test("PixVerse fresh control trace values preserve route identity and never become asset authority", () => {
  const adapter = createPixVerseManagedAdapter("text");
  const provider = { auth: { schemes: [{ type: "api_key", header: "API-KEY" }] } };
  const endpoint = { method: "GET", path: "/openapi/v2/video/result/${video_id}" };
  const first = adapter.control("retrieve", endpoint, "123", {});
  const next = adapter.control("retrieve", endpoint, "123", {});
  assert.equal(managedProbeId(adapter), "1");
  assert.notEqual(first.headers.get("ai-trace-id"), next.headers.get("ai-trace-id"));
  assert.deepEqual(managedHeaderIdentity(provider, first), [["ai-trace-id", "<per-attempt-uuid>"]]);
  assert.deepEqual(managedHeaderIdentity(provider, next), managedHeaderIdentity(provider, first));
  assert.notDeepEqual(managedHeaderIdentity(provider, { ...first, transientHeaders: [] }), managedHeaderIdentity(provider, first));
  assert.throws(() => createPixVerseManagedAdapter("image").prepare({ model: "v6", prompt: "Synthetic", duration: 5,
    quality: "540p", img_id: Number(adapter.identityProbe) }, new Headers(), {}, new URLSearchParams()), /upload_scope_required/);
});

test("Runway version headers remain stable route identity and DELETE keeps bodyless conservative observation", async () => {
  const adapter = createRunwayManagedAdapter("text");
  const provider = { auth: { schemes: [{ type: "bearer" }] } };
  const id = "11111111-1111-4111-8111-111111111111";
  const get = adapter.control("retrieve", { method: "GET", path: "/v1/tasks/${id}" }, id, {});
  assert.deepEqual(managedHeaderIdentity(provider, get), [["accept", "application/json"], ["x-runway-version", runwayApiVersion]]);
  const changed = { ...get, headers: new Headers(get.headers) }; changed.headers.set("x-runway-version", "2026-11-03");
  assert.notDeepEqual(managedHeaderIdentity(provider, changed), managedHeaderIdentity(provider, get));
  const cancel = adapter.control("cancel", { method: "DELETE", path: "/v1/tasks/${id}" }, id, {});
  assert.equal(cancel.headers.get("x-runway-version"), runwayApiVersion);
  assert.equal(cancel.transientHeaders, undefined);
  const observation = await adapter.read(new Response(null, { status: 204 }), { action: "cancel", expectedId: id, requestedVersion: "gen4.5", pathParams: {} });
  assert.equal(observation.terminal, null);
  assert.equal(observation.observationUnavailable, "canceled_or_deleted");
  assert.equal(observation.followUp, undefined);
});
