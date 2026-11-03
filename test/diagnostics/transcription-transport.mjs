import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../helpers/workerd.mjs";

// Diagnostic only: finite independent requests, no retries or external upstream.
const require = createRequire(import.meta.resolve("wrangler/package.json"));
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  miniflare: require("miniflare/package.json").version, workerd: require("workerd/package.json").version }));
const temporary = await mkdtemp(join(tmpdir(), "clawrouter-transcription-transport-"));
let mf;
try {
  mf = await startWorkerdFixture(temporary, `
import handler from "./worker/index.ts";
export * from "./worker/index.ts";
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/fixture/")) {
    if (path === "/fixture/consume") await request.arrayBuffer();
    return Response.json({ error: { code: "probe_denied" } }, { status: 401 });
  }
  return handler.fetch(request, env, ctx);
} };`, `export default { fetch() { throw new Error("unexpected upstream dispatch"); } };`);
  const origin = await mf.ready;
  const deadline = AbortSignal.timeout(60_000);
  for (const path of ["/fixture/consume", "/fixture/unread", "/v1/audio/transcriptions"]) {
    for (const mode of ["form", "staged"]) {
      for (const stallMs of [0, 50]) {
        const outcomes = {};
        for (let sample = 0; sample < 8; sample++) {
          deadline.throwIfAborted();
          const form = new FormData();
          form.set("model", "openai/gpt-4o-transcribe");
          form.set("file", new File([new Uint8Array([0, 255, 128, 42])], "sample.wav", { type: "audio/wav" }));
          form.set("language", "en"); form.set("prompt", "synthetic prompt é");
          const init = { method: "POST", body: form,
            signal: AbortSignal.any([deadline, AbortSignal.timeout(2_000)]) };
          if (mode === "staged") {
            const encoded = new Request(new URL(path, origin), { method: "POST", body: form });
            const bytes = new Uint8Array(await encoded.arrayBuffer());
            let cancelled = false;
            init.body = new ReadableStream({
              start(controller) { controller.enqueue(bytes.subarray(0, 80)); },
              async pull(controller) {
                await delay(10);
                if (!cancelled) { controller.enqueue(bytes.subarray(80)); controller.close(); }
              },
              cancel() { cancelled = true; },
            });
            init.headers = { "content-type": encoded.headers.get("content-type") };
            init.duplex = "half";
          }
          let outcome;
          try {
            const pending = fetch(new URL(path, origin), init).then(
              response => ({ response }), error => ({ error }));
            // Stall only this Node client while the separate workerd process can
            // reject the upload. This controls a timing window, not CPU load.
            if (stallMs) {
              await delay(1);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
            }
            const result = await pending;
            if (result.error) throw result.error;
            const { response } = result;
            const body = await response.json();
            assert.equal(response.status, 401);
            assert.ok(body.error);
            outcome = "complete_401";
          } catch (error) {
            if (error instanceof assert.AssertionError || error instanceof SyntaxError) throw error;
            const code = error.cause?.code ?? error.code ?? error.name;
            outcome = /^[A-Z_0-9]+$/.test(String(code)) ? String(code) : "fetch_error";
          }
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
        console.log(JSON.stringify({ path, mode, stallMs, samples: 8, outcomes }));
        if (path === "/fixture/consume") assert.deepEqual(outcomes, { complete_401: 8 }, "consuming control must return complete responses");
      }
    }
  }
} finally {
  await mf?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
