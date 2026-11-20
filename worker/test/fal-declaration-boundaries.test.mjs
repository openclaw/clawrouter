import assert from "node:assert/strict";
import test from "node:test";
import { falManagedAdapter as adapter } from "../managed-fal.ts";

const prepare = (pathParams, body = { prompt: "A paper boat" }) => adapter.prepare(body, new Headers(), pathParams, new URLSearchParams());
const quality = { owner: "xai", app: "grok-imagine-image", variant: "quality" };

test("unqualified Grok-quality generation cannot escape through the generic queue route", () => {
  assert.throws(() => prepare(quality), /fal_grok_quality_native_contract_unqualified/);
  // Closing new creates does not fabricate failure or strand original jobs.
  for (const [action, suffix, method] of [["retrieve", "/status", "GET"], ["result", "", "GET"], ["cancel", "/cancel", "PUT"]]) {
    const control = adapter.control(action, { method, path: "/${owner}/${app}/requests/${request_id}" + suffix }, "owned_job", quality);
    assert.equal(control.path, "/xai/grok-imagine-image/requests/owned_job" + suffix);
  }
});

test("the frozen MiniMax default uses its prompt-only contract, without stale image or duration defaults", () => {
  const route = { owner: "fal-ai", app: "minimax", variant: "video-01-live" };
  assert.deepEqual(prepare(route).body, { prompt: "A paper boat" });
  for (const extra of [{ image_url: "https://assets.example/image.png" }, { duration: 5 }, { resolution: "720p" }, { aspect_ratio: "16:9" }, { sound: true }]) {
    assert.throws(() => prepare(route, { prompt: "A paper boat", ...extra }));
  }
});

test("retired Kling and arbitrary deep paths remain outside the declared queue template", () => {
  for (const route of [
    { owner: "fal-ai", app: "kling-video", variant: "v2.1", subvariant: "master", mode: "text-to-video" },
    { owner: "fal-ai", app: "kling-video", variant: "v2.1/master/text-to-video" },
    { owner: "fal-ai", app: "kling-video", variant: "v2.1", subvariant: "master/text-to-video" },
    { owner: "fal-ai", app: "other", variant: "v1", subvariant: "text-to-video" },
  ]) assert.throws(() => prepare(route));
});
