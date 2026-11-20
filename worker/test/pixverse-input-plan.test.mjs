import assert from "node:assert/strict";
import test from "node:test";
import { preparePixVerseImagePlan, createPixVerseManagedAdapter } from "../managed-pixverse.ts";
const plan = { model: "v6", prompt: "A lighthouse", duration: 5, quality: "720p" };
test("planned image creation validates before upload without minting a usable provider ID", () => {
  const result = preparePixVerseImagePlan(plan);
  assert.deepEqual(result, plan); assert.equal(Object.hasOwn(result, "img_id"), false);
  assert.throws(() => createPixVerseManagedAdapter("image").prepare(result, new Headers(), {}, new URLSearchParams()));
  assert.deepEqual(createPixVerseManagedAdapter("image", "123").prepare({ ...result, img_id: 123 }, new Headers(), {}, new URLSearchParams()).body,
    { ...plan, img_id: 123 });
});
for (const [name, extra] of Object.entries({ suppliedID: { img_id: 123 }, url: { image_url: "https://images.example/a.png" },
  file: { file: { url: "https://images.example/a.png" } }, nativeURL: { image: "https://images.example/a.png" }, headers: { headers: { "API-KEY": "synthetic" } },
  unknownModel: { model: "other" }, invalidDuration: { duration: 16 }, unsupportedQuality: { quality: "4k" }, mixedTextMode: { aspect_ratio: "1:1" } })) {
  test(`planned image rejects ${name} before upload`, () => assert.throws(() => preparePixVerseImagePlan({ ...plan, ...extra })));
}
