import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { transform } = require("esbuild");
async function producer() {
  const source = await readFile(new URL("../worker/fixtures/edge-native-upstream.ts", import.meta.url), "utf8");
  const result = await transform(source.slice(0, source.indexOf("export class UpstreamRecords")), { loader: "ts", format: "esm", target: "es2022" });
  return (await import("data:text/javascript;base64," + Buffer.from(result.code).toString("base64"))).syntheticProducer;
}
test("synthetic producer joins the exact original timer before cancellation completion", async () => {
  const create = await producer(), original = Promise.withResolvers(), incoming = new AbortController(), reports = []; let timerSignal;
  const value = create(incoming.signal, (delay, options) => { assert.equal(delay, 10000); timerSignal = options.signal; return original.promise; }, async proof => { reports.push(proof); });
  assert.equal(value.original, original.promise);
  const reader = value.body.getReader(); assert.ok((await reader.read()).value.length > 0);
  let finished = false; incoming.abort(); const canceled = reader.cancel(incoming.signal.reason).then(() => { finished = true; });
  assert.ok(value.cancellation instanceof Promise);
  await Promise.resolve(); assert.equal(timerSignal.aborted, true); assert.equal(finished, false); assert.equal(reports.length, 0);
  original.reject({ syntheticNativeCancellation: true }); await canceled; await value.retired; reader.releaseLock();
  assert.equal(reports.length, 1); assert.equal(reports[0].canceled, true); assert.equal(reports[0].cancelSettled, true); assert.equal(reports[0].signalAborted, true); assert.equal(reports[0].expired, false);
});
test("native timer fulfillment is expiry, never cancellation success", async () => {
  const create = await producer(), original = Promise.withResolvers(), reports = [];
  const value = create(new AbortController().signal, () => original.promise, async proof => { reports.push(proof); });
  const reader = value.body.getReader(); await reader.read(); const pending = reader.read(); void pending.catch(() => {});
  original.resolve(); await assert.rejects(value.retired); await assert.rejects(pending); reader.releaseLock();
  assert.equal(reports[0].expired, true); assert.equal(reports[0].cancelSettled, false);
});
for (const reason of [undefined, null, 1, false]) test(`unexpected timer rejection ${typeof reason} remains failure`, async () => {
  const create = await producer(), original = Promise.withResolvers(); const value = create(new AbortController().signal, () => original.promise, async () => {});
  const reader = value.body.getReader(); await reader.read(); const canceled = reader.cancel({ own: true }); original.reject(reason);
  await assert.rejects(canceled); await assert.rejects(value.retired); reader.releaseLock();
});
test("reporting failure cannot turn original cancellation into passing retirement", async () => {
  const create = await producer(), original = Promise.withResolvers(); const value = create(new AbortController().signal, () => original.promise, async () => { throw undefined; });
  const reader = value.body.getReader(); await reader.read(); const canceled = reader.cancel({ own: true }); original.reject({ canceled: true });
  await canceled; await value.cancellation;
  let caught = false; try { await value.retired; } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true);
  reader.releaseLock();
});
test("a pre-aborted producer acquires no timer", async () => {
  const create = await producer(), controller = new AbortController(); controller.abort(); let calls = 0;
  assert.throws(() => create(controller.signal, () => { calls++; return Promise.resolve(); }, async () => {})); assert.equal(calls, 0);
});
