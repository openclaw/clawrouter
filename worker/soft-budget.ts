import { identityFailure } from "./identity-admission.ts";
import { searchJsonBytes } from "./minimax-search-operation.ts";
import { musicCoverControlHeader, musicCoverControlVersion, musicCoverUnavailable, type MiniMaxMusicCoverControl } from "./minimax-music-cover-control.ts";
import type { BudgetReservationPlan } from "./accounting.ts";
import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { admitBudgetPlan, planBudgetReservation, type BudgetReservation } from "./accounting.ts";
import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache } from "./hot-cache.ts";
import { HttpError } from "./utils.ts";
import { admitSoftStatusRequest } from "./soft-budget-json.ts";
import { accountingAdmissionFailure, accountingIdentity, accountingNumberCapacity, admitAccountingJson, isAccountingAdmissionFailure } from "./json-body.ts";
import { readSoftStatus } from "./soft-budget-response.ts";
import { prepareOwnedHttpSoftStatus, startOwnedHttpSoftStatus, bindOwnedHttpSoftStatus, finishOwnedHttpSoftStatus, checkOwnedHttpSoftStatusRetirement, type OwnedHttpRequest, type OwnedStatusReader } from "./http-identity-owner.ts";
import type { HttpOperation } from "./http-operation.ts";

// Soft: ledger status runs concurrently with the upstream request and settlement
// is asynchronous. Stored policies without a mode keep reserve (hard caps); new
// policies are created soft by the admin API and console.
export function softBudgetPolicy(policy: { budgetMode?: "reserve" | "soft" }): boolean {
  return policy.budgetMode === "soft";
}

// Only time spent after upstream headers counts against this grace period.
export const softBudgetGraceMs = 50;

// Recently observed exhausted scopes, per isolate. A hit denies the next request
// before any upstream work; otherwise status never delays the request.
const exhausted = registerHotCache(new HotCache<true>(4096));

type SoftLeg = ReturnType<typeof planBudgetReservation>["legs"][number];
const legId = (leg: SoftLeg) => `${leg.objectName}\n${leg.request.scopeKey}\n${leg.request.windowKey}\n${leg.request.limitMicros}`;

function softDenial(leg: SoftLeg, connection: { providerId: string }, at = Date.now()): HttpError {
  const kind = leg.kind;
  const monthlyReset = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1)).toISOString();
  const message = kind === "daily" ? dailyBudgetMessage(leg.request.limitMicros, at) : kind === "weekly" ? weeklyBudgetMessage(leg.request.limitMicros, at)
    : `${kind === "policy" ? "proxy key budget is exhausted" : `provider ${connection.providerId} monthly budget is exhausted`}; resets at ${monthlyReset}.`;
  return new HttpError(402, kind === "daily" ? "daily_budget_exhausted" : kind === "weekly" ? "weekly_budget_exhausted" : kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted", withLimitHint(message, leg));
}

/** Synchronous pre-dispatch check: zero limits and recently observed exhaustion. */
export function softBudgetPreflight(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection): HttpError | undefined {
  const config = hotCacheConfig(env);
  for (const leg of planBudgetReservation(auth, capability, { reserveMicros: 0, basis: "none", inputTokens: null, outputTokens: null }, connection, Date.now(), true).legs) {
    if (leg.request.limitMicros === 0 || exhausted.peek(legId(leg), config)) return softDenial(leg, connection);
  }
  return undefined;
}

export function prepareSoftBudget(auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, search = false) {
  accountingIdentity(requestId); accountingIdentity(capability); accountingIdentity(connection.providerId);
  const plan = planBudgetReservation(auth, capability, { reserveMicros: 0, basis: "none", inputTokens: null, outputTokens: null }, connection, Date.now(), true);
  if (search) admitBudgetPlan(plan, true);
  const descriptors = plan.legs.map(leg => {
    const limit = String(leg.request.limitMicros);
    if (!search && leg.request.limitMicros !== 0) {
      try { admitSoftStatusRequest(leg.objectName, leg.request.policyId, leg.request.windowKey, leg.request.scopeKey!, limit); }
      catch { accountingAdmissionFailure(); }
    }
    const chargeLength = 7 + requestId.length + leg.request.scopeKey!.length + leg.request.windowKey.length + 2;
    if (chargeLength > 8192) accountingAdmissionFailure();
    const request = { chargeId: `charge:${requestId}:${leg.request.scopeKey}:${leg.request.windowKey}`,
      policyId: leg.request.policyId, windowKey: leg.request.windowKey, scopeKey: leg.request.scopeKey!, capability };
    admitAccountingJson({ kind: "budget_charge", ledger: { objectName: leg.objectName }, request: { ...request, amountMicros: accountingNumberCapacity() } }, "intent");
    if (search) admitAccountingJson({ kind: "budget_charge", ledger: { objectName: leg.objectName }, request: { ...request, amountMicros: accountingNumberCapacity() } }, "search");
    const url = new URL("https://clawrouter.internal/status");
    url.searchParams.set("policy_id", leg.request.policyId); url.searchParams.set("window_key", leg.request.windowKey);
    url.searchParams.set("scope_key", leg.request.scopeKey!); url.searchParams.set("limit_micros", limit);
    return { leg, url: url.href, charge: { objectName: leg.objectName, request } };
  });
  const reservation: BudgetReservation = { reservations: [], reservedMicros: 0, charges: descriptors.map(item => item.charge) };
  admitAccountingJson(reservation, "capsule");
  return { descriptors, reservation, providerId: connection.providerId };
}
export type PreparedSoftBudget = ReturnType<typeof prepareSoftBudget>;

export function softBudget(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  return startSoftBudget(env, prepareSoftBudget(auth, capability, connection, requestId, !!search), abort, search);
}
export function startSoftBudget(env: Env, prepared: PreparedSoftBudget, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  return observeSoftBudget(env.BUDGET_LEDGER, hotCacheConfig(env), prepared, abort, search);
}
function observeSoftBudget(namespace: Env["BUDGET_LEDGER"], config: ReturnType<typeof hotCacheConfig>,
  { descriptors, reservation, providerId }: PreparedSoftBudget, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  let denial: HttpError | undefined;
  let admissionFailure: HttpError | undefined;
  let delivered = false;
  let complete = false;
  const check = Promise.allSettled(descriptors.map(async ({ leg, url }) => {
    try {
      const status = leg.request.limitMicros === 0 ? null : search
        ? await search.controlJson<{ spentMicros: number }>({}, (_body, signal) => namespace.get(namespace.idFromName(leg.objectName)).fetch(url, { signal }))
        : await readSoftStatus(() => namespace.get(namespace.idFromName(leg.objectName)).fetch(url)) as { spentMicros: number } | null;
      // Zero is a configured block even when its reporting ledger is unavailable.
      if (leg.request.limitMicros !== 0 && (!status || !Number.isSafeInteger(status.spentMicros) || status.spentMicros < leg.request.limitMicros)) {
        exhausted.delete(legId(leg));
        return;
      }
      // Remember for the fresh window so later requests stop before dispatch.
      exhausted.set(legId(leg), true, config, hotCacheNow() + config.freshMs);
      // Shared WebSocket lanes cannot abort one turn; only deny later creates.
      if (!abort || delivered || denial) return;
      denial = softDenial(leg, { providerId });
      abort(denial);
    } catch (error) { if (isAccountingAdmissionFailure(error)) throw error; /* Existing observation errors fail open. */ }
  })).then(outcomes => {
    complete = true;
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) { if (isAccountingAdmissionFailure(failed.reason)) admissionFailure = failed.reason; throw failed.reason; }
  });
  return {
    reservation, check,
    get denial() { return denial; },
    // Reads start at dispatch, so this only waits when the ledger is slower than
    // the provider's own time to headers; late results inform later requests.
    async beforeDelivery(): Promise<number> {
      if (admissionFailure) throw admissionFailure;
      if (complete || denial) { delivered = true; return 0; }
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([check, new Promise<void>(resolve => { timer = setTimeout(resolve, softBudgetGraceMs); })]); }
      finally { clearTimeout(timer); }
      delivered = true;
      return performance.now() - start;
    },
    close() { delivered = true; },
  };
}

// Closed private entry. Ordinary observers and readSoftStatus remain unchanged.
class OwnedSoftBudget {
  private config?: ReturnType<typeof hotCacheConfig>;
  private operation?: HttpOperation;
  private failure?: unknown;
  protected statusBits = 0;
  private get hasFailure(): boolean { return !!(this.statusBits & 1); }
  private set hasFailure(value: boolean) { this.statusBits = value ? this.statusBits | 1 : this.statusBits & ~1; }
  private get delivered(): boolean { return !!(this.statusBits & 2); }
  private set delivered(value: boolean) { this.statusBits = value ? this.statusBits | 2 : this.statusBits & ~2; }
  private get complete(): boolean { return !!(this.statusBits & 4); }
  private set complete(value: boolean) { this.statusBits = value ? this.statusBits | 4 : this.statusBits & ~4; }
  private get started(): boolean { return !!(this.statusBits & 8); }
  private set started(value: boolean) { this.statusBits = value ? this.statusBits | 8 : this.statusBits & ~8; }
  private get received(): number { return this.statusBits >>> 7 & 15; }
  private set received(value: number) { this.statusBits = this.statusBits & ~(15 << 7) | (value & 15) << 7; }
  private get remaining(): number { return this.statusBits >>> 11 & 7; }
  private set remaining(value: number) { this.statusBits = this.statusBits & ~(7 << 11) | (value & 7) << 11; }
  private denied?: HttpError;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;
  readonly check = new Promise<void>((yes, no) => { this.resolve = yes; this.reject = no; });
  declare readonly http: OwnedHttpRequest;
  declare readonly prepared: PreparedSoftBudget;
  constructor(http: OwnedHttpRequest, prepared: PreparedSoftBudget) {
    this.http = http; this.prepared = prepared;
    this.remaining = prepared.descriptors.length;
    if (ownedSoftBudgets?.has(http)) throw new TypeError("owned soft budget already prepared");
    (ownedSoftBudgets ??= new WeakMap()).set(http, this);
  }
  get denial(): HttpError | undefined { return this.denied; }
  start(env: Env, operation: HttpOperation): void {
    if (this.started) throw new TypeError("owned soft budget already started");
    bindOwnedHttpSoftStatus(this.http, env, this.prepared, operation);
    this.started = true;
    // Keep the original namespace/config lookup point after provider dispatch.
    this.config = hotCacheConfig(env); this.operation = operation;
    void this.check.then(() => undefined, () => undefined);
    startOwnedHttpSoftStatus(this.http);
    if (!this.remaining) { this.complete = true; this.resolve(); }
  }
  receive(index: number, succeeded: boolean, spent: number | null): void {
    if (!this.started || !Number.isInteger(index) || index < 0 || index >= this.prepared.descriptors.length || this.received & 1 << index)
      throw new TypeError("owned soft budget result is not current");
    this.received |= 1 << index;
    try {
      if (succeeded) {
        const leg = this.prepared.descriptors[index].leg;
        if (leg.request.limitMicros !== 0 && (spent === null || !Number.isSafeInteger(spent) || spent < leg.request.limitMicros)) exhausted.delete(legId(leg));
        else {
          exhausted.set(legId(leg), true, this.config!, hotCacheNow() + this.config!.freshMs);
          if (!this.delivered && !this.denied) {
            this.denied = softDenial(leg, { providerId: this.prepared.providerId });
            this.operation!.stop("upstream", this.denied);
          }
        }
      }
    } catch (error) {
      if (isAccountingAdmissionFailure(error)) { this.failure = error; this.hasFailure = true; }
      // The ordinary observer swallows other cache/denial observation failures.
    }
    if (!--this.remaining) {
      this.complete = true;
      if (this.hasFailure) this.reject(this.failure); else this.resolve();
    }
  }
  async beforeDelivery(): Promise<number> {
    if (this.hasFailure) throw this.failure;
    if (this.complete || this.denied) { this.delivered = true; return 0; }
    const start = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.check, new Promise<void>(resolve => { timer = setTimeout(resolve, softBudgetGraceMs); })]); }
    finally { clearTimeout(timer); }
    this.delivered = true; return performance.now() - start;
  }
  close(): void { this.delivered = true; }
}
export class OwnedStatusController extends OwnedSoftBudget {
  namespace?: Env["BUDGET_LEDGER"];
  get bound(): boolean { return !!(this.statusBits & 16); }
  set bound(value: boolean) { this.statusBits = value ? this.statusBits | 16 : this.statusBits & ~16; }
  get readersStarted(): boolean { return !!(this.statusBits & 32); }
  set readersStarted(value: boolean) { this.statusBits = value ? this.statusBits | 32 : this.statusBits & ~32; }
  get settled(): boolean { return !!(this.statusBits & 64); }
  set settled(value: boolean) { this.statusBits = value ? this.statusBits | 64 : this.statusBits & ~64; }
  private get physicalRemaining(): number { return this.statusBits >>> 14 & 7; }
  private set physicalRemaining(value: number) { this.statusBits = this.statusBits & ~(7 << 14) | (value & 7) << 14; }
  private resolveRetired!: () => void;
  readonly retired = new Promise<void>(done => { this.resolveRetired = done; });
  readonly readers: (OwnedStatusReader | undefined)[] = [];
  constructor(cap: OwnedHttpRequest, plan: PreparedSoftBudget) { super(cap, plan); }
  startReaders(): void {
    if (this.readersStarted || this.settled || !this.bound) throw identityFailure("protocol");
    this.readersStarted = true; this.physicalRemaining = this.prepared.descriptors.length;
    for (let index = 0; index < this.prepared.descriptors.length; index++) {
      if (this.prepared.descriptors[index].leg.request.limitMicros === 0) { this.decide(index, true, null); this.readers[index] = undefined; this.completeReader(); continue; }
      this.readers[index]!.start();
    }
    if (!this.physicalRemaining) this.finish();
  }
  decide(index: number, succeeded: boolean, spent: number | null): void { this.receive(index, succeeded, spent); }
  retire(index: number, reader: OwnedStatusReader): void {
    if (this.readers[index] !== reader) throw identityFailure("protocol");
    this.readers[index] = undefined; this.completeReader();
  }
  private completeReader(): void { if (!--this.physicalRemaining) this.finish(); }
  private finish(): void {
    if (this.settled) return;
    this.namespace = undefined; this.settled = true;
    finishOwnedHttpSoftStatus(this.http, this);
    this.resolveRetired();
  }
  abandonUnstarted(): void {
    if (this.readersStarted) return;
    this.readers.length = 0; this.finish();
  }
}

let ownedSoftBudgets: WeakMap<OwnedHttpRequest, OwnedSoftBudget> | undefined;
export function prepareOwnedHttpSoftBudget(http: OwnedHttpRequest, env: Env, prepared: PreparedSoftBudget): void {
  if (ownedSoftBudgets?.has(http)) throw new TypeError("owned soft budget already prepared");
  prepareOwnedHttpSoftStatus(http, env, prepared);
}
export function startOwnedHttpSoftBudget(http: OwnedHttpRequest, env: Env, prepared: PreparedSoftBudget, operation: HttpOperation): void {
  const owner = ownedSoftBudgets?.get(http);
  if (!owner || owner.prepared !== prepared) throw new TypeError("owned soft budget plan is not registered");
  owner.start(env, operation);
}
function ownedSoftBudget(http: OwnedHttpRequest): OwnedSoftBudget {
  const owner = ownedSoftBudgets?.get(http);
  if (!owner) throw identityFailure("protocol");
  return owner;
}
export function ownedHttpSoftBudgetCheck(http: OwnedHttpRequest): Promise<void> { return ownedSoftBudget(http).check; }
export function beforeOwnedHttpSoftDelivery(http: OwnedHttpRequest): Promise<number> { return ownedSoftBudget(http).beforeDelivery(); }
export function ownedHttpSoftDenial(http: OwnedHttpRequest): HttpError | undefined { return ownedSoftBudget(http).denial; }
export function closeOwnedHttpSoftBudget(http: OwnedHttpRequest): void { ownedSoftBudget(http).close(); }
export function retireOwnedHttpSoftBudget(http: OwnedHttpRequest): void { checkOwnedHttpSoftStatusRetirement(http); ownedSoftBudgets?.delete(http); }

// Cover completes and physically retires every observation BEFORE its final
// authority tail. No grace-period, cache or post-dispatch background work.
export async function musicCoverSoftBudget(env: Env, plan: BudgetReservationPlan, connection: ProviderConnection, owner: MiniMaxMusicCoverControl): Promise<void> {
  if (plan.legs.length > 4) musicCoverUnavailable();
  searchJsonBytes(plan);
  for (const leg of plan.legs) {
    if (leg.request.limitMicros === 0) throw softDenial(leg, connection);
    const status = await owner.controlJson<{ spentMicros: number }>({}, (_body, signal) => {
      const url = new URL("https://clawrouter.internal/status");
      for (const [key, value] of Object.entries({ policy_id: leg.request.policyId, window_key: leg.request.windowKey,
        scope_key: leg.request.scopeKey!, limit_micros: String(leg.request.limitMicros) })) url.searchParams.set(key, value);
      if (url.href.length > 4096) musicCoverUnavailable();
      return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(leg.objectName)).fetch(url, { signal, redirect: "manual",
        headers: { [musicCoverControlHeader]: musicCoverControlVersion } });
    });
    if (!Number.isSafeInteger(status.spentMicros) || status.spentMicros < 0) musicCoverUnavailable();
    if (status.spentMicros >= leg.request.limitMicros) throw softDenial(leg, connection);
  }
}
