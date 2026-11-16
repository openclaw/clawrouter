import { authorityUserJsonLimits, isAccessDenial, parseAccessJson } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";

type Failure = "aborted" | "transport" | "status" | "limit" | "protocol" | "cleanup";
const failure = (reason: Failure): Error => Object.assign(new Error("Authority user query unavailable"), {
  code: "authority_user_query_failed", reason,
});

function wait<T>(actual: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(failure("aborted")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    actual.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(failure("aborted")); else resolve(value);
    }, () => {
      signal.removeEventListener("abort", abort);
      reject(failure(signal.aborted ? "aborted" : "transport"));
    });
  });
}

class UserResponse {
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private input?: InputRetirement;
  private firstCancel?: Promise<void>;
  private ending?: Promise<void>;
  private cleanupFailed = false;
  private byob = false;
  private readonly response: Response;

  constructor(response: Response) {
    this.response = response;
    if (!response.body) return;
    try { this.reader = response.body.getReader({ mode: "byob" }); this.byob = true; }
    catch { try { this.reader = response.body.getReader(); } catch { /* Unknown ownership stays held. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        if (!this.firstCancel) {
          let settle!: () => void;
          this.firstCancel = new Promise<void>(resolve => { settle = resolve; });
          try { Promise.resolve(this.reader!.cancel("authority user query stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
          catch { this.cleanupFailed = true; settle(); }
        }
        return this.firstCancel;
      },
      releaseLock: () => { try { this.reader!.releaseLock(); } catch { this.cleanupFailed = true; } },
    });
  }

  retire(kind: "eof" | "cancel"): Promise<void> {
    if (this.ending) return this.ending;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.ending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void this.ending.catch(() => undefined);
    void (async () => {
      if (this.input) await this.input.retire(kind);
      // inputRetirement observes cancellation settlement, not cleanup success.
      // Failed/unknown unlock cannot release the response owner or facade.
      if (this.response.body && (!this.reader || this.response.body.locked)) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.firstCancel = undefined;
      if (this.cleanupFailed) throw failure("cleanup");
    })().then(resolve, () => reject(failure("cleanup")));
    return this.ending;
  }

  async read(signal?: AbortSignal): Promise<unknown> {
    let eof = false, reason: Failure = "transport";
    try {
      let count = 0, headerBytes = 0;
      reason = "limit";
      for (const [key, value] of this.response.headers) {
        if (++count > 32 || key.length > 4096 - headerBytes) throw failure(reason);
        headerBytes += key.length;
        if (value.length > 4096 - headerBytes) throw failure(reason);
        headerBytes += value.length;
      }
      reason = "status"; if (!this.response.ok) throw failure(reason);
      reason = "protocol"; if (!this.response.body) throw failure(reason);
      reason = "transport"; if (!this.byob || !this.input) throw failure(reason);
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), wire = 0, reads = 0, text = "";
      const decoder = new TextDecoder(); // response.text() replacement and BOM semantics.
      const append = (chunk: string) => {
        if (chunk.length > authorityUserJsonLimits.text - text.length) throw failure("limit");
        text += chunk;
      };
      for (;;) {
        reason = "aborted"; if (signal?.aborted) throw failure(reason);
        reason = "limit"; if (reads++ >= 8192) throw failure(reason);
        reason = "transport";
        const part = await wait(this.input.read(() => {
          try { return (this.reader as ReadableStreamBYOBReader).read(backing).catch(() => { throw failure("transport"); }); }
          catch { return Promise.reject(failure("transport")); }
        }), signal);
        const bytes = part.value;
        reason = "limit";
        if (bytes) {
          if (!(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > 16384
            || bytes.byteLength > authorityUserJsonLimits.wire - wire) throw failure(reason);
          wire += bytes.byteLength;
          append(decoder.decode(bytes, { stream: !part.done }));
          backing = new Uint8Array(bytes.buffer);
        }
        if (part.done) { if (!bytes) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) throw failure(reason);
      }
      reason = "protocol";
      try {
        const value = parseAccessJson(text, "authority_user");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(reason);
        const envelope = value as Record<string, unknown>;
        if (typeof envelope.initialized !== "boolean" || !Array.isArray(envelope.users) || !Array.isArray(envelope.missingEmails)
          || envelope.missingEmails.some(email => typeof email !== "string")
          || envelope.users.some(user => !user || typeof user !== "object" || Array.isArray(user) || typeof user.email !== "string"
            || !user.record || typeof user.record !== "object" || Array.isArray(user.record))) throw failure(reason);
        return value;
      }
      catch (error) { if (isAccessDenial(error)) reason = "limit"; throw failure(reason); }
    } catch { throw failure(signal?.aborted ? "aborted" : reason); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}

// Query-only, complete-envelope consumer. It neither bounds producer SQL/KV
// materialization nor gives resolveUsers a caller signal or a new deadline.
export async function readAuthorityUserResponse(start: () => Promise<Response>, signal?: AbortSignal): Promise<unknown> {
  let owner: UserResponse | undefined, result: unknown;
  const cancel = () => { if (owner) void owner.retire("cancel").catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const actual = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined); // Registered before invoking the producer.
  try {
    if (signal?.aborted) reject(failure("aborted"));
    else {
      try { Promise.resolve(start()).then(response => {
        try { owner = new UserResponse(response); if (signal?.aborted) cancel(); resolve(); }
        catch { reject(failure("transport")); }
      }, () => reject(failure("transport"))); }
      catch { reject(failure("transport")); }
    }
    await wait(actual, signal);
    result = await owner!.read(signal);
  } finally {
    cancel(); // Late responses are disposed even when the signal race has ended.
    try { await actual.catch(() => undefined); if (owner) await owner.retire("cancel"); }
    finally { signal?.removeEventListener("abort", cancel); }
  }
  if (signal?.aborted) throw failure("aborted");
  return result;
}
