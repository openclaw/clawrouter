import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedRoute, managedPaths } = await import("../managed-routes.ts");
const { managedFileRoute, qualifyManagedFiles, managedFilePublicBody } = await import("../managed-files.ts");
const source = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
source.capabilities.push({ id: "media.predict", endpoint: "omni", methods: ["POST"] });
Object.assign(source.endpoints, {
  omni: { path: "/v1beta/interactions", requestFormat: "google.omni_video_create", responseFormat: "google.omni_video", lifecycle: { protocol: "google.omni_video", retrieve: "interaction", cancel: "cancel", files: { metadata: "file", download: "download" } } },
  interaction: { method: "GET", path: "/v1beta/interactions/${interaction_id}", pathParams: ["interaction_id"], requestFormat: "google.omni_video_get", responseFormat: "google.omni_video" },
  cancel: { method: "POST", path: "/v1beta/interactions/${interaction_id}/cancel", pathParams: ["interaction_id"], requestFormat: "google.omni_video_cancel", responseFormat: "google.omni_video" },
  file: { method: "GET", path: "/v1beta/files/${file_id}", pathParams: ["file_id"], requestFormat: "google.omni_video_file_metadata", responseFormat: "google.omni_video_file" },
  download: { method: "GET", path: "/v1beta/files/${file_id}:download", pathParams: ["file_id"], query: { alt: "media" }, requestFormat: "google.omni_video_file_download", responseFormat: "google.omni_video_bytes" },
});
const provider = compileProviderSnapshot([source]).providers[0], create = provider.endpoints.find(value => value.id === "omni");

test("compiled Omni links resolve the registered lifecycle/files through the actual shared route helpers", async () => {
  const { adapter } = managedRoute(provider, create), fileRoute = managedFileRoute(provider, create);
  assert.equal(adapter.protocol, "google.omni_video"); assert.equal(adapter.files, fileRoute.adapter);
  for (const [background, store, controls] of [[false, false, []], [false, true, ["retrieve"]], [true, true, ["retrieve", "cancel"]]]) {
    const prepared = adapter.prepare({ ...wire.requests[0], background, store }, new Headers(), {}, new URLSearchParams());
    const paths = managedPaths(provider, create, wire.completed.id, prepared.pathParams);
    assert.deepEqual(Object.keys(paths), controls);
    for (const value of Object.values(paths)) assert.ok(value.startsWith("/v1/native/google-gemini/v1beta/interactions/"));
  }
  const prepared = adapter.prepare(wire.requests[2], new Headers(), {}, new URLSearchParams());
  const observed = await adapter.read(Response.json(wire.completed), { action: "retrieve", expectedId: wire.completed.id, requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams });
  const qualified = qualifyManagedFiles(provider, create, observed, source.baseUrls.default);
  assert.deepEqual(qualified.files, [{ id: "fixture-video", mimeType: "video/mp4" }]);
  const rewritten = managedFilePublicBody(provider, create, qualified, observed.body);
  assert.equal(rewritten.steps[2].content[0].uri, "/v1/native/google-gemini/v1beta/files/fixture-video:download?alt=media");
  assert.throws(() => qualifyManagedFiles(provider, create, observed, "https://other.example"), error => error.code === "managed_file_owner_unavailable");
  assert.throws(() => managedFilePublicBody(provider, create, { ...qualified, files: [] }, observed.body), /unbound_output/);
  assert.equal(qualifyManagedFiles(provider, create, { ...observed, terminal: null }, source.baseUrls.default).files, undefined);
});
