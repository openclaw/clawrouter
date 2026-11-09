import { identityJsonProfiles, isAccessDenial, parseAccessJson, type UserSourceCounts } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { budgetFields, effectiveBudgetPolicy } from "./budget-overrides.ts";
import { HttpError } from "./utils.ts";
import type { AccessPolicy, BudgetOverride } from "./types";
import type { AdmissionResult } from "./authority-admission.ts";

export const identityHeader = "x-clawrouter-identity-admission";
export const identityVersion = "v1";
export type IdentityProfile = "record" | "complete";
type Kind = "limit" | "protocol" | "transport" | "cleanup";
const failures = new WeakSet<object>();
export function identityFailure(kind: Kind): HttpError {
  const error = new HttpError(503, "identity_admission_unavailable", `Identity admission failed (${kind})`);
  failures.add(error); return error;
}
export function isIdentityFailure(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && failures.has(error);
}
const fail: (kind: Kind) => never = kind => { throw identityFailure(kind); };
export type IdentitySourceBudget = UserSourceCounts & { bytes: number; text: number };
export function identitySourceBudget(): IdentitySourceBudget {
  return { bytes: 0, text: 0, values: 0, containers: 0, members: 0, entries: 0, units: 0 };
}
export function identityUtf8(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
  }
  return bytes;
}
export function admitIdentityBytes(budget: IdentitySourceBudget, bytes: number, maximum = 1048576): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum || bytes > 2097152 - budget.bytes) fail("limit");
  budget.bytes += bytes;
}
export function admitIdentityText(text: string, budget: IdentitySourceBudget, profile: IdentityProfile = "record"): void {
  if (typeof text !== "string" || text.length > identityJsonProfiles[profile].wire || text.length > 2097152 - budget.text) fail("limit");
  budget.text += text.length;
}
export function parseIdentity(text: string, budget: IdentitySourceBudget, profile: IdentityProfile = "record"): unknown {
  admitIdentityText(text, budget, profile);
  try { return parseAccessJson(text, profile === "record" ? "identity_record" : "identity_complete", budget); }
  catch (error) { if (isAccessDenial(error)) fail("limit"); throw error; } // Ordinary malformed JSON retains its existing caller mapping.
}

// Closed prospective JSON visitor: no key vector, clone, encoding or serializer
// before the full occurrence/escaped-byte plan passes. Shared aliases count again.
export function identityPlan(profile: IdentityProfile = "complete") {
  const p = identityJsonProfiles[profile], maximum = p.wire, counts = identitySourceBudget();
  const add = (text: number, bytes = text) => {
    counts.text += text; counts.bytes += bytes;
    if (counts.text > maximum || counts.bytes > maximum) fail("limit");
  };
  const string = (text: string, key = false) => {
    if (text.length > (key ? 1024 : 1048576) || (counts.units += text.length) > p.units) fail("limit");
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
    if (++counts.values > p.values) fail("limit");
    if (typeof value === "string") return string(value);
    if (value === null || value === undefined || typeof value === "function" || typeof value === "symbol") { add(4); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number") { add(Number.isFinite(value) ? String(value).length : 4); return; }
    if (typeof value !== "object" || depth >= p.depth || ++counts.containers > p.containers) fail("limit");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("protocol");
    const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJson && (!Object.hasOwn(toJson, "value") || typeof toJson.value === "function")) fail("protocol");
    add(2); let first = true;
    if (array) {
      for (let i = 0; i < value.length; i++) {
        if (++counts.entries > p.entries || counts.entries + counts.members > p.combined) fail("limit");
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
      if (++counts.members > p.members || counts.members + counts.entries > p.combined) fail("limit");
      if (!first) add(1); first = false;
      string(key, true); add(1); item(child, depth + 1);
    }
  };
  const object = (depth: number, fields: (field: (key: string, value: unknown, nested?: () => void) => void) => void) => {
    if (depth >= p.depth || ++counts.values > p.values || ++counts.containers > p.containers) fail("limit");
    add(2); let first = true;
    fields((key, value, nested) => {
      if (!nested && (value === undefined || typeof value === "function" || typeof value === "symbol")) return;
      if (++counts.members > p.members || counts.members + counts.entries > p.combined) fail("limit");
      if (!first) add(1); first = false;
      string(key, true); add(1); if (nested) nested(); else item(value, depth + 1);
    });
  };
  const array = (depth: number, elements: (entry: (value: unknown, nested?: () => void) => void) => void) => {
    if (depth >= p.depth || ++counts.values > p.values || ++counts.containers > p.containers) fail("limit");
    add(2); let first = true;
    elements((value, nested) => {
      if (++counts.entries > p.entries || counts.entries + counts.members > p.combined) fail("limit");
      if (!first) add(1); first = false;
      if (nested) nested(); else item(value, depth + 1);
    });
  };
  return { item, add, string, object, array, counts };
}

export function admitIdentity(value: unknown, profile: IdentityProfile = "complete"): void {
  identityPlan(profile).item(value, 0);
}
export function identityJson(value: unknown, profile: IdentityProfile = "complete"): string {
  admitIdentity(value, profile);
  const text = JSON.stringify(value);
  if (typeof text !== "string") fail("protocol");
  return text;
}
export function copyIdentity<T>(value: T): T { admitIdentity(value, "record"); return structuredClone(value); }
export function admitIdentityCount(count: number, maximum: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) fail("limit");
}
// Semantic positions only. An unknown metadata field named candidates/pools is
// ordinary JSON; it never inherits these actual admission-container quotas.
export function admitAdmission(value: AdmissionResult): void {
  admitIdentity(value);
  admitIdentityCount(value.connections.length, 128);
  let pools = 0, candidates = 0;
  for (const key in value.pools) if (Object.hasOwn(value.pools, key)) {
    if (++pools > 128) fail("limit");
    const length = Math.max(value.pools[key].keys.length, value.snapshots?.[key]?.candidates.length ?? 0);
    admitIdentityCount(length, 256); candidates += length;
  }
  // Snapshots without a pool are still actual candidate containers.
  for (const key in value.snapshots) if (Object.hasOwn(value.snapshots, key) && !Object.hasOwn(value.pools, key)) {
    if (++pools > 128) fail("limit");
    const length = value.snapshots![key].candidates.length;
    admitIdentityCount(length, 256); candidates += length;
  }
  admitIdentityCount(candidates, 1024);
}
export function admittedEffectivePolicy(id: string, policy: AccessPolicy, overrides?: Record<string, BudgetOverride>): AccessPolicy {
  admitIdentity(policy, "record");
  const override = policy.budgetScope === "principal" ? overrides?.[id] : undefined;
  if (!override) return policy;
  admitIdentity(override, "record");
  identityPlan().object(0, field => {
    for (const key in policy) if (Object.hasOwn(policy, key) && key !== "budgetOverride") {
      field(key, budgetFields.includes(key as typeof budgetFields[number]) && Object.hasOwn(override, key)
        ? override[key as typeof budgetFields[number]] : (policy as unknown as Record<string, unknown>)[key]);
    }
    for (const key of budgetFields) if (!Object.hasOwn(policy, key) && Object.hasOwn(override, key)) field(key, override[key]);
    field("budgetOverride", override);
  });
  return effectiveBudgetPolicy(id, policy, overrides);
}

export function identityActual<T>(start: () => Promise<T>): Promise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const actual = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try { Promise.resolve(start()).then(resolve, () => reject(identityFailure("transport"))); }
  catch { reject(identityFailure("transport")); }
  return actual;
}
function wait<T>(actual: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(identityFailure("transport")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    actual.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(identityFailure("transport")); });
  });
}

// Original body only. The default reader is a cancellation owner, never a read
// fallback. Failed FIRST cancellation is observed separately from retirement.
class IdentitySource {
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
          try { Promise.resolve(this.reader!.cancel("identity admission stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
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
    })().then(resolve, () => reject(identityFailure("cleanup")));
    return this.ending;
  }
  async text(budget: IdentitySourceBudget, signal?: AbortSignal, profile: IdentityProfile = "complete"): Promise<string> {
    let eof = false, reason: Kind = "protocol";
    try {
      if (!this.body) fail(reason);
      reason = "transport"; if (!this.byob || !this.input) fail(reason);
      const maximum = identityJsonProfiles[profile].wire;
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), text = "", reads = 0, wire = 0;
      const decoder = new TextDecoder();
      const append = (part: string) => { if (part.length > maximum - text.length || part.length > 2097152 - budget.text - text.length) fail("limit"); text += part; };
      for (;;) {
        reason = "transport"; if (signal?.aborted) fail(reason);
        reason = "limit"; if (reads++ >= 8192) fail(reason);
        reason = "transport";
        const part = await wait(this.input.read(() => identityActual(() => (this.reader as ReadableStreamBYOBReader).read(backing))), signal);
        reason = "limit";
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384) fail(reason);
          if ((wire += part.value.byteLength) > maximum) fail("limit");
          admitIdentityBytes(budget, part.value.byteLength, maximum);
          append(decoder.decode(part.value, { stream: !part.done }));
          backing = new Uint8Array(part.value.buffer);
        }
        if (part.done) { if (!part.value) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) fail(reason);
      }
      return text;
    } catch (error) { if (isIdentityFailure(error)) throw error; throw identityFailure(reason); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}
function admitHeaders(headers: Headers): void {
  let count = 0, bytes = 0;
  for (const [key, value] of headers) {
    if (++count > 32 || identityUtf8(key) > 4096 - bytes) fail("limit"); bytes += identityUtf8(key);
    if (identityUtf8(value) > 4096 - bytes) fail("limit"); bytes += identityUtf8(value);
  }
}

export async function readIdentityKv<T>(start: () => Promise<ReadableStream<Uint8Array> | null>, budget: IdentitySourceBudget): Promise<T | null> {
  const body = await identityActual(start);
  if (body === null) return null;
  const owner = new IdentitySource(body);
  try { return parseIdentity(await owner.text(budget, undefined, "record"), budget) as T; }
  finally { await owner.retire("cancel"); }
}
export async function readIdentityRequest(request: Request, validPath: boolean): Promise<unknown> {
  const owner = new IdentitySource(request.body);
  try {
    if (!validPath || request.method !== "POST" || request.headers.get(identityHeader) !== identityVersion) fail("protocol");
    admitHeaders(request.headers);
    const budget = identitySourceBudget();
    return parseIdentity(await owner.text(budget, request.signal), budget, "complete");
  } finally { await owner.retire("cancel"); }
}
// Own the ORIGINAL response before status/header rejection. Late fetch, FIRST
// cancel (including rejection), pending read and unlock all remain joined.
export async function readIdentityResponse<T>(start: () => Promise<Response>, budget = identitySourceBudget(), signal?: AbortSignal,
  businessError?: (status: number, value: unknown) => never): Promise<T> {
  if (signal?.aborted) fail("transport");
  let owner: IdentitySource | undefined, response: Response | undefined, result: unknown;
  const actual = identityActual(start).then(value => { response = value; owner = new IdentitySource(value.body); });
  void actual.catch(() => undefined);
  try {
    await wait(actual, signal); admitHeaders(response!.headers);
    result = parseIdentity(await owner!.text(budget, signal), budget, "complete");
    if (!response!.ok) {
      const error = (result as { error?: { code?: unknown; message?: unknown } })?.error;
      if (response!.status === 503 && error?.code === "identity_admission_unavailable") {
        const kind = (["limit", "protocol", "transport", "cleanup"] as const).find(kind => error.message === `Identity admission failed (${kind})`);
        fail(kind ?? "protocol");
      }
      if (businessError) businessError(response!.status, result);
      throw new Error("Authority identity query failed");
    }
  } finally {
    const disposal = owner?.retire("cancel"); void disposal?.catch(() => undefined);
    try { await actual; } finally { await (owner?.retire("cancel") ?? disposal); }
  }
  if (signal?.aborted) fail("transport");
  return result as T;
}

// The SQL engine has already done its native work. COUNT and BLOB lengths gate
// JavaScript value materialization; no native-allocation claim is made here.
export function identitySqlRows(sql: SqlStorage, query: string, bindings: (string | number | null)[], budget: IdentitySourceBudget, maximumRows = 32768): unknown[] {
  const meta = Array.from(sql.exec<{ count: number; bytes: number; largest: number }>(
    `SELECT count(*) AS count, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes, coalesce(max(length(CAST(value AS BLOB))),0) AS largest FROM (${query})`, ...bindings))[0];
  admitIdentityCount(meta.count, maximumRows);
  if (meta.largest > 1048576) fail("limit");
  admitIdentityBytes(budget, meta.bytes, 2097152);
  const result: unknown[] = [];
  for (const row of sql.exec<{ value: string }>(query, ...bindings)) result.push(parseIdentity(row.value, budget));
  return result;
}

export async function readIdentityRaw(start: () => Promise<ReadableStream<Uint8Array> | null>, budget: IdentitySourceBudget): Promise<string | null> {
  const body = await identityActual(start);
  if (body === null) return null;
  const owner = new IdentitySource(body);
  try { return await owner.text(budget, undefined, "record"); }
  finally { await owner.retire("cancel"); }
}
