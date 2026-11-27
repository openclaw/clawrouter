import { accessDenial, accessEvidenceLimits, accessLimits, isAccessDenial, parseAccessJson } from "./access-json.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";

// This is an owned-reader boundary. Native HTTP buffering is not an application
// allocation guarantee. An unknown lock deliberately keeps the facade pending.
class AccessResponse {
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private input?: InputRetirement;
  private firstCancel?: Promise<void>;
  private ending?: Promise<void>;
  private cleanupFailed = false;
  private readonly byob: boolean;
  private readonly response: Response;

  constructor(response: Response) {
    this.response = response;
    let byob = false;
    if (response.body) {
      try { this.reader = response.body.getReader({ mode: "byob" }); byob = true; }
      catch { try { this.reader = response.body.getReader(); } catch { /* Already locked: ownership is unresolved. */ } }
      if (this.reader) this.input = inputRetirement({
        cancel: () => {
          if (!this.firstCancel) {
            let settle!: () => void;
            this.firstCancel = new Promise<void>(resolve => { settle = resolve; });
            try { Promise.resolve(this.reader!.cancel("Access reader stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
            catch { this.cleanupFailed = true; settle(); }
          }
          return this.firstCancel;
        },
        releaseLock: () => { try { this.reader!.releaseLock(); } catch { this.cleanupFailed = true; } },
      });
    }
    this.byob = byob;
  }

  retire(kind: "eof" | "cancel"): Promise<void> {
    if (this.ending) return this.ending;
    // Install before FIRST cancel can synchronously re-enter the abort listener.
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.ending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void this.ending.catch(() => undefined);
    void (async () => {
      if (this.input) await this.input.retire(kind);
      if (this.response.body?.locked) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.firstCancel = undefined;
      if (this.cleanupFailed) throw accessDenial("cleanup");
    })().then(resolve, () => reject(accessDenial("cleanup")));
    return this.ending;
  }

  async read(operation: HttpOperation, url: string, profile: "jwks" | "evidence"): Promise<unknown | null> {
    let eof = false;
    try {
      const response = this.response;
      checkHeaders(response, url, profile);
      if (profile === "jwks" ? response.status !== 200 : !response.ok) return null;
      if (!this.byob || !this.input) throw accessDenial("transport");
      const declared = response.headers.get("content-length");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let window: Uint8Array<ArrayBuffer> = new Uint8Array(accessLimits.backing), wire = 0, reads = 0, text = "";
      const append = (chunk: string) => {
        if (profile === "evidence" && chunk.length > accessEvidenceLimits.text - text.length) throw accessDenial("limit");
        text += chunk;
      };
      for (;;) {
        if (operation.signal.aborted) throw accessDenial("deadline");
        if (reads++ >= accessLimits.reads) throw accessDenial("limit");
        const actual = this.input.read(() => {
          try { return (this.reader as ReadableStreamBYOBReader).read(window).catch(() => { throw accessDenial("transport"); }); }
          catch { return Promise.reject(accessDenial("transport")); }
        });
        const part = await operation.wait(actual);
        const bytes = part.value;
        if (bytes) {
          if (!(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > accessLimits.backing
            || bytes.byteLength > accessLimits.jwks - wire) throw accessDenial("limit");
          wire += bytes.byteLength;
          append(decoder.decode(bytes, { stream: !part.done }));
          // Reuse the returned WHOLE backing; the accumulator is never lent to BYOB.
          window = new Uint8Array(bytes.buffer);
        }
        if (part.done) { if (!bytes) append(decoder.decode()); eof = true; break; }
        if (!window.byteLength) throw accessDenial("transport");
      }
      if (declared !== null && wire !== Number(declared)) throw accessDenial("transport");
      return parseAccessJson(text, profile);
    } catch (error) {
      // No raw transport/decoder cause survives the physical-retirement await.
      throw isAccessDenial(error) ? error : accessDenial("transport");
    } finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}

function checkHeaders(response: Response, url: string, profile: "jwks" | "evidence"): void {
  let count = 0, bytes = 0;
  for (const [key, value] of response.headers) {
    // Headers are byte strings. Bound both fields before any normalization.
    if (++count > accessLimits.headers || key.length > accessLimits.headerBytes - bytes) throw accessDenial("limit");
    bytes += key.length;
    if (value.length > accessLimits.headerBytes - bytes) throw accessDenial("limit");
    bytes += value.length;
  }
  if (response.status === 206 || response.redirected || response.url !== url || response.headers.has("content-range")
    || response.headers.has("range") || response.status >= 300 && response.status < 400) throw accessDenial("transport");
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") throw accessDenial("transport");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw accessDenial("transport");
  if (length !== null && Number(length) > accessLimits.jwks) throw accessDenial("limit");
  const json = profile === "jwks" ? /^application\/(?:json|jwk-set\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i
    : /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i;
  if ((profile === "jwks" ? response.status === 200 : response.ok) && !json.test(response.headers.get("content-type") ?? "")) throw accessDenial("transport");
}

export async function readAccessJwks(url: string, operation: HttpOperation): Promise<unknown | null> {
  return readAccessResponse(url, operation, "jwks");
}

export async function readAccessEvidence(url: string, cookie: string, operation: HttpOperation): Promise<unknown | null> {
  return readAccessResponse(url, operation, "evidence", cookie);
}

async function readAccessResponse(url: string, operation: HttpOperation, profile: "jwks" | "evidence", cookie?: string): Promise<unknown | null> {
  let owner: AccessResponse | undefined;
  const cancel = () => { if (owner) void owner.retire("cancel").catch(() => undefined); };
  operation.signal.addEventListener("abort", cancel, { once: true });
  // Register the actual fetch before construction/racing. It owns late bodies;
  // HttpOperation's synchronous discard callback cannot certify their retirement.
  let resolve!: (response: Response) => void, reject!: (reason: unknown) => void;
  const actual = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try {
    if (operation.signal.aborted) reject(accessDenial("deadline"));
    else {
      try {
        fetch(url, { redirect: "manual", headers: profile === "jwks"
          ? { accept: "application/json, application/jwk-set+json", "accept-encoding": "identity" }
          : { accept: "application/json", "accept-encoding": "identity", cookie: cookie! },
          ...(profile === "jwks" ? { cf: { cacheTtl: 300, cacheEverything: true } } : {}), signal: operation.signal }).then(response => {
          owner = new AccessResponse(response); if (operation.signal.aborted) cancel(); resolve(response);
        }, () => reject(accessDenial("transport")));
      } catch { reject(accessDenial("transport")); }
    }
    await operation.wait(actual);
    return await owner!.read(operation, url, profile);
  } finally {
    // Retirement-blocking facade: a deadline stops work but never detaches roots.
    try {
      await actual.catch(() => undefined);
      if (owner) await owner.retire("cancel");
    } finally { operation.signal.removeEventListener("abort", cancel); }
  }
}
