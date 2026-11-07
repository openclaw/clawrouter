import { isAccessDenial, parseAccessJson, type UserSourceCounts } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { HttpError } from "./utils.ts";
import type { AccessPolicyEntry, BudgetOverride, Env, PolicyBinding } from "./types";

export const policyCollectionHeader = "x-clawrouter-policy-collection";
export const policyCollectionVersion = "v1";
export type PolicyFailureKind = "limit" | "protocol" | "transport" | "cleanup";
const failures = new WeakSet<object>();
export function policyCollectionFailure(kind: PolicyFailureKind): HttpError {
  const error = new HttpError(503, "policy_collection_unavailable", `Policy collection failed (${kind})`);
  failures.add(error); return error;
}
export function isPolicyCollectionFailure(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && failures.has(error);
}
const fail: (kind: PolicyFailureKind) => never = kind => { throw policyCollectionFailure(kind); };
export type PolicySourceBudget = UserSourceCounts & { bytes: number; text: number; readonly maximum: number };
export function policySourceBudget(caller = false): PolicySourceBudget {
  return { bytes: 0, text: 0, values: 0, containers: 0, members: 0, entries: 0, units: 0, maximum: caller ? 4194304 : 2097152 };
}
export function admitPolicyBytes(budget: PolicySourceBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2097152 || bytes > budget.maximum - budget.bytes) fail("limit");
  budget.bytes += bytes;
}
export function parsePolicyRecord(text: string, budget: PolicySourceBudget): unknown {
  if (typeof text !== "string" || text.length > 2097152 || text.length > budget.maximum - budget.text) fail("limit");
  budget.text += text.length;
  try { return parseAccessJson(text, "policy_collection", budget); }
  catch (error) { return fail(isAccessDenial(error) ? "limit" : "protocol"); }
}

// Closed JSON accounting, before copying/encoding/serialization. Full unknown
// fields count. This is an operational representation bound, not measured heap.
function jsonMeter(maximum: number, counts = policySourceBudget()) {
  const add = (text: number, bytes = text) => {
    counts.text += text; counts.bytes += bytes;
    if (counts.text > maximum || counts.bytes > maximum) fail("limit");
  };
  const string = (text: string, key = false) => {
    if (text.length > (key ? 1024 : 1048576) || (counts.units += text.length) > 2097152) fail("limit");
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
  const object = (depth: number, fields: (field: (key: string, value: unknown, nested?: () => void) => void) => void) => {
    if (depth >= 16 || ++counts.values > 65536 || ++counts.containers > 16384) fail("limit");
    add(2); let first = true;
    fields((key, value, nested) => {
      if (!nested && (value === undefined || typeof value === "function" || typeof value === "symbol")) return;
      if (++counts.members + counts.entries > 32768) fail("limit");
      if (!first) add(1); first = false;
      string(key, true); add(1); if (nested) nested(); else item(value, depth + 1);
    });
  };
  return { item, add, string, object, counts };
}

export function admitPolicyJson(value: unknown): void {
  try { jsonMeter(2097152).item(value, 0); }
  catch (error) { if (isPolicyCollectionFailure(error)) throw error; fail("protocol"); }
}
export function policyJsonText(value: unknown): string {
  admitPolicyJson(value);
  try { const text = JSON.stringify(value); if (typeof text !== "string") fail("protocol"); return text; }
  catch { return fail("protocol"); }
}
export function policyId(value: unknown): asserts value is string {
  if (typeof value !== "string") fail("protocol");
  if (value.length > 1024) fail("limit");
}
export function admitPolicyPrincipals(values: readonly { principalId: string }[]): void {
  if (!Array.isArray(values)) fail("protocol");
  if (values.length > 1024) fail("limit");
  for (const value of values) policyId(value?.principalId);
}
export function admitPolicyIds(values: readonly string[]): void {
  if (!Array.isArray(values)) fail("protocol");
  admitPolicyJson(values);
  const ids = new Set<string>();
  for (const id of values) { policyId(id); if (!ids.has(id) && ids.size === 2048) fail("limit"); ids.add(id); }
}
export function admitPolicyBindings(values: readonly PolicyBinding[]): void {
  if (!Array.isArray(values)) fail("protocol");
  if (values.length > 4096) fail("limit");
  for (const value of values) {
    // Invalid unmatched raw bindings retain their old ignore path; only resource
    // admission precedes the owner's RAW match and canonical marker decisions.
    if (typeof value?.principalId === "string") policyId(value.principalId);
    if (typeof value?.policyId === "string") policyId(value.policyId);
  }
  admitPolicyJson(values);
}
// Sequence plans visit all prospective entries before the matching array/spread.
export function policySequencePlan(): (value: unknown) => void {
  const meter = jsonMeter(2097152);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  return value => {
    if (++meter.counts.entries + meter.counts.members > 32768) fail("limit");
    if (meter.counts.entries > 1) meter.add(1);
    meter.item(value, 1);
  };
}
export function policyActual<T>(start: () => Promise<T>): Promise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const actual = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try { Promise.resolve(start()).then(resolve, () => reject(policyCollectionFailure("transport"))); }
  catch { reject(policyCollectionFailure("transport")); }
  return actual;
}
function wait<T>(actual: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(policyCollectionFailure("transport")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    actual.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(policyCollectionFailure("transport")); });
  });
}

// Original body only. The default reader is a cancellation owner, never a read
// fallback. Failed FIRST cancellation is observed separately from retirement.
class PolicySource {
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
          try { Promise.resolve(this.reader!.cancel("policy collection stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
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
    })().then(resolve, () => reject(policyCollectionFailure("cleanup")));
    return this.ending;
  }
  async text(budget: PolicySourceBudget, signal?: AbortSignal): Promise<string> {
    let eof = false, reason: PolicyFailureKind = "protocol";
    try {
      if (!this.body) fail(reason);
      reason = "transport"; if (!this.byob || !this.input) fail(reason);
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), text = "", reads = 0, wire = 0;
      const decoder = new TextDecoder();
      const append = (part: string) => { if (part.length > 2097152 - text.length || part.length > budget.maximum - budget.text - text.length) fail("limit"); text += part; };
      for (;;) {
        reason = "transport"; if (signal?.aborted) fail(reason);
        reason = "limit"; if (reads++ >= 8192) fail(reason);
        reason = "transport";
        const part = await wait(this.input.read(() => policyActual(() => (this.reader as ReadableStreamBYOBReader).read(backing))), signal);
        reason = "limit";
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384) fail(reason);
          if ((wire += part.value.byteLength) > 2097152) fail("limit");
          admitPolicyBytes(budget, part.value.byteLength);
          append(decoder.decode(part.value, { stream: !part.done }));
          backing = new Uint8Array(part.value.buffer);
        }
        if (part.done) { if (!part.value) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) fail(reason);
      }
      return text;
    } catch { throw policyCollectionFailure(reason); }
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

const selectedPaths = new Set(["/resolve", "/initialize", "/policies/resolve", "/policies/initialize"]);
export function isPolicyCollectionPath(path: string): boolean { return selectedPaths.has(path); }
export function admitPolicyCall(path: string, body: unknown): void {
  admitPolicyJson(body);
  try {
    if (path === "/resolve") admitPolicyPrincipals((body as { principals: { principalId: string }[] }).principals);
    else if (path === "/policies/resolve") admitPolicyIds((body as { policyIds: string[] }).policyIds);
    else if (path === "/initialize") {
      if (!Array.isArray(body) || body.length > 1024) fail(Array.isArray(body) ? "limit" : "protocol");
      let bindings = 0;
      for (const seed of body) {
        policyId(seed?.principal?.principalId);
        if (Array.isArray(seed.bindings)) {
          admitPolicyBindings(seed.bindings);
          if ((bindings += seed.bindings.length) > 4096) fail("limit");
        }
      }
    } else if (path === "/policies/initialize") {
      const entries = Array.isArray(body) ? body : (body as { entries?: unknown })?.entries;
      if (!Array.isArray(entries)) fail("protocol");
      if (!Array.isArray(body) && typeof (body as { retainRequestContentDefault?: unknown }).retainRequestContentDefault !== "boolean") fail("protocol");
      const ids = new Set<string>();
      for (const entry of entries) { policyId(entry?.policyId); if (!ids.has(entry.policyId) && ids.size === 2048) fail("limit"); ids.add(entry.policyId); }
    } else fail("protocol");
  } catch (error) { if (isPolicyCollectionFailure(error)) throw error; fail("protocol"); }
}
export async function readPolicyRequest(request: Request, path: string): Promise<unknown> {
  const owner = new PolicySource(request.body); // Own even an invalid marker/method/path.
  let result: unknown;
  try {
    if (request.method !== "POST" || request.headers.get(policyCollectionHeader) !== policyCollectionVersion || !isPolicyCollectionPath(path)) fail("protocol");
    admitHeaders(request.headers);
    const budget = policySourceBudget(), text = await owner.text(budget, request.signal);
    const profile = path === "/resolve" ? "policy_principals" : path === "/initialize" ? "policy_bindings" : path === "/policies/resolve" ? "policy_ids" : "policy_seeds";
    try { result = parseAccessJson(text, profile); } catch (error) { fail(isAccessDenial(error) ? "limit" : "protocol"); }
    admitPolicyCall(path, result);
  } finally { await owner.retire("cancel"); }
  if (request.signal.aborted) fail("transport");
  return result;
}
export async function readPolicyResponse(start: () => Promise<Response>, signal?: AbortSignal, path = "/policies/resolve"): Promise<unknown> {
  if (signal?.aborted) fail("transport");
  let owner: PolicySource | undefined, response: Response | undefined, result: unknown;
  const actual = policyActual(start).then(value => { response = value; owner = new PolicySource(value.body); });
  void actual.catch(() => undefined);
  try {
    await wait(actual, signal);
    admitHeaders(response!.headers);
    // Preserve the existing generic query's PUBLIC 500 mapping, without retaining
    // its old raw response text/cause. Initialization uses the separate ACK owner.
    if (!response!.ok) throw Object.assign(new Error("Authority policy query failed"), { code: "policy_collection_query_failed", reason: "status" });
    const budget = policySourceBudget();
    const text = await owner!.text(budget, signal);
    try { result = parseAccessJson(text, path === "/resolve" ? "policy_binding_reply" : "policy_collection"); }
    catch (error) { fail(isAccessDenial(error) ? "limit" : "protocol"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) fail("protocol");
    const envelope = result as { initialized?: unknown; policies?: unknown; bindings?: unknown; missingPrincipals?: unknown; missingPolicyIds?: unknown };
    if (typeof envelope.initialized !== "boolean") fail("protocol");
    if (path === "/resolve") {
      admitPolicyBindings(envelope.bindings as PolicyBinding[]);
      admitPolicyPrincipals(envelope.missingPrincipals as { principalId: string }[]);
    } else {
      if (!Array.isArray(envelope.policies)) fail("protocol");
      for (const entry of envelope.policies) policyId(entry?.policyId);
      admitPolicyIds(envelope.missingPolicyIds as string[]);
    }
  } finally {
    const disposal = owner?.retire("cancel"); void disposal?.catch(() => undefined);
    await actual.catch(() => undefined);
    await (disposal ?? owner?.retire("cancel"));
  }
  if (signal?.aborted) fail("transport");
  return result;
}

function admitCursor(cursor: unknown): asserts cursor is string {
  if (typeof cursor !== "string" || !cursor.length) fail("protocol");
  if (cursor.length > 16384) fail("limit");
  let bytes = 0;
  for (let i = 0; i < cursor.length; i++) {
    const c = cursor.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < cursor.length && cursor.charCodeAt(i + 1) >= 0xdc00 && cursor.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
    if (bytes > 16384) fail("limit");
  }
}
export class PolicyCollection {
  private readonly source = policySourceBudget(true);
  private pages = 0;
  private keys = 0;
  private bindings = 0;
  constructor(email?: string, groups?: readonly string[]) {
    // Access calls this BEFORE groups.map, principal objects or deduplication.
    if (groups !== undefined) {
      if (!Array.isArray(groups)) fail("protocol");
      if (groups.length + 1 > 1024) fail("limit");
      policyId(email);
      for (const group of groups) policyId(group);
    }
  }
  async read(env: Env, key: string): Promise<Record<string, unknown> | null> {
    const body = await policyActual(() => env.POLICY_KV.get(key, "stream"));
    if (body === null) return null;
    const owner = new PolicySource(body);
    try { return parsePolicyRecord(await owner.text(this.source), this.source) as Record<string, unknown> | null; }
    finally { await owner.retire("cancel"); }
  }
  async listBindings(env: Env, prefix: string): Promise<PolicyBinding[]> {
    const values: PolicyBinding[] = [], plan = policySequencePlan();
    let cursor: string | undefined;
    do {
      if (++this.pages > 4096) fail("limit");
      const page = await policyActual(() => env.POLICY_KV.list({ prefix, cursor, limit: 64 }));
      // Native page allocation is outside this claim. Full page metadata and
      // key shape are charged conservatively before keys/metadata are traversed.
      try { jsonMeter(this.source.maximum, this.source).item(page, 0); }
      catch (error) { if (isPolicyCollectionFailure(error)) throw error; fail("protocol"); }
      if (!Array.isArray(page.keys) || typeof page.list_complete !== "boolean") fail("protocol");
      if (page.keys.length > 64 || page.keys.length > 4096 - this.keys) fail("limit");
      this.keys += page.keys.length;
      if (!page.list_complete) admitCursor(page.cursor);
      for (const key of page.keys) {
        if (!key || typeof key.name !== "string") fail("protocol");
        const value = await this.read(env, key.name);
        if (++this.bindings > 4096) fail("limit");
        if (value) { plan(value); values.push(value as unknown as PolicyBinding); }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    admitPolicyBindings(values);
    return values;
  }
}

// Only referenced overrides are admitted; an unreferenced map is not copied or
// enumerated. The COMPLETE referenced unknown graph and effective result count.
export function admitEffectivePolicies(entries: AccessPolicyEntry[], ids: string[], overrides?: Record<string, BudgetOverride>): void {
  admitPolicyJson(entries); admitPolicyIds(ids);
  const meter = jsonMeter(2097152);
  meter.add(2); meter.counts.values++; meter.counts.containers++;
  for (const id of ids) {
    const entry = entries.find(value => value.policyId === id);
    if (!entry?.policy.enabled) continue;
    const policy = entry.policy, override = policy.budgetScope === "principal" ? overrides?.[id] : undefined;
    if (override) admitPolicyJson(override);
    if (++meter.counts.entries + meter.counts.members > 32768) fail("limit");
    if (meter.counts.entries > 1) meter.add(1);
    meter.object(1, field => {
      for (const key in entry) if (Object.hasOwn(entry, key)) {
        if (key !== "policy" || !override) { field(key, (entry as unknown as Record<string, unknown>)[key]); continue; }
        meterPolicy(field);
      }
    });
    function meterPolicy(field: (key: string, value: unknown, nested?: () => void) => void) {
      field("policy", undefined, () => meter.object(2, member => {
        const caps = ["dailyBudgetMicros", "weeklyBudgetMicros", "monthlyBudgetMicros"] as const;
        for (const key in policy) if (Object.hasOwn(policy, key)) {
          const value = key === "budgetOverride" ? override : caps.some(cap => cap === key) && Object.hasOwn(override!, key)
            ? (override as unknown as Record<string, unknown>)[key] : (policy as unknown as Record<string, unknown>)[key];
          member(key, value);
        }
        for (const cap of caps) if (!Object.hasOwn(policy, cap) && Object.hasOwn(override!, cap)) member(cap, override![cap]);
        if (!Object.hasOwn(policy, "budgetOverride")) member("budgetOverride", override);
      }));
    }
  }
}
