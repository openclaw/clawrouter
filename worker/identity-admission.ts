import { identityJsonProfiles, isAccessDenial, parseAccessJson, type UserSourceCounts, type IdentityEnvelope } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { budgetFields, effectiveBudgetPolicy } from "./budget-overrides.ts";
import { HttpError } from "./utils.ts";
import type { AccessPolicy, BudgetOverride, GrantRoutingPolicy } from "./types";
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
const sourceFields = ["bytes", "text", "values", "containers", "members", "entries", "units"] as const;
const sourceLimits: IdentitySourceBudget = { bytes: 2097152, text: 2097152, values: 131072,
  containers: 32768, members: 65536, entries: 32768, units: 2097152 };
// New private continuation metadata only. Existing intake budgets are unchanged.
function checkIdentitySource(value: unknown): asserts value is IdentitySourceBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("protocol");
  let fields = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (!(sourceFields as readonly string[]).includes(key)) fail("protocol");
    fields++;
  }
  if (fields !== 7) fail("protocol");
  for (const key of sourceFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0 || descriptor.value > sourceLimits[key]) fail("limit");
  }
  const source = value as IdentitySourceBudget;
  if (source.members + source.entries > 98304) fail("limit");
}
export function identitySourceSnapshot(value: unknown): IdentitySourceBudget {
  checkIdentitySource(value);
  return { bytes: value.bytes, text: value.text, values: value.values, containers: value.containers,
    members: value.members, entries: value.entries, units: value.units };
}
export function checkIdentitySourceAddition(left: IdentitySourceBudget, right: IdentitySourceBudget): void {
  for (const key of sourceFields) {
    if (!Number.isSafeInteger(right[key]) || right[key] < 0 || right[key] > sourceLimits[key] - left[key]) fail("limit");
  }
  if (left.members + left.entries + right.members + right.entries > 98304) fail("limit");
}
export function addIdentitySources(left: IdentitySourceBudget, right: IdentitySourceBudget): IdentitySourceBudget {
  checkIdentitySourceAddition(left, right);
  return { bytes: left.bytes + right.bytes, text: left.text + right.text, values: left.values + right.values,
    containers: left.containers + right.containers, members: left.members + right.members,
    entries: left.entries + right.entries, units: left.units + right.units };
}
export function advanceIdentitySource(owner: IdentitySourceBudget, sent: IdentitySourceBudget,
  producer: IdentitySourceBudget, reply: IdentitySourceBudget): void {
  checkIdentitySource(producer);
  for (const key of sourceFields) if (owner[key] !== sent[key] || producer[key] < sent[key]) fail("protocol");
  checkIdentitySourceAddition(producer, reply);
  // The producer already includes sent. Replace once, then add ORIGINAL reply
  // consumption; neither prospective serialization nor sent gets double credit.
  for (const key of sourceFields) owner[key] = producer[key] + reply[key];
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
export function parseIdentity(text: string, budget: IdentitySourceBudget, profile: IdentityProfile = "record", envelope?: IdentityEnvelope, wire?: (start: number, end: number) => number): unknown {
  admitIdentityText(text, budget, profile);
  try { return parseAccessJson(text, profile === "record" ? "identity_record" : "identity_complete", budget, envelope, wire); }
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

// Private derived-string planning without joining borrowed components. This is
// not a new closure/product in ordinary identityPlan or the PR974 factory path.
export function planPrivateIdentityString(plan: ReturnType<typeof identityPlan>, parts: Iterable<string>, profile: IdentityProfile = "complete"): void {
  const p = identityJsonProfiles[profile], counts = plan.counts, add = plan.add;
  if (++counts.values > p.values) fail("limit");
  let units = 0, high = false;
  add(2);
  for (const part of parts) {
    units += part.length; counts.units += part.length;
    if (units > 1048576 || counts.units > p.units) fail("limit");
    for (let index = 0; index < part.length; index++) {
      const c = part.charCodeAt(index);
      if (high) {
        high = false;
        if (c >= 0xdc00 && c <= 0xdfff) { add(2, 4); continue; }
        add(6);
      }
      if (c >= 0xd800 && c <= 0xdbff) high = true;
      else if (c >= 0xdc00 && c <= 0xdfff || c < 32 && c !== 8 && c !== 9 && c !== 10 && c !== 12 && c !== 13) add(6);
      else if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else add(1, c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  }
  if (high) add(6);
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
  for (const record of [value.credential?.credential, value.policy?.policy, value.owner?.record, value.selection?.selected?.grant]) if (record != null) admitIdentity(record, "record");
  for (const connection of value.connections) admitIdentity(connection, "record");
  for (const key in value.snapshots) if (Object.hasOwn(value.snapshots, key)) for (const candidate of value.snapshots![key].candidates) if (candidate.grant != null) admitIdentity(candidate.grant, "record");
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
// Call ONLY with the fresh return of the existing normalizer. Its __proto__
// assignment consumed the original quota but emitted no own JSON property.
export function canonicalFreshIdentityRouting(routing: GrantRoutingPolicy): GrantRoutingPolicy {
  if (Array.isArray(Object.getPrototypeOf(routing.eligibleGrants))) Object.setPrototypeOf(routing.eligibleGrants, Object.prototype);
  if (Object.hasOwn(routing, "sharedGrants") && Array.isArray(Object.getPrototypeOf(routing.sharedGrants!))) Object.setPrototypeOf(routing.sharedGrants!, Object.prototype);
  return routing;
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

// Original-wire offsets for embedded records, including replacement-decoded
// UTF8. Each retained block is admitted before its <=16 KiB copy; the complete
// source ceiling bounds their sum. Discard with the reader after parsing.
export class IdentityWire {
  private blocks: Uint8Array[] = [];
  private block = 0; private offset = 0; private bytes = 0; private units = 0;
  add(bytes: Uint8Array): void { if (bytes.byteLength) this.blocks.push(bytes.slice()); }
  private peek(ahead = 0): number | undefined {
    let block = this.block, offset = this.offset + ahead;
    while (block < this.blocks.length && offset >= this.blocks[block].length) offset -= this.blocks[block++].length;
    return this.blocks[block]?.[offset];
  }
  private advance(target: number): number {
    while (this.units < target) {
      const first = this.peek(); if (first === undefined) fail("protocol");
      let size = 1, expected = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
      for (; size < expected; size++) {
        const next = this.peek(size), low = size === 1 && first === 0xe0 ? 0xa0 : size === 1 && first === 0xf0 ? 0x90 : 0x80;
        const high = size === 1 && first === 0xed ? 0x9f : size === 1 && first === 0xf4 ? 0x8f : 0xbf;
        if (next === undefined || next < low || next > high) break;
      }
      const bom = this.bytes === 0 && size === 3 && first === 0xef && this.peek(1) === 0xbb && this.peek(2) === 0xbf;
      this.units += bom ? 0 : size === expected && expected === 4 ? 2 : 1;
      this.bytes += size; this.offset += size;
      while (this.block < this.blocks.length && this.offset >= this.blocks[this.block].length) this.offset -= this.blocks[this.block++].length;
    }
    if (this.units !== target) fail("protocol");
    return this.bytes;
  }
  clear(): void { this.blocks.length = 0; }
  span = (start: number, end: number): number => { const from = this.advance(start); return this.advance(end) - from; };
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
  async text(budget: IdentitySourceBudget, signal?: AbortSignal, profile: IdentityProfile = "complete", wire?: IdentityWire): Promise<string> {
    let eof = false, reason: Kind = "protocol";
    try {
      if (!this.body) fail(reason);
      reason = "transport"; if (!this.byob || !this.input) fail(reason);
      const maximum = identityJsonProfiles[profile].wire;
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), text = "", reads = 0, wireBytes = 0;
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
          if ((wireBytes += part.value.byteLength) > maximum) fail("limit");
          admitIdentityBytes(budget, part.value.byteLength, maximum);
          wire?.add(part.value);
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
export function admitIdentityHeaders(headers: Headers): void {
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
    admitIdentityHeaders(request.headers);
    const budget = identitySourceBudget();
    const wire = new IdentityWire();
    return parseIdentity(await owner.text(budget, request.signal, "complete", wire), budget, "complete", new URL(request.url).pathname === "/materialize" ? "grant" : "generic", wire.span);
  } finally { await owner.retire("cancel"); }
}
// Own the ORIGINAL response before status/header rejection. Late fetch, FIRST
// cancel (including rejection), pending read and unlock all remain joined.
export async function readIdentityResponse<T>(start: () => Promise<Response>, budget = identitySourceBudget(), signal?: AbortSignal,
  businessError?: (status: number, value: unknown) => never, envelope: IdentityEnvelope = "identity"): Promise<T> {
  if (signal?.aborted) fail("transport");
  let owner: IdentitySource | undefined, response: Response | undefined, result: unknown;
  const actual = identityActual(start).then(value => { response = value; owner = new IdentitySource(value.body); });
  void actual.catch(() => undefined);
  try {
    await wait(actual, signal); admitIdentityHeaders(response!.headers);
    const wire = new IdentityWire();
    result = parseIdentity(await owner!.text(budget, signal, "complete", wire), budget, "complete", envelope, wire.span);
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
export function identitySqlRows(sql: SqlStorage, query: string, bindings: (string | number | null)[], budget: IdentitySourceBudget, maximumRows = 32768, materialize?: <T>(bytes: number, run: () => T) => T): unknown[] {
  const meta = Array.from(sql.exec<{ count: number; bytes: number; largest: number }>(
    `SELECT count(*) AS count, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes, coalesce(max(length(CAST(value AS BLOB))),0) AS largest FROM (${query})`, ...bindings))[0];
  admitIdentityCount(meta.count, maximumRows);
  if (meta.largest > 1048576) fail("limit");
  admitIdentityBytes(budget, meta.bytes, 2097152);
  if (materialize) return materialize(meta.bytes, () => {
    const result: unknown[] = [];
    for (const row of sql.exec<{ value: string }>(query, ...bindings)) result.push(parseIdentity(row.value, budget));
    return result;
  });
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

// Private bridge only: fold the ORIGINAL accepted SQL row stream directly.
// No history array, pair array, truncation or candidate-count cap.
export function foldIdentitySqlHistory(sql: SqlStorage, poolKey: string, budget: IdentitySourceBudget, materialize?: <T>(bytes: number, run: () => T) => T): Record<string, { count: number; lastMs: number }> {
  const query = "SELECT json_object('grant_key', grant_key, 'selected_count', selected_count, 'last_selected_ms', last_selected_ms) AS value FROM upstream_grant_selection WHERE pool_key = ?";
  const meta = Array.from(sql.exec<{ count: number; bytes: number; largest: number }>(`SELECT count(*) AS count, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes, coalesce(max(length(CAST(value AS BLOB))),0) AS largest FROM (${query})`, poolKey))[0];
  admitIdentityCount(meta.count, 32768);
  if (meta.largest > 1048576) fail("limit");
  checkIdentitySourceAddition(budget, { bytes: meta.bytes, text: 0, values: 4 * meta.count, containers: meta.count, members: 3 * meta.count, entries: 0, units: 0 });
  admitIdentityBytes(budget, meta.bytes, 2097152);
  const fold = () => {
    const counts: Record<string, { count: number; lastMs: number }> = Object.create(null);
    for (const row of sql.exec<{ value: string }>(query, poolKey)) {
      let value = parseIdentity(row.value, budget) as { grant_key: string; selected_count: number; last_selected_ms: number };
      counts[value.grant_key] = { count: value.selected_count, lastMs: value.last_selected_ms };
      value = undefined as never;
    }
    return counts;
  };
  return materialize ? materialize(meta.bytes, fold) : fold();
}

// Prospective generated state, before the unchanged normalizer constructs its
// defaults, windows, snapshot copies or fact objects. Unknown raw fields already
// consumed ORIGINAL source credit. This plan consumes no source credit.
export function admitGeneratedRuntime(value: unknown, plan: ReturnType<typeof identityPlan>, key: string, depth = 0, nested = false): void {
  const state = value as import("./types").GrantRuntimeState;
  if (!state || typeof state !== "object" || !Array.isArray(state.windows)) return; // unchanged normalizer owns invalid syntax
  if (!nested) plan.string(key, true);
  plan.object(depth, field => {
    field("status", state.status); field("observedAt", state.observedAt); field("source", state.source);
    field("cooldownUntil", state.cooldownUntil == null || !Number.isFinite(Date.parse(state.cooldownUntil)) ? null : state.cooldownUntil);
    field("lastSignal", state.lastSignal);
    field("grantRevision", typeof state.grantRevision === "string" && state.grantRevision.length <= 64 && Number.isFinite(Date.parse(state.grantRevision)) ? state.grantRevision : null);
    field("windows", undefined, () => plan.array(depth + 1, entry => {
      for (const window of state.windows) {
        if (!window) { entry(null); continue; }
        entry(undefined, () => plan.object(depth + 2, member => {
          if (window.observedAt && Number.isFinite(Date.parse(window.observedAt))) member("observedAt", window.observedAt);
          member("id", typeof window.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(window.id) ? window.id : window.kind);
          member("kind", window.kind);
          member("unit", typeof window.unit === "string" && window.unit.length <= 32 ? window.unit : null);
          member("window", typeof window.window === "string" && window.window.length <= 64 ? window.window : null);
          member("remaining", window.remaining ?? null); member("limit", window.limit ?? null);
          member("resetAt", window.resetAt != null && Number.isFinite(Date.parse(window.resetAt)) ? window.resetAt : null);
          if (window.models) member("models", window.models);
        }));
      }
    }));
    if (state.windowSnapshots) field("windowSnapshots", undefined, () => plan.object(depth + 1, snapshot => {
      for (const scope in state.windowSnapshots) if (Object.hasOwn(state.windowSnapshots, scope)) {
        const item = state.windowSnapshots[scope];
        snapshot(scope, undefined, () => plan.object(depth + 2, member => {
          member("observedAt", item.observedAt);
          member("ids", undefined, () => plan.array(depth + 3, entry => {
            if (Array.isArray(item.ids)) for (let i = 0; i < item.ids.length; i++) if (item.ids.indexOf(item.ids[i]) === i) entry(item.ids[i]);
          }));
        }));
      }
    }));
    for (const group of ["account", "extraUsage"] as const) {
      const facts = state[group];
      if (!facts || typeof facts !== "object") continue;
      const names = group === "account" ? ["email", "displayName", "rateLimitTier", "subscriptionStatus", "extraUsageEnabled"] : ["enabled", "usedCredits", "monthlyLimit", "utilization", "currency", "spendLimitReached"];
      const accepted = (name: string): boolean => {
        const v = (facts as unknown as Record<string, unknown>)[name];
        const boolean = name === "extraUsageEnabled" || name === "enabled" || name === "spendLimitReached";
        const numeric = name === "usedCredits" || name === "monthlyLimit" || name === "utilization";
        return boolean ? typeof v === "boolean" : numeric ? typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
          : typeof v === "string" && v.length <= 320 && !/[\u0000-\u001f\u007f]/.test(v);
      };
      if (names.some(accepted)) field(group, undefined, () => plan.object(depth + 1, member => { for (const name of names) if (accepted(name)) member(name, (facts as unknown as Record<string, unknown>)[name]); }));
    }
  });
}

// Admitted JSON only. Compare without a second complete serialization or key
// vector. The recursion uses the same finite depth channel as the JSON visitor.
export function equalAdmissionJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!equalAdmissionJson(left[i], right[i])) return false;
    return true;
  }
  let a = 0, b = 0;
  for (const key in left) if (Object.hasOwn(left, key)) {
    a++;
    if (!Object.hasOwn(right, key) || !equalAdmissionJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  }
  for (const key in right) if (Object.hasOwn(right, key)) b++;
  return a === b;
}

// Exact partial whole-result layout with one prospective normalized replacement.
// No output state/default/copy is constructed before this complete plan passes.
export function planPrivateRuntime(result: AdmissionResult, providerId: string, keys: string[], states: Record<string, import("./types").GrantRuntimeState>,
  nextKey: string, raw: unknown, hasAttachment: boolean): void {
  const plan = identityPlan();
  plan.object(0, field => {
    for (const key in result) if (Object.hasOwn(result, key) && key !== "pools") field(key, (result as unknown as Record<string, unknown>)[key]);
    field("pools", undefined, () => plan.object(1, pool => {
      for (const key in result.pools) if (Object.hasOwn(result.pools, key) && key !== providerId) pool(key, result.pools[key]);
      pool(providerId, undefined, () => plan.object(2, member => {
        member("keys", keys); member("hasAttachment", hasAttachment);
        member("states", undefined, () => plan.object(3, state => {
          for (const key in states) if (Object.hasOwn(states, key) && key !== nextKey) state(key, states[key]);
          state(nextKey, undefined, () => admitGeneratedRuntime(raw, plan, nextKey, 4, true));
        }));
      }));
    }));
  });
}
