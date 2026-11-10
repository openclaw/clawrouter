import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { addIdentitySources, admitIdentityBytes, admitIdentityHeaders, identityFailure, identitySourceBudget, parseIdentity,
  type IdentityProfile, type IdentitySourceBudget } from "./identity-admission.ts";
import { PreflightTicket } from "./credential-preflight-arena.ts";
import { closePreflightReply, closePreflightRequest, credentialPreflightHeader, credentialPreflightPath,
  credentialPreflightVersion, type CredentialPreflightReply, type CredentialPreflightRequest } from "./credential-preflight-protocol.ts";

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

  constructor(private ticket: PreflightTicket) {}
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
  let bytes: Uint8Array | undefined;
  let sent = false, closed = false;
  const finish = () => {
    if (closed) return;
    closed = true; bytes = undefined;
    ticket.leave("terminal"); ticket.release();
  };
  try {
    bytes = new TextEncoder().encode(text); text = "";
    const body = new ReadableStream<Uint8Array>({ type: "bytes",
      pull(controller) {
        if (!sent) { sent = true; const chunk = bytes!; bytes = undefined; controller.enqueue(chunk); }
        else { const request = controller.byobRequest; controller.close(); request?.respond(0); finish(); }
      },
      cancel() { finish(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  } catch (error) { text = ""; finish(); throw error; }
}
