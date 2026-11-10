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

const driverNativeThen = Promise.prototype.then;
const driverDefaultRead = ReadableStreamDefaultReader.prototype.read;
const driverByobRead = ReadableStreamBYOBReader.prototype.read;
const driverDefaultCancel = ReadableStreamDefaultReader.prototype.cancel;
const driverByobCancel = ReadableStreamBYOBReader.prototype.cancel;

// Internal fixed receiver base. Only the three genuine private reader classes
// construct it after their existing capability/provenance/funding checks. No
// callback, strategy, raw result getter or graph-valued Promise is accepted.
export abstract class OwnedReaderDriver {
  body?: ReadableStream<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  originalRead?: Promise<unknown>;
  captured?: Uint8Array;
  readDone = false;
  reading?: Promise<void>;
  readonly retired: Promise<void>;
  protected driverFlags = 0; // stopping=1, cancel=2, immediate unlock=4, unlocked=8, done=16, UNKNOWN=32.
  protected nativeFailure?: object;
  private pending = 0; // read=1, cancel=2, unlock=4, closed=8, pull=16.
  private seen = 0;
  private installing = 0;
  private activeTails = 0;
  private serial = 0;
  private pullSerial = 0;
  private queued = false;
  private advanceWork = this.advance.bind(this);
  private readAccept?: () => void;
  private readReject?: (failure: object) => void;
  private readFailure?: object;
  private cancelOriginal?: Promise<unknown>;
  private unlockOriginal?: unknown;
  private closedOriginal?: Promise<unknown>;
  private pullOriginal?: Promise<void>;
  private resolveRetired!: () => void;
  private native = 0; // closed=1, read=2, cancel=4, closed rejected=8.
  constructor() { this.retired = new Promise<void>(resolve => { this.resolveRetired = resolve; }); }
  protected abstract holdDriver(): void;
  protected abstract driverProtocolFailure(): Error;
  protected abstract recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object;
  protected abstract captureDriverValue(value: ReadableStreamReadResult<Uint8Array>): void;
  protected abstract propagatedDriverFailure(reason: unknown): boolean;
  protected abstract driverCleared(): void;
  protected driverRetired(): void {}
  protected captureDriverFailure(reason: unknown): object { return this.recordDriverFailure("read", reason); }
  protected driverCleanupFailure(_kind: "closed" | "cancel" | "unlock", _failure: object): void {}
  protected driverPullFailure(_failure: object): void {}
  get driverDone(): boolean { return !!(this.driverFlags & 16); }
  get driverCapturing(): boolean { return !!((this.pending | this.seen) & 1) || !!this.installing || !!this.activeTails; }
  get pulling(): boolean { return !!(this.pending & 16); }
  protected uncertain(): void { this.driverFlags |= 32; this.holdDriver(); }
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    try { queueMicrotask(this.advanceWork); }
    catch (reason) { this.recordDriverFailure("retire", reason); reason = undefined; this.uncertain(); }
  }
  private observe(kind: number, original: Promise<unknown>, serial = this.serial): void {
    this.installing++;
    try {
      const then = original.then;
      if (then !== driverNativeThen) this.native &= ~(kind === 8 ? 1 : kind === 1 ? 2 : kind === 2 ? 4 : 0);
      void Reflect.apply(then, original, [this.fulfilled.bind(this, kind, serial), this.rejected.bind(this, kind, serial)]);
    } finally { this.installing--; this.schedule(); }
  }
  private eligible(kind: number, serial: number): boolean {
    return !!(this.pending & kind) && !(this.seen & kind) && (kind !== 1 || serial === this.serial) && (kind !== 16 || serial === this.pullSerial);
  }
  private fulfilled(kind: number, serial: number, value: unknown): void {
    if (!this.eligible(kind, serial)) return;
    this.seen |= kind; this.activeTails++;
    try { if (kind === 1) this.captureDriverValue(value as ReadableStreamReadResult<Uint8Array>); }
    catch (reason) { this.readFailure ??= this.captureDriverFailure(reason); reason = undefined; }
    finally { value = undefined; this.activeTails--; this.schedule(); }
  }
  private rejected(kind: number, serial: number, reason: unknown): void {
    if (!this.eligible(kind, serial)) return;
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
    } finally { reason = undefined; this.activeTails--; this.schedule(); }
  }
  protected observeDriverClosed(native: boolean): void {
    this.pending |= 8; this.installing++;
    if (native) this.native |= 1;
    try { this.closedOriginal = this.reader!.closed; this.observe(8, this.closedOriginal); }
    catch (reason) {
      const failure = this.recordDriverFailure("closed", reason); reason = undefined;
      if (this.closedOriginal) this.uncertain(); else this.seen |= 8;
      throw failure;
    } finally { this.installing--; this.schedule(); }
  }
  protected startDriverRead(byobBytes?: number): Promise<void> {
    if (this.driverFlags & 1 || this.pending & 1 || !this.reader) throw this.driverProtocolFailure();
    this.pending |= 1; this.seen &= ~1; this.serial++; this.readFailure = undefined;
    const ready = new Promise<void>((accept, reject) => { this.readAccept = accept; this.readReject = reject; });
    this.reading = ready; this.installing++;
    try {
      const reader = this.reader, method = reader.read;
      const prototype = byobBytes === undefined ? ReadableStreamDefaultReader.prototype : ReadableStreamBYOBReader.prototype;
      if (this.native & 1 && Object.getPrototypeOf(reader) === prototype && method === (byobBytes === undefined ? driverDefaultRead : driverByobRead)) this.native |= 2; else this.native &= ~2;
      this.originalRead = Reflect.apply(method, reader, byobBytes === undefined ? [] : [new Uint8Array(byobBytes)]);
      this.observe(1, this.originalRead!);
    } catch (reason) {
      this.readFailure = this.recordDriverFailure("read", reason); reason = undefined;
      if (this.originalRead) this.uncertain(); else this.seen |= 1;
    } finally { this.installing--; this.schedule(); }
    return ready;
  }
  protected beginDriverPull(): void {
    // Native stream demand may resume after our pull observer returns but before
    // its queued pump. Consume only that proven tail; keep the queued driver.
    if (!this.installing && !this.activeTails && this.seen & 16) {
      this.seen &= ~16; this.pending &= ~16; this.pullOriginal = undefined;
    }
    if (this.pending & 16) throw this.driverProtocolFailure();
    this.pending |= 16; this.seen &= ~16; this.pullSerial++;
  }
  protected ownDriverPull(original: Promise<void>): Promise<void> {
    this.pullOriginal = original;
    try { this.observe(16, original, this.pullSerial); }
    catch (reason) { this.driverPullFailure(this.recordDriverFailure("pull", reason)); reason = undefined; this.uncertain(); }
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
  private cancelDriver(): void {
    this.pending |= 2; this.installing++;
    try {
      if (this.reader) {
        const reader = this.reader, method = reader.cancel;
        const prototype = Object.getPrototypeOf(reader);
        if (this.native & 1 && (prototype === ReadableStreamDefaultReader.prototype || prototype === ReadableStreamBYOBReader.prototype)
          && method === (prototype === ReadableStreamDefaultReader.prototype ? driverDefaultCancel : driverByobCancel)) this.native |= 4; else this.native &= ~4;
        this.cancelOriginal = Reflect.apply(method, reader, []);
      } else if (!this.body) { this.seen |= 2; return; }
      else if (this.body.locked) { this.uncertain(); return; }
      else this.cancelOriginal = this.body.cancel();
      this.observe(2, this.cancelOriginal!);
    } catch (reason) {
      this.driverCleanupFailure("cancel", this.recordDriverFailure("cancel", reason)); reason = undefined;
      if (this.cancelOriginal) this.uncertain(); else this.seen |= 2;
    } finally { this.installing--; this.schedule(); }
  }
  private unlockDriver(): void {
    if (this.driverFlags & 8) return;
    this.driverFlags |= 8; this.pending |= 4; this.installing++;
    try {
      if (!this.reader) { this.seen |= 4; return; }
      const reader = this.reader, method = reader.releaseLock;
      this.unlockOriginal = Reflect.apply(method, reader, []);
      if (this.unlockOriginal === undefined) this.seen |= 4;
      else this.observe(4, Promise.resolve(this.unlockOriginal));
    } catch (reason) {
      this.driverCleanupFailure("unlock", this.recordDriverFailure("unlock", reason)); reason = undefined;
      if (this.unlockOriginal !== undefined) this.uncertain(); else this.seen |= 4;
    } finally { this.installing--; this.schedule(); }
  }
  private advance(): void {
    this.queued = false;
    if (this.installing || this.activeTails) return;
    const seen = this.seen; this.seen = 0; this.pending &= ~seen;
    if (seen & 1) this.originalRead = undefined;
    if (seen & 2) this.cancelOriginal = undefined;
    if (seen & 4) this.unlockOriginal = undefined;
    if (seen & 8) this.closedOriginal = undefined;
    if (seen & 16) this.pullOriginal = undefined;
    // Logical installation failure is prompt even when the original remains
    // UNKNOWN. A later original still captures/discards under this same owner.
    if (this.readAccept && (seen & 1 || this.readFailure)) {
      const accept = this.readAccept, reject = this.readReject;
      this.readAccept = undefined; this.readReject = undefined; this.reading = undefined;
      if (this.readFailure) reject!(this.readFailure); else accept();
    }
    if (!(this.driverFlags & 1) || this.pending & 3) return;
    if (!(this.driverFlags & 8)) { this.unlockDriver(); return; }
    if (this.pending || this.queued || this.driverFlags & (16 | 32)) return;
    try {
      if (this.body?.locked) { this.uncertain(); return; }
      this.body = undefined; this.reader = undefined; this.captured = undefined; this.nativeFailure = undefined;
      this.originalRead = undefined; this.readFailure = undefined; this.advanceWork = undefined as never;
      this.driverCleared(); this.driverFlags |= 16; this.driverRetired(); this.resolveRetired();
    } catch (reason) { this.recordDriverFailure("retire", reason); reason = undefined; this.uncertain(); }
  }
}
