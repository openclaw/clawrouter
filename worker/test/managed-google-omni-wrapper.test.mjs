import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleOmniManagedAdapter as adapter } from "../managed-google-omni-wrapper.ts";
import { managedFileAdapter } from "../managed-file-adapters.ts";
import { managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
const params = (background, store) => ({ background: String(background), store: String(store) });

test("registered Omni wrapper attaches the actual file factory and retained control flags", () => {
  assert.equal(adapter.files, managedFileAdapter("google.omni_video"));
  assert.equal(managedLifecycleAdapter("google.omni_video"), adapter);
  assert.deepEqual(adapter.retainedParams, ["background", "store"]);
  assert.deepEqual(adapter.allowedControls(params(false, false)), []);
  assert.deepEqual(adapter.allowedControls(params(false, true)), ["retrieve"]);
  assert.deepEqual(adapter.allowedControls(params(true, true)), ["retrieve", "cancel"]);
  for (const value of [params(true, false), {}, { background: "true", store: "true", arbitrary: "flag" }]) {
    assert.throws(() => adapter.allowedControls(value));
  }
});

test("schema-prefix translation keeps original flags and exact control methods/paths", () => {
  const get = { method: "GET", path: "/v1beta/interactions/${interaction_id}" };
  const cancel = { method: "POST", path: get.path + "/cancel" };
  const id = wire.pending.id;
  assert.equal(adapter.control("retrieve", get, id, params(false, true)).path, "/v1beta/interactions/" + id);
  assert.equal(adapter.control("cancel", cancel, id, params(true, true)).path, "/v1beta/interactions/" + id + "/cancel");
  assert.throws(() => adapter.control("retrieve", get, id, params(false, false)));
  assert.throws(() => adapter.control("cancel", cancel, id, params(false, true)));
  for (const endpoint of [{ ...get, path: get.path.slice(7) }, { ...get, method: "POST" }, { ...get, path: "/v1alpha/interactions/${interaction_id}" }]) {
    assert.throws(() => adapter.control("retrieve", endpoint, id, params(false, true)));
  }
});

test("unstored unary responses need no retrieve path, and pending/error output cannot bind file links", () => {
  const observation = { id: wire.completed.id, nativeStatus: "completed", terminal: "succeeded", body: wire.completed };
  assert.deepEqual(adapter.rewrite(observation, {}), wire.completed);
  assert.throws(() => adapter.rewrite(observation, { retrieve: "https://other.example" }));
  assert.throws(() => adapter.rewrite(observation, { result: "/unexpected" }));
  for (const body of [wire.pending, { ...wire.pending, status: "failed", steps: undefined, error: { code: "synthetic" } }]) {
    assert.deepEqual(adapter.files.rewrite(body, []), body);
    assert.throws(() => adapter.files.rewrite(body, [{ id: "fixture-video", metadata: "/file", download: "/bytes" }]));
  }
});

