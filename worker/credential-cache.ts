import { admitIdentity, copyIdentity, identityFailure } from "./identity-admission.ts";
import { grantRevision, grantUsable, REFRESH_MARGIN_MS } from "./grant-eligibility.ts";
import { HotCache, hotCacheConfig, registerHotCache, tryRunInBackground, type HotCacheState, type HotCacheConfig, PrivateCacheReservation, hotCacheNow, waitForOtherRequest, JOIN_WAIT_MS } from "./hot-cache.ts";
import type { Env, UpstreamGrant } from "./types";
import { checkOwnedGenerationPrefetch, claimOwnedGenerationPrefetch, finishOwnedGenerationPrefetch,
  materializeOwnedGenerationPrefetch, checkCredentialGenerationDestination, type GenerationSelectionHandle, type OwnedGenerationPrefetch } from "./credential-preflight.ts";
import { GenerationConsumptionLease } from "./credential-preflight-arena.ts";
import { measureGenerationGraph, freezeGenerationGraph } from "./identity-generations.ts";

// Materialized upstream credentials, isolate memory only: never persisted,
// logged or returned to callers. A revoked or rotated credential can be used by
// this isolate until the max age or the token's refresh margin, whichever is first.
const credentials = registerHotCache(new HotCache<UpstreamGrant>(1024));

// The routing projection's generation/revision identify the published credential version.
const entryId = (key: string, grant: UpstreamGrant) => `${key}\n${grant.credentialGeneration ?? ""}\n${grantRevision(grant) ?? ""}`;
const loader = (materialize: () => Promise<UpstreamGrant>) => async () => {
  const materialized = await materialize();
  admitIdentity(materialized, "record");
  const expiresAt = materialized.expiresAt ? Date.parse(materialized.expiresAt) - REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY;
  return { value: materialized, cacheable: grantUsable(materialized), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY };
};

export async function cachedGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>, observe?: (state: HotCacheState, waitedMs: number) => void): Promise<UpstreamGrant> {
  admitIdentity(grant, "record");
  const config = hotCacheConfig(env), start = performance.now();
  if (!config.maxAgeMs) { const value = await materialize(); admitIdentity(value, "record"); observe?.("off", performance.now() - start); return value; }
  const { value, state } = await credentials.get(entryId(key, grant), config, loader(materialize));
  observe?.(state, performance.now() - start);
  // Callers may decorate the grant; never hand out the shared cached object.
  return copyIdentity(value);
}

/**
 * Warm the exact entry a later lookup for this grant version will use, so an
 * admission round trip and the credential owner round trip overlap. A version
 * mismatch simply leaves the prefetched entry unused.
 */
export function prefetchGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>): void {
  admitIdentity(grant, "record");
  const config = hotCacheConfig(env), id = entryId(key, grant);
  if (!config.maxAgeMs || credentials.peek(id, config)) return;
  tryRunInBackground(() => credentials.load(id, config, loader(materialize)));
}

/** Drop every cached version of a grant (upstream 401/403, credential failure, revoke). */
export function evictGrantCredentials(key: string): void {
  credentials.deleteKeys(id => id.startsWith(`${key}\n`));
}

// New PRIVATE destination only. Ordinary credentials, callers and bodies above
// remain unchanged. No entry or fulfilled graph enters the ordinary HotCache.
export type OwnedCredentialPrefetchReceipt = Readonly<{ accepted: false } | { accepted: true; completed: Promise<void> }>;
export interface OwnedCredentialBorrow { dispose(): void }
const ownedPrefetchRejected: OwnedCredentialPrefetchReceipt = Object.freeze({ accepted: false });
type OwnedCommand = ReturnType<typeof claimOwnedGenerationPrefetch>;
interface OwnedAuthorityIndex { binding: NonNullable<Env["ACCESS_CONTROL"]>; owners: WeakMap<NonNullable<Env["GRANT_CREDENTIALS"]>, OwnedDestinationPartition>; count: number; funding: PrivateCacheReservation }
interface OwnedDestinationPartition { authority: OwnedAuthorityIndex; binding: NonNullable<Env["GRANT_CREDENTIALS"]>; entries: Map<string, OwnedDestinationEntry>; funding: PrivateCacheReservation }
interface OwnedDestinationEntry { partition: OwnedDestinationPartition; id: string; current?: OwnedDestinationValue; publication?: object; active: number; values: number; funding: PrivateCacheReservation }
interface OwnedDestinationValue { entry?: OwnedDestinationEntry; grant?: UpstreamGrant; funding: PrivateCacheReservation; storedAt: number; maxAgeMs: number; expiresAt: number; published: boolean; borrowers: number }
interface OwnedBorrowOwner { value?: OwnedDestinationValue; funding: GenerationConsumptionLease }
let ownedAuthorities: WeakMap<NonNullable<Env["ACCESS_CONTROL"]>, OwnedAuthorityIndex> | undefined;
let ownedIndexFunding: PrivateCacheReservation | undefined;
let ownedAuthorityCount = 0;
let ownedBorrows: WeakMap<OwnedCredentialBorrow, OwnedBorrowOwner> | undefined;
let ownedBorrowFunding: GenerationConsumptionLease | undefined;
let ownedBorrowCount = 0;

// Each fixed vector includes the receipt and exact-charge object/fields, owner,
// index cells, flags, number/timestamp cells and fixed property-name occurrences.
// ID occurs twice (entry field + Map key). No view or equal-string discount.
function ownedIndexVector(payloadBytes: number, structure = 64) { return { serializedBytes: 0, payloadBytes, structure }; }
function lookupOwnedEntry(command: OwnedCommand): OwnedDestinationEntry | undefined {
  return command.authority && command.binding ? ownedAuthorities?.get(command.authority)?.owners.get(command.binding)?.entries.get(command.id) : undefined;
}
function retireOwnedEntry(entry: OwnedDestinationEntry): void {
  if (!entry.partition || entry.current || entry.active || entry.values) return;
  const partition = entry.partition, authority = partition.authority;
  partition.entries.delete(entry.id); entry.id = ""; entry.partition = undefined as never; entry.publication = undefined;
  const failures: unknown[] = [];
  try { entry.funding.release(); } catch (error) { failures.push(error); }
  if (!partition.entries.size) {
    authority.owners.delete(partition.binding); partition.binding = undefined as never; partition.authority = undefined as never; partition.entries = undefined as never;
    try { partition.funding.release(); } catch (error) { failures.push(error); }
    if (!--authority.count) {
      ownedAuthorities!.delete(authority.binding); authority.binding = undefined as never; authority.owners = undefined as never;
      try { authority.funding.release(); } catch (error) { failures.push(error); }
      if (!--ownedAuthorityCount) { ownedAuthorities = undefined; const funding = ownedIndexFunding; ownedIndexFunding = undefined; try { funding?.release(); } catch (error) { failures.push(error); } }
    }
  }
  if (failures.length) throw new AggregateError(failures, "private credential index retirement");
}
function acquireOwnedEntry(command: OwnedCommand): OwnedDestinationEntry | undefined {
  const found = lookupOwnedEntry(command); if (found) { found.active++; return found; }
  if (!command.authority || !command.binding) throw identityFailure("protocol");
  let root: PrivateCacheReservation | null | undefined, authorityFunding: PrivateCacheReservation | null | undefined;
  let partitionFunding: PrivateCacheReservation | null | undefined, entryFunding: PrivateCacheReservation | null | undefined;
  let hasPrimary = false, primary: unknown;
  try {
    // Complete simultaneous metadata is reserved BEFORE the first index factory.
    if (!ownedAuthorities && !(root = PrivateCacheReservation.reserve(ownedIndexVector(2048)))) return;
    let authority = ownedAuthorities?.get(command.authority);
    if (!authority && !(authorityFunding = PrivateCacheReservation.reserve(ownedIndexVector(2048)))) return;
    let partition = authority?.owners.get(command.binding);
    if (!partition && !(partitionFunding = PrivateCacheReservation.reserve(ownedIndexVector(2048)))) return;
    if (!(entryFunding = PrivateCacheReservation.reserve(ownedIndexVector(2048 + 4 * command.id.length)))) return;
    if (!ownedAuthorities) { ownedAuthorities = new WeakMap(); ownedIndexFunding = root!; root = undefined; }
    if (!authority) { authority = { binding: command.authority, owners: new WeakMap(), count: 0, funding: authorityFunding! }; authorityFunding = undefined; ownedAuthorities.set(command.authority, authority); ownedAuthorityCount++; }
    if (!partition) { partition = { authority, binding: command.binding, entries: new Map(), funding: partitionFunding! }; partitionFunding = undefined; authority.owners.set(command.binding, partition); authority.count++; }
    const entry: OwnedDestinationEntry = { partition, id: command.id, active: 1, values: 0, funding: entryFunding };
    entryFunding = undefined; partition.entries.set(entry.id, entry); return entry;
  } catch (error) { hasPrimary = true; primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try { entryFunding?.release(); } catch (error) { failures.push(error); }
    try { partitionFunding?.release(); } catch (error) { failures.push(error); }
    try { authorityFunding?.release(); } catch (error) { failures.push(error); }
    try { root?.release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "private credential index preparation");
  }
}
function retireOwnedValue(value: OwnedDestinationValue): void {
  if (value.published || value.borrowers) return;
  const entry = value.entry!; value.entry = undefined; value.grant = undefined;
  const failures: unknown[] = [];
  try { value.funding.release(); } catch (error) { failures.push(error); }
  entry.values--;
  try { retireOwnedEntry(entry); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "private credential value retirement");
}
function unpublishOwnedValue(entry: OwnedDestinationEntry): void {
  const current = entry.current; entry.current = undefined;
  if (current) { current.published = false; retireOwnedValue(current); }
}
function peekOwnedValue(entry: OwnedDestinationEntry | undefined, config: HotCacheConfig): OwnedDestinationValue | undefined {
  const value = entry?.current; if (!value || !config.maxAgeMs) return;
  const now = hotCacheNow();
  if (now < value.storedAt || now - value.storedAt >= Math.min(config.maxAgeMs, value.maxAgeMs) || now >= value.expiresAt) {
    // Expiry fences late publication but never retires a live borrower/original.
    entry!.publication = undefined; unpublishOwnedValue(entry!); return;
  }
  return value;
}
function ownedValueFresh(value: OwnedDestinationValue | undefined, config: HotCacheConfig): boolean {
  return !!value && hotCacheNow() - value.storedAt < config.freshMs;
}

interface OwnedPrefetchRun {
  cap?: OwnedGenerationPrefetch; command?: OwnedCommand;
  original?: Promise<void>; completed?: Promise<void>; resolve?: () => void; reject?: (error: unknown) => void;
  started: boolean; finished: boolean; claimed: boolean; registrationFailed: boolean; registrationError?: unknown;
}
let ownedPrefetchPermits: WeakMap<object, OwnedGenerationPrefetch> | undefined;
let ownedPrefetchPermitCharge: GenerationConsumptionLease | undefined;
let ownedPrefetchPermitCount = 0;
export function ownsCredentialPrefetchPermit(permit: object, cap: OwnedGenerationPrefetch): boolean { return ownedPrefetchPermits?.get(permit) === cap; }
function newOwnedPrefetchRun(cap: OwnedGenerationPrefetch): OwnedPrefetchRun {
  checkOwnedGenerationPrefetch(cap);
  if (!ownedPrefetchPermits) {
    try { ownedPrefetchPermitCharge = GenerationConsumptionLease.reserve(512); ownedPrefetchPermits = new WeakMap(); }
    catch (primary) { try { cap.dispose(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned prefetch registration"); } throw primary; }
  }
  const run: OwnedPrefetchRun = { cap, started: false, finished: false, claimed: false, registrationFailed: false };
  ownedPrefetchPermits.set(run, cap); ownedPrefetchPermitCount++;
  try { run.command = claimOwnedGenerationPrefetch(cap, run); run.claimed = true; return run; }
  catch (error) { retireOwnedPrefetch(run, true, error); throw error; }
}
function retireOwnedPrefetch(run: OwnedPrefetchRun, hasPrimary: boolean, primary?: unknown): void {
  if (run.finished) return;
  run.finished = true;
  const failures: unknown[] = [];
  if (run.registrationFailed) failures.push(run.registrationError);
  run.registrationError = undefined;
  const cap = run.cap; run.cap = undefined; run.command = undefined; run.original = undefined;
  // Only after the ORIGINAL materialization and all app graph/promise aliases
  // clear can the 32 MiB temporary owner retire. Destination owns a NEW debit.
  try { if (cap) { if (run.claimed) finishOwnedGenerationPrefetch(cap, run); else cap.dispose(); } } catch (error) { failures.push(error); }
  ownedPrefetchPermits!.delete(run);
  if (!--ownedPrefetchPermitCount) { ownedPrefetchPermits = undefined; const charge = ownedPrefetchPermitCharge; ownedPrefetchPermitCharge = undefined; try { charge?.release(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned credential prefetch cleanup");
  if (hasPrimary) throw primary;
}
function settleOwnedPrefetch(run: OwnedPrefetchRun, hasPrimary: boolean, primary?: unknown): void {
  const resolve = run.resolve!, reject = run.reject!;
  run.resolve = undefined; run.reject = undefined; run.completed = undefined;
  try { retireOwnedPrefetch(run, hasPrimary, primary); resolve(); } catch (error) { reject(error); }
}
async function loadOwnedDestination(run: OwnedPrefetchRun): Promise<void> {
  let entry = acquireOwnedEntry(run.command!);
  if (!entry) return; // Optional index refusal starts no materialization.
  let original: Promise<UpstreamGrant> | undefined, value: UpstreamGrant | undefined, publication: object | undefined;
  let destination: PrivateCacheReservation | null | undefined, hasPrimary = false, primary: unknown;
  try {
    const deadline = Date.now() + JOIN_WAIT_MS;
    while (entry.publication) {
      let pending: object | undefined = entry.publication;
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      // Only THIS request's scalar polling/timers. No foreign promise or I/O.
      await waitForOtherRequest(() => entry!.publication !== pending, remaining); pending = undefined;
      if (ownedValueFresh(peekOwnedValue(entry, run.command!.config), run.command!.config)) return;
    }
    publication = Object.freeze({}); entry.publication = publication;
    original = materializeOwnedGenerationPrefetch(run.cap!, run);
    value = await original;
    original = undefined; // ORIGINAL fetch/read/FIRSTcancel/unlock already joined.
    admitIdentity(value, "record");
    const vector = measureGenerationGraph(value);
    freezeGenerationGraph(value);
    const expires = value.expiresAt ? Date.parse(value.expiresAt) - REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY;
    if (!grantUsable(value) || entry.publication !== publication) return;
    // Graph + value owner + vector receipt/exact-charge metadata, while full
    // temporary traversal/source funding is STILL held. Refusal keeps old value.
    destination = PrivateCacheReservation.reserve({ serializedBytes: vector.serializedBytes,
      payloadBytes: vector.payloadBytes + 1024, structure: vector.structure + 64 });
    if (!destination || entry.publication !== publication) return;
    const next: OwnedDestinationValue = { entry, grant: value, funding: destination, storedAt: hotCacheNow(),
      maxAgeMs: run.command!.config.maxAgeMs, expiresAt: Number.isFinite(expires) ? expires : Number.POSITIVE_INFINITY, published: true, borrowers: 0 };
    const previous = entry.current; entry.values++; entry.current = next; destination = undefined;
    if (previous) { previous.published = false; retireOwnedValue(previous); }
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    // No graph-valued promise/follower escapes. A refused/new invalidated graph
    // has no destination; clear EVERY operation alias before temporary cleanup.
    value = undefined; original = undefined;
    const failures: unknown[] = [];
    try { destination?.release(); } catch (error) { failures.push(error); }
    if (entry.publication === publication) entry.publication = undefined;
    publication = undefined;
    entry.active--; const retired = entry; entry = undefined;
    try { retireOwnedEntry(retired); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "private credential load retirement");
  }
  if (hasPrimary) throw primary;
}
function startOwnedPrefetch(run: OwnedPrefetchRun): Promise<void> {
  run.started = true; const completed = run.completed!;
  try { run.original = loadOwnedDestination(run); } catch (error) { run.original = Promise.reject(error); }
  void run.original.then(() => settleOwnedPrefetch(run, false), error => settleOwnedPrefetch(run, true, error));
  return completed;
}

/** Inactive private destination; it does NOT warm ordinary foreground callers. */
export function prefetchOwnedGrantCredentials(cap: OwnedGenerationPrefetch): OwnedCredentialPrefetchReceipt {
  const run = newOwnedPrefetchRun(cap);
  try {
    const command = run.command!;
    if (!command.eligible || !command.config.maxAgeMs || ownedValueFresh(peekOwnedValue(lookupOwnedEntry(command), command.config), command.config)) {
      retireOwnedPrefetch(run, false); return ownedPrefetchRejected;
    }
    const completed = new Promise<void>((resolve, reject) => { run.resolve = resolve; run.reject = reject; });
    run.completed = completed; void completed.then(() => undefined, () => undefined);
    let accepted: boolean;
    try { accepted = tryRunInBackground(() => startOwnedPrefetch(run)); }
    catch (error) { if (!run.started) throw error; run.registrationFailed = true; run.registrationError = error; accepted = true; }
    if (!accepted && !run.started) {
      const resolve = run.resolve!; retireOwnedPrefetch(run, false);
      run.resolve = undefined; run.reject = undefined; run.completed = undefined; resolve(); return ownedPrefetchRejected;
    }
    return Object.freeze({ accepted: true, completed });
  } catch (primary) {
    if (!run.started) {
      const reject = run.reject; run.resolve = undefined; run.reject = undefined; run.completed = undefined;
      if (!run.finished) try { retireOwnedPrefetch(run, true, primary); } catch (failure) { reject?.(failure); throw failure; }
      reject?.(primary);
    }
    throw primary;
  }
}
function disposeOwnedCredentialBorrow(this: OwnedCredentialBorrow): void {
  const owner = ownedBorrows?.get(this); if (!owner) throw identityFailure("protocol");
  ownedBorrows!.delete(this); const value = owner.value!; owner.value = undefined;
  const failures: unknown[] = [];
  value.borrowers--; try { retireOwnedValue(value); } catch (error) { failures.push(error); }
  try { owner.funding.release(); } catch (error) { failures.push(error); }
  if (!--ownedBorrowCount) { ownedBorrows = undefined; const funding = ownedBorrowFunding; ownedBorrowFunding = undefined; try { funding?.release(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "private credential borrower retirement");
}
export function borrowOwnedGrantCredentials(cap: OwnedGenerationPrefetch): OwnedCredentialBorrow | undefined {
  const run = newOwnedPrefetchRun(cap); let result: OwnedCredentialBorrow | undefined, funding: GenerationConsumptionLease | undefined;
  let hasPrimary = false, primary: unknown;
  try {
    const value = peekOwnedValue(lookupOwnedEntry(run.command!), run.command!.config);
    if (value) {
      // Caller-lived metadata has real COMMON backing, independent of optional
      // cache coordinates. Existing graph/debit is borrowed without another RPC.
      funding = GenerationConsumptionLease.reserve(4096);
      if (!ownedBorrows) { ownedBorrowFunding = GenerationConsumptionLease.reserve(512); ownedBorrows = new WeakMap(); }
      const owner: OwnedBorrowOwner = { value, funding }, handle = Object.freeze({ dispose: disposeOwnedCredentialBorrow });
      ownedBorrows.set(handle, owner); ownedBorrowCount++; value.borrowers++; result = handle; funding = undefined;
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures: unknown[] = [];
  try { funding?.release(); } catch (error) { failures.push(error); }
  try { retireOwnedPrefetch(run, hasPrimary, primary); } catch (error) { failures.push(error); }
  if (failures.length) { try { result?.dispose(); } catch (error) { failures.push(error); } throw failures.length === 1 ? failures[0] : new AggregateError(failures, "private credential borrow preparation"); }
  return result;
}
// Named cross-owner transfer: target provenance is checked inside the genuine
// selected-owner registry. The returned capability is still dispose-only.
export function moveOwnedCredentialBorrow(borrow: OwnedCredentialBorrow, selected: GenerationSelectionHandle, env: Env): OwnedCredentialBorrow {
  const owner = ownedBorrows?.get(borrow); if (!owner?.value?.entry) throw identityFailure("protocol");
  const entry = owner.value.entry, partition = entry.partition;
  checkCredentialGenerationDestination(selected, env, partition.authority.binding, partition.binding, entry.id);
  // The original 4096-byte borrower/terminal component prepays simultaneous old/new
  // capability and WeakMap products. No graph clone or additional ref occurs.
  const adopted = Object.freeze({ dispose: disposeOwnedCredentialBorrow });
  ownedBorrows!.set(adopted, owner); ownedBorrows!.delete(borrow); return adopted;
}
export function evictOwnedGrantCredentials(cap: OwnedGenerationPrefetch): void {
  const run = newOwnedPrefetchRun(cap); let hasPrimary = false, primary: unknown;
  try { const entry = lookupOwnedEntry(run.command!); if (entry) { entry.publication = undefined; unpublishOwnedValue(entry); retireOwnedEntry(entry); } }
  catch (error) { hasPrimary = true; primary = error; }
  retireOwnedPrefetch(run, hasPrimary, primary);
}
