import { isAccessDenial, parseAccessJson, type UserSourceCounts } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { HttpError } from "./utils.ts";

export const assignmentSourceHeader = "x-clawrouter-assignment-materialization";
export const assignmentSourceVersion = "v1";
export const assignmentSourceLimit = 2097152, assignmentCompleteLimit = 1048576;
export type AssignmentFailureKind = "limit" | "protocol" | "transport" | "cleanup";
const failures = new WeakMap<object, AssignmentFailureKind>();
export function assignmentSourceFailure(kind: AssignmentFailureKind): HttpError {
  const error = new HttpError(503, "assignment_materialization_unavailable", `Assignment materialization failed (${kind})`);
  failures.set(error, kind); return error;
}
export function isAssignmentSourceFailure(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && failures.has(error);
}
const fail: (kind: AssignmentFailureKind) => never = (kind) => { throw assignmentSourceFailure(kind); };
export type AssignmentSourceBudget = UserSourceCounts & { bytes: number; text: number };
export function assignmentSourceBudget(): AssignmentSourceBudget {
  return { bytes: 0, text: 0, values: 0, containers: 0, members: 0, entries: 0, units: 0 };
}
export function admitAssignmentBytes(budget: AssignmentSourceBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > assignmentSourceLimit - budget.bytes) fail("limit");
  budget.bytes += bytes;
}
export function parseAssignmentSource(text: string, budget = assignmentSourceBudget()): unknown {
  if (typeof text !== "string" || text.length > assignmentSourceLimit - budget.text) fail("limit");
  budget.text += text.length;
  try { return parseAccessJson(text, "assignment_source", budget); }
  catch (error) { return fail(isAccessDenial(error) ? "limit" : "protocol"); }
}

// This meter has one closed assignment graph profile. It walks plain JSON data
// without first allocating keys/entries, a token vector or an encoded archive.
// Serialized bytes and UTF16 units are independent from decoded string units.
function jsonMeter(maximum: number, counts = assignmentSourceBudget()) {
  const add = (text: number, bytes = text) => {
    counts.text += text; counts.bytes += bytes;
    if (counts.text > maximum || counts.bytes > maximum) fail("limit");
  };
  const string = (text: string, key = false) => {
    if (text.length > (key ? 1024 : assignmentCompleteLimit) || (counts.units += text.length) > assignmentSourceLimit) fail("limit");
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(2, 4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(1, c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  const item = (value: unknown, depth: number): void => {
    if (++counts.values > 65536) fail("limit");
    if (typeof value === "string") return string(value);
    if (value === null || value === undefined || typeof value === "function" || typeof value === "symbol") { add(4); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number") { add(Number.isFinite(value) ? String(value).length : 4); return; }
    if (typeof value !== "object" || depth >= 16 || ++counts.containers > 16384) fail("limit");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("protocol");
    const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJson && (!Object.hasOwn(toJson, "value") || typeof toJson.value === "function")) fail("protocol");
    add(2); let first = true;
    if (array) {
      for (let i = 0; i < value.length; i++) {
        if (++counts.entries + counts.members > 32768) fail("limit");
        if (!first) add(1); first = false;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor && !Object.hasOwn(descriptor, "value")) fail("protocol");
        item(descriptor?.value, depth + 1);
      }
    } else for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) fail("protocol");
      const child: unknown = descriptor.value;
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (++counts.members + counts.entries > 32768) fail("limit");
      if (!first) add(1); first = false;
      string(key, true); add(1); item(child, depth + 1);
    }
  };
  const normalizedString = (value: string) => {
    if (typeof value !== "string") fail("protocol");
    add(2);
    let from = 0, to = value.length, length = 0;
    while (from < to && /\s/u.test(value[from])) from++;
    while (to > from && /\s/u.test(value[to - 1])) to--;
    for (let i = from; i < to; i++) {
      const code = value.codePointAt(i)!;
      const scalar = String.fromCodePoint(code).toLowerCase();
      if (code > 65535) i++;
      // Contextual final sigma changes spelling, not JSON size. All other
      // default lower-case expansions have the same scalar mapping here.
      length += scalar.length; counts.units += scalar.length;
      if (length > assignmentCompleteLimit || counts.units > assignmentSourceLimit) fail("limit");
      for (let j = 0; j < scalar.length; j++) {
        const c = scalar.charCodeAt(j);
        if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
        else if (c < 32) add(6);
        else if (c >= 0xd800 && c <= 0xdbff && j + 1 < scalar.length && scalar.charCodeAt(j + 1) >= 0xdc00 && scalar.charCodeAt(j + 1) <= 0xdfff) { add(2, 4); j++; }
        else if (c >= 0xd800 && c <= 0xdfff) add(6);
        else add(1, c < 128 ? 1 : c < 2048 ? 2 : 3);
      }
    }
  };
  return { item, add, string, normalizedString, counts };
}
export function admitAssignmentJson(value: unknown, stored = false): void {
  try { jsonMeter(stored ? assignmentCompleteLimit : assignmentSourceLimit).item(value, 0); }
  catch (error) { if (isAssignmentSourceFailure(error)) throw error; fail("protocol"); }
}
export function assignmentJsonText(value: unknown, stored = false): string {
  admitAssignmentJson(value, stored);
  try { const text = JSON.stringify(value); if (typeof text !== "string") fail("protocol"); return text; }
  catch { return fail("protocol"); }
}

// Before evaluator flatMaps/sets/normalization arrays, count every prospective
// occurrence, not just unique output. Each plan describes one retained sequence.
export function assignmentSequencePlan(): { add(value: unknown): void; normalized(value: string): void } {
  const meter = jsonMeter(assignmentSourceLimit);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  const entry = () => {
    if (++meter.counts.entries + meter.counts.members > 32768) fail("limit");
    if (meter.counts.entries > 1) meter.add(1);
  };
  return {
    add(value) { entry(); meter.item(value, 1); },
    normalized(value) { entry(); if (++meter.counts.values > 65536) fail("limit"); meter.normalizedString(value); },
  };
}

export function assignmentListingPlan(): (rule: object, name: string) => { ruleId: string; generatedGroup: string } {
  const meter = jsonMeter(assignmentSourceLimit);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  let rows = 0;
  return (rule, name) => {
    if (name.length > assignmentCompleteLimit - 11) fail("limit");
    const ruleId = name.slice("access/assignment-rules/".length), generatedGroup = `assignment.${ruleId}`;
    // Walk the prospective spread BEFORE allocating it. Match existing override
    // semantics and key order, including a stored ruleId/generatedGroup member.
    if (++meter.counts.entries + meter.counts.members > 32768 || ++meter.counts.values > 65536 || ++meter.counts.containers > 16384) fail("limit");
    if (rows++) meter.add(1); meter.add(2);
    let members = 0, generated = false;
    const field = (key: string, value: unknown) => {
      if (value === undefined || typeof value === "function" || typeof value === "symbol") return;
      if (++meter.counts.members + meter.counts.entries > 32768) fail("limit");
      if (members++) meter.add(1);
      meter.string(key, true); meter.add(1); meter.item(value, 2);
    };
    field("ruleId", Object.hasOwn(rule, "ruleId") ? (rule as { ruleId: unknown }).ruleId : ruleId);
    for (const key in rule) if (Object.hasOwn(rule, key) && key !== "ruleId") {
      if (key === "generatedGroup") { field(key, generatedGroup); generated = true; }
      else field(key, (rule as Record<string, unknown>)[key]);
    }
    if (!generated) field("generatedGroup", generatedGroup);
    return { ruleId, generatedGroup };
  };
}

export function assignmentMapPlan(): { retained(id: string, entry: unknown): void; matched(id: string, groups: string[], generated: string | undefined, revoke: boolean): void } {
  const meter = jsonMeter(assignmentSourceLimit);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  let count = 0;
  const member = (name: string) => {
    if (++meter.counts.members + meter.counts.entries > 32768) fail("limit");
    meter.string(name, true); meter.add(1);
  };
  const begin = (id: string) => { if (count++) meter.add(1); member(id); };
  const container = () => { if (++meter.counts.values > 65536 || ++meter.counts.containers > 16384) fail("limit"); meter.add(2); };
  return {
    retained(id, entry) { begin(id); meter.item(entry, 1); },
    matched(id, groups, generated, revoke) {
      begin(id); container(); member("groups"); container();
      let entries = 0;
      const group = (text: string) => {
        if (++meter.counts.entries + meter.counts.members > 32768 || ++meter.counts.values > 65536) fail("limit");
        if (entries++) meter.add(1); meter.normalizedString(text);
      };
      for (const text of groups) group(text);
      if (generated !== undefined) group(generated);
      meter.add(1); member("revokeOnLoss"); meter.item(revoke, 2);
    },
  };
}

// The caller supplies the SAME fixed-field projection used by the legacy
// revision writer. Only one row projection lives at a time, before capture.map.
export function admitAssignmentRevision<T>(rules: readonly T[], project: (rule: T) => unknown): void {
  const meter = jsonMeter(assignmentCompleteLimit);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  for (let i = 0; i < rules.length; i++) {
    if (++meter.counts.entries + meter.counts.members > 32768) fail("limit");
    if (i) meter.add(1);
    meter.item(project(rules[i]), 1);
  }
}

export function admitAssignmentCursor(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length) fail("protocol");
  if (value.length > 16384) fail("limit");
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
    if (bytes > 16384) fail("limit");
  }
}

// KV page envelopes are already native objects. Charge their serialized data
// shape before traversing metadata/keys; this is not a bound on native creation.
export function admitAssignmentPage(page: unknown, budget: AssignmentSourceBudget): void {
  try { jsonMeter(assignmentSourceLimit, budget).item(page, 0); }
  catch (error) { if (isAssignmentSourceFailure(error)) throw error; fail("protocol"); }
}
export function assignmentActual<T>(start: () => Promise<T>): Promise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const actual = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try { Promise.resolve(start()).then(resolve, () => reject(assignmentSourceFailure("transport"))); }
  catch { reject(assignmentSourceFailure("transport")); }
  return actual;
}

function wait<T>(actual: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(assignmentSourceFailure("transport")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    actual.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(assignmentSourceFailure("transport")); });
  });
}

// Original body only. The default reader is a cancellation owner, never a read
// fallback. Failed FIRST cancellation is observed separately from retirement.
class AssignmentSource {
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private input?: InputRetirement;
  private byob = false;
  private cleanupFailed = false;
  private first?: Promise<void>;
  private ending?: Promise<void>;
  private readonly body: ReadableStream<Uint8Array> | null;
  constructor(body: ReadableStream<Uint8Array> | null) {
    this.body = body;
    if (!body) return;
    try { this.reader = body.getReader({ mode: "byob" }); this.byob = true; }
    catch { try { this.reader = body.getReader(); } catch { /* Unknown ownership remains held. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        if (!this.first) {
          let settle!: () => void;
          this.first = new Promise<void>(resolve => { settle = resolve; });
          try { Promise.resolve(this.reader!.cancel("assignment materialization stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
          catch { this.cleanupFailed = true; settle(); }
        }
        return this.first;
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
      if (this.body && (!this.reader || this.body.locked)) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.first = undefined;
      if (this.cleanupFailed) fail("cleanup");
    })().then(resolve, () => reject(assignmentSourceFailure("cleanup")));
    return this.ending;
  }
  async text(budget: AssignmentSourceBudget, signal?: AbortSignal): Promise<string> {
    let eof = false, reason: AssignmentFailureKind = "protocol";
    try {
      if (!this.body) fail(reason);
      reason = "transport"; if (!this.byob || !this.input) fail(reason);
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), text = "", reads = 0;
      const decoder = new TextDecoder();
      const append = (part: string) => { if (part.length > assignmentSourceLimit - budget.text - text.length) fail("limit"); text += part; };
      for (;;) {
        reason = "transport"; if (signal?.aborted) fail(reason);
        reason = "limit"; if (reads++ >= 8192) fail(reason);
        reason = "transport";
        const part = await wait(this.input.read(() => assignmentActual(() => (this.reader as ReadableStreamBYOBReader).read(backing))), signal);
        reason = "limit";
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384) fail(reason);
          admitAssignmentBytes(budget, part.value.byteLength);
          append(decoder.decode(part.value, { stream: !part.done }));
          backing = new Uint8Array(part.value.buffer);
        }
        if (part.done) { if (!part.value) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) fail(reason);
      }
      return text;
    } catch { throw assignmentSourceFailure(reason); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}
function admitHeaders(headers: Headers): void {
  let count = 0, bytes = 0;
  for (const [key, value] of headers) {
    if (++count > 32 || key.length > 4096 - bytes) fail("limit"); bytes += key.length;
    if (value.length > 4096 - bytes) fail("limit"); bytes += value.length;
  }
}
export async function readAssignmentRequest(request: Request, path: string, admitted: boolean): Promise<unknown> {
  const owner = new AssignmentSource(request.body); // Fifth/invalid requests still OWN their original body.
  let result: unknown;
  try {
    if (!admitted) fail("limit");
    if (request.method !== "POST" || path !== "/users/reconcile-assignments"
      || request.headers.get(assignmentSourceHeader) !== assignmentSourceVersion) fail("protocol");
    admitHeaders(request.headers);
    const budget = assignmentSourceBudget();
    result = parseAssignmentSource(await owner.text(budget, request.signal), budget);
  } finally { await owner.retire("cancel"); }
  if (request.signal.aborted) fail("transport");
  return result;
}
export async function readAssignmentKv(start: () => Promise<ReadableStream<Uint8Array> | null>, budget: AssignmentSourceBudget): Promise<unknown> {
  const body = await assignmentActual(start);
  if (body === null) return null;
  const owner = new AssignmentSource(body);
  try { return parseAssignmentSource(await owner.text(budget), budget); }
  finally { await owner.retire("cancel"); }
}
export async function readAssignmentResponse(start: () => Promise<Response>, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) fail("transport");
  let owner: AssignmentSource | undefined, response: Response | undefined, result: unknown, hasFailure = false;
  let failure: HttpError | undefined;
  // Register the actual fetch before invocation. Its fulfillment immediately
  // acquires the original body, including a response arriving after abort.
  const actual = assignmentActual(start).then(value => { response = value; owner = new AssignmentSource(value.body); });
  void actual.catch(() => undefined);
  try {
    await wait(actual, signal);
    admitHeaders(response!.headers);
    const budget = assignmentSourceBudget();
    const value = parseAssignmentSource(await owner!.text(budget, signal), budget);
    if (!response!.ok) {
      const error = value && typeof value === "object" ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
      if (response!.status === 404 && error?.code === "unknown_user") throw new HttpError(404, "unknown_user", "access user not found");
      if ((response!.status === 400 || response!.status === 500) && error?.code === "authority_error") throw new HttpError(response!.status, "authority_error", "authority request failed");
      if (response!.status === 503 && error?.code === "assignment_materialization_unavailable") {
        for (const kind of ["limit", "protocol", "transport", "cleanup"] as const) if (error.message === `Assignment materialization failed (${kind})`) fail(kind);
      }
      fail("protocol");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("protocol");
    const envelope = value as { changed?: unknown; user?: unknown; matchedRuleIds?: unknown; retainedRuleIds?: unknown };
    if (typeof envelope.changed !== "boolean" || !envelope.user || typeof envelope.user !== "object"
      || !Array.isArray(envelope.matchedRuleIds) || !Array.isArray(envelope.retainedRuleIds)) fail("protocol");
    result = value;
  } catch (error) {
    hasFailure = true;
    failure = isAssignmentSourceFailure(error) || error instanceof HttpError ? error : assignmentSourceFailure("transport");
  } finally {
    // Start disposal BEFORE joining a potentially pending read. The reader's
    // own finally also uses this same memoized retirement.
    const disposal = owner?.retire("cancel");
    void disposal?.catch(() => undefined);
    await actual.catch(() => undefined);
    await (disposal ?? owner?.retire("cancel"));
  }
  if (hasFailure) throw failure;
  if (signal?.aborted) fail("transport");
  return result;
}
