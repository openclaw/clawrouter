import assert from "node:assert/strict";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
import { assertManagedDispatch, managedProbeId } from "../managed-dispatch.ts";

test("Wan registry binds only the scoped create format and supplies a synchronous dispatch guard", () => {
  const adapter = managedCreateAdapter("dashscope.video", "dashscope.video_create");
  assert.equal(adapter, managedLifecycleAdapter("dashscope.video"));
  assert.ok(adapter);
  assert.equal(adapter.supportsCancel, false);
  assert.equal(adapter.supportsResult, false);
  assert.equal(typeof adapter.assertDispatch, "function");
  assert.equal(adapter.validateId(managedProbeId(adapter)), managedProbeId(adapter));
  for (const format of ["dashscope.video_get", "openai.chat", "pixverse.image_video"]) {
    assert.equal(managedCreateAdapter("dashscope.video", format), undefined);
  }
});



test("Registered Wan rejects incompatible selected credentials on create and each original-job control", () => {
  for (const [method, path] of [["POST", "/api/v1/services/aigc/video-generation/video-synthesis"], ["GET", "/api/v1/tasks/synthetic-task"]]) {
    const request = (origin, secret) => new Request(origin + path, { method,
      headers: { authorization: "Bearer " + secret } });
    assert.doesNotThrow(() => assertManagedDispatch("dashscope.video", request("https://dashscope-intl.aliyuncs.com", "synthetic-standard")));
    for (const [origin, secret] of [["https://dashscope-intl.aliyuncs.com", "sk-sp-synthetic"], ["https://coding-intl.dashscope.aliyuncs.com", "synthetic-standard"], ["https://example.com", "synthetic-standard"]]) {
      assert.throws(() => assertManagedDispatch("dashscope.video", request(origin, secret)),
        error => error.status === 503 && error.code === "managed_dispatch_unavailable" && !error.message.includes(secret));
    }
  }
});
