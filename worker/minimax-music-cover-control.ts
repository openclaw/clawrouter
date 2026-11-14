import { musicCoverVerification, retireMusicCoverVerification } from "./proxy-auth.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { claimMiniMaxMusicCoverControl, isMiniMaxMusicCoverUpload, type MusicCoverControlPhase, type MusicCoverUploadCapability, type SealedMusicCoverInput } from "./minimax-music-cover-input.ts";
import { assertSearchHeaders, readSearchJson, searchJsonBytes } from "./minimax-search-operation.ts";
import { HttpError } from "./utils.ts";

export const musicCoverControlVersion = "clawrouter.minimax-music-cover-control.v1";
export const musicCoverControlHeader = "x-clawrouter-music-cover-control";
export const musicCoverControlLimits = Object.freeze({ tickets: 27, ordinary: 16, softOrdinary: 12, mandatory: 10,
  ticketKiB: Object.freeze([160, 144, 256, 64, 128, 272]), scratchMiB: Object.freeze([1, 1, 1, 1, 1]),
  controlBytes: 16384, mandatoryMs: 15000, bridgeBytes: 384 * 1024 });
export function musicCoverUnavailable(status = 503): never {
  throw new HttpError(status, "minimax_music_cover_unavailable", "Music cover control or original authority is unavailable");
}
const genuine = new WeakSet<MiniMaxMusicCoverControl>();
const ownerToken = Symbol("music cover control owner");
export function isMusicCoverControl(value: unknown): value is MiniMaxMusicCoverControl {
  return typeof value === "object" && value !== null && genuine.has(value as MiniMaxMusicCoverControl);
}
interface Ticket {
  readonly id: number;
  readonly mandatory: boolean;
  work?: Promise<void>;
  input?: InputRetirement;
  response?: Response;
  cancellation?: Promise<void>;
  released: boolean;
  succeeded?: boolean;
}
export interface MusicCoverFinalRead { readonly kind: "music-cover-final-read.v1" }
export interface MusicCoverPreparedPost { readonly kind: "music-cover-prepared-post.v1" }
interface PreparedPost {
  owner: MiniMaxMusicCoverControl;
  cap: MusicCoverUploadCapability;
  execute: () => void;
  result: Promise<unknown>;
  physical: Promise<void>;
  ticket?: Ticket;
  discard: () => Promise<void>;
  retired: Promise<void>;
  used: boolean;
}
const preparedPosts = new WeakMap<MusicCoverPreparedPost, PreparedPost>();
type Snapshot = Readonly<{ ordinary: number; mandatory: number; ordinaryActive: number; mandatoryActive: number;
  closed: boolean; cleanupFailed: boolean; ownershipBlocked: boolean; postAttempts: number }>;

// No independent acquisition: the genuine post-hash input owner keeps all 96 MiB.
// The inactive transport may spend the reserved POST cell. Its capability is
// custody, not current authority; no production caller composes these paths.
export class MiniMaxMusicCoverControl {
  private activeOperation?: HttpOperation;
  private controlPhase?: MusicCoverControlPhase;
  get operation(): HttpOperation { return this.activeOperation ?? musicCoverUnavailable(); }
  get phase(): MusicCoverControlPhase { return this.controlPhase ?? musicCoverUnavailable(); }
  private ordinary = 0;
  private mandatory = 0;
  private postAttempts = 0;
  private ordinaryLimit: number = musicCoverControlLimits.ordinary;
  private mode?: boolean;
  private active = [false, false];
  private readonly queues: Array<Array<() => void>> = [[], []];
  private readonly tickets: Ticket[] = [];
  private closed = false;
  private cleanupFailed = false;
  private ownershipBlocked = false;
  private closing?: Promise<void>;
  private ordinarySealed = false;
  private finalRead?: { token: MusicCoverFinalRead; index: number };
  private prepared?: MusicCoverPreparedPost;
  private decision?: () => void;
  private readonly abort = () => {
    for (const ticket of this.tickets) if (!ticket.mandatory && ticket.input)
      void ticket.input.retire("cancel", "cover control stopped").catch(() => { this.cleanupFailed = true; });
  };
  constructor(token: symbol, phase: MusicCoverControlPhase, decision?: () => void) {
    if (token !== ownerToken) musicCoverUnavailable();
    this.controlPhase = phase;
    this.decision = decision;
    this.activeOperation = new HttpOperation(phase.signal, Math.max(0, phase.deadlineAt - Date.now()));
    this.operation.signal.addEventListener("abort", this.abort, { once: true });
    genuine.add(this);
  }
  setBudgetMode(soft: boolean): void {
    if (this.mode !== undefined && this.mode !== soft) musicCoverUnavailable();
    this.mode = soft; this.ordinaryLimit = soft ? musicCoverControlLimits.softOrdinary : musicCoverControlLimits.ordinary;
    if (this.ordinary > this.ordinaryLimit) musicCoverUnavailable();
  }
  private ticket(mandatory: boolean, post = false): Ticket {
    if (this.closed || this.ownershipBlocked || !mandatory && this.ordinarySealed || post && (mandatory || this.postAttempts)
      || (mandatory ? this.mandatory >= 10 : this.ordinary >= this.ordinaryLimit + (post ? 1 : this.postAttempts))) musicCoverUnavailable();
    if (post) this.postAttempts++;
    if (mandatory) this.mandatory++; else this.ordinary++;
    const ticket: Ticket = { id: this.tickets.length, mandatory, released: false };
    this.tickets.push(ticket); return ticket;
  }
  private async slot(ticket: Ticket): Promise<void> {
    const lane = ticket.mandatory ? 1 : 0;
    if (this.active[lane]) await new Promise<void>(resolve => this.queues[lane].push(resolve));
    else this.active[lane] = true;
    if (this.ownershipBlocked) musicCoverUnavailable();
  }
  private release(ticket: Ticket): void {
    if (ticket.released) return;
    if (ticket.response?.body?.locked) { this.ownershipBlocked = true; return; }
    ticket.released = true;
    const lane = ticket.mandatory ? 1 : 0, next = this.queues[lane].shift();
    if (next) next(); else this.active[lane] = false;
  }
  private async discard(ticket: Ticket): Promise<void> {
    if (ticket.input) { await ticket.input.retire("cancel", "cover control discarded"); return; }
    const body = ticket.response?.body;
    if (!body) return;
    if (body.locked || ticket.response!.bodyUsed) { this.ownershipBlocked = true; musicCoverUnavailable(); }
    const reader = body.getReader();
    const base = inputRetirement({ cancel: () => {
      if (!ticket.cancellation) {
        let resolve!: () => void, reject!: (reason: unknown) => void;
        ticket.cancellation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        void ticket.cancellation.catch(() => undefined);
        try { void Promise.resolve(reader.cancel("cover control discarded")).then(resolve, reject); } catch (error) { reject(error); }
      }
      return ticket.cancellation;
    }, releaseLock: () => reader.releaseLock() });
    const retired = base.retired.then(() => ticket.cancellation);
    void retired.catch(() => undefined);
    ticket.input = { read: start => base.read(start), retired, retire(kind, reason) {
      void base.retire(kind, reason).catch(() => undefined); return retired;
    } };
    await ticket.input.retire("cancel");
  }
  controlJson<T>(body: unknown, start: (text: string, signal: AbortSignal) => Promise<Response>, mandatory = false,
    signal?: AbortSignal, bootstrap = false): Promise<T> {
    if (bootstrap ? this.ordinary !== 0 || mandatory || musicCoverVerification(this) : !musicCoverVerification(this)) musicCoverUnavailable(403);
    const ticket = this.ticket(mandatory);
    // Queued descriptors contain only a prebounded graph, never serialized bytes.
    searchJsonBytes(body);
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => undefined);
    ticket.work = (async () => {
      await this.slot(ticket);
      const window = mandatory ? new HttpOperation(undefined, musicCoverControlLimits.mandatoryMs) : undefined;
      const active = window?.signal ?? signal ?? this.operation.signal;
      try {
        active.throwIfAborted();
        // Actual fetch registration precedes its construction, and owns late replies.
        ticket.response = await start(JSON.stringify(body), active);
        if (active.aborted) { await this.discard(ticket); active.throwIfAborted(); }
        const value = await readSearchJson(ticket.response, active, "control", input => { ticket.input = input; });
        if (!ticket.response.ok) musicCoverUnavailable(ticket.response.status);
        await ticket.input!.retired;
        ticket.succeeded = true;
        resolve(value as T);
      } catch (error) {
        const status = error instanceof HttpError && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const bounded = new HttpError(status, "minimax_music_cover_control_failed", "Music cover control was not acknowledged");
        if (!mandatory) reject(bounded); // Public result is separate from physical retirement.
        try { await this.discard(ticket); } catch { this.cleanupFailed = true; }
        if (mandatory) reject(bounded); // Fallback may start only after this predecessor retires.
      } finally {
        window?.stop("complete"); this.release(ticket);
      }
    })().catch(() => { reject(new HttpError(503, "minimax_music_cover_control_failed", "Music cover control failed")); });
    return result;
  }
  task<T>(body: unknown, start: (bounded: unknown) => Promise<T>, mandatory = false): Promise<T> {
    if (!musicCoverVerification(this)) musicCoverUnavailable(403);
    const ticket = this.ticket(mandatory); searchJsonBytes(body);
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => undefined);
    ticket.work = (async () => {
      await this.slot(ticket);
      const window = mandatory ? new HttpOperation(undefined, musicCoverControlLimits.mandatoryMs) : undefined;
      try {
        const signal = window?.signal ?? this.operation.signal;
        signal.throwIfAborted();
        // Queue promises expose no cancellation ACK. Their actual settlement
        // retains this slot, even after the bounded execution window expires.
        const value = await start(body); signal.throwIfAborted(); resolve(value);
      } catch { reject(new HttpError(503, "minimax_music_cover_control_failed", "Music cover queue was not acknowledged")); }
      finally { window?.stop("complete"); this.release(ticket); }
    })().catch(() => { reject(new HttpError(503, "minimax_music_cover_control_failed", "Music cover control failed")); });
    return result;
  }
  // Inactive transport only. This spends scheduling capacity, NOT a verifier
  // or preparation record. Start owns upload/fetch/late-body/read/delivery and
  // must dispose failure branches before rejection; the slot joins its root.
  post<T>(cap: MusicCoverUploadCapability, start: (fail: () => void) => Promise<{ value: T; retired: Promise<void> }>): Promise<T> {
    if (!isMiniMaxMusicCoverUpload(cap, this.phase)) musicCoverUnavailable(403);
    const ticket = this.ticket(false, true);
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => undefined);
    ticket.work = (async () => {
      await this.slot(ticket);
      try {
        // A prestart abort is not evidence of internal cleanup failure, even
        // when an internal caller supplied a reason with cleanupFailed:true.
        if (this.operation.signal.aborted) throw new Error("music cover inactive transport stopped");
        const outcome = await start(() => reject(new Error("music cover inactive transport failed")));
        resolve(outcome.value); await outcome.retired;
      } catch (error) {
        if ((error as { cleanupFailed?: unknown })?.cleanupFailed === true) this.cleanupFailed = true;
        reject(new Error("music cover inactive transport failed"));
      } finally { this.release(ticket); }
    })();
    return result;
  }
  // Preparation owns an UNPULLED source before the final authority wait. The
  // capsule is custody only; a separate exact-ticket handoff must authorize it.
  preparePost<T>(cap: MusicCoverUploadCapability, start: (fail: () => void) => Promise<{ value: T; retired: Promise<void> }>,
    discard: () => Promise<void>, retired: Promise<void>): MusicCoverPreparedPost {
    if (this.prepared || this.ordinarySealed || !isMiniMaxMusicCoverUpload(cap, this.phase)) musicCoverUnavailable(403);
    const capsule: MusicCoverPreparedPost = Object.freeze({ kind: "music-cover-prepared-post.v1" });
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void, retire!: () => void;
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const physical = new Promise<void>(yes => { retire = yes; });
    void result.catch(() => undefined);
    const prepared: PreparedPost = { owner: this, cap, result, physical, discard, retired, used: false, execute: () => {
      void (async () => {
        try {
          const output = await start(() => reject(new Error("music cover transport failed")));
          resolve(output.value); await output.retired;
        } catch (error) {
          if ((error as { cleanupFailed?: unknown })?.cleanupFailed === true) this.cleanupFailed = true;
          reject(new Error("music cover transport failed"));
        } finally { this.release(prepared.ticket!); retire(); }
      })();
    } };
    preparedPosts.set(capsule, prepared);
    this.prepared = capsule; void retired.catch(() => undefined); return capsule;
  }
  markFinalOwnerRead(): MusicCoverFinalRead {
    if (this.finalRead || this.ordinarySealed || this.active[0] || this.queues[0].length) musicCoverUnavailable();
    const token: MusicCoverFinalRead = Object.freeze({ kind: "music-cover-final-read.v1" });
    this.finalRead = { token, index: this.tickets.length }; return token;
  }
  tryPostHandoff<T>(capsule: MusicCoverPreparedPost, final: MusicCoverFinalRead, validate: () => void, invoked: () => void): Promise<T> {
    const prepared = preparedPosts.get(capsule), fence = this.finalRead;
    const last = fence && this.tickets[fence.index];
    if (!prepared || prepared.owner !== this || prepared.used || this.prepared !== capsule
      || !fence || fence.token !== final || this.tickets.length !== fence.index + 1 || !last?.succeeded || !last.released
      || last.mandatory || this.active[0] || this.queues[0].length || this.operation.signal.aborted
      || Date.now() >= this.phase.deadlineAt || !isMiniMaxMusicCoverUpload(prepared.cap, this.phase)) musicCoverUnavailable(403);
    validate(); // Synchronous original owner/format/coverage checks only.
    const ticket = this.ticket(false, true);
    this.active[0] = true; prepared.used = true; prepared.ticket = ticket;
    ticket.work = prepared.physical;
    // Registration and terminal admission fencing precede invocation. There is
    // no queued slot, preparation or await after the exact owner-read receipt.
    invoked(); this.sealOrdinary();
    prepared.execute();
    return prepared.result as Promise<T>;
  }
  sealOrdinary(): void {
    if (this.ordinarySealed) return;
    this.ordinarySealed = true;
    const prepared = this.prepared && preparedPosts.get(this.prepared);
    if (prepared && !prepared.used) void prepared.discard().catch(() => { this.cleanupFailed = true; });
    this.decision?.(); this.decision = undefined;
  }
  async retireOrdinary(): Promise<void> {
    // The bounded snapshot is at most seventeen fixed ordinary references. No new
    // operation may be introduced by finalization; late ACKs keep their IDs.
    for (const ticket of this.tickets) if (!ticket.mandatory) await ticket.work;
    const prepared = this.prepared && preparedPosts.get(this.prepared);
    if (prepared) { try { await prepared.retired; } catch { this.cleanupFailed = true; } }
    if (this.ownershipBlocked) await new Promise<void>(() => undefined);
  }
  cancel(): void { this.activeOperation?.cancel("cover control stopped"); }
  finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Initiate input closure BEFORE joins. The input joins our registered root;
    // neither this promise nor any ticket ever awaits input.retired/discard().
    if (!this.postAttempts) this.phase.close();
    this.closing = (async () => {
      for (const ticket of this.tickets) { await ticket.work; }
      // Successful publication must retain the original deadline through
      // downstream EOF/cancel. Never cancel it merely because headers exist.
      if (this.postAttempts) this.phase.close();
      if (this.ownershipBlocked || this.tickets.some(ticket => ticket.response?.body?.locked)) {
        this.ownershipBlocked = true;
        await new Promise<void>(() => undefined); // Unknown physical ownership retains the original charge.
      }
      this.operation.signal.removeEventListener("abort", this.abort); this.operation.stop("complete");
      // Retained flows may keep this owner for counters. Drop every physical
      // handle and settled promise (including raw cleanup rejection reasons)
      // only AFTER all work and original locks retire, before the input root.
      for (const ticket of this.tickets) {
        ticket.response = undefined; ticket.input = undefined;
        ticket.cancellation = undefined; ticket.work = undefined;
      }
      retireMusicCoverVerification(this); genuine.delete(this);
      if (this.prepared) preparedPosts.delete(this.prepared);
      this.prepared = undefined; this.finalRead = undefined; this.decision = undefined;
      this.controlPhase = undefined; this.activeOperation = undefined;
      if (this.cleanupFailed) musicCoverUnavailable();
    })();
    return this.closing;
  }
  snapshot(): Snapshot { return Object.freeze({ ordinary: this.ordinary, mandatory: this.mandatory,
    ordinaryActive: Number(this.active[0]), mandatoryActive: Number(this.active[1]), closed: this.closed,
    cleanupFailed: this.cleanupFailed, ownershipBlocked: this.ownershipBlocked, postAttempts: this.postAttempts }); }
}

// One registered finalizer waits for the terminal dispatch decision, never an
// initially empty ticket list. Public delivery does not join either retirement.
export function runMiniMaxMusicCoverComposition<T>(input: SealedMusicCoverInput,
  work: (owner: MiniMaxMusicCoverControl, installFinalizer: (finish: () => Promise<void>) => void) => Promise<T>) {
  let resolve!: () => void, reject!: (error: Error) => void, decide!: () => void;
  let owner: MiniMaxMusicCoverControl | undefined, finalizer: (() => Promise<void>) | undefined;
  const retired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void retired.catch(() => undefined);
  const decision = new Promise<void>(yes => { decide = yes; });
  const phase = claimMiniMaxMusicCoverControl(input, retired, () => owner?.cancel());
  owner = new MiniMaxMusicCoverControl(ownerToken, phase, decide);
  const current = owner;
  const finalization = decision.then(async () => {
    await current.retireOrdinary();
    try { await finalizer?.(); } finally { finalizer = undefined; }
  });
  void finalization.catch(() => undefined);
  const physical = Promise.resolve().then(() => work(current, finish => {
    if (finalizer || current.snapshot().postAttempts) musicCoverUnavailable();
    finalizer = finish;
  }));
  const result = current.operation.wait(physical);
  void result.catch(() => undefined);
  const seal = () => current.sealOrdinary();
  void physical.then(seal, seal).then(async () => {
    let failed = false;
    try { await finalization; } catch { failed = true; }
    try { await current.finish(); } catch { failed = true; }
    if (failed) reject(new Error("cover composition cleanup failed")); else resolve();
  });
  return Object.freeze({ result, retired, snapshot: () => current.snapshot() });
}

export function runMiniMaxMusicCoverControls<T>(input: SealedMusicCoverInput, work: (owner: MiniMaxMusicCoverControl) => Promise<T>) {
  let resolve!: () => void, reject!: (reason: unknown) => void, owner: MiniMaxMusicCoverControl | undefined;
  const retired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void retired.catch(() => undefined);
  // Synchronous genuine-handle/unused/live/hash-settled validation and ROOT
  // registration precede creation of the control graph or work callback.
  const phase = claimMiniMaxMusicCoverControl(input, retired, () => owner?.cancel());
  owner = new MiniMaxMusicCoverControl(ownerToken, phase);
  const current = owner;
  const physical = Promise.resolve().then(() => work(current));
  // Register public settlement before successful input closure cancels the
  // operation signal. Cleanup remains a separately observed physical result.
  const result = current.operation.wait(physical);
  void physical.then(() => current.finish(), () => current.finish()).then(resolve,
    () => reject(new Error("cover control cleanup failed")));
  void result.catch(() => undefined);
  return Object.freeze({ result, retired, snapshot: () => current.snapshot() });
}

export function coverControlHeaders(headers: Headers): void { assertSearchHeaders(headers, true); }

export async function readCoverControlRequest(request: Request): Promise<unknown> {
  let input: InputRetirement | undefined;
  try { return await readSearchJson(request, request.signal, "control", owner => { input = owner; }); }
  finally { await input?.retired.catch(() => undefined); }
}
