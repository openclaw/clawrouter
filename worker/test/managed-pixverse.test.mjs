import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPixVerseManagedAdapter, preparePixVerseImageUpload, readPixVerseImageUpload, validatePixVerseId } from "../managed-pixverse.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url), "utf8"));
const adapter = createPixVerseManagedAdapter("text");
const id = String(wire.text.response.Resp.video_id);
const context = { action: "retrieve", expectedId: id, requestedVersion: "v6", pathParams: {} };
const prepare = (body, instance = adapter) => instance.prepare(body, new Headers({ "API-KEY": "synthetic-caller" }), {}, new URLSearchParams());
const response = result => Response.json({ ErrCode: 0, Resp: result });

test("PixVerse preserves native model fields and gives each request a fresh non-secret trace header", () => {
  const first = prepare(wire.text.body), second = prepare({ ...wire.text.body, model: "c1" });
  assert.equal(first.body, wire.text.body);
  assert.equal(first.requestedVersion, "v6");
  assert.equal(first.headers.get("api-key"), null);
  assert.match(first.headers.get("ai-trace-id"), /^[a-f0-9-]{36}$/);
  assert.notEqual(first.headers.get("ai-trace-id"), second.headers.get("ai-trace-id"));
  assert.equal(first.headers.get("content-type"), "application/json");
  for (const change of [{ model: "v6-max" }, { duration: 16 }, { seed: 2147483648 }, { callback: "https://example.com" }, { prompt: "猫".repeat(683) }, { img_id: 1 }, { quality: "480p" }]) assert.throws(() => prepare({ ...wire.text.body, ...change }));
});

test("PixVerse image creation requires a trusted pre-resolved upload binding", () => {
  assert.throws(() => prepare(wire.image.body, createPixVerseManagedAdapter("image")), /upload_scope_required/);
  const image = createPixVerseManagedAdapter("image", String(wire.upload.response.Resp.img_id));
  assert.deepEqual(prepare(wire.image.body, image).body, wire.image.body);
  assert.throws(() => prepare({ ...wire.image.body, img_id: 1 }, image), /identity_mismatch/);
  assert.throws(() => prepare({ ...wire.image.body, img_id: String(wire.image.body.img_id) }, image));
  assert.throws(() => prepare({ ...wire.image.body, aspect_ratio: "16:9" }, image));
});

test("PixVerse multipart file and URL modes preserve bytes without forging a boundary", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const file = preparePixVerseImageUpload({ file: { bytes, type: "image/png", name: "synthetic.png" } });
  assert.equal(file.headers.get("content-type"), null);
  assert.deepEqual(new Uint8Array(await file.body.get("image").arrayBuffer()), bytes);
  assert.equal(file.body.get("image").name, "synthetic.png");
  const url = preparePixVerseImageUpload({ url: wire.upload.multipart.image_url });
  assert.deepEqual([...url.body.keys()], ["image_url"]);
  assert.equal(url.body.get("image_url"), wire.upload.multipart.image_url);
  assert.throws(() => preparePixVerseImageUpload({ url: "https://media.example/a.png", file: { bytes, type: "image/png", name: "a.png" } }));
  assert.throws(() => preparePixVerseImageUpload({ file: { bytes: new Uint8Array(20_000_000), type: "image/png", name: "a.png" } }));
  assert.throws(() => preparePixVerseImageUpload({ url: "https://user:synthetic@media.example/a.png" }));
  assert.throws(() => preparePixVerseImageUpload({ url: "malformed synthetic URL" }), { message: "invalid_pixverse_image_url" });
  assert.deepEqual(await readPixVerseImageUpload(Response.json(wire.upload.response)), { id: String(wire.upload.response.Resp.img_id) });
});

test("PixVerse recognizes terminal failures and deleted observations without credit/refund assumptions", async () => {
  const create = await adapter.read(Response.json(wire.text.response), { ...context, action: "create", expectedId: undefined });
  assert.equal(create.id, id); assert.equal(create.terminal, null); assert.equal(create.followUp, "retrieve");
  for (const item of wire.observations) {
    const value = await adapter.read(response(item.native), context);
    assert.equal(value.terminal, item.terminal);
    assert.equal(value.observationUnavailable, item.observationUnavailable);
  }
  assert.equal((await adapter.read(response({ status: 1 }), context)).terminal, "succeeded");
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  assert.equal(wire.billing.responseCreditsAreFinal, false);
});

test("PixVerse checks both native identity fields and rejects unsafe numeric precision", async () => {
  for (const field of ["id", "video_id"]) await assert.rejects(() => adapter.read(response({ status: 1, [field]: 2 }), context), /identity_mismatch/);
  assert.equal((await adapter.read(response({ status: 5, id: Number(id), video_id: id }), context)).id, id);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "01", "1e3", "../1", "9007199254740992"]) assert.throws(() => validatePixVerseId(invalid));
});

test("PixVerse control construction cannot cancel, follow arbitrary URLs or reuse trace IDs", () => {
  const endpoint = { method: "GET", path: wire.retrieve.path };
  const first = adapter.control("retrieve", endpoint, id, {}), next = adapter.control("retrieve", endpoint, id, {});
  assert.equal(first.path, "/openapi/v2/video/result/" + id);
  assert.equal(first.query.size, 0);
  assert.notEqual(first.headers.get("ai-trace-id"), next.headers.get("ai-trace-id"));
  assert.deepEqual(first.transientHeaders, ["ai-trace-id"]);
  assert.deepEqual(next.transientHeaders, first.transientHeaders);
  assert.equal(adapter.validateId(adapter.identityProbe), "1");
  for (const item of [first, next]) assert.match(item.headers.get("ai-trace-id"), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(first.headers.get("api-key"), null);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, endpoint, id, {}));
  assert.throws(() => adapter.control("retrieve", { method: "GET", path: "https://media.example" }, id, {}));
  assert.throws(() => adapter.identify("retrieve", { video_id: id }, new URLSearchParams("video_id=2")));
});

test("PixVerse errors, partial EOF and unexpected states are not terminal execution evidence", async () => {
  for (const value of [{ ErrCode: 100, Resp: { status: 1 } }, { ErrCode: "0", Resp: { status: 1 } }, { ErrCode: 0, Resp: { status: 9 } }]) await assert.rejects(() => adapter.read(Response.json(value), context));
  await assert.rejects(() => adapter.read(new Response('{"ErrCode":0,"Resp":', { headers: { "content-type": "application/json" } }), context));
  await assert.rejects(() => adapter.read(new Response(" ", { headers: { "content-type": "application/json", "content-length": "1048577" } }), context));
  await assert.rejects(() => readPixVerseImageUpload(Response.json({ ErrCode: 101, Resp: { img_id: 1 } })));
});

test("PixVerse public response drops control links and leaves output media opaque", async () => {
  const observation = await adapter.read(response({ status: 1, status_url: "https://untrusted.example/control", url: "https://media.example/output.mp4" }), context);
  const body = adapter.rewrite(observation, { retrieve: "/v1/native/pixverse/openapi/v2/video/result/" + id });
  assert.equal(body.Resp.status_url, undefined);
  assert.equal(body.Resp.url, "https://media.example/output.mp4");
});
