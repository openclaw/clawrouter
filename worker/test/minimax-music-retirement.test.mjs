import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { prepareNativeMiniMaxMusic } from "../native-minimax-music.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { musicBody, musicSse } from "./minimax-music-runtime-fixture.mjs";
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function native(stream) {
  return prepareNativeMiniMaxMusic({ provider: { id: "minimax", base_urls: { default: "https://api.minimax.io" } },
    endpoint: { id: "music", method: "POST", path: "/v1/music_generation", path_params: [], query: {}, streaming: "sse", request_format: "minimax.music", response_format: "minimax.music" },
    model: { id: "minimax/music-2.6", upstream: "music-2.6", capabilities: ["music.generate"] }, capability: "music.generate", method: "POST", pathParams: {}, body: musicBody(stream) });
}
for (const stream of [false, true]) for (const header of ["mime", "encoding", "status"])
  test(`MiniMax music ${header} rejection awaits ORIGINAL first cleanup stream=${stream}`, async () => {
    const cleanup = deferred(); let cancels = 0;
    const body = new ReadableStream({ cancel() { cancels++; return cleanup.promise; } }, { highWaterMark: 0 });
    const headers = { "content-type": header === "mime" ? "text/plain" : stream ? "text/event-stream" : "application/json",
      ...(header === "encoding" ? { "content-encoding": "gzip" } : {}) };
    const leaf = native(stream), lease = leaf.acquire(); let finished = false;
    const pending = leaf.read(new Response(body, { status: header === "status" ? 302 : 200, headers }), new AbortController().signal)
      .finally(() => { finished = true; lease.release(); });
    const rejection = assert.rejects(pending); await turn();
    assert.equal(cancels, 1); assert.equal(finished, false); assert.equal(body.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
    const other = new BodyLease(); assert.equal(other.grow(17 * 1024 * 1024), false); other.release();
    cleanup.resolve(); await rejection; assert.equal(body.locked, false); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 0);
  });
test("MiniMax music terminal and native DONE do not replace physical EOF", async () => {
  const end = deferred(); let pulls = 0;
  const body = new ReadableStream({ async pull(c) { if (!pulls++) c.enqueue(new TextEncoder().encode(musicSse("music-2.6"))); else { await end.promise; c.close(); } } }, { highWaterMark: 0 });
  const leaf = native(true), lease = leaf.acquire(); let finished = false;
  const pending = leaf.read(new Response(body, { headers: { "content-type": "text/event-stream" } }), new AbortController().signal).then(value => { finished = true; return value; });
  await turn(); assert.equal(pulls, 2); assert.equal(finished, false); assert.equal(body.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  end.resolve(); const result = await pending; assert.equal(body.locked, false); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  await result.response.body.cancel(); lease.release(); assert.equal(bodyBudgetCharged(), 0);
});
