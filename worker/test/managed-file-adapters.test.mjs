import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedFileAdapter } from "../managed-file-adapters.ts";
import { managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/managed-files.json", import.meta.url)));
const adapter = managedFileAdapter(fixture.protocol), file = fixture.descriptor, base = fixture.selectedBase;
const observation = body => ({ id: body.id, nativeStatus: body.status, terminal: "succeeded", body });
const withUri = uri => { const body = structuredClone(wire.completed); body.steps[2].content[0].uri = uri; return body; };

test("the registered lifecycle supplies only the qualified file protocol", () => {
  assert.equal(adapter.protocol, "google.omni_video");
  assert.equal(managedFileAdapter("google.veo"), undefined);
  assert.equal(managedLifecycleAdapter("google.omni_video").files, adapter);
  assert.equal(fixture.qualification.rawIdAuthorizesAccess, false);
});

test("descriptors bind only original successful same-origin/prefix output and ignore later inline delivery", () => {
  assert.deepEqual(adapter.describe(observation(wire.completed), base), [file]);
  assert.deepEqual(adapter.describe(observation(wire.retrieved), base), []);
  assert.deepEqual(adapter.describe({ ...observation(wire.completed), terminal: null }, base), []);
  assert.throws(() => adapter.describe({ ...observation(wire.completed), id: "foreign-job" }, base), /observation/);
  assert.throws(() => adapter.describe({ ...observation(wire.completed), observationUnavailable: "deleted" }, base), /observation/);
  for (const uri of ["https://other.example/v1beta/files/fixture-video", base + "/v1alpha/files/fixture-video", base + "/v1beta/files/fixture-video?key=synthetic", base + "/v1beta/files/fixture-video%2Fother"]) {
    assert.throws(() => adapter.describe(observation(withUri(uri)), base));
  }
  assert.throws(() => adapter.describe(observation(wire.completed), "https://proxy.example"), /file_origin/);
  assert.deepEqual(adapter.describe(observation(withUri("files/fixture-video")), "https://proxy.example/route"), [file]);
  const repeated = structuredClone(wire.completed); repeated.steps[2].content.push(repeated.steps[2].content[0]);
  assert.deepEqual(adapter.describe(observation(repeated), base), [file]);
});

test("native file selectors and source schema links cannot widen identity, method or query", () => {
  assert.equal(adapter.identify("metadata", { file_id: file.id }, new URLSearchParams()), file.id);
  assert.equal(adapter.identify("download", { file_id: file.id }, new URLSearchParams("alt=media")), file.id);
  for (const params of [{ file_id: "../other" }, { file_id: "x".repeat(129) }, { file_id: file.id, job_id: "foreign" }]) {
    assert.throws(() => adapter.identify("metadata", params, new URLSearchParams()));
  }
  for (const query of ["", "alt=json", "alt=media&alt=media", "alt=media&key=synthetic"]) {
    assert.throws(() => adapter.identify("download", { file_id: file.id }, new URLSearchParams(query)));
  }
  for (const change of [{ method: "POST" }, { path: "/files/${file_id}" }, { query: { key: "synthetic" } }]) {
    assert.throws(() => adapter.control("metadata", { ...fixture.metadata, ...change }, file, base));
  }
  const target = adapter.control("metadata", fixture.metadata, file, base);
  assert.equal(target.path, "/v1beta/files/fixture-video"); assert.equal(target.query.size, 0); assert.equal(target.headers, undefined);
  const proxy = adapter.control("metadata", fixture.metadata, file, "https://proxy.example/route");
  assert.equal(proxy.path, "/v1beta/files/fixture-video");
});

test("only matching ACTIVE metadata enables download; processing failure has no generation or price verdict", async () => {
  for (const [body, status] of [[wire.processing, "processing"], [wire.fileFailed, "failed"]]) {
    const state = await adapter.readState(Response.json(body), file);
    assert.equal(state.status, status); assert.equal(state.terminal, undefined); assert.equal(state.actualCostMicros, undefined);
    assert.throws(() => adapter.control("download", fixture.download, file, base, state), /not_active/);
  }
  const active = await adapter.readState(Response.json({ ...wire.active, uri: "https://other.example/secret" }), file);
  assert.deepEqual(active.body, { name: "files/fixture-video", state: "ACTIVE" });
  const download = adapter.control("download", fixture.download, file, base, active);
  assert.equal(download.path, "/v1beta/files/fixture-video:download");
  assert.equal(download.query.toString(), "alt=media");
  for (const state of [undefined, { ...active, id: "foreign" }, { ...active, body: { name: "files/foreign", state: "ACTIVE" } }]) {
    assert.throws(() => adapter.control("download", fixture.download, file, base, state), /not_active/);
  }
  await assert.rejects(adapter.readState(Response.json({ ...wire.active, name: "files/foreign" }), file), /identity/);
  await assert.rejects(adapter.readState(Response.json(wire.active, { status: 206 }), file), /response/);
});

test("file byte delivery preserves bytes and rejects redirects, partial, truncation, empty and MIME drift", async () => {
  const bytes = new Uint8Array(fixture.syntheticBytes);
  assert.deepEqual(await adapter.readFile(new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": "3" } }), file, 3), bytes);
  for (const response of [
    new Response(bytes, { status: 206 }), new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    new Response(bytes, { headers: { "content-range": "bytes 0-2/10" } }), new Response(bytes, { headers: { "content-length": "4" } }),
    new Response(new Uint8Array()), new Response(bytes, { headers: { "content-type": "video/webm" } }),
  ]) await assert.rejects(adapter.readFile(response, file, 4));
  await assert.rejects(adapter.readFile(new Response(bytes), file, 2));
});

test("only bound video outputs are rewritten to trusted relative paths without mutating native body", () => {
  const result = adapter.rewrite(wire.completed, [fixture.publicPaths]);
  assert.equal(result.steps[2].content[0].uri, fixture.publicPaths.download);
  assert.deepEqual(result.steps[0], wire.completed.steps[0]);
  assert.match(wire.completed.steps[2].content[0].uri, /^https:/);
  assert.deepEqual(adapter.rewrite(wire.retrieved, []), wire.retrieved);
  assert.throws(() => adapter.rewrite(wire.completed, []), /unbound_output/);
  for (const download of ["https://other.example/file", "//other.example/file", "/safe/../file", "/safe/%2e%2e/file", "/safe\\other"]) {
    assert.throws(() => adapter.rewrite(wire.completed, [{ ...fixture.publicPaths, download }]), /public_path/);
  }
  assert.throws(() => adapter.rewrite(wire.completed, [fixture.publicPaths, fixture.publicPaths]), /duplicate_path/);
});

