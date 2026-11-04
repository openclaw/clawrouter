import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Run the byte controller/BYOB and capacity lifetime in workerd itself. Node's
// FixedLengthStream shim cannot qualify native stream queue behavior.
const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import { pixVerseByteStream, pixVerseInputLease, readPixVerseBytes } from './worker/pixverse-input-body.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
import { HttpOperation } from './worker/http-operation.ts';
const check = (condition, message) => { if (!condition) throw new Error(message); };
export default { async fetch(request) {
  const operation = new HttpOperation(request.signal, 10000);
  const ingress = pixVerseInputLease('public'), owner = pixVerseInputLease('owner');
  try {
    check(bodyBudgetCharged() === 96 * 1024 * 1024, 'whole composed capacity');
    let refused = false;
    try { pixVerseInputLease('owner'); } catch { refused = true; }
    check(refused, 'third lease refused');
    let pulls = 0, maximum = 0;
    class ObservedBytes extends Uint8Array {
      subarray(start, end) { pulls++; maximum = Math.max(maximum, end - start); return super.subarray(start, end); }
    }
    const source = pixVerseByteStream([new ObservedBytes(50000).fill(71)]);
    await Promise.resolve(); check(pulls === 0, 'no read ahead');
    const reader = source.body.getReader();
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const chunk = await reader.read(); check(!chunk.done && chunk.value.length <= 16384, 'bounded default chunk'); total += chunk.value.length;
      await Promise.resolve(); check(pulls === i + 1, 'no queued speculative pull');
    }
    check(total === 50000 && !source.complete, 'lease remains until EOF, not last enqueue');
    check(bodyBudgetCharged() === 96 * 1024 * 1024, 'full lease at delivery boundary');
    check((await reader.read()).done && source.complete, 'explicit EOF'); await source.done; reader.releaseLock();
    const canceled = pixVerseByteStream([new Uint8Array(50000)]), cancelReader = canceled.body.getReader();
    await cancelReader.read(); await cancelReader.cancel(); await canceled.done;
    check(!canceled.complete, 'cancel is not EOF'); cancelReader.releaseLock();
    const raw = await readPixVerseBytes(request.body, 65536, operation);
    check(raw.length === 50000 && raw.buffer.byteLength === 65536, 'native request BYOB fixed buffer');
    const sent = pixVerseByteStream([raw]);
    const response = await fetch('https://fixture.example/echo', { method: 'POST', body: sent.body.pipeThrough(new FixedLengthStream(sent.length)), signal: operation.signal });
    const echoed = await response.json();
    check(sent.complete && echoed.bytes === 50000 && echoed.maximum <= 16384, 'native fixed-length transport consumption');
    return Response.json({ pulls, maximum, refused, bytes: raw.length, held: bodyBudgetCharged() });
  } finally { operation.stop('complete'); owner.release(); ingress.release(); }
} };`;
const upstream = `export default { async fetch(request) {
  const reader = request.body.getReader({mode:'byob'}); let window = new Uint8Array(16384), bytes = 0, maximum = 0;
  for (;;) { const part = await reader.read(window); if (part.value) { bytes += part.value.length; maximum = Math.max(maximum,part.value.length); window = new Uint8Array(part.value.buffer); } if (part.done) break; }
  reader.releaseLock(); return Response.json({bytes,maximum});
} };`;

test("workerd composed input proves bounded pulls, native BYOB, cancellation and full capacity refusal/lifetime", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-pixverse-capacity-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const worker = await startWorkerdFixture(temporary, router, upstream); t.after(() => worker.dispose());
  const base = (await worker.ready).origin;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(base, { method: "POST", body: new Uint8Array(50000).fill(71) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { pulls: 4, maximum: 16384, refused: true, bytes: 50000, held: 96 * 1024 * 1024 });
  }
});
