import { inputRetirement, type InputRetirement } from "./input-retirement.ts";

type Ack = "initialized" | "updated" | "recorded" | "released";
type Failure = "aborted" | "transport" | "status" | "limit" | "protocol" | "cleanup";
const paths: Readonly<Record<string, Ack>> = Object.freeze({
  "/initialize": "initialized", "/initialize-all": "initialized",
  "/users/initialize": "initialized", "/users/initialize-all": "initialized",
  "/policies/initialize": "initialized", "/policies/initialize-all": "initialized",
  "/credentials/initialize": "initialized", "/credentials/initialize-all": "initialized",
  "/connections/initialize": "initialized", "/connections/initialize-all": "initialized",
  "/mutate": "updated", "/users/put": "updated", "/policies/put": "updated",
  "/grant-pools/feedback": "updated", "/oauth-states/put": "updated",
  "/grant-pools/record": "recorded", "/submission-tickets/release": "released",
});

export function authorityAck(path: string): Ack | undefined {
  return Object.hasOwn(paths, path) ? paths[path] : undefined;
}

function failure(reason: Failure, invoked = true): Error {
  return Object.assign(new Error("Authority acknowledgment unavailable"), {
    code: "authority_ack_failed", reason, outcome: invoked ? "OUTCOME_UNKNOWN" : "NOT_INVOKED",
  });
}

// Tiny root-string guard before JSON.parse; no containers or token vector.
function parseAck(text: string, json: boolean, expected: Ack): Ack {
  if (json) {
    let at = 0, units = 0;
    const space = () => { while (at < text.length && " \t\r\n".includes(text[at])) at++; };
    space(); if (text[at++] !== '"') throw failure("protocol");
    let closed = false;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') { closed = true; break; }
      if (char.charCodeAt(0) < 32 || ++units > 11) throw failure("protocol");
      if (char === "\\") {
        const escape = text[at++];
        if (escape === "u") {
          for (let i = 0; i < 4; i++) if (!/^[0-9a-f]$/i.test(text[at++] ?? "")) throw failure("protocol");
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) throw failure("protocol");
      }
    }
    space(); if (!closed || at !== text.length) throw failure("protocol");
    if (JSON.parse(text) !== expected) throw failure("protocol");
  } else if (text !== expected) throw failure("protocol");
  return expected;
}

function wait<T>(actual: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(failure("aborted")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    actual.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(failure("aborted")); else resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(failure("transport")); });
  });
}

class AckResponse {
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
    catch { try { this.reader = response.body.getReader(); } catch { /* Unresolved ownership remains held. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        if (!this.firstCancel) {
          let settle!: () => void;
          this.firstCancel = new Promise<void>(resolve => { settle = resolve; });
          try { Promise.resolve(this.reader!.cancel("authority ACK stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
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
      if (this.response.body && (!this.reader || this.response.body.locked)) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.firstCancel = undefined;
      if (this.cleanupFailed) throw failure("cleanup");
    })().then(resolve, () => reject(failure("cleanup")));
    return this.ending;
  }

  async read(expected: Ack, signal?: AbortSignal): Promise<Ack> {
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
      reason = "transport"; if (!this.byob || !this.input) throw failure(reason);
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(128), wire = 0, reads = 0, text = "";
      const decoder = new TextDecoder(); // Preserve response.text() replacement/BOM semantics.
      const append = (chunk: string) => { if (chunk.length > 128 - text.length) throw failure("limit"); text += chunk; };
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
          if (!(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > 128 || bytes.byteLength > 128 - wire) throw failure(reason);
          wire += bytes.byteLength; append(decoder.decode(bytes, { stream: !part.done }));
          backing = new Uint8Array(bytes.buffer);
        }
        if (part.done) { if (!bytes) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) throw failure(reason);
      }
      reason = "protocol";
      return parseAck(text, this.response.headers.get("content-type")?.includes("application/json") ?? false, expected);
    } catch { throw failure(signal?.aborted ? "aborted" : reason); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}

export async function readAuthorityAck(start: () => Promise<Response>, expected: Ack, signal?: AbortSignal): Promise<Ack> {
  let owner: AckResponse | undefined, invoked = false;
  const cancel = () => { if (owner) void owner.retire("cancel").catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const actual = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try {
    if (signal?.aborted) reject(failure("aborted", false));
    else {
      invoked = true; // A thrown invocation is uncertain, never proof of rollback.
      try { Promise.resolve(start()).then(response => {
        owner = new AckResponse(response); if (signal?.aborted) cancel(); resolve();
      }, () => reject(failure("transport"))); }
      catch { reject(failure("transport")); }
    }
    try { await wait(actual, signal); }
    catch { throw failure(signal?.aborted ? "aborted" : "transport", invoked); }
    const result = await owner!.read(expected, signal);
    if (signal?.aborted) throw failure("aborted");
    return result;
  } finally {
    // Abort starts disposal before joining. Late bodies and rejected FIRST
    // cancellation remain owned; the supplied signal adds no new deadline.
    cancel();
    try { await actual.catch(() => undefined); if (owner) await owner.retire("cancel"); }
    finally { signal?.removeEventListener("abort", cancel); }
  }
}
