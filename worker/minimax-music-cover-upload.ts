import { jsonBodyBytes } from "./json-body.ts";
import { runMiniMaxMusicCoverControls } from "./minimax-music-cover-control.ts";
import { claimMiniMaxMusicCoverUpload, isMiniMaxMusicCoverUpload, encodeMiniMaxMusicCoverUpload, retireMiniMaxMusicCoverUpload,
  transferMiniMaxMusicCoverResponse, type MusicCoverControlPhase, type MusicCoverUploadCapability,
  type SealedMusicCoverInput } from "./minimax-music-cover-input.ts";
import { disposeMiniMaxMusicCoverResponse, readNativeMiniMaxMusicCover } from "./native-minimax-music.ts";

const destination = "https://api.minimax.io/v1/music_generation";
const failed = () => new Error("inactive music cover transport failed");
const cleanupError = () => Object.assign(new Error("music cover upload cleanup failed"), { cleanupFailed: true });
function cleanupFlag(error: unknown): boolean {
  try { return error instanceof Error && Object.getOwnPropertyDescriptor(error, "cleanupFailed")?.value === true; }
  catch { return false; }
}
export const musicCoverUploadLimits = Object.freeze({ backing: 16384, inventoryKiB: Object.freeze([128, 32, 32, 64, 64, 64, 48, 8]),
  assignedKiB: 440, unavailableKiB: 15944, uploadMiB: 16, controlsMiB: 32, responseMiB: 64,
  liveBytes: 100331648, margin: 331648 });

// This class owns the exact source passed to fetch. The input capability exposes
// bounded ASCII writes, never a byte view, mutable audio or caller allocation.
export class MusicCoverUploadSource {
  readonly body: ReadableStream<Uint8Array>;
  readonly length: number;
  private cap?: MusicCoverUploadCapability;
  private prefix?: Uint8Array<ArrayBuffer>;
  private suffix?: Uint8Array<ArrayBuffer>;
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private pending?: Promise<void>;
  private firstDiscard?: Promise<void>;
  private closing?: Promise<void>;
  private phase = 0;
  private emitted = 0;
  private sourceClosed = false;
  private discarded = false;
  private cleanupFailed = false;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;
  readonly retired = new Promise<void>((yes, no) => { this.resolve = yes; this.reject = no; });
  constructor(cap: MusicCoverUploadCapability, phase: MusicCoverControlPhase) {
    if (!isMiniMaxMusicCoverUpload(cap, phase)) throw failed();
    const m = phase.metadata, plan = { model: m.model, prompt: m.prompt, ...(m.lyrics === undefined ? {} : { lyrics: m.lyrics }), stream: false, output_format: "hex" };
    if (jsonBodyBytes(plan) > 16000) throw failed();
    const encoder = new TextEncoder();
    this.prefix = encoder.encode(JSON.stringify(plan).slice(0, -1) + ',"audio_base64":"');
    this.suffix = encoder.encode('"}');
    if (this.prefix.buffer.byteLength > 16384) throw failed();
    this.length = this.prefix.length + Math.ceil(m.bytes / 3) * 4 + this.suffix.length;
    this.cap = cap;
    void this.retired.catch(() => undefined);
    this.body = new ReadableStream<Uint8Array>({
      start: controller => { this.controller = controller; },
      pull: controller => {
        if (this.pending || this.discarded || this.sourceClosed) return;
        // Register the physical pull BEFORE invoking any producer callback.
        let resolve!: () => void, reject!: (reason: unknown) => void;
        const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        this.pending = pending.then(() => { this.pending = undefined; }, () => {
          this.pending = undefined; this.discarded = true; throw failed();
        });
        const physical = this.pending;
        void physical.then(() => { if (this.sourceClosed || this.discarded) void this.close(); }, () => { void this.discard(); });
        try { void this.produce(controller).then(resolve, () => reject(failed())); } catch { reject(failed()); }
        return physical;
      },
      cancel: () => this.discard(),
    }, { highWaterMark: 0 });
  }
  // A separate method permits test-only held producer callbacks on the SAME
  // stream; production has no gate, alternate stream or replacement body.
  private async produce(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.discarded || !this.cap) return;
    if (!this.phase) { this.phase = 1; this.emitted += this.prefix!.length; controller.enqueue(this.prefix!); this.prefix = undefined; return; }
    if (this.phase === 1) {
      const chunk = new Uint8Array(16384), count = encodeMiniMaxMusicCoverUpload(this.cap, chunk);
      if (count) { this.emitted += count; controller.enqueue(chunk.subarray(0, count)); return; }
      this.phase = 2;
    }
    this.emitted += this.suffix!.length; controller.enqueue(this.suffix!); this.suffix = undefined;
    if (this.emitted !== this.length) throw failed();
    controller.close(); this.sourceClosed = true;
  }
  private async disposeSource(): Promise<void> {
    this.controller?.error(failed());
  }
  discard(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.firstDiscard && !this.sourceClosed) {
      this.discarded = true;
      let resolve!: () => void;
      this.firstDiscard = new Promise<void>(yes => { resolve = yes; });
      try { void Promise.resolve(this.disposeSource()).then(resolve, () => { this.cleanupFailed = true; resolve(); }); }
      catch { this.cleanupFailed = true; resolve(); }
    }
    return this.close();
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try { await this.pending; } catch { this.discarded = true; }
      await this.firstDiscard;
      if (this.cap) retireMiniMaxMusicCoverUpload(this.cap, this.sourceClosed && !this.discarded && !this.cleanupFailed);
      this.cap = undefined; this.prefix = undefined; this.suffix = undefined; this.controller = undefined;
      this.pending = undefined; this.firstDiscard = undefined;
      if (this.cleanupFailed) { this.reject(cleanupError()); throw cleanupError(); }
      this.resolve();
    })();
    void this.closing.catch(() => undefined); return this.closing;
  }
  snapshot() { return Object.freeze({ emitted: this.emitted, length: this.length, sourceClosed: this.sourceClosed,
    discarded: this.discarded, cleanupFailed: this.cleanupFailed, pending: !!this.pending,
    references: Number(!!this.cap) + Number(!!this.prefix) + Number(!!this.suffix) + Number(!!this.controller) }); }
}

// INACTIVE transport foundation: no credentials, current authority, accounting,
// public factory or registered route. The preparation record from the separate
// authority slice is deliberately not accepted. A fixture supplies transport;
// this function fixes the entire destination, body, headers and one attempt.
export function runInactiveMiniMaxMusicCoverUpload(input: SealedMusicCoverInput,
  transport: (url: string, init: RequestInit) => Promise<Response>) {
  return runMiniMaxMusicCoverControls(input, async owner => {
    const phase = owner.phase, cap = claimMiniMaxMusicCoverUpload(phase), signal = owner.operation.signal;
    return owner.post(cap, async reportFailure => {
      const upload = new MusicCoverUploadSource(cap, phase);
      let response: Response | undefined, disposal: Promise<void> | undefined, cleanupFailed = false;
      const discardResponse = () => {
        if (!disposal && response) {
          const original = response; response = undefined;
          disposal = disposeMiniMaxMusicCoverResponse(original).catch(() => { cleanupFailed = true; });
        }
        return disposal;
      };
      const abort = () => { void upload.discard().catch(() => { cleanupFailed = true; }); void discardResponse(); };
      signal.addEventListener("abort", abort, { once: true });
      // Both physical roots exist before fetch construction. Headers are not
      // upload retirement; a late response belongs to this same attempt.
      let resolve!: (value: Response | PromiseLike<Response>) => void, reject!: (reason: unknown) => void;
      let actual: Promise<Response> | undefined = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
      void actual.catch(() => undefined);
      try {
        signal.throwIfAborted();
        // Normalize before the owned promise can retain any rejection graph.
        void transport(destination, { method: "POST", redirect: "manual", signal, body: upload.body,
          headers: { "content-type": "application/json", accept: "application/json", "content-length": String(upload.length) } })
          .then(resolve, () => reject(failed()));
      } catch { reject(failed()); }
      try {
        response = await actual; actual = undefined;
        if (signal.aborted) abort();
        await upload.retired;
        if (signal.aborted) throw failed();
        const successor = transferMiniMaxMusicCoverResponse(cap);
        const original = response!; response = undefined;
        const output = await readNativeMiniMaxMusicCover(original, successor, signal, reportFailure);
        signal.removeEventListener("abort", abort);
        return { value: output.response, retired: output.retired };
      } catch (error) {
        const failedCleanup = cleanupFlag(error); error = undefined;
        reportFailure();
        // Disposal starts BEFORE joins and does not depend on transfer success.
        abort();
        try { await upload.discard(); } catch { cleanupFailed = true; }
        await discardResponse(); await disposal;
        if (cleanupFailed || failedCleanup) throw cleanupError();
        throw failed();
      } finally { signal.removeEventListener("abort", abort); actual = undefined; response = undefined; disposal = undefined; }
    });
  });
}
