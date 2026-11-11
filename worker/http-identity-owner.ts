import { inheritOwnedLocalError, clearOwnedLocalError } from "./native-errors.ts";
import { setOwnedHeader, deleteOwnedHeader, newOwnedHeaders, ownedMetadataString, captureOwnedResponseMetadata } from "./proxy-completion.ts";
import { ExactBodyCharge } from "./body-budget.ts";
import { identityFailure, isIdentityFailure, identityHeader, identitySourceBudget, identityPlan, admitIdentityBytes, admitIdentityHeaders, parseIdentity, IdentityWire } from "./identity-admission.ts";
import { createPrivateMaterializationReceipt, adoptPrivateMaterializationResponse, failPrivateMaterializationAcquisition,
  beginPrivateMaterializationAcquisition, abandonPrivateMaterializationReceipt, completePrivateMaterializationInstallation, consumePrivateMaterializationReceipt,
  type PrivateMaterializationReceipt, type PrivateMaterializationDestination } from "./identity-admission.ts";
import { ProxyCompletion, OwnedReaderDriver, claimOwnedHttpStaticCustody, inspectOwnedBytes, isLocalOwnedByteView, isLocalOwnedByteBacking, newOwnedBytes, ownedBytesFromBacking, ownedByteLength, ownedByteSubarray, copyOwnedBytes, newOwnedDecoder, decodeOwnedBytes, enqueueOwnedBytes, measureOwnedHeaders, newOwnedResponse } from "./proxy-completion.ts";
import type { Env, QueueMessage, AuthorizedIdentity, UsageEvent, BudgetReserveRequest, BudgetChargeRequest, BudgetSettleRequest } from "./types.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { matchesOwnedHttpProviderConfiguration, type UpstreamAuth } from "./providers.ts";
import type { PreparationAdmission } from "./provider-templates.ts";
import type { HttpOperation } from "./http-operation.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import { proxyKeyVerification } from "./proxy-auth.ts";
import { HttpError } from "./utils.ts";
import { selectedCredentialFailure } from "./grant-credential-failure.ts";
import { acceptOwnedAuthorizationSnapshot, retireOwnedResponseControl } from "./response-control-authorization.ts";
import { acceptOwnedVeniceInspection, retireOwnedVeniceRevalidation } from "./venice-chat-authority.ts";
import { acceptOwnedGmiInspection, retireOwnedGmiRevalidation } from "./gmi-organization-binding.ts";
import { drainOwnedHttpIdentity, retireOwnedHttpConsumers, retireOwnedHttpIdentity, claimOwnedHttpRevalidationBacking, matchesOwnedHttpMaterialization, matchesOwnedHttpPreflight, matchesOwnedHttpContinuation,
  admitOwnedHttpRevalidationBacking, retireOwnedHttpRevalidationBacking, type OwnedHttpRevalidationBacking, type OwnedHttpCredential } from "./credential-preflight.ts";
import { admitOwnedHttpCodecBacking, admitOwnedHttpUsageBacking, retireOwnedHttpCodecBacking, admitOwnedHttpConsumerBacking, retireOwnedHttpConsumerBacking } from "./credential-preflight.ts";
import { claimOwnedHttpArchiveFunding } from "./pricing.ts";
import { matchesOwnedHttpBudgetPlan, ownsConsumedHttpAccountingHandoff, ownsFailedHttpAccountingHandoff, captureOwnedHttpUsageStatus, matchesOwnedHttpPublicationContext, matchesOwnedHttpGenericUsageInput, acceptOwnedGenericUsage, matchesOwnedHttpConfigurationPreparation, matchesOwnedHttpInitialSelection, retireOwnedHttpProxy, matchesOwnedHttpArchiveInput, claimOwnedHttpArchiveInput, matchesOwnedHttpRevalidationInput, matchesOwnedHttpVeniceResponseInput, matchesOwnedHttpPublicBody, matchesOwnedHttpSoftStatusPlan, matchesOwnedHttpCodecConsumerInput, matchesOwnedHttpNormalizationInput, matchesOwnedHttpCodecNormalizationInput, matchesOwnedHttpCodecUsageInput, acceptOwnedCodecUsage, matchesOwnedHttpProviderFetchInput, acceptOwnedHttpProviderResponse } from "./proxy.ts";
import { retireOwnedVeniceChatCodec, matchesOwnedVeniceRetirement, consumeOwnedVeniceChatResponse, matchesOwnedVeniceOutputBody, matchesOwnedVeniceOutputFailure, matchesOwnedVeniceConsumerInput } from "./venice-chat-runtime.ts";
import { matchesOwnedCodecUsagePublication, type CodecReader, ownsOwnedNormalizerReader, acknowledgeOwnedNormalizerOutput, type OwnedNormalizerReader, GenericUsageReader, type ObservedUsage, matchesOwnedCodecOutputFailure, matchesOwnedCodecConsumerRetirement, retireOwnedCodecConsumers, ownedUsageCaptureBytes, type OwnedCodecConsumer } from "./proxy-response.ts";
import { admissionContinuationHeader, admissionContinuationVersion, admissionContinuationPath, credentialPreflightHeader, credentialPreflightVersion, credentialPreflightPath, credentialPreflightNamespace } from "./credential-preflight-protocol.ts";
import { usageShardName } from "./usage-sharding.ts";
import { logCorrelationError } from "./correlation.ts";
import type { AccountingSinks, BudgetReservation, BudgetReservationPlan, BudgetReservationIntent } from "./accounting.ts";
import { matchesOwnedHttpAccountingCommand, matchesOwnedHttpAccountingAdoption, matchesOwnedHttpAccountingFailure, adoptOwnedHttpAccountingTerminal, rejectOwnedHttpAccountingTerminal, retireOwnedHttpAccountingCommands, type OwnedHttpAccountingCommand } from "./proxy-accounting.ts";
import { parseSoftStatus, softStatusLimits, softStatusError } from "./soft-budget-json.ts";
import { privateSnapshotJson, privateGrantIdentityJson, privateIntentJson, privateCapsuleJson, copyPrivateQueueIntent, copyPrivateQueueCapsule, measurePrivateJsonBody } from "./json-body.ts";
import { OwnedStatusController, retireOwnedHttpSoftBudget, type PreparedSoftBudget } from "./soft-budget.ts";
import { createPrivatePreflightReceipt, adoptPrivatePreflightResponse, failPrivatePreflightAcquisition,
  beginPrivatePreflightAcquisition, abandonPrivatePreflightReceipt, completePrivatePreflightInstallation, consumePrivatePreflightReceipt, type PrivatePreflightReceipt,
  createPrivateContinuationReceipt, adoptPrivateContinuationResponse, failPrivateContinuationAcquisition,
  beginPrivateContinuationAcquisition, abandonPrivateContinuationReceipt, completePrivateContinuationInstallation, consumePrivateContinuationReceipt,
  type PrivateContinuationReceipt, type PrivateContinuationDestination } from "./credential-preflight-source.ts";
import type { PreflightTicket } from "./credential-preflight-arena.ts";
import type { IdentitySourceBudget } from "./identity-admission.ts";
import type { CredentialPreflightReply } from "./credential-preflight-protocol.ts";

// This entry is inactive until the named compiled HTTP adapter invokes it.
// Capabilities contain no request, identity, credential or preparation graph.
export interface OwnedHttpRequest { readonly kind?: never }
export interface OwnedHttpLocalFailure {
  readonly status: number; readonly code: string; readonly message: string;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface OwnedHttpUpload { readonly kind?: never }
export interface OwnedHttpSinkOwner { readonly sink?: never }
export interface OwnedHttpBudgetLeg { readonly budgetLeg?: never }
export interface OwnedHttpSinkRegistration { readonly registration?: never }
export interface OwnedHttpIntakeDiagnostics { readonly intake?: never }
export interface OwnedHttpRevalidation { readonly revalidation?: never }
export interface OwnedHttpNormalization { readonly normalization?: never }
type SinkOrigin = "acquire" | "fetch" | "body" | "read" | "closed" | "cancel" | "unlock" | "queue" | "put" | "pipe" | "abort" | "pull" | "retire" | "registration" | "registration-missing" | "listener-add" | "listener-remove" | "diagnostic" | "terminal-prepare" | "terminal-install" | "terminal-start" | "terminal-fallback" | "terminal-adoption" | "terminal-close";
type SinkDisposition = "transport" | "missing" | "conflict" | "protocol";
export interface OwnedHttpFailureMetadata {
  readonly origin: SinkOrigin; readonly ordinal: number; readonly failed: boolean;
  readonly primary: boolean; readonly primaryIsUndefined: boolean; readonly disposition: SinkDisposition;
}
type SinkOriginOwner = number;
type SinkOriginRecord = Readonly<OwnedHttpFailureMetadata>;
const sinkKinds: readonly SinkOrigin[] = Object.freeze(["acquire", "fetch", "body", "read", "closed", "cancel", "unlock", "queue", "put", "pipe", "abort", "pull", "retire", "registration", "registration-missing", "listener-add", "listener-remove", "diagnostic", "terminal-prepare", "terminal-install", "terminal-start", "terminal-fallback", "terminal-adoption", "terminal-close"]);

interface RequestOwner {
  request?: Request;
  env?: Env;
  funding: ExactBodyCharge;
  completion: ProxyCompletion;
  uploads: UploadOwner[];
  sealed: boolean;
  unknown: boolean;
  retirement?: Promise<void>;
  sink?: OwnedHttpSinkOwner;
  sinkPending: number;
  sinkClosed: boolean;
  sinkRetired: Promise<void>;
  resolveSink?: () => void;
  sinkOrigins?: Map<number, SinkOriginRecord | number>;
  nextSinkOrigin: number;
  sinkCredits: number;
  revalidationCredits: number;
  abortController?: AbortController;
  abortListener?: () => void;
  abortRemoval?: SinkOriginOwner;
  terminalRegistration?: SinkOriginOwner;
  budgetDenials?: WeakSet<object>;
  revalidations?: OwnedHttpRevalidation[];
  codecOrigins?: SinkOriginRecord[];
  softStatus?: OwnedStatusController;
  retiringConsumers?: true;
  accountingCredits?: number;
  accountingTerminalLegs?: number;
  accountingTerminalClaimed?: boolean;
  accountingTerminal?: OwnedAccountingTerminal;
  budgetSequence?: OwnedBudgetSequence;
  accountingPreparationOrigin?: SinkOriginOwner;
  accountingFallbackOrigin?: SinkOriginOwner;
  accountingAdoptionOrigin?: SinkOriginOwner;
  accountingCloseOrigin?: SinkOriginOwner;
  accountingInstallationOrigin?: SinkOriginOwner;
  accountingStartOrigin?: SinkOriginOwner;
  publicReaders?: WeakMap<Response, number>;
  publicOutputs?: WeakMap<ReadableStream<Uint8Array>, OwnedPublicReader>;
  metadata?: OwnedFinalMetadata;
  publication?: OwnedProxyPublication;
  publicCaptureLiveBytes: number;
  publicCaptureHighWater: number;
  errorState: number;
  terminalErrorCredit: number;
  localFailures?: WeakSet<object>;
  localErrorResponses?: Response[]; localErrorDisposals?: WeakSet<Response>;
  continuation?: OwnedContinuationAcquisition;
}
class UploadOwner {
  controller?: AbortController;
  listener?: () => void;
  source?: ReadableStream<Uint8Array>;
  fixed?: FixedLengthStream;
  private resolveJoined!: () => void;
  readonly joined = new Promise<void>(resolve => { this.resolveJoined = resolve; });
  private resolveRetired!: () => void;
  readonly retired = new Promise<void>(resolve => { this.resolveRetired = resolve; });
  abandonment?: Promise<void>;
  provider?: OwnedProviderFetch;
  private flags = 0;
  private pipeOrigin = 0;
  private observation?: OwnedOriginalObservation;
  readonly failures: unknown[] = [];
  declare readonly cap: OwnedHttpUpload;
  declare readonly request: RequestOwner;
  declare readonly listenerRemoval: SinkOriginOwner;
  constructor(cap: OwnedHttpUpload, request: RequestOwner, listenerRemoval: SinkOriginOwner) {
    this.cap = cap; this.request = request; this.listenerRemoval = listenerRemoval;
  }
  get started(): boolean { return !!(this.flags & 1); }
  get settled(): boolean { return !!(this.flags & 2); }
  get dispatched(): boolean { return !!(this.flags & 4); }
  get providerStarted(): boolean { return !!(this.flags & 512); }
  dispatch(): void { this.flags |= 4; }
  startProvider(): void { this.flags |= 512; }
  private unknown(): void { this.flags |= 32; this.request.unknown = true; }
  private schedule(): void {
    if (this.flags & (64 | 128)) return;
    this.flags |= 64;
    try { ownedBoundaryQueue(this.advance.bind(this)); } catch { this.unknown(); }
  }
  private advance(): void {
    this.flags &= ~64;
    if (this.flags & (8 | 32 | 128) || !(this.flags & 16)) return;
    this.flags |= 2 | 128;
    this.resolveJoined(); this.resolveJoined = undefined as never;
  }
  private accepted(): void {
    if (this.flags & 16) return;
    this.flags |= 16;
    this.schedule();
  }
  private rejected(reason: unknown): void {
    if (this.flags & 16) { reason = undefined; return; }
    this.flags |= 16;
    try { this.failures.push(failedSinkOrigin(this.request, this.pipeOrigin, reason)); }
    catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || this.flags & 256) { value = undefined; return; }
    try { if (failed) this.rejected(value); else this.accepted(); }
    finally { value = undefined; }
  }
  pipe(source: ReadableStream<Uint8Array>, fixed: FixedLengthStream): void {
    this.source = source; this.fixed = fixed; this.flags |= 1 | 8;
    this.pipeOrigin = sinkOrigin(this.request.sink!, "pipe");
    let original: Promise<void> | undefined;
    try {
      try { original = source.pipeTo(fixed.writable, { signal: this.controller!.signal }); }
      catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) {
        this.unknown();
        throw failedSinkOrigin(this.request, this.pipeOrigin, reason);
      }
    } finally { original = undefined; this.flags &= ~8; this.schedule(); }
  }
  unused(): void { this.flags |= 2; this.accepted(); }
  finish(): void {
    if (!this.settled || this.flags & (32 | 256)) return;
    if (!severOwnedOriginal(this.observation)) { this.unknown(); return; }
    this.observation = undefined; this.flags |= 256;
    retireOwnedSinkChild(this.request);
    this.resolveRetired(); this.resolveRetired = undefined as never;
  }
}

// Positive metadata backing precedes the registry/owner/control factories.
// These components are logical allowances, never JavaScript object sizes.
// Entry owns terminal registration plus one untouched-response cancellation.
const sinkOriginBytes = 2048;
// Cell C=1, P=6, two scalar values; two bound handlers; argument vector,
// owner slot and fixed installation/dispatch operands. This is an added
// prospective component, not a claim that the complete fixed windows fit.
const ownedOriginalCellBytes = 8 * (1 + 6 + 2 + 6 + 3 + 2 + 20)
  + 2 * "ownerkindstateobservationcancellation".length;
const ownedSinkOriginBytes = sinkOriginBytes + ownedOriginalCellBytes;
const requestMetadataBytes = 4096 + 4096 + 3 * sinkOriginBytes;
const uploadMetadataBytes = 4096;
const originalReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const ownedBoundaryThen = Promise.prototype.then;
const ownedBoundaryQueue = queueMicrotask;
const originalReaderRead = ReadableStreamDefaultReader.prototype.read;
let requests: WeakMap<OwnedHttpRequest, RequestOwner> | undefined;
let uploads: WeakMap<OwnedHttpUpload, UploadOwner> | undefined;
let registryFunding: ExactBodyCharge | undefined;
let requestCount = 0;
let sinkOwners: WeakMap<OwnedHttpSinkOwner, RequestOwner> | undefined;
let sinkFailures: WeakSet<object> | undefined;
let sinkRegistrations: WeakMap<OwnedHttpSinkRegistration, OwnedSinkRegistration> | undefined;
type IntakePhase = "acquire" | "read" | "closed" | "cancel" | "unlock" | "listenerAdd" | "listenerRemove" | "abort" | "pull" | "retire"
  | "readObserver" | "closedObserver" | "cancelObserver" | "unlockObserver";
type IntakeOwner = Partial<Record<IntakePhase, SinkOriginOwner>> & { owner: RequestOwner };
export type OwnedCodecRole = 0 | 1 | 2;
let intakes: WeakMap<OwnedHttpIntakeDiagnostics, IntakeOwner> | undefined;

// The capability has no graph, callback, receiver or mutable public field.
// It is minted before the first sink acquisition and stays with the request.
export function ownedHttpSinkOwner(cap: OwnedHttpRequest): OwnedHttpSinkOwner {
  const owner = requestOwner(cap);
  if (!owner.sink) throw identityFailure("protocol");
  return owner.sink;
}
export function registerOwnedHttpRetirement(cap: OwnedHttpRequest, context: Pick<ExecutionContext, "waitUntil">, work: Promise<void>): void {
  const owner = requestOwner(cap);
  if (work !== owner.retirement || !owner.terminalRegistration) throw identityFailure("protocol");
  // This original is the encompassing retirement itself: never enroll it in
  // the sink/root it joins. Its registration origin was funded at request entry.
  try { context.waitUntil(work); }
  catch (reason) { owner.unknown = true; throw failedSinkOrigin(owner, owner.terminalRegistration, reason); }
}
export function checkOwnedHttpSinkOwner(sink: OwnedHttpSinkOwner): void { sinkOwner(sink); }
export function recordOwnedHttpBudgetDenial(sink: OwnedHttpSinkOwner, error: object): void { sinkOwner(sink).budgetDenials!.add(error); }
export function isOwnedHttpBudgetDenial(sink: OwnedHttpSinkOwner, error: unknown): boolean {
  const owner = sinkOwner(sink);
  return error !== null && (typeof error === "object" || typeof error === "function") && owner.budgetDenials!.has(error);
}
function sinkOwner(sink: OwnedHttpSinkOwner): RequestOwner {
  const owner = sinkOwners?.get(sink);
  if (!owner || !owner.sink) throw identityFailure("protocol");
  return owner;
}
function enrollOwnedSinkChild(owner: RequestOwner): void {
  if (owner.sinkClosed || !Number.isSafeInteger(owner.sinkPending + 1)) throw identityFailure("protocol");
  owner.sinkPending++;
}
function retireOwnedSinkChild(owner: RequestOwner): void {
  if (owner.sinkPending <= 0) { owner.unknown = true; return; }
  owner.sinkPending--;
  finishOwnedSinkChildren(owner);
}
function finishOwnedSinkChildren(owner: RequestOwner): void {
  if (!owner.sinkClosed || owner.sinkPending || owner.unknown || !owner.resolveSink) return;
  owner.resolveSink(); owner.resolveSink = undefined;
}
function claimOwnedSinkFactories(): void {
  if (!claimOwnedHttpStaticCustody()) throw identityFailure("limit");
}
export function ownedHttpFailureMetadata(value: unknown): OwnedHttpFailureMetadata | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function") && sinkFailures?.has(value) ? value as OwnedHttpFailureMetadata : undefined;
}
function reserveSinkOrigins(sink: OwnedHttpSinkOwner, count: number): void {
  const owner = sinkOwner(sink);
  // Operation-local terminal origins are prepaid before acquisition/start.
  // Cancellation never has to compete for a new common-arena reservation.
  const charge = owner.funding.replace(owner.funding.bytes + count * ownedSinkOriginBytes);
  if (!charge) throw identityFailure("limit");
  owner.funding = charge; owner.sinkCredits += count;
}
function sinkOrigin(sink: OwnedHttpSinkOwner, origin: SinkOrigin): SinkOriginOwner {
  const owner = sinkOwner(sink), kind = sinkKinds.indexOf(origin);
  if (!owner.sinkCredits || kind < 0 || !Number.isSafeInteger(32 * owner.nextSinkOrigin + kind)) throw identityFailure("protocol");
  owner.sinkCredits--;
  // The ordinal is claimed now. Healthy origins construct no record/index/cap.
  return 32 * owner.nextSinkOrigin++ + kind;
}
function failedSinkOrigin(owner: RequestOwner, origin: SinkOriginOwner, reason: unknown, primary = true, disposition: SinkDisposition = "transport"): SinkOriginRecord {
  const ordinal = Math.floor(origin / 32);
  let record = owner.sinkOrigins!.get(ordinal);
  if (typeof record === "number") throw identityFailure("protocol"); // Its actual operation already retired.
  if (!record) {
    // Every possible occurrence was prepaid before its actual acquisition.
    // Independent origins remain independent, including equal/undefined reasons.
    record = Object.freeze({ origin: sinkKinds[origin % 32], ordinal,
      failed: true, primary, primaryIsUndefined: reason === undefined, disposition });
    owner.sinkOrigins!.set(ordinal, record); sinkFailures!.add(record);
  }
  return record;
}

// A retired status leg no longer exposes a failure carrier to any consumer.
// Its ordinal and all bounded facts remain CONTROL in the existing Map cells.
// This is representation compaction after joins, never a funding release.
function compactRetiredSinkOrigin(owner: RequestOwner, ordinal: number): void {
  const record = owner.sinkOrigins!.get(ordinal);
  if (!record || typeof record === "number") return;
  const disposition = record.disposition === "transport" ? 0 : record.disposition === "missing" ? 1 : record.disposition === "conflict" ? 2 : 3;
  const word = sinkKinds.indexOf(record.origin) | (record.primary ? 32 : 0) | (record.primaryIsUndefined ? 64 : 0) | disposition << 7;
  owner.sinkOrigins!.set(ordinal, word); sinkFailures!.delete(record);
}
function reportOwnedSinkDiagnostics(owner: RequestOwner, terminal: readonly unknown[]): void {
  if (!owner.sinkOrigins!.size) return;
  // The one reporting origin and its invocation products were prepaid at entry.
  // Claim now, after the originals whose order it follows; no early ordinal bank.
  const reporting = sinkOrigin(owner.sink!, "diagnostic");
  for (let ordinal = 0; ordinal < owner.nextSinkOrigin - 1; ordinal++) {
    const record = owner.sinkOrigins!.get(ordinal);
    if (record === undefined || typeof record !== "number" && terminal.includes(record)) continue;
    const word = typeof record === "number" ? record : sinkKinds.indexOf(record.origin)
      | (record.primary ? 32 : 0) | (record.primaryIsUndefined ? 64 : 0)
      | (record.disposition === "transport" ? 0 : record.disposition === "missing" ? 1 : record.disposition === "conflict" ? 2 : 3) << 7;
    try {
      // Fixed scalars only. Recovered transport failures stay diagnostics; this
      // consumer does not change accounting's result, retry, status or IDs.
      console.warn("owned_http_diagnostic", sinkKinds[word & 31], ordinal, true, !!(word & 32), !!(word & 64), word >>> 7);
    } catch (reason) {
      owner.unknown = true; throw failedSinkOrigin(owner, reporting, reason);
    }
  }
}



// Only these fixed original-operation owners can install this observer. Each
// escaping handler binds the fresh cell, never an owner or a payload. The cell
// remains live on UNKNOWN and is severed only at its owner's physical end.
type OwnedOriginalTarget = OwnedSinkVoidCommand | OwnedProviderFetch | OwnedLedgerCommand | OwnedTerminalOperation
  | UploadOwner | OwnedSinkRegistration | OwnedPreflightAcquisition | OwnedContinuationAcquisition | OwnedMaterializationAcquisition
  | OwnedLedgerAck | OwnedStatusReader;
interface OwnedOriginalObservation { owner: OwnedOriginalTarget | undefined; kind: number; state: number }
function ownedOriginalFulfilled(this: OwnedOriginalObservation, value: unknown): void {
  if (!this.owner || this.state & (1 | 8)) { value = undefined; return; }
  this.state |= 1 | 16;
  try { this.owner.dispatchOriginal(this, false, value); }
  finally { value = undefined; this.state &= ~16; }
}
function ownedOriginalRejected(this: OwnedOriginalObservation, reason: unknown): void {
  if (!this.owner || this.state & (1 | 8)) { reason = undefined; return; }
  this.state |= 1 | 16;
  try { this.owner.dispatchOriginal(this, true, reason); }
  finally { reason = undefined; this.state &= ~16; }
}
function installOwnedOriginal(cell: OwnedOriginalObservation, original: Promise<unknown>): void {
  try { installOwnedOriginalMethod(cell, original, original.then); }
  catch (reason) { cell.state |= 4; throw reason; }
  finally { original = undefined as never; cell = undefined as never; }
}
function installOwnedOriginalMethod(cell: OwnedOriginalObservation, original: unknown, then: unknown): void {
  try {
    void Reflect.apply(then as Function, original, [ownedOriginalFulfilled.bind(cell), ownedOriginalRejected.bind(cell)]);
    cell.state |= 2;
  } catch (reason) { cell.state |= 4; throw reason; }
  finally { original = undefined; then = undefined; cell = undefined as never; }
}
function severOwnedOriginal(cell: OwnedOriginalObservation | undefined): boolean {
  if (!cell) return true;
  if (cell.state !== 3) return false;
  cell.state = 8; cell.owner = undefined; cell.kind = 0;
  return true;
}

// Only the named void commands below construct this state. It accepts no
// callable producer/consumer and never stores a successful native value.
class OwnedSinkVoidCommand {
  private flags = 1; // installing, callback, failed, UNKNOWN, queued, delivered
  subject?: unknown;
  private observation?: OwnedOriginalObservation;
  private resolve!: () => void;
  private reject!: (failure: object) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  declare readonly owner: RequestOwner;
  declare readonly origin: SinkOriginOwner;
  declare readonly budget?: OwnedBudgetSequence;
  constructor(owner: RequestOwner, origin: SinkOriginOwner, budget?: OwnedBudgetSequence) {
    this.owner = owner; this.origin = origin; this.budget = budget;
    // Suppression belongs to our genuine void receipt, never the discarded
    // return of an external observer method.
    void this.ready.then(ignoreOwnedVoidOutcome, ignoreOwnedVoidOutcome);
  }
  private unknown(): void { this.flags |= 8; this.owner.unknown = true; }
  private schedule(): void {
    if (this.flags & 16) return;
    this.flags |= 16;
    try { ownedBoundaryQueue(this.advance.bind(this)); } catch { this.unknown(); }
  }
  private failure(reason: unknown): void {
    this.flags |= 4;
    try { failedSinkOrigin(this.owner, this.origin, reason); } catch { this.unknown(); }
  }
  private accepted(): void {
    if (this.flags & 2) return;
    this.flags |= 2; this.schedule();
  }
  private rejected(reason: unknown): void {
    if (this.flags & 2) { reason = undefined; return; }
    this.flags |= 2;
    this.failure(reason); reason = undefined; this.schedule();
  }
  invokedFailure(reason: unknown): void {
    this.rejected(reason); reason = undefined;
    this.flags &= ~1; this.schedule();
  }
  abandonUnstarted(): void {
    if (this.flags !== 1) throw identityFailure("protocol");
    this.subject = undefined; this.flags = 32 | 64;
    this.resolve(); this.resolve = undefined as never; this.reject = undefined as never;
    if (this.budget) this.budget.retireCommand(); else retireOwnedSinkChild(this.owner);
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || this.flags & 64) { value = undefined; return; }
    try { if (failed) this.rejected(value); else this.accepted(); }
    finally { value = undefined; }
  }
  observe(original: Promise<unknown>): void {
    this.observation = { owner: this, kind: 0, state: 0 };
    try { installOwnedOriginal(this.observation, original); }
    catch (reason) {
      this.failure(reason); this.unknown();
      throw failedSinkOrigin(this.owner, this.origin, reason);
    }
    finally { original = undefined as never; this.flags &= ~1; this.schedule(); }
  }
  private advance(): void {
    this.flags &= ~16;
    if (this.flags & 1 || !(this.flags & (2 | 8))) return;
    if (!(this.flags & 32)) {
      this.flags |= 32;
      if (this.flags & 4) {
        const failure = this.owner.sinkOrigins!.get(Math.floor(this.origin / 32));
        if (!failure || typeof failure === "number") { this.unknown(); return; }
        this.reject(failure);
      } else this.resolve();
      this.resolve = undefined as never; this.reject = undefined as never;
    }
    if (this.flags & (8 | 64)) return;
    if (!severOwnedOriginal(this.observation)) { this.unknown(); return; }
    this.observation = undefined; this.flags |= 64; this.subject = undefined;
    if (this.budget) this.budget.retireCommand(); else retireOwnedSinkChild(this.owner);
  }
}
function ignoreOwnedVoidOutcome(): void {}
function createOwnedSinkVoidCommand(owner: RequestOwner, origin: SinkOriginOwner): OwnedSinkVoidCommand {
  claimOwnedSinkFactories(); enrollOwnedSinkChild(owner);
  return new OwnedSinkVoidCommand(owner, origin);
}

interface RevalidationOwner {
  http: OwnedHttpRequest; auth: AuthorizedIdentity;
  selection: ProxySelection; upstream: UpstreamAuth; attempt: OwnedHttpUpload;
  url: URL; headers: Headers; preparation?: PreparationAdmission;
  backing: OwnedHttpRevalidationBacking; persistentBytes: number; phaseBytes: number; preparing: boolean;
  active: boolean; graph?: unknown;
  graphKind?: "snapshot" | "inspect"; retainedBytes: number; environmentUnits: number;
  snapshotRequestBytes: number; requestBytes: number; fingerprintBytes: number;
  codec?: true; codecSource?: true; codecScope?: ProxyCompletion; consumer?: true;
  consumerHeaderBytes?: number; consumerDataBytes?: number; normalizationBytes?: number;
  codecRoles?: number; sourceBase?: number; consumerBase?: number; replacementBase?: number;
}
let revalidations: WeakMap<OwnedHttpRevalidation, RevalidationOwner> | undefined;
// Same original-wire/text/decoded/parsed component as the private full reader.
// Retained policy/routing occurrences are ADDITIVE during the inspect RPC.
const revalidationSourceBytes = 16793600 + 2 * 2097152 + 32768;
const revalidationControlBytes = 65536;
const originalByobCancel = ReadableStreamBYOBReader.prototype.cancel;
const originalByobClosed = Object.getOwnPropertyDescriptor(ReadableStreamBYOBReader.prototype, "closed")?.get;
export function reserveOwnedHttpRevalidationOrigins(http: OwnedHttpRequest, providerId: string): void {
  if (providerId !== "venice" && providerId !== "gmi") return;
  const owner = requestOwner(http);
  if (owner.sealed) throw identityFailure("protocol");
  // Before this attempt's selection effects: snapshot + inspect at dispatch,
  // and Venice's one existing delivery check. Environment routes leave the
  // unused inspect credits held, never invent a new operation. The source has
  // ten distinct origins (including closed); each consumer has nine. This
  // extra origin uses positive SAME-common backing before selection effects.
  const count = providerId === "venice" ? 68 : 20;
  reserveSinkOrigins(ownedHttpSinkOwner(http), count);
  owner.revalidationCredits += count;
}

export function beginOwnedHttpRevalidation(http: OwnedHttpRequest, request: Request, env: Env,
  auth: AuthorizedIdentity, selection: ProxySelection, upstream: UpstreamAuth, attempt: OwnedHttpUpload,
  url: URL, headers: Headers, preparation: PreparationAdmission): OwnedHttpRevalidation {
  checkOwnedHttpRequest(http, request, env);
  if (!matchesOwnedHttpRevalidationInput(http, request, env, auth, selection, upstream, attempt, url, headers, preparation)
    || !["venice", "gmi"].includes(selection.provider.id) || selection.capability !== "llm.chat"
    || selection.endpoint.request_format !== "openai.chat_completions"
    || selection.endpoint.response_format !== "openai.chat_completions"
    || auth.authType !== "proxy_key" || !proxyKeyVerification(auth) || !env.ACCESS_CONTROL) throw identityFailure("protocol");
  // Frame/visitor/registry/cap backing precedes every private guard factory.
  const backing = claimOwnedHttpRevalidationBacking(http, upstream.grant, selection.provider.id as "venice" | "gmi");
  let persistentBytes = revalidationControlBytes, admitted = false;
  try {
    const secret = selection.provider.id === "venice" ? env.VENICE_API_KEY : env.GMI_API_KEY;
    const units = (upstream.grant?.credential?.length ?? 0) + (upstream.grant?.accessToken?.length ?? 0)
      + (upstream.grant?.credentialLineage?.length ?? 0) + (typeof upstream.grant?.accountId === "string" ? upstream.grant.accountId.length : 0)
      + (typeof secret === "string" ? secret.length : 0)
      + auth.policyId.length + (auth.credentialId?.length ?? 0) + (auth.principalId?.length ?? 0)
      + auth.policy.generation.length + (auth.policy.tenantId?.length ?? 7)
      + (upstream.grantKey?.length ?? 0) + selection.endpoint.id.length + (selection.model?.upstream.length ?? 0) + url.href.length;
    // Header normalization, identity/route JSON and both hash representations
    // coexist with borrowed records. No equality/interning credit is used.
    const original = identityPlan();
    if (upstream.grant) original.array(0, entry => {
      entry(upstream.grant!.provider); entry(upstream.grant!.kind); entry(upstream.grant!.credentialGeneration);
      entry(upstream.grant!.credentialLineage); entry(upstream.grant!.accountId ?? null);
    });
    const rpc = identityPlan();
    rpc.object(0, field => { field("credentialId", auth.credentialId); field("principalId", auth.principalId); field("policyId", auth.policyId); });
    const snapshotRequestBytes = 2 * rpc.counts.text + rpc.counts.bytes;
    const bindingUnits = auth.policyId.length + (auth.credentialId?.length ?? 0) + (auth.principalId?.length ?? 0)
      + 2 * auth.policy.generation.length + (auth.policy.tenantId?.length ?? 7) + (upstream.grantKey?.length ?? 0)
      + selection.endpoint.id.length + (upstream.grant?.credentialLineage?.length ?? 0);
    persistentBytes = revalidationControlBytes + 4 * original.counts.text + 4 * bindingUnits
      + 4 * (typeof secret === "string" ? secret.length : 0) + 1024;
    admitOwnedHttpRevalidationBacking(backing, persistentBytes, 12 * units + revalidationControlBytes); admitted = true;
    claimOwnedSinkFactories();
    const cap = Object.freeze({});
    const state: RevalidationOwner = { http, auth, selection, upstream, attempt, url, headers, preparation, active: false,
      backing, persistentBytes, phaseBytes: 12 * units + revalidationControlBytes, preparing: true,
      retainedBytes: 0, snapshotRequestBytes, requestBytes: 0, fingerprintBytes: 0, environmentUnits: typeof secret === "string" ? secret.length : 0 };
    (revalidations ??= new WeakMap()).set(cap, state);
    (requestOwner(http).revalidations ??= []).push(cap);
    return cap;
  } catch (error) {
    if (admitted) admitOwnedHttpRevalidationBacking(backing, persistentBytes, 0);
    retireOwnedHttpRevalidationBacking(backing); throw error;
  }
}
function revalidationOwner(cap: OwnedHttpRevalidation): RevalidationOwner {
  const owner = revalidations?.get(cap);
  if (!owner || requestOwner(owner.http).unknown) throw identityFailure("protocol");
  return owner;
}
export function checkOwnedHttpRevalidation(cap: OwnedHttpRevalidation, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, upstream: UpstreamAuth, url: URL, headers: Headers, request?: Request): void {
  const owner = revalidationOwner(cap);
  if (requestOwner(owner.http).env !== env || owner.auth !== auth || owner.selection !== selection || owner.upstream !== upstream
    || owner.url !== url || owner.headers !== headers || request !== undefined && requestOwner(owner.http).request !== request
    || !proxyKeyVerification(auth) || auth.authType !== "proxy_key") throw identityFailure("protocol");
}
export function matchesOwnedHttpRevalidationCaller(cap: OwnedHttpRevalidation,
  proof: unknown, credentialId: string | null, principalId: string | null, policyId: string, providerId: string, grantKey: string | null): boolean {
  const owner = revalidationOwner(cap), auth = owner.auth;
  return proof === proxyKeyVerification(auth) && credentialId === auth.credentialId && principalId === auth.principalId
    && policyId === auth.policyId && providerId === owner.selection.provider.id && grantKey === owner.upstream.grantKey;
}
export function beginOwnedHttpRevalidationRead(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  if (owner.active || owner.preparing || owner.phaseBytes) throw identityFailure("protocol");
  setRevalidationPhase(owner, revalidationSourceBytes + revalidationControlBytes);
  owner.active = true; owner.retainedBytes = 0;
}
export function finishOwnedHttpRevalidationPreparation(http: OwnedHttpRequest): void {
  const root = requestOwner(http);
  if (root.revalidations) for (const cap of root.revalidations) {
    const owner = revalidationOwner(cap);
    if (owner.preparing) {
      setRevalidationPhase(owner, 0);
      owner.preparing = false; owner.preparation = undefined;
    }
  }
}
export function applyOwnedHttpRevalidationCredential(cap: OwnedHttpRevalidation, headers: Headers, query: URLSearchParams): void {
  const owner = revalidationOwner(cap);
  if (!owner.preparing || !owner.preparation) throw identityFailure("protocol");
  applyProviderCredential(owner.selection.provider, owner.upstream.grant, requestOwner(owner.http).env!, headers, query, owner.preparation);
}
function setRevalidationPhase(owner: RevalidationOwner, bytes: number): void {
  admitOwnedHttpRevalidationBacking(owner.backing, owner.persistentBytes, bytes);
  owner.phaseBytes = bytes;
}
export function checkOwnedHttpVeniceCodec(cap: OwnedHttpRevalidation, selection: ProxySelection): void {
  const owner = revalidationOwner(cap);
  if (owner.selection !== selection || selection.provider.id !== "venice" || !owner.preparing
    || !matchesOwnedHttpRevalidationInput(owner.http, requestOwner(owner.http).request!, requestOwner(owner.http).env!, owner.auth, selection,
      owner.upstream, owner.attempt, owner.url, owner.headers, owner.preparation!)) throw identityFailure("protocol");
}
export function fundOwnedHttpVeniceCodec(cap: OwnedHttpRevalidation, codecBytes: number): void {
  const owner = revalidationOwner(cap);
  if (owner.selection.provider.id !== "venice") throw identityFailure("protocol");
  admitOwnedHttpCodecBacking(owner.backing, codecBytes, requestOwner(owner.http).unknown); owner.codec = true;
}
export function fundOwnedHttpAcceptedUsage(cap: OwnedHttpRevalidation, bytes: number): void {
  const owner = codecCustodyOwner(cap), root = requestOwner(owner.http);
  if (!owner.consumer || !Number.isSafeInteger(bytes) || bytes < 0) throw identityFailure("protocol");
  // UNKNOWN keeps the admitted high-water debit. Clearing a local alias can
  // finish without replacing its primary failure or refunding unresolved work.
  admitOwnedHttpUsageBacking(owner.backing, bytes, root.unknown);
}
export function prepareOwnedHttpCodecConsumers(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  if (!owner.preparing || owner.selection.provider.id !== "venice" || owner.consumer) throw identityFailure("protocol");
  // Prefix backings/indices/classification and fixed consumer execution metadata
  // stay additive to codec + generic usage under the SAME foreground ticket.
  admitOwnedHttpConsumerBacking(owner.backing, 1048576 + 65536); owner.consumer = true;
}
export function checkOwnedHttpCodecConsumer(http: OwnedHttpRequest, cap: OwnedHttpRevalidation,
  response: Response, operation: HttpOperation, streaming: boolean, requestId: string,
  usageContext?: Readonly<import("./token-usage.ts").UsageTokenContext>): void {
  const owner = revalidationOwner(cap);
  if (owner.http !== http || !owner.consumer || !owner.codecSource || !owner.codecScope || owner.preparing
    || requestOwner(http).sealed || !matchesOwnedVeniceConsumerInput(cap, response, streaming)
    || !matchesOwnedHttpCodecConsumerInput(http, cap, owner.attempt, operation, streaming, requestId, usageContext)) throw identityFailure("protocol");
}
export function checkOwnedHttpCodecNormalization(cap: OwnedHttpRevalidation, response: Response,
  streaming: boolean, operation: HttpOperation, requestId: string): void {
  const owner = revalidationOwner(cap);
  if (!owner.consumer || !matchesOwnedVeniceConsumerInput(cap, response, streaming)
    || !matchesOwnedHttpCodecNormalizationInput(owner.http, cap, owner.attempt, operation, requestId)) throw identityFailure("protocol");
}
export function checkOwnedHttpCodecUsage(cap: OwnedHttpRevalidation, operation: HttpOperation,
  validated: import("./native-response.ts").ValidatedNativeUsage | undefined,
  usageContext: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined): void {
  const owner = revalidationOwner(cap);
  if (!owner.consumer || !matchesOwnedHttpCodecUsageInput(owner.http, cap, owner.attempt, operation, validated, usageContext))
    throw identityFailure("protocol");
}
export function forwardOwnedHttpCodecUsage(cap: OwnedHttpRevalidation, response: Response, usage: import("./proxy-response.ts").ObservedUsage): void {
  const owner = codecCustodyOwner(cap);
  if (!owner.consumer) throw identityFailure("protocol");
  acceptOwnedCodecUsage(owner.http, cap, response, usage);
}
// The producer command constructs and binds the actual output; it cannot bless
// an arbitrary Response supplied by a caller after a mutable constructor ran.
export function createOwnedHttpCodecUsageResponse(cap: OwnedHttpRevalidation, reader: CodecReader,
  operation: HttpOperation, source: Response, body: ReadableStream<Uint8Array>, status: number, statusText: string, headers: Headers): Response {
  const owner = codecCustodyOwner(cap), root = requestOwner(owner.http);
  if (!owner.consumer || !matchesOwnedCodecUsagePublication(cap, reader, source, body, operation)
    || !matchesOwnedHttpPublicationContext(owner.http, owner.attempt, operation)) throw identityFailure("protocol");
  if (typeof status !== "number" || typeof statusText !== "string") throw identityFailure("protocol");
  captureOwnedHttpUsageStatus(owner.http, cap, source, status);
  const measured = measureOwnedHeaders(headers);
  const publication = prepareOwnedUsagePublication(owner.http, root, uploadOwner(owner.attempt), operation, source, body,
    3 * measured + 6 * statusText.length + 8192);
  if (!matchesOwnedCodecUsagePublication(cap, reader, source, body, operation)) throw identityFailure("protocol");
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  const output = newOwnedResponse(body, status, statusText, headers);
  publication.source = output; publication.phase = 1;
  return output;
}
export function fundOwnedHttpCodecConsumerHeaders(cap: OwnedHttpRevalidation, pairs: number, units: number): void {
  const owner = revalidationOwner(cap);
  if (!owner.consumer || !Number.isSafeInteger(pairs) || pairs < 0 || !Number.isSafeInteger(units) || units < 0)
    throw identityFailure("protocol");
  owner.consumerHeaderBytes = 96 * pairs + 6 * units;
  admitOwnedHttpConsumerBacking(owner.backing, 1048576 + 65536 + owner.consumerHeaderBytes + (owner.consumerDataBytes ?? 0));
}
export function fundOwnedHttpCodecConsumerCapture(cap: OwnedHttpRevalidation, bytes: number): void {
  const owner = codecCustodyOwner(cap);
  if (!owner.consumer || !Number.isSafeInteger(bytes) || bytes < 0) throw identityFailure("protocol");
  const next = Math.max(owner.consumerDataBytes ?? 0, bytes);
  admitOwnedHttpConsumerBacking(owner.backing, 1048576 + 65536 + (owner.consumerHeaderBytes ?? 0) + next);
  owner.consumerDataBytes = next;
}
interface NormalizationChild {
  root: RequestOwner; request: Request; attempt: UploadOwner; operation: HttpOperation; response: Response;
  body?: ReadableStream<Uint8Array>; driver?: OwnedNormalizerReader; output?: Uint8Array; replayResponse?: Response;
  base: number; dataBytes: number; captureBytes: number; closed: boolean;
}
let normalizations: WeakMap<OwnedHttpNormalization, NormalizationChild> | undefined;
let normalizationOutputs: WeakMap<Uint8Array, OwnedHttpNormalization> | undefined;
export function beginOwnedHttpNormalization(http: OwnedHttpRequest, attempt: OwnedHttpUpload,
  response: Response, operation: HttpOperation): OwnedHttpNormalization {
  const root = requestOwner(http), upload = uploadOwner(attempt);
  if (root.sealed || root.unknown || upload.request !== root || !root.request
    || !matchesOwnedHttpNormalizationInput(http, attempt, response, operation)) throw identityFailure("protocol");
  growOwnedHttpRequest(http, 8192); reserveSinkOrigins(root.sink!, 8); claimOwnedSinkFactories();
  if (root.sealed || root.unknown || root.sinkClosed || !root.request || upload.request !== root
    || !matchesOwnedHttpNormalizationInput(http, attempt, response, operation)
    || !Number.isSafeInteger(root.sinkPending + 1)) throw identityFailure("protocol");
  const base = root.nextSinkOrigin; root.nextSinkOrigin += 8; root.sinkCredits -= 8;
  const cap = Object.freeze({});
  const child: NormalizationChild = { root, request: root.request, attempt: upload, operation, response,
    base, dataBytes: 0, captureBytes: 0, closed: false };
  (normalizations ??= new WeakMap()).set(cap, child);
  enrollOwnedSinkChild(root);
  return cap;
}
function normalizationChild(cap: OwnedHttpNormalization): NormalizationChild {
  const child = normalizations?.get(cap);
  if (!child) throw identityFailure("protocol");
  return child;
}
export function checkOwnedHttpNormalizationReaderCreation(cap: OwnedHttpNormalization): void {
  const child = normalizationChild(cap);
  if (child.closed || child.driver || child.attempt.request !== child.root
    || child.request !== child.root.request) throw identityFailure("protocol");
}
export function ownOwnedHttpNormalizationReader(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader,
  body: ReadableStream<Uint8Array>): void {
  const child = normalizationChild(cap);
  if (child.closed || child.driver || !ownsOwnedNormalizerReader(cap, driver) || driver.body !== body)
    throw identityFailure("protocol");
  // The already-enrolled child holds this driver's existing VOID retired
  // receipt before getReader. No encompassing logical completion is its join.
  child.body = body; child.driver = driver;
}
export function fundOwnedHttpNormalization(cap: OwnedHttpNormalization, bytes: number): void {
  const child = normalizationChild(cap);
  if (child.closed || !(bytes >= 0) || bytes > 9007199254740991 || bytes % 1) throw identityFailure("protocol");
  if (bytes <= child.dataBytes) return;
  const replacement = child.root.funding.replace(child.root.funding.bytes + bytes - child.dataBytes);
  if (!replacement) throw identityFailure("limit");
  child.root.funding = replacement; child.dataBytes = bytes;
}
export function fundOwnedHttpNormalizationCapture(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader, bytes: number): void {
  const child = normalizationChild(cap);
  if (child.driver !== driver || child.body !== driver.body || driver.driverDone
    || !(bytes >= 0) || bytes > 9007199254740991 || bytes % 1) throw identityFailure("protocol");
  // Existing child only: sealing forbids new enrollment, not a pending FIRST
  // callback or replay under this exact operation. Other components stay added.
  if (bytes <= child.captureBytes) return;
  const replacement = child.root.funding.replace(child.root.funding.bytes + bytes - child.captureBytes);
  if (!replacement) throw identityFailure("limit");
  child.root.funding = replacement; child.captureBytes = bytes;
}
export function ownedHttpNormalizationFailure(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader,
  kind: "acquire" | "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object {
  const child = normalizationChild(cap);
  if (child.driver !== driver) throw identityFailure("protocol");
  const offset = kind === "acquire" ? 0 : kind === "read" ? 1 : kind === "cancel" ? 2 : kind === "unlock" ? 3
    : kind === "closed" ? 4 : kind === "pull" ? 5 : 6;
  const ordinal = child.base + offset, known = child.root.sinkOrigins!.has(ordinal);
  const failure = failedSinkOrigin(child.root, 32 * ordinal + sinkKinds.indexOf(kind), reason);
  if (!known) retainOwnedDiagnostic(child.root, failure);
  return failure;
}
export function holdOwnedHttpNormalization(cap: OwnedHttpNormalization): void { normalizationChild(cap).root.unknown = true; }
export function publishOwnedHttpNormalizationOutput(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader, bytes: Uint8Array): void {
  const child = normalizationChild(cap);
  if (child.driver !== driver || child.output || driver.driverDone) throw identityFailure("protocol");
  (normalizationOutputs ??= new WeakMap()).set(bytes, cap); child.output = bytes;
}
export function bindOwnedHttpNormalizationReplay(cap: OwnedHttpNormalization, reader: OwnedNormalizerReader, response: Response): void {
  const child = normalizationChild(cap);
  if (child.driver !== reader || child.closed || child.replayResponse) throw identityFailure("protocol");
  child.replayResponse = response;
}
function acceptFundedNormalizationOutput(usage: GenericUsageChild, bytes: Uint8Array): void {
  const cap = normalizationOutputs?.get(bytes), child = cap && normalizations?.get(cap);
  if (!child || child.root !== usage.root || child.attempt !== usage.attempt || child.operation !== usage.operation
    || child.replayResponse !== usage.response || child.output !== bytes || !child.driver) return;
  // Called only after the registered usage reader funds this actual backing and its
  // new snapshot. Inner enqueue alone never supplies this transfer proof.
  acknowledgeOwnedNormalizerOutput(cap!, child.driver, bytes);
}
export function clearOwnedHttpNormalizationOutput(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader, bytes: Uint8Array): void {
  const child = normalizationChild(cap);
  if (child.driver !== driver || child.output !== bytes) throw identityFailure("protocol");
  normalizationOutputs!.delete(bytes); child.output = undefined;
}
export function finishOwnedHttpNormalizationReader(cap: OwnedHttpNormalization, driver: OwnedNormalizerReader): void {
  const child = normalizationChild(cap);
  if (child.driver !== driver || !driver.driverDone) throw identityFailure("protocol");
  retireNormalizationChild(cap, child);
}
export function endOwnedHttpNormalization(cap: OwnedHttpNormalization): void {
  const child = normalizationChild(cap); child.closed = true; retireNormalizationChild(cap, child);
}
function retireNormalizationChild(cap: OwnedHttpNormalization, child: NormalizationChild): void {
  if (!child.closed || child.driver && !child.driver.driverDone) return;
  if (child.output) normalizationOutputs!.delete(child.output);
  child.output = undefined; child.body = undefined; child.driver = undefined; child.replayResponse = undefined;
  child.response = undefined as never; child.operation = undefined as never; child.attempt = undefined as never; child.request = undefined as never;
  normalizations!.delete(cap); retireOwnedSinkChild(child.root); child.root = undefined as never;
  // The component high-water remains in the root charge until final physical
  // request retirement, including any unproved downstream output alias.
}
export type OwnedHttpUsage = Readonly<{ readonly __ownedHttpUsage?: never }>;
interface GenericUsageChild {
  root: RequestOwner; http: OwnedHttpRequest; request: Request; attempt: UploadOwner;
  operation: HttpOperation; response: Response; format: string; tariff: import("./request-tariff.ts").RequestTariff | undefined;
  validated: import("./native-response.ts").ValidatedNativeUsage | undefined;
  context: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined;
  accounting: import("./proxy-accounting.ts").OwnedHttpAccountingCommand;
  reader?: GenericUsageReader; body?: ReadableStream<Uint8Array>; output?: Uint8Array; outputBody?: ReadableStream<Uint8Array>;
  base: number; captureBytes: number; inspectionBytes: number; delivered: boolean; consumed: boolean;
}
let genericUsageChildren: WeakMap<OwnedHttpUsage, GenericUsageChild> | undefined;
let genericUsageOutputs: WeakMap<Uint8Array, OwnedHttpUsage> | undefined;
export function beginOwnedHttpGenericUsage(http: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response,
  operation: HttpOperation, format: string, tariff: import("./request-tariff.ts").RequestTariff | undefined,
  validated: import("./native-response.ts").ValidatedNativeUsage | undefined,
  context: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined,
  accounting: import("./proxy-accounting.ts").OwnedHttpAccountingCommand): OwnedHttpUsage {
  const root = requestOwner(http), upload = uploadOwner(attempt);
  if (root.sealed || root.unknown || upload.request !== root || !root.request
    || !matchesOwnedHttpGenericUsageInput(http, attempt, response, operation, format, tariff, validated, context, accounting))
    throw identityFailure("protocol");
  growOwnedHttpRequest(http, 65536); reserveSinkOrigins(root.sink!, 16); claimOwnedSinkFactories();
  if (root.sealed || root.unknown || root.sinkClosed || !root.request || upload.request !== root
    || !matchesOwnedHttpGenericUsageInput(http, attempt, response, operation, format, tariff, validated, context, accounting)
    || !Number.isSafeInteger(root.sinkPending + 1))
    throw identityFailure("protocol");
  const base = root.nextSinkOrigin; root.nextSinkOrigin += 16; root.sinkCredits -= 16;
  const cap = Object.freeze({});
  const child: GenericUsageChild = { root, http, request: root.request!, attempt: upload, operation, response, format, tariff,
    validated, context, accounting, base, captureBytes: 0, inspectionBytes: 0, delivered: false, consumed: false };
  (genericUsageChildren ??= new WeakMap()).set(cap, child); enrollOwnedSinkChild(root); return cap;
}
function genericUsageChild(cap: OwnedHttpUsage): GenericUsageChild {
  const child = genericUsageChildren?.get(cap); if (!child) throw identityFailure("protocol"); return child;
}
export function checkOwnedHttpGenericUsage(cap: OwnedHttpUsage, response: Response, operation: HttpOperation,
  validated: import("./native-response.ts").ValidatedNativeUsage | undefined,
  context: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined): void {
  const child = genericUsageChild(cap);
  if (child.reader || child.response !== response || child.operation !== operation || child.validated !== validated || child.context !== context)
    throw identityFailure("protocol");
}
export function ownOwnedHttpGenericUsageReader(cap: OwnedHttpUsage, reader: GenericUsageReader): void {
  const child = genericUsageChild(cap);
  if (child.reader || !GenericUsageReader.owns(cap, reader)) throw identityFailure("protocol");
  child.reader = reader;
}
export function checkOwnedHttpGenericUsageInspection(cap: OwnedHttpUsage, reader: GenericUsageReader): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || reader.usage || reader.driverDone) throw identityFailure("protocol");
}
export function bindOwnedHttpGenericUsageBody(cap: OwnedHttpUsage, reader: GenericUsageReader, body: ReadableStream<Uint8Array>): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.body || reader.body !== body) throw identityFailure("protocol"); child.body = body;
}
export function fundOwnedHttpGenericUsage(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: number): void {
  fundGenericUsageComponent(cap, reader, bytes, "inspection");
}
export function fundOwnedHttpGenericUsageCapture(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: number): void {
  fundGenericUsageComponent(cap, reader, bytes, "capture");
}
function fundGenericUsageComponent(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: number, component: "capture" | "inspection"): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || reader.driverDone || !(bytes >= 0) || bytes > 9007199254740991 || bytes % 1)
    throw identityFailure("protocol");
  const prior = component === "capture" ? child.captureBytes : child.inspectionBytes;
  if (bytes <= prior) return;
  const replacement = child.root.funding.replace(child.root.funding.bytes + bytes - prior);
  if (!replacement) throw identityFailure("limit");
  child.root.funding = replacement;
  if (component === "capture") child.captureBytes = bytes; else child.inspectionBytes = bytes;
}
export function ownedHttpGenericUsageInstallationFailure(cap: OwnedHttpUsage, reader: GenericUsageReader,
  kind: "read" | "cancel" | "unlock" | "closed" | "pull", reason: unknown): object {
  return genericUsageFailure(cap, reader, kind, reason, true);
}
export function ownedHttpGenericUsageFailure(cap: OwnedHttpUsage, reader: GenericUsageReader,
  kind: "acquire" | "read" | "cancel" | "unlock" | "closed" | "pull" | "retire" | "listener-add" | "listener-remove", reason: unknown): object {
  return genericUsageFailure(cap, reader, kind, reason, false);
}
function genericUsageFailure(cap: OwnedHttpUsage, reader: GenericUsageReader,
  kind: "acquire" | "read" | "cancel" | "unlock" | "closed" | "pull" | "retire" | "listener-add" | "listener-remove", reason: unknown, installation: boolean): object {
  const child = genericUsageChild(cap);
  if (child.reader !== reader) throw identityFailure("protocol");
  const offset = kind === "acquire" ? 0 : kind === "read" ? 1 : kind === "cancel" ? 2 : kind === "unlock" ? 3
    : kind === "closed" ? 4 : kind === "pull" ? 5 : kind === "retire" ? 6 : kind === "listener-add" ? 7 : 8;
  const ordinal = child.base + offset + (installation ? 9 : 0), known = child.root.sinkOrigins!.has(ordinal);
  const failure = failedSinkOrigin(child.root, 32 * ordinal + sinkKinds.indexOf(kind), reason);
  if (!known) retainOwnedDiagnostic(child.root, failure); return failure;
}
export function holdOwnedHttpGenericUsage(cap: OwnedHttpUsage): void { genericUsageChild(cap).root.unknown = true; }
export function acceptOwnedHttpNormalizerIntoUsage(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: Uint8Array): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || !reader.driverCapturing) throw identityFailure("protocol");
  acceptFundedNormalizationOutput(child, bytes);
}
export function bindOwnedHttpGenericUsageOutput(cap: OwnedHttpUsage, reader: GenericUsageReader, body: ReadableStream<Uint8Array>): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.outputBody || reader.driverDone) throw identityFailure("protocol"); child.outputBody = body;
}
export function offerOwnedHttpGenericUsageOutput(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: Uint8Array): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.output || reader.driverDone) throw identityFailure("protocol");
  (genericUsageOutputs ??= new WeakMap()).set(bytes, cap); child.output = bytes;
}
function acceptFundedGenericUsageOutput(root: RequestOwner, body: ReadableStream<Uint8Array>, bytes: Uint8Array): void {
  const cap = genericUsageOutputs?.get(bytes), child = cap && genericUsageChildren?.get(cap);
  if (!child || child.root !== root || child.outputBody !== body || !matchesOwnedHttpPublicBody(child.http, body)
    || child.output !== bytes || !child.reader) return;
  child.reader.acknowledge(bytes);
}
export function clearOwnedHttpGenericUsageOutput(cap: OwnedHttpUsage, reader: GenericUsageReader, bytes: Uint8Array): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.output !== bytes) throw identityFailure("protocol");
  genericUsageOutputs!.delete(bytes); child.output = undefined;
}
export function createOwnedHttpGenericUsageResponse(cap: OwnedHttpUsage, reader: GenericUsageReader, source: Response,
  body: ReadableStream<Uint8Array>, status: number, statusText: string, headers: Headers): Response {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.response !== source || child.outputBody !== body || !reader.usage
    || reader.driverDone || !matchesOwnedHttpPublicationContext(child.http, child.attempt.cap, child.operation)) throw identityFailure("protocol");
  if (typeof status !== "number" || typeof statusText !== "string") throw identityFailure("protocol");
  captureOwnedHttpUsageStatus(child.http, cap, source, status);
  const measured = measureOwnedHeaders(headers);
  const publication = prepareOwnedUsagePublication(child.http, child.root, child.attempt, child.operation, source, body,
    3 * measured + 6 * statusText.length + 8192);
  if (child.reader !== reader || child.outputBody !== body || reader.driverDone) throw identityFailure("protocol");
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  const output = newOwnedResponse(body, status, statusText, headers);
  publication.source = output; publication.phase = 1;
  return output;
}
export function bindOwnedHttpGenericBodylessResponse(cap: OwnedHttpUsage, reader: GenericUsageReader, source: Response): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.response !== source || child.body || child.outputBody || reader.body
    || !reader.usage || reader.usage.finished || reader.driverDone
    || !matchesOwnedHttpPublicationContext(child.http, child.attempt.cap, child.operation)) throw identityFailure("protocol");
  const publication = prepareOwnedUsagePublication(child.http, child.root, child.attempt, child.operation, source, null, 8192);
  publication.phase = 1;
}
export function forwardOwnedHttpGenericUsage(cap: OwnedHttpUsage, reader: GenericUsageReader, result: ObservedUsage): void {
  const child = genericUsageChild(cap);
  if (child.reader !== reader || child.delivered || !reader.usage?.matchesDelivery(result)) throw identityFailure("protocol");
  acceptOwnedGenericUsage(child.http, cap, result); child.delivered = true;
}
export function ownedHttpGenericUsageRetirement(cap: OwnedHttpUsage): Promise<void> {
  const reader = genericUsageChild(cap).reader; if (!reader) throw identityFailure("protocol"); return reader.retired;
}
export function abandonOwnedHttpGenericUsage(cap: OwnedHttpUsage): void {
  const child = genericUsageChild(cap);
  if (child.reader?.usage) child.reader.usage.abandon(); else child.reader?.stop(true);
  // Abandonment owns physical cleanup, not the accounting destination.
  retireGenericUsageChild(cap, child);
}
export function ownedHttpGenericUsageCompletion(cap: OwnedHttpUsage): Promise<void> {
  const reader = genericUsageChild(cap).reader; if (!reader?.usage) throw identityFailure("protocol"); return reader.usage.ready;
}
export function consumeOwnedHttpGenericUsage(cap: OwnedHttpUsage): void {
  const child = genericUsageChild(cap);
  if (child.consumed || !ownsConsumedHttpAccountingHandoff(child.http, cap)) throw identityFailure("protocol");
  child.consumed = true; retireGenericUsageChild(cap, child);
}
export function failOwnedHttpGenericUsage(cap: OwnedHttpUsage): void {
  const child = genericUsageChild(cap);
  if (child.consumed || !ownsFailedHttpAccountingHandoff(child.http, cap)) throw identityFailure("protocol");
  // This is failed disposition, never a successful accounting acknowledgment.
  retireGenericUsageChild(cap, child);
}
export function finishOwnedHttpGenericUsageReader(cap: OwnedHttpUsage, reader: GenericUsageReader): void {
  const child = genericUsageChild(cap); if (child.reader !== reader || !reader.driverDone) throw identityFailure("protocol");
  retireGenericUsageChild(cap, child);
}
function retireGenericUsageChild(cap: OwnedHttpUsage, child: GenericUsageChild): void {
  if (!child.consumed && !ownsFailedHttpAccountingHandoff(child.http, cap) || child.reader && !child.reader.driverDone) return;
  child.reader?.clearUsage();
  if (child.output) genericUsageOutputs!.delete(child.output);
  child.output = undefined; child.outputBody = undefined; child.body = undefined; child.reader = undefined; child.response = undefined as never;
  child.operation = undefined as never; child.request = undefined as never; child.attempt = undefined as never;
  child.validated = undefined; child.context = undefined; child.tariff = undefined; child.accounting = undefined as never;
  genericUsageChildren!.delete(cap); retireOwnedSinkChild(child.root); child.root = undefined as never; child.http = undefined as never;
}
export function fundOwnedHttpCodecNormalization(cap: OwnedHttpRevalidation, bytes: number): void {
  const owner = codecCustodyOwner(cap), root = requestOwner(owner.http);
  if (!owner.consumer || root.sealed || !(bytes >= 0) || bytes > 9007199254740991 || bytes % 1) throw identityFailure("protocol");
  const prior = owner.normalizationBytes ?? 0;
  if (bytes <= prior) return;
  const replacement = root.funding.replace(root.funding.bytes + bytes - prior);
  if (!replacement) throw identityFailure("limit");
  root.funding = replacement; owner.normalizationBytes = bytes;
}
export function settleOwnedHttpCodecConsumerCapture(cap: OwnedHttpRevalidation): void {
  const owner = codecCustodyOwner(cap);
  if (!owner.consumer) throw identityFailure("protocol");
  if (requestOwner(owner.http).unknown) return;
  const bytes = ownedUsageCaptureBytes(cap);
  if (bytes === null) return;
  admitOwnedHttpConsumerBacking(owner.backing, 1048576 + 65536 + (owner.consumerHeaderBytes ?? 0) + bytes);
  owner.consumerDataBytes = bytes;
}
export function beginOwnedCodecConsumerDiagnostics(cap: OwnedHttpRevalidation): 1 | 2 {
  const owner = revalidationOwner(cap);
  if (!owner.consumer) throw identityFailure("protocol");
  const role = (owner.codecRoles ?? 0) & 2 ? 2 : 1;
  claimCodecRole(owner, role);
  return role;
}
function claimCodecRole(owner: RevalidationOwner, role: OwnedCodecRole): void {
  const root = requestOwner(owner.http), bit = 1 << role, width = role === 0 ? 10 : 9;
  if ((owner.codecRoles ?? 0) & bit || root.revalidationCredits < width || root.sinkCredits < width) throw identityFailure("protocol");
  root.revalidationCredits -= width; root.sinkCredits -= width;
  // Claim at ACTUAL acquisition, preserving order against fresh revalidation.
  const base = root.nextSinkOrigin; root.nextSinkOrigin += width;
  if (role === 0) owner.sourceBase = base;
  else if (role === 1) owner.consumerBase = base;
  else owner.replacementBase = base;
  owner.codecRoles = (owner.codecRoles ?? 0) | bit;
}
function codecCustodyOwner(cap: OwnedHttpRevalidation): RevalidationOwner {
  const owner = revalidations?.get(cap);
  if (!owner || !owner.codecSource) throw identityFailure("protocol");
  // Accepted originals must still report and join after UNKNOWN is set.
  // This lookup grants neither a new acquisition nor retirement credit.
  return owner;
}
export function ownedHttpCodecFailure(cap: OwnedHttpRevalidation, role: OwnedCodecRole, phase: IntakePhase, reason: unknown): object {
  const owner = codecCustodyOwner(cap), roles = owner.codecRoles ?? 0;
  if (role !== 0 && role !== 1 && role !== 2 || !(roles & 1 << role) || roles & 1 << (role + 3) || (role !== 0 && phase === "abort"))
    throw identityFailure("protocol");
  const root = requestOwner(owner.http);
  const base = role === 0 ? owner.sourceBase! : role === 1 ? owner.consumerBase! : owner.replacementBase!;
  const offset = phase === "acquire" ? 0 : phase === "read" ? 1 : phase === "cancel" ? 2 : phase === "unlock" ? 3
    : phase === "listenerAdd" ? 4 : phase === "listenerRemove" ? 5 : phase === "abort" ? 6 : phase === "closed" ? role === 0 ? 9 : 6 : phase === "pull" ? 7 : phase === "retire" ? 8 : -1;
  if (offset < 0 || phase === "readObserver" || phase === "closedObserver" || phase === "cancelObserver" || phase === "unlockObserver")
    throw identityFailure("protocol");
  const ordinal = base + offset, known = root.sinkOrigins!.has(ordinal);
  const kind: SinkOrigin = phase === "listenerAdd" ? "listener-add" : phase === "listenerRemove" ? "listener-remove" : phase;
  const record = failedSinkOrigin(root, 32 * ordinal + sinkKinds.indexOf(kind), reason);
  if (!known) retainOwnedDiagnostic(root, record);
  return record;
}
export function finishOwnedCodecDiagnostics(cap: OwnedHttpRevalidation, role: OwnedCodecRole): void {
  const owner = codecCustodyOwner(cap), roles = owner.codecRoles ?? 0;
  if (role !== 0 && role !== 1 && role !== 2 || !(roles & 1 << role) || roles & 1 << (role + 3)) throw identityFailure("protocol");
  // No ledger deletion or refund: other roles and UNKNOWN retain this owner.
  owner.codecRoles = roles | 1 << (role + 3);
}
export function ownOwnedCodecConsumerRetirement(http: OwnedHttpRequest, cap: OwnedCodecConsumer, work: Promise<void>): void {
  if (revalidationOwner(cap).http !== http || !matchesOwnedCodecConsumerRetirement(cap, work)) throw identityFailure("protocol");
  requestOwner(http).completion.startPrivateLeaf(() => work);
}
function veniceResponseOwner(cap: OwnedHttpRevalidation, response: Response, signal: AbortSignal): RevalidationOwner {
  const owner = revalidationOwner(cap);
  if (!owner.codec || owner.preparing || !matchesOwnedHttpVeniceResponseInput(owner.http, owner.attempt, response, signal)) throw identityFailure("protocol");
  return owner;
}
export function checkOwnedHttpVeniceResponse(cap: OwnedHttpRevalidation, response: Response, signal: AbortSignal): void {
  if (!veniceResponseOwner(cap, response, signal).codecScope) throw identityFailure("protocol");
}
export function beginOwnedHttpVeniceSource(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  if (!owner.codec || owner.codecSource) throw identityFailure("protocol");
  claimCodecRole(owner, 0); owner.codecSource = true;
}
export function ownOwnedHttpVeniceRetirement(cap: OwnedHttpRevalidation, work: Promise<void>): void {
  const owner = revalidationOwner(cap);
  if (!owner.codecScope || !matchesOwnedVeniceRetirement(cap, work)) throw identityFailure("protocol");
  owner.codecScope.startPrivateLeaf(() => work);
}
export function startOwnedHttpVeniceCodec(cap: OwnedHttpRevalidation, response: Response, signal: AbortSignal): Promise<Response> {
  const owner = veniceResponseOwner(cap, response, signal);
  if (owner.codecScope) throw identityFailure("protocol");
  return requestOwner(owner.http).completion.start(children => {
    owner.codecScope = children;
    return consumeOwnedVeniceChatResponse(cap, response, signal);
  });
}
export function holdOwnedHttpVeniceSource(cap: OwnedHttpRevalidation): void {
  const owner = revalidations?.get(cap);
  if (!owner) throw identityFailure("protocol");
  requestOwner(owner.http).unknown = true;
}
export function retireOwnedHttpVeniceBacking(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  if (!owner.codec) throw identityFailure("protocol");
  retireOwnedHttpCodecBacking(owner.backing); owner.codec = undefined; owner.codecSource = undefined; owner.codecScope = undefined;
}
export function fundOwnedHttpRevalidationEnvironment(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  const value = owner.selection.provider.id === "venice" ? requestOwner(owner.http).env!.VENICE_API_KEY : requestOwner(owner.http).env!.GMI_API_KEY;
  const units = typeof value === "string" ? value.length : 0;
  if (units > owner.environmentUnits) {
    fundRevalidationCopies(owner, 12 * (units - owner.environmentUnits));
    owner.environmentUnits = units;
  }
}
function fundRevalidationCopies(owner: RevalidationOwner, bytes: number): void {
  // This already-enrolled request child can execute during delivery after
  // request sealing. It cannot enroll a new request or fund another owner.
  if (requestOwner(owner.http).unknown || !Number.isSafeInteger(bytes) || bytes <= 0) throw identityFailure("protocol");
  const total = owner.persistentBytes + bytes;
  admitOwnedHttpRevalidationBacking(owner.backing, total, owner.phaseBytes);
  owner.persistentBytes = total;
}
export function matchesOwnedHttpRevalidationGraph(cap: OwnedHttpRevalidation, value: unknown,
  kind: "snapshot" | "policy" | "inspect" | "grant"): boolean {
  const owner = revalidationOwner(cap);
  if (!owner.active || !owner.graph || typeof owner.graph !== "object") return false;
  const graph = owner.graph as { policy?: { policy?: unknown }; grant?: unknown };
  return kind === "snapshot" ? owner.graphKind === "snapshot" && value === graph
    : kind === "policy" ? owner.graphKind === "snapshot" && value === graph.policy?.policy
    : kind === "inspect" ? owner.graphKind === "inspect" && value === graph
    : owner.graphKind === "inspect" && value === graph.grant;
}
// The only fingerprint operands are this attempt's original grant or the
// exact grant adopted by its current inspect command. The same synchronous
// workspace is reused only after the preceding copy/stringify call returned;
// its COMMON high-water stays held for the whole revalidation owner lifetime.
export function ownedHttpRevalidationFingerprint(cap: OwnedHttpRevalidation, grant: import("./types.ts").UpstreamGrant): string {
  const owner = revalidationOwner(cap);
  if (grant !== owner.upstream.grant && !matchesOwnedHttpRevalidationGraph(cap, grant, "grant")) throw identityFailure("protocol");
  const provider = grant.provider, kind = grant.kind, generation = grant.credentialGeneration,
    lineage = grant.credentialLineage, account = grant.accountId ?? null;
  const plan = identityPlan();
  plan.array(0, entry => { entry(provider); entry(kind); entry(generation); entry(lineage); entry(account); });
  const n = plan.counts;
  // Five tuple cells and their borrowed primitive occurrences overlap the
  // independently copied identity graph, result text and active call products.
  const bytes = 4096 + 8 * (n.values + 2 * n.members + n.entries) + 2 * n.units + 4 * n.text + n.bytes;
  if (bytes > owner.fingerprintBytes) {
    const persistent = owner.persistentBytes + bytes - owner.fingerprintBytes;
    admitOwnedHttpRevalidationBacking(owner.backing, persistent, owner.phaseBytes);
    owner.persistentBytes = persistent; owner.fingerprintBytes = bytes;
  }
  return privateGrantIdentityJson([provider, kind, generation, lineage, account]);
}
export function retainOwnedHttpRevalidationPolicy(cap: OwnedHttpRevalidation, policy: unknown): void {
  if (!matchesOwnedHttpRevalidationGraph(cap, policy, "policy")) throw identityFailure("protocol");
  const owner = revalidationOwner(cap), plan = identityPlan("record");
  plan.item(policy, 0);
  const n = plan.counts;
  // Upper bound for D: every value is conservatively a primitive occurrence,
  // in addition to each distinct parsed container and each key/value cell.
  owner.retainedBytes = 8 * (n.containers + 2 * n.members + n.entries + n.values) + 2 * n.units;
}
export function admitOwnedHttpRevalidationRouting(cap: OwnedHttpRevalidation,
  counts: { values: number; containers: number; members: number; entries: number; units: number }): void {
  const owner = revalidationOwner(cap);
  if (!owner.active || owner.graphKind !== "snapshot") throw identityFailure("protocol");
  const bytes = 8 * (counts.containers + 2 * counts.members + counts.entries + counts.values) + 2 * counts.units;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw identityFailure("limit");
  // The private bounded normalizer's passive prefix workspace is no larger
  // than a second output occurrence vector; it ends before inspect starts.
  setRevalidationPhase(owner, owner.requestBytes + Math.max(revalidationSourceBytes + revalidationControlBytes,
    owner.retainedBytes + 2 * bytes + revalidationControlBytes));
  owner.retainedBytes += bytes;
}
export function endOwnedHttpRevalidationRead(cap: OwnedHttpRevalidation): void {
  const owner = revalidationOwner(cap);
  if (!owner.active || owner.graph !== undefined || owner.requestBytes) throw identityFailure("protocol");
  // Fixed receivers clear policy/routing before this command; the consumed
  // source's read/FIRSTcancel/unlock have already settled.
  owner.retainedBytes = 0; owner.active = false; setRevalidationPhase(owner, 0);
}

// Named operations only: callers cannot supply a namespace/path/body/graph or
// callback. A successful consumed snapshot is delivered to one fixed receiver.
export function consumeOwnedHttpAuthorizationSnapshot(cap: OwnedHttpRevalidation, env: Env, signal: AbortSignal): Promise<void> {
  return startOwnedRevalidationRpc(cap, env, signal, "snapshot");
}
export function consumeOwnedHttpGrantInspection(cap: OwnedHttpRevalidation, env: Env, signal: AbortSignal): Promise<void> {
  return startOwnedRevalidationRpc(cap, env, signal, "inspect");
}
function startOwnedRevalidationRpc(cap: OwnedHttpRevalidation, env: Env, signal: AbortSignal, kind: "snapshot" | "inspect"): Promise<void> {
  const owner = revalidationOwner(cap);
  if (env !== requestOwner(owner.http).env || !owner.active || !owner.phaseBytes || owner.graph !== undefined
    || kind === "inspect" && !owner.upstream.grantKey) throw identityFailure("protocol");
  const sink = ownedHttpSinkOwner(owner.http), root = sinkOwner(sink);
  if (root.revalidationCredits < 10) throw identityFailure("protocol");
  setRevalidationPhase(owner, revalidationSourceBytes + owner.retainedBytes + revalidationControlBytes
    + (kind === "snapshot" ? owner.snapshotRequestBytes : 6));
  owner.requestBytes = kind === "snapshot" ? owner.snapshotRequestBytes : 6;
  // Stub, fetch, reader acquisition/fallback, read, FIRSTcancel, unlock, and
  // abort listener installation/removal. No fresh charge is needed in cleanup.
  root.revalidationCredits -= 10;
  try {
    claimOwnedSinkFactories();
    enrollOwnedSinkChild(root);
    const rpc = new OwnedRevalidationRpc(cap, owner, root, signal, kind);
    return rpc.consume();
  }
  catch (error) { owner.requestBytes = 0; root.revalidationCredits += 10; throw error; }
}
interface OwnedRpcFetchObservation { owner: OwnedRevalidationRpc | undefined; flags: number }
function ownedRpcFetchAccepted(this: OwnedRpcFetchObservation, value: Response): void {
  if (this.flags & (1 | 8)) { value = undefined as never; return; }
  try { this.owner?.acceptFetch(this, false, value); } finally { value = undefined as never; }
}
function ownedRpcFetchRejected(this: OwnedRpcFetchObservation, reason: unknown): void {
  if (this.flags & (1 | 8)) { reason = undefined; return; }
  try { this.owner?.acceptFetch(this, true, reason); } finally { reason = undefined; }
}
class OwnedRevalidationRpc extends OwnedReaderDriver {
  private response?: Response;
  private fetchCell?: OwnedRpcFetchObservation;
  private fetchFlags = 0; // installing, accepted, installed, queued, delivered, stopping, UNKNOWN, opened
  private fetchFailure?: object;
  private readyResolve!: () => void;
  private readyReject!: (failure: object) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private advanceFetchWork = this.advanceFetch.bind(this);
  private readonly abort = this.abortRead.bind(this);
  private listener = false;
  private byob = false;
  private cleanupFailed = false;
  private requestBody?: string;
  private wire?: IdentityWire;
  private decoder?: TextDecoder;
  private backing?: Uint8Array<ArrayBuffer>;
  private text = "";
  private wireBytes = 0;
  private readonly budget = identitySourceBudget();
  private readonly base: number;
  declare private cap: OwnedHttpRevalidation;
  declare private owner: RevalidationOwner;
  declare private root: RequestOwner;
  declare private signal: AbortSignal;
  declare private kind: "snapshot" | "inspect";
  constructor(cap: OwnedHttpRevalidation, owner: RevalidationOwner, root: RequestOwner,
    signal: AbortSignal, kind: "snapshot" | "inspect") {
    super();
    this.cap = cap; this.owner = owner; this.root = root; this.signal = signal; this.kind = kind;
    this.base = root.nextSinkOrigin; root.nextSinkOrigin += 10; root.sinkCredits -= 10;
    this.fetchCell = { owner: this, flags: 0 };
  }
  private failure(offset: number, kind: SinkOrigin, reason: unknown, primary = true): object {
    return failedSinkOrigin(this.root, 32 * (this.base + offset) + sinkKinds.indexOf(kind), reason, primary);
  }
  protected holdDriver(): void { this.root.unknown = true; this.fetchFlags |= 64; }
  protected driverProtocolFailure(): Error { return identityFailure("protocol"); }
  protected propagatedDriverFailure(_reason: unknown): boolean { return false; }
  protected recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object {
    return this.failure(kind === "read" ? 4 : kind === "cancel" ? 5 : kind === "unlock" ? 6 : kind === "closed" ? 9 : 2, kind, reason);
  }
  protected captureDriverFailure(reason: unknown): object { return isIdentityFailure(reason) ? reason : this.recordDriverFailure("read", reason); }
  protected driverCleanupFailure(kind: "closed" | "cancel" | "unlock", _failure: object): void { if (kind !== "closed") this.cleanupFailed = true; }
  protected driverCleared(): void {}
  private scheduleFetch(): void {
    if (this.fetchFlags & 8) return;
    this.fetchFlags |= 8;
    try { ownedBoundaryQueue(this.advanceFetchWork); } catch { this.uncertain(); }
  }
  acceptFetch(cell: OwnedRpcFetchObservation, rejected: boolean, value: unknown): void {
    if (cell !== this.fetchCell || cell.flags & (1 | 8) || !(this.fetchFlags & (1 | 4 | 64))) { value = undefined; return; }
    cell.flags |= 1; this.fetchFlags |= 2;
    try {
      if (rejected) this.fetchFailure = this.failure(1, "fetch", value);
      else if (value instanceof Response) this.response = value;
      else { this.fetchFailure = this.failure(1, "fetch", undefined); this.uncertain(); }
    } catch { this.uncertain(); }
    finally { value = undefined; this.scheduleFetch(); }
  }
  private advanceFetch(): void {
    this.fetchFlags &= ~8;
    if (this.fetchFlags & 1 || !(this.fetchFlags & 2)) return;
    if (!(this.fetchFlags & 16)) {
      if (this.fetchFlags & 64 || this.fetchFailure) this.deliverFetch(this.fetchFailure ?? identityFailure("transport"));
      else if (this.fetchFlags & 4) this.deliverFetch();
    }
    if (!(this.fetchFlags & 64) && this.fetchCell && this.fetchCell.flags & 1 && this.fetchFlags & 4) {
      this.fetchCell.flags = 8; this.fetchCell.owner = undefined; this.fetchCell = undefined;
    }
    if (this.fetchFlags & 32) {
      try { if (this.response && !(this.fetchFlags & 128)) this.open(); }
      catch { this.cleanupFailed = true; }
      void this.stopDriver(true);
    }
  }
  private deliverFetch(failure?: object): void {
    if (this.fetchFlags & 16) return;
    this.fetchFlags |= 16;
    const resolve = this.readyResolve, reject = this.readyReject;
    this.readyResolve = undefined as never; this.readyReject = undefined as never;
    if (failure) reject(failure); else resolve();
  }
  private invoke(): void {
    if (this.signal.aborted) { this.fetchFlags |= 2 | 4; this.fetchCell!.flags |= 1; this.fetchFailure = identityFailure("transport"); this.scheduleFetch(); return; }
    let binding: Env["ACCESS_CONTROL"] | Env["GRANT_CREDENTIALS"];
    try { binding = this.kind === "snapshot" ? requestOwner(this.owner.http).env!.ACCESS_CONTROL : requestOwner(this.owner.http).env!.GRANT_CREDENTIALS; }
    catch (reason) {
      this.fetchFailure = this.failure(0, "acquire", reason); reason = undefined;
      this.fetchFlags |= 2 | 4; this.fetchCell!.flags |= 1; this.scheduleFetch(); return;
    }
    if (!binding) { this.fetchFlags |= 2 | 4; this.fetchCell!.flags |= 1; this.fetchFailure = new HttpError(503, "provider_not_configured", "provider is not configured"); this.scheduleFetch(); return; }
    const key = this.kind === "snapshot" ? "policy-bindings" : this.owner.upstream.grantKey!;
    let stub: DurableObjectStub | undefined, original: Promise<Response> | undefined, started = false;
    try {
      try { stub = binding.get(binding.idFromName(key)); }
      catch (reason) { this.fetchFailure = this.failure(0, "acquire", reason); this.fetchFlags |= 2 | 4; this.fetchCell!.flags |= 1; return; }
      this.requestBody = this.kind === "snapshot" ? privateSnapshotJson({ credentialId: this.owner.auth.credentialId,
        principalId: this.owner.auth.principalId, policyId: this.owner.auth.policyId }) : "{}";
      this.fetchFlags |= 1;
      original = stub.fetch(this.kind === "snapshot" ? "https://clawrouter.internal/authorization/snapshot" : "https://clawrouter.internal/inspect",
        { method: "POST", body: this.requestBody, signal: this.signal });
      started = !!original;
      const then = original.then;
      void Reflect.apply(then, original, [ownedRpcFetchAccepted.bind(this.fetchCell!), ownedRpcFetchRejected.bind(this.fetchCell!)]);
      this.fetchFlags |= 4;
    } catch (reason) {
      try {
        this.fetchFailure = this.failure(1, "fetch", reason);
        if (started) { this.uncertain(); this.deliverFetch(this.fetchFailure); }
        else { this.fetchFlags |= 2 | 4; if (this.fetchCell) this.fetchCell.flags |= 1; }
      } catch { this.uncertain(); }
      finally { reason = undefined; }
    } finally { original = undefined; stub = undefined; this.fetchFlags &= ~1; this.scheduleFetch(); }
  }
  private open(): void {
    if (this.fetchFlags & 128) return;
    this.fetchFlags |= 128;
    try { this.body = this.response!.body ?? undefined; }
    catch (reason) { this.uncertain(); throw this.failure(2, "acquire", reason); }
    if (!this.body) throw identityFailure("protocol");
    try { this.reader = this.body.getReader({ mode: "byob" }); this.byob = true; }
    catch (reason) {
      this.failure(2, "acquire", reason);
      try { this.reader = this.body.getReader(); }
      catch (error) { this.uncertain(); throw this.failure(3, "acquire", error); }
    }
    const reader = this.reader;
    this.observeDriverClosed(Object.getPrototypeOf(reader) === (this.byob ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
      && !Object.hasOwn(reader, "closed") && typeof originalLookupGetter === "function"
      && originalLookupGetter.call(reader, "closed") === (this.byob ? originalByobClosed : originalReaderClosed));
  }
  private abortRead(): void { this.fetchFlags |= 32; if (this.fetchFlags & 128) void this.stopDriver(true); }
  private view(value: unknown): ReturnType<typeof inspectOwnedBytes> {
    const proof = inspectOwnedBytes(value);
    if (!isLocalOwnedByteBacking(proof.buffer) || proof.backing > 16384) throw identityFailure("limit");
    return proof;
  }
  protected captureDriverValue(part: ReadableStreamReadResult<Uint8Array>): void {
    // Every old result getter is kept at its own role. No read-result object or
    // graph leaves this synchronous first-observer fold.
    let operand: Uint8Array | undefined, proof: ReturnType<typeof inspectOwnedBytes> | undefined;
    const discard = this.signal.aborted || !!(this.fetchFlags & 32);
    try {
      if (part.value) {
        operand = part.value; proof = this.view(operand);
        if (!(operand!.buffer instanceof ArrayBuffer)) throw identityFailure("limit");
        operand = undefined; proof = undefined;
        operand = part.value; proof = this.view(operand);
        if (operand!.buffer.byteLength > 16384) throw identityFailure("limit");
        operand = undefined; proof = undefined;
        operand = part.value; proof = this.view(operand);
        void operand!.byteLength;
        if (!discard) admitIdentityBytes(this.budget, proof.length, 2097152);
        operand = undefined; proof = undefined;
        operand = part.value; proof = this.view(operand);
        if (proof.length > 2097152 - this.wireBytes) throw identityFailure("limit");
        if (!discard) { this.wire!.addPrivate(operand!); this.wireBytes += proof.length; }
        else { const snapshot = newOwnedBytes(proof.length); copyOwnedBytes(snapshot, operand!); }
        operand = undefined; proof = undefined;
        operand = part.value; proof = this.view(operand);
        const snapshot = newOwnedBytes(proof.length); copyOwnedBytes(snapshot, operand!); operand = undefined; proof = undefined;
        const stream = !part.done;
        if (!discard) {
          const chunk = decodeOwnedBytes(this.decoder!, snapshot, stream);
          if (chunk.length > 2097152 - this.text.length) throw identityFailure("limit");
          this.text += chunk;
        }
        operand = part.value; proof = this.view(operand);
        // Preserve the seventh public buffer getter, but never use its value as
        // native backing proof or as the next read's storage.
        void operand!.buffer;
        this.backing = ownedBytesFromBacking(proof.buffer); operand = undefined; proof = undefined;
      }
      this.readDone = !!part.done;
      if (this.readDone && !part.value && !discard) {
        const chunk = decodeOwnedBytes(this.decoder!);
        if (chunk.length > 2097152 - this.text.length) throw identityFailure("limit");
        this.text += chunk;
      }
      if (!this.readDone && this.backing && !ownedByteLength(this.backing)) throw identityFailure("transport");
    } finally { part = undefined as never; operand = undefined; proof = undefined; }
  }
  async consume(): Promise<void> {
    let graph: unknown, hasPrimary = false, primary: unknown, eof = false;
    try {
      this.invoke(); await this.ready;
      this.open();
      this.listener = true;
      try { this.signal.addEventListener("abort", this.abort, { once: true }); }
      catch (reason) { throw this.failure(7, "listener-add", reason); }
      if (!this.byob || this.signal.aborted) throw identityFailure("transport");
      admitIdentityHeaders(this.response!.headers);
      this.wire = new IdentityWire(); this.decoder = newOwnedDecoder(); this.backing = newOwnedBytes(16384);
      for (let reads = 0; ; reads++) {
        if (reads >= 8192) throw identityFailure("limit");
        if (this.signal.aborted) throw identityFailure("transport");
        await this.startDriverRead(this.backing);
        if (this.signal.aborted) throw identityFailure("transport");
        if (this.readDone) { eof = true; break; }
      }
      try { graph = parseIdentity(this.text, this.budget, "complete", this.kind === "snapshot" ? "authorization-snapshot" : "grant", this.wire.span); }
      catch (error) { throw isIdentityFailure(error) ? error : identityFailure("protocol"); }
      finally { this.text = ""; this.wire.clear(); this.wire = undefined; this.decoder = undefined; this.backing = undefined; }
      await this.stopDriver(false);
      if (this.cleanupFailed) throw identityFailure("cleanup");
      if (this.signal.aborted) throw identityFailure("transport");
      if (!this.response!.ok) {
        if (this.kind === "snapshot") throw identityFailure("transport");
        const payload = graph as { error?: { code?: string; message?: string } };
        const retryAfter = this.response!.headers.get("retry-after");
        const code = typeof payload?.error?.code === "string" ? payload.error.code : "credential_owner_error";
        const message = typeof payload?.error?.message === "string" ? payload.error.message : "grant credential operation failed";
        fundRevalidationCopies(this.owner, 4096 + 8 * (code.length + message.length + (retryAfter?.length ?? 0)) + 2 * this.owner.upstream.grantKey!.length);
        throw selectedCredentialFailure(new HttpError(this.response!.status, code, message,
          retryAfter === null ? undefined : { "Retry-After": retryAfter }), this.owner.upstream.grantKey!);
      }
      this.owner.graph = graph; this.owner.graphKind = this.kind;
      if (this.kind === "snapshot") acceptOwnedAuthorizationSnapshot(this.cap, graph);
      else if (this.owner.selection.provider.id === "venice") acceptOwnedVeniceInspection(this.cap, graph);
      else acceptOwnedGmiInspection(this.cap, graph);
    } catch (error) { hasPrimary = true; primary = error; }
    finally {
      this.fetchFlags |= 32;
      if (this.fetchFlags & 2) {
        if (this.response && !(this.fetchFlags & 128)) { try { this.open(); } catch { this.cleanupFailed = true; } }
        void this.stopDriver(!eof);
      }
      await this.retired;
      if (this.listener) {
        try { this.signal.removeEventListener("abort", this.abort); }
        catch (reason) { this.uncertain(); this.cleanupFailed = true; this.failure(8, "listener-remove", reason, false); }
      }
      this.wire?.clear(); this.wire = undefined; this.decoder = undefined; this.backing = undefined; this.text = "";
      graph = undefined; this.owner.graph = undefined; this.owner.graphKind = undefined;
      this.requestBody = undefined; this.owner.requestBytes = 0; this.response = undefined;
      if (!(this.fetchFlags & 64)) {
        this.listener = false; this.advanceFetchWork = undefined as never;
        retireOwnedSinkChild(this.root);
      }
    }
    if (this.cleanupFailed) throw identityFailure("cleanup");
    if (hasPrimary) throw ownedHttpFailureMetadata(primary) ? identityFailure("transport") : primary;
  }
}

export function checkOwnedHttpArchivePreparation(cap: OwnedHttpRequest, sink: OwnedHttpSinkOwner, env: Env,
  auth: AuthorizedIdentity, selection: ProxySelection, requestId: string): void {
  const owner = requestOwner(cap);
  if (sinkOwner(sink) !== owner || owner.env !== env || owner.sealed || owner.unknown
    || !matchesOwnedHttpArchiveInput(cap, env, auth, selection, requestId)) throw identityFailure("protocol");
}
export function prepareOwnedHttpArchive(cap: OwnedHttpRequest, sink: OwnedHttpSinkOwner, env: Env,
  auth: AuthorizedIdentity, selection: ProxySelection, requestId: string): Env["CONTENT_ARCHIVE"] {
  const owner = requestOwner(cap);
  if (sinkOwner(sink) !== owner || owner.env !== env || owner.sealed || owner.unknown
    || !claimOwnedHttpArchiveInput(cap, env, auth, selection, requestId)) throw identityFailure("protocol");
  claimOwnedHttpArchiveFunding(cap, selection.body as Record<string, unknown>);
  claimOwnedSinkFactories();
  // Capture the actual binding once at the newly admitted private preparation
  // point. The write command keeps its existing later binding-identity check.
  return owner.env!.CONTENT_ARCHIVE;
}

export function ownedHttpArchivePut(sink: OwnedHttpSinkOwner, bucket: Env["CONTENT_ARCHIVE"], key: string,
  value: string | ReadableStream<Uint8Array>, expiresAt: string): Promise<void> {
  const owner = sinkOwner(sink);
  if (bucket !== owner.env!.CONTENT_ARCHIVE) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 1); const record = sinkOrigin(sink, "put");
  const command = createOwnedSinkVoidCommand(owner, record);
  let original: Promise<unknown>;
  try { original = bucket.put(key, value, { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } }); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  command.observe(original); original = undefined as never;
  return command.ready;
}
export function ownedHttpArchivePipe(sink: OwnedHttpSinkOwner, source: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  reserveSinkOrigins(sink, 3); // ORIGINAL pipe, owned abort, original FIRSTcancel.
  const record = sinkOrigin(sink, "pipe");
  const command = createOwnedSinkVoidCommand(sinkOwner(sink), record);
  let original: Promise<void>;
  try { original = source.pipeTo(writable, { signal }); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  command.observe(original); original = undefined as never;
  return command.ready;
}
export function ownedHttpArchiveCancel(sink: OwnedHttpSinkOwner, readable: ReadableStream<Uint8Array>): Promise<void> {
  const record = sinkOrigin(sink, "cancel");
  const command = createOwnedSinkVoidCommand(sinkOwner(sink), record);
  let original: Promise<void>;
  try { original = readable.cancel(); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  command.observe(original); original = undefined as never;
  return command.ready;
}
export function ownedHttpArchiveAbort(sink: OwnedHttpSinkOwner, controller: AbortController): void {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "abort");
  try { controller.abort(); } catch (reason) { throw failedSinkOrigin(owner, record, reason); }
}

class OwnedSinkRegistration {
  private flags = 1; // installation/registration, seen, UNKNOWN, queued, closed, retired
  private observation?: OwnedOriginalObservation;
  declare readonly owner: RequestOwner;
  declare public origin: SinkOriginOwner;
  constructor(owner: RequestOwner, origin: SinkOriginOwner) {
    this.owner = owner; this.origin = origin;
  }
  private unknown(): void { this.flags |= 4; this.owner.unknown = true; }
  private observed(): void {
    if (this.flags & 2) return;
    this.flags |= 2;
    this.schedule();
  }
  private schedule(): void {
    if (this.flags & (8 | 32)) return;
    this.flags |= 8;
    try { ownedBoundaryQueue(this.advance.bind(this)); }
    catch { this.unknown(); }
  }
  private advance(): void {
    this.flags &= ~8;
    if (this.flags & (1 | 4 | 32) || (this.flags & (2 | 16)) !== (2 | 16)) return;
    if (!severOwnedOriginal(this.observation)) { this.unknown(); return; }
    this.observation = undefined; this.flags |= 32;
    retireOwnedSinkChild(this.owner);
  }
  dispatchOriginal(cell: OwnedOriginalObservation, _failed: boolean, _value: unknown): void {
    _value = undefined;
    if (cell === this.observation && !(this.flags & 32)) this.observed();
  }
  complete(context?: Pick<ExecutionContext, "waitUntil">, work?: Promise<void | boolean>): void {
    try {
      if (work) {
        // The actual observer return has no private business or custody role.
        // Callback acceptance cannot cross the still-open registration barrier.
        this.observation = { owner: this, kind: 0, state: 0 };
        try { installOwnedOriginal(this.observation, work); }
        catch (reason) { this.unknown(); throw failedSinkOrigin(this.owner, this.origin, reason); }
      } else this.flags |= 2;
      if (!context || !work) {
        this.origin = 32 * Math.floor(this.origin / 32) + sinkKinds.indexOf("registration-missing");
        throw failedSinkOrigin(this.owner, this.origin, 0);
      }
      try { context.waitUntil(work); }
      catch (reason) { throw failedSinkOrigin(this.owner, this.origin, reason); }
    } finally {
      work = undefined; context = undefined;
      this.flags = (this.flags & ~1) | 16;
      this.schedule();
    }
  }
  abandon(): void {
    this.flags = (this.flags & ~1) | 2 | 16;
    this.schedule();
  }
}
export function beginOwnedHttpSinkRegistration(sink: OwnedHttpSinkOwner): OwnedHttpSinkRegistration {
  const owner = sinkOwner(sink); reserveSinkOrigins(sink, 1);
  const origin = sinkOrigin(sink, "registration");
  claimOwnedSinkFactories(); enrollOwnedSinkChild(owner);
  const cap = Object.freeze({}), receipt = new OwnedSinkRegistration(owner, origin);
  (sinkRegistrations ??= new WeakMap()).set(cap, receipt);
  return cap;
}
export function completeOwnedHttpSinkRegistration(cap: OwnedHttpSinkRegistration, context?: Pick<ExecutionContext, "waitUntil">, work?: Promise<void | boolean>): void {
  const receipt = sinkRegistrations?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  sinkRegistrations!.delete(cap);
  receipt.complete(context, work);
}
export function abandonUnstartedOwnedHttpRegistration(cap: OwnedHttpSinkRegistration): void {
  const receipt = sinkRegistrations?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  sinkRegistrations!.delete(cap); receipt.abandon();
}

export function ownedHttpQueueSend(sink: OwnedHttpSinkOwner, queue: Env["USAGE_QUEUE"], message: QueueMessage,
  recovery?: OwnedHttpBudgetLeg): Promise<void> {
  const owner = sinkOwner(sink);
  if (recovery) return ownedBudgetRecoveryQueue(sink, queue, message, recovery);
  if (owner.budgetSequence) throw identityFailure("protocol");
  if (queue !== owner.env!.USAGE_QUEUE) throw identityFailure("protocol");
  const usage = (message as UsageEvent).type === "clawrouter.usage.v1";
  // These callers carry the already-admitted intent/capsule producers. Their
  // recovery send can overlap the original ledger/body cleanup. Keep a distinct
  // complete copy component; never borrow terminal or foreground credit.
  const funding = owner.funding.replace(owner.funding.bytes + (usage ? ownedCapsuleSerializationData : ownedIntentSerializationData));
  if (!funding) throw identityFailure("limit");
  owner.funding = funding;
  reserveSinkOrigins(sink, 1); const record = sinkOrigin(sink, "queue");
  const command = createOwnedSinkVoidCommand(owner, record);
  try { if (usage) copyPrivateQueueCapsule(message, command); else copyPrivateQueueIntent(message, command); }
  catch (reason) { command.abandonUnstarted(); throw reason; }
  let original: ReturnType<Env["USAGE_QUEUE"]["send"]>;
  try { original = queue.send(command.subject as QueueMessage); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  finally { message = undefined as never; }
  command.observe(original); original = undefined as never;
  return command.ready;
}

class OwnedProviderFetch {
  private flags = 1; // installation, accepted callback, failure, UNKNOWN, queued, delivered, disposal, transferred, cancel started, cancelled, retired
  private response?: Response;
  private observation?: OwnedOriginalObservation;
  private cancellation?: OwnedOriginalObservation;
  private resolve!: () => void;
  private reject!: (failure: object) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  private resolveRetired!: () => void;
  readonly retired = new Promise<void>(resolve => { this.resolveRetired = resolve; });
  private cancelOrigin = 0;
  declare readonly http: OwnedHttpRequest;
  declare readonly upload: UploadOwner;
  declare readonly origin: number;
  constructor(http: OwnedHttpRequest, upload: UploadOwner, origin: number) {
    this.http = http; this.upload = upload; this.origin = origin;
    void this.ready.then(ignoreOwnedVoidOutcome, ignoreOwnedVoidOutcome);
  }
  private unknown(): void { this.flags |= 8; this.upload.request.unknown = true; }
  private schedule(): void {
    if (this.flags & (16 | 1024)) return;
    this.flags |= 16;
    try { ownedBoundaryQueue(this.advance.bind(this)); } catch { this.unknown(); }
  }
  private failed(reason: unknown): void {
    this.flags |= 4;
    try { failedSinkOrigin(this.upload.request, this.origin, reason); } catch { this.unknown(); }
  }
  private accepted(value: Response): void {
    if (this.flags & 2) { value = undefined as never; return; }
    this.flags |= 2;
    try {
      if (!(value instanceof Response)) { this.failed(undefined); this.unknown(); }
      else this.response = value;
    } catch (reason) { this.failed(reason); this.unknown(); }
    finally { value = undefined as never; this.schedule(); }
  }
  private rejected(reason: unknown): void {
    if (this.flags & 2) { reason = undefined; return; }
    this.flags |= 2; this.failed(reason); reason = undefined; this.schedule();
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (this.flags & 1024) { value = undefined; return; }
    try {
      if (cell === this.observation) { if (failed) this.rejected(value); else this.accepted(value as Response); }
      else if (cell === this.cancellation) { if (failed) this.cancelFailed(value); else this.cancelled(); }
    } finally { value = undefined; }
  }
  invoke(url: URL, init: RequestInit): void {
    let original: Promise<Response> | undefined;
    try {
      try { original = fetch(url, init); }
      catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) {
        this.failed(reason); this.unknown();
        throw failedSinkOrigin(this.upload.request, this.origin, reason);
      }
    } finally { original = undefined; url = undefined as never; init = undefined as never; this.flags &= ~1; this.schedule(); }
  }
  consume(): void {
    if (!(this.flags & 32) || this.flags & (4 | 8 | 64 | 128) || !this.response) throw identityFailure("protocol");
    this.flags |= 2048;
    try { acceptOwnedHttpProviderResponse(this.http, this.upload.cap, this.response); }
    finally { this.flags &= ~2048; }
    this.response = undefined; this.flags |= 128; this.schedule();
  }
  matches(http: OwnedHttpRequest, response: Response): boolean {
    return this.http === http && this.response === response && !!(this.flags & 2048);
  }
  dispose(): Promise<void> { this.flags |= 64; this.schedule(); return this.retired; }
  private cancelled(): void {
    if (this.flags & 512) return;
    this.flags |= 512; this.schedule();
  }
  private cancelFailed(reason: unknown): void {
    if (this.flags & 512) { reason = undefined; return; }
    this.flags |= 512;
    try { failedSinkOrigin(this.upload.request, this.cancelOrigin, reason); }
    catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private cancel(): void {
    this.flags |= 256 | 1;
    let original: Promise<void> | undefined, started = false;
    try {
      this.cancelOrigin = sinkOrigin(this.upload.request.sink!, "cancel");
      if (!this.response!.body) { this.cancelled(); return; }
      if (this.response!.body!.locked) { this.unknown(); return; }
      try { original = this.response!.body!.cancel(); started = true; }
      catch (reason) { this.cancelFailed(reason); return; }
      this.cancellation = { owner: this, kind: 1, state: 0 };
      installOwnedOriginal(this.cancellation, original);
    } catch (reason) {
      if (started) this.unknown();
      this.cancelFailed(reason);
    } finally { original = undefined; this.flags &= ~1; this.schedule(); }
  }
  private advance(): void {
    this.flags &= ~16;
    if (this.flags & (1 | 1024)) return;
    try {
      if (!(this.flags & 32) && this.flags & (2 | 8)) {
        this.flags |= 32;
        if (this.flags & 4) {
          const failure = this.upload.request.sinkOrigins!.get(Math.floor(this.origin / 32));
          if (!failure || typeof failure === "number") { this.unknown(); return; }
          this.reject(failure);
        } else this.resolve();
        this.resolve = undefined as never; this.reject = undefined as never;
      }
      if (this.flags & 64 && this.response && !(this.flags & 256)) { this.cancel(); return; }
      if (this.flags & 8 || !(this.flags & 2) || this.response && !(this.flags & 512)) return;
      if (!severOwnedOriginal(this.observation) || !severOwnedOriginal(this.cancellation)) { this.unknown(); return; }
      this.observation = undefined; this.cancellation = undefined;
      this.response = undefined; this.flags |= 1024;
      retireOwnedSinkChild(this.upload.request);
      if (this.upload.provider === this) this.upload.provider = undefined;
      this.resolveRetired(); this.resolveRetired = undefined as never;
    } catch { this.unknown(); }
  }
}
export function startOwnedHttpProviderFetch(http: OwnedHttpRequest, attempt: OwnedHttpUpload, url: URL, init: RequestInit): Promise<void> {
  const owner = uploadOwner(attempt), root = requestOwner(http);
  if (owner.request !== root || owner.providerStarted || !owner.dispatched || !matchesOwnedHttpProviderFetchInput(http, attempt, url, init)) throw identityFailure("protocol");
  reserveSinkOrigins(root.sink!, 2);
  const record = sinkOrigin(root.sink!, "fetch");
  claimOwnedSinkFactories(); enrollOwnedSinkChild(root);
  const command = new OwnedProviderFetch(http, owner, record);
  owner.startProvider(); owner.provider = command; command.invoke(url, init); return command.ready;
}
export function consumeOwnedHttpProviderResponse(attempt: OwnedHttpUpload): void {
  const command = uploadOwner(attempt).provider;
  if (!command) throw identityFailure("protocol");
  command.consume();
}
export function matchesOwnedHttpProviderHandoff(http: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response): boolean {
  return uploads?.get(attempt)?.provider?.matches(http, response) === true;
}
export function disposeOwnedHttpProviderResponse(attempt: OwnedHttpUpload): Promise<void> | undefined {
  const command = uploadOwner(attempt).provider;
  return command?.dispose();
}
export function ownedHttpSignal(cap: OwnedHttpRequest): AbortSignal {
  const owner = requestOwner(cap);
  if (owner.abortController) return owner.abortController.signal;
  growOwnedHttpRequest(cap, 2048);
  const sink = ownedHttpSinkOwner(cap); reserveSinkOrigins(sink, 2);
  const adding = sinkOrigin(sink, "listener-add"), removal = sinkOrigin(sink, "listener-remove");
  const controller = new AbortController(), stopped = Object.freeze({ kind: "owned-http-aborted" });
  owner.abortController = controller; owner.abortRemoval = removal;
  owner.abortListener = () => controller.abort(stopped);
  try { owner.request!.signal.addEventListener("abort", owner.abortListener, { once: true }); }
  catch (reason) { throw failedSinkOrigin(owner, adding, reason); }
  if (owner.request!.signal.aborted) owner.abortListener();
  return controller.signal;
}
export function cancelOwnedHttpResponse(sink: OwnedHttpSinkOwner, response: Response): Promise<void> {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "cancel");
  if (!response.body) { return Promise.resolve(); }
  if (response.body.locked) { owner.unknown = true; return new Promise<never>(() => {}); }
  const command = createOwnedSinkVoidCommand(owner, record);
  let original: Promise<void>;
  try { original = response.body!.cancel(); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  command.observe(original); original = undefined as never;
  return command.ready;
}

class OwnedPreflightAcquisition {
  private acquisition = 0;
  private fetching = 0;
  private seen = false;
  private observation?: OwnedOriginalObservation;
  declare private root: RequestOwner;
  declare private receipt: PrivatePreflightReceipt;
  declare private permit: object;
  constructor(root: RequestOwner, receipt: PrivatePreflightReceipt, permit: object) {
    this.root = root; this.receipt = receipt; this.permit = permit;
    this.acquisition = sinkOrigin(root.sink!, "acquire"); this.fetching = sinkOrigin(root.sink!, "fetch");
  }
  private accepted(response: Response): void {
    if (this.seen) { response = undefined as never; return; }
    this.seen = true;
    try { adoptPrivatePreflightResponse(this.receipt, this.permit, response); }
    catch (reason) { this.root.unknown = true; try { failedSinkOrigin(this.root, this.fetching, reason); } catch { /* UNKNOWN retains the source. */ } }
    finally { response = undefined as never; }
  }
  private rejected(reason: unknown): void {
    if (this.seen) { reason = undefined; return; }
    this.seen = true;
    try { failedSinkOrigin(this.root, this.fetching, reason); failPrivatePreflightAcquisition(this.receipt, this.permit, reason === undefined); }
    catch { this.root.unknown = true; }
    finally { reason = undefined; }
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || !this.root) { value = undefined; return; }
    try { if (failed) this.rejected(value); else this.accepted(value as Response); }
    finally { value = undefined; }
  }
  invoke(binding: NonNullable<Env["ACCESS_CONTROL"]>, body: string, signal?: AbortSignal): void {
    beginPrivatePreflightAcquisition(this.receipt, this.permit);
    let stub: DurableObjectStub | undefined, original: Promise<Response> | undefined, uncertain = false;
    try {
      try { stub = binding.get(binding.idFromName(credentialPreflightNamespace)); }
      catch (reason) {
        failedSinkOrigin(this.root, this.acquisition, reason);
        failPrivatePreflightAcquisition(this.receipt, this.permit, reason === undefined); reason = undefined; return;
      }
      try { original = stub.fetch(`https://authority${credentialPreflightPath}`, {
        method: "POST", headers: { "content-type": "application/json", [credentialPreflightHeader]: credentialPreflightVersion }, body, signal, redirect: "manual",
      }); } catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) {
        uncertain = true; this.root.unknown = true;
        try { failedSinkOrigin(this.root, sinkOrigin(this.root.sink!, "retire"), reason); }
        catch { /* Started acquisition and its independent installation failure stay UNKNOWN. */ }
        finally { reason = undefined; }
      }
    } finally {
      original = undefined; stub = undefined; body = ""; binding = undefined as never;
      completePrivatePreflightInstallation(this.receipt, this.permit, uncertain);
    }
  }
  async consume(): Promise<CredentialPreflightReply> {
    try { return await consumePrivatePreflightReceipt(this.receipt, this.permit); }
    finally {
      if (!this.root.unknown && severOwnedOriginal(this.observation)) {
      this.observation = undefined; retireOwnedSinkChild(this.root);
      this.root = undefined as never; this.receipt = undefined as never; this.permit = undefined as never;
      } else this.root.unknown = true;
    }
  }
}
export function admitOwnedHttpPreflightSerialization(http: OwnedHttpRequest, sink: OwnedHttpSinkOwner, permit: object, ticket: PreflightTicket): void {
  const root = sinkOwner(sink);
  if (root !== requestOwner(http) || root.sealed || root.unknown || !matchesOwnedHttpPreflight(http, permit, ticket, sink)
    || !(ticket.bytes > 0)) throw identityFailure("protocol");
  // The genuine FULL ticket already owns the request/plan/text component. This
  // adds no source counter and claims the one shared domain before fixed use.
  claimOwnedSinkFactories();
}
export function consumeOwnedHttpPreflight(http: OwnedHttpRequest, sink: OwnedHttpSinkOwner, permit: object, ticket: PreflightTicket,
  binding: NonNullable<Env["ACCESS_CONTROL"]>, body: string, budget: IdentitySourceBudget, signal?: AbortSignal): Promise<CredentialPreflightReply> {
  const root = sinkOwner(sink);
  if (binding !== root.env!.ACCESS_CONTROL || !matchesOwnedHttpPreflight(http, permit, ticket, sink)) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 20); claimOwnedSinkFactories(); enrollOwnedSinkChild(root);
  let receipt: PrivatePreflightReceipt | undefined, command: OwnedPreflightAcquisition;
  try {
    receipt = createPrivatePreflightReceipt(ticket, root, permit, budget, signal);
    command = new OwnedPreflightAcquisition(root, receipt, permit);
  } catch (error) {
    if (receipt) abandonPrivatePreflightReceipt(receipt, permit);
    retireOwnedSinkChild(root); throw error;
  }
  command.invoke(binding, body, signal); return command.consume();
}

export function checkOwnedHttpMaterializationInputs(sink: OwnedHttpSinkOwner, cap: OwnedHttpCredential, permit: object,
  env: Env, key: string, grant: import("./types.ts").UpstreamGrant): void {
  const root = sinkOwner(sink);
  if (root.env !== env || !matchesOwnedHttpMaterialization(cap, permit, sink, env, key, grant)) throw identityFailure("protocol");
}

class OwnedContinuationAcquisition {
  private acquisition = 0;
  private fetching = 0;
  private seen = false;
  private observation?: OwnedOriginalObservation;
  started = false;
  private receipt?: PrivateContinuationReceipt;
  private init?: RequestInit;
  declare private root: RequestOwner;
  declare public permit: object;
  declare public destination: PrivateContinuationDestination;
  declare private ticket: PreflightTicket;
  declare private budget: IdentitySourceBudget;
  declare private request: Request;
  declare private attempt: UploadOwner | undefined;
  declare private binding: NonNullable<Env["ACCESS_CONTROL"]>;
  declare private namespace: typeof credentialPreflightNamespace;
  declare private signal: AbortSignal | undefined;
  constructor(root: RequestOwner, permit: object, destination: PrivateContinuationDestination,
    ticket: PreflightTicket, budget: IdentitySourceBudget, request: Request, attempt: UploadOwner | undefined,
    binding: NonNullable<Env["ACCESS_CONTROL"]>, namespace: typeof credentialPreflightNamespace,
    signal: AbortSignal | undefined) {
    this.root = root; this.permit = permit; this.destination = destination; this.ticket = ticket; this.budget = budget; this.request = request; this.attempt = attempt; this.binding = binding; this.namespace = namespace; this.signal = signal;
    this.acquisition = sinkOrigin(root.sink!, "acquire"); this.fetching = sinkOrigin(root.sink!, "fetch");
  }
  private accepted(response: Response): void {
    if (!this.started || this.seen) { response = undefined as never; return; }
    this.seen = true;
    try { adoptPrivateContinuationResponse(this.receipt!, this.permit, response); }
    catch (reason) { this.root.unknown = true; try { failedSinkOrigin(this.root, this.fetching, reason); } catch { /* Retain UNKNOWN. */ } }
    finally { response = undefined as never; }
  }
  private rejected(reason: unknown): void {
    if (!this.started || this.seen) { reason = undefined; return; }
    this.seen = true;
    try { failedSinkOrigin(this.root, this.fetching, reason); failPrivateContinuationAcquisition(this.receipt!, this.permit, reason === undefined); }
    catch { this.root.unknown = true; }
    finally { reason = undefined; }
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || !this.root) { value = undefined; return; }
    try { if (failed) this.rejected(value); else this.accepted(value as Response); }
    finally { value = undefined; }
  }
  private invoke(): void {
    beginPrivateContinuationAcquisition(this.receipt!, this.permit); this.started = true;
    let stub: DurableObjectStub | undefined, original: Promise<Response> | undefined, uncertain = false;
    try {
      try { stub = this.binding.get(this.binding.idFromName(this.namespace)); }
      catch (reason) {
        this.seen = true;
        failedSinkOrigin(this.root, this.acquisition, reason);
        failPrivateContinuationAcquisition(this.receipt!, this.permit, reason === undefined); reason = undefined; return;
      }
      try { original = stub.fetch(`https://authority${admissionContinuationPath}`, this.init); }
      catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) {
        uncertain = true; this.root.unknown = true;
        try { failedSinkOrigin(this.root, sinkOrigin(this.root.sink!, "retire"), reason); }
        catch { /* Installation uncertainty retains the first late callback right. */ }
        finally { reason = undefined; }
      }
    } catch (reason) {
      uncertain = true; this.root.unknown = true; reason = undefined;
    } finally {
      original = undefined; stub = undefined;
      completePrivateContinuationInstallation(this.receipt!, this.permit, uncertain);
    }
  }
  async consume(body: string, signal?: AbortSignal): Promise<void> {
    if (this.started || this.root.continuation !== this || this.root.request !== this.request
      || this.root.uploads[this.root.uploads.length - 1] !== this.attempt || this.signal !== signal)
      throw identityFailure("protocol");
    this.receipt = createPrivateContinuationReceipt(this.ticket, this.root, this.permit, this.destination, this.budget, this.signal);
    this.init = { method: "POST", headers: { "content-type": "application/json", [admissionContinuationHeader]: admissionContinuationVersion }, body, signal, redirect: "manual" };
    body = ""; signal = undefined;
    this.invoke();
    try { await consumePrivateContinuationReceipt(this.receipt!, this.permit); }
    finally { this.retire(); }
  }
  abandon(): void {
    if (this.started) throw identityFailure("protocol");
    if (this.receipt) abandonPrivateContinuationReceipt(this.receipt, this.permit);
    this.retire();
  }
  private retire(): void {
    // The lower consume joins physical retirement even when its report rejects.
    // It never waits on this HTTP parent. UNKNOWN cannot reach this handoff.
    if (this.root.unknown || !severOwnedOriginal(this.observation)) { this.root.unknown = true; return; }
    this.observation = undefined;
    this.root.continuation = undefined;
    retireOwnedSinkChild(this.root);
    this.root = undefined as never; this.receipt = undefined; this.ticket = undefined as never; this.budget = undefined as never;
    this.request = undefined as never; this.attempt = undefined; this.binding = undefined as never;
    this.signal = undefined; this.init = undefined;
    this.permit = undefined as never; this.destination = undefined as never;
  }
}
export function prepareOwnedHttpContinuation(http: OwnedHttpRequest, permit: object, destination: PrivateContinuationDestination,
  ticket: PreflightTicket, binding: NonNullable<Env["ACCESS_CONTROL"]>, namespace: typeof credentialPreflightNamespace, signal?: AbortSignal): void {
  const root = requestOwner(http);
  if (root.sealed || root.unknown || root.continuation || !root.request
    || !matchesOwnedHttpContinuation(http, permit, destination, ticket, binding, namespace)) throw identityFailure("protocol");
  // Fixed registration/receipt/source/VOID resolvers and active operands are
  // prepaid separately from the FULL ticket's body/text/parsed-envelope phase.
  growOwnedHttpRequest(http, 4096); reserveSinkOrigins(root.sink!, 20); claimOwnedSinkFactories();
  if (root.sealed || root.unknown || root.continuation
    || !matchesOwnedHttpContinuation(http, permit, destination, ticket, binding, namespace)) throw identityFailure("protocol");
  enrollOwnedSinkChild(root);
  try {
    const budget = identitySourceBudget();
    root.continuation = new OwnedContinuationAcquisition(root, permit, destination, ticket, budget, root.request!,
      root.uploads[root.uploads.length - 1], binding, namespace, signal);
  } catch (error) {
    retireOwnedSinkChild(root); throw error;
  }
}
export function consumeOwnedHttpContinuation(http: OwnedHttpRequest, permit: object, destination: PrivateContinuationDestination,
  body: string, signal?: AbortSignal): Promise<void> {
  const command = requestOwner(http).continuation;
  if (!command || command.permit !== permit || command.destination !== destination) throw identityFailure("protocol");
  return command.consume(body, signal);
}
export function abandonOwnedHttpContinuation(http: OwnedHttpRequest, permit: object, destination: PrivateContinuationDestination): void {
  const command = requestOwner(http).continuation;
  if (!command) return;
  if (command.permit !== permit || command.destination !== destination) throw identityFailure("protocol");
  command.abandon();
}
export function admitOwnedHttpMaterializationPayload(sink: OwnedHttpSinkOwner, cap: OwnedHttpCredential, permit: object,
  env: Env, key: string, grant: import("./types.ts").UpstreamGrant, bytes: number): void {
  checkOwnedHttpMaterializationInputs(sink, cap, permit, env, key, grant);
  if (!(bytes > 0) || bytes > 9007199254740991 || bytes % 1) throw identityFailure("protocol");
  const root = sinkOwner(sink), funding = root.funding.replace(root.funding.bytes + bytes);
  if (!funding) throw identityFailure("limit");
  root.funding = funding; claimOwnedSinkFactories();
}
class OwnedMaterializationAcquisition {
  private acquisition = 0;
  private fetching = 0;
  private seen = false;
  private observation?: OwnedOriginalObservation;
  declare private root: RequestOwner;
  declare private receipt: PrivateMaterializationReceipt;
  declare private permit: object;
  constructor(root: RequestOwner, receipt: PrivateMaterializationReceipt, permit: object) {
    this.root = root; this.receipt = receipt; this.permit = permit;
    this.acquisition = sinkOrigin(root.sink!, "acquire"); this.fetching = sinkOrigin(root.sink!, "fetch");
  }
  private accepted(response: Response): void {
    if (this.seen) { response = undefined as never; return; }
    this.seen = true;
    try { adoptPrivateMaterializationResponse(this.receipt, this.permit, response); }
    catch (reason) { this.root.unknown = true; try { failedSinkOrigin(this.root, this.fetching, reason); } catch { /* UNKNOWN already owns the command. */ } }
    finally { response = undefined as never; }
  }
  private rejected(reason: unknown): void {
    if (this.seen) { reason = undefined; return; }
    this.seen = true;
    try { failedSinkOrigin(this.root, this.fetching, reason); failPrivateMaterializationAcquisition(this.receipt, this.permit); }
    catch { this.root.unknown = true; }
    finally { reason = undefined; }
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || !this.root) { value = undefined; return; }
    try { if (failed) this.rejected(value); else this.accepted(value as Response); }
    finally { value = undefined; }
  }
  invoke(binding: NonNullable<Env["GRANT_CREDENTIALS"]>, key: string, body: string, signal?: AbortSignal): void {
    beginPrivateMaterializationAcquisition(this.receipt, this.permit);
    let stub: DurableObjectStub | undefined, original: Promise<Response> | undefined, uncertain = false;
    try {
      try { stub = binding.get(binding.idFromName(key)); }
      catch (reason) {
        failedSinkOrigin(this.root, this.acquisition, reason); reason = undefined;
        failPrivateMaterializationAcquisition(this.receipt, this.permit); return;
      }
      try { original = stub.fetch("https://clawrouter.internal/materialize", { method: "POST", body, signal, headers: { [identityHeader]: "v1" } }); }
      catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) {
        uncertain = true; this.root.unknown = true;
        try { failedSinkOrigin(this.root, sinkOrigin(this.root.sink!, "retire"), reason); }
        catch { /* Started acquisition and its independent installation failure stay UNKNOWN. */ }
        finally { reason = undefined; }
      }
    } finally {
      original = undefined; stub = undefined; body = ""; binding = undefined as never;
      completePrivateMaterializationInstallation(this.receipt, this.permit, uncertain);
    }
  }
  async consume(): Promise<void> {
    try { await consumePrivateMaterializationReceipt(this.receipt, this.permit); }
    finally {
      if (!this.root.unknown && severOwnedOriginal(this.observation)) {
      this.observation = undefined; retireOwnedSinkChild(this.root);
      this.root = undefined as never; this.receipt = undefined as never; this.permit = undefined as never;
      } else this.root.unknown = true;
    }
  }
}
export function consumeOwnedHttpGrantMaterialization(sink: OwnedHttpSinkOwner, cap: OwnedHttpCredential, permit: object,
  binding: NonNullable<Env["GRANT_CREDENTIALS"]>, key: string, body: string, signal?: AbortSignal): Promise<void> {
  const root = sinkOwner(sink);
  if (binding !== root.env!.GRANT_CREDENTIALS || !matchesOwnedHttpMaterialization(cap, permit, sink, undefined, key)) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 20); claimOwnedSinkFactories(); enrollOwnedSinkChild(root);
  let receipt: PrivateMaterializationReceipt | undefined, command: OwnedMaterializationAcquisition;
  try {
    receipt = createPrivateMaterializationReceipt(root, permit, permit as PrivateMaterializationDestination, identitySourceBudget(), signal);
    command = new OwnedMaterializationAcquisition(root, receipt, permit);
  } catch (error) {
    if (receipt) abandonPrivateMaterializationReceipt(receipt, permit);
    retireOwnedSinkChild(root); throw error;
  }
  command.invoke(binding, key, body, signal); return command.consume();
}

// Non-OK outcome is available immediately. Its original FIRSTcancel remains a
// separate join and may stay pending while the ordinary recovery send proceeds.
export function discardOwnedHttpSinkResponse(sink: OwnedHttpSinkOwner, response: Response): void {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "cancel");
  if (!response.body) { return; }
  if (response.body.locked) { owner.unknown = true; return; }
  const command = createOwnedSinkVoidCommand(owner, record);
  let original: Promise<void>;
  try { original = response.body!.cancel(); }
  catch (reason) { command.invokedFailure(reason); return; }
  command.observe(original); original = undefined as never;
}

const ownedLedgerAckWire = 32768;
const ownedLedgerAckBacking = 65536;
// Whole returned backing, BYOB work, private snapshot, retained wire, four
// UTF-16 occurrences, malformed-inclusive graph and bounded projected receipt.
// No header copy/profile is introduced by the private acknowledgment reader.
const ownedLedgerAckData = 1098240;
const ownedLedgerReceiptData = 2 * ownedLedgerAckWire + 512;
type OwnedLedgerAcknowledgment = {
  allowed?: boolean; dispatched?: boolean; charged?: boolean; settled?: boolean;
  chargeId?: string; eventId?: string; outcome?: "stored" | "duplicate" | "expired_by_retention";
};
function ownedLedgerGraphUpper(text: string): number {
  let census: ReturnType<typeof measurePrivateJsonBody> | undefined;
  try { census = measurePrivateJsonBody(text); return census.upper; }
  finally { census = undefined; text = ""; }
}
function reserveOwnedLedgerAcknowledgments(root: RequestOwner, count: number): void {
  const funding = root.funding.replace(root.funding.bytes + count * (ownedLedgerAckData + 4096 + 15 * ownedSinkOriginBytes));
  if (!funding) throw identityFailure("limit");
  root.funding = funding; root.sinkCredits += count * 15;
}
function retireOwnedLedgerAcknowledgmentData(root: RequestOwner, bytes: number): void {
  const funding = root.funding.replace(root.funding.bytes - bytes);
  if (!funding) { root.unknown = true; throw identityFailure("protocol"); }
  root.funding = funding;
}

type OwnedLedgerResult = OwnedLedgerAcknowledgment & { ok: boolean; status?: number };
class OwnedLedgerCommand {
  private flags = 1;
  private response?: Response;
  private observation?: OwnedOriginalObservation;
  private cancellation?: OwnedOriginalObservation;
  private ack?: OwnedLedgerAck;
  private resolve?: (value: OwnedLedgerResult) => void;
  private reject?: (reason: object) => void;
  readonly ready = new Promise<OwnedLedgerResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  origin = 0;
  private fetching = 0;
  private fetchInstallation: number;
  private cancelInstallation: number;
  private processing: number;
  declare readonly root: RequestOwner;
  declare readonly path: "/reserve" | "/dispatch" | "/charge" | "/settle" | "/ingest";
  declare readonly expectedId?: string;
  declare readonly budget?: OwnedBudgetSequence;
  constructor(root: RequestOwner, path: "/reserve" | "/dispatch" | "/charge" | "/settle" | "/ingest", expectedId?: string, budget?: OwnedBudgetSequence) {
    this.root = root; this.path = path; this.expectedId = expectedId; this.budget = budget;
    this.fetchInstallation = sinkOrigin(root.sink!, "retire");
    this.cancelInstallation = sinkOrigin(root.sink!, "retire");
    this.processing = sinkOrigin(root.sink!, "body");
    void this.ready.then(ignoreOwnedVoidOutcome, ignoreOwnedVoidOutcome);
  }
  private unknown(): void { this.flags |= 8; this.root.unknown = true; }
  private schedule(): void {
    if (this.flags & (16 | 512)) return;
    this.flags |= 16;
    try { ownedBoundaryQueue(this.advance.bind(this)); } catch { this.unknown(); }
  }
  private fail(origin: number, reason: unknown): void {
    try {
      const failure = failedSinkOrigin(this.root, origin, reason);
      if (!(this.flags & 32)) { this.flags |= 32; this.reject!(failure); delete this.resolve; delete this.reject; }
    } catch { this.unknown(); }
    finally { reason = undefined; }
  }
  private accepted(response: Response): void {
    if (this.flags & 2) { response = undefined as never; return; }
    this.flags |= 2;
    try { if (!(response instanceof Response)) { this.unknown(); this.flags |= 4; } else this.response = response; }
    catch { this.unknown(); this.flags |= 4; }
    finally { response = undefined as never; this.schedule(); }
  }
  private rejected(reason: unknown): void {
    if (this.flags & 2) { reason = undefined; return; }
    this.flags |= 2 | 4;
    try { failedSinkOrigin(this.root, this.fetching, reason); } catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (this.flags & 512) { value = undefined; return; }
    try {
      if (cell === this.observation) { if (failed) this.rejected(value); else this.accepted(value as Response); }
      else if (cell === this.cancellation) { if (failed) this.cancelFailed(value); else this.cancelled(); }
    } finally { value = undefined; }
  }
  invoke(namespace: Env["BUDGET_LEDGER"] | Env["USAGE_LEDGER"], name: string, body: string, signal?: AbortSignal): void {
    let original: Promise<Response> | undefined, stub: DurableObjectStub | undefined;
    const acquiring = sinkOrigin(this.root.sink!, "acquire");
    this.fetching = sinkOrigin(this.root.sink!, "fetch");
    try {
      try { stub = namespace.get(namespace.idFromName(name)); }
      catch (reason) { this.flags |= 2 | 4; this.fail(acquiring, reason); return; }
      try { original = stub.fetch(`https://clawrouter.internal${this.path}`, { method: "POST", body, signal }); }
      catch (reason) { this.rejected(reason); return; }
      this.observation = { owner: this, kind: 0, state: 0 };
      try { installOwnedOriginal(this.observation, original); }
      catch (reason) { this.unknown(); this.fail(this.fetchInstallation, reason); }
    } finally {
      original = undefined; stub = undefined; body = ""; namespace = undefined as never;
      this.flags &= ~1; this.schedule();
    }
  }
  acceptAck(value: unknown): void {
    if (this.flags & 32) throw identityFailure("protocol");
    let projected: OwnedLedgerResult;
    if (!value || typeof value !== "object" || Array.isArray(value)) projected = { ok: true };
    else {
      const item = value as Record<string, unknown>, expectedId = this.expectedId;
      projected = {
        ok: true,
        ...(typeof item.allowed === "boolean" ? { allowed: item.allowed } : {}),
        ...(typeof item.dispatched === "boolean" ? { dispatched: item.dispatched } : {}),
        ...(typeof item.charged === "boolean" ? { charged: item.charged } : {}),
        ...(typeof item.settled === "boolean" ? { settled: item.settled } : {}),
        ...(expectedId !== undefined && item.chargeId === expectedId ? { chargeId: expectedId } : {}),
        ...(expectedId !== undefined && item.eventId === expectedId ? { eventId: expectedId } : {}),
        ...(item.outcome === "stored" || item.outcome === "duplicate" || item.outcome === "expired_by_retention" ? { outcome: item.outcome } : {}),
      };
    }
    value = undefined; this.flags |= 32;
    this.resolve!(projected); delete this.resolve; delete this.reject;
  }
  rejectAck(failure: object): void {
    if (this.flags & 32) return;
    // Only the old body-acknowledgment catch becomes an invalid closed reply.
    // Acquisition/transport and genuine admission failures keep rejection.
    if (this.path === "/charge" || this.path === "/settle" || this.path === "/ingest") { this.acceptAck(undefined); return; }
    this.flags |= 32;
    this.reject!(failure); delete this.resolve; delete this.reject;
  }
  retireAckPayload(): void {
    if (this.flags & 1024) return;
    this.flags |= 1024;
    retireOwnedLedgerAcknowledgmentData(this.root, ownedLedgerAckData - ownedLedgerReceiptData);
  }
  handoffAck(ack: OwnedLedgerAck): boolean {
    if (this.ack !== ack || this.flags & (1 | 8 | 16 | 512) || !(this.flags & 32) || !(this.flags & 128)) return false;
    if (!severOwnedOriginal(this.observation)) return false;
    delete this.observation; delete this.ack;
    // admittedOwned*Command returned ready before this queued processing.
    // No caller retains the adapter: the projected receipt/Promise has no link
    // back to it. Neither resolving that receipt nor this cut retires a child.
    this.flags |= 512;
    return true;
  }
  private retire(): void {
    if (this.flags & (8 | 512)) return;
    if (!severOwnedOriginal(this.observation) || !severOwnedOriginal(this.cancellation)) { this.unknown(); return; }
    this.observation = undefined; this.cancellation = undefined;
    this.flags |= 512; this.response = undefined;
    // The closed reply may still be held by its real caller. Only the reader's
    // graph/text/backing overlap has joined and cleared at this boundary.
    this.retireAckPayload();
    if (this.budget) this.budget.retireCommand(); else retireOwnedSinkChild(this.root);
  }
  private cancelled(): void { if (this.flags & 256) return; this.flags |= 256; this.schedule(); }
  private cancelFailed(reason: unknown): void {
    if (this.flags & 256) { reason = undefined; return; }
    this.flags |= 256;
    try { failedSinkOrigin(this.root, this.origin, reason); } catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private discard(): void {
    this.flags |= 64 | 1;
    this.origin = sinkOrigin(this.root.sink!, "cancel");
    let original: Promise<void> | undefined, started = false;
    try {
      if (!this.response!.body) { this.cancelled(); return; }
      if (this.response!.body!.locked) { this.unknown(); return; }
      original = this.response!.body!.cancel(); started = true;
      this.cancellation = { owner: this, kind: 1, state: 0 };
      installOwnedOriginal(this.cancellation, original);
    } catch (reason) {
      if (started) { this.unknown(); this.fail(this.cancelInstallation, reason); }
      else this.cancelFailed(reason);
    } finally { original = undefined; this.flags &= ~1; this.schedule(); }
  }
  private advance(): void {
    this.flags &= ~16;
    if (this.flags & (1 | 512)) return;
    try {
      if (this.flags & 4) {
        if (!(this.flags & 32)) this.fail(this.fetching, 0);
        this.retire(); return;
      }
      // Installation uncertainty ends logical success, not the FIRST late
      // capture/disposition right. Cleanup uses the already enrolled position.
      if (this.flags & 8) {
        if (this.response && !(this.flags & (64 | 128))) this.discard();
        return;
      }
      if (!(this.flags & 2)) return;
      if (!(this.flags & (64 | 128))) {
        if (!this.response!.ok) {
          const status = this.path === "/settle" ? this.response!.status === 404 ? 404 : this.response!.status === 409 ? 409 : 0
            : this.path === "/reserve" || this.path === "/ingest" ? this.response!.status : undefined;
          this.discard();
          if (!(this.flags & 32)) { this.flags |= 32; this.resolve!({ ok: false, status }); delete this.resolve; delete this.reject; }
        } else {
          this.flags |= 128; this.origin = sinkOrigin(this.root.sink!, "body");
          this.ack = new OwnedLedgerAck(this, this.response); this.response = undefined; this.ack.open();
          if (!(this.flags & 8) && severOwnedOriginal(this.observation)) delete this.observation;
        }
      }
      if (this.flags & 64 && this.flags & 256) this.retire();
    } catch (reason) {
      this.fail(this.processing, reason); this.unknown();
      if (this.response && !(this.flags & (64 | 128))) {
        try { this.discard(); } catch { this.unknown(); }
      }
    }
  }
}
// One plan owns all future positions before the first reserve. The branch
// latch permits dispatch OR partial rollback; reserve originals stay additive.
interface OwnedBudgetLegRecord {
  sequence: OwnedBudgetSequence; ordinal: number; intent: BudgetReservationIntent;
  name: string; id: string; cap: OwnedHttpBudgetLeg; flags: number;
  reservation: object | undefined; request: BudgetSettleRequest | undefined;
  namespace: Env["BUDGET_LEDGER"] | undefined;
}
let ownedBudgetLegs: WeakMap<OwnedHttpBudgetLeg, OwnedBudgetLegRecord> | undefined;
class OwnedBudgetSequence {
  legs: OwnedBudgetLegRecord[] = [];
  phase = 0; // prepared, reserving, dispatch, rollback, closed
  physical = 1; // Logical plan sentinel, independent of every original tail.
  result: BudgetReservation | undefined;
  sinks: AccountingSinks | undefined;
  declare public root: RequestOwner;
  declare public http: OwnedHttpRequest;
  declare public accounting: OwnedHttpAccountingCommand;
  declare public plan: BudgetReservationPlan;
  declare public attempt: OwnedHttpUpload;
  constructor(root: RequestOwner, http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
    plan: BudgetReservationPlan, attempt: OwnedHttpUpload) {
    this.root = root; this.http = http; this.accounting = accounting; this.plan = plan; this.attempt = attempt;
  }
  prepare(): void {
    for (let ordinal = 0; ordinal < this.plan.legs.length; ordinal++) {
      const intent = this.plan.legs[ordinal], cap = Object.freeze({});
      const leg: OwnedBudgetLegRecord = { sequence: this, ordinal, intent, name: intent.objectName,
        id: intent.request.reservationId, cap, flags: 0, reservation: undefined, request: undefined, namespace: undefined };
      this.legs.push(leg); (ownedBudgetLegs ??= new WeakMap()).set(cap, leg);
    }
  }
  close(): void {
    if (this.phase === 4) return;
    this.phase = 4;
    // Logical branch selection has ended. Existing commands retain this same
    // physical destination; revoked legs cannot create another command.
    for (const leg of this.legs) {
      ownedBudgetLegs!.delete(leg.cap);
      const ended: Partial<OwnedBudgetLegRecord> = leg;
      delete ended.sequence; delete ended.ordinal; delete ended.intent;
      delete ended.name; delete ended.id; delete ended.cap; delete ended.flags;
      delete ended.reservation; delete ended.request; delete ended.namespace;
    }
    this.legs.length = 0;
    const ended: Partial<OwnedBudgetSequence> = this;
    delete ended.legs; delete ended.result; delete ended.sinks;
    delete ended.plan; delete ended.attempt; delete ended.accounting; delete ended.http;
    this.retireCommand();
  }
  retireCommand(): void {
    if (this.physical <= 0) throw identityFailure("protocol");
    if (--this.physical || this.phase !== 4) return;
    const root = this.root;
    delete (this as Partial<OwnedBudgetSequence>).root;
    // No debit is recycled: other request aliases still have their own owners.
    retireOwnedSinkChild(root);
  }
}
function ownedBudgetSequence(sink: OwnedHttpSinkOwner): OwnedBudgetSequence {
  const sequence = sinkOwner(sink).budgetSequence;
  if (!sequence || sequence.phase === 4) throw identityFailure("protocol");
  return sequence;
}
function ownedBudgetLeg(cap: OwnedHttpBudgetLeg, sink: OwnedHttpSinkOwner): OwnedBudgetLegRecord {
  const leg = ownedBudgetLegs?.get(cap), sequence = ownedBudgetSequence(sink);
  if (!leg || leg.sequence !== sequence || sequence.legs[leg.ordinal] !== leg) throw identityFailure("protocol");
  return leg;
}
export function beginOwnedHttpBudgetReserves(sink: OwnedHttpSinkOwner, env: Env, plan: BudgetReservationPlan): void {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.root.env !== env || sequence.plan !== plan || sequence.phase !== 0 || sequence.root.sealed || sequence.root.unknown)
    throw identityFailure("protocol");
  sequence.phase = 1;
}
export function claimOwnedHttpBudgetReserve(sink: OwnedHttpSinkOwner, intent: BudgetReservationIntent, ordinal: number): OwnedHttpBudgetLeg {
  const sequence = ownedBudgetSequence(sink), leg = sequence.legs[ordinal];
  if (sequence.phase !== 1 || sequence.root.sealed || sequence.root.unknown || !leg || leg.intent !== intent || leg.flags & 1)
    throw identityFailure("protocol");
  leg.flags |= 1; return leg.cap;
}
export function acceptOwnedHttpBudgetReservation(sink: OwnedHttpSinkOwner, cap: OwnedHttpBudgetLeg, reservation: object): void {
  const leg = ownedBudgetLeg(cap, sink);
  if (leg.sequence.phase !== 1 || !(leg.flags & 64) || leg.flags & 2) throw identityFailure("protocol");
  leg.flags |= 2; leg.reservation = reservation;
}
function selectOwnedBudgetBranch(sink: OwnedHttpSinkOwner, plan: BudgetReservationPlan, result: BudgetReservation, rollback: boolean): void {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.plan !== plan || sequence.phase !== 1) throw identityFailure("protocol");
  let fulfilled = 0;
  for (const leg of sequence.legs) if (leg.flags & 2) {
    if (result.reservations[fulfilled++] !== leg.reservation) throw identityFailure("protocol");
  }
  if (fulfilled !== result.reservations.length || (rollback ? fulfilled >= plan.legs.length : fulfilled !== plan.legs.length))
    throw identityFailure("protocol");
  sequence.result = result; sequence.phase = rollback ? 3 : 2;
}
export function selectOwnedHttpBudgetRollback(sink: OwnedHttpSinkOwner, plan: BudgetReservationPlan, result: BudgetReservation): void {
  selectOwnedBudgetBranch(sink, plan, result, true);
}
export function selectOwnedHttpBudgetDispatch(sink: OwnedHttpSinkOwner, plan: BudgetReservationPlan, result: BudgetReservation): void {
  selectOwnedBudgetBranch(sink, plan, result, false);
}
export function checkOwnedHttpBudgetDispatch(sink: OwnedHttpSinkOwner, result: BudgetReservation): void {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.result !== result || sequence.phase !== 2) throw identityFailure("protocol");
}
export function bindOwnedHttpBudgetRollbackSinks(sink: OwnedHttpSinkOwner, env: Env, sinks: AccountingSinks): void {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.phase !== 3 || sequence.root.env !== env || sinks.ownedHttp !== sink || sequence.sinks)
    throw identityFailure("protocol");
  sequence.sinks = sinks;
}
export function finishOwnedHttpBudgetBranch(sink: OwnedHttpSinkOwner, result: BudgetReservation): void {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.result !== result || sequence.phase !== 2 && sequence.phase !== 3) throw identityFailure("protocol");
  sequence.close();
}
function ownedBudgetReservationLeg(sink: OwnedHttpSinkOwner, item: object, phase: number): OwnedBudgetLegRecord {
  const sequence = ownedBudgetSequence(sink);
  if (sequence.phase !== phase) throw identityFailure("protocol");
  for (const leg of sequence.legs) if (leg.reservation === item && leg.flags & 2) return leg;
  throw identityFailure("protocol");
}
export function claimOwnedHttpBudgetDispatch(sink: OwnedHttpSinkOwner, item: object): OwnedHttpBudgetLeg {
  const leg = ownedBudgetReservationLeg(sink, item, 2);
  if (leg.sequence.root.sealed || leg.sequence.root.unknown || leg.flags & 4) throw identityFailure("protocol");
  leg.flags |= 4; return leg.cap;
}
export function claimOwnedHttpBudgetRollback(sink: OwnedHttpSinkOwner, item: object, cost: number): OwnedHttpBudgetLeg {
  const leg = ownedBudgetReservationLeg(sink, item, 3);
  if (cost !== 0 || leg.flags & 8) throw identityFailure("protocol");
  leg.flags |= 8; return leg.cap;
}
export function bindOwnedHttpBudgetRollbackRequest(sink: OwnedHttpSinkOwner, cap: OwnedHttpBudgetLeg, request: BudgetSettleRequest): void {
  const leg = ownedBudgetLeg(cap, sink);
  if (leg.sequence.phase !== 3 || !(leg.flags & 8) || leg.request || request.reservationId !== leg.id || request.actualCostMicros !== 0)
    throw identityFailure("protocol");
  leg.request = request;
}
export function failedOwnedHttpBudgetRollback(sink: OwnedHttpSinkOwner, cap: OwnedHttpBudgetLeg): void {
  const leg = ownedBudgetLeg(cap, sink);
  if (leg.sequence.phase !== 3 || !(leg.flags & 8) || leg.flags & 16) throw identityFailure("protocol");
  leg.flags |= 16;
}
export function claimOwnedHttpBudgetQueue(sink: OwnedHttpSinkOwner, cap: OwnedHttpBudgetLeg): void {
  const leg = ownedBudgetLeg(cap, sink);
  if (leg.sequence.phase !== 3 || !(leg.flags & 16) || leg.flags & 32) throw identityFailure("protocol");
  leg.flags |= 32;
}
function admittedOwnedBudgetCommand(leg: OwnedBudgetLegRecord, namespace: Env["BUDGET_LEDGER"],
  path: "/reserve" | "/dispatch" | "/settle", body: string, signal?: AbortSignal): Promise<OwnedLedgerResult> {
  const sequence = leg.sequence, command = new OwnedLedgerCommand(sequence.root, path, undefined, sequence);
  sequence.physical++;
  command.invoke(namespace, leg.name, body, signal); return command.ready;
}
function admittedOwnedLedgerCommand(root: RequestOwner, namespace: Env["BUDGET_LEDGER"] | Env["USAGE_LEDGER"], name: string,
  path: "/reserve" | "/dispatch" | "/charge" | "/settle" | "/ingest", body: string, signal?: AbortSignal, expectedId?: string): Promise<OwnedLedgerResult> {
  enrollOwnedSinkChild(root);
  const command = new OwnedLedgerCommand(root, path, expectedId);
  command.invoke(namespace, name, body, signal); return command.ready;
}
function admitOwnedLedgerSource(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"] | Env["USAGE_LEDGER"], usage: boolean): RequestOwner {
  const root = sinkOwner(sink);
  if (namespace !== (usage ? root.env!.USAGE_LEDGER : root.env!.BUDGET_LEDGER)) throw identityFailure("protocol");
  const funding = root.funding.replace(root.funding.bytes + (usage ? ownedCapsuleSerializationData : ownedIntentSerializationData));
  if (!funding) throw identityFailure("limit");
  root.funding = funding;
  reserveOwnedLedgerAcknowledgments(root, 1); reserveSinkOrigins(sink, 3); claimOwnedSinkFactories();
  return root;
}
// Closed source producers only: reserveBudget/dispatch and the matching
// charge/settle/ingest callers. Admission precedes every replacement carrier;
// namespace acquisition remains after protected serialization.
export function ownedHttpReserveAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"], name: string,
  source: BudgetReserveRequest, signal?: AbortSignal, cap?: OwnedHttpBudgetLeg): Promise<OwnedLedgerResult> {
  if (!cap) throw identityFailure("protocol");
  const leg = ownedBudgetLeg(cap, sink), sequence = leg.sequence;
  if (sequence.phase !== 1 || sequence.root.sealed || sequence.root.unknown || !(leg.flags & 1) || leg.flags & 64
    || leg.intent.request !== source || leg.name !== name) throw identityFailure("protocol");
  leg.flags |= 64; leg.namespace = namespace;
  const request = { policyId: source.policyId, windowKey: source.windowKey, scopeKey: source.scopeKey, limitMicros: source.limitMicros,
    costMicros: source.costMicros, reservationId: source.reservationId, capability: source.capability, dispatched: source.dispatched };
  const body = privateIntentJson(request);
  return admittedOwnedBudgetCommand(leg, namespace, "/reserve", body, signal);
}
export function ownedHttpDispatchAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"], name: string,
  reservationId: string, signal?: AbortSignal, cap?: OwnedHttpBudgetLeg): Promise<OwnedLedgerResult> {
  if (!cap) throw identityFailure("protocol");
  const leg = ownedBudgetLeg(cap, sink), sequence = leg.sequence;
  if (sequence.phase !== 2 || sequence.root.sealed || sequence.root.unknown || !(leg.flags & 4) || leg.flags & 128
    || leg.namespace !== namespace || leg.name !== name || leg.id !== reservationId) throw identityFailure("protocol");
  leg.flags |= 128;
  const body = privateIntentJson({ reservationId });
  return admittedOwnedBudgetCommand(leg, namespace, "/dispatch", body, signal);
}

export function ownedHttpChargeAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"], name: string,
  source: BudgetChargeRequest): Promise<OwnedLedgerResult> {
  const root = admitOwnedLedgerSource(sink, namespace, false);
  // Preserve the actual charge producer's property order, including its
  // amountMicros appended after the previously admitted charge identity.
  const body = privateIntentJson({ ...source });
  return admittedOwnedLedgerCommand(root, namespace, name, "/charge", body, undefined, source.chargeId);
}
export function ownedHttpSettleAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"], name: string,
  source: BudgetSettleRequest, signal?: AbortSignal, cap?: OwnedHttpBudgetLeg): Promise<OwnedLedgerResult> {
  if (!cap) throw identityFailure("protocol");
  const leg = ownedBudgetLeg(cap, sink);
  if (leg.sequence.phase !== 3 || !(leg.flags & 8) || leg.flags & 256 || leg.request !== source
    || leg.namespace !== namespace || leg.name !== name) throw identityFailure("protocol");
  leg.flags |= 256;
  const body = privateIntentJson({ reservationId: source.reservationId, actualCostMicros: source.actualCostMicros });
  return admittedOwnedBudgetCommand(leg, namespace, "/settle", body, signal);
}
function ownedBudgetRecoveryQueue(sink: OwnedHttpSinkOwner, queue: Env["USAGE_QUEUE"], message: QueueMessage,
  cap: OwnedHttpBudgetLeg): Promise<void> {
  const leg = ownedBudgetLeg(cap, sink), sequence = leg.sequence;
  const settlement = message as Extract<QueueMessage, { kind: "budget_settlement" }>;
  if (sequence.phase !== 3 || !(leg.flags & 32) || leg.flags & 512 || settlement.kind !== "budget_settlement"
    || queue !== sequence.sinks?.queue || settlement.request !== leg.request || !("ledger" in settlement) || settlement.ledger.objectName !== leg.name)
    throw identityFailure("protocol");
  leg.flags |= 512;
  const command = new OwnedSinkVoidCommand(sequence.root, sinkOrigin(sink, "queue"), sequence);
  sequence.physical++;
  try { copyPrivateQueueIntent(message, command); }
  catch (reason) { command.abandonUnstarted(); throw reason; }
  let original: ReturnType<Env["USAGE_QUEUE"]["send"]>;
  try { original = queue.send(command.subject as QueueMessage); }
  catch (reason) { command.invokedFailure(reason); return command.ready; }
  command.observe(original); original = undefined as never; return command.ready;
}

export function ownedHttpIngestAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["USAGE_LEDGER"], name: string,
  source: UsageEvent, signal?: AbortSignal): Promise<OwnedLedgerResult> {
  const root = admitOwnedLedgerSource(sink, namespace, true);
  // The full event remains on its bounded protected-copy route until every
  // nested producer occurrence has a separate no-copy provenance proof.
  const body = privateCapsuleJson(source);
  return admittedOwnedLedgerCommand(root, namespace, name, "/ingest", body, signal, source.id);
}
export function ownedHttpLedgerAcknowledgment(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"] | Env["USAGE_LEDGER"],
  name: string, path: "/reserve" | "/dispatch" | "/charge" | "/settle" | "/ingest", body: string, signal?: AbortSignal, expectedId?: string): Promise<OwnedLedgerResult> {
  const root = sinkOwner(sink);
  if (namespace !== (path === "/ingest" ? root.env!.USAGE_LEDGER : root.env!.BUDGET_LEDGER)) throw identityFailure("protocol");
  reserveOwnedLedgerAcknowledgments(root, 1); reserveSinkOrigins(sink, 3); claimOwnedSinkFactories();
  return admittedOwnedLedgerCommand(root, namespace, name, path, body, signal, expectedId);
}

interface OwnedHttpReadObservation {
  owner: OwnedStatusReader | undefined;
  nonce: number | undefined;
  state: number;
}
function ownedHttpReadFulfilled(this: OwnedHttpReadObservation, value: unknown): void {
  if (this.state & (1 | 8)) { value = undefined; return; }
  try { this.owner?.dispatchReadObservation(this, false, value); } finally { value = undefined; }
}
function ownedHttpReadRejected(this: OwnedHttpReadObservation, reason: unknown): void {
  if (this.state & (1 | 8)) { reason = undefined; return; }
  try { this.owner?.dispatchReadObservation(this, true, reason); } finally { reason = undefined; }
}

// This reader has one closed destination: its genuine ledger command/terminal
// slot. Successful values never enter a Promise or a caller-supplied callback.
// Fixed placement is source-defined, never selected from spare capacity:
// OPERATION: genuine destination/terminal slot and logical handoff rights.
// SOURCE: ACK instance/body plus acquisition-installed closed handlers/links.
// READ: active capture/read cells, native qualification and correlation record.
// TERMINAL: closed/unlock rights/origins, unlock handlers and physical join state.
// SYNC: only live activations/arguments/proofs and the in-place transition.
// The same nativeFailure target/map record is still separately owned/counted;
// deleting this reference later supplies neither a record nor DATA refund.
interface AckReadCell { owner: OwnedLedgerAck | undefined; state: number }
function ackReadFulfilled(this: AckReadCell, value: unknown): void {
  if (this.state & (1 | 8)) { value = undefined; return; }
  this.state |= 16;
  try { this.owner?.dispatchReadObservation(this, false, value); }
  finally { value = undefined; this.state &= ~16; }
}
function ackReadRejected(this: AckReadCell, reason: unknown): void {
  if (this.state & (1 | 8)) { reason = undefined; return; }
  this.state |= 16;
  try { this.owner?.dispatchReadObservation(this, true, reason); }
  finally { reason = undefined; this.state &= ~16; }
}
function ackClosedFulfilled(this: OwnedLedgerAck, _value: unknown): void {
  _value = undefined; if (this.closedState & (1 | 8)) return; this.acceptClosed(false, undefined);
}
function ackClosedRejected(this: OwnedLedgerAck, reason: unknown): void {
  if (this.closedState & (1 | 8)) { reason = undefined; return; }
  try { this.acceptClosed(true, reason); } finally { reason = undefined; }
}
function ackUnlockFulfilled(this: OwnedLedgerAck, _value: unknown): void {
  _value = undefined; if (this.unlockState & (1 | 8)) return; this.acceptUnlock(false, undefined);
}
function ackUnlockRejected(this: OwnedLedgerAck, reason: unknown): void {
  if (this.unlockState & (1 | 8)) { reason = undefined; return; }
  try { this.acceptUnlock(true, reason); } finally { reason = undefined; }
}

class OwnedLedgerAck {
  declare owner?: RequestOwner | OwnedBudgetSequence | OwnedAccountingTerminal;
  body?: ReadableStream<Uint8Array> | null;
  closedState = 3;
  closedOrigin = 0;
  unlockState = 0;
  unlockOrigin = 0;
  joinState = 0;
  nativeFailure?: SinkOriginRecord;
  declare slot?: number;
  reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  decoder?: TextDecoder;
  capture?: Uint8Array;
  text = "";
  wire = 0;
  length = 0;
  pending = 0;
  installing = 0;
  readObservation?: AckReadCell;
  cancelObservation?: OwnedOriginalObservation;
  readOrigin = 0;
  cancelOrigin = 0;
  primaryOrigin = 0;
  declare parent?: OwnedLedgerCommand;
  declare response?: Response;
  declare origin: number;
  constructor(parent: OwnedLedgerCommand | OwnedAccountingTerminal, response: Response | undefined, slot?: number, origin?: number) {
    if (parent instanceof OwnedLedgerCommand) {
      this.parent = parent; this.owner = parent.budget ?? parent.root; this.origin = parent.origin;
    } else { this.owner = parent; this.slot = slot!; this.origin = origin!; }
    this.response = response;
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.cancelObservation || this.joinState & 16384) { value = undefined; return; }
    try { if (failed) this.cancelFailed(value); else this.cancelled(); }
    finally { value = undefined; }
  }
  private get root(): RequestOwner { return this.owner instanceof OwnedBudgetSequence || this.owner instanceof OwnedAccountingTerminal ? this.owner.root : this.owner!; }
  private unknown(): void { this.joinState |= 4; this.root.unknown = true; }
  private schedule(): void {
    if (this.joinState & (2 | 16384)) return;
    this.joinState |= 2;
    try { ownedBoundaryQueue(this.advance.bind(this)); } catch { this.unknown(); }
  }
  private failure(origin: number, reason: unknown): void {
    try {
      failedSinkOrigin(this.root, origin, reason);
      this.primaryOrigin ||= origin;
    } catch { this.unknown(); }
    finally { reason = undefined; this.joinState |= 8; this.schedule(); }
  }
  private observationFailure(reason: unknown): void {
    this.unknown();
    try { this.failure(sinkOrigin(this.root.sink!, "retire"), reason); }
    catch { this.unknown(); }
    finally { reason = undefined; }
  }
  open(): void {
    this.installing++;
    try {
      this.body = this.response!.body;
      if (!this.body) { this.failure(this.origin, 0); return; }
      let acquire = sinkOrigin(this.root.sink!, "acquire");
      try { this.reader = this.body.getReader({ mode: "byob" }); this.joinState |= 1; }
      catch (reason) {
        failedSinkOrigin(this.root, acquire, reason); reason = undefined;
        // The default reader is a real parsing fallback for the amended ACK
        // protocol, matching Response.json's default-readable input support.
        acquire = sinkOrigin(this.root.sink!, "acquire");
        try { this.reader = this.body.getReader(); }
        catch (fallback) { this.failure(acquire, fallback); this.unknown(); return; }
        reason = undefined;
      }
      this.closedOrigin = sinkOrigin(this.root.sink!, "closed"); this.closedState = 16;
      let closed: Promise<void> | undefined, started = false;
      try {
        const prototype = this.joinState & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype;
        const getter = this.joinState & 1 ? ownedStatusNativeClosed : originalReaderClosed;
        if (Object.getPrototypeOf(this.reader) === prototype && !Object.hasOwn(this.reader, "closed")
          && typeof originalLookupGetter === "function" && originalLookupGetter.call(this.reader, "closed") === getter) this.closedState |= 32;
        closed = this.reader.closed; started = !!closed;
        const then = closed.then;
        if (then !== ownedBoundaryThen) this.closedState &= ~32;
        void Reflect.apply(then, closed, [ackClosedFulfilled.bind(this), ackClosedRejected.bind(this)]);
        this.closedState |= 2;
      } catch (reason) {
        if (started) { this.closedState |= 4; this.observationFailure(reason); }
        else { this.closedState |= 3; this.failure(this.closedOrigin, reason); }
      } finally { closed = undefined; this.closedState &= ~16; }
      if (this.joinState & 8) return;
      this.decoder = newOwnedDecoder(); this.capture = newOwnedBytes(ownedLedgerAckBacking);
    } catch (reason) { this.failure(this.origin, reason); }
    finally { this.response = undefined; this.installing--; this.schedule(); }
  }
  acceptClosed(failed: boolean, reason: unknown): void {
    if (this.closedState & (1 | 8) || this.joinState & 16384) { reason = undefined; return; }
    this.closedState |= 1 | 64;
    try {
      if (failed && (!(this.closedState & 32) || !this.nativeFailure)) {
        const failure = failedSinkOrigin(this.root, this.closedOrigin, reason);
        if (this.closedState & 32) this.nativeFailure = failure;
      }
    } catch { this.unknown(); }
    finally { reason = undefined; this.closedState &= ~64; this.schedule(); }
  }
  private read(): void {
    if (this.readObservation) throw identityFailure("protocol");
    let observation: AckReadCell | undefined = { owner: this, state: 0 };
    this.readObservation = observation;
    this.pending |= 2; this.joinState &= ~(16 | 32); this.installing++;
    let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined, started = false;
    try {
      this.readOrigin ||= sinkOrigin(this.root.sink!, "read");
      const reader = this.reader!, method = reader.read;
      const prototype = this.joinState & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype;
      if (Object.getPrototypeOf(reader) === prototype && method === (this.joinState & 1 ? ownedStatusNativeRead : originalReaderRead)) this.joinState |= 65536;
      else this.joinState &= ~65536;
      if (this.joinState & 1) {
        const backing = newOwnedBytes(16384);
        original = Reflect.apply(method, reader, [backing]);
      } else original = Reflect.apply(method, reader, []);
      started = !!original;
      const then = original!.then;
      if (then !== ownedBoundaryThen) this.joinState &= ~65536;
      void Reflect.apply(then, original, [ackReadFulfilled.bind(observation), ackReadRejected.bind(observation)]);
      observation.state |= 2;
    } catch (reason) {
      observation.state |= started ? 4 : 3;
      if (started) this.observationFailure(reason);
      else this.failure(this.readOrigin || this.origin, reason);
      if (!started) this.joinState |= 16;
    } finally { observation = undefined; original = undefined; this.installing--; this.schedule(); }
  }
  dispatchReadObservation(cell: AckReadCell, failed: boolean, value: unknown): void {
    if (this.readObservation !== cell || cell.state & (1 | 8)
      || !(this.pending & 2) || this.joinState & (16 | 16384)) { value = undefined; return; }
    cell.state |= 1;
    try {
      if (failed) this.readRejected(value);
      else this.readAccepted(value as ReadableStreamReadResult<Uint8Array>);
    } catch { this.unknown(); }
    finally { value = undefined; }
  }
  private dischargeReadObservation(): void {
    let cell = this.readObservation;
    if (cell && !this.installing && !(this.pending & 2) && !(this.joinState & 4) && cell.state === 3) {
      cell.state = 8; cell.owner = undefined; delete this.readObservation;
    }
    cell = undefined;
  }
  private readAccepted(result: ReadableStreamReadResult<Uint8Array>): void {
    if (!(this.pending & 2) || this.joinState & (16 | 16384)) { result = undefined as never; return; }
    this.joinState |= 16;
    try {
      const done = !!result.done;
      let value = result.value;
      if (value !== undefined) {
        const proof = inspectOwnedBytes(value);
        if (!isLocalOwnedByteView(value) || !isLocalOwnedByteBacking(proof.buffer)
          || proof.backing > ownedLedgerAckBacking || proof.length > ownedLedgerAckWire - this.wire) {
          this.failure(this.origin, 0); return;
        }
        this.length = proof.length;
        copyOwnedBytes(this.capture!, value); value = undefined;
      } else this.length = 0;
      if (done) this.joinState |= 32;
    } catch (reason) { this.failure(this.origin, reason); }
    finally { result = undefined as never; this.schedule(); }
  }
  private readRejected(reason: unknown): void {
    if (!(this.pending & 2) || this.joinState & (16 | 16384)) { reason = undefined; return; }
    this.joinState |= 16;
    try {
      if (this.joinState & 65536 && this.nativeFailure) {
        this.primaryOrigin ||= 32 * this.nativeFailure.ordinal + sinkKinds.indexOf(this.nativeFailure.origin);
        this.joinState |= 8; this.schedule();
      } else {
        this.failure(this.readOrigin, reason);
        if (this.joinState & 65536) {
          const failure = this.root.sinkOrigins!.get(Math.floor(this.readOrigin / 32));
          if (failure && typeof failure !== "number") this.nativeFailure = failure;
        }
      }
    } catch { this.unknown(); }
    finally { reason = undefined; }
  }
  private cancel(): void {
    this.joinState |= 512; this.pending |= 4; this.installing++;
    let original: Promise<void> | undefined, started = false;
    try {
      if (!this.reader) { if (this.body) this.unknown(); this.cancelled(); return; }
      this.cancelOrigin = sinkOrigin(this.root.sink!, "cancel");
      const reader = this.reader, method = reader.cancel;
      const prototype = this.joinState & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype;
      if (Object.getPrototypeOf(reader) === prototype && method === (this.joinState & 1 ? originalByobCancel : originalReaderCancel)) this.joinState |= 131072;
      original = Reflect.apply(method, reader, []); started = !!original;
      const then = original!.then;
      if (then !== ownedBoundaryThen) this.joinState &= ~131072;
      this.cancelObservation = { owner: this, kind: 2, state: 0 };
      installOwnedOriginalMethod(this.cancelObservation, original, then);
    } catch (reason) {
      if (started) this.observationFailure(reason);
      else this.cancelFailed(reason);
    } finally { original = undefined; this.installing--; this.schedule(); }
  }
  private cancelled(): void { if (this.joinState & 1024) return; this.joinState |= 1024; this.schedule(); }
  private cancelFailed(reason: unknown): void {
    if (!(this.pending & 4) || this.joinState & (1024 | 16384)) { reason = undefined; return; }
    this.joinState |= 1024;
    try {
      if (!(this.joinState & 131072) || !this.nativeFailure) {
        const failure = failedSinkOrigin(this.root, this.cancelOrigin, reason);
        if (this.joinState & 131072) this.nativeFailure = failure;
      }
    } catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private unlock(): void {
    this.joinState |= 2048; this.installing++; this.unlockState = 16;
    let original: unknown, started = false;
    try {
      if (!this.reader) { this.unlockState |= 3; return; }
      this.unlockOrigin = sinkOrigin(this.root.sink!, "unlock");
      original = this.reader.releaseLock(); started = original !== undefined;
      if (!started) { this.unlockState |= 3; return; }
      let then: unknown;
      if (original !== null && (typeof original === "object" || typeof original === "function")) then = (original as { then?: unknown }).then;
      if (typeof then !== "function") { this.unlockState |= 3; return; }
      void Reflect.apply(then, original, [ackUnlockFulfilled.bind(this), ackUnlockRejected.bind(this)]);
      this.unlockState |= 2;
      then = undefined;
    } catch (reason) {
      if (started) { this.unlockState |= 4; this.observationFailure(reason); }
      else { this.unlockState |= 3; this.failure(this.unlockOrigin, reason); }
    } finally { original = undefined; this.unlockState &= ~16; this.installing--; this.schedule(); }
  }
  acceptUnlock(failed: boolean, reason: unknown): void {
    if (this.unlockState & (1 | 8) || this.joinState & 16384) { reason = undefined; return; }
    this.unlockState |= 1 | 64;
    try { if (failed) failedSinkOrigin(this.root, this.unlockOrigin, reason); }
    catch { this.unknown(); }
    finally { reason = undefined; this.unlockState &= ~64; this.schedule(); }
  }
  private compact(): void {
    if (this.joinState & 4 || this.closedState & (4 | 16 | 64) || this.unlockState & (4 | 16 | 64)
      || !(this.unlockState & 2) || this.installing || this.pending || this.readObservation) return;
    if (!severOwnedOriginal(this.cancelObservation)) { this.unknown(); return; }
    if (this.parent && !this.parent.handoffAck(this)) return;
    // Same physical instance, same destination and charge. Queued execution
    // enters tail mode only after read/cancel/unlock-install frames returned.
    delete this.readObservation; delete this.cancelObservation; delete this.parent; delete this.response;
    delete this.reader; delete this.capture; delete this.decoder;
    const ended: Partial<OwnedLedgerAck> = this;
    delete ended.text; delete ended.wire; delete ended.length; delete ended.pending;
    delete ended.installing; delete ended.readOrigin; delete ended.cancelOrigin;
    delete ended.primaryOrigin; delete ended.origin;
    this.joinState = 262144; this.schedule();
  }
  private retireTail(): void {
    if (this.joinState & 16384) return;
    if (this.joinState & 4 || (this.closedState & (7 | 16 | 64)) !== 3 || (this.unlockState & (7 | 16 | 64)) !== 3) return;
    try { if (this.body?.locked) { this.unknown(); return; } }
    catch { this.unknown(); return; }
    const owner = this.owner!, slot = this.slot, root = this.root;
    if (owner instanceof OwnedAccountingTerminal && owner.operations[slot!] !== this) { this.unknown(); return; }
    // End external handler rights and payload aliases before the same physical
    // destination discharges its existing component. Failure cannot retry it.
    this.closedState |= 8; this.unlockState |= 8; this.joinState |= 16384;
    delete this.body; delete this.nativeFailure;
    try {
      if (owner instanceof OwnedAccountingTerminal) owner.retireAckTail(slot!, this);
      else {
        retireOwnedLedgerAcknowledgmentData(root, ownedLedgerAckData - ownedLedgerReceiptData);
        if (owner instanceof OwnedBudgetSequence) owner.retireCommand(); else retireOwnedSinkChild(root);
      }
    } catch { this.joinState |= 4; root.unknown = true; return; }
    delete this.owner; delete this.slot;
  }

  private parse(): void {
    // Whole malformed-inclusive native construction stays inside the prepaid
    // component. The scanner's limited bit is deliberately irrelevant here.
    if (ownedLedgerGraphUpper(this.text) > 18 * ownedLedgerAckWire) { this.failure(this.origin, 0); return; }
    let value: unknown;
    try {
      try { value = JSON.parse(this.text); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        error = undefined; this.failure(this.origin, 0); return;
      }
      this.joinState |= 128;
      if (this.parent) this.parent.acceptAck(value); else (this.owner as OwnedAccountingTerminal).accept(this.slot!, value);
    } finally { value = undefined; this.text = ""; }
  }
  private advance(): void {
    this.joinState &= ~2;
    if (this.joinState & 16384) return;
    if (this.joinState & 262144) { this.retireTail(); return; }
    if (this.installing) return;
    try {
      if (this.primaryOrigin && !(this.joinState & 128)) {
        const failure = this.root.sinkOrigins!.get(Math.floor(this.primaryOrigin / 32));
        if (!failure || typeof failure === "number") { this.unknown(); return; }
        this.joinState |= 128; if (this.parent) this.parent.rejectAck(failure); else (this.owner as OwnedAccountingTerminal).reject(this.slot!);
      }
      if (this.joinState & 1024) this.pending &= ~4;
      if (this.pending & 2 && this.joinState & 16) {
        this.pending &= ~2;
        if (!(this.joinState & 8)) {
          this.wire += this.length;
          let decoded = this.length ? decodeOwnedBytes(this.decoder!, ownedByteSubarray(this.capture!, 0, this.length), !(this.joinState & 32))
            : this.joinState & 32 ? decodeOwnedBytes(this.decoder!) : "";
          if (decoded.length > ownedLedgerAckWire - this.text.length) this.failure(this.origin, 0);
          else this.text += decoded;
          this.length = 0;
          decoded = "";
          this.dischargeReadObservation();
          if (!(this.joinState & 8) && this.joinState & 32) { this.joinState |= 64 | 8; this.parse(); }
        }
        else this.dischargeReadObservation();
        if (!(this.joinState & 8)) { this.schedule(); return; }
      }
      if (this.joinState & 8) {
        if (!(this.joinState & (64 | 512))) { this.cancel(); return; }
        if (this.pending & (2 | 4)) return;
        if (!(this.joinState & 2048)) { this.unlock(); return; }
        this.compact(); return;
      }
      if (!(this.pending & 2)) this.read();
    } catch (reason) { this.failure(this.origin, reason); }
  }
}

// The terminal owns fifteen fixed operation positions: five ledger fetches,
// five body reads/cancellations, and five queue sends. Recovery does not await
// an unused body's cancellation. Ordinary finalization keeps its existing path.
class OwnedTerminalOperation {
  flags = 16; // retired, UNKNOWN, FIRST, rejected, installing, queued, cancel-only
  private observation?: OwnedOriginalObservation;
  private installationOrigin: number;
  private processingOrigin: number;
  private dispositionOrigin: number;
  declare readonly owner: OwnedAccountingTerminal;
  declare readonly code: number;
  declare readonly origin: number;
  declare public subject?: unknown;
  constructor(owner: OwnedAccountingTerminal, code: number, origin: number, subject?: unknown) {
    this.owner = owner; this.code = code; this.origin = origin; this.subject = subject;
    this.installationOrigin = sinkOrigin(owner.sink, "retire");
    this.processingOrigin = sinkOrigin(owner.sink, "body");
    this.dispositionOrigin = sinkOrigin(owner.sink, "cancel");
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (cell !== this.observation || this.flags & 1) { value = undefined; return; }
    try { if (failed) this.reject(value); else this.accept(value); }
    finally { value = undefined; }
  }
  observe(original: Promise<unknown>): void {
    this.observation = { owner: this, kind: 0, state: 0 };
    try { installOwnedOriginal(this.observation, original); }
    catch (reason) { this.unknown(reason); }
    finally { original = undefined as never; this.flags &= ~16; this.schedule(); }
  }
  accept(value: unknown): void {
    if (this.flags & (1 | 4)) { value = undefined; return; }
    this.flags |= 4;
    try {
      if (this.code < 5 && !(value instanceof Response)) { this.flags |= 8; this.unknown(0, 1); }
      else if (this.code < 10 && !(this.flags & 64)) this.subject = value;
    } catch (reason) { this.flags |= 8; this.unknown(reason, 1); }
    finally { value = undefined; this.schedule(); }
  }
  reject(reason: unknown): void {
    if (this.flags & (1 | 4)) { reason = undefined; return; }
    this.flags |= 4 | 8;
    try { failedSinkOrigin(this.owner.root, this.origin, reason); }
    catch (failure) { this.unknown(failure, 1); }
    finally { reason = undefined; this.schedule(); }
  }
  private schedule(): void {
    if (this.flags & (1 | 32)) return;
    this.flags |= 32;
    try { ownedBoundaryQueue(this.settleObservation.bind(this)); }
    catch (reason) { this.unknown(reason, 1); }
  }
  private settleObservation(): void {
    this.flags &= ~32;
    if (this.flags & (1 | 16)) return;
    // Installation completes before ACK processing. UNKNOWN preserves physical
    // ownership but must not strand the lane's already funded logical recovery.
    if (this.flags & 2) {
      if (this.code < 5 && this.flags & 4 && !(this.flags & (8 | 1024))) {
        this.flags |= 1024;
        try { this.owner.discardFailedResponse(this.code, this.subject); }
        catch (reason) { this.unknown(reason, 2); }
      }
      if (!(this.flags & 512)) {
        this.flags |= 512;
        try { this.owner.reject(this.code); } catch (reason) { this.unknown(reason, 1); }
      }
      return;
    }
    if (!(this.flags & 4) || this.flags & 512) return;
    this.flags |= 512;
    try {
      if (this.flags & 8) this.owner.reject(this.code);
      else this.owner.accept(this.code, this.subject);
      this.subject = undefined; this.retire();
    } catch (reason) {
      this.unknown(reason, 1);
      try { this.owner.discardFailedResponse(this.code, this.subject); }
      catch (failure) { this.unknown(failure, 2); }
      try { this.owner.reject(this.code); }
      catch (failure) { this.unknown(failure, 1); }
    }
  }
  abandonUnstarted(): void {
    if (this.flags !== 16) throw identityFailure("protocol");
    this.subject = undefined; this.flags = 0; this.retire();
  }
  syncFailure(reason: unknown): void {
    try { this.reject(reason); }
    catch (failure) { this.unknown(failure, 1); }
    finally { reason = undefined; this.flags &= ~16; this.schedule(); }
  }
  retire(): void {
    if (this.flags & 3) return;
    if (!severOwnedOriginal(this.observation)) { this.unknown(undefined, 1); return; }
    this.observation = undefined; this.flags |= 1; this.subject = undefined;
    compactRetiredSinkOrigin(this.owner.root, Math.floor(this.origin / 32));
    compactRetiredSinkOrigin(this.owner.root, Math.floor(this.installationOrigin / 32));
    compactRetiredSinkOrigin(this.owner.root, Math.floor(this.processingOrigin / 32));
    compactRetiredSinkOrigin(this.owner.root, Math.floor(this.dispositionOrigin / 32));
    this.owner.retireOperation(this.code, !!(this.flags & 256));
  }
  unknown(reason: unknown, kind: 0 | 1 | 2 = 0): void {
    this.flags |= 2; this.owner.root.unknown = true;
    const recorded = kind === 2 ? 16384 : kind === 1 ? 8192 : 4096;
    if (this.flags & recorded) { reason = undefined; return; }
    this.flags |= recorded;
    try { failedSinkOrigin(this.owner.root, kind === 2 ? this.dispositionOrigin : kind === 1 ? this.processingOrigin : this.installationOrigin, reason); }
    catch { /* Independent UNKNOWN origins stay owned even if reporting fails. */ }
    finally { reason = undefined; }
  }
}
// Fixed intent/capsule profiles supply V, K, U and W. Two graph occurrences
// and eight wire-byte equivalents cover copy/text/native-call overlap; the
// fixed record allowance remains separate from CONTROL-product counting.
const ownedIntentSerializationData = 4096 + 2 * (8 * (2 * 256 - 1 + 128) + 2 * 8192) + 8 * 16384;
const ownedCapsuleSerializationData = 4096 + 2 * (8 * (2 * 1024 - 1 + 512) + 2 * 32768) + 8 * 65536;
function ownedTerminalBacking(legs: number): number {
  return (legs + 1) * (ownedLedgerAckData + 4096 + 21 * ownedSinkOriginBytes)
    + 2 * legs * ownedIntentSerializationData + 2 * ownedCapsuleSerializationData;
}
function reserveOwnedTerminalBacking(root: RequestOwner, legs: number): void {
  const previous = root.accountingTerminalLegs;
  if (previous !== undefined && legs <= previous) return;
  const next = root.funding.replace(root.funding.bytes + ownedTerminalBacking(legs)
    - (previous === undefined ? 0 : ownedTerminalBacking(previous)));
  if (!next) throw identityFailure("limit");
  root.funding = next; root.accountingTerminalLegs = legs;
  root.sinkCredits += 21 * (legs - (previous ?? -1));
}
class OwnedAccountingTerminal {
  readonly operations: (OwnedTerminalOperation | OwnedLedgerAck | undefined)[] = new Array(15);
  readonly result: Promise<boolean>;
  readonly retired: Promise<void>;
  resolve!: (ok: boolean) => void;
  resolveRetired!: () => void;
  pending = 0;
  physical = 1; // Launch sentinel: synchronous outcomes cannot retire the owner.
  completed = 0;
  launched = 0;
  failures = 0;
  ackCredits = 0;
  phase = 0; // prepared, adopted, launching, failed-before-adoption, retired
  declare sinks: AccountingSinks;
  declare reservation: BudgetReservation;
  declare event: UsageEvent;
  declare custody: ProxyCompletion;
  declare readonly cap: OwnedHttpRequest;
  declare readonly root: RequestOwner;
  declare readonly sink: OwnedHttpSinkOwner;
  constructor(cap: OwnedHttpRequest, root: RequestOwner, sink: OwnedHttpSinkOwner) {
    this.cap = cap; this.root = root; this.sink = sink;
    this.result = new Promise<boolean>(done => { this.resolve = done; });
    this.retired = new Promise<void>(done => { this.resolveRetired = done; });
  }
  failPreparation(): void {
    if (this.phase !== 0) throw identityFailure("protocol");
    this.phase = 3; this.resolve(false);
  }
  abandonPrepared(): void {
    if (this.phase !== 0 && this.phase !== 3) return;
    // No original was launched. The request's actual consumers have joined;
    // unused backing stays in the request charge until its final release.
    this.phase = 4; this.physical = 0; this.operations.length = 0;
    this.resolve(false); this.resolve = undefined as never;
    this.resolveRetired(); this.resolveRetired = undefined as never;
    if (this.root.accountingTerminal === this) this.root.accountingTerminal = undefined;
  }
  operation(code: number, kind: SinkOrigin, subject?: unknown): OwnedTerminalOperation {
    if (this.launched & (1 << code)) throw identityFailure("protocol");
    this.launched |= 1 << code;
    const record = new OwnedTerminalOperation(this, code, sinkOrigin(this.sink, kind), subject);
    this.operations[code] = record; this.physical++;
    return record;
  }
  start(): void {
    const count = (this.reservation.charges ?? this.reservation.reservations).length;
    let index = 0;
    try {
      for (; index < count; index++) this.ledger(index);
      this.queue(4);
    } catch (reason) {
      // No original exists for an unlaunched lane. Its future right ends here;
      // already-started operations still own their physical observations.
      for (; index < count; index++) if (!(this.completed & (1 << index)) && !(this.launched & (1 << index))) this.complete(index, false);
      if (!(this.completed & 16) && !(this.launched & (1 << 14))) this.complete(4, false);
      throw reason;
    } finally { this.physical--; this.finishRetirement(); }
  }
  ledger(index: number): void {
    const charged = !!this.reservation.charges, usage = index === 4;
    const item = usage ? undefined : charged ? this.reservation.charges![index] : this.reservation.reservations[index];
    const request = usage ? this.event : charged
      ? { __proto__: null, ...this.reservation.charges![index].request, amountMicros: this.event.actual_cost_micros }
      : { __proto__: null, reservationId: this.reservation.reservations[index].reservationId, actualCostMicros: this.event.actual_cost_micros };
    const body = usage ? privateCapsuleJson(request) : privateIntentJson(request), path = usage ? "/ingest" : charged ? "/charge" : "/settle";
    const namespace = usage ? this.sinks.usage : this.sinks.budget;
    const name = usage ? usageShardName(this.event.tenant_id, this.event.policy_id) : item!.objectName;
    const acquisition = sinkOrigin(this.sink, "acquire");
    let stub: DurableObjectStub;
    try { stub = namespace.get(namespace.idFromName(name)); }
    catch (reason) {
      failedSinkOrigin(this.root, acquisition, reason); reason = undefined;
      if (usage) this.complete(index, false); else this.queue(index);
      return;
    }
    const operation = this.operation(index, "fetch", body);
    let original: Promise<Response>;
    try { original = stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body }); }
    catch (reason) { operation.syncFailure(reason); return; }
    operation.observe(original); original = undefined as never; stub = undefined as never;
  }
  queue(index: number): void {
    const charged = !!this.reservation.charges;
    const item = index === 4 ? undefined : charged ? this.reservation.charges![index] : this.reservation.reservations[index];
    const message = index === 4 ? this.event : charged
      ? { __proto__: null, kind: "budget_charge", ledger: { __proto__: null, objectName: item!.objectName }, request: { __proto__: null, ...this.reservation.charges![index].request, amountMicros: this.event.actual_cost_micros } }
      : { __proto__: null, kind: "budget_settlement", ledger: { __proto__: null, objectName: item!.objectName }, request: { __proto__: null, reservationId: this.reservation.reservations[index].reservationId, actualCostMicros: this.event.actual_cost_micros } };
    const operation = this.operation(10 + index, "queue");
    try { if (index === 4) copyPrivateQueueCapsule(message, operation); else copyPrivateQueueIntent(message, operation); }
    catch (reason) {
      // Copy/admission failure is not a queue transport failure. End only this
      // unstarted slot, fail its logical lane, and preserve the actual reason.
      try { this.complete(index, false); }
      finally { operation.abandonUnstarted(); }
      throw reason;
    }
    let original: ReturnType<Env["USAGE_QUEUE"]["send"]>;
    try { original = this.sinks.queue.send(operation.subject as QueueMessage); }
    catch (reason) { operation.syncFailure(reason); return; }
    operation.observe(original); original = undefined as never;
  }
  body(index: number, response: Response, cancel: boolean): void {
    if (!cancel) {
      const code = 5 + index;
      if (this.launched & (1 << code)) throw identityFailure("protocol");
      const origin = sinkOrigin(this.sink, "body");
      const reader = new OwnedLedgerAck(this, response, code, origin);
      this.launched |= 1 << code; this.operations[code] = reader; this.physical++;
      response = undefined as never; reader.open(); return;
    }
    const operation = this.operation(5 + index, "cancel", response);
    if (cancel) operation.flags |= 64;
    let original: Promise<unknown>;
    try {
      if (cancel) {
        const body = response.body;
        if (!body) { operation.retire(); return; }
        if (body.locked) { operation.unknown(undefined); return; }
        original = body.cancel();
      } else throw identityFailure("protocol");
    } catch (reason) { operation.syncFailure(reason); return; }
    operation.observe(original); original = undefined as never; response = undefined as never;
  }
  accept(code: number, value: unknown): void {
    if (code < 5) {
      const response = value as Response, index = code;
      if (!response.ok) {
        this.body(index, response, true);
        // The original cleanup above remains live while logical recovery starts.
        if (index === 4) this.complete(index, false); else this.queue(index);
      } else this.body(index, response, false);
    } else if (code < 10) {
      const index = code - 5;
      if (this.operations[code] instanceof OwnedTerminalOperation && this.operations[code].flags & 64) return;
      const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const valid = index === 4 ? item?.eventId === this.event.id && (item.outcome === "stored" || item.outcome === "duplicate" || item.outcome === "expired_by_retention")
        : this.reservation.charges ? item?.charged === true && item.chargeId === this.reservation.charges[index].request.chargeId : item?.settled === true;
      if (valid || index === 4) this.complete(index, !!valid); else this.queue(index);
    } else this.complete(code - 10, true);
  }
  discardFailedResponse(code: number, value: unknown): void {
    if (code >= 5 || this.launched & (1 << (5 + code))) { value = undefined; return; }
    // Only an actual FIRST Response reaches a body-disposition position. An
    // unrelated payload is neither inspected nor adopted as a body owner.
    try { if (value instanceof Response) this.body(code, value, true); }
    finally { value = undefined; }
  }
  reject(code: number): void {
    const index = code < 5 ? code : code < 10 ? code - 5 : code - 10;
    if (this.completed & (1 << index)) return;
    try { if (code < 10) {
      if (code >= 5 && this.operations[code] instanceof OwnedTerminalOperation && this.operations[code].flags & 64) return;
      if (index === 4) this.complete(4, false);
      else if (!(this.launched & (1 << (10 + index)))) this.queue(index);
    } else if (code === 14) {
      if (!(this.launched & 16)) this.ledger(4);
    } else this.complete(index, false);
    } catch (reason) {
      // A failed recovery preparation cannot strand its logical lane. Started
      // operation positions remain owned and cannot be reset or replayed.
      if (!(this.completed & (1 << index))) this.complete(index, false);
      throw reason;
    }
  }
  complete(index: number, ok: boolean): void {
    if (this.completed & (1 << index)) throw identityFailure("protocol");
    this.completed |= 1 << index;
    if (!ok) this.failures |= index === 4 ? 2 : 1;
    if (--this.pending) return;
    if (this.failures) {
      try { this.custody.fail(); } catch { this.root.unknown = true; }
      if (this.failures & 1) {
        try { logCorrelationError("accounting finalization failed", this.event.request_id); } catch { this.root.unknown = true; }
      }
      if (this.failures & 2) {
        try { logCorrelationError("accounting finalization failed", this.event.request_id); } catch { this.root.unknown = true; }
      }
    }
    this.resolve(!this.failures);
    this.phase |= 16; this.scheduleLogicalCut();
  }
  launchReturned(): void { this.phase |= 8; this.scheduleLogicalCut(); }
  private scheduleLogicalCut(): void {
    if ((this.phase & 24) !== 24 || this.phase & (32 | 64) || this.pending) return;
    this.phase |= 32;
    try { ownedBoundaryQueue(this.compactLogical.bind(this)); }
    catch { this.root.unknown = true; }
  }
  private compactLogical(): void {
    this.phase &= ~32;
    if ((this.phase & 24) !== 24 || this.phase & 64 || this.pending) return;
    const ended: Partial<OwnedAccountingTerminal> = this;
    delete ended.event; delete ended.reservation; delete ended.sinks; delete ended.custody;
    this.phase |= 64;
    this.finishRetirement();
  }
  retireAckTail(code: number, tail: OwnedLedgerAck): void {
    if (code < 5 || code >= 10 || this.operations[code] !== tail) throw identityFailure("protocol");
    this.retireOperation(code);
  }
  retireOperation(code: number, ackPayloadRetired = false): void {
    if (!Object.hasOwn(this.operations, code)) throw identityFailure("protocol");
    delete this.operations[code];
    if (code >= 5 && code < 10) { this.ackCredits--; if (!ackPayloadRetired) retireOwnedLedgerAcknowledgmentData(this.root, ownedLedgerAckData); }
    this.physical--; this.finishRetirement();
  }
  finishRetirement(): void {
    if (this.physical || this.pending || this.root.unknown || !(this.phase & 64)) return;
    if (this.ackCredits) { retireOwnedLedgerAcknowledgmentData(this.root, this.ackCredits * ownedLedgerAckData); this.ackCredits = 0; }
    if (this.root.accountingTerminal === this) this.root.accountingTerminal = undefined;
    this.phase = this.phase & ~7 | 4;
    this.operations.length = 0;
    this.resolve = undefined as never; this.resolveRetired(); this.resolveRetired = undefined as never;
  }
}
export function prepareOwnedHttpAccounting(cap: OwnedHttpRequest): void {
  const root = requestOwner(cap);
  if (root.accountingCredits !== undefined) return;
  // Before the initial admission can commit a choice. Preparation and final
  // receivers overlap; at most one terminal can start for this HTTP invocation.
  growOwnedHttpRequest(cap, 2 * 4096 + 8192 + 1024);
  reserveSinkOrigins(root.sink!, 41);
  reserveOwnedTerminalBacking(root, 0);
  root.accountingPreparationOrigin = sinkOrigin(root.sink!, "terminal-prepare");
  root.accountingFallbackOrigin = sinkOrigin(root.sink!, "terminal-fallback");
  root.accountingAdoptionOrigin = sinkOrigin(root.sink!, "terminal-adoption");
  root.accountingCloseOrigin = sinkOrigin(root.sink!, "terminal-close");
  root.accountingInstallationOrigin = sinkOrigin(root.sink!, "terminal-install");
  root.accountingStartOrigin = sinkOrigin(root.sink!, "terminal-start");
  // One shell per request, selected by either the preparation or final command.
  // Its existing finite terminal component precedes every budget obligation.
  claimOwnedSinkFactories();
  root.accountingCredits = 0; // A failed shell constructor cannot be retried.
  root.accountingTerminal = new OwnedAccountingTerminal(cap, root, root.sink!);
  root.accountingCredits = 2;
}
export function prepareOwnedHttpAccountingTerminalPlan(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  plan: unknown, attempt: OwnedHttpUpload): void {
  const root = requestOwner(cap);
  if (root.sealed || root.unknown || root.accountingTerminalClaimed || root.accountingTerminalLegs === undefined || root.budgetSequence
    || !matchesOwnedHttpAccountingCommand(cap, accounting) || !matchesOwnedHttpBudgetPlan(cap, accounting, plan, attempt))
    throw identityFailure("protocol");
  const admitted = plan as BudgetReservationPlan & BudgetReservation | undefined;
  const legs = (admitted?.legs ?? admitted?.charges ?? admitted?.reservations)?.length ?? 0;
  if (!Number.isInteger(legs) || legs < 0 || legs > 4) throw identityFailure("protocol");
  reserveOwnedTerminalBacking(root, legs);
  if (!admitted?.legs) return; // Soft charges use the separate final terminal.
  const rollback = Math.max(0, legs - 1);
  const ledger = ownedIntentSerializationData + ownedLedgerAckData + 4096 + 18 * ownedSinkOriginBytes;
  const queue = ownedIntentSerializationData + ownedSinkOriginBytes;
  let units = "roothttpaccountingplanattemptlegsphasephysicalresultsinks".length + "budgetusagequeueownedHttp".length;
  for (const leg of admitted.legs) units += "sequenceordinalintentnameidcapflagsreservationrequestnamespace".length
    + leg.objectName.length + leg.request.reservationId.length;
  // Ten sequence fields/array plus the later four-field sinks carrier; ten fields per leg, opaque cap, vector and map
  // cells. The added synchronous construction operands have a separate debit.
  const metadata = 8 * (26 + 9 + 64 + 32 * legs) + 2 * units;
  const funding = root.funding.replace(root.funding.bytes + legs * ledger
    + Math.max(legs * ledger, rollback * (ledger + queue)) + metadata);
  if (!funding) throw identityFailure("limit");
  root.funding = funding;
  root.sinkCredits += 18 * legs + Math.max(18 * legs, 19 * rollback);
  claimOwnedSinkFactories();
  const sequence = new OwnedBudgetSequence(root, cap, accounting, admitted, attempt);
  enrollOwnedSinkChild(root); root.budgetSequence = sequence;
  try { sequence.prepare(); }
  catch (reason) { sequence.close(); throw reason; } // No original has started.
}
export function claimOwnedHttpAccountingFactory(cap: OwnedHttpRequest): void {
  const root = requestOwner(cap);
  if (!root.accountingCredits) throw identityFailure("protocol");
  root.accountingCredits--;
}
export function checkOwnedHttpAccountingRetirement(cap: OwnedHttpRequest): void {
  const root = requestOwner(cap);
  if (!root.retiringConsumers || root.unknown) throw identityFailure("protocol");
}
function recordOwnedTerminalFailure(root: RequestOwner, custody: ProxyCompletion, origin: SinkOriginOwner, reason: unknown): void {
  // Each source has its own prepaid origin, including equal/undefined failures.
  // Failure reporting cannot prevent a later required launch step.
  try { custody.fail(); } catch { root.unknown = true; }
  try { failedSinkOrigin(root, origin, reason); } catch { root.unknown = true; }
  finally { reason = undefined; }
}
export function recordOwnedHttpAccountingPreparationFailure(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, reason: unknown): void {
  const root = requestOwner(cap);
  if (root.accountingTerminalClaimed || root.accountingPreparationOrigin === undefined || !matchesOwnedHttpAccountingCommand(cap, accounting))
    throw identityFailure("protocol");
  recordOwnedTerminalFailure(root, root.completion, root.accountingPreparationOrigin, reason); reason = undefined;
}
export function recordOwnedHttpAccountingFallbackFailure(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, reason: unknown): void {
  const root = requestOwner(cap);
  if (root.accountingTerminalClaimed || root.accountingFallbackOrigin === undefined || !matchesOwnedHttpAccountingCommand(cap, accounting))
    throw identityFailure("protocol");
  recordOwnedTerminalFailure(root, root.completion, root.accountingFallbackOrigin, reason); reason = undefined;
}
export function recordOwnedHttpAccountingAdoptionFailure(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, reason: unknown): void {
  const root = requestOwner(cap);
  if (root.accountingTerminalClaimed || root.accountingAdoptionOrigin === undefined || !matchesOwnedHttpAccountingCommand(cap, accounting))
    throw identityFailure("protocol");
  recordOwnedTerminalFailure(root, root.completion, root.accountingAdoptionOrigin, reason); reason = undefined;
}
export function failOwnedHttpAccountingTerminal(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  custody: ProxyCompletion): Promise<boolean> {
  const root = requestOwner(cap), terminal = root.accountingTerminal;
  if (root.accountingTerminalClaimed || !terminal || terminal.phase !== 0 || !matchesOwnedHttpAccountingFailure(cap, accounting, custody))
    throw identityFailure("protocol");
  rejectOwnedHttpAccountingTerminal(cap, accounting);
  terminal.failPreparation();
  try { custody.fail(); } catch { root.unknown = true; }
  // The original evidence stays in the accounting/handoff slots through real
  // request retirement. This result is false, not adoption or consumption.
  return terminal.result;
}
export function startOwnedHttpAccountingTerminal(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, sinks: AccountingSinks,
  reservation: BudgetReservation, event: UsageEvent, custody: ProxyCompletion): Promise<boolean> {
  const root = requestOwner(cap), sink = root.sink!, terminal = root.accountingTerminal;
  if (root.accountingTerminalClaimed || root.accountingTerminalLegs === undefined
    || !terminal || terminal.phase !== 0 || terminal.root !== root || terminal.cap !== cap || terminal.sink !== sink
    || !matchesOwnedHttpAccountingAdoption(cap, accounting, sinks, custody, event, reservation) || sinks.ownedHttp !== sink)
    throw identityFailure("protocol");
  const legs = (reservation.charges ?? reservation.reservations).length;
  if (legs > root.accountingTerminalLegs || legs > 4) throw identityFailure("protocol");
  // The exact factory-captured sinks are registry-proven. No Env reread or
  // factory/callback lies between full validation and this internal commit.
  terminal.sinks = sinks; terminal.reservation = reservation; terminal.event = event; terminal.custody = custody;
  terminal.pending = legs + 1; terminal.ackCredits = legs + 1; terminal.phase = 1;
  root.accountingTerminalClaimed = true;
  adoptOwnedHttpAccountingTerminal(cap, accounting, event, reservation);
  // These steps are deliberately outside adoption. Each must run even if a
  // preceding close/registration/diagnostic fails; none creates a replacement.
  try { root.budgetSequence?.close(); }
  catch (reason) {
    root.unknown = true; recordOwnedTerminalFailure(root, custody, root.accountingCloseOrigin!, reason); reason = undefined;
  }
  try { custody.startPrivateLeaf(() => terminal.retired); }
  catch (reason) {
    root.unknown = true; recordOwnedTerminalFailure(root, custody, root.accountingInstallationOrigin!, reason); reason = undefined;
  }
  terminal.phase = 2; // Irreversible LAUNCHING precedes even namespace acquisition.
  try { terminal.start(); }
  catch (reason) {
    terminal.failures |= 4;
    recordOwnedTerminalFailure(root, custody, root.accountingStartOrigin!, reason); reason = undefined;
  }
  terminal.launchReturned();
  return terminal.result;
}

function requestOwner(cap: OwnedHttpRequest): RequestOwner {
  const owner = requests?.get(cap);
  if (!owner) throw identityFailure("protocol");
  return owner;
}
function uploadOwner(cap: OwnedHttpUpload): UploadOwner {
  const owner = uploads?.get(cap);
  if (!owner) throw identityFailure("protocol");
  return owner;
}

// The entry activation and platform-facing async promise precede admission.
// A refused first reservation must not allocate an application error response.
export const ownedHttpPlatformFailure = "private HTTP request could not be admitted";
// One fixed unknown-error render is prepaid before entry effects. Dynamic error
// strings consume this credit plus an admitted increment; credit is never reused.
const terminalErrorBytes = 8192 + 14 * (6 * 35 + 128) + 8 * 35;
const bootstrapPromise = Promise;
const bootstrapWeakMap = WeakMap;
const bootstrapWeakSet = WeakSet;
const bootstrapMap = Map;
const bootstrapFreeze = Object.freeze;
const bootstrapProperty = Object.defineProperty;
const bootstrapDescriptor = Object.getOwnPropertyDescriptor;
const bootstrapMapSet = WeakMap.prototype.set;
const bootstrapMapGet = WeakMap.prototype.get;
const bootstrapSetAdd = WeakSet.prototype.add;
const bootstrapSetHas = WeakSet.prototype.has;
const bootstrapApply = Reflect.apply;
function createOwnedHttpRequest(request: Request, env: Env, funding: ExactBodyCharge): OwnedHttpRequest | undefined {
  let registry: ExactBodyCharge | undefined;
  try {
    if (!requests) {
      registry = ExactBodyCharge.reserve(1024) ?? undefined;
      if (!registry) return undefined;
    }
    // The immutable ordinary completion class uses this native constructor.
    // Check without invoking a substituted global getter before its initializer.
    if (bootstrapDescriptor(globalThis, "Promise")?.value !== bootstrapPromise) return undefined;
    const nextRequests = requests ?? new bootstrapWeakMap<OwnedHttpRequest, RequestOwner>();
    const nextUploads = uploads ?? new bootstrapWeakMap<OwnedHttpUpload, UploadOwner>();
    const nextSinks = sinkOwners ?? new bootstrapWeakMap<OwnedHttpSinkOwner, RequestOwner>();
    const nextFailures = sinkFailures ?? new bootstrapWeakSet<object>();
    const terminalRegistration = 13; // sinkKinds' existing registration kind index.
    const sink = bootstrapFreeze({});
    let resolveSink!: () => void;
    const sinkRetired = new bootstrapPromise<void>(resolve => { resolveSink = resolve; });
    const owner: RequestOwner = { request, env, funding, completion: new ProxyCompletion(), uploads: [],
      sealed: false, unknown: false, sink, sinkPending: 0, sinkClosed: false, sinkRetired, resolveSink, sinkOrigins: new bootstrapMap(), nextSinkOrigin: 1, sinkCredits: 2, revalidationCredits: 0,
      terminalRegistration, budgetDenials: new bootstrapWeakSet(), publicCaptureLiveBytes: 0, publicCaptureHighWater: 0, errorState: 0, terminalErrorCredit: terminalErrorBytes };
    const cap = bootstrapFreeze({});
    bootstrapApply(bootstrapMapSet, nextSinks, [sink, owner]);
    bootstrapApply(bootstrapMapSet, nextRequests, [cap, owner]);
    // All factories have completed. Publish only the complete association.
    requests = nextRequests; uploads = nextUploads; sinkOwners = nextSinks; sinkFailures = nextFailures;
    if (registry) { registryFunding = registry; registry = undefined; }
    requestCount++;
    return cap;
  } finally { registry?.release(); }
}
export function tryBeginOwnedHttpRequest(request: Request, env: Env): OwnedHttpRequest | undefined {
  let funding: ExactBodyCharge | null;
  try { funding = ExactBodyCharge.reserve(requestMetadataBytes); }
  catch { return undefined; }
  if (!funding) return undefined;
  let transferred = false;
  try {
    const terminal = funding.replace(requestMetadataBytes + terminalErrorBytes + 3 * ownedOriginalCellBytes);
    if (!terminal) return undefined;
    funding = terminal;
    const cap = createOwnedHttpRequest(request, env, funding);
    transferred = cap !== undefined;
    return cap;
  } catch { return undefined; }
  finally {
    if (!transferred) {
      try { funding.release(); }
      catch { /* Unknown bootstrap disposal keeps the existing COMMON debit. */ }
    }
  }
}

export function beginOwnedHttpRequest(request: Request, env: Env): OwnedHttpRequest {
  const cap = tryBeginOwnedHttpRequest(request, env);
  if (!cap) throw identityFailure("limit");
  return cap;
}

export function admitOwnedHttpConfigurationCommand(cap: OwnedHttpRequest, preparation: PreparationAdmission, providerPermit?: object): void {
  const owner = requestOwner(cap);
  if (owner.sealed || owner.unknown || !(providerPermit === undefined ? matchesOwnedHttpConfigurationPreparation(cap, preparation)
    : matchesOwnedHttpProviderConfiguration(cap, providerPermit, preparation))) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, 4096); claimOwnedSinkFactories();
}
export function checkOwnedHttpInitialSelection(cap: OwnedHttpRequest, request: Request, env: Env,
  body: Record<string, unknown>, preparation: PreparationAdmission): void {
  checkOwnedHttpRequest(cap, request, env);
  if (!matchesOwnedHttpInitialSelection(cap, body, preparation)) throw identityFailure("protocol");
}
export function admitOwnedHttpErrorText(cap: OwnedHttpRequest, units: number): void {
  if (!(units >= 0) || units > 9007199254740991 || units % 1) return failOwnedHttpError(cap);
  beginOwnedHttpError(cap, 4096 + 8 * units);
  const owner = requestOwner(cap);
  if (owner.errorState !== 1) return failOwnedHttpError(cap);
  owner.errorState = 0;
}

/** Closed primitive error construction. No caller callback or external detail. */
export function beginOwnedHttpError(cap: OwnedHttpRequest, bytes: number): void {
  const owner = requests && bootstrapApply(bootstrapMapGet, requests, [cap]) as RequestOwner | undefined;
  if (!owner || owner.sealed || owner.errorState || !(bytes > 0) || bytes > 9007199254740991 || bytes % 1) throw ownedHttpPlatformFailure;
  owner.errorState = 1;
  try {
    const credit = owner.terminalErrorCredit;
    if (bytes > credit) {
      const next = owner.funding.replace(owner.funding.bytes + bytes - credit);
      if (!next) throw ownedHttpPlatformFailure;
      owner.funding = next;
    }
    if (!claimOwnedHttpStaticCustody() || owner.errorState !== 1) throw ownedHttpPlatformFailure;
    owner.terminalErrorCredit = bytes < credit ? credit - bytes : 0;
  } catch { owner.errorState = 2; throw ownedHttpPlatformFailure; }
}
export function failOwnedHttpError(cap: OwnedHttpRequest): never {
  const owner = requests && bootstrapApply(bootstrapMapGet, requests, [cap]) as RequestOwner | undefined;
  if (owner) owner.errorState = 2;
  throw ownedHttpPlatformFailure;
}
export function finishOwnedHttpError(cap: OwnedHttpRequest, response: Response): void {
  const owner = requests && bootstrapApply(bootstrapMapGet, requests, [cap]) as RequestOwner | undefined;
  if (!owner || owner.errorState !== 1) throw ownedHttpPlatformFailure;
  // All initial response brands remain accounted through the root's actual join.
  const responses = owner.localErrorResponses ??= [];
  bootstrapProperty(responses, responses.length, { __proto__: null, value: response, writable: true, configurable: true, enumerable: true } as PropertyDescriptor);
  owner.errorState = 0;
}
// Superseded initial errors still own their actual bodies. The source response
// stays in localErrorResponses until the encompassing physical join; this set
// is only an accepted-once disposition marker, never a retirement proof.
export function discardOwnedHttpInitialError(cap: OwnedHttpRequest, response: Response): void {
  const owner = requestOwner(cap);
  if (owner.sealed || !owner.localErrorResponses?.includes(response)) throw identityFailure("protocol");
  if (owner.localErrorDisposals && bootstrapApply(bootstrapSetHas, owner.localErrorDisposals, [response])) return;
  growOwnedHttpRequest(cap, 4096); reserveSinkOrigins(owner.sink!, 1);
  bootstrapApply(bootstrapSetAdd, owner.localErrorDisposals ??= new bootstrapWeakSet(), [response]);
  try { discardOwnedHttpSinkResponse(owner.sink!, response); }
  catch (reason) { owner.unknown = true; throw reason; }
}
export function finishOwnedHttpFailure(cap: OwnedHttpRequest, failure: OwnedHttpLocalFailure): void {
  const owner = requests && bootstrapApply(bootstrapMapGet, requests, [cap]) as RequestOwner | undefined;
  if (!owner || owner.errorState !== 1) throw ownedHttpPlatformFailure;
  bootstrapApply(bootstrapSetAdd, owner.localFailures ??= new bootstrapWeakSet(), [failure]);
  owner.errorState = 0;
}
export function isOwnedHttpLocalFailure(cap: OwnedHttpRequest, failure: unknown): failure is OwnedHttpLocalFailure {
  const owner = requests && bootstrapApply(bootstrapMapGet, requests, [cap]) as RequestOwner | undefined;
  if (!owner || owner.errorState === 2) throw ownedHttpPlatformFailure;
  return !!owner.localFailures && failure !== null && (typeof failure === "object" || typeof failure === "function")
    && bootstrapApply(bootstrapSetHas, owner.localFailures, [failure]);
}

export function checkOwnedHttpRequest(cap: OwnedHttpRequest, request: Request, env: Env): void {
  const owner = requestOwner(cap);
  if (owner.sealed || owner.request !== request || owner.env !== env) throw identityFailure("protocol");
}
// A completed preparation may reduce its foreground ticket only while its
// already-registered HTTP owner still permits forward work. No new signal or
// resource is created here; the preparation path already installed this signal.
export function canCompleteOwnedHttpPreparation(cap: OwnedHttpRequest, request?: Request): boolean {
  const owner = requests?.get(cap);
  return !!owner && !owner.sealed && !owner.unknown && !owner.retirement
    && owner.request !== undefined && (request === undefined || owner.request === request)
    && !!owner.abortController && !owner.abortController.signal.aborted;
}
export function matchesOwnedHttpRequestInputs(cap: OwnedHttpRequest, env: Env, request?: Request): boolean {
  const owner = requests?.get(cap);
  return !!owner && owner.env === env && (request === undefined || owner.request === request);
}

// Complete simultaneous application payload, not an incremental credit and
// not a replacement for a generation's separately funded admission ticket.
export function fundOwnedHttpRequest(cap: OwnedHttpRequest, bytes: number): void {
  const owner = requestOwner(cap);
  if (owner.sealed || owner.unknown || !Number.isSafeInteger(bytes) || bytes < owner.funding.bytes) throw identityFailure("protocol");
  if (bytes === owner.funding.bytes) return;
  const replacement = owner.funding.replace(bytes);
  if (!replacement) throw identityFailure("limit");
  owner.funding = replacement;
}

export function growOwnedHttpRequest(cap: OwnedHttpRequest, bytes: number): void {
  const owner = requestOwner(cap);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw identityFailure("protocol");
  fundOwnedHttpRequest(cap, owner.funding.bytes + bytes);
}

// Register fixed operation origins before acquiring/starting an original. Read,
// FIRSTcancel and unlock are separate origins even when they reject with the
// same value or undefined. A second observation of one origin adds no error.
export function beginOwnedHttpIntakeDiagnostics(cap: OwnedHttpRequest): OwnedHttpIntakeDiagnostics {
  growOwnedHttpRequest(cap, 1024); reserveSinkOrigins(ownedHttpSinkOwner(cap), 11);
  const owner = requestOwner(cap), sink = ownedHttpSinkOwner(cap);
  // The first private intake now claims the same permanent module slice, even
  // when later authentication or parsing denies it. Refusal creates no receipt.
  claimOwnedSinkFactories();
  const acquire = sinkOrigin(sink, "acquire"), read = sinkOrigin(sink, "read");
  const cancel = sinkOrigin(sink, "cancel"), unlock = sinkOrigin(sink, "unlock");
  const closed = sinkOrigin(sink, "closed"), listenerAdd = sinkOrigin(sink, "abort"), listenerRemove = sinkOrigin(sink, "abort");
  const readObserver = sinkOrigin(sink, "retire"), closedObserver = sinkOrigin(sink, "retire");
  const cancelObserver = sinkOrigin(sink, "retire"), unlockObserver = sinkOrigin(sink, "retire");
  const receipt = Object.freeze({});
  (intakes ??= new WeakMap()).set(receipt, { owner, acquire, read, cancel, unlock, closed, listenerAdd, listenerRemove,
    readObserver, closedObserver, cancelObserver, unlockObserver });
  return receipt;
}
export function ownedHttpIntakeFailure(cap: OwnedHttpIntakeDiagnostics, phase: IntakePhase, reason: unknown): object {
  const receipt = intakes?.get(cap), origin = receipt?.[phase];
  if (!receipt || origin === undefined) throw identityFailure("protocol");
  const ordinal = Math.floor(origin / 32), known = receipt.owner.sinkOrigins!.has(ordinal);
  const record = failedSinkOrigin(receipt.owner, origin, reason);
  if (!known) retainOwnedDiagnostic(receipt.owner, record);
  return record;
}
export function finishOwnedHttpIntakeDiagnostics(cap: OwnedHttpIntakeDiagnostics): void {
  if (!intakes?.has(cap)) throw identityFailure("protocol");
  // Called only after actual read/FIRSTcancel/unlock/closed/listener joins.
  // Failed records remain rooted independently; no successful origin history.
  intakes.delete(cap);
}
function retainOwnedDiagnostic(owner: RequestOwner, record: SinkOriginRecord): void {
  const roots = owner.codecOrigins ??= [];
  let index = roots.length;
  while (index && roots[index - 1].ordinal > record.ordinal) { roots[index] = roots[index - 1]; index--; }
  roots[index] = record;
}

// Fixed public-Response consumer. No identity or prepared payload escapes.
// The generic InputRetirement contract is unchanged; observe its ORIGINAL
// operations here so its intentionally suppressed cancel error is not lost.
export function ownOwnedHttpResponse(cap: OwnedHttpRequest, response: Response): Response {
  return ownHttpResponse(cap, response, false);
}
export function ownOwnedHttpPublicResponse(cap: OwnedHttpRequest, response: Response): Response {
  return ownHttpResponse(cap, response, true);
}
export function hasOwnedHttpResponseRetirement(cap: OwnedHttpRequest, response: Response): boolean {
  const owner = requestOwner(cap);
  if ((owner.publicReaders?.get(response) ?? 0) > 0 || owner.metadata?.discarded === response) return true;
  return owner.metadata?.response === response && !!owner.publicOutputs?.get(captureOwnedResponseMetadata(response).body!);
}
export function retireOwnedHttpAssociatedResponse(cap: OwnedHttpRequest, response: Response): boolean {
  const owner = requestOwner(cap);
  if (!hasOwnedHttpResponseRetirement(cap, response)) return false;
  const reader = owner.publicOutputs?.get(captureOwnedResponseMetadata(response).body!);
  if (reader) void reader.retire(true);
  // Constructor failure already started its own reader's retirement; a prior
  // local-error disposition likewise owns the original cancellation separately.
  return true;
}
const originalReaderClosed = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "closed")?.get;
const originalLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
class OwnedPublicReader extends OwnedReaderDriver {
  private output?: ReadableStream<Uint8Array>;
  private metadataOutput?: Response;
  publishMetadataOutput(response: Response): void { this.metadataOutput = response; }
  publishOutput(output: ReadableStream<Uint8Array>): void { this.output = output; this.owner.publicOutputs!.set(output, this); }
  private captureLiveBytes = 0;
  private handedOff = false;
  declare private cap: OwnedHttpRequest;
  declare private owner: RequestOwner;
  declare private original: Response | undefined;
  declare private base: number;
  declare private publicBoundary: boolean;
  constructor(cap: OwnedHttpRequest, owner: RequestOwner,
    original: Response | undefined, body: ReadableStream<Uint8Array> | undefined,
    base: number, publicBoundary: boolean) { super();
    this.cap = cap; this.owner = owner; this.original = original; this.base = base; this.publicBoundary = publicBoundary; this.body = body; }
  private failure(offset: number, kind: SinkOrigin, reason: unknown): SinkOriginRecord {
    const ordinal = this.base + offset, known = this.owner.sinkOrigins!.has(ordinal);
    const failure = failedSinkOrigin(this.owner, 32 * ordinal + sinkKinds.indexOf(kind), reason);
    if (!known) retainOwnedDiagnostic(this.owner, failure);
    return failure;
  }
  protected holdDriver(): void { holdOwnedHttpRequest(this.cap); }
  protected driverProtocolFailure(): Error { return identityFailure("protocol"); }
  protected recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object {
    return this.failure(kind === "read" ? 1 : kind === "cancel" ? 2 : kind === "unlock" ? 3 : kind === "closed" ? 4 : kind === "pull" ? 5 : 7, kind, reason);
  }
  protected driverCleanupFailure(kind: "closed" | "cancel" | "unlock", _failure: object): void { if (kind !== "closed") this.owner.completion.fail(); }
  protected driverPullFailure(_failure: object): void { this.owner.completion.fail(); void this.retire(true); }
  protected propagatedDriverFailure(reason: unknown): boolean {
    const forwarded = this.publicBoundary && matchesOwnedHttpPublicBody(this.cap, this.body ?? null);
    if (!this.publicBoundary || forwarded) for (const codec of this.owner.revalidations ?? []) {
      if (forwarded && matchesOwnedCodecOutputFailure(codec, this.body ?? null, reason)) return true;
      if (matchesOwnedVeniceOutputBody(codec, this.body ?? null) && matchesOwnedVeniceOutputFailure(codec, reason)) return true;
    }
    return false;
  }
  protected captureDriverValue(value: ReadableStreamReadResult<Uint8Array>): void {
    // Public role deliberately observes done BEFORE value, each exactly once.
    this.readDone = !!value.done;
    let bytes = value.value;
    if (this.readDone) { bytes = undefined; this.captured = undefined; return; }
    const proof = inspectOwnedBytes(bytes);
    // Only this enrolled live reader can grow its existing request charge after
    // sealing. No new child or general-purpose funding authority is created.
    if (requestOwner(this.cap) !== this.owner || !this.body || !this.original || this.driverDone || !this.driverCapturing)
      throw identityFailure("protocol");
    const component = proof.backing + proof.length;
    const live = this.owner.publicCaptureLiveBytes - this.captureLiveBytes + component;
    const high = live > this.owner.publicCaptureHighWater ? live : this.owner.publicCaptureHighWater;
    if (!Number.isSafeInteger(live) || live < component || !Number.isSafeInteger(high)) throw identityFailure("limit");
    if (high > this.owner.publicCaptureHighWater) {
      const replacement = this.owner.funding.replace(this.owner.funding.bytes + high - this.owner.publicCaptureHighWater);
      if (!replacement) throw identityFailure("limit");
      this.owner.funding = replacement;
    }
    this.owner.publicCaptureLiveBytes = live; this.owner.publicCaptureHighWater = high;
    this.captureLiveBytes = component; this.handedOff = false;
    const copy = newOwnedBytes(proof.length); copyOwnedBytes(copy, bytes!);
    if (this.publicBoundary) acceptFundedGenericUsageOutput(this.owner, this.body, bytes!); bytes = undefined;
    this.captured = copy;
  }
  private clearCapture(): void {
    this.owner.publicCaptureLiveBytes -= this.captureLiveBytes; this.captureLiveBytes = 0; this.handedOff = false;
  }
  protected driverPullRetired(): void {
    if (this.handedOff && !this.captured && !this.driverCapturing && !(this.driverFlags & 32)) this.clearCapture();
  }
  protected driverCleared(): void {
    if (this.original) {
      const count = this.owner.publicReaders?.get(this.original);
      if (!count) throw identityFailure("protocol");
      if (count === 1) this.owner.publicReaders!.delete(this.original);
      else this.owner.publicReaders!.set(this.original, count - 1);
    }
    if (this.output && this.owner.publicOutputs?.get(this.output) === this) this.owner.publicOutputs.delete(this.output);
    this.output = undefined;
    if (this.metadataOutput) clearOwnedLocalError(this.metadataOutput);
    this.metadataOutput = undefined;
    this.original = undefined; this.clearCapture();
  }
  open(): void {
    if (!this.original || !this.body) throw identityFailure("protocol");
    try { this.reader = this.body!.getReader(); }
    catch (reason) { throw this.failure(0, "acquire", reason); }
    const reader = this.reader;
    this.observeDriverClosed(Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
      && typeof originalLookupGetter === "function" && originalLookupGetter.call(reader, "closed") === originalReaderClosed);
  }
  retire(cancel: boolean): Promise<void> { return this.stopDriver(cancel); }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.beginDriverPull();
    return this.ownDriverPull(this.next(controller));
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let reading = true;
    try {
      await this.startDriverRead(); reading = false;
      if (this.driverFlags & 1) { this.captured = undefined; return; }
      if (this.readDone) { this.captured = undefined; controller.close(); void this.retire(false); }
      else { enqueueOwnedBytes(controller, this.captured!); this.captured = undefined; this.handedOff = true; }
    } catch (reason) {
      const failure = reading ? reason : this.failure(5, "pull", reason); reason = undefined;
      if (!(this.driverFlags & 1)) {
        try { controller.error(failure); } catch (error) { this.failure(6, "pull", error); }
        void this.retire(true);
      }
    }
  }
  cancel(): void { void this.retire(true); }
}

function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response {
  const owner = requestOwner(cap);
  if (owner.sealed) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, 8192); reserveSinkOrigins(ownedHttpSinkOwner(cap), 9);
  const base = owner.nextSinkOrigin; owner.nextSinkOrigin += 9; owner.sinkCredits -= 9;
  let headerBytes = 0;
  let body: ReadableStream<Uint8Array>;
  try {
    const actual = response.body;
    if (!actual) return response;
    body = actual;
  } catch (reason) {
    const failure = failedSinkOrigin(owner, 32 * base + sinkKinds.indexOf("acquire"), reason);
    retainOwnedDiagnostic(owner, failure); throw failure;
  }
  // Genuine capacity refusal stays outside metadata-origin normalization.
  claimOwnedSinkFactories();
  try { headerBytes = measureOwnedHeaders(response.headers); }
  catch (reason) {
    const failure = failedSinkOrigin(owner, 32 * base + sinkKinds.indexOf("acquire"), reason);
    retainOwnedDiagnostic(owner, failure); throw failure;
  }
  if (headerBytes) growOwnedHttpRequest(cap, headerBytes);
  let reader: OwnedPublicReader | undefined;
  let enrolled = false;
  try {
    owner.publicReaders ??= new WeakMap(); owner.publicOutputs ??= new WeakMap();
    reader = new OwnedPublicReader(cap, owner, response, body, base, publicBoundary);
    owner.completion.startPrivateLeaf(() => reader!.retired); enrolled = true;
    owner.publicReaders.set(response, (owner.publicReaders.get(response) ?? 0) + 1);
    reader.open();
    const stream = new ReadableStream<Uint8Array>(reader, { highWaterMark: 0 });
    reader.publishOutput(stream);
    // Retain the original late getter order. Measure the exact second Headers
    // operand after status/statusText getters have had their existing effects.
    const status = response.status, statusText = response.statusText, headers = response.headers;
    if (typeof status !== "number" || typeof statusText !== "string") throw identityFailure("protocol");
    const component = measureOwnedHeaders(headers) + 4 * statusText.length;
    if (component > 9007199254740991) throw identityFailure("limit");
    if (component > headerBytes) {
      growOwnedHttpRequest(cap, component - headerBytes);
      // The unchanged allocator has its own scalar helper lookup. No such call
      // remains after this final native measurement of the SAME actual operand.
      // Mutation during funding cannot create an unfunded constructor operand.
      if (measureOwnedHeaders(headers) + 4 * statusText.length > component) throw identityFailure("protocol");
    }
    const copy = inheritOwnedLocalError(response, newOwnedResponse(stream, status, statusText, headers));
    reader.publishMetadataOutput(copy);
    return copy;
  } catch (reason) {
    owner.completion.fail();
    if (reader && enrolled) void reader.retire(true);
    throw reason;
  } finally { response = undefined as never; }
}

// Separate from terminal accounting: all four status readers can still be live
// after the delivery grace and while recovery/settlement originals are pending.
const ownedStatusNativeRead = ReadableStreamBYOBReader.prototype.read;
const ownedStatusNativeCancel = ReadableStreamBYOBReader.prototype.cancel;
const ownedStatusNativeClosed = Object.getOwnPropertyDescriptor(ReadableStreamBYOBReader.prototype, "closed")?.get;
const ownedStatusGraph = 8 * (32 + 2 * 64 + 64 + 128) + 2 * 4096;
const ownedStatusData = 3 * 16384 + 6 * 16384 + ownedStatusGraph + 2 * 4096 + 8192;
export class OwnedStatusReader {
  private response?: Response;
  private body?: ReadableStream<Uint8Array>;
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private bits = 0;
  private get flags(): number { return this.bits & 65535; }
  private set flags(value: number) { this.bits = this.bits & ~65535 | value & 65535; }
  private get pending(): number { return this.bits >>> 16 & 15; }
  private set pending(value: number) { this.bits = this.bits & ~(15 << 16) | (value & 15) << 16; }
  private get phase(): number { return this.bits >>> 20 & 7; }
  private set phase(value: number) { this.bits = this.bits & ~(7 << 20) | (value & 7) << 20; }
  private get done(): boolean { return !!(this.bits & 1 << 23); }
  private set done(value: boolean) { this.bits = value ? this.bits | 1 << 23 : this.bits & ~(1 << 23); }
  private nativeFailure?: object;
  private acquisition?: SinkOriginOwner;
  private fetching?: SinkOriginOwner;
  private base?: number;
  private advanceWork = this.advance.bind(this);
  private decoder?: TextDecoder;
  private text = "";
  private backing?: Uint8Array<ArrayBuffer>;
  private value?: Uint8Array;
  private wire = 0;
  private reads = 0;
  private readObservation?: OwnedHttpReadObservation;
  private fetchObservation?: OwnedOriginalObservation;
  private closedObservation?: OwnedOriginalObservation;
  private cancelObservation?: OwnedOriginalObservation;
  private unlockObservation?: OwnedOriginalObservation;
  private spent: number | null = null;
  declare private owner: OwnedStatusController;
  declare private index: number;
  constructor(owner: OwnedStatusController, index: number) {
    this.owner = owner; this.index = index;
  }
  dispatchOriginal(cell: OwnedOriginalObservation, failed: boolean, value: unknown): void {
    if (this.phase === 6) { value = undefined; return; }
    try {
      if (cell === this.fetchObservation) { if (failed) this.fetchRejected(value); else this.fetchResolved(value as Response); }
      else if (cell === this.closedObservation) { if (failed) this.closedRejected(value); else this.closedResolved(); }
      else if (cell === this.cancelObservation) { if (failed) this.cancelRejected(value); else this.cancelResolved(); }
      else if (cell === this.unlockObservation) { if (failed) this.unlockRejected(value); else this.unlockResolved(); }
    } finally { value = undefined; }
  }
  start(): void {
    if (this.phase) throw identityFailure("protocol");
    this.phase = 1;
    this.pending |= 1;
    this.acquire();
  }
  private schedule(): void {
    if (this.flags & 8192) return;
    this.flags |= 8192;
    try { ownedBoundaryQueue(this.advanceWork); }
    catch (reason) { this.unsettled(reason); }
  }
  private unknown(): void {
    this.flags |= 256;
    try { holdOwnedHttpRequest(this.owner.http); } catch { /* The reader's physical receipt remains held. */ }
  }
  private retired(): void {
    try {
      if (this.reader || this.body || this.response || this.pending)
        throw identityFailure("protocol");
      const root = requestOwner(this.owner.http);
      if (this.acquisition !== undefined) compactRetiredSinkOrigin(root, Math.floor(this.acquisition / 32));
      if (this.fetching !== undefined) compactRetiredSinkOrigin(root, Math.floor(this.fetching / 32));
      if (this.base !== undefined) for (let index = 0; index < 9; index++) compactRetiredSinkOrigin(root, this.base + index);
      this.owner.retire(this.index, this); this.owner = undefined as never;
    } catch (reason) { this.unsettled(reason); }
  }
  private unsettled(reason: unknown): void {
    this.unknown();
    try { this.failure(10, "retire", reason); }
    catch { /* A recording failure cannot escape an ignored observer return. */ }
    finally { reason = undefined; }
  }
  private claimReader(): number {
    if (this.base !== undefined) return this.base;
    const root = requestOwner(this.owner.http);
    if (root.sinkCredits < 9) throw identityFailure("protocol");
    this.base = root.nextSinkOrigin; root.nextSinkOrigin += 9; root.sinkCredits -= 9;
    return this.base;
  }
  failure(offset: number, kind: SinkOrigin, reason: unknown): SinkOriginRecord {
    const origin = offset === 0 ? this.acquisition! : offset === 1 ? this.fetching!
      : 32 * (this.claimReader() + offset - 2) + sinkKinds.indexOf(kind);
    return failedSinkOrigin(requestOwner(this.owner.http), origin, reason);
  }
  private acquire(): void {
    const descriptor = this.owner.prepared.descriptors[this.index], namespace = this.owner.namespace;
    this.acquisition = sinkOrigin(requestOwner(this.owner.http).sink!, "acquire");
    let stub: DurableObjectStub;
    try { if (!namespace) throw softStatusError(); stub = namespace.get(namespace.idFromName(descriptor.leg.objectName)); }
    catch (reason) { this.failure(0, "acquire", reason); reason = undefined; this.flags |= 2048; this.settleRead(); return; }
    this.fetching = sinkOrigin(requestOwner(this.owner.http).sink!, "fetch");
    let observing = false, started = false, original: Promise<Response> | undefined;
    try {
      original = stub.fetch(descriptor.url); started = !!original;
      const then = original.then;
      observing = true;
      this.fetchObservation = { owner: this, kind: 1, state: 0 };
      installOwnedOriginalMethod(this.fetchObservation, original, then);
    } catch (reason) {
      this.failure(1, "fetch", reason); reason = undefined; this.flags |= 2048;
      if (observing || started) this.unknown();
      else this.settleRead();
      this.stopReading();
    }
    original = undefined; stub = undefined as never;
  }
  private open(): void {
    this.claimReader();
    try { this.body = this.response!.body ?? undefined; }
    catch (reason) { this.failure(2, "acquire", reason); this.unknown(); throw softStatusError(); }
    if (!this.body) return;
    try { this.reader = this.body.getReader({ mode: "byob" }); this.flags |= 1; }
    catch (reason) {
      this.failure(2, "acquire", reason); reason = undefined;
      try { this.reader = this.body.getReader(); } catch (error) { this.failure(3, "acquire", error); }
    }
    if (!this.reader) return;
    this.observeClosed();
  }
  private fetchResolved(response: Response): void {
    if (this.reads || !(this.pending & 1)) { response = undefined as never; return; }
    this.pending &= ~1;
    this.response = response; response = undefined as never;
    this.schedule();
  }
  private fetchRejected(reason: unknown): void {
    if (this.reads || !(this.pending & 1)) { reason = undefined; return; }
    this.pending &= ~1;
    try { this.failure(1, "fetch", reason); }
    catch { this.unknown(); }
    finally { reason = undefined; this.flags |= 2048; this.schedule(); }
  }
  private observeClosed(): void {
    this.pending |= 8;
    let observing = false;
    try {
      let original: Promise<void> | undefined;
      {
        const reader = this.reader!, prototype = this.flags & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype;
        const nativeClosed = this.flags & 1 ? ownedStatusNativeClosed : originalReaderClosed;
        if (Object.getPrototypeOf(reader) === prototype && !Object.hasOwn(reader, "closed") && typeof originalLookupGetter === "function"
          && originalLookupGetter.call(reader, "closed") === nativeClosed) this.flags |= 2;
        original = reader.closed;
      }
      observing = true;
      const then = original.then; if (then !== ownedBoundaryThen) this.flags &= ~2;
      this.closedObservation = { owner: this, kind: 8, state: 0 };
      installOwnedOriginalMethod(this.closedObservation, original, then);
      original = undefined;
    } catch (reason) {
      const failure = this.failure(8, "closed", reason); reason = undefined;
      if (observing) this.unknown(); else this.closedResolved();
      throw failure;
    }
  }
  private closedResolved(): void { if (!(this.pending & 8)) return; this.pending &= ~8; this.schedule(); }
  private closedRejected(reason: unknown): void {
    if (!(this.pending & 8)) { reason = undefined; return; }
    this.pending &= ~8;
    this.flags |= 4;
    try {
      if (!(this.flags & 2 && this.nativeFailure)) {
        const failure = this.failure(8, "closed", reason);
        if (this.flags & 2) this.nativeFailure = failure;
      }
    } catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private read(): void {
    if (this.pending & 1 || this.readObservation || !(this.flags & 1) || !this.reader) throw softStatusError();
    this.pending |= 1;
    this.flags &= ~32;
    let original: Promise<unknown> | undefined, started = false;
    let observation: OwnedHttpReadObservation | undefined;
    try {
      const reader = this.reader as ReadableStreamBYOBReader, method = reader.read;
      if ((this.flags & 2) && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype && method === ownedStatusNativeRead) this.flags |= 32;
      original = Reflect.apply(method, reader, [this.backing]); started = !!original;
      const then = original!.then; if (then !== ownedBoundaryThen) this.flags &= ~32;
      // The actual observer's return value is not a settlement receipt. Our
      // pending bit clears only at its first actual callback; the fixed driver
      // runs after that callback and the synchronous installation have returned.
      observation = { owner: this, nonce: this.reads, state: 0 }; this.readObservation = observation;
      void Reflect.apply(then, original, [ownedHttpReadFulfilled.bind(observation), ownedHttpReadRejected.bind(observation)]);
      observation.state |= 2;
    } catch (reason) {
      if (observation) observation.state |= 4;
      this.failure(5, "read", reason); reason = undefined; this.flags |= 2048;
      if (started) this.unknown(); else this.settleRead();
      this.stopReading();
    } finally { observation = undefined; original = undefined; }
  }
  dispatchReadObservation(cell: OwnedHttpReadObservation, failed: boolean, value: unknown): void {
    if (this.readObservation !== cell || cell.state & (1 | 8) || cell.nonce !== this.reads || !(this.pending & 1)) { value = undefined; return; }
    cell.state |= 1;
    try {
      if (failed) this.readRejected(cell.nonce as number, value);
      else this.readResolved(cell.nonce as number, value as ReadableStreamReadResult<Uint8Array>);
    } catch { this.unknown(); }
    finally { value = undefined; }
  }
  private dischargeReadObservation(): void {
    let cell = this.readObservation;
    if (cell && !(this.pending & 1) && !(this.flags & 256) && (cell.state & 7) === 3) {
      cell.state = 8; cell.owner = undefined; cell.nonce = undefined; this.readObservation = undefined;
    }
    cell = undefined;
  }
  private settleRead(): void {
    this.pending &= ~1; this.schedule();
  }
  private readResolved(serial: number, value: ReadableStreamReadResult<Uint8Array>): void {
    if (serial !== this.reads || !(this.pending & 1)) { value = undefined as never; return; }
    this.pending &= ~1;
    try {
      this.done = !!value.done;
      let bytes = value.value;
      if (bytes) {
        const proof = inspectOwnedBytes(bytes);
        if (!isLocalOwnedByteBacking(proof.buffer) || proof.backing > softStatusLimits.backing || proof.length > softStatusLimits.wire - this.wire)
          throw softStatusError();
        const snapshot = newOwnedBytes(proof.length); copyOwnedBytes(snapshot, bytes); bytes = undefined;
        this.value = snapshot; this.backing = ownedBytesFromBacking(proof.buffer);
      } else this.value = undefined;
    } catch (reason) { this.failure(5, "read", reason); reason = undefined; this.flags |= 2048; }
    finally { value = undefined as never; this.schedule(); }
  }
  private readRejected(serial: number, reason: unknown): void {
    if (serial !== this.reads || !(this.pending & 1)) { reason = undefined; return; }
    this.pending &= ~1;
    const failure = this.flags & 32 && this.nativeFailure ? this.nativeFailure : this.failure(5, "read", reason);
    if (this.flags & 32) this.nativeFailure = failure;
    reason = undefined; this.flags |= 2048; this.schedule();
  }
  private stopReading(): void {
    if (this.phase >= 3) return;
    this.phase = 3;
    // A fetch observer can throw after installation and still deliver its
    // original response later. Do not spend FIRSTcancel on an absent body.
    if (this.base !== undefined) this.cancel(); else this.schedule();
  }
  private cancelResolved(): void { if (!(this.pending & 2)) return; this.pending &= ~2; this.schedule(); }
  private cancelRejected(reason: unknown): void {
    if (!(this.pending & 2)) { reason = undefined; return; }
    this.pending &= ~2;
    try {
      if (!(this.flags & 4096 && this.nativeFailure && this.flags & 4)) { this.flags |= 16; this.failure(6, "cancel", reason); }
    } catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private unlockResolved(): void { if (!(this.pending & 4)) return; this.pending &= ~4; this.schedule(); }
  private unlockRejected(reason: unknown): void {
    if (!(this.pending & 4)) { reason = undefined; return; }
    this.pending &= ~4;
    this.flags |= 16;
    try { this.failure(7, "unlock", reason); }
    catch { this.unknown(); }
    finally { reason = undefined; this.schedule(); }
  }
  private cancel(): void {
    if (this.flags & 16384) return;
    this.flags |= 16384; this.pending |= 2;
    if (this.flags & 8) { this.cancelResolved(); return; }
    let observing = false;
    try {
      let original: Promise<void> | undefined, native = false;
      if (this.reader) {
        const reader = this.reader, method = reader.cancel;
        native = !!(this.flags & 2) && Object.getPrototypeOf(reader) === (this.flags & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
          && method === (this.flags & 1 ? ownedStatusNativeCancel : originalReaderCancel);
        original = Reflect.apply(method, reader, ["soft budget observation stopped"]);
      } else if (!this.body) { this.cancelResolved(); return; }
      else if (this.body.locked) { this.unknown(); return; }
      else original = this.body.cancel();
      observing = true;
      const then = original!.then;
      if (native && then === ownedBoundaryThen) this.flags |= 4096; else this.flags &= ~4096;
      this.cancelObservation = { owner: this, kind: 2, state: 0 };
      installOwnedOriginalMethod(this.cancelObservation, original, then);
      original = undefined;
    } catch (reason) {
      this.failure(6, "cancel", reason); reason = undefined; this.flags |= 16;
      if (observing) this.unknown(); else this.cancelResolved();
    }
  }
  private unlock(): void {
    if (this.flags & 32768) return;
    this.flags |= 32768; this.pending |= 4;
    if (!this.reader) { this.unlockResolved(); return; }
    let observing = false;
    try {
      let original: unknown;
      { const reader = this.reader, method = reader.releaseLock; original = Reflect.apply(method, reader, []); }
      if (original === undefined) { this.unlockResolved(); return; }
      observing = true;
      let then: unknown;
      if (original !== null && (typeof original === "object" || typeof original === "function")) then = (original as { then?: unknown }).then;
      if (typeof then !== "function") { original = Promise.resolve(); then = ownedBoundaryThen; }
      this.unlockObservation = { owner: this, kind: 4, state: 0 };
      installOwnedOriginalMethod(this.unlockObservation, original, then);
      then = undefined;
      original = undefined;
    } catch (reason) {
      this.failure(7, "unlock", reason); reason = undefined; this.flags |= 16;
      if (observing) this.unknown(); else this.unlockResolved();
    }
  }
  private advance(): void {
    this.flags &= ~8192;
    try {
      if (this.phase === 1 || this.phase === 2) {
        if (this.pending & 1) return;
        if (this.flags & 2048) { this.stopReading(); return; }
        if (this.phase === 1) {
          this.open();
          let headers = 0, units = 0, ok = false;
          try { this.response!.headers.forEach((value, key) => {
            if (++headers > softStatusLimits.headers || key.length > softStatusLimits.headerBytes - units) throw softStatusError();
            units += key.length;
            if (value.length > softStatusLimits.headerBytes - units) throw softStatusError();
            units += value.length;
          }); ok = this.response!.ok; } catch (reason) { throw this.failure(4, "acquire", reason); }
          if (!ok) { this.flags |= 64; this.stopReading(); return; }
          if (!(this.flags & 1) || !this.reader) throw softStatusError();
          this.backing = newOwnedBytes(softStatusLimits.backing);
          this.decoder = newOwnedDecoder(true); this.phase = 2;
        } else {
          let bytes = this.value; this.value = undefined;
          if (bytes) {
            if (ownedByteLength(bytes) > softStatusLimits.wire - this.wire) throw softStatusError();
            this.wire += ownedByteLength(bytes);
            const chunk = decodeOwnedBytes(this.decoder!, bytes, !this.done);
            if (chunk.length > softStatusLimits.wire - this.text.length) throw softStatusError();
            this.text += chunk;
          }
          if (this.done) {
            if (!bytes) { const tail = decodeOwnedBytes(this.decoder!); if (tail.length > softStatusLimits.wire - this.text.length) throw softStatusError(); this.text += tail; }
            bytes = undefined; this.dischargeReadObservation(); this.flags |= 8;
            let value = parseSoftStatus(this.text); this.text = "";
            if (value && typeof value === "object" && "spentMicros" in value) {
              const candidate = (value as { spentMicros?: unknown }).spentMicros;
              if (typeof candidate === "number" && Number.isSafeInteger(candidate)) this.spent = candidate;
            }
            value = undefined; this.flags |= 64; this.stopReading(); return;
          }
          bytes = undefined;
          this.dischargeReadObservation();
          if (!ownedByteLength(this.backing!)) throw softStatusError();
        }
        if (this.reads++ >= softStatusLimits.reads) throw softStatusError();
        this.read(); return;
      }
      if (this.phase === 3) {
        if (this.base === undefined) {
          if (this.pending & 1) return;
          if (this.response) {
            try { this.open(); }
            catch (reason) { reason = undefined; this.flags |= 16; }
          }
        }
        if (!(this.flags & 16384)) { this.cancel(); return; }
        if (this.pending & 3) return;
        this.value = undefined; this.dischargeReadObservation();
        this.phase = 4; this.unlock(); return;
      }
      if (this.phase === 4) {
        if (this.pending & 4) return;
        if (this.body?.locked) { this.unknown(); return; }
        // Independent closed rejection is diagnostic; actual read/cancel/unlock
        // cleanup still precedes this completion-arrival decision.
        this.owner.decide(this.index, !!(this.flags & 64) && !(this.flags & 16), this.spent);
        this.phase = 5;
      }
      if (this.phase !== 5 || this.pending || this.flags & (256 | 8192)) return;
      if (this.body?.locked) { this.unknown(); return; }
      if (!severOwnedOriginal(this.fetchObservation) || !severOwnedOriginal(this.closedObservation)
        || !severOwnedOriginal(this.cancelObservation) || !severOwnedOriginal(this.unlockObservation)) { this.unknown(); return; }
      this.fetchObservation = undefined; this.closedObservation = undefined; this.cancelObservation = undefined; this.unlockObservation = undefined;
      this.reader = undefined; this.body = undefined; this.response = undefined;
      this.advanceWork = undefined as never; this.nativeFailure = undefined; this.decoder = undefined;
      this.text = ""; this.backing = undefined; this.value = undefined;
      this.phase = 6; this.retired();
    } catch (reason) {
      if (this.phase < 3) {
        // Existing parse/header/profile failures are failed observations, not
        // exhausted-cache updates. Their raw reasons never enter the owner.
        reason = undefined; this.flags &= ~64; this.stopReading();
      } else this.unsettled(reason);
    }
  }
}
export function prepareOwnedHttpSoftStatus(cap: OwnedHttpRequest, env: Env, plan: PreparedSoftBudget): void {
  const root = requestOwner(cap);
  if (root.sealed || root.unknown || root.env !== env || root.softStatus || !matchesOwnedHttpSoftStatusPlan(cap, env, plan)
    || plan.descriptors.length > 4) throw identityFailure("protocol");
  // Four complete source/read/text/graph overlaps, plus fixed decision metadata.
  growOwnedHttpRequest(cap, 4096 + plan.descriptors.length * ownedStatusData);
  reserveSinkOrigins(ownedHttpSinkOwner(cap), 1 + 11 * plan.descriptors.length);
  claimOwnedSinkFactories(); enrollOwnedSinkChild(root);
  const state = new OwnedStatusController(cap, plan); root.softStatus = state;
  for (let index = 0; index < plan.descriptors.length; index++) {
    state.readers.push(new OwnedStatusReader(state, index));
  }
}
export function finishOwnedHttpSoftStatus(cap: OwnedHttpRequest, state: OwnedStatusController): void {
  const root = requestOwner(cap);
  if (root.softStatus !== state || !state.settled) throw identityFailure("protocol");
  retireOwnedSinkChild(root);
}
export function bindOwnedHttpSoftStatus(cap: OwnedHttpRequest, env: Env, plan: PreparedSoftBudget, operation: HttpOperation): void {
  const root = requestOwner(cap), state = root.softStatus;
  if (!state || state.prepared !== plan || state.readersStarted || state.settled || root.env !== env
    || !matchesOwnedHttpSoftStatusPlan(cap, env, plan, operation)) throw identityFailure("protocol");
  const origin = sinkOrigin(root.sink!, "acquire");
  try { state.namespace = env.BUDGET_LEDGER; } catch (reason) { throw failedSinkOrigin(root, origin, reason); }
  state.bound = true;
}
export function startOwnedHttpSoftStatus(cap: OwnedHttpRequest): void {
  const state = requestOwner(cap).softStatus;
  if (!state) throw identityFailure("protocol");
  state.startReaders();
}
export function checkOwnedHttpSoftStatusRetirement(cap: OwnedHttpRequest): void {
  const root = requestOwner(cap);
  if (!root.sealed || root.unknown || !root.softStatus?.settled) throw identityFailure("protocol");
}

// Only control custody leaves this module. Payloads stay in the named command
// that consumes them; returning this scope does not retire any such aliases.
export function ownedHttpCompletion(cap: OwnedHttpRequest): ProxyCompletion {
  const owner = requestOwner(cap);
  if (owner.sealed) throw identityFailure("protocol");
  return owner.completion;
}

// Enroll BEFORE constructing the source, FixedLengthStream or pipe. The root
// remains open across partial preparation failure until explicit abandonment.
export function beginOwnedHttpUpload(cap: OwnedHttpRequest): OwnedHttpUpload {
  const request = requestOwner(cap);
  if (request.sealed) throw identityFailure("protocol");
  fundOwnedHttpRequest(cap, request.funding.bytes + uploadMetadataBytes);
  // Upload completion is a separate original-root join. Enrolling it in the
  // logical delivery/accounting completion would prevent that boundary from
  // ever initiating cancellation of a dispatched, backpressured upload.
  const sink = ownedHttpSinkOwner(cap); reserveSinkOrigins(sink, 5);
  const adding = sinkOrigin(sink, "listener-add"), listenerRemoval = sinkOrigin(sink, "listener-remove");
  claimOwnedSinkFactories(); enrollOwnedSinkChild(request);
  const upload = Object.freeze({});
  const owner = new UploadOwner(upload, request, listenerRemoval);
  uploads!.set(upload, owner); request.uploads.push(owner);
  try {
    const controller = new AbortController(); owner.controller = controller;
    const signal = request.request!.signal;
    owner.listener = () => controller.abort();
    try { signal.addEventListener("abort", owner.listener, { once: true }); }
    catch (reason) { throw failedSinkOrigin(request, adding, reason); }
    if (signal.aborted) controller.abort();
    return upload;
  } catch (error) { owner.unused(); throw error; }
}

export function checkOwnedHttpUpload(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (owner.started || owner.settled || owner.request.sealed) throw identityFailure("protocol");
}

export function holdOwnedHttpUploadSerialization(cap: OwnedHttpUpload): never {
  const owner = uploadOwner(cap);
  owner.request.unknown = true;
  // A failed restoration can leave the genuine source graph changed. Keep its
  // request/attempt funding and prevent dispatch; no cleanup result is invented.
  throw identityFailure("cleanup");
}

export function finishOwnedHttpUploadPreparation(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (!owner.started) { if (owner.source) throw identityFailure("protocol"); owner.unused(); }
}

export function dispatchOwnedHttpUpload(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (owner.dispatched || owner.abandonment) throw identityFailure("protocol");
  owner.dispatch();
}

// Named preparation handoff. The genuine upload capability was registered
// before either source factory. No replacement reader or second cancel exists.
export function pipeOwnedHttpUpload(cap: OwnedHttpUpload, source: ReadableStream<Uint8Array>, fixed: FixedLengthStream): ReadableStream<Uint8Array> {
  const owner = uploadOwner(cap);
  if (owner.started || owner.settled || !owner.controller) throw identityFailure("protocol");
  owner.pipe(source, fixed);
  return fixed.readable;
}

// Partial factory failure may have created a source before a fixed stream.
// Transfer it immediately so abandonment has its sole original cancellation.
export function adoptOwnedHttpUploadSource(cap: OwnedHttpUpload, source: ReadableStream<Uint8Array>): void {
  const owner = uploadOwner(cap);
  if (owner.started || owner.source || owner.settled) throw identityFailure("protocol");
  owner.source = source;
}

export function abandonOwnedHttpUpload(cap: OwnedHttpUpload): Promise<void> {
  const owner = uploadOwner(cap);
  if (owner.abandonment) return owner.abandonment;
  let complete!: () => void;
  owner.abandonment = new Promise<void>(resolve => { complete = resolve; });
  // Abort FIRST: waiting for an unconsumed backpressured upload would deadlock.
  try { if (owner.controller) ownedHttpArchiveAbort(owner.request.sink!, owner.controller); } catch (error) { owner.failures.push(error); }
  void (async () => {
    if (owner.started) await owner.joined;
    else if (owner.source) {
      // A lock without our ORIGINAL pipe has no application settlement proof.
      // Preserve the open scope and debit rather than invent cancellation ACK.
      if (owner.source.locked) { owner.request.unknown = true; return; }
      try { await ownedHttpArchiveCancel(owner.request.sink!, owner.source); } catch (error) { owner.failures.push(error); }
      owner.unused(); await owner.joined;
    } else { owner.unused(); await owner.joined; }
  })().then(() => { if (owner.settled) complete(); }, error => { owner.request.unknown = true; owner.failures.push(error); complete(); });
  // This is a join receipt, not a success verdict. The sole terminal consumer
  // below reports each original failure once, even if abandon is joined twice.
  return owner.abandonment;
}

export function holdOwnedHttpRequest(cap: OwnedHttpRequest): void { requestOwner(cap).unknown = true; }

// Called only after all named consumers have cleared their payload aliases.
// It is deliberately OUTSIDE the encompassing completion it waits for.
export function finishOwnedHttpRequest(cap: OwnedHttpRequest): Promise<void> {
  const owner = requestOwner(cap);
  if (owner.retirement) return owner.retirement;
  for (const upload of owner.uploads) if (!upload.dispatched && !upload.settled) void abandonOwnedHttpUpload(upload.cap);
  owner.softStatus?.abandonUnstarted();
  owner.sealed = true; owner.completion.seal();
  owner.retirement = (async () => {
    await owner.completion.completion;
    const failures: unknown[] = [];
    for (const upload of owner.uploads) {
      // No logical HTTP consumer can still need this request upload now. A
      // provider can finish its response without draining our original pipe.
      // Initiate owned cancellation BEFORE joining that original; UNKNOWN
      // abandonment remains pending and retains all relevant funding.
      if (!upload.settled) await abandonOwnedHttpUpload(upload.cap);
      await upload.joined;
      if (!upload.settled) { owner.unknown = true; continue; }
      failures.push(...upload.failures);
      try { if (upload.listener) owner.request!.signal.removeEventListener("abort", upload.listener); }
      catch (reason) { owner.unknown = true; failures.push(failedSinkOrigin(owner, upload.listenerRemoval, reason)); }
      upload.source = undefined; upload.fixed = undefined;
      upload.controller = undefined; upload.listener = undefined; upload.failures.length = 0;
      upload.finish(); await upload.retired;
      uploads!.delete(upload.cap);
    }
    owner.accountingTerminal?.abandonPrepared();
    if (owner.budgetSequence && owner.budgetSequence.phase !== 4) {
      try { owner.budgetSequence.close(); }
      catch (reason) { owner.unknown = true; recordOwnedTerminalFailure(owner, owner.completion, owner.accountingCloseOrigin!, reason); reason = undefined; }
    }
    // Logical accounting/recovery has finished; unused non-OK body retirement
    // can still be pending. It never delayed those recovery decisions above.
    owner.sinkClosed = true;
    // The private intake already claims the fixed module slice. A request
    // with no later sink children still closes this physical receipt directly.
    if (!owner.sinkPending && !owner.unknown && owner.resolveSink) { owner.resolveSink(); owner.resolveSink = undefined; }
    await owner.sinkRetired;
    for (const origin of owner.codecOrigins ?? []) if (origin.failed) failures.push(origin);
    if (!owner.unknown) {
      if (owner.abortListener) {
        try { owner.request!.signal.removeEventListener("abort", owner.abortListener); }
        catch (reason) { owner.unknown = true; failures.push(failedSinkOrigin(owner, owner.abortRemoval!, reason)); }
      }
      owner.abortListener = undefined; owner.abortController = undefined; owner.abortRemoval = undefined;
    }
    if (!owner.unknown) {
      // A failed last-consumer handoff is not proof that prepared callbacks
      // stopped borrowing identity/credential graphs. Preserve their owners.
      try {
        owner.retiringConsumers = true;
        retireOwnedHttpAccountingCommands(cap);
        retireOwnedHttpProxy(cap);
        for (const revalidation of owner.revalidations ?? []) {
          const state = revalidations!.get(revalidation)!;
          if (state.active || state.graph !== undefined) throw identityFailure("protocol");
          // A failed preparation may never have published its callbacks. Its
          // original prepare promise and uploads were joined above.
          if (state.preparing) { setRevalidationPhase(state, 0); state.preparing = false; }
          if (state.phaseBytes) throw identityFailure("protocol");
          retireOwnedCodecConsumers(revalidation);
          if (state.consumer) { retireOwnedHttpConsumerBacking(state.backing); state.consumer = undefined; }
          retireOwnedVeniceChatCodec(revalidation);
          retireOwnedVeniceRevalidation(revalidation); retireOwnedGmiRevalidation(revalidation); retireOwnedResponseControl(revalidation);
          state.auth = undefined as never; state.selection = undefined as never; state.upstream = undefined as never;
          state.attempt = undefined as never;
          state.url = undefined as never; state.headers = undefined as never;
          state.preparation = undefined;
          retireOwnedHttpRevalidationBacking(state.backing); state.backing = undefined as never;
          revalidations!.delete(revalidation);
        }
        owner.revalidations = undefined;
      } catch (error) { owner.unknown = true; failures.push(error); }
      if (!owner.unknown) try { retireOwnedHttpConsumers(cap); } catch (error) { owner.unknown = true; failures.push(error); }
    }
    if (!owner.unknown && owner.softStatus) {
      retireOwnedHttpSoftBudget(cap); owner.softStatus.readers.length = 0; owner.softStatus = undefined;
    }
    // Fixed-cohort transport starts only after HTTP consumers cleared. Unknown
    // delivery keeps its graphs/parents and cannot borrow this phase's windows.
    if (!owner.unknown) {
      try { await drainOwnedHttpIdentity(cap); } catch (error) { failures.push(error); }
      if (!owner.unknown) try { retireOwnedHttpIdentity(cap); } catch (error) { owner.unknown = true; failures.push(error); }
    }
    if (!owner.unknown) {
      try { reportOwnedSinkDiagnostics(owner, failures); } catch (error) { failures.push(error); }
    }
    if (!owner.unknown) {
      // Only actual last-consumer clearance retires diagnostic capabilities.
      // A failed listener removal may leave a live callback even after the
      // current original body has joined; UNKNOWN keeps those caps funded.
      if (owner.codecOrigins) owner.codecOrigins.length = 0;
      if (owner.metadata?.formatted) clearOwnedLocalError(owner.metadata.formatted);
      if (owner.metadata?.correlated) clearOwnedLocalError(owner.metadata.correlated);
      if (owner.metadata?.cors) clearOwnedLocalError(owner.metadata.cors);
      if (owner.publication?.output) clearOwnedLocalError(owner.publication.output);
      owner.publication = undefined;
      owner.codecOrigins = undefined; owner.publicReaders = undefined; owner.publicOutputs = undefined; owner.metadata = undefined;
      owner.uploads.length = 0; owner.request = undefined; owner.env = undefined;
      if (owner.sink) sinkOwners!.delete(owner.sink);
      if (owner.sinkOrigins) for (const origin of owner.sinkOrigins.values()) if (typeof origin !== "number") sinkFailures!.delete(origin);
      if (owner.localErrorResponses) {
        for (let index = 0; index < owner.localErrorResponses.length; index++) clearOwnedLocalError(owner.localErrorResponses[index]);
        owner.localErrorResponses = undefined; owner.localErrorDisposals = undefined;
      }
      owner.localFailures = undefined;
      owner.sinkOrigins = undefined; owner.sink = undefined; owner.terminalRegistration = undefined; owner.budgetDenials = undefined;
      requests!.delete(cap); owner.funding.release();
      if (!--requestCount) { requests = undefined; uploads = undefined; sinkOwners = undefined; sinkFailures = undefined; sinkRegistrations = undefined; intakes = undefined; revalidations = undefined; const funding = registryFunding; registryFunding = undefined; funding?.release(); }
    }
    if (failures.length) throw new AggregateError(failures, "owned HTTP request retirement");
  })();
  void owner.retirement.then(() => undefined, () => undefined);
  return owner.retirement;
}


// One retained producer/publication association, paid on the HTTP owner. This
// is neither a new body owner nor authority derived from the accounting DTO.
interface OwnedProxyPublication {
  source: Response; output: Response | undefined; body: ReadableStream<Uint8Array> | null;
  attempt: UploadOwner; operation: HttpOperation; phase: number; admittedBytes: number;
  sourceHeaders: Headers | undefined; sourceHeaderBytes: number;
}
function prepareOwnedUsagePublication(http: OwnedHttpRequest, root: RequestOwner, attempt: UploadOwner,
  operation: HttpOperation, source: Response, body: ReadableStream<Uint8Array> | null, bytes: number): OwnedProxyPublication {
  if (root !== requestOwner(http) || root.publication || root.sealed || root.unknown || attempt.request !== root
    || !matchesOwnedHttpPublicationContext(http, attempt.cap, operation)) throw identityFailure("protocol");
  growOwnedHttpRequest(http, bytes); claimOwnedSinkFactories();
  if (root.publication || root.sealed || root.unknown || attempt.request !== root
    || !matchesOwnedHttpPublicationContext(http, attempt.cap, operation)) throw identityFailure("protocol");
  const publication: OwnedProxyPublication = { source, output: undefined, body, attempt, operation, phase: 0, admittedBytes: bytes, sourceHeaders: undefined, sourceHeaderBytes: 0 };
  root.publication = publication; return publication;
}
function ownedProxyPublication(http: OwnedHttpRequest, source: Response, phase: number): OwnedProxyPublication {
  const root = requestOwner(http), publication = root.publication;
  if (!publication || root.sealed || root.unknown || publication.source !== source || publication.phase !== phase
    || publication.attempt.request !== root || !matchesOwnedHttpPublicationContext(http, publication.attempt.cap, publication.operation))
    throw identityFailure("protocol");
  return publication;
}
function admitOwnedProxyPublication(http: OwnedHttpRequest, source: Response, phase: number, bytes: number): void {
  const publication = ownedProxyPublication(http, source, phase);
  growOwnedHttpRequest(http, bytes);
  if (ownedProxyPublication(http, source, phase) !== publication) throw identityFailure("protocol");
  publication.admittedBytes += bytes;
}
// The shared target includes these fourteen literals and this array. No new
// per-request deletion vector or mutable collection dispatch is needed.
const ownedProxyStrippedHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "trailer", "transfer-encoding", "upgrade", "x-clawrouter-grant-failover", "x-clawrouter-error-code", "openai-organization", "openai-project", "anthropic-organization-id", "anthropic-workspace-id"] as const;
export function beginOwnedHttpProxyPublicationHeaders(http: OwnedHttpRequest, source: Response, providerId: string): Headers {
  const publication = ownedProxyPublication(http, source, 1);
  if (typeof providerId !== "string") throw identityFailure("protocol");
  // Fixed census/clone/set operands plus every provider-ID occurrence precede
  // even the first actual source Headers getter and its census factories.
  admitOwnedProxyPublication(http, source, 1, 8192 + 8 * providerId.length);
  const headers = source.headers;
  const measured = measureOwnedHeaders(headers);
  publication.sourceHeaders = headers; publication.sourceHeaderBytes = measured;
  // Twelve conservative timing prefix/fragment/final string occurrences,
  // four numeric strings and both enum strings coexist with all inserted
  // header values/names. These are payload charges, not a fixed-window proof.
  const timingUnits = 12 * 238 + 4 * 32 + 2 * 6;
  admitOwnedProxyPublication(http, source, 1, 2 * measured + 2 * timingUnits
    + 4 * (256 + providerId.length + 238 + 12 + 1 + 21) + 32 * 6 + 8192);
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  const copy = newOwnedHeaders(headers);
  for (let index = 0; index < ownedProxyStrippedHeaders.length; index++) deleteOwnedHeader(copy, ownedProxyStrippedHeaders[index]);
  setOwnedHeader(copy, "x-clawrouter-upstream-provider", providerId);
  publication.phase = 2; return copy;
}
export function checkOwnedHttpProxyPublicationBody(http: OwnedHttpRequest, source: Response, body: ReadableStream<Uint8Array> | null): void {
  if (ownedProxyPublication(http, source, 2).body !== body) throw identityFailure("protocol");
}
export function finishOwnedHttpProxyPublication(http: OwnedHttpRequest, source: Response, body: ReadableStream<Uint8Array> | null,
  status: number, statusText: string, headers: Headers): Response {
  const publication = ownedProxyPublication(http, source, 2);
  if (body !== publication.body || typeof status !== "number" || typeof statusText !== "string") throw identityFailure("protocol");
  const measured = measureOwnedHeaders(headers);
  admitOwnedProxyPublication(http, source, 2, 2 * measured + 6 * statusText.length + 8192);
  if (!publication.sourceHeaders || measureOwnedHeaders(publication.sourceHeaders) > publication.sourceHeaderBytes)
    throw identityFailure("protocol");
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  const output = newOwnedResponse(body, status, statusText, headers);
  // Both source body reads matched the independently bound producer body.
  // No JSON-shape inference or new brand crosses a changed-body wrapper.
  inheritOwnedLocalError(source, output);
  publication.output = output; publication.phase = 3; return output;
}

// One fixed final-metadata sequence on the genuine request, never a public
// strategy/funding callback or a new body owner. Stage charges stay held until
// request physical retirement; overwriting a response is not a debit refund.
interface OwnedFinalMetadata {
  response: Response; path: string; requestId: string; stage: number; busy: boolean;
  discarded: Response | undefined;
  formatted: Response | undefined; correlated: Response | undefined; cors: Response | undefined;
}
export function beginOwnedHttpFinalMetadata(cap: OwnedHttpRequest, request: Request, env: Env,
  response: Response, path: string, requestId: string): void {
  const owner = requestOwner(cap);
  if (owner.sealed || owner.metadata || owner.request !== request || owner.env !== env
    || typeof path !== "string" || typeof requestId !== "string") throw identityFailure("protocol");
  growOwnedHttpRequest(cap, 8192 + 2 * path.length + 2 * requestId.length);
  reserveSinkOrigins(owner.sink!, 2); claimOwnedSinkFactories();
  owner.metadata = { response, path, requestId, stage: 0, busy: false, discarded: undefined, formatted: undefined, correlated: undefined, cors: undefined };
}
export function beginOwnedHttpMetadataStage(cap: OwnedHttpRequest, response: Response, stage: number,
  requestId?: string, path?: string, request?: Request): void {
  const owner = requestOwner(cap), state = owner.metadata;
  if (owner.sealed || owner.unknown || !state || state.busy || state.stage !== stage || state.response !== response
    || requestId !== undefined && requestId !== state.requestId || path !== undefined && path !== state.path
    || request !== undefined && request !== owner.request) throw identityFailure("protocol");
  state.busy = true;
}
export function admitOwnedHttpMetadata(cap: OwnedHttpRequest, response: Response, stage: number, bytes: number): void {
  const owner = requestOwner(cap), state = owner.metadata;
  if (!state || !state.busy || state.stage !== stage || state.response !== response) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, bytes);
}
export function finishOwnedHttpMetadataStage(cap: OwnedHttpRequest, response: Response, stage: number, copy: Response): Response {
  const owner = requestOwner(cap), state = owner.metadata;
  if (!state || !state.busy || state.stage !== stage || state.response !== response) throw identityFailure("protocol");
  if (copy !== response) {
    if (stage === 0) state.formatted = copy;
    else if (stage === 2) state.correlated = copy;
    else if (stage === 5) state.cors = copy;
  }
  state.response = copy; state.stage++; state.busy = false;
  return copy;
}
export function disposeOwnedHttpLocalErrorBody(cap: OwnedHttpRequest, response: Response): void {
  const owner = requestOwner(cap), state = owner.metadata;
  if (!state || state.stage !== 0 || !state.busy || state.response !== response || state.discarded)
    throw identityFailure("protocol");
  const body = response.body;
  if (!body) { state.discarded = response; return; }
  const reader = owner.publicOutputs?.get(body);
  if (reader) { state.discarded = response; void reader.retire(true); return; }
  if (body.locked) { owner.unknown = true; state.discarded = response; return; }
  const command = createOwnedSinkVoidCommand(owner, sinkOrigin(owner.sink!, "cancel"));
  state.discarded = response;
  let original: Promise<void>;
  try { original = body.cancel(); }
  catch (reason) { command.invokedFailure(reason); return; }
  command.observe(original); original = undefined as never;
}
export function ownOwnedHttpMetadataPublicResponse(cap: OwnedHttpRequest, response: Response): Response {
  beginOwnedHttpMetadataStage(cap, response, 1);
  return finishOwnedHttpMetadataStage(cap, response, 1, ownOwnedHttpPublicResponse(cap, response));
}
export function withOwnedHttpVersion(cap: OwnedHttpRequest, response: Response, env: Env): Response {
  const owner = requestOwner(cap);
  if (owner.env !== env) throw identityFailure("protocol");
  beginOwnedHttpMetadataStage(cap, response, 4);
  // The first getter is truthiness-only. Do not reuse it as the inserted value.
  if (env.CF_VERSION_METADATA?.id) {
    const value: unknown = env.CF_VERSION_METADATA.id;
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "undefined")
      throw identityFailure("protocol");
    const headers = response.headers, statusText = response.statusText;
    if (typeof statusText !== "string") throw identityFailure("protocol");
    const source = measureOwnedHeaders(headers), units = typeof value === "string" ? value.length : 32;
    admitOwnedHttpMetadata(cap, response, 4, 8192 + 2 * source + 4 * statusText.length + 8 * (units + 23));
    if (measureOwnedHeaders(headers) > source) throw identityFailure("protocol");
    setOwnedHeader(headers, "x-clawrouter-version-id", ownedMetadataString(value));
  }
  return finishOwnedHttpMetadataStage(cap, response, 4, response);
}
