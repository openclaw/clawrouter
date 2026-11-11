import { ExactBodyCharge } from "./body-budget.ts";
/** Logical custody for one ordinary HTTP caller. No payloads or rejection reasons are retained here. */
export interface ProxyCompletionReceipt { readonly failed: boolean; readonly unused: boolean }

export class ProxyCompletion {
  private open = true;
  private pending = 0;
  private started = false;
  private failed = false;
  private resolve!: (receipt: ProxyCompletionReceipt) => void;
  readonly completion = new Promise<ProxyCompletionReceipt>(resolve => { this.resolve = resolve; });

  /** An active parent may enroll children after its own parent has sealed. */
  fork(): ProxyCompletion {
    if (!this.open) throw new TypeError("HTTP completion enrollment is closed");
    this.started = true;
    this.pending++;
    const child = new ProxyCompletion();
    void child.completion.then(receipt => {
      this.failed ||= receipt.failed;
      this.pending--;
      this.finish();
    });
    return child;
  }

  /** Reserve before invoking even synchronous work; return its ORIGINAL promise/outcome. */
  start<T>(start: (children: ProxyCompletion) => Promise<T>): Promise<T> {
    const children = this.fork();
    let work: Promise<T>;
    try { work = start(children); }
    catch (error) { children.fail(); children.seal(); throw error; }
    void work.then(() => { children.seal(); }, () => { children.fail(); children.seal(); });
    return work;
  }

  /** @internal Complete private leaf only; dynamic callers keep fork/start. */
  startPrivateLeaf<T>(invoke: () => Promise<T>): Promise<T> {
    if (!this.open) throw new TypeError("HTTP completion enrollment is closed");
    this.started = true;
    this.pending++;
    let work: Promise<T>;
    try { work = invoke(); }
    catch (error) { this.failed = true; this.pending--; this.finish(); throw error; }
    finally { invoke = undefined as never; }
    this.observePrivateLeaf(work);
    return work;
  }

  private observePrivateLeaf(work: Promise<unknown>): void {
    // This scope holds no invocation callback, fulfilled value or reject reason.
    let pending = true;
    try {
      void work.then(() => {
        if (!pending) return;
        pending = false; this.pending--; this.finish();
      }, () => {
        if (!pending) return;
        pending = false; this.failed = true; this.pending--; this.finish();
      });
    } catch (error) {
      // Observation failed after work started. Keep its enrollment UNKNOWN;
      // even a partially installed observer must not manufacture retirement.
      pending = false; this.failed = true; throw error;
    } finally { work = undefined as never; }
  }

  /** A fulfilled false accounting result is a settled failure, not successful accounting. */
  fail(): void { this.failed = true; }
  seal(): void { this.open = false; this.finish(); }
  private finish(): void {
    if (!this.open && this.pending === 0) this.resolve(Object.freeze({ failed: this.failed, unused: !this.started }));
  }
}

// Normative custody of the enumerated, already-loaded private static slice.
// No request capacity is supplied here; instance/call products stay prepaid on
// the requesting ticket. The singleton lives until this module/isolate ends.
let ownedHttpStaticCharge: ExactBodyCharge | undefined;
export function claimOwnedHttpStaticCustody(): boolean {
  if (ownedHttpStaticCharge) return true;
  const charge = ExactBodyCharge.reserve(65536);
  if (!charge) return false;
  ownedHttpStaticCharge = charge;
  return true;
}

// Private DATA primitives only. Standard intrinsics are trusted at module
// initialization; actual I/O methods are never substituted by these commands.
const ownedByteArray = Uint8Array;
const ownedByteBuffer = ArrayBuffer;
const ownedByteApply = Reflect.apply;
const ownedByteDescriptor = Object.getOwnPropertyDescriptor;
const ownedBytePrototype = Object.getPrototypeOf;
const ownedByteHasOwn = Object.hasOwn;
const ownedByteTypedPrototype = ownedBytePrototype(ownedByteArray.prototype);
const ownedByteBrand = ownedByteDescriptor(ownedByteTypedPrototype, Symbol.toStringTag)!.get!;
const ownedByteBufferOf = ownedByteDescriptor(ownedByteTypedPrototype, "buffer")!.get!;
const ownedByteOffsetOf = ownedByteDescriptor(ownedByteTypedPrototype, "byteOffset")!.get!;
const ownedByteLengthOf = ownedByteDescriptor(ownedByteTypedPrototype, "length")!.get!;
const ownedByteBackingLength = ownedByteDescriptor(ownedByteBuffer.prototype, "byteLength")!.get!;
const ownedByteResizable = ownedByteDescriptor(ownedByteBuffer.prototype, "resizable")?.get;
const ownedByteLegacyFixed = ownedByteDescriptor(ownedByteBuffer.prototype, "resizable") === undefined
  && ownedByteDescriptor(ownedByteBuffer.prototype, "maxByteLength") === undefined
  && ownedByteDescriptor(ownedByteBuffer.prototype, "resize") === undefined;
const ownedByteSet = ownedByteDescriptor(ownedByteTypedPrototype, "set")!.value;
const ownedByteHasInstance = Function.prototype[Symbol.hasInstance];
const ownedByteNoArguments = Object.freeze([]);
const ownedByteDecoder = TextDecoder;
const ownedByteDecode = TextDecoder.prototype.decode;
const ownedByteEncoder = TextEncoder;
const ownedByteEncodeInto = TextEncoder.prototype.encodeInto;
const ownedByteEncode = TextEncoder.prototype.encode;
const ownedOutputPrototype = ReadableStreamDefaultController.prototype;
const ownedOutputEnqueue = ownedByteDescriptor(ownedOutputPrototype, "enqueue")!.value;
const ownedOutputBrand = ownedByteDescriptor(ownedOutputPrototype, "desiredSize")!.get!;
const ownedByteOutputPrototype = ReadableByteStreamController.prototype;
const ownedByteOutputEnqueue = ownedByteDescriptor(ownedByteOutputPrototype, "enqueue")!.value;
const ownedByteOutputBrand = ownedByteDescriptor(ownedByteOutputPrototype, "desiredSize")!.get!;
export interface OwnedByteProof { buffer: ArrayBuffer; offset: number; length: number; backing: number }
export function inspectOwnedBytes(value: unknown): OwnedByteProof {
  if (ownedByteApply(ownedByteBrand, value, ownedByteNoArguments) !== "Uint8Array") throw new TypeError("owned byte view");
  const buffer = ownedByteApply(ownedByteBufferOf, value, ownedByteNoArguments) as ArrayBuffer;
  const backing = ownedByteApply(ownedByteBackingLength, buffer, ownedByteNoArguments) as number;
  if (ownedByteResizable ? ownedByteApply(ownedByteResizable, buffer, ownedByteNoArguments) : !ownedByteLegacyFixed)
    throw new TypeError("owned fixed backing");
  return { buffer, backing, offset: ownedByteApply(ownedByteOffsetOf, value, ownedByteNoArguments),
    length: ownedByteApply(ownedByteLengthOf, value, ownedByteNoArguments) };
}
export function isLocalOwnedByteView(value: Uint8Array): boolean { return ownedByteApply(ownedByteHasInstance, ownedByteArray, [value]); }
export function isLocalOwnedByteBacking(buffer: ArrayBuffer): boolean { return ownedByteApply(ownedByteHasInstance, ownedByteBuffer, [buffer]); }
export function ownedByteLength(value: Uint8Array): number { return ownedByteApply(ownedByteLengthOf, value, ownedByteNoArguments); }
export function ownedByteBackingBytes(value: Uint8Array): number {
  return ownedByteApply(ownedByteBackingLength, ownedByteApply(ownedByteBufferOf, value, ownedByteNoArguments), ownedByteNoArguments);
}
export function newOwnedBytes(length: number): Uint8Array<ArrayBuffer> { return new ownedByteArray(length); }
export function ownedBytesFromBacking(buffer: ArrayBuffer): Uint8Array<ArrayBuffer> { return new ownedByteArray(buffer); }
export function ownedByteSubarray(value: Uint8Array, start = 0, end = ownedByteLength(value)): Uint8Array<ArrayBuffer> {
  const proof = inspectOwnedBytes(value), length = proof.length;
  const first = start < 0 ? length + start : start, last = end < 0 ? length + end : end;
  const from = first < 0 ? 0 : first > length ? length : first;
  const to = last < 0 ? 0 : last > length ? length : last;
  return new ownedByteArray(proof.buffer, proof.offset + from, to > from ? to - from : 0);
}
export function copyOwnedBytes(destination: Uint8Array, source: Uint8Array, offset?: number): void {
  inspectOwnedBytes(destination); inspectOwnedBytes(source);
  ownedByteApply(ownedByteSet, destination, offset === undefined ? [source] : [source, offset]);
}
export function ownedByteSlice(value: Uint8Array, start = 0, end = ownedByteLength(value)): Uint8Array<ArrayBuffer> {
  const source = ownedByteSubarray(value, start, end), copy = newOwnedBytes(ownedByteLength(source));
  copyOwnedBytes(copy, source); return copy;
}
export function newOwnedDecoder(fatal = false): TextDecoder { return new ownedByteDecoder("utf-8", { fatal, ignoreBOM: false }); }
export function decodeOwnedBytes(decoder: TextDecoder, bytes?: Uint8Array, stream = false): string {
  if (bytes) inspectOwnedBytes(bytes);
  return ownedByteApply(ownedByteDecode, decoder, bytes === undefined ? [] : [bytes, { stream }]);
}
export function encodeOwnedTextInto(encoder: TextEncoder, text: string, destination: Uint8Array): ReturnType<TextEncoder["encodeInto"]> {
  inspectOwnedBytes(destination);
  return ownedByteApply(ownedByteEncodeInto, encoder, [text, destination]);
}
export function encodeOwnedText(encoder: TextEncoder, text: string): Uint8Array<ArrayBuffer> {
  return ownedByteApply(ownedByteEncode, encoder, [text]);
}
export function newOwnedEncoder(): TextEncoder { return new ownedByteEncoder(); }
export function enqueueOwnedBytes(controller: ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController, bytes: Uint8Array): void {
  // Validate before exposing the exact snapshot to any output hook. The actual
  // supported method lookup and call keep their original receiver/argument.
  const prototype = ownedBytePrototype(controller);
  if (prototype !== ownedOutputPrototype && prototype !== ownedByteOutputPrototype || ownedByteDescriptor(controller, "enqueue") !== undefined)
    throw new TypeError("owned output handoff");
  ownedByteApply(prototype === ownedOutputPrototype ? ownedOutputBrand : ownedByteOutputBrand, controller, ownedByteNoArguments);
  const descriptor = ownedByteDescriptor(prototype, "enqueue");
  if (!descriptor || !ownedByteHasOwn(descriptor, "value") || descriptor.value !== (prototype === ownedOutputPrototype ? ownedOutputEnqueue : ownedByteOutputEnqueue))
    throw new TypeError("owned output handoff");
  const method = controller.enqueue;
  ownedByteApply(method, controller, [bytes]);
}

// Private metadata admission uses genuine internal Headers storage. The pinned
// Workerd constructor's Headers fast path must be qualified by hosted witnesses;
// this does not claim that every other runtime ignores a mutable iterator.
const ownedHeaderForEach = Headers.prototype.forEach;
const ownedResponseConstructor = Response;
function countOwnedHeader(this: { bytes: number; units: number }, value: string, key: string): void {
  const units = value.length + key.length;
  this.bytes += 32 + 4 * units; this.units += units;
  if (this.bytes > 9007199254740991) throw new TypeError("owned header size");
}
export function measureOwnedHeaders(headers: Headers): number {
  const counter = { bytes: 0, units: 0 };
  ownedByteApply(ownedHeaderForEach, headers, [countOwnedHeader, counter]);
  return counter.bytes;
}
export function measureOwnedHeaderUnits(headers: Headers): number {
  const counter = { bytes: 0, units: 0 };
  ownedByteApply(ownedHeaderForEach, headers, [countOwnedHeader, counter]);
  return counter.units;
}
export function newOwnedResponse(body: ReadableStream<Uint8Array> | Uint8Array | string | null, status: number, statusText: string, headers: Headers): Response {
  return new ownedResponseConstructor(body, { __proto__: null, status, statusText, headers } as ResponseInit);
}

// Closed private metadata DATA commands. The caller admits the complete stage
// before constructing a clone or inserting a new retained string occurrence.
const ownedHeadersConstructor = Headers;
const ownedHeaderSet = Headers.prototype.set;
const ownedHeaderHas = Headers.prototype.has;
const ownedHeaderGet = Headers.prototype.get;
const ownedHeaderDelete = Headers.prototype.delete;
const ownedPrimitiveString = String;
export function newOwnedHeaders(headers?: Headers): Headers { return new ownedHeadersConstructor(headers); }
export function setOwnedHeader(headers: Headers, name: string, value: string): void {
  ownedByteApply(ownedHeaderSet, headers, [name, value]);
}
export function hasOwnedHeader(headers: Headers, name: string): boolean {
  return ownedByteApply(ownedHeaderHas, headers, [name]);
}
export function getOwnedHeader(headers: Headers, name: string): string | null {
  return ownedByteApply(ownedHeaderGet, headers, [name]);
}
export function deleteOwnedHeader(headers: Headers, name: string): void {
  ownedByteApply(ownedHeaderDelete, headers, [name]);
}
export function ownedMetadataString(value: string | number | boolean | null | undefined): string {
  return ownedPrimitiveString(value);
}

const ownedResponseBody = ownedByteDescriptor(ownedResponseConstructor.prototype, "body")!.get!;
const ownedResponseStatus = ownedByteDescriptor(ownedResponseConstructor.prototype, "status")!.get!;
const ownedResponseStatusText = ownedByteDescriptor(ownedResponseConstructor.prototype, "statusText")!.get!;
const ownedResponseHeaders = ownedByteDescriptor(ownedResponseConstructor.prototype, "headers")!.get!;
const ownedResponseSocket = ownedByteDescriptor(ownedResponseConstructor.prototype, "webSocket")?.get;
export function captureOwnedResponseMetadata(response: Response) {
  return { body: ownedByteApply(ownedResponseBody, response, ownedByteNoArguments) as ReadableStream<Uint8Array> | null,
    status: ownedByteApply(ownedResponseStatus, response, ownedByteNoArguments) as number,
    statusText: ownedByteApply(ownedResponseStatusText, response, ownedByteNoArguments) as string,
    headers: ownedByteApply(ownedResponseHeaders, response, ownedByteNoArguments) as Headers,
    webSocket: ownedResponseSocket ? ownedByteApply(ownedResponseSocket, response, ownedByteNoArguments) as WebSocket | null : undefined };
}
export function cloneOwnedMetadataResponse(source: ReturnType<typeof captureOwnedResponseMetadata>): Response {
  return new ownedResponseConstructor(source.body, { __proto__: null, status: source.status, statusText: source.statusText,
    headers: source.headers, ...(source.webSocket ? { webSocket: source.webSocket } : {}) } as ResponseInit);
}

const driverNativeThen = Promise.prototype.then;
const driverDefaultRead = ReadableStreamDefaultReader.prototype.read;
const driverByobRead = ReadableStreamBYOBReader.prototype.read;
const driverDefaultCancel = ReadableStreamDefaultReader.prototype.cancel;
const driverByobCancel = ReadableStreamBYOBReader.prototype.cancel;

// An external observer can retain either handler indefinitely. The only bound
// receiver is this fresh cell, never the driver or its readiness nonce directly.
// Inert cells remain external artifacts; no claim about their heap lifetime is made.
interface DriverObservation {
  owner: OwnedReaderDriver | undefined;
  token: Promise<void> | undefined;
  kind: number;
  state: number; // accepted, installed, uncertain, inert
}
function driverObservationFulfilled(this: DriverObservation, value: unknown): void {
  if (this.state & (1 | 8)) { value = undefined; return; }
  try { this.owner?.dispatchDriverObservation(this, false, value); }
  finally { value = undefined; }
}
function driverObservationRejected(this: DriverObservation, reason: unknown): void {
  if (this.state & (1 | 8)) { reason = undefined; return; }
  try { this.owner?.dispatchDriverObservation(this, true, reason); }
  finally { reason = undefined; }
}

// Internal fixed receiver base. Only the source, consumer, public, normalizer and fixed RPC reader classes
// construct it after their existing capability/provenance/funding checks. No
// callback, strategy, raw result getter or graph-valued Promise is accepted.
export abstract class OwnedReaderDriver {
  body?: ReadableStream<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  captured?: Uint8Array;
  reading?: Promise<void>;
  readonly retired: Promise<void>;
  private bits = 0;
  // Six disposition bits, two five-bit operation masks, four native-proof
  // bits and three booleans. Installation depth and callback nesting stay separate.
  protected get driverFlags(): number { return this.bits & 63; }
  protected set driverFlags(value: number) { this.bits = this.bits & ~63 | value & 63; }
  private get pending(): number { return this.bits >>> 6 & 31; }
  private set pending(value: number) { this.bits = this.bits & ~(31 << 6) | (value & 31) << 6; }
  private get seen(): number { return this.bits >>> 11 & 31; }
  private set seen(value: number) { this.bits = this.bits & ~(31 << 11) | (value & 31) << 11; }
  private get native(): number { return this.bits >>> 16 & 15; }
  private set native(value: number) { this.bits = this.bits & ~(15 << 16) | (value & 15) << 16; }
  private get queued(): boolean { return !!(this.bits & 1 << 20); }
  private set queued(value: boolean) { this.bits = value ? this.bits | 1 << 20 : this.bits & ~(1 << 20); }
  get readDone(): boolean { return !!(this.bits & 1 << 21); }
  set readDone(value: boolean) { this.bits = value ? this.bits | 1 << 21 : this.bits & ~(1 << 21); }
  private get readDelivered(): boolean { return !!(this.bits & 1 << 22); }
  private set readDelivered(value: boolean) { this.bits = value ? this.bits | 1 << 22 : this.bits & ~(1 << 22); }
  protected nativeFailure?: object;
  private installing = 0;
  private activeTails = 0;
  private advanceWork = this.advance.bind(this);
  private readAccept?: () => void;
  private readReject?: (failure: object) => void;
  private readFailure?: object;
  private pullOriginal?: Promise<void>;
  private readObservation?: DriverObservation;
  private pullObservation?: DriverObservation;
  private closedObservation?: DriverObservation;
  private cancelObservation?: DriverObservation;
  private unlockObservation?: DriverObservation;
  private resolveRetired!: () => void;
  constructor() { this.retired = new Promise<void>(resolve => { this.resolveRetired = resolve; }); }
  protected abstract holdDriver(): void;
  protected abstract driverProtocolFailure(): Error;
  protected abstract recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object;
  protected recordDriverInstallationFailure(kind: "read" | "cancel" | "unlock" | "closed" | "pull", reason: unknown): object {
    return this.recordDriverFailure(kind, reason);
  }
  protected abstract captureDriverValue(value: ReadableStreamReadResult<Uint8Array>): void;
  protected abstract propagatedDriverFailure(reason: unknown): boolean;
  protected abstract driverCleared(): void;
  protected driverRetired(): void {}
  protected driverPullRetired(): void {}
  protected captureDriverFailure(reason: unknown): object { return this.recordDriverFailure("read", reason); }
  protected driverCleanupFailure(_kind: "closed" | "cancel" | "unlock", _failure: object): void {}
  protected driverPullFailure(_failure: object): void {}
  get driverDone(): boolean { return !!(this.driverFlags & 16); }
  get driverCapturing(): boolean { return !!((this.pending | this.seen) & 1) || !!this.installing || !!this.activeTails; }
  get pulling(): boolean { return !!(this.pending & 16); }
  protected uncertain(): void {
    this.driverFlags |= 32;
    try { this.holdDriver(); } catch { /* The unresolved driver receipt still holds its parent. */ }
  }
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    try { queueMicrotask(this.advanceWork); }
    catch (reason) {
      this.uncertain();
      try { this.recordDriverFailure("retire", reason); } catch { /* No observer exception may escape. */ }
      finally { reason = undefined; }
    }
  }
  private observe(kind: number, original: Promise<unknown>, token?: Promise<void>, normalizeVoid = false): void {
    this.installing++;
    let cell: DriverObservation | undefined;
    try {
      cell = { owner: this, token, kind, state: 0 };
      if (kind === 1) this.readObservation = cell;
      else if (kind === 16) this.pullObservation = cell;
      else if (kind === 8) this.closedObservation = cell;
      else if (kind === 2) this.cancelObservation = cell;
      else this.unlockObservation = cell;
      let then: unknown;
      if (normalizeVoid) {
        if (original !== null && (typeof original === "object" || typeof original === "function")) then = original.then;
        if (typeof then !== "function") { original = Promise.resolve(); then = driverNativeThen; }
      } else then = original.then;
      if (then !== driverNativeThen) this.native &= ~(kind === 8 ? 1 : kind === 1 ? 2 : kind === 2 ? 4 : 0);
      void Reflect.apply(then as Function, original, [driverObservationFulfilled.bind(cell), driverObservationRejected.bind(cell)]);
      cell.state |= 2;
    } catch (reason) { if (cell) cell.state |= 4; throw reason; }
    finally { cell = undefined; original = undefined as never; token = undefined; this.installing--; this.schedule(); }
  }
  private eligible(kind: number, token?: Promise<void>): boolean {
    return !(this.driverFlags & 16) && !!(this.pending & kind) && !(this.seen & kind)
      && (kind !== 1 || !!token && token === this.reading)
      && (kind !== 16 || !!token && token === this.pullOriginal);
  }
  /** @internal Only the two fixed cell-bound handlers enter this command. */
  dispatchDriverObservation(cell: DriverObservation, failed: boolean, value: unknown): void {
    if (cell.owner !== this || cell.state & (1 | 8) || !this.eligible(cell.kind, cell.token)) { value = undefined; return; }
    cell.state |= 1;
    try {
      if (failed) this.rejected(cell.kind, cell.token, value);
      else this.fulfilled(cell.kind, cell.token, value);
    } catch { this.uncertain(); }
    finally { value = undefined; }
  }
  private dischargeObservation(kind: number): void {
    let cell = kind === 1 ? this.readObservation : kind === 16 ? this.pullObservation : kind === 8 ? this.closedObservation
      : kind === 2 ? this.cancelObservation : this.unlockObservation;
    if (!cell) return;
    if (this.installing || this.activeTails || this.driverFlags & 32 || (cell.state & 7) !== 3) { cell = undefined; return; }
    // Acceptance already transferred any captured bytes/failure to the still
    // funded driver. No queued command retains this cell or its nonce directly.
    cell.state = 8; cell.owner = undefined; cell.token = undefined; cell.kind = 0;
    if (kind === 1) this.readObservation = undefined;
    else if (kind === 16) this.pullObservation = undefined;
    else if (kind === 8) this.closedObservation = undefined;
    else if (kind === 2) this.cancelObservation = undefined;
    else this.unlockObservation = undefined;
    cell = undefined;
  }
  private fulfilled(kind: number, token: Promise<void> | undefined, value: unknown): void {
    if (!this.eligible(kind, token)) { value = undefined; return; }
    this.seen |= kind; this.activeTails++;
    try { if (kind === 1) this.captureDriverValue(value as ReadableStreamReadResult<Uint8Array>); }
    catch (reason) {
      try { this.readFailure ??= this.captureDriverFailure(reason); }
      catch { this.uncertain(); }
      finally { reason = undefined; }
    }
    finally { value = undefined; this.activeTails--; this.schedule(); }
  }
  private rejected(kind: number, token: Promise<void> | undefined, reason: unknown): void {
    if (!this.eligible(kind, token)) { reason = undefined; return; }
    this.seen |= kind; this.activeTails++;
    try {
      if (kind === 1) {
        const failure = this.native & 2 && this.nativeFailure ? this.nativeFailure
          : this.native & 2 && this.propagatedDriverFailure(reason) ? reason as object : this.recordDriverFailure("read", reason);
        if (this.native & 2) this.nativeFailure = failure;
        this.readFailure ??= failure;
      } else if (kind === 8) {
        this.native |= 8;
        if (!(this.native & 1 && (this.nativeFailure || this.propagatedDriverFailure(reason)))) {
          const failure = this.recordDriverFailure("closed", reason);
          if (this.native & 1) this.nativeFailure = failure;
          this.driverCleanupFailure("closed", failure);
        }
      } else if (kind === 2) {
        if (!(this.native & 4 && this.native & 8 && (this.nativeFailure || this.propagatedDriverFailure(reason))))
          this.driverCleanupFailure("cancel", this.recordDriverFailure("cancel", reason));
      } else if (kind === 4) this.driverCleanupFailure("unlock", this.recordDriverFailure("unlock", reason));
      else this.driverPullFailure(this.recordDriverFailure("pull", reason));
    } catch { this.uncertain(); }
    finally { reason = undefined; this.activeTails--; this.schedule(); }
  }
  protected observeDriverClosed(native: boolean): void {
    this.pending |= 8; this.installing++;
    if (native) this.native |= 1;
    let original: Promise<unknown> | undefined, started = false;
    try { original = this.reader!.closed; started = !!original; this.observe(8, original); }
    catch (reason) {
      if (started) this.uncertain(); else this.seen |= 8;
      const failure = started ? this.recordDriverInstallationFailure("closed", reason) : this.recordDriverFailure("closed", reason); reason = undefined;
      throw failure;
    } finally { original = undefined; this.installing--; this.schedule(); }
  }
  protected startDriverRead(byobBytes?: number | Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.driverFlags & 1 || this.pending & 1 || this.readObservation || !this.reader) throw this.driverProtocolFailure();
    this.pending |= 1; this.seen &= ~1; this.readDelivered = false; this.readFailure = undefined;
    const ready = new Promise<void>((accept, reject) => { this.readAccept = accept; this.readReject = reject; });
    this.reading = ready; this.installing++;
    let original: Promise<unknown> | undefined, started = false;
    try {
      const reader = this.reader, method = reader.read;
      const prototype = byobBytes === undefined ? ReadableStreamDefaultReader.prototype : ReadableStreamBYOBReader.prototype;
      if (this.native & 1 && Object.getPrototypeOf(reader) === prototype && method === (byobBytes === undefined ? driverDefaultRead : driverByobRead)) this.native |= 2; else this.native &= ~2;
      original = Reflect.apply(method, reader, byobBytes === undefined ? [] : [typeof byobBytes === "number" ? newOwnedBytes(byobBytes) : byobBytes]);
      started = !!original;
      this.observe(1, original!, ready);
    } catch (reason) {
      if (started) this.uncertain(); else this.seen |= 1;
      const failure = started ? this.recordDriverInstallationFailure("read", reason) : this.recordDriverFailure("read", reason);
      this.readFailure ??= failure; reason = undefined;
    } finally { original = undefined; this.installing--; this.schedule(); }
    return ready;
  }
  protected beginDriverPull(): void {
    // Native stream demand may resume after our pull observer returns but before
    // its queued pump. Consume only that proven tail; keep the queued driver.
    if (!this.installing && !this.activeTails && this.seen & 16) {
      // Finish this original's bookkeeping before rearming. The already-queued
      // driver pump is still funded, but captures neither this cell nor its nonce.
      this.dischargeObservation(16);
      this.seen &= ~16; this.pending &= ~16; this.pullOriginal = undefined; this.driverPullRetired();
    }
    if (this.pending & 16 || this.pullObservation) throw this.driverProtocolFailure();
    this.pullOriginal = undefined;
    this.pending |= 16; this.seen &= ~16;
  }
  protected ownDriverPull(original: Promise<void>): Promise<void> {
    this.pullOriginal = original;
    try { this.observe(16, original, original); }
    catch (reason) { this.driverPullFailure(this.recordDriverInstallationFailure("pull", reason)); reason = undefined; this.uncertain(); }
    return original;
  }
  protected stopDriver(cancel: boolean, immediateUnlock = false): Promise<void> {
    if (!(this.driverFlags & 1)) {
      this.driverFlags |= 1 | (cancel ? 2 : 0) | (immediateUnlock ? 4 : 0);
      if (cancel) this.cancelDriver();
      if (immediateUnlock) this.unlockDriver();
      this.schedule();
    }
    return this.retired;
  }
  protected stopNormalizerDriver(reason: unknown): Promise<void> {
    try { return this.stopNormalizer(reason); } finally { reason = undefined; }
  }
  protected stopNormalizerOperationDriver(operation: import("./http-operation.ts").HttpOperation): Promise<void> {
    try { return this.stopNormalizer(undefined, operation); } finally { operation = undefined as never; }
  }
  private stopNormalizer(reason: unknown, operation?: import("./http-operation.ts").HttpOperation): Promise<void> {
    if (!(this.driverFlags & 1)) {
      this.driverFlags |= 1 | 2 | 4;
      try { this.cancelDriver(reason, true, operation); }
      finally {
        reason = undefined; operation = undefined;
        // A failed FIRST invocation/installation cannot skip this independent
        // original. No pull waits for the retirement that includes itself.
        try { this.unlockDriver(true); } finally { this.schedule(); }
      }
    }
    reason = undefined; operation = undefined;
    return this.retired;
  }
  protected stopUsageDriver(cancel: boolean, reason?: unknown): Promise<void> {
    if (!(this.driverFlags & 1)) {
      this.bits |= 1 << 23; // Fixed delayed-unlock role; no retained reason.
      this.driverFlags |= 1 | (cancel ? 2 : 0);
      try { if (cancel) this.cancelDriver(reason, true); }
      finally { reason = undefined; this.schedule(); }
    }
    reason = undefined;
    return this.retired;
  }
  protected finishNormalizerDriver(): Promise<void> {
    if (!(this.driverFlags & 1)) {
      this.driverFlags |= 1 | 4;
      try { this.unlockDriver(true); } finally { this.schedule(); }
    }
    return this.retired;
  }
  private cancelDriver(reason?: unknown, normalizer = false, operation?: import("./http-operation.ts").HttpOperation): void {
    this.pending |= 2; this.installing++;
    let original: Promise<unknown> | undefined, started = false;
    try {
      if (this.reader) {
        const reader = this.reader, method = reader.cancel;
        const prototype = Object.getPrototypeOf(reader);
        if (this.native & 1 && (prototype === ReadableStreamDefaultReader.prototype || prototype === ReadableStreamBYOBReader.prototype)
          && method === (prototype === ReadableStreamDefaultReader.prototype ? driverDefaultCancel : driverByobCancel)) this.native |= 4; else this.native &= ~4;
        original = Reflect.apply(method, reader, normalizer ? [operation ? operation.signal.reason : reason] : []);
      } else if (!this.body) { this.seen |= 2; return; }
      else if (this.body.locked) { this.uncertain(); return; }
      else original = normalizer ? this.body.cancel(operation ? operation.signal.reason : reason) : this.body.cancel();
      reason = undefined; operation = undefined;
      started = !!original;
      this.observe(2, original!);
    } catch (reason) {
      if (started) this.uncertain(); else this.seen |= 2;
      this.driverCleanupFailure("cancel", started ? this.recordDriverInstallationFailure("cancel", reason) : this.recordDriverFailure("cancel", reason)); reason = undefined;
    } finally { original = undefined; reason = undefined; operation = undefined; this.installing--; this.schedule(); }
  }
  private unlockDriver(normalizer = false): void {
    if (this.driverFlags & 8) return;
    this.driverFlags |= 8; this.pending |= 4; this.installing++;
    let original: unknown, started = false;
    try {
      if (!this.reader) { this.seen |= 4; return; }
      const reader = this.reader, method = reader.releaseLock;
      original = Reflect.apply(method, reader, []);
      started = original !== undefined;
      if (!started) this.seen |= 4;
      else this.observe(4, original as Promise<unknown>, undefined, true);
    } catch (reason) {
      if (started) this.uncertain(); else this.seen |= 4;
      this.driverCleanupFailure("unlock", started ? this.recordDriverInstallationFailure("unlock", reason) : this.recordDriverFailure("unlock", reason)); reason = undefined;
    } finally { original = undefined; this.installing--; this.schedule(); }
  }
  private advance(): void {
    this.queued = false;
    if (this.installing || this.activeTails) return;
    const seen = this.seen; this.seen = 0; this.pending &= ~seen;
    if (seen & 1) this.dischargeObservation(1);
    if (seen & 2) this.dischargeObservation(2);
    if (seen & 4) this.dischargeObservation(4);
    if (seen & 8) this.dischargeObservation(8);
    if (seen & 16) this.dischargeObservation(16);
    if (seen & 16) { this.pullOriginal = undefined; this.driverPullRetired(); }
    // Logical installation failure is prompt even when the original remains
    // UNKNOWN. A later original still captures/discards under this same owner.
    if (!this.readDelivered && this.readAccept && (seen & 1 || this.readFailure)) {
      const accept = this.readAccept, reject = this.readReject;
      this.readAccept = undefined; this.readReject = undefined; this.readDelivered = true;
      if (this.readFailure) reject!(this.readFailure); else accept();
    }
    // The readiness identity remains the original observer's nonce after a
    // prompt logical failure. Only its actual callback/tail clears that nonce.
    if (seen & 1) this.reading = undefined;
    if (!(this.driverFlags & 1) || this.pending & 3) return;
    if (!(this.driverFlags & 8)) { this.unlockDriver(!!(this.bits & 1 << 23)); return; }
    if (this.pending || this.queued || this.driverFlags & (16 | 32)) return;
    try {
      if (this.body?.locked) { this.uncertain(); return; }
      this.body = undefined; this.reader = undefined; this.captured = undefined; this.nativeFailure = undefined;
      this.reading = undefined; this.readFailure = undefined; this.advanceWork = undefined as never;
      this.driverCleared(); this.driverFlags |= 16; this.driverRetired(); this.resolveRetired();
    } catch (reason) { this.recordDriverFailure("retire", reason); reason = undefined; this.uncertain(); }
  }
}
