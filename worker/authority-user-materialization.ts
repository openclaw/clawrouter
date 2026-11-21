import { isAccessDenial, parseAccessJson, type UserSourceCounts } from "./access-json.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { HttpError } from "./utils.ts";

export const userMaterializationHeader = "x-clawrouter-user-materialization";
export const userMaterializationVersion = "v1";
const sourceLimit = 2097152, completeLimit = 1048576;
type Kind = "limit" | "protocol" | "transport" | "cleanup";
export function userMaterializationFailure(kind: Kind): HttpError {
  return new HttpError(503, "user_materialization_unavailable", `User materialization failed (${kind})`);
}
const fail = (kind: Kind): never => { throw userMaterializationFailure(kind); };
export type UserRecordBudget = UserSourceCounts & { bytes: number; text: number };
export function userRecordBudget(): UserRecordBudget {
  return { bytes: 0, text: 0, values: 0, containers: 0, members: 0, entries: 0, units: 0 };
}
export function admitUserRecordBytes(budget: UserRecordBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > sourceLimit - budget.bytes) fail("limit");
  budget.bytes += bytes;
}
export function parseUserRecord(text: string, budget: UserRecordBudget): unknown {
  if (typeof text !== "string" || text.length > sourceLimit - budget.text) fail("limit");
  budget.text += text.length;
  return parse(text, "user_record", budget);
}
function parse(text: string, profile: "user_record" | "user_query" | "user_init", counts?: UserSourceCounts): unknown {
  try { return parseAccessJson(text, profile, counts); }
  catch (error) { return fail(isAccessDenial(error) ? "limit" : "protocol"); }
}

// One ORIGINAL stream. A default reader is cancellation-only. Retirement joins
// the actual read and FIRST cancellation; a locked/unknown owner never completes.
class UserSource {
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
    catch { try { this.reader = body.getReader(); } catch { /* Retained below. */ } }
    if (this.reader) this.input = inputRetirement({
      cancel: () => {
        if (!this.first) {
          let settle!: () => void;
          this.first = new Promise<void>(resolve => { settle = resolve; });
          try { Promise.resolve(this.reader!.cancel("user materialization stopped")).then(settle, () => { this.cleanupFailed = true; settle(); }); }
          catch { this.cleanupFailed = true; settle(); }
        }
        return this.first;
      },
      releaseLock: () => { try { this.reader!.releaseLock(); } catch { this.cleanupFailed = true; } },
    });
  }
  retire(kind: "eof" | "cancel"): Promise<void> {
    if (this.ending) return this.ending;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.ending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void this.ending.catch(() => undefined);
    void (async () => {
      if (this.input) await this.input.retire(kind);
      if (this.body && (!this.reader || this.body.locked)) await new Promise<never>(() => {});
      this.reader = undefined; this.input = undefined; this.first = undefined;
      if (this.cleanupFailed) fail("cleanup");
    })().then(resolve, () => reject(userMaterializationFailure("cleanup")));
    return this.ending;
  }
  async text(budget: UserRecordBudget): Promise<string> {
    let eof = false, reason: Kind = "transport";
    try {
      reason = "protocol"; if (!this.body) fail(reason);
      reason = "transport"; if (!this.byob || !this.input) fail("transport");
      let backing: Uint8Array<ArrayBuffer> = new Uint8Array(16384), text = "", reads = 0;
      const decoder = new TextDecoder(); // Original replacement/BOM semantics.
      const append = (part: string) => {
        if (part.length > sourceLimit - budget.text - text.length) fail("limit");
        text += part;
      };
      for (;;) {
        reason = "limit"; if (reads++ >= 8192) fail(reason);
        reason = "transport";
        const part = await this.input!.read(() => {
          try { return (this.reader as ReadableStreamBYOBReader).read(backing).catch(() => fail("transport")); }
          catch { return Promise.reject(userMaterializationFailure("transport")); }
        });
        reason = "limit";
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384) fail(reason);
          admitUserRecordBytes(budget, part.value.byteLength);
          append(decoder.decode(part.value, { stream: !part.done }));
          backing = new Uint8Array(part.value.buffer);
        }
        if (part.done) { if (!part.value) append(decoder.decode()); eof = true; break; }
        reason = "transport"; if (!backing.byteLength) fail(reason);
      }
      return text;
    } catch { throw userMaterializationFailure(reason); }
    finally { await this.retire(eof ? "eof" : "cancel"); }
  }
}

export async function readUserMaterializationRequest(request: Request, path: string): Promise<unknown> {
  const owner = new UserSource(request.body); // Own before rejecting selector/headers.
  try {
    if (request.headers.get(userMaterializationHeader) !== userMaterializationVersion
      || request.method !== "POST" || path !== "/users/resolve" && path !== "/users/initialize") fail("protocol");
    let count = 0, size = 0;
    for (const [key, value] of request.headers) {
      if (++count > 32 || key.length > 4096 - size) fail("limit"); size += key.length;
      if (value.length > 4096 - size) fail("limit"); size += value.length;
    }
    const budget = userRecordBudget();
    const text = await owner.text(budget);
    return parse(text, path === "/users/resolve" ? "user_query" : "user_init");
  } finally { await owner.retire("cancel"); }
}

export async function readUserKvRecord(start: () => Promise<ReadableStream<Uint8Array> | null>, budget: UserRecordBudget): Promise<unknown> {
  // Register and normalize the actual producer BEFORE invocation. No signal race,
  // timeout or detached late body: this facade always joins the original get.
  let resolve!: (owner: UserSource | null) => void, reject!: (error: unknown) => void;
  const actual = new Promise<UserSource | null>((yes, no) => { resolve = yes; reject = no; });
  void actual.catch(() => undefined);
  try { Promise.resolve(start()).then(body => { try { resolve(body === null ? null : new UserSource(body)); } catch { reject(userMaterializationFailure("transport")); } }, () => reject(userMaterializationFailure("transport"))); }
  catch { reject(userMaterializationFailure("transport")); }
  const owner = await actual;
  if (!owner) return null;
  try { return parseUserRecord(await owner.text(budget), budget); }
  finally { await owner.retire("cancel"); }
}

// Preflight the actual JSON data BEFORE stringify. No encoded archive, key list,
// normalization or projection. JSON omission/null/number/string escaping matches
// JSON.stringify for the plain data produced by SQL/KV and internal call sites.
export function admitUserJson(value: unknown, profile: "query" | "init" | "complete"): void {
  const complete = profile === "complete", maximum = complete ? completeLimit : sourceLimit;
  const maxValues = complete ? 8192 : 16384, maxContainers = complete ? 2048 : 4096, maxMembers = complete ? 4096 : 8192, maxEntries = complete ? 4096 : 8192;
  let bytes = 0, text = 0, values = 0, containers = 0, members = 0, entries = 0, units = 0, occurrences = 0;
  const add = (utf16: number, utf8 = utf16) => { text += utf16; bytes += utf8; if (text > maximum || bytes > maximum) fail("limit"); };
  const string = (value: string, key = false, email = false) => {
    if (value.length > (key || email ? 1024 : maximum) || (units += value.length) > maximum) fail("limit");
    add(2);
    for (let i = 0; i < value.length; i++) {
      const n = value.charCodeAt(i);
      if (n === 34 || n === 92 || n === 8 || n === 9 || n === 10 || n === 12 || n === 13) add(2);
      else if (n < 32) add(6);
      else if (n >= 0xd800 && n <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { add(2, 4); i++; }
      else if (n >= 0xd800 && n <= 0xdfff) add(6);
      else add(1, n < 128 ? 1 : n < 2048 ? 2 : 3);
    }
  };
  const visit = (item: unknown, depth: number, key = "", rootMember = false, row = false, email = false): void => {
    if (++values > maxValues) fail("limit");
    if (typeof item === "string") { string(item, false, email); return; }
    if (item === null || item === undefined || typeof item === "function" || typeof item === "symbol") { add(4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item !== "object" || depth >= 16 || ++containers > maxContainers) fail("limit");
    // Closed internal JSON data. Never invoke arbitrary toJSON or accessors during
    // admission and then invoke them again to serialize a different graph.
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail("protocol");
    const jsonMethod = Object.getOwnPropertyDescriptor(item, "toJSON");
    if (jsonMethod && (!Object.hasOwn(jsonMethod, "value") || typeof jsonMethod.value === "function")) fail("protocol");
    add(2); let first = true;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (++entries > maxEntries) fail("limit");
        const queryEmail = profile === "query" && rootMember && key === "emails", initRow = profile === "init" && depth === 0;
        if ((queryEmail || initRow) && ++occurrences > 4096) fail("limit");
        if (!first) add(1); first = false;
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor && !Object.hasOwn(descriptor, "value")) fail("protocol");
        visit(descriptor?.value, depth + 1, key, false, initRow, queryEmail);
      }
    } else for (const name in item) {
      if (!Object.hasOwn(item, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
      if (!Object.hasOwn(descriptor, "value")) fail("protocol");
      const child: unknown = descriptor.value;
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (++members > maxMembers) fail("limit");
      if (!first) add(1); first = false;
      string(name, true); add(1); visit(child, depth + 1, name, depth === 0, false, row && name === "email");
    }
  };
  try { visit(value, 0); } catch (error) { if (error instanceof HttpError) throw error; fail("protocol"); }
}
export function userJsonText(value: unknown, profile: "query" | "init" | "complete"): string {
  admitUserJson(value, profile);
  try { const text = JSON.stringify(value); if (typeof text !== "string") fail("protocol"); return text; }
  catch { return fail("protocol"); }
}
