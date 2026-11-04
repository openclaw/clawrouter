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
import { pixVerseByteStream, pixVerseInputLease, readPixVerseBytes, inspectPixVerseBytes } from './worker/pixverse-input-body.ts';
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
      await Promise.resolve(); check(pulls === i + 1, 'no queued speculative data pull');
      if (i < 3) check(!source.complete, 'no completion while bytes remain');
    }
    check(total === 50000, 'all original bytes delivered');
    // workerd may request the empty terminal pull when its final data read is
    // fulfilled. That is EOF, not speculative production of another data chunk.
    check(bodyBudgetCharged() === 96 * 1024 * 1024, 'full lease at delivery boundary');
    check((await reader.read()).done && source.complete, 'explicit EOF'); await source.done; reader.releaseLock();
    const canceled = pixVerseByteStream([new Uint8Array(50000)]), cancelReader = canceled.body.getReader();
    await cancelReader.read(); await cancelReader.cancel(); await canceled.done;
    check(!canceled.complete, 'cancel is not EOF'); cancelReader.releaseLock();
    const expected = Number(request.headers.get('content-length'));
    const raw = await readPixVerseBytes(request.body, 8 * 1024 * 1024 + 32768, operation);
    check(raw.length === expected && raw.buffer.byteLength === 8 * 1024 * 1024 + 32768, 'native request BYOB fixed buffer');
    const codecMaximum = await inspectPixVerseBytes(raw.subarray(0, 50000), operation, async response => {
      const reader = response.body.getReader(); let maximum = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; maximum = Math.max(maximum, part.value.length); }
      reader.releaseLock(); return maximum;
    });
    check(codecMaximum <= 16384, 'codec response view preserves bounded chunks');
    const sent = pixVerseByteStream([raw]);
    const response = await fetch('https://fixture.example/echo', { method: 'POST', body: sent.body.pipeThrough(new FixedLengthStream(sent.length)), signal: operation.signal });
    const echoed = await response.json();
    check(sent.complete && echoed.bytes === expected && echoed.maximum <= 16384, 'native fixed-length transport consumption');
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
  for (const length of [50000, 8 * 1024 * 1024]) {
    const response = await fetch(base, { method: "POST", body: new Uint8Array(length).fill(71) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { pulls: 4, maximum: 16384, refused: true, bytes: length, held: 96 * 1024 * 1024 });
  }
});

// Transport-only object: the companion composed-runtime suite exercises the
// actual credential/receipt owners. Here workerd, rather than a Node stub,
// owns the request/response pipes and pending-read cancellation.
const transportRouter = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject } from './worker/index.ts';
import { pixVerseByteStream, pixVerseInputLease, readPixVerseBytes } from './worker/pixverse-input-body.ts';
import { HttpOperation } from './worker/http-operation.ts';
const check = (condition, message) => { if (!condition) throw new Error(message); };
export class GrantCredentialObject {
  phase = 'idle'; complete = false; intact = false; held = false;
  async fetch(request) {
    if (new URL(request.url).pathname === '/status') return Response.json({phase:this.phase,complete:this.complete,intact:this.intact,held:this.held});
    const lease = pixVerseInputLease('owner'), operation = new HttpOperation(request.signal, 3000);
    let stream, delivered = false;
    this.phase = 'reading'; this.held = true;
    try {
      const raw = await readPixVerseBytes(request.body, new URL(request.url).pathname === '/overflow' ? 16384 : 8 * 1024 * 1024, operation);
      stream = pixVerseByteStream([raw]); this.phase = 'reply';
      const abort = () => stream.cancel(operation.signal.reason);
      operation.signal.addEventListener('abort', abort, {once:true});
      void stream.done.then(() => {
        operation.signal.removeEventListener('abort', abort);
        this.complete = stream.complete; this.intact = raw.length > 0 && raw[0] === 71 && raw[raw.length - 1] === 71;
        this.phase = 'done'; this.held = false; operation.stop('complete'); lease.release();
      });
      delivered = true; return new Response(stream.body);
    } catch { this.phase = 'failed'; return new Response('bounded transport failure', {status:422}); }
    finally { if (!delivered) { stream?.cancel('failed'); operation.stop('complete'); this.held = false; lease.release(); } }
  }
}
async function state(stub, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await (await stub.fetch('https://owner/status')).json();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('native object transport did not reach the bounded state');
}
export default { async fetch(request, env) {
  const ingress = pixVerseInputLease('public'), operation = new HttpOperation(request.signal, 10000);
  const object = name => env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(name));
  try {
    const full = object('complete'), source = pixVerseByteStream([new Uint8Array(8 * 1024 * 1024).fill(71)]);
    const response = await full.fetch('https://owner/echo', {method:'POST',body:source.body,signal:operation.signal});
    check(response.status === 200, 'DO accepted complete byte input');
    const raw = await readPixVerseBytes(response.body, 8 * 1024 * 1024, operation);
    check(raw.length === 8 * 1024 * 1024 && raw[0] === 71 && source.complete, 'DO full input/output EOF');
    const completed = await state(full, value => value.phase === 'done');
    check(completed.complete && completed.intact && !completed.held, 'DO EOF releases only output and preserves input');

    const canceled = object('cancel-output'), upload = pixVerseByteStream([new Uint8Array(8 * 1024 * 1024).fill(71)]);
    const partial = await canceled.fetch('https://owner/echo', {method:'POST',body:upload.body,signal:operation.signal});
    const reader = partial.body.getReader({mode:'byob'});
    const first = await reader.read(new Uint8Array(16384)); check(!first.done && first.value.length <= 16384, 'bounded DO response window');
    await reader.cancel('caller stopped output'); reader.releaseLock();
    const canceledState = await state(canceled, value => value.phase === 'done');
    check(!canceledState.complete && canceledState.intact && !canceledState.held, 'DO partial cancellation preserves input and releases capacity');

    const pending = object('cancel-input'), abort = new AbortController(); let inputController, emitted = false;
    const input = new ReadableStream({type:'bytes',start(controller) { inputController = controller; },pull(controller) {
      if (!emitted) { emitted = true; controller.enqueue(new Uint8Array(16384).fill(71)); }
      else return new Promise(() => {});
    }}, {highWaterMark:0});
    const waiting = pending.fetch('https://owner/echo', {method:'POST',body:input,signal:abort.signal}).then(response => response.body?.cancel(), () => undefined);
    await state(pending, value => value.phase === 'reading' && value.held);
    abort.abort('caller stopped pending input'); inputController.error('caller stopped pending input'); await waiting;
    const aborted = await state(pending, value => value.phase === 'failed');
    check(!aborted.complete && !aborted.held, 'DO pending BYOB cancellation unlocks and releases');

    const overflow = object('overflow'), excess = pixVerseByteStream([new Uint8Array(16385).fill(71)]);
    const rejected = await overflow.fetch('https://owner/overflow', {method:'POST',body:excess.body,signal:operation.signal});
    check(rejected.status === 422, 'DO overflow rejected'); await rejected.body.cancel(); excess.cancel('rejected');
    const failed = await state(overflow, value => value.phase === 'failed'); check(!failed.held && !failed.complete, 'DO overflow never completes');
    return Response.json({complete:true,outputCanceled:true,pendingInputCanceled:true,overflowRejected:true});
  } finally { operation.stop('complete'); ingress.release(); }
} };`;

test("workerd Durable Object transport preserves borrowed input and releases EOF, cancellation and overflow leases", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-pixverse-transport-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const worker = await startWorkerdFixture(temporary, transportRouter, upstream); t.after(() => worker.dispose());
  const response = await fetch((await worker.ready).origin);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { complete: true, outputCanceled: true, pendingInputCanceled: true, overflowRejected: true });
});
