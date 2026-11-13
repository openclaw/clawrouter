// Classify by bytes, never upload speed. One BYOB reader retains a bounded
// prefix and transfers it and the unread tail to exactly one routing path.
import type {JsonReadPrefix} from '../utils.ts';
export const probeBytes = 256 * 1024, probeReadBytes = 16 * 1024, probeBudgetBytes = 32 * (probeBytes + 1);
let charged = 0;
const releases = new WeakMap<Request, () => void>();
export const probeCharged = () => charged;
export function releaseProbe(request: Request) { releases.get(request)?.(); releases.delete(request); }

// Canonical intake owns the same physical prefix and subsequent JSON parsing.
export interface ProbeIntake {
 reserve(bytes: number): Promise<void>;
 // A native handoff retains no parsed Worker body. Retire its canonical
 // prefix charge once the last retained buffer leaves this owner.
 retirePrefix?(): void;
 // Only a complete prefix may transfer directly to its canonical JSON owner.
 retainPrefix?(request: Request, prefix: JsonReadPrefix): void;
}
export async function probeUnknown(request: Request, intake?: ProbeIntake): Promise<{ request: Request; small: boolean; reason: string }> {
 if (!request.body) return { request, small: true, reason: 'empty' };
 if (!intake && charged + probeReadBytes > probeBudgetBytes) return { request, small: false, reason: 'probe_capacity' };
 let reader: ReadableStreamBYOBReader | undefined;
 try { reader = request.body.getReader({ mode: 'byob' }); }
 catch { return { request, small: false, reason: 'probe_stream' }; }
 let owned = 0, released = false, prefix: Uint8Array[] = [], bytes = 0, ended = false;
 let nativePrefix = false, prefixRetired = false;
 const retirePrefix = () => { if (nativePrefix && !prefixRetired) { prefixRetired = true; intake?.retirePrefix?.(); } };
 const reserve = (size: number) => { if (!intake && charged + size > probeBudgetBytes) return false; charged += size; owned += size; return true; };
 const release = () => { if (!released) { released = true; charged -= owned; owned = 0; request.signal.removeEventListener('abort', cancel); retirePrefix(); } };
 const cancel = () => { prefix = []; void reader?.cancel(request.signal.reason).catch(() => {}); release(); };
 request.signal.addEventListener('abort', cancel, { once: true });
 if (request.signal.aborted) { cancel(); throw request.signal.reason; }
 const limit = intake ? 32_000_000 : probeBytes;
 let reason = 'probe_limit';
 try {
  while (bytes <= limit) {
   const size = Math.min(probeReadBytes, limit + 1 - bytes);
   // Use the canonical intake thresholds and 2x body charge. Raw bytes
   // transfer to its JSON reader without copying. Do not reject exact-budget
   // EOFs for padding that only a future read could need.
   if (intake) await intake.reserve(Math.max(bytes, probeReadBytes));
   if (!reserve(size)) { reason = 'probe_capacity'; break; }
   // Fill each backing before retaining another. Tiny chunks cannot amplify
   // retained buffers or array entries. BYOB transfers the same backing on
   // each partial read, so there is no prefix copy or tee.
   let backing: ArrayBuffer = new ArrayBuffer(size), used = 0;
   while (used < size) {
    const part = await reader!.read(new Uint8Array(backing, used));
    if (request.signal.aborted) throw request.signal.reason;
    if (part.value) { backing = part.value.buffer as ArrayBuffer; used += part.value.byteLength; bytes += part.value.byteLength; }
    if (part.done) { ended = true; reason = 'probe_eof'; reader!.releaseLock(); reader = undefined; break; }
   }
   if (intake) await intake.reserve(Math.max(bytes, probeReadBytes));
   if (used) prefix.push(new Uint8Array(backing, 0, used));
   else { charged -= size; owned -= size; }
   if (ended) break;
  }
 } catch (error) { cancel(); throw error; }
 const small = ended && bytes <= limit;
 nativePrefix = !small;
 const readPrefix = () => {
  const part = prefix.shift();
  if (part) {
   charged -= part.buffer.byteLength; owned -= part.buffer.byteLength;
   if (prefix.length === 0) retirePrefix();
  }
  return part;
 };
 // A complete body already has a canonical JSON owner. Transfer only that
 // capability: constructing a replacement stream/Request would allocate a
 // transport that the owner must immediately cancel without ever reading.
 if (small && intake?.retainPrefix) {
  releases.set(request, () => { prefix = []; release(); });
  intake.retainPrefix(request, { bytes, read: readPrefix, finish() { prefix = []; release(); } });
  return { request, small, reason };
 }
 const body = new ReadableStream<Uint8Array>({
  async pull(c) {
   if (prefix.length) {
    const part = readPrefix()!;
    c.enqueue(part);
    return;
   }
   if (ended) { release(); c.close(); return; }
   try {
    const part = await reader!.read(new Uint8Array(probeReadBytes));
    if (part.done) { ended = true; reader!.releaseLock(); reader = undefined; release(); c.close(); }
    else c.enqueue(part.value);
   } catch (error) { release(); c.error(error); }
  },
  cancel(reason) { prefix = []; release(); return reader?.cancel(reason); },
 }, { highWaterMark: 0 });
 const next = new Request(request, { body, duplex: 'half' } as RequestInit);
 releases.set(next, () => { prefix = []; void reader?.cancel().catch(() => {}); release(); });
 return { request: next, small, reason };
}
