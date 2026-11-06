import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { parseSoftStatus, softStatusError, softStatusLimits } from "./soft-budget-json.ts";

// No observation deadline: close() only suppresses the outward denial callback.
// A failed/unknown unlock retains this physical owner and the enclosing check.
class SoftStatusResponse {
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private input?: InputRetirement;
  private firstCancel?: Promise<void>;
  private ending?: Promise<void>;
  private cleanupFailed = false;
  private byob = false;
  private readonly response: Response;

  constructor(response: Response) {
    this.response = response;
    const body = response.body;
    if (!body) return;
    try { this.reader = body.getReader({ mode: "byob" }); this.byob = true; }
    catch { try { this.reader = body.getReader(); } catch { /* Unknown ownership stays held. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        if (!this.firstCancel) {
          let settle!: () => void;
          this.firstCancel = new Promise<void>(resolve => { settle = resolve; });
          try { Promise.resolve(this.reader!.cancel("soft budget observation stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
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
      if (this.response.body?.locked) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.firstCancel = undefined;
      if (this.cleanupFailed) throw softStatusError();
    })().then(resolve, () => reject(softStatusError()));
    return this.ending;
  }

  async read(): Promise<unknown> {
    let eof = false;
    try {
      let headers = 0, headerBytes = 0;
      for (const [key, value] of this.response.headers) {
        if (++headers > softStatusLimits.headers || key.length > softStatusLimits.headerBytes - headerBytes) throw softStatusError();
        headerBytes += key.length;
        if (value.length > softStatusLimits.headerBytes - headerBytes) throw softStatusError();
        headerBytes += value.length;
      }
      // Preserve response.ok, not network-only MIME/URL/range/exact-200 rules.
      if (!this.response.ok) return null;
      if (!this.byob || !this.input) throw softStatusError();
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(softStatusLimits.backing), wire = 0, reads = 0, text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const append = (chunk: string) => {
        if (chunk.length > softStatusLimits.wire - text.length) throw softStatusError();
        text += chunk;
      };
      for (;;) {
        if (reads++ >= softStatusLimits.reads) throw softStatusError();
        const part = await this.input.read(() => {
          try { return (this.reader as ReadableStreamBYOBReader).read(backing).catch(() => { throw softStatusError(); }); }
          catch { return Promise.reject(softStatusError()); }
        });
        const bytes = part.value;
        if (bytes) {
          if (!(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > softStatusLimits.backing
            || bytes.byteLength > softStatusLimits.wire - wire) throw softStatusError();
          wire += bytes.byteLength;
          append(decoder.decode(bytes, { stream: !part.done }));
          backing = new Uint8Array(bytes.buffer);
        }
        if (part.done) { if (!bytes) append(decoder.decode()); eof = true; break; }
        if (!backing.byteLength) throw softStatusError();
      }
      return parseSoftStatus(text);
    } catch { throw softStatusError(); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}

export async function readSoftStatus(start: () => Promise<Response>): Promise<unknown> {
  // Register before invoking the DO transport. No signal race or detached late
  // fetch: every response is owned before status/header checks and before return.
  let resolve!: (response: Response) => void, reject!: (reason: unknown) => void;
  const actual = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  try { Promise.resolve(start()).then(resolve, () => reject(softStatusError())); }
  catch { reject(softStatusError()); }
  const owner = new SoftStatusResponse(await actual);
  return owner.read();
}
