import { newOwnedBytes, ownedByteSubarray, ownedByteLength, encodeOwnedTextInto, encodeOwnedText, newOwnedEncoder, enqueueOwnedBytes } from "./proxy-completion.ts";
import type { Token } from "stream-json/core/parser.js";
import { createJsonTokenizer } from "./json-tokens.ts";
import { HttpError } from "./utils.ts";

const accountingAdmissionErrors = new WeakSet<object>();
export function accountingAdmissionFailure(): never {
  const error = new HttpError(503, "accounting_preflight_unavailable", "accounting preflight is unavailable");
  accountingAdmissionErrors.add(error);
  throw error;
}
export function isAccountingAdmissionFailure(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && accountingAdmissionErrors.has(error);
}
export function accountingIdentity(value: unknown, maximum = 1024): void {
  if (value != null && (typeof value !== "string" || value.length > maximum)) accountingAdmissionFailure();
}

// Closed accounting profiles, including the existing tighter control sink.
type AccountingJsonProfile = "intent" | "capsule" | "archive" | "search";
const accountingProfiles = {
  // Existing Search/cover control sink, including its root-depth and omitted-
  // member accounting. This adds no new limit to legacy sink finalization.
  search: { wire: 16384, depth: 16, values: 128, containers: Infinity, members: 128, entries: 128, combined: Infinity, strings: 8192, key: 4096, scalar: 4096 },
  intent: { wire: 16384, depth: 8, values: 256, containers: 64, members: 128, entries: 64, combined: Infinity, strings: 8192, key: 128, scalar: 2048 },
  capsule: { wire: 65536, depth: 8, values: 1024, containers: 128, members: 512, entries: 256, combined: Infinity, strings: 32768, key: 128, scalar: 2048 },
  archive: { wire: 8 * 1024 * 1024 + 65536, depth: 32, values: 65536, containers: 16384, members: Infinity, entries: Infinity, combined: 32768, strings: 8 * 1024 * 1024, key: 1024, scalar: Infinity },
} as const;

// Private prospective scalar witnesses. They never enter a copied graph or wire
// value. Event producers must enforce the corresponding bound on actual values.
const accountingRanges = new WeakMap<object, { units: number; bytes: number; text: number }>();
const accountingObjects = new WeakMap<object, { source: object; overrides: Record<string, unknown>; renames: readonly { from: string; to: string }[]; defaultServiceTier: boolean }>();
const accountingArrays = new WeakMap<object, { source: readonly unknown[]; extra: readonly unknown[] }>();
const accountingSequences = new WeakMap<object, () => Iterable<unknown>>();
// Fixed prospective views used by Fusion before copying a request or building
// unknown adviser text. They are never serializable/retainable certificates.
export function accountingObjectProjection(source: object, overrides: Record<string, unknown>, renames: readonly { from: string; to: string }[] = [], defaultServiceTier = false): object {
  const view = Object.freeze({}); accountingObjects.set(view, { source, overrides, renames, defaultServiceTier }); return view;
}
export function accountingArrayProjection(source: readonly unknown[], extra: readonly unknown[]): object {
  const view = Object.freeze({}); accountingArrays.set(view, { source, extra }); return view;
}
export function accountingSequenceProjection(values: () => Iterable<unknown>): object {
  const view = Object.freeze({}); accountingSequences.set(view, values); return view;
}
export function accountingJoinedText(parts: Iterable<string>, separator: string, prefix = ""): { value: object; units: number } {
  const initial = admitAccountingJson(prefix, "archive"), between = admitAccountingJson(separator, "archive");
  let bytes = initial.bytes, text = initial.text, units = prefix.length, first = true;
  for (const part of parts) {
    const measured = admitAccountingJson(part, "archive");
    if (!first) { bytes += between.bytes - 2; text += between.text - 2; units += separator.length; }
    first = false; bytes += measured.bytes - 2; text += measured.text - 2; units += part.length;
    if (bytes > accountingProfiles.archive.wire || text > accountingProfiles.archive.wire || units > accountingProfiles.archive.strings) accountingAdmissionFailure();
  }
  const value = Object.freeze({}); accountingRanges.set(value, { units, bytes, text }); return { value, units };
}
export function accountingTextCapacity(known: string, unknownUnits: number): object {
  const measured = admitAccountingJson(known, "archive"), view = Object.freeze({});
  accountingRanges.set(view, { units: known.length + unknownUnits, bytes: measured.bytes + 6 * unknownUnits, text: measured.text + 6 * unknownUnits });
  return view;
}
export function accountingStringCapacity(units: number): object {
  const value = Object.freeze({});
  accountingRanges.set(value, { units, bytes: 2 + 6 * units, text: 2 + 6 * units });
  return value;
}
export function accountingNumberCapacity(): object {
  const value = Object.freeze({});
  accountingRanges.set(value, { units: 0, bytes: 24, text: 24 });
  return value;
}

// No encoding, substring, entries vector or normalized copy precedes this walk.
// A gateway entry loses only the two fields already excluded by retention.
export function admitAccountingJson(value: unknown, profile: AccountingJsonProfile,
  gateway?: readonly unknown[]): { bytes: number; text: number } {
  const limits = accountingProfiles[profile];
  let bytes = 0, text = 0, values = 0, containers = 0, members = 0, entries = 0, strings = 0;
  const active = new Set<object>();
  const add = (wire: number, units = wire) => {
    bytes += wire; text += units;
    if (bytes > limits.wire || text > limits.wire) accountingAdmissionFailure();
  };
  const string = (input: string, key: boolean) => {
    if (input.length > (key ? limits.key : limits.scalar) || (strings += input.length) > limits.strings) accountingAdmissionFailure();
    add(2);
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2, 1);
      else if (code >= 0xd800 && code <= 0xdbff && input.charCodeAt(i + 1) >= 0xdc00 && input.charCodeAt(i + 1) <= 0xdfff) { add(4, 2); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3, 1);
    }
  };
  const visit = (input: unknown, depth: number, gatewayEntry = false): void => {
    if (++values > limits.values || depth > limits.depth) accountingAdmissionFailure();
    if (typeof input === "string") { string(input, false); return; }
    if (input === null || input === undefined) { add(4); return; }
    if (typeof input === "number") {
      if (profile === "search" && !Number.isFinite(input)) accountingAdmissionFailure();
      const token = Number.isFinite(input) ? String(input) : "null";
      if (token.length > 64) accountingAdmissionFailure();
      add(token.length); return;
    }
    if (typeof input === "boolean") { add(input ? 4 : 5); return; }
    if (typeof input !== "object") accountingAdmissionFailure();
    const range = accountingRanges.get(input);
    if (range) {
      if (range.units > limits.scalar || (strings += range.units) > limits.strings) accountingAdmissionFailure();
      add(range.bytes, range.text); return;
    }
    if (++containers > limits.containers || active.has(input)) accountingAdmissionFailure();
    const objectView = accountingObjects.get(input), arrayView = accountingArrays.get(input), sequence = accountingSequences.get(input);
    const array = Array.isArray(input) || !!arrayView || !!sequence, prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input) && prototype !== Array.prototype) accountingAdmissionFailure();
    if (!array && prototype !== Object.prototype && prototype !== null) accountingAdmissionFailure();
    active.add(input); add(2);
    if (sequence) {
      let first = true;
      for (const item of sequence()) {
        if (++entries > limits.entries || entries + members > limits.combined) accountingAdmissionFailure();
        if (!first) add(1); first = false; visit(item, depth + 1);
      }
    } else if (array) {
      const source: readonly unknown[] = arrayView?.source ?? input as unknown[];
      const length = source.length + (arrayView?.extra.length ?? 0);
      if ((entries += length) > limits.entries || entries + members > limits.combined) accountingAdmissionFailure();
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(i < source.length ? source : arrayView!.extra, String(i < source.length ? i : i - source.length));
        if (descriptor && !("value" in descriptor)) accountingAdmissionFailure();
        if (i) add(1);
        visit(descriptor?.value, depth + 1, source === gateway);
      }
    } else {
      let first = true, hasServiceTier = false;
      const source = objectView?.source ?? input;
      const overrides = objectView?.overrides;
      // Rename metadata is bounded independently before this visitor. Resolve
      // chains without allocating an entries/key vector or copying body fields.
      const renamed = (key: string) => {
        for (const rename of objectView?.renames ?? []) if (key === rename.from) key = rename.to;
        return key;
      };
      const emit = (name: string, value: unknown) => {
        // Closed Fusion API variant, applied AFTER declared field renames.
        // Subscription/raw variants use the unchanged projection separately.
        if (objectView?.defaultServiceTier && name === "service_tier") {
          hasServiceTier = true;
          if (value == null || typeof value === "string" && value.length === 4 && value.toLowerCase() === "auto") value = "default";
        }
        if (value === undefined) { if (profile === "search" && ++members > limits.members) accountingAdmissionFailure(); return; }
        if (++members > limits.members || entries + members > limits.combined) accountingAdmissionFailure();
        if (!first) add(1); first = false;
        string(name, true); add(1); visit(value, depth + 1);
      };
      const member = (key: string, owner: object) => {
        if (gatewayEntry && (key === "headers" || key === "authorization")) return;
        const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
        if (!("value" in descriptor)) accountingAdmissionFailure();
        emit(renamed(key), descriptor.value);
      };
      for (const key in source) if (Object.hasOwn(source, key)) member(key, overrides && Object.hasOwn(overrides, key) ? overrides : source);
      if (overrides) for (const key in overrides) if (Object.hasOwn(overrides, key) && !Object.hasOwn(source, key)) member(key, overrides);
      if (objectView?.defaultServiceTier && !hasServiceTier) emit("service_tier", "default");
    }
    active.delete(input);
  };
  visit(value, profile === "search" ? 1 : 0);
  return { bytes, text };
}

const ownedArchivePrototype = Object.setPrototypeOf;
const ownedArchiveProperty = Object.defineProperty;
const ownedArchiveStringify = JSON.stringify;
const ownedArchiveArray = Array.isArray;
const privateJsonNumber = Number;
const privateJsonCharacter = String.prototype.charCodeAt;
function privateJsonCodeAt(text: string, index: number, argument: number[]): number {
  argument[0] = index; return ownedArchiveApply(privateJsonCharacter, text, argument);
}
const ownedArchiveOwn = Object.hasOwn;
const ownedArchiveDescriptor = Object.getOwnPropertyDescriptor;
const ownedArchiveMapHas = WeakMap.prototype.has;
const ownedArchiveApply = Reflect.apply;
const privateJsonObjectPrototype = Object.prototype;
const privateJsonArrayPrototype = Array.prototype;
const privateJsonPrototype = Object.getPrototypeOf;
const privateJsonFreeze = Object.freeze;
const privateAccountingKeys = Object.keys;
// Parked archive cursor: six own fields, four primitive-value occurrences,
// its container and stack reference. Key vectors are paid separately.
const privateArchiveCursorBytes = 8 * (1 + 12 + 4 + 1)
  + 2 * "sourcetargetkeysindexemittedgatewayEntry".length;
export function privateArchiveWorkspaceBytes(graphBytes: number, maximumDepth: number): number {
  // Every body key-vector cell/string is bounded by the already measured graph
  // component; the fixed retained-record keys add one separately paid vector.
  const reachedDepth = maximumDepth < accountingProfiles.archive.depth ? maximumDepth : accountingProfiles.archive.depth;
  return graphBytes + (reachedDepth + 2) * privateArchiveCursorBytes + 1024;
}
function privateAccountingContainer(array: boolean): unknown[] | Record<string, unknown> {
  if (!array) return { __proto__: null };
  const value: unknown[] = []; ownedArchivePrototype(value, null); return value;
}
function privateAccountingProperty(target: object, key: string | number, value: unknown): void {
  ownedArchiveProperty(target, key, { __proto__: null, value, enumerable: true, writable: true, configurable: true } as PropertyDescriptor);
}
interface PrivateArchiveCursor {
  source: object; target: object | undefined; keys: string[] | undefined;
  index: number; emitted: number; gatewayEntry: boolean;
}
// The checked retention caller owns the complete source/copy/workspace debit.
// This is the same admitted private representation used by accounting copies;
// only the archive's traversal replaces recursive APP execution frames.
function walkPrivateAccountingArchive(value: unknown, gateway: readonly unknown[] | undefined, copying: boolean): { bytes: number; text: number; value: unknown } {
  const limits = accountingProfiles.archive;
  let bytes = 0, text = 0, values = 0, containers = 0, members = 0, entries = 0, strings = 0;
  const stack: PrivateArchiveCursor[] = [], argument = [0];
  let root: unknown, input = value, gatewayEntry = false, entering = true;
  const add = (wire: number, units = wire) => {
    bytes += wire; text += units;
    if (bytes > limits.wire || text > limits.wire) accountingAdmissionFailure();
  };
  const string = (input: string, key: boolean) => {
    if (input.length > (key ? limits.key : limits.scalar) || (strings += input.length) > limits.strings) accountingAdmissionFailure();
    add(2);
    for (let index = 0; index < input.length; index++) {
      const code = privateJsonCodeAt(input, index, argument);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2, 1);
      else if (code >= 0xd800 && code <= 0xdbff && privateJsonCodeAt(input, index + 1, argument) >= 0xdc00
        && privateJsonCodeAt(input, index + 1, argument) <= 0xdfff) { add(4, 2); index++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3, 1);
    }
  };
  try {
    while (entering || stack.length) {
      if (entering) {
        entering = false;
        if (++values > limits.values || stack.length > limits.depth) accountingAdmissionFailure();
        if (typeof input === "string") string(input, false);
        else if (input === null || input === undefined) add(4);
        else if (typeof input === "boolean") add(input ? 4 : 5);
        else if (typeof input === "number") {
          const token = Number.isFinite(input) ? String(input) : "null";
          if (token.length > 64) accountingAdmissionFailure();
          add(token.length);
        } else if (typeof input !== "object") accountingAdmissionFailure();
        else {
          // Prospective wrappers were never accepted by the private copier.
          if (ownedArchiveApply(ownedArchiveMapHas, accountingRanges, [input]) || ownedArchiveApply(ownedArchiveMapHas, accountingObjects, [input])
            || ownedArchiveApply(ownedArchiveMapHas, accountingArrays, [input]) || ownedArchiveApply(ownedArchiveMapHas, accountingSequences, [input])) accountingAdmissionFailure();
          const array = ownedArchiveArray(input), prototype = privateJsonPrototype(input);
          if (array ? prototype !== privateJsonArrayPrototype : prototype !== privateJsonObjectPrototype && prototype !== null) accountingAdmissionFailure();
          if (++containers > limits.containers) accountingAdmissionFailure();
          for (let index = 0; index < stack.length; index++) if (stack[index].source === input) accountingAdmissionFailure();
          add(2);
          if (array && ((entries += (input as unknown[]).length) > limits.entries || entries + members > limits.combined)) accountingAdmissionFailure();
          // Keys/cursors were counted in pricing before retention effects. A
          // second walk may reuse that workspace only after this walk's finally.
          const target = copying ? privateAccountingContainer(array) : undefined;
          if (copying) {
            if (!stack.length) root = target;
            else {
              const parent = stack[stack.length - 1];
              privateAccountingProperty(parent.target!, parent.keys ? parent.keys[parent.index - 1] : parent.index - 1, target);
            }
          }
          const cursor: PrivateArchiveCursor = { source: input, target, keys: array ? undefined : privateAccountingKeys(input), index: 0, emitted: 0, gatewayEntry };
          privateAccountingProperty(stack, stack.length, cursor);
          input = undefined;
          continue;
        }
        if (copying) {
          if (!stack.length) root = input;
          else {
            const parent = stack[stack.length - 1];
            privateAccountingProperty(parent.target!, parent.keys ? parent.keys[parent.index - 1] : parent.index - 1, input ?? null);
          }
        }
        input = undefined;
      }
      if (!stack.length) break;
      const cursor = stack[stack.length - 1], length = cursor.keys ? cursor.keys.length : (cursor.source as unknown[]).length;
      if (cursor.index === length) {
        cursor.source = undefined as never; cursor.target = undefined; cursor.keys = undefined;
        stack.length--; continue;
      }
      const key = cursor.keys ? cursor.keys[cursor.index++] : cursor.index++;
      if (cursor.keys && cursor.gatewayEntry && (key === "headers" || key === "authorization")) continue;
      const descriptor = ownedArchiveDescriptor(cursor.source, key);
      if (descriptor && !ownedArchiveOwn(descriptor, "value")) accountingAdmissionFailure();
      input = descriptor?.value;
      if (cursor.keys) {
        if (input === undefined) continue;
        if (++members > limits.members || entries + members > limits.combined) accountingAdmissionFailure();
        if (cursor.emitted++) add(1);
        string(key as string, true); add(1);
        gatewayEntry = false;
      } else {
        if (cursor.emitted++) add(1);
        gatewayEntry = cursor.source === gateway;
      }
      entering = true;
    }
    return { bytes, text, value: root };
  } finally { stack.length = 0; input = undefined; root = undefined; value = undefined; gateway = undefined; }
}

// A guard is not input admission. Only the named current passive producers
// below may reach this constructor; queue/archive retain their separate copies.
function assertPrivateJsonPrototypes(): void {
  if (ownedArchiveOwn(privateJsonObjectPrototype, "toJSON") || ownedArchiveOwn(privateJsonArrayPrototype, "toJSON")
    || privateJsonPrototype(privateJsonObjectPrototype) !== null || privateJsonPrototype(privateJsonArrayPrototype) !== privateJsonObjectPrototype)
    throw "private JSON prototype is unsupported";
}
function stringifyPrivatePassiveRoot(value: unknown): string {
  assertPrivateJsonPrototypes();
  return ownedArchiveStringify(value)!;
}

// The queue-only mode completes and freezes children before attachment. The
// same bounded copy frames serve ordinary, private-unsealed and sealed copies.
function copyAdmittedAccountingJson(value: unknown, gateway?: readonly unknown[], gatewayEntry = false, owned: 0 | 1 | 2 = 0): unknown {
  if (owned && (typeof value === "function" || typeof value === "symbol")) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (owned ? ownedArchiveApply(ownedArchiveMapHas, accountingRanges, [value]) || ownedArchiveApply(ownedArchiveMapHas, accountingObjects, [value])
    || ownedArchiveApply(ownedArchiveMapHas, accountingArrays, [value]) || ownedArchiveApply(ownedArchiveMapHas, accountingSequences, [value])
    : accountingRanges.has(value) || accountingObjects.has(value) || accountingArrays.has(value) || accountingSequences.has(value)) accountingAdmissionFailure();
  if (owned ? ownedArchiveArray(value) : Array.isArray(value)) {
    const copy: unknown[] = owned ? privateAccountingContainer(true) as unknown[] : [];
    for (let i = 0; i < (value as unknown[]).length; i++) {
      if (owned) {
        const descriptor = ownedArchiveDescriptor(value, i);
        if (descriptor && !ownedArchiveOwn(descriptor, "value")) accountingAdmissionFailure();
        ownedArchiveProperty(copy, i, { __proto__: null, value: copyAdmittedAccountingJson(descriptor?.value ?? null, gateway, value === gateway, owned), enumerable: true, writable: true, configurable: true } as PropertyDescriptor);
      }
      else copy.push(copyAdmittedAccountingJson((value as unknown[])[i] ?? null, gateway, value === gateway));
    }
    if (owned === 2) privateJsonFreeze(copy);
    return copy;
  }
  const copy: Record<string, unknown> = owned ? privateAccountingContainer(false) as Record<string, unknown> : {};
  for (const key in value) {
    if (!(owned ? ownedArchiveOwn(value, key) : Object.hasOwn(value, key)) || gatewayEntry && (key === "headers" || key === "authorization")) continue;
    const descriptor = owned ? ownedArchiveDescriptor(value, key)! : undefined;
    if (owned && !ownedArchiveOwn(descriptor!, "value")) accountingAdmissionFailure();
    const item = owned ? descriptor!.value : (value as Record<string, unknown>)[key];
    if (item !== undefined && (!owned || typeof item !== "function" && typeof item !== "symbol")) {
      if (owned) ownedArchiveProperty(copy, key, { __proto__: null, value: copyAdmittedAccountingJson(item, gateway, false, owned), enumerable: true, writable: true, configurable: true } as PropertyDescriptor);
      else Object.defineProperty(copy, key, { value: copyAdmittedAccountingJson(item, gateway), enumerable: true, writable: true, configurable: true });
    }
  }
  if (owned === 2) privateJsonFreeze(copy);
  return copy;
}

export function copyAccountingJson<T>(value: T, profile: AccountingJsonProfile): T {
  admitAccountingJson(value, profile);
  return copyAdmittedAccountingJson(value) as T;
}

// Closed private accounting destinations. The upper named operation has already
// admitted the complete source/copy/text component and its genuine sink binding.
// Existing producer admission remains authoritative; do not re-admit a private
// null-prototype copy or increment an identity source counter here.
export function privateIntentJson(value: unknown): string {
  // Actual terminal charge/settle DTOs have only admitted primitive own fields.
  // Keep their previously reserved copy/text overlap until the complete ledger.
  return stringifyPrivatePassiveRoot(value);
}
type PrivatePreflightRequest = { credentialId: string; secretSha256: string; source: import("./identity-admission.ts").IdentitySourceBudget };
export function sealPrivatePreflightRequest(value: PrivatePreflightRequest): void {
  // Both records are freshly constructed by the genuine preflight command.
  // Freeze before the existing plan can expose either record to a method hook.
  privateJsonFreeze(value.source); privateJsonFreeze(value);
}
export function privatePreflightJson(value: PrivatePreflightRequest): string { return stringifyPrivatePassiveRoot(value); }
export function privateSnapshotJson(value: { credentialId: string | null; principalId: string | null; policyId: string }): string {
  return stringifyPrivatePassiveRoot(value);
}
export function privateVeniceRouteJson(url: string, endpoint: string, model: string): string {
  if (typeof url !== "string" || typeof endpoint !== "string" || typeof model !== "string") throw "private route identity is invalid";
  return stringifyPrivatePassiveRoot([url, endpoint, model]);
}
export function privateGmiRouteJson(url: string, organization: string | null): string {
  if (typeof url !== "string" || organization !== null && typeof organization !== "string") throw "private route identity is invalid";
  return stringifyPrivatePassiveRoot([url, organization]);
}
export function privateCapsuleJson(value: unknown): string {
  let copy: unknown;
  try { copy = copyAdmittedAccountingJson(value, undefined, false, 1); return ownedArchiveStringify(copy)!; }
  finally { copy = undefined; value = undefined; }
}
// The genuine materialization command has separately admitted its complete
// identity profile and the simultaneous copy/text/wire component. Reuse only
// the copy mechanism here, never the accounting capsule's smaller profile.
export function privateMaterializationJson(value: unknown): string {
  let copy: unknown;
  try { copy = copyAdmittedAccountingJson(value, undefined, false, 1); return ownedArchiveStringify(copy)!; }
  finally { copy = undefined; value = undefined; }
}
// Only the HTTP-associated admission continuation selects this entry. Its
// existing complete plan funds the copy without changing cumulative counters.
export function privateAdmissionJson(value: unknown): string {
  let copy: unknown;
  try { copy = copyAdmittedAccountingJson(value, undefined, false, 1); return ownedArchiveStringify(copy)!; }
  finally { copy = undefined; value = undefined; }
}
// The fixed normalizer alone constructs this envelope from a freshly parsed
// private response subtree. No graph is exposed between capture and this guard.
export function privateMappedErrorJson(value: unknown): string { return stringifyPrivatePassiveRoot(value); }
export function privateGrantIdentityJson(value: unknown): string {
  let copy: unknown;
  try { copy = copyAdmittedAccountingJson(value, undefined, false, 1); return ownedArchiveStringify(copy)!; }
  finally { copy = undefined; value = undefined; }
}
export function copyPrivateQueueIntent(value: unknown, destination: { subject?: unknown }): void {
  destination.subject = copyAdmittedAccountingJson(value, undefined, false, 2);
}
export function copyPrivateQueueCapsule(value: unknown, destination: { subject?: unknown }): void {
  destination.subject = copyAdmittedAccountingJson(value, undefined, false, 2);
}

interface AccountingChunkCursor {
  value: unknown[] | Record<string, unknown>;
  keys: string[] | undefined;
  index: number;
  emitted: number;
}
function* accountingChunks(value: unknown): Generator<string> {
  // Admission/copy has completed and cleared its cursors before this generator
  // starts. The private caller prepays this stack and every key occurrence in
  // the same traversal high-water component; ordinary serialization is shared.
  const stack: AccountingChunkCursor[] = [];
  let input = value, entering = true;
  try {
    while (entering || stack.length) {
      if (entering) {
        entering = false;
        if (typeof input === "string") { yield* quoted(input); input = undefined; }
        else if (input !== null && typeof input === "object") {
          const array = Array.isArray(input);
          privateAccountingProperty(stack, stack.length, { value: input as unknown[] | Record<string, unknown>,
            keys: array ? undefined : privateAccountingKeys(input), index: 0, emitted: 0 });
          input = undefined;
          yield array ? "[" : "{";
        } else { yield JSON.stringify(input); input = undefined; }
      }
      if (!stack.length) break;
      const cursor = stack[stack.length - 1];
      const length = cursor.keys ? cursor.keys.length : (cursor.value as unknown[]).length;
      if (cursor.index === length) {
        yield cursor.keys ? "}" : "]";
        cursor.value = undefined as never; cursor.keys = undefined;
        stack.length--; continue;
      }
      const key = cursor.keys ? cursor.keys[cursor.index++] : cursor.index++;
      const item = (cursor.value as Record<string | number, unknown>)[key];
      if (cursor.keys && item === undefined) continue;
      if (cursor.emitted++) yield ",";
      if (cursor.keys) { yield* quoted(key as string); yield ":"; }
      input = item ?? null; entering = true;
    }
  } finally {
    for (let index = 0; index < stack.length; index++) {
      stack[index].value = undefined as never; stack[index].keys = undefined;
    }
    stack.length = 0; input = undefined; value = undefined;
  }
}

/** Privately copied TEXT archive; one synchronous pull and at most one queued chunk. */
export function accountingArchive(value: unknown, gateway?: readonly unknown[]) {
  return createAccountingArchive(value, gateway, false);
}
/** @internal Only the checked private content-retention preparation calls this. */
export function privateAccountingArchive(value: unknown, gateway?: readonly unknown[]) {
  return createAccountingArchive(value, gateway, true);
}
function createAccountingArchive(value: unknown, gateway: readonly unknown[] | undefined, ownedBytes: boolean) {
  const measurement = ownedBytes ? walkPrivateAccountingArchive(value, gateway, false) : admitAccountingJson(value, "archive", gateway);
  let owned: unknown = ownedBytes ? walkPrivateAccountingArchive(value, gateway, true).value : copyAdmittedAccountingJson(value, gateway);
  let used = false, done = false;
  let archiveEncoder: TextEncoder | undefined;
  let chunks: Generator<string> | undefined;
  let pending: string | undefined;
  const release = () => { if (done) return; done = true; owned = undefined; pending = undefined; chunks?.return(undefined); if (ownedBytes) { chunks = undefined; archiveEncoder = undefined; } };
  return {
    bytes: measurement.bytes,
    text(): string {
      if (used || measurement.bytes > 32768) throw new Error("accounting archive requires streaming");
      used = true;
      const text = ownedBytes ? ownedArchiveStringify(owned) : JSON.stringify(owned);
      release(); return text;
    },
    stream(): ReadableStream<Uint8Array> {
      if (used) throw new Error("accounting archive already consumed");
      used = true; chunks = accountingChunks(owned);
      if (ownedBytes) archiveEncoder = newOwnedEncoder();
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          try {
            const backing = ownedBytes ? newOwnedBytes(32768) : new Uint8Array(32768);
            let written = 0, eof = false;
            while (true) {
              if (pending === undefined) {
                const next = chunks!.next();
                if (next.done) { eof = true; break; }
                pending = next.value;
              }
              // quoted() has <=4096 source units: escaped ASCII <=24576 bytes,
              // unescaped UTF-8 <=12288. Measure before encodeInto, not after.
              if (pending.length > 24576) accountingAdmissionFailure();
              let bytes = 0;
              for (let i = 0; i < pending.length; i++) {
                const code = pending.charCodeAt(i);
                if (code < 128) bytes++;
                else if (code < 2048) bytes += 2;
                else if (code >= 0xd800 && code <= 0xdbff && pending.charCodeAt(i + 1) >= 0xdc00 && pending.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
                else bytes += 3;
              }
              if (bytes > (ownedBytes ? ownedByteLength(backing) : backing.byteLength) - written) break;
              const encoded = ownedBytes
                ? encodeOwnedTextInto(archiveEncoder!, pending, ownedByteSubarray(backing, written))
                : encoder.encodeInto(pending, backing.subarray(written));
              if (encoded.read !== pending.length) accountingAdmissionFailure();
              written += encoded.written; pending = undefined;
            }
            if (written) {
              if (ownedBytes) enqueueOwnedBytes(controller, ownedByteSubarray(backing, 0, written));
              else controller.enqueue(backing.subarray(0, written));
            }
            if (eof) { release(); controller.close(); }
          } catch (error) { release(); controller.error(error); }
        },
        cancel() { release(); },
      }, { highWaterMark: 0 });
    },
    discard: release,
    get retired() { return done; },
  };
}

// Large JSON media must not create an additional whole-document string and
// UTF-8 buffer for every pricing/dispatch/retention owner. Inputs are the plain
// JSON values constructed from ingress (not arbitrary objects with toJSON).
const stringChunk = 4096;
const encoder = new TextEncoder();

function* quoted(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + stringChunk);
    // JSON.stringify escapes a lone surrogate. Keep a real pair together so
    // chunk boundaries cannot change the JSON value or its encoded byte count.
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* jsonChunks(value: unknown): Generator<string> {
  if (typeof value === "string") { yield* quoted(value); return; }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* jsonChunks(value[index] ?? null);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield* quoted(key); yield ":"; yield* jsonChunks(item);
    }
    yield "}";
  } else {
    // Reject non-JSON programmer values rather than silently alter a request.
    if (value !== null && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("expected a JSON value");
    yield JSON.stringify(value);
  }
}

// A quoted chunk is at most 6 × stringChunk + 2 UTF-16 units (\u0000 escapes),
// and each unit encodes to at most 3 bytes.
const scratch = new Uint8Array(3 * (6 * stringChunk + 2));

// Same chunks as quoted(), measured into a reused buffer instead of encoded.
function quotedBytes(value: string): number {
  if (value.length <= stringChunk) return encoder.encodeInto(JSON.stringify(value), scratch).written;
  let bytes = 2;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + stringChunk);
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    bytes += encoder.encodeInto(JSON.stringify(value.slice(offset, end)), scratch).written - 2;
    offset = end;
  }
  return bytes;
}

// Counts exactly what jsonBodyStream emits, without serializing: pricing and
// dispatch size every Claude body, and the chunked serializer cost ~70% of a
// request's CPU just to be measured.
export function jsonBodyBytes(value: unknown): number {
  if (typeof value === "string") return quotedBytes(value);
  if (Array.isArray(value)) {
    let bytes = 1 + Math.max(0, value.length - 1) + 1;
    for (let index = 0; index < value.length; index++) bytes += jsonBodyBytes(value[index] ?? null);
    return bytes;
  }
  if (value !== null && typeof value === "object") {
    let bytes = 2, members = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      bytes += quotedBytes(key) + 1 + jsonBodyBytes(item);
      members++;
    }
    return bytes + Math.max(0, members - 1);
  }
  if (value !== null && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("expected a JSON value");
  return JSON.stringify(value).length;
}

// UTF-8 length without materializing the encoded copy; slices keep surrogate
// pairs together so a split cannot count as two replacement characters.
export function utf8Length(text: string): number {
  if (text.length <= stringChunk) return encoder.encodeInto(text, scratch).written;
  let bytes = 0;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + stringChunk);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    bytes += encoder.encodeInto(text.slice(offset, end), scratch).written;
    offset = end;
  }
  return bytes;
}

export function jsonBodyStream(value: unknown): ReadableStream<Uint8Array> {
  const chunks = jsonChunks(value);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // Coalesce tiny structural pieces without retaining a document-sized
      // serialization; one pull emits at most ~48 KiB of encoded string data.
      let text = "";
      while (text.length < 8192) {
        const next = chunks.next();
        if (next.done) { if (text) controller.enqueue(encoder.encode(text)); controller.close(); return; }
        text += next.value;
      }
      controller.enqueue(encoder.encode(text));
    },
    cancel() { chunks.return(undefined); },
  }, { highWaterMark: 0 });
}

export type JsonTransportRetirement = "eof" | "cancel" | "error" | "discard";
export interface JsonBodyTransport {
  readonly bytes: number;
  readonly retirement: JsonTransportRetirement | null;
  stream(): ReadableStream<Uint8Array>;
  discard(): void;
}

// The caller supplies validated, structurally bounded plain JSON and keeps it
// immutable (deeply frozen borrowed input is supported). Only this serializer's
// references retire here; other input owners and queued wire bytes are separate.
export function jsonBodyTransport(value: unknown, maximumBytes: number): JsonBodyTransport {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("invalid JSON transport bound");
  const bytes = jsonBodyBytes(value);
  if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) throw new RangeError("JSON transport exceeds bound");
  let body: unknown = value;
  value = undefined;
  let chunks: Generator<string> | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let started = false, emitted = 0, retirement: JsonTransportRetirement | null = null;
  function retire(reason: JsonTransportRetirement): void {
    if (retirement !== null) return;
    retirement = reason;
    const iterator = chunks;
    chunks = undefined; body = undefined; controller = undefined;
    iterator?.return(undefined);
  }
  return {
    bytes,
    get retirement() { return retirement; },
    stream() {
      if (started || retirement !== null) throw new TypeError("JSON transport is single-use");
      started = true;
      chunks = jsonChunks(body); body = undefined;
      return new ReadableStream<Uint8Array>({
        start(current) { controller = current; },
        pull(current) {
          try {
            let text = "", done = false;
            while (text.length < 8192) {
              const next = chunks!.next();
              if (next.done) { done = true; break; }
              text += next.value;
            }
            // Each quoted piece is <=24 KiB encoded; the prior coalesced text
            // is <24 KiB encoded. No whole-document string/buffer is created.
            const wire = encoder.encode(text);
            emitted += wire.byteLength;
            if (wire.byteLength > 64 * 1024 || emitted > bytes || (done && emitted !== bytes)) throw new RangeError("JSON transport size changed");
            if (wire.byteLength) current.enqueue(wire);
            if (done) { current.close(); retire("eof"); }
          } catch (error) { retire("error"); throw error; }
        },
        cancel() { retire("cancel"); },
      }, { highWaterMark: 0 });
    },
    discard() {
      if (retirement !== null) return;
      const current = controller;
      retire("discard");
      current?.error(new TypeError("JSON transport discarded"));
    },
  };
}

// Base64 images and data URLs dominate large bodies. JSON.stringify of the whole
// value would add a document-sized string plus its encoded bytes, and the
// chunked serializer above costs 4–20× native CPU. Instead stringify a skeleton
// with each media string swapped for a per-call marker, then splice the strings
// back in as raw chunks: native CPU, and no copy beyond the parsed value.
// Below 1 MiB of such strings a whole-document copy is cheaper than streaming.
const mediaChars = 64 * 1024, mediaChunk = 64 * 1024, mediaMinimum = 1024 * 1024;
// Characters JSON.stringify emits verbatim as one UTF-8 byte each.
const unplain = /[^\x20\x21\x23-\x5b\x5d-\x7e]/;

export interface MediaJsonBody { bytes: number; stream(): ReadableStream<Uint8Array> }

// Null when large strings total under 1 MiB; JSON.stringify is cheaper then.
export interface PrivateMediaAdmission { workspaceBytes: number; serializationBytes: number; restorePending: boolean }
export function privateMediaJsonBody(value: unknown, admission: PrivateMediaAdmission): MediaJsonBody | null {
  return mediaBody(value, admission);
}
export function privateUploadJson(value: unknown): string { return stringifyPrivatePassiveRoot(value); }
export function mediaJsonBody(value: unknown): MediaJsonBody | null { return mediaBody(value); }
function mediaBody(value: unknown, owned?: PrivateMediaAdmission): MediaJsonBody | null {
  if (owned && owned.workspaceBytes < 24) throw new Error("private media workspace is unavailable");
  const slots: Array<{ owner: Record<string, unknown> | unknown[]; key: string | number; value: string; marker?: string }> = [];
  // Iterative: an 8 MiB JSON.parse body can nest far deeper than the call stack.
  const pending: unknown[] = [value];
  let total = 0, locatorBytes = 8;
  while (pending.length) {
    const owner = pending.pop();
    if (!owner || typeof owner !== "object") continue;
    if (owned) {
      // Count the next batch before appending any child or locator. This is
      // paid variable traversal CONTROL; the current loop/descriptor/calls are
      // still fixed execution CONTROL. No late COMMON reservation is made.
      let children = 0, additions = 0;
      if (ownedArchiveArray(owner)) {
        for (let key = 0; key < owner.length; key++) {
          const item = owner[key];
          if (item !== null && typeof item === "object") children++;
          else if (typeof item === "string" && item.length >= mediaChars) additions += privateMediaLocatorBytes(key, item);
        }
      } else for (const key in owner) if (ownedArchiveOwn(owner, key)) {
        const item = (owner as Record<string, unknown>)[key];
        if (item !== null && typeof item === "object") children++;
        else if (typeof item === "string" && item.length >= mediaChars) additions += privateMediaLocatorBytes(key, item);
      }
      if (8 * (1 + pending.length + children) + locatorBytes + additions > owned.workspaceBytes)
        throw new Error("private media workspace changed");
      locatorBytes += additions;
      if (ownedArchiveArray(owner)) {
        for (let key = 0; key < owner.length; key++) {
          const item = owner[key];
          if (typeof item === "string" && item.length >= mediaChars) { privateMediaLocator(slots, owner, key, item); total += item.length; }
          else if (item !== null && typeof item === "object") privateMediaAppend(pending, item);
        }
      } else for (const key in owner) if (ownedArchiveOwn(owner, key)) {
        const item = (owner as Record<string, unknown>)[key];
        if (typeof item === "string" && item.length >= mediaChars) { privateMediaLocator(slots, owner as Record<string, unknown>, key, item); total += item.length; }
        else if (item !== null && typeof item === "object") privateMediaAppend(pending, item);
      }
      continue;
    }
    const keys: Array<string | number> = Array.isArray(owner) ? Array.from(owner.keys()) : Object.keys(owner);
    for (const key of keys) {
      const item = (owner as Record<string | number, unknown>)[key];
      if (typeof item === "string") { if (item.length >= mediaChars) { slots.push({ owner: owner as Record<string, unknown>, key, value: item }); total += item.length; } }
      else if (item && typeof item === "object") pending.push(item);
    }
  }
  if (total < mediaMinimum) { if (owned) { slots.length = 0; pending.length = 0; value = undefined; } return null; }
  const marker = `\u0000clawrouter-media-${crypto.randomUUID()}-`;
  let skeleton: string;
  if (owned) {
    // UUID and marker construction finish before the final prototype guard.
    // All marker strings were prepaid per locator, including primitive cells.
    for (let index = 0; index < slots.length; index++) slots[index].marker = marker + index;
    assertPrivateJsonPrototypes();
    let installed = 0, restored = true;
    owned.restorePending = true;
    try {
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index]; installed = index + 1;
        ownedArchiveProperty(slot.owner, slot.key,
          { __proto__: null, value: slot.marker, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
      }
      skeleton = ownedArchiveStringify(value)!;
    } finally {
      for (let index = 0; index < installed; index++) {
        const slot = slots[index];
        try { ownedArchiveProperty(slot.owner, slot.key,
          { __proto__: null, value: slot.value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor); }
        catch { restored = false; }
      }
      if (restored) owned.restorePending = false;
    }
    if (owned.restorePending) throw new Error("private media restoration is unknown");
  } else {
  try {
    slots.forEach((slot, index) => { (slot.owner as Record<string | number, unknown>)[slot.key] = marker + index; });
    skeleton = JSON.stringify(value);
  } finally {
    for (const slot of slots) (slot.owner as Record<string | number, unknown>)[slot.key] = slot.value;
  }
  }
  // The marker's control character is always escaped, and its UUID is fresh,
  // so caller text cannot produce this serialized form.
  const needle = `"${(owned ? ownedArchiveStringify(marker)! : JSON.stringify(marker)).slice(1, -1)}`;
  const pieces: Array<Uint8Array | string> = [];
  let bytes = 0, offset = 0;
  for (let at = skeleton.indexOf(needle); at >= 0; at = skeleton.indexOf(needle, offset)) {
    const end = skeleton.indexOf('"', at + needle.length);
    const piece = owned ? encodeOwnedText(encoder, skeleton.slice(offset, at)) : encoder.encode(skeleton.slice(offset, at)), media = slots[Number(skeleton.slice(at + needle.length, end))].value;
    pieces.push(piece, media);
    bytes += piece.byteLength + (unplain.test(media) ? quotedBytes(media) : media.length + 2);
    offset = end + 1;
  }
  const tail = owned ? encodeOwnedText(encoder, skeleton.slice(offset)) : encoder.encode(skeleton.slice(offset));
  pieces.push(tail);
  bytes += tail.byteLength;
  if (owned) {
    slots.length = 0; pending.length = 0; value = undefined; skeleton = "";
    return privateMediaTransport(pieces, bytes);
  }
  return {
    bytes,
    stream() {
      let index = 0, chunks: Iterator<string> | null = null;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          while (index < pieces.length) {
            const piece = pieces[index];
            if (typeof piece !== "string") { index++; if (piece.byteLength) { controller.enqueue(piece); return; } continue; }
            chunks ??= unplain.test(piece) ? quoted(piece) : plainChunks(piece);
            const next = chunks.next();
            if (!next.done) { controller.enqueue(encoder.encode(next.value)); return; }
            chunks = null; index++;
          }
          controller.close();
        },
        cancel() { index = pieces.length; },
      }, { highWaterMark: 0 });
    },
  };
}

function privateMediaLocatorBytes(key: string | number, value: string): number {
  return 8 * (1 + 9 + 3) + 2 * (19 + 70 + value.length + (typeof key === "string" ? key.length : 0));
}
function privateMediaAppend<T>(target: T[], value: T): void {
  ownedArchiveProperty(target, target.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
}
function privateMediaLocator(slots: Array<{ owner: Record<string, unknown> | unknown[]; key: string | number; value: string; marker?: string }>,
  owner: Record<string, unknown> | unknown[], key: string | number, value: string): void {
  const descriptor = ownedArchiveDescriptor(owner, key);
  if (!descriptor || !ownedArchiveOwn(descriptor, "value") || descriptor.value !== value
    || descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true)
    throw new Error("private media source is not writable own data");
  privateMediaAppend(slots, { owner, key, value, marker: "" });
}
// Only output pieces escape this fixed factory; no parent, locator, source-root
// or restoration environment is captured by the stream's closures.
function privateMediaTransport(pieces: Array<Uint8Array | string>, bytes: number): MediaJsonBody {
  return {
    bytes,
    stream() {
      let index = 0, chunks: Iterator<string> | null = null;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          while (index < pieces.length) {
            const piece = pieces[index];
            if (typeof piece !== "string") { index++; if (ownedByteLength(piece)) { enqueueOwnedBytes(controller, piece); return; } continue; }
            chunks ??= unplain.test(piece) ? quoted(piece) : plainChunks(piece);
            const next = chunks.next();
            if (!next.done) { enqueueOwnedBytes(controller, encodeOwnedText(encoder, next.value)); return; }
            chunks = null; index++;
          }
          pieces.length = 0; controller.close();
        },
        cancel() { index = pieces.length; chunks = null; pieces.length = 0; },
      }, { highWaterMark: 0 });
    },
  };
}

function* plainChunks(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length; offset += mediaChunk) yield value.slice(offset, offset + mediaChunk);
  yield '"';
}

export class JsonBodyStructureLimit extends Error {}

interface PrivateJsonBodyParser { push(text: string): void; take(): unknown; discard(): void }
interface JsonBodyParser extends PrivateJsonBodyParser { end(): unknown; enforceStructureLimits(): void }
type JsonBodyContainer = Record<string, unknown> | unknown[];

// The larger envelope is for media, not unbounded object expansion. A byte cap
// alone lets millions of tiny arrays/objects exhaust the 128 MB isolate. Parse
// in bounded feeds directly into the value instead of retaining a second full
// decoded document for JSON.parse. Limits apply only to bodies above 8 MiB.
export function createJsonBodyParser(enforceStructure = true): JsonBodyParser {
  return createBodyParser(enforceStructure, false);
}

// The genuine private codec prepays this synchronous factory. Its completed
// graph transfers directly to that codec; no end/getter or callback escapes.
export function createPrivateJsonBodyParser(): PrivateJsonBodyParser {
  return createBodyParser(true, true);
}

// Allocation census preserves the private usage scanner's legacy separators.
// This is not JSON grammar; key lookahead below still uses only JSON's four.
function privateJsonAtomSpace(code: number): boolean {
  return code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760
    || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

// Fixed private callers prepay the scalar workspace and this three-field
// receipt. Native JSON.parse alone decides grammar; exact is usable ONLY after
// it succeeds. The codec consumes limited; accepted usage deliberately does not.
export function measurePrivateJsonBody(text: string): { upper: number; exact: number; limited: boolean } {
  let containers = 0, strings = 0, atoms = 0, keys = 0, rawUnits = 0, decodedUnits = 0;
  let depth = 0, values = 0, limited = false, index = 0;
  // One invocation-local native-call vector, prepaid with the census activation.
  // Reentrant censuses have distinct vectors; no per-character array factory.
  const characterIndex = [0];
  try {
    while (index < text.length) {
      let code = privateJsonCodeAt(text, index++, characterIndex);
      if (code === 34) {
        strings++;
        let length = 0, closed = false;
        while (index < text.length) {
          code = privateJsonCodeAt(text, index++, characterIndex);
          if (code === 34) { closed = true; break; }
          rawUnits++;
          if (code !== 92 || index === text.length) { length++; decodedUnits++; continue; }
          code = privateJsonCodeAt(text, index++, characterIndex); rawUnits++;
          if (code === 117 && index + 4 <= text.length) {
            let unicode = true;
            for (let look = index; look < index + 4; look++) {
              const digit = privateJsonCodeAt(text, look, characterIndex);
              if (!(digit >= 48 && digit <= 57 || digit >= 65 && digit <= 70 || digit >= 97 && digit <= 102)) unicode = false;
            }
            if (unicode) { index += 4; rawUnits += 4; length++; decodedUnits++; continue; }
          }
          // Invalid escapes remain input to native grammar. Their raw spelling
          // is conservatively counted; no decoded key/value is constructed.
          const width = code === 34 || code === 92 || code === 47 || code === 98 || code === 102 || code === 110 || code === 114 || code === 116 ? 1 : 2;
          length += width; decodedUnits += width;
        }
        let look = index;
        while (look < text.length) {
          code = privateJsonCodeAt(text, look, characterIndex);
          if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
          look++;
        }
        if (closed && privateJsonCodeAt(text, look, characterIndex) === 58) { keys++; if (length > 4096) limited = true; }
        // Never count a provisional quoted key as a value before classification.
        else if (closed && ++values > 65536) limited = true;
      } else if (code === 123 || code === 91) {
        if (++depth > 128) limited = true;
        containers++;
        if (++values > 65536) limited = true;
      } else if (code === 125 || code === 93) depth--;
      else if (code !== 44 && code !== 58 && !privateJsonAtomSpace(code)) {
        atoms++;
        const numeric = code === 45 || code >= 48 && code <= 57;
        let length = 1;
        while (index < text.length) {
          code = privateJsonCodeAt(text, index, characterIndex);
          if (code === 34 || code === 123 || code === 91 || code === 125 || code === 93 || code === 44 || code === 58
            || privateJsonAtomSpace(code)) break;
          index++; length++;
        }
        if (numeric && length > 4096) limited = true;
        if (++values > 65536) limited = true;
      }
    }
    return { upper: 16 * (containers + strings + atoms) + 2 * rawUnits,
      exact: 8 * (2 * (containers + strings - keys + atoms) - 1 + keys) + 2 * decodedUnits, limited };
  } finally { text = ""; characterIndex[0] = 0; }
}

function createBodyParser(enforceStructure: boolean, privateParents: false): JsonBodyParser;
function createBodyParser(enforceStructure: boolean, privateParents: true): PrivateJsonBodyParser;
function createBodyParser(enforceStructure: boolean, privateParents: boolean): JsonBodyParser | PrivateJsonBodyParser {
  // Exactly one stack is constructed. Ordinary callers retain their existing
  // frame representation; the private path has direct parent references only.
  const stack: Array<{ value: JsonBodyContainer; key?: string }> | undefined = privateParents ? undefined : [];
  const parents: JsonBodyContainer[] | undefined = privateParents ? [] : undefined;
  let pendingKey: string | undefined;
  let root: unknown, scalar = "", key = false, nodes = 0, maximumDepth = 0, maximumScalar = 0;
  const checkStructure = () => {
    if (enforceStructure && (nodes > 65_536 || maximumDepth > 128 || maximumScalar > 4096)) throw new JsonBodyStructureLimit();
  };
  function attach(value: unknown) {
    nodes++; checkStructure();
    let parent: JsonBodyContainer | undefined, member: string | undefined;
    if (parents) {
      parent = parents.length ? parents[parents.length - 1] : undefined; member = pendingKey;
    } else {
      const frame = stack!.at(-1); parent = frame?.value; member = frame?.key;
    }
    if (!parent) root = value;
    else if (parents) ownedArchiveProperty(parent, ownedArchiveArray(parent) ? parent.length : member!,
      { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
    else if (Array.isArray(parent)) parent.push(value);
    // Define an own property, as JSON.parse does, including __proto__. Repeated
    // keys replace the previous value instead of altering object prototypes.
    else Object.defineProperty(parent, member!, { value, writable: true, enumerable: true, configurable: true });
    if (parents) { pendingKey = undefined; member = undefined; }
  }
  function accept(token: Token) {
    switch (token.name) {
      case "startObject": case "startArray": {
        maximumDepth = parents ? (maximumDepth < parents.length + 1 ? parents.length + 1 : maximumDepth)
          : Math.max(maximumDepth, (parents ?? stack!).length + 1); checkStructure();
        const value = token.name === "startArray" ? [] : {};
        // A child attaches BEFORE descent, so its parent's key is no longer
        // needed. The next sibling supplies a new key after ascent.
        attach(value); if (parents) ownedArchiveProperty(parents, parents.length,
          { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
        else stack!.push({ value }); break;
      }
      case "endObject": case "endArray":
        if (parents) { if (parents.length) parents.length--; } else (parents ?? stack!).pop(); break;
      case "startKey": key = true; scalar = ""; break;
      case "startString": case "startNumber": key = false; scalar = ""; break;
      case "stringChunk": case "numberChunk":
        scalar += token.value;
        if (key || token.name === "numberChunk") { maximumScalar = parents ? (maximumScalar < scalar.length ? scalar.length : maximumScalar) : Math.max(maximumScalar, scalar.length); checkStructure(); }
        break;
      case "endKey": if (parents) pendingKey = scalar; else stack!.at(-1)!.key = scalar; scalar = ""; break;
      case "endString": attach(scalar); scalar = ""; break;
      case "endNumber": attach(privateParents ? privateJsonNumber(scalar) : Number(scalar)); scalar = ""; break;
      case "nullValue": case "trueValue": case "falseValue":
        if (privateParents) attach(token.name === "nullValue" ? null : token.name === "trueValue");
        else attach(token.value); break;
    }
  }
  let consume: ReturnType<typeof createJsonTokenizer> | undefined = createJsonTokenizer(accept);
  const discard = () => { consume = undefined; root = undefined; scalar = ""; pendingKey = undefined; (parents ?? stack!).length = 0; };
  const push = (text: string): void => {
    if (!consume) throw new TypeError("JSON parser is retired");
    for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));
  };
  const take = (): unknown => {
    if (!consume) throw new TypeError("JSON parser is retired");
    try { consume.end(); return root; }
    finally { discard(); }
  };
  if (privateParents) return { push, take, discard };
  return {
    push,
    end(): unknown {
      if (!consume) throw new TypeError("JSON parser is retired");
      consume.end(); return root;
    },
    // Shared-route byte-zero intake preserves small JSON.parse structural
    // acceptance, then applies the existing bounds once it exceeds 8 MiB.
    enforceStructureLimits(): void { enforceStructure = true; checkStructure(); },
    // Move the completed graph to one caller and drop all parser/tokenizer
    // references. Existing end() callers retain their original behavior.
    take,
    discard,
  };
}

// The same structural bounds for a message that already arrived whole, such as
// an expanded WebSocket create. Feeds are re-decoded copies, never slices: a
// retained 13+ character value sliced from the message would pin all of it.
export function parseBoundedJson(text: string): unknown {
  const parser = createJsonBodyParser(), decoder = new TextDecoder();
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + stringChunk);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    parser.push(decoder.decode(encoder.encode(text.slice(offset, end))));
    offset = end;
  }
  return parser.end();
}
