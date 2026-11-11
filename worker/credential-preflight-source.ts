import { inspectOwnedBytes, isLocalOwnedByteView, isLocalOwnedByteBacking, newOwnedBytes, ownedBytesFromBacking, ownedByteLength, ownedByteSubarray, copyOwnedBytes, newOwnedDecoder, decodeOwnedBytes } from "./proxy-completion.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { privateIdentityNativeThen, privateIdentityNativeClosed, privateIdentityNativeReaderOperation, privateIdentityOrigin, privateIdentityDiagnostic, type PrivateIdentityParent, IdentityWire, isIdentityFailure, addIdentitySources, admitAdmission, admitIdentityBytes, admitIdentityHeaders, identityFailure, identitySourceBudget, identityUtf8, parseIdentity,
  type IdentityProfile, type IdentitySourceBudget } from "./identity-admission.ts";
import { PreflightTicket, transferAdmissionScratch, retireAdmissionScratch } from "./credential-preflight-arena.ts";
import { closeAdmissionEnvelope, closePreflightReply, closePreflightRequest, credentialPreflightHeader, credentialPreflightPath,
  credentialPreflightVersion, type AdmissionContinuationEnvelope, type CredentialPreflightReply, type CredentialPreflightRequest } from "./credential-preflight-protocol.ts";
import type { AdmissionResult } from "./authority-admission.ts";

type Outcome<T> = { failed: false; value?: T } | { failed: true; error: unknown };
type Root<T> = { original?: Promise<T>; outcome?: Promise<Outcome<T>>; result?: Outcome<T> };
function original<T>(start: () => Promise<T>): Root<T> {
  let promise: Promise<T>;
  try { promise = start(); } catch (error) { promise = Promise.reject(error); }
  const root: Root<T> = { original: promise };
  root.outcome = Promise.resolve(promise).then(value => (root.result = { failed: false, value }), error => (root.result = { failed: true, error }));
  return root;
}
function clear<T>(root: Root<T> | undefined): void {
  if (root?.result && !root.result.failed) root.result.value = undefined;
  if (root) { root.original = undefined; root.outcome = undefined; }
}

// One source at a time. The read window is reused only after the original and
// propagated read settle, admission/copy completes, and result aliases clear.
// No read history grows with the 8192-read bound. Generic InputRetirement stays
// unchanged; FIRST cancel and unlock outcomes are independently owned here.
class PreflightSource {
  private ticket: PreflightTicket;
  private body?: ReadableStream<Uint8Array> | null;
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private input?: InputRetirement;
  private byob = false;
  private readRoot?: Root<ReadableStreamReadResult<Uint8Array>>;
  private propagated?: Root<ReadableStreamReadResult<Uint8Array>>;
  private first?: Root<void>;
  private retirement?: Root<void>;
  private terminalStarted = false;
  private ending?: Promise<void>;
  private unlocked = false;
  private unlockFailed = false;
  private unlockError: unknown;
  private listenerFailed = false;
  private listenerError: unknown;
  private abort?: () => void;
  private signal?: AbortSignal;
  private eof = false;
  private hasPrimary = false;
  private primary: unknown;
  private primaryOrigin?: object;
  private decoder?: TextDecoder;
  private backing?: Uint8Array<ArrayBuffer>;
  private text = "";
  private reads = 0;
  private wireBytes = 0;

  constructor(ticket: PreflightTicket) { this.ticket = ticket; }
  own(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): void {
    this.body = body; this.signal = signal;
    if (!body) return;
    try { this.reader = body.getReader({ mode: "byob" }); this.byob = true; }
    catch { try { this.reader = body.getReader(); } catch { /* Unknown owner holds the ticket. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        this.first ??= original(() => this.reader!.cancel("credential preflight stopped"));
        return this.first.original!;
      },
      releaseLock: () => {
        try { this.reader!.releaseLock(); this.unlocked = true; }
        catch (error) { this.unlockFailed = true; this.unlockError = error; this.unlocked = !this.body!.locked; }
      },
    });
    this.abort = () => { this.beginRetirement("cancel"); };
    if (signal?.aborted) this.abort(); else signal?.addEventListener("abort", this.abort, { once: true });
  }
  private beginRetirement(kind: "eof" | "cancel"): void {
    if (this.terminalStarted) return;
    this.ticket.enter("terminal");
    this.terminalStarted = true;
    if (this.input) this.retirement = original(() => this.input!.retire(kind));
  }
  async consume<T>(budget: IdentitySourceBudget, profile: IdentityProfile, close: (value: unknown) => T): Promise<T> {
    let parsed: unknown, result: T | undefined;
    try {
      if (!this.body || !this.byob || !this.input || this.signal?.aborted) throw identityFailure("transport");
      const maximum = profile === "record" ? 1048576 : 2097152;
      this.decoder = new TextDecoder(); this.backing = new Uint8Array(16384);
      for (;;) {
        if (this.signal?.aborted) throw identityFailure("transport");
        if (this.reads++ >= 8192) throw identityFailure("limit");
        this.ticket.enter("read");
        this.propagated = original(() => this.input!.read(() => {
          this.readRoot = original(() => (this.reader as ReadableStreamBYOBReader).read(this.backing!));
          return this.readRoot.original!;
        }));
        const outcome = await this.propagated.outcome!;
        if (outcome.failed) { this.primaryOrigin = this.readRoot ?? this.propagated; throw outcome.error; }
        if (this.signal?.aborted) throw identityFailure("transport");
        let part = outcome.value!;
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384
            || part.value.byteLength > maximum - this.wireBytes) throw identityFailure("limit");
          this.wireBytes += part.value.byteLength;
          admitIdentityBytes(budget, part.value.byteLength, maximum);
          const decoded = this.decoder.decode(part.value, { stream: !part.done });
          if (decoded.length > maximum - this.text.length || decoded.length > 2097152 - budget.text - this.text.length) throw identityFailure("limit");
          this.text += decoded;
          this.backing = new Uint8Array(part.value.buffer);
        } else if (part.done) {
          const decoded = this.decoder.decode();
          if (decoded.length > maximum - this.text.length || decoded.length > 2097152 - budget.text - this.text.length) throw identityFailure("limit");
          this.text += decoded;
        }
        const done = part.done;
        part = undefined as never;
        clear(this.readRoot); clear(this.propagated); this.readRoot = undefined; this.propagated = undefined;
        this.ticket.leave("read");
        if (done) { this.eof = true; break; }
        if (!this.backing.byteLength) throw identityFailure("transport");
      }
      parsed = parseIdentity(this.text, budget, profile, "generic");
      // Full ORIGINAL occurrence/byte admission precedes final closed grammar.
      result = close(parsed);
    } catch (error) { this.hasPrimary = true; this.primary = error; }
    finally { parsed = undefined; }
    return result!;
  }
  fail(error: unknown, origin?: object): void {
    if (this.hasPrimary) return;
    this.hasPrimary = true; this.primary = error; this.primaryOrigin = origin;
  }
  finish(): Promise<void> {
    return this.ending ??= (async () => {
      this.beginRetirement(this.eof ? "eof" : "cancel");
      // Every original is already observed. Serial joins cannot discard siblings.
      await this.readRoot?.outcome;
      await this.propagated?.outcome;
      await this.first?.outcome;
      await this.retirement?.outcome;
      if (this.body && (!this.reader || !this.unlocked || this.body.locked)) {
        this.ticket.holdUnknown();
        await new Promise<never>(() => {});
      }
      try { if (this.abort) this.signal?.removeEventListener("abort", this.abort); }
      catch (error) { this.listenerFailed = true; this.listenerError = error; }
      this.abort = undefined; this.signal = undefined;
      this.body = undefined; this.reader = undefined; this.input = undefined;
      this.decoder = undefined; this.backing = undefined; this.text = "";
      clear(this.readRoot); clear(this.propagated); clear(this.first); clear(this.retirement);
      this.ticket.leave("read"); this.ticket.leave("terminal");
    })();
  }
  report(): void {
    const failures: unknown[] = [];
    // Propagation of the original read is the SAME origin, not a second failure.
    for (const root of [this.readRoot ?? this.propagated, this.first, this.retirement]) {
      if (root && root !== this.primaryOrigin && root.result?.failed) failures.push(root.result.error);
    }
    if (this.unlockFailed) failures.push(this.unlockError);
    if (this.listenerFailed) failures.push(this.listenerError);
    const hasPrimary = this.hasPrimary, primary = this.primary;
    this.primary = undefined; this.primaryOrigin = undefined;
    this.readRoot = undefined; this.propagated = undefined; this.first = undefined; this.retirement = undefined;
    this.unlockError = undefined; this.listenerError = undefined;
    // Failure custody transfers to the operation outcome, without a retained
    // source history. Independent equal/undefined reasons remain separate.
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "credential preflight cleanup failed");
    if (hasPrimary) throw primary;
  }
}

async function consumeOriginal<T>(ticket: PreflightTicket, start: () => Promise<Response | ReadableStream<Uint8Array> | null>,
  budget: IdentitySourceBudget, profile: IdentityProfile, close: (value: unknown, response?: Response) => T, signal?: AbortSignal,
  validate?: () => void): Promise<T | null> {
  ticket.enter("source");
  const owner = new PreflightSource(ticket), acquisition = original(start);
  let response: Response | undefined, body: ReadableStream<Uint8Array> | null | undefined;
  try {
    const outcome = await acquisition.outcome!;
    if (outcome.failed) { owner.fail(outcome.error, acquisition); throw outcome.error; }
    if (outcome.value instanceof Response) { response = outcome.value; body = response.body; }
    else body = outcome.value;
    owner.own(body ?? null, signal); clear(acquisition);
    if (response) admitIdentityHeaders(response.headers);
    validate?.();
    if (body === null) return null;
    return await owner.consume(budget, profile, value => close(value, response));
  } catch (error) { owner.fail(error); throw error; }
  finally {
    await owner.finish();
    response = undefined; body = undefined; clear(acquisition);
    ticket.leave("source");
    owner.report();
  }
}

export async function consumePreflightRequest(request: Request | undefined, ticket: PreflightTicket): Promise<CredentialPreflightRequest> {
  const intake = identitySourceBudget();
  let input = request; request = undefined;
  try {
    const closed = await consumeOriginal(ticket, () => Promise.resolve(input?.body ?? null), intake, "complete", closePreflightRequest, input?.signal, () => {
      if (!input || input.method !== "POST" || new URL(input.url).pathname !== credentialPreflightPath
        || input.headers.get(credentialPreflightHeader) !== credentialPreflightVersion) throw identityFailure("protocol");
      admitIdentityHeaders(input.headers);
    });
    if (!closed) throw identityFailure("protocol");
    // Intake is source consumption too. Producer source counters cannot buy a
    // second complete-profile allowance. Prospective JSON is a separate plan.
    closed.source = addIdentitySources(closed.source, intake);
    return closed;
  } finally { input = undefined; }
}
export function consumePreflightCredential(ticket: PreflightTicket, start: () => Promise<ReadableStream<Uint8Array> | null>, budget: IdentitySourceBudget): Promise<Record<string, unknown> | null> {
  return consumeOriginal(ticket, start, budget, "record", value => value as Record<string, unknown>);
}
export async function consumePreflightReply(ticket: PreflightTicket, start: () => Promise<Response>, budget: IdentitySourceBudget, signal?: AbortSignal): Promise<CredentialPreflightReply> {
  const reply = await consumeOriginal(ticket, start, budget, "complete", (value, response) => {
    if (!response?.ok) {
      const error = (value as { error?: { code?: unknown; message?: unknown } })?.error;
      if (response?.status === 503 && error?.code === "identity_admission_unavailable") {
        for (const kind of ["limit", "protocol", "transport", "cleanup"] as const) {
          if (error.message === `Identity admission failed (${kind})`) throw identityFailure(kind);
        }
      }
      throw identityFailure("transport");
    }
    return closePreflightReply(value);
  }, signal);
  if (!reply) throw identityFailure("protocol");
  return reply;
}

// A new private producer, never a wrapper around a platform response. Header
// publication does not retire its payload: retain until actual EOF pull/cancel.
export function preflightReplyResponse(ticket: PreflightTicket, text: string, status = 200): Response {
  ticket.enter("terminal");
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let sent = false, closed = false;
  const finish = () => {
    if (closed) return;
    closed = true; bytes = undefined;
    ticket.leave("terminal"); ticket.release();
  };
  try {
    bytes = new TextEncoder().encode(text); text = "";
    const body = new ReadableStream({ type: "bytes",
      pull(controller) {
        if (!sent) { sent = true; const chunk = bytes!; bytes = undefined; controller.enqueue(chunk); }
        else { const request = controller.byobRequest; controller.close(); request?.respond(0); finish(); }
      },
      cancel() { finish(); },
    } satisfies UnderlyingByteSource, { highWaterMark: 0 });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  } catch (error) { text = ""; finish(); throw error; }
}

// Bridge-only finite failure custody. The 974 raw-reason API above is unchanged.
// A sanitized follower settles only after its ORIGINAL. No raw rejection enters
// InputRetirement, an async finally, a retained outcome or a failure history.
export function admissionBridgeReplyResponse(ticket: PreflightTicket, text: string, status = 200): Response {
  // Caller has cleared request/current/prior/journal graphs. Fund BOTH caller
  // and producer text occurrences plus the entire prospective encoded backing.
  transferAdmissionScratch(ticket, { C: 0, P: 0, N: 0, U: 2 * text.length, B: identityUtf8(text) });
  ticket.enter("terminal");
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let sent = false, closed = false;
  const finish = () => {
    if (closed) return;
    closed = true; bytes = undefined; text = "";
    retireAdmissionScratch(ticket); ticket.leave("terminal"); ticket.release();
  };
  try {
    bytes = new TextEncoder().encode(text); text = "";
    const body = new ReadableStream({ type: "bytes",
      pull(controller) {
        if (!sent) { sent = true; const chunk = bytes!; bytes = undefined; controller.enqueue(chunk); }
        else { const request = controller.byobRequest; controller.close(); request?.respond(0); finish(); }
      },
      cancel() { finish(); },
    } satisfies UnderlyingByteSource, { highWaterMark: 0 });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  } catch (error) { text = ""; finish(); throw error; }
}

type BridgeCategory = "transport" | "cleanup" | "limit" | "protocol" | "json" | "authority";
type BridgeOutcome<T> = { failed: false; value: T } | { failed: true; undefinedReason: boolean };
export type BridgeFailureMetadata = Readonly<{ primary: boolean; primaryIsUndefined: boolean; origins: number; originOrder: number; category: BridgeCategory }>;
const bridgeFailures = new WeakMap<object, BridgeFailureMetadata>();
export function admissionBridgeFailureMetadata(value: object): BridgeFailureMetadata | undefined { return bridgeFailures.get(value); }
function bridgeOriginal<T>(start: () => Promise<T>): Promise<BridgeOutcome<T>> {
  let original: Promise<T> | undefined;
  try { original = start(); }
  catch (error) { const undefinedReason = error === undefined; error = undefined; start = undefined as never; return Promise.resolve({ failed: true, undefinedReason }); }
  start = undefined as never;
  const follower = Promise.resolve(original).then(value => ({ failed: false as const, value }), error => {
    const undefinedReason = error === undefined; error = undefined;
    return { failed: true as const, undefinedReason };
  });
  original = undefined;
  return follower;
}

class AdmissionBridgeSource {
  private ticket: PreflightTicket;
  body?: ReadableStream<Uint8Array> | null;
  reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private retirement?: InputRetirement;
  private byob = false;
  private ended?: Promise<void>;
  private pending?: Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>;
  private first?: Promise<void>;
  private terminal = false;
  private eof = false;
  private signal?: AbortSignal;
  private abort?: () => void;
  private category: BridgeCategory = "transport";
  private primary = false;
  private primaryIsUndefined = false;
  private origins = 0;
  private originOrder = 0;
  constructor(ticket: PreflightTicket) { this.ticket = ticket; }
  failure(category: BridgeCategory, origin: number, undefinedReason = false): void {
    // A bit names a fixed ORIGINAL origin, not the equality of its reason.
    if (!this.primary) { this.primary = true; this.category = category; this.primaryIsUndefined = undefinedReason; }
    if (!(this.origins & origin)) this.originOrder = this.originOrder * 16 + Math.log2(origin) + 1;
    this.origins |= origin;
    if (category === "cleanup") this.category = "cleanup";
  }
  own(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): void {
    this.body = body; this.signal = signal;
    if (!body) return;
    const owned = privatePreflightReaders?.get(this);
    let acquisition = owned?.origin(0);
    try { this.reader = body.getReader({ mode: "byob" }); this.byob = true; }
    catch (error) {
      if (owned) owned.diagnostic(acquisition!, error);
      this.failure("transport", 256, error === undefined); error = undefined;
      acquisition = owned?.origin(0);
      try { this.reader = body.getReader(); }
      catch (fallback) { if (owned) { owned.diagnostic(acquisition!, fallback); owned.holdUnknown(); } this.failure("transport", 512, fallback === undefined); fallback = undefined; /* UNKNOWN holds all funding. */ }
    }
    if (owned) owned.ownReader(this.reader, body);
    else if (this.reader) this.retirement = inputRetirement({
      cancel: () => this.first ??= bridgeOriginal(() => this.reader!.cancel("private admission stopped")).then(outcome => {
        if (outcome.failed) this.failure("cleanup", 4, outcome.undefinedReason);
      }),
      releaseLock: () => {
        try { this.reader!.releaseLock(); }
        catch (error) { this.failure("cleanup", 8, error === undefined); error = undefined; }
      },
    });
    this.abort = owned ? this.stop.bind(this, "cancel") : () => { this.stop("cancel"); };
    if (signal?.aborted) this.abort();
    else {
      const origin = signal ? owned?.origin(15) : undefined;
      try { signal?.addEventListener("abort", this.abort, { once: true }); }
      catch (error) {
        if (owned && origin !== undefined) owned.diagnostic(origin, error);
        this.failure("transport", 1024, error === undefined); error = undefined; this.stop("cancel");
      }
    }
  }
  private stop(kind: "cancel" | "eof"): void {
    if (this.terminal) return;
    this.terminal = true; this.ticket.enter("terminal");
    const owned = privatePreflightReaders?.get(this);
    this.ended = owned ? owned.finishReader(kind) : this.retirement?.retire(kind);
    // Only sanitized followers reach generic retirement. Observe its own outcome.
    if (this.ended) this.ended = this.ended.then(() => undefined, () => { this.failure("cleanup", 16); });
  }
  async read<T>(budget: IdentitySourceBudget, profile: IdentityProfile, envelope: import("./access-json.ts").IdentityEnvelope,
    close: (value: unknown) => T): Promise<T | undefined> {
    const owned = privatePreflightReaders?.get(this);
    let text = "", parsed: unknown, result: T | undefined, backing: Uint8Array<ArrayBuffer> | undefined;
    let decoder: TextDecoder | undefined, wire: IdentityWire | undefined;
    try {
      if (this.signal?.aborted) { this.failure("transport", 128); throw identityFailure("transport"); }
      if (!this.body || !this.byob || !(owned || this.retirement)) throw identityFailure("transport");
      const maximum = profile === "record" ? 1048576 : 2097152;
      let reads = 0, bytes = 0;
      backing = owned ? newOwnedBytes(16384) : new Uint8Array(16384); decoder = owned ? newOwnedDecoder() : new TextDecoder(); wire = new IdentityWire();
      for (;;) {
        if (this.signal?.aborted) { this.failure("transport", 128); throw identityFailure("transport"); }
        if (reads++ >= 8192) throw identityFailure("limit");
        this.ticket.enter("read");
        if (owned) await owned.read(backing!);
        else {
        this.pending = this.retirement!.read(() => bridgeOriginal(() => (this.reader as ReadableStreamBYOBReader).read(backing!)).then(outcome => {
          if (outcome.failed) { this.failure("transport", 2, outcome.undefinedReason); throw identityFailure("transport"); }
          return outcome.value;
        }));
        // Immediate rejection observer; no raw or fulfilled graph history.
        void this.pending!.then(() => undefined, () => undefined);
        }
        let part = owned ? undefined : await this.pending!;
        if (this.signal?.aborted) { part = undefined as never; this.failure("transport", 128); throw identityFailure("transport"); }
        if ((owned ? owned.value : part!.value)) {
          if (owned ? ownedByteLength(owned.value!) > maximum - bytes
            : !(part!.value!.buffer instanceof ArrayBuffer) || part!.value!.buffer.byteLength > 16384 || part!.value!.byteLength > maximum - bytes) throw identityFailure("limit");
          bytes += owned ? ownedByteLength(owned.value!) : part!.value!.byteLength;
          admitIdentityBytes(budget, owned ? ownedByteLength(owned.value!) : part!.value!.byteLength, maximum);
          if (owned) wire.addPrivate(owned.value!); else wire.add(part!.value!);
          const decoded = owned ? decodeOwnedBytes(decoder, owned.value!, !owned.done) : decoder.decode(part!.value!, { stream: !part!.done });
          if (decoded.length > maximum - text.length || decoded.length > 2097152 - budget.text - text.length) throw identityFailure("limit");
          text += decoded; backing = owned ? owned.returnedBacking! : new Uint8Array(part!.value!.buffer);
        } else if ((owned ? owned.done : part!.done)) {
          const decoded = owned ? decodeOwnedBytes(decoder) : decoder.decode();
          if (decoded.length > maximum - text.length || decoded.length > 2097152 - budget.text - text.length) throw identityFailure("limit");
          text += decoded;
        }
        const done = (owned ? owned.done : part!.done); part = undefined as never; this.pending = undefined; if (owned) owned.clearRead();
        this.ticket.leave("read");
        if (done) { this.eof = true; break; }
        if (!(owned ? ownedByteLength(backing!) : backing!.byteLength)) throw identityFailure("transport");
      }
      parsed = parseIdentity(text, budget, profile, envelope, wire.span);
      if (owned) owned.acceptParsed(parsed); else result = close(parsed);
    } catch (error) {
      if (!this.primary) this.failure(bridgeCategory(error), 32, error === undefined);
      error = undefined;
    } finally {
      parsed = undefined; text = ""; backing = undefined; decoder = undefined; wire?.clear(); wire = undefined; close = undefined as never;
    }
    return result;
  }
  async finish(): Promise<void> {
    this.stop(this.eof ? "eof" : "cancel");
    try { await this.pending; } catch { /* already classified ORIGINAL read */ }
    await this.first; await this.ended;
    if (this.body && (!this.reader || this.body.locked)) { this.ticket.holdUnknown(); await new Promise<never>(() => {}); }
    const owned = privatePreflightReaders?.get(this);
    const origin = this.abort && this.signal ? owned?.origin(16) : undefined;
    try { if (this.abort) this.signal?.removeEventListener("abort", this.abort); }
    catch (error) {
      this.failure("cleanup", 64, error === undefined);
      if (owned) {
        owned.holdUnknown();
        if (origin !== undefined) owned.diagnostic(origin, error);
        error = undefined; throw identityFailure("cleanup");
      }
      error = undefined;
    }
    this.body = undefined; this.reader = undefined; this.retirement = undefined; this.signal = undefined; this.abort = undefined;
    this.pending = undefined; this.first = undefined; this.ended = undefined;
    this.ticket.leave("read"); this.ticket.leave("terminal");
  }
  report(): void {
    if (!this.primary) return;
    const error = this.category === "json" ? new SyntaxError("invalid private admission JSON")
      : this.category === "authority" ? new Error("Authority identity query failed") : identityFailure(this.category);
    bridgeFailures.set(error, Object.freeze({ primary: true, primaryIsUndefined: this.primaryIsUndefined, origins: this.origins, originOrder: this.originOrder, category: this.category }));
    throw error;
  }
}
function bridgeCategory(error: unknown): BridgeCategory {
  if (isIdentityFailure(error)) {
    if (error.message === "Identity admission failed (limit)") return "limit";
    if (error.message === "Identity admission failed (cleanup)") return "cleanup";
    if (error.message === "Identity admission failed (protocol)") return "protocol";
    return "transport";
  }
  return error instanceof SyntaxError ? "json" : "authority";
}
export async function consumeAdmissionBridge<T>(ticket: PreflightTicket,
  start: () => Promise<Response | ReadableStream<Uint8Array> | null>, budget: IdentitySourceBudget,
  profile: IdentityProfile, close: (value: unknown, response?: Response) => T,
  signal?: AbortSignal, validate?: () => void, envelope: import("./access-json.ts").IdentityEnvelope = "generic"): Promise<T | null> {
  ticket.enter("source");
  const owner = new AdmissionBridgeSource(ticket);
  let response: Response | undefined, body: ReadableStream<Uint8Array> | null | undefined, result: T | null | undefined;
  let acquisition: Promise<BridgeOutcome<Response | ReadableStream<Uint8Array> | null>> | undefined = bridgeOriginal(start);
  start = undefined as never;
  try {
    let outcome = await acquisition; acquisition = undefined;
    if (outcome.failed) { owner.failure("transport", 1, outcome.undefinedReason); outcome = undefined as never; }
    else {
      if (outcome.value instanceof Response) { response = outcome.value; body = response.body; } else body = outcome.value;
      outcome = undefined as never; owner.own(body ?? null, signal);
      if (response) admitIdentityHeaders(response.headers);
      validate?.();
      result = body === null ? null : await owner.read(budget, profile, envelope, value => close(value, response));
    }
  } catch (error) { owner.failure(bridgeCategory(error), 32, error === undefined); error = undefined; }
  // No raw catch value or original-settled acquisition promise crosses this wait.
  await owner.finish();
  if (signal?.aborted) owner.failure("transport", 128);
  response = undefined; body = undefined; acquisition = undefined; close = undefined as never; validate = undefined; signal = undefined;
  ticket.leave("source"); owner.report();
  return result!;
}

// Only the registered compiled HTTP preflight path creates these receipts.
// The ordinary bridge and its general callback API retain their original path.
export interface PrivatePreflightReceipt { readonly preflight?: never }
export interface PrivateContinuationReceipt { readonly continuation?: never }
export interface PrivateContinuationDestination {
  continuationReply?: AdmissionContinuationEnvelope<AdmissionResult>;
  continuationSource?: IdentitySourceBudget;
}
let privatePreflights: WeakMap<PrivatePreflightReceipt | PrivateContinuationReceipt, PrivatePreflightState> | undefined;
let privatePreflightReaders: WeakMap<AdmissionBridgeSource, PrivatePreflightState> | undefined;
const privatePreflightQueue = queueMicrotask;
interface PreflightReadObservation { owner: PrivatePreflightState | undefined; nonce: Promise<void> | undefined; state: number }
function preflightReadFulfilled(this: PreflightReadObservation, value: unknown): void {
  if (this.state & (1 | 8)) { value = undefined; return; }
  try { this.owner?.dispatchRead(this, false, value); } finally { value = undefined; }
}
function preflightReadRejected(this: PreflightReadObservation, reason: unknown): void {
  if (this.state & (1 | 8)) { reason = undefined; return; }
  try { this.owner?.dispatchRead(this, true, reason); } finally { reason = undefined; }
}
interface PreflightVoidObservation { owner: PrivatePreflightState | undefined; kind: 2 | 4 | 8; state: number }
function preflightVoidFulfilled(this: PreflightVoidObservation): void {
  if (!this.owner || this.state & (1 | 8)) return;
  this.state |= 1 | 16;
  try { this.owner.dispatchVoid(this, false, undefined); } finally { this.state &= ~16; }
}
function preflightVoidRejected(this: PreflightVoidObservation, reason: unknown): void {
  if (!this.owner || this.state & (1 | 8)) { reason = undefined; return; }
  this.state |= 1 | 16;
  try { this.owner.dispatchVoid(this, true, reason); } finally { reason = undefined; this.state &= ~16; }
}
class PrivatePreflightState {
  source: AdmissionBridgeSource;
  response?: Response;
  result?: CredentialPreflightReply | AdmissionContinuationEnvelope<AdmissionResult>;
  private flags = 1;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>(resolve => { this.resolveReady = resolve; });
  private resolveRetired!: () => void;
  readonly retired = new Promise<void>(resolve => { this.resolveRetired = resolve; });
  private native = 0;
  private nativeOrigin = 0;
  private pending = 0;
  private seen = 0;
  private installing = 0;
  private closedObservation?: PreflightVoidObservation;
  private cancelObservation?: PreflightVoidObservation;
  private unlockObservation?: PreflightVoidObservation;
  private readReady?: Promise<void>;
  private readObservation?: PreflightReadObservation;
  private resolveRead?: () => void;
  private first?: Promise<void>;
  private resolveCancel?: () => void;
  private unlocking?: Promise<void>;
  private resolveUnlock?: () => void;
  private closed?: Promise<void>;
  private resolveClosed?: () => void;
  private ending?: Promise<void>;
  private capture?: Uint8Array<ArrayBuffer>;
  private readFailure?: "limit" | "protocol" | "transport" | "cleanup";
  private readOrigin = 0;
  private cancelOrigin = 0;
  private unlockOrigin = 0;
  private closedOrigin = 0;
  value?: Uint8Array<ArrayBuffer>;
  returnedBacking?: Uint8Array<ArrayBuffer>;
  done = false;
  declare public ticket: PreflightTicket;
  declare public parent: PrivateIdentityParent;
  declare public permit: object;
  declare public budget: IdentitySourceBudget;
  declare public signal?: AbortSignal;
  declare readonly kind: "preflight" | "continuation";
  declare private destination?: PrivateContinuationDestination;
  constructor(ticket: PreflightTicket, parent: PrivateIdentityParent, permit: object,
    budget: IdentitySourceBudget, signal?: AbortSignal,
    kind: "preflight" | "continuation" = "preflight", destination?: PrivateContinuationDestination) {
    this.ticket = ticket; this.parent = parent; this.permit = permit; this.budget = budget; this.signal = signal; this.kind = kind; this.destination = destination;
    this.source = new AdmissionBridgeSource(ticket);
  }
  holdUnknown(): void { this.flags |= 8; this.parent.unknown = true; this.ticket.holdUnknown(); }
  origin(kind: 0 | 3 | 4 | 5 | 6 | 12 | 15 | 16): number { return privateIdentityOrigin(this.parent, kind); }
  diagnostic(origin: number, reason: unknown, primary = true): void {
    try { privateIdentityDiagnostic(this.parent, origin, reason === undefined, primary); }
    catch { this.holdUnknown(); }
    finally { reason = undefined; }
  }
  dispatchVoid(cell: PreflightVoidObservation, failed: boolean, reason: unknown): void {
    if (this.flags & 64 || (cell.kind === 8 ? this.closedObservation : cell.kind === 2 ? this.cancelObservation : this.unlockObservation) !== cell) { reason = undefined; return; }
    try { if (failed) this.rejected(cell.kind, reason); else this.observed(cell.kind); }
    finally { reason = undefined; }
  }
  private observeVoid(kind: 2 | 4 | 8, original: unknown, then: unknown): void {
    let cell: PreflightVoidObservation | undefined = { owner: this, kind, state: 0 };
    if (kind === 8) this.closedObservation = cell;
    else if (kind === 2) this.cancelObservation = cell;
    else this.unlockObservation = cell;
    try {
      void Reflect.apply(then as Function, original, [preflightVoidFulfilled.bind(cell), preflightVoidRejected.bind(cell)]);
      cell.state |= 2;
    } catch (reason) { cell.state |= 4; throw reason; }
    finally { cell = undefined; original = undefined; then = undefined; }
  }
  private severVoid(cell: PreflightVoidObservation | undefined): boolean {
    if (!cell) return true;
    if (cell.state !== 3) return false;
    cell.state = 8; cell.owner = undefined;
    return true;
  }
  private installedFailure(reason: unknown): void {
    this.holdUnknown();
    try { this.diagnostic(this.origin(12), reason); } catch { this.holdUnknown(); }
    finally { reason = undefined; }
  }
  ownReader(reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array> | undefined, body: ReadableStream<Uint8Array>): void {
    if (reader !== this.source.reader || body !== this.source.body) throw identityFailure("protocol");
    if (!reader) { this.holdUnknown(); return; }
    this.pending |= 8; this.closedOrigin = this.origin(4);
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
    this.installing++;
    let original: Promise<void> | undefined, started = false;
    try {
      if (privateIdentityNativeClosed(reader)) this.native |= 1;
      original = reader.closed; started = !!original;
      const then = original.then; if (then !== privateIdentityNativeThen) this.native &= ~1;
      this.observeVoid(8, original, then);
    }
    catch (error) { if (started) this.installedFailure(error); else { this.diagnostic(this.closedOrigin, error); this.flags |= 128; this.observed(8); } }
    finally { original = undefined; this.installing--; this.schedule(); }
  }
  private observed(kind: number): void {
    if (!(this.pending & kind) || this.seen & kind) return;
    this.seen |= kind; this.schedule();
  }
  private rejected(kind: number, reason: unknown): void {
    if (!(this.pending & kind) || this.seen & kind || this.flags & 64) { reason = undefined; return; }
    this.seen |= kind;
    try {
      if (kind === 8) {
        this.native |= 8;
        if (!(this.native & 1 && this.nativeOrigin)) {
          this.diagnostic(this.closedOrigin, reason, false);
          if (this.native & 1) this.nativeOrigin = this.closedOrigin;
        }
      } else if (!(kind === 2 && this.native & 4 && this.native & 8 && this.nativeOrigin)) {
        this.diagnostic(kind === 2 ? this.cancelOrigin : this.unlockOrigin, reason);
        this.flags |= 128;
      }
    } catch { this.holdUnknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  async read(backing: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.flags & 128) throw identityFailure("cleanup");
    if (this.pending & 1 || this.readObservation || this.flags & 256) throw identityFailure("transport");
    if (!this.capture) this.capture = newOwnedBytes(16384);
    this.pending |= 1; this.seen &= ~1; this.readFailure = undefined;
    this.readReady = new Promise<void>(resolve => { this.resolveRead = resolve; });
    const nonce = this.readReady;
    this.readOrigin ||= this.origin(3); this.installing++;
    let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined, started = false;
    let observation: PreflightReadObservation | undefined;
    try {
      const reader = this.source.reader as ReadableStreamBYOBReader, method = reader.read;
      if (this.native & 1 && privateIdentityNativeReaderOperation(reader, method, "read")) this.native |= 2; else this.native &= ~2;
      original = Reflect.apply(method, reader, [backing]); started = !!original;
      const then = original!.then; if (then !== privateIdentityNativeThen) this.native &= ~2;
      observation = { owner: this, nonce, state: 0 }; this.readObservation = observation;
      void Reflect.apply(then, original, [preflightReadFulfilled.bind(observation), preflightReadRejected.bind(observation)]);
      observation.state |= 2;
    } catch (error) {
      if (observation) observation.state |= 4;
      this.readFailure = "transport";
      if (started) this.installedFailure(error);
      else { this.diagnostic(this.readOrigin, error); this.observed(1); }
    } finally { observation = undefined; original = undefined; backing = undefined as never; this.installing--; this.schedule(); }
    await nonce;
    if (this.readFailure) throw identityFailure(this.readFailure);
    if (this.signal?.aborted) throw identityFailure("transport");
  }
  dispatchRead(cell: PreflightReadObservation, failed: boolean, value: unknown): void {
    if (cell.owner !== this || cell.state & (1 | 8) || cell.nonce !== this.readReady
      || !(this.pending & 1) || this.seen & 1 || this.flags & 64) { value = undefined; return; }
    cell.state |= 1;
    try {
      if (failed) this.readRejected(cell.nonce!, value);
      else this.readAccepted(cell.nonce!, value as ReadableStreamReadResult<Uint8Array>);
    } catch { this.holdUnknown(); }
    finally { value = undefined; }
  }
  private readAccepted(nonce: Promise<void>, part: ReadableStreamReadResult<Uint8Array>): void {
    if (this.readReady !== nonce || !(this.pending & 1) || this.seen & 1 || this.flags & 64) { part = undefined as never; return; }
    this.seen |= 1;
    try {
      let value = part.value;
      if (value) {
        let proof: ReturnType<typeof inspectOwnedBytes> | undefined;
        try { if (isLocalOwnedByteView(value)) proof = inspectOwnedBytes(value); } catch { /* The invalid branch still observes DONE. */ }
        if (!proof || !isLocalOwnedByteBacking(proof.buffer) || proof.backing > 16384) this.readFailure = "limit";
        else {
          copyOwnedBytes(this.capture!, value); this.value = ownedByteSubarray(this.capture!, 0, proof.length);
          this.returnedBacking = ownedBytesFromBacking(proof.buffer);
        }
      } else this.value = undefined;
      value = undefined; this.done = !!part.done;
    } catch (error) { this.readFailure = "transport"; this.diagnostic(this.readOrigin, error); error = undefined; }
    finally { part = undefined as never; this.schedule(); }
  }
  private readRejected(nonce: Promise<void>, reason: unknown): void {
    if (this.readReady !== nonce || !(this.pending & 1) || this.seen & 1 || this.flags & 64) { reason = undefined; return; }
    this.seen |= 1;
    this.readFailure = "transport";
    try {
      if (this.native & 2 && this.nativeOrigin) {
        const ordinal = Math.floor(this.nativeOrigin / 32), prior = this.parent.sinkOrigins!.get(ordinal);
        if (typeof prior === "number") this.parent.sinkOrigins!.set(ordinal, prior | 32);
      } else {
        this.diagnostic(this.readOrigin, reason);
        if (this.native & 2) this.nativeOrigin = this.readOrigin;
      }
    } finally { reason = undefined; this.schedule(); }
  }
  clearRead(): void {
    this.value = undefined; this.returnedBacking = undefined;
    let cell = this.readObservation;
    if (cell && !this.installing && !(this.pending & 1) && !(this.flags & 8) && (cell.state & 7) === 3) {
      cell.state = 8; cell.owner = undefined; cell.nonce = undefined; this.readObservation = undefined;
    }
    cell = undefined;
    if (!(this.pending & 1)) { this.readReady = undefined; this.resolveRead = undefined; }
  }
  private cancel(): void {
    if (this.first || !this.source.reader) return;
    this.pending |= 2; this.cancelOrigin = this.origin(5);
    this.first = new Promise<void>(resolve => { this.resolveCancel = resolve; });
    this.installing++;
    let original: Promise<void> | undefined, started = false;
    try {
      const reader = this.source.reader, method = reader.cancel;
      if (this.native & 1 && privateIdentityNativeReaderOperation(reader, method, "cancel")) this.native |= 4; else this.native &= ~4;
      original = Reflect.apply(method, reader, ["private admission stopped"]); started = !!original;
      const then = original!.then; if (then !== privateIdentityNativeThen) this.native &= ~4;
      this.observeVoid(2, original, then);
    }
    catch (error) { if (started) this.installedFailure(error); else this.rejected(2, error); }
    finally { original = undefined; this.installing--; this.schedule(); }
  }
  private unlock(): void {
    if (this.unlocking || !this.source.reader) return;
    this.pending |= 4; this.unlockOrigin = this.origin(6);
    this.unlocking = new Promise<void>(resolve => { this.resolveUnlock = resolve; });
    this.installing++;
    let original: unknown, then: unknown, started = false;
    try {
      original = this.source.reader.releaseLock(); started = original !== undefined;
      if (!started) this.observed(4);
      else {
        if (original !== null && (typeof original === "object" || typeof original === "function"))
          then = (original as { then?: unknown }).then;
        if (typeof then !== "function") { original = Promise.resolve(); then = privateIdentityNativeThen; }
        this.observeVoid(4, original, then);
      }
    } catch (error) { if (started) this.installedFailure(error); else this.rejected(4, error); }
    finally { original = undefined; then = undefined; this.installing--; this.schedule(); }
  }
  finishReader(kind: "eof" | "cancel"): Promise<void> {
    if (this.ending) return this.ending;
    this.flags |= 256;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.ending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void this.ending.then(privatePreflightIgnore, privatePreflightIgnore);
    if (kind === "cancel") this.cancel();
    void this.finishReaderWork().then(resolve, reject);
    return this.ending;
  }
  private async finishReaderWork(): Promise<void> {
    await this.readReady; await this.first;
    this.unlock(); await this.unlocking; await this.closed;
    if (this.flags & 8 || this.source.body && (!this.source.reader || this.source.body.locked)) {
      this.holdUnknown(); await new Promise<never>(() => {});
    }
    if (!this.severVoid(this.closedObservation) || !this.severVoid(this.cancelObservation) || !this.severVoid(this.unlockObservation)) {
      this.holdUnknown(); await new Promise<never>(() => {});
    }
    this.closedObservation = undefined; this.cancelObservation = undefined; this.unlockObservation = undefined;
    this.source.reader = undefined; this.source.body = undefined;
    this.clearRead(); this.capture = undefined; this.first = undefined; this.closed = undefined; this.unlocking = undefined;
    if (this.flags & 128) throw identityFailure("cleanup");
  }

  adopt(response: Response): void {
    if (!(this.flags & 1024) || this.flags & (2 | 64)) { response = undefined as never; return; }
    this.flags |= 2;
    try { if (!(response instanceof Response)) { this.flags |= 4; this.holdUnknown(); } else this.response = response; }
    catch { this.flags |= 4; this.holdUnknown(); }
    finally { response = undefined as never; this.schedule(); }
  }
  failed(undefinedReason: boolean): void {
    if (!(this.flags & 1024) || this.flags & (2 | 64)) return;
    this.flags |= 2 | 4; this.source.failure("transport", 1, undefinedReason); this.schedule();
  }
  beginAcquisition(): void {
    if (this.flags !== 1) throw identityFailure("protocol");
    this.flags |= 1024;
  }
  abandonUnstarted(): void {
    if (this.flags !== 1) throw identityFailure("protocol");
    this.flags = 64;
    this.resolveReady(); this.resolveReady = undefined as never;
    this.resolveRetired(); this.resolveRetired = undefined as never;
  }
  installed(uncertain: boolean): void {
    if (!(this.flags & 1024) || this.flags & 64) throw identityFailure("protocol");
    if (uncertain) this.holdUnknown(); this.flags &= ~1; this.schedule();
  }
  private schedule(): void {
    if (this.flags & (16 | 64)) return;
    this.flags |= 16;
    try { privatePreflightQueue(this.advance.bind(this)); } catch { this.holdUnknown(); }
  }
  private advance(): void {
    this.flags &= ~16;
    if (this.installing) return;
    if (this.pending & this.seen & 1) { this.pending &= ~1; this.resolveRead?.(); this.resolveRead = undefined; }
    if (this.pending & this.seen & 2) { this.pending &= ~2; this.resolveCancel?.(); this.resolveCancel = undefined; }
    if (this.pending & this.seen & 4) { this.pending &= ~4; this.resolveUnlock?.(); this.resolveUnlock = undefined; }
    if (this.pending & this.seen & 8) { this.pending &= ~8; this.resolveClosed?.(); this.resolveClosed = undefined; }
    if (this.flags & (1 | 512) || !(this.flags & 2)) return;
    if (this.flags & 8) {
      if (this.response) {
        this.flags |= 512;
        try { this.source.own(this.response.body, this.signal); } catch { this.holdUnknown(); }
        this.response = undefined;
        void this.source.finish().then(privatePreflightIgnore, privatePreflightIgnore);
      }
      return;
    }
    this.flags |= 512; this.resolveReady(); this.resolveReady = undefined as never;
  }
  acceptParsed(value: unknown): void {
    if (!this.response?.ok) {
      const error = (value as { error?: { code?: unknown; message?: unknown } })?.error;
      if (this.response?.status === 503 && error?.code === "identity_admission_unavailable") {
        for (const kind of ["limit", "protocol", "transport", "cleanup"] as const)
          if (error.message === `Identity admission failed (${kind})`) throw identityFailure(kind);
        if (this.kind === "continuation") throw identityFailure("protocol");
      }
      if (this.kind === "continuation") throw new Error("Authority identity query failed");
      throw identityFailure("transport");
    }
    if (this.kind === "continuation") {
      const closed = closeAdmissionEnvelope<AdmissionResult>(value);
      admitAdmission(closed.admission);
      this.result = closed;
    } else this.result = closePreflightReply(value);
  }
  beginConsumption(): void {
    if (this.flags & 32) throw identityFailure("protocol");
    this.flags |= 32;
  }
  clearAliases(): void {
    this.source = undefined as never; this.parent = undefined as never; this.permit = undefined as never;
    this.budget = undefined as never; this.signal = undefined; this.ending = undefined;
    this.result = undefined; this.destination = undefined; this.ticket = undefined as never;
  }
  async consume(): Promise<void> {
    try {
      await this.ready;
      if (!(this.flags & 4) && this.response) {
        this.source.own(this.response.body, this.signal);
        admitIdentityHeaders(this.response.headers);
        if (this.kind !== "continuation" || this.source.body !== null)
          await this.source.read(this.budget, "complete", this.kind === "continuation" ? "continuation" : "generic", undefined as never);
      }
    } catch (error) { this.source.failure(bridgeCategory(error), 32, error === undefined); error = undefined; }
    finally {
      try { await this.source.finish(); }
      finally {
        this.response = undefined;
        if (!(this.flags & 8)) { this.flags |= 64; this.resolveRetired(); this.resolveRetired = undefined as never; }
      }
    }
    if (this.signal?.aborted) this.source.failure("transport", 128);
    this.source.report();
    if (this.kind === "continuation") {
      // Parsing/admission precede cleanup; only this closed handoff follows the
      // physical receipt and its report. No fulfilled graph Promise is created.
      this.destination!.continuationReply = this.result as AdmissionContinuationEnvelope<AdmissionResult> | undefined;
      this.destination!.continuationSource = this.budget;
      this.result = undefined;
    } else if (!this.result) throw identityFailure("protocol");
  }
}
function privatePreflightIgnore(): void {}
function privatePreflight(cap: PrivatePreflightReceipt, permit: object): PrivatePreflightState {
  const state = privatePreflights?.get(cap);
  if (!state || state.kind !== "preflight" || state.permit !== permit) throw identityFailure("protocol");
  return state;
}
export function createPrivatePreflightReceipt(ticket: PreflightTicket, parent: PrivateIdentityParent, permit: object,
  budget: IdentitySourceBudget, signal?: AbortSignal): PrivatePreflightReceipt {
  ticket.enter("source");
  try {
    const cap = Object.freeze({}), state = new PrivatePreflightState(ticket, parent, permit, budget, signal);
    (privatePreflights ??= new WeakMap()).set(cap, state);
    (privatePreflightReaders ??= new WeakMap()).set(state.source, state);
    return cap;
  } catch (error) { ticket.leave("source"); throw error; }
}
export function adoptPrivatePreflightResponse(cap: PrivatePreflightReceipt, permit: object, response: Response): void { privatePreflight(cap, permit).adopt(response); }
export function beginPrivatePreflightAcquisition(cap: PrivatePreflightReceipt, permit: object): void { privatePreflight(cap, permit).beginAcquisition(); }
export function abandonPrivatePreflightReceipt(cap: PrivatePreflightReceipt, permit: object): void {
  const state = privatePreflight(cap, permit);
  state.abandonUnstarted(); state.ticket.leave("source");
  privatePreflightReaders!.delete(state.source); privatePreflights!.delete(cap); state.clearAliases();
}
export function failPrivatePreflightAcquisition(cap: PrivatePreflightReceipt, permit: object, undefinedReason: boolean): void { privatePreflight(cap, permit).failed(undefinedReason); }
export function completePrivatePreflightInstallation(cap: PrivatePreflightReceipt, permit: object, uncertain: boolean): void { privatePreflight(cap, permit).installed(uncertain); }
export function consumePrivatePreflightReceipt(cap: PrivatePreflightReceipt, permit: object): Promise<CredentialPreflightReply> {
  const state = privatePreflight(cap, permit);
  state.beginConsumption();
  return finishConsumePrivatePreflightReceipt(cap, state);
}
async function finishConsumePrivatePreflightReceipt(cap: PrivatePreflightReceipt, state: PrivatePreflightState): Promise<CredentialPreflightReply> {
  try { await state.consume(); return state.result as CredentialPreflightReply; }
  finally {
    await state.retired;
    state.ticket.leave("source");
    privatePreflightReaders!.delete(state.source); privatePreflights!.delete(cap); state.clearAliases();
  }
}

function privateContinuation(cap: PrivateContinuationReceipt, permit: object): PrivatePreflightState {
  const state = privatePreflights?.get(cap);
  if (!state || state.kind !== "continuation" || state.permit !== permit) throw identityFailure("protocol");
  return state;
}
export function createPrivateContinuationReceipt(ticket: PreflightTicket, parent: PrivateIdentityParent, permit: object,
  destination: PrivateContinuationDestination, budget: IdentitySourceBudget, signal?: AbortSignal): PrivateContinuationReceipt {
  ticket.enter("source");
  try {
    const cap = Object.freeze({}), state = new PrivatePreflightState(ticket, parent, permit, budget, signal, "continuation", destination);
    (privatePreflights ??= new WeakMap()).set(cap, state);
    (privatePreflightReaders ??= new WeakMap()).set(state.source, state);
    return cap;
  } catch (error) { ticket.leave("source"); throw error; }
}
export function adoptPrivateContinuationResponse(cap: PrivateContinuationReceipt, permit: object, response: Response): void { privateContinuation(cap, permit).adopt(response); }
export function beginPrivateContinuationAcquisition(cap: PrivateContinuationReceipt, permit: object): void { privateContinuation(cap, permit).beginAcquisition(); }
export function failPrivateContinuationAcquisition(cap: PrivateContinuationReceipt, permit: object, undefinedReason: boolean): void { privateContinuation(cap, permit).failed(undefinedReason); }
export function completePrivateContinuationInstallation(cap: PrivateContinuationReceipt, permit: object, uncertain: boolean): void { privateContinuation(cap, permit).installed(uncertain); }
export function abandonPrivateContinuationReceipt(cap: PrivateContinuationReceipt, permit: object): void {
  const state = privateContinuation(cap, permit);
  state.abandonUnstarted(); state.ticket.leave("source");
  privatePreflightReaders!.delete(state.source); privatePreflights!.delete(cap); state.clearAliases();
}
export function consumePrivateContinuationReceipt(cap: PrivateContinuationReceipt, permit: object): Promise<void> {
  const state = privateContinuation(cap, permit);
  state.beginConsumption();
  return finishConsumePrivateContinuationReceipt(cap, state);
}
async function finishConsumePrivateContinuationReceipt(cap: PrivateContinuationReceipt, state: PrivatePreflightState): Promise<void> {
  try { await state.consume(); }
  finally {
    await state.retired;
    state.ticket.leave("source");
    privatePreflightReaders!.delete(state.source); privatePreflights!.delete(cap); state.clearAliases();
  }
}
