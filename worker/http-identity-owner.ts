import { ExactBodyCharge } from "./body-budget.ts";
import { identityFailure, isIdentityFailure, identityHeader, identitySourceBudget, identityPlan, admitIdentityBytes, admitIdentityHeaders, parseIdentity, IdentityWire } from "./identity-admission.ts";
import { ProxyCompletion } from "./proxy-completion.ts";
import { inputRetirement } from "./input-retirement.ts";
import type { Env, QueueMessage, AuthorizedIdentity, UsageEvent } from "./types.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { PreparationAdmission } from "./provider-templates.ts";
import type { HttpOperation } from "./http-operation.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import { proxyKeyVerification } from "./proxy-auth.ts";
import { HttpError } from "./utils.ts";
import { selectedCredentialFailure } from "./grant-credential-failure.ts";
import { acceptOwnedAuthorizationSnapshot, retireOwnedResponseControl } from "./response-control-authorization.ts";
import { acceptOwnedVeniceInspection, retireOwnedVeniceRevalidation } from "./venice-chat-authority.ts";
import { acceptOwnedGmiInspection, retireOwnedGmiRevalidation } from "./gmi-organization-binding.ts";
import { drainOwnedHttpIdentity, retireOwnedHttpConsumers, retireOwnedHttpIdentity, claimOwnedHttpRevalidationBacking,
  admitOwnedHttpRevalidationBacking, retireOwnedHttpRevalidationBacking, type OwnedHttpRevalidationBacking } from "./credential-preflight.ts";
import { admitOwnedHttpCodecBacking, admitOwnedHttpUsageBacking, retireOwnedHttpCodecBacking, admitOwnedHttpConsumerBacking, retireOwnedHttpConsumerBacking } from "./credential-preflight.ts";
import { retireOwnedHttpProxy, matchesOwnedHttpRevalidationInput, matchesOwnedHttpVeniceResponseInput, matchesOwnedHttpPublicBody, matchesOwnedHttpSoftStatusPlan, matchesOwnedHttpCodecConsumerInput, matchesOwnedHttpCodecNormalizationInput, matchesOwnedHttpCodecUsageInput, acceptOwnedCodecUsage } from "./proxy.ts";
import { retireOwnedVeniceChatCodec, matchesOwnedVeniceRetirement, consumeOwnedVeniceChatResponse, matchesOwnedVeniceOutputBody, matchesOwnedVeniceOutputFailure, matchesOwnedVeniceConsumerInput } from "./venice-chat-runtime.ts";
import { matchesOwnedCodecOutputFailure, matchesOwnedCodecConsumerRetirement, retireOwnedCodecConsumers, ownedUsageCaptureBytes, type OwnedCodecConsumer } from "./proxy-response.ts";
import { credentialPreflightHeader, credentialPreflightVersion, credentialPreflightPath, credentialPreflightNamespace } from "./credential-preflight-protocol.ts";
import { usageShardName } from "./usage-sharding.ts";
import { logCorrelationError } from "./correlation.ts";
import type { AccountingSinks, BudgetReservation } from "./accounting.ts";
import { matchesOwnedHttpAccountingCommand, retireOwnedHttpAccountingCommands, type OwnedHttpAccountingCommand } from "./proxy-accounting.ts";
import { parseSoftStatus, softStatusLimits, softStatusError } from "./soft-budget-json.ts";
import { acceptOwnedHttpSoftStatus, retireOwnedHttpSoftBudget, type PreparedSoftBudget } from "./soft-budget.ts";

// This entry is inactive until the named compiled HTTP adapter invokes it.
// Capabilities contain no request, identity, credential or preparation graph.
export interface OwnedHttpRequest { readonly kind?: never }
export interface OwnedHttpUpload { readonly kind?: never }
export interface OwnedHttpSinkOwner { readonly sink?: never }
export interface OwnedHttpSinkRegistration { readonly registration?: never }
export interface OwnedHttpIntakeDiagnostics { readonly intake?: never }
export interface OwnedHttpRevalidation { readonly revalidation?: never }
type SinkOrigin = "acquire" | "fetch" | "body" | "read" | "closed" | "cancel" | "unlock" | "queue" | "put" | "pipe" | "abort" | "pull" | "retire" | "registration" | "registration-missing" | "listener-add" | "listener-remove" | "diagnostic";
type SinkDisposition = "transport" | "missing" | "conflict" | "protocol";
export interface OwnedHttpFailureMetadata {
  readonly origin: SinkOrigin; readonly ordinal: number; readonly failed: boolean;
  readonly primary: boolean; readonly primaryIsUndefined: boolean; readonly disposition: SinkDisposition;
}
type SinkOriginOwner = number;
type SinkOriginRecord = Readonly<OwnedHttpFailureMetadata>;
const sinkKinds: readonly SinkOrigin[] = Object.freeze(["acquire", "fetch", "body", "read", "closed", "cancel", "unlock", "queue", "put", "pipe", "abort", "pull", "retire", "registration", "registration-missing", "listener-add", "listener-remove", "diagnostic"]);

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
  sinkCustody?: ProxyCompletion;
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
}
interface UploadOwner {
  cap: OwnedHttpUpload;
  request: RequestOwner;
  scope: ProxyCompletion;
  sink: OwnedHttpSinkOwner;
  controller?: AbortController;
  listener?: () => void;
  listenerRemoval: SinkOriginOwner;
  source?: ReadableStream<Uint8Array>;
  fixed?: FixedLengthStream;
  original?: Promise<void>;
  joined?: Promise<void>;
  abandonment?: Promise<void>;
  started: boolean;
  settled: boolean;
  dispatched: boolean;
  failures: unknown[];
}

// Positive metadata backing precedes the registry/owner/control factories.
// These components are logical allowances, never JavaScript object sizes.
// Entry owns terminal registration plus one untouched-response cancellation.
const sinkOriginBytes = 2048;
const requestMetadataBytes = 4096 + 4096 + 3 * sinkOriginBytes;
const uploadMetadataBytes = 4096;
const originalReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const ownedBoundaryThen = Promise.prototype.then;
const originalReaderRead = ReadableStreamDefaultReader.prototype.read;
let requests: WeakMap<OwnedHttpRequest, RequestOwner> | undefined;
let uploads: WeakMap<OwnedHttpUpload, UploadOwner> | undefined;
let registryFunding: ExactBodyCharge | undefined;
let requestCount = 0;
let sinkOwners: WeakMap<OwnedHttpSinkOwner, RequestOwner> | undefined;
let sinkFailures: WeakSet<object> | undefined;
let sinkRegistrations: WeakMap<OwnedHttpSinkRegistration, { owner: RequestOwner; origin: SinkOriginOwner; scope: ProxyCompletion }> | undefined;
type IntakePhase = "acquire" | "read" | "closed" | "cancel" | "unlock" | "listenerAdd" | "listenerRemove" | "abort" | "pull" | "retire";
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
  if (!owner || !owner.sinkCustody) throw identityFailure("protocol");
  return owner;
}
export function ownedHttpFailureMetadata(value: unknown): OwnedHttpFailureMetadata | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function") && sinkFailures?.has(value) ? value as OwnedHttpFailureMetadata : undefined;
}
function reserveSinkOrigins(sink: OwnedHttpSinkOwner, count: number): void {
  const owner = sinkOwner(sink);
  // Operation-local terminal origins are prepaid before acquisition/start.
  // Cancellation never has to compete for a new common-arena reservation.
  const charge = owner.funding.replace(owner.funding.bytes + count * sinkOriginBytes);
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

// Internal only: every exported entry below is a closed named native command.
// The first non-async reactions sanitize BEFORE any shared catch/allSettled.
function sinkOriginal<T>(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<T>, discard?: false): Promise<T>;
function sinkOriginal(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<unknown>, discard: true): Promise<void>;
function sinkOriginal(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<unknown>, discard = false): Promise<unknown> {
  const owner = sinkOwner(sink);
  let outcome!: Promise<unknown>;
  owner.sinkCustody!.startPrivateLeaf(() => {
    let original: Promise<unknown> | undefined;
    try { original = start(); }
    catch (reason) {
      outcome = Promise.reject(failedSinkOrigin(owner, record, reason));
      start = undefined as never;
      return outcome.then(() => undefined, () => undefined);
    }
    start = undefined as never;
    outcome = original.then(value => { return discard ? undefined : value; }, reason => { throw failedSinkOrigin(owner, record, reason); });
    original = undefined;
    // Custody consumes only a void follower; it cannot retain a fulfilled graph.
    return outcome.then(() => undefined, () => undefined);
  });
  return outcome;
}

interface RevalidationOwner {
  http: OwnedHttpRequest; request: Request; env: Env; auth: AuthorizedIdentity;
  selection: ProxySelection; upstream: UpstreamAuth; attempt: OwnedHttpUpload;
  url: URL; headers: Headers; preparation?: PreparationAdmission;
  backing: OwnedHttpRevalidationBacking; persistentBytes: number; phaseBytes: number; preparing: boolean;
  active: boolean; graph?: unknown;
  graphKind?: "snapshot" | "inspect"; retainedBytes: number; environmentUnits: number;
  snapshotRequestBytes: number; requestBytes: number;
  codec?: true; codecSource?: true; codecScope?: ProxyCompletion; consumer?: true;
  consumerHeaderBytes?: number; consumerDataBytes?: number;
  codecRoles?: number; sourceBase?: number; consumerBase?: number; replacementBase?: number;
}
let revalidations: WeakMap<OwnedHttpRevalidation, RevalidationOwner> | undefined;
// Same original-wire/text/decoded/parsed component as the private full reader.
// Retained policy/routing occurrences are ADDITIVE during the inspect RPC.
const revalidationSourceBytes = 16793600 + 2 * 2097152 + 32768;
const revalidationControlBytes = 65536;
const originalByobCancel = ReadableStreamBYOBReader.prototype.cancel;
export function reserveOwnedHttpRevalidationOrigins(http: OwnedHttpRequest, providerId: string): void {
  if (providerId !== "venice" && providerId !== "gmi") return;
  const owner = requestOwner(http);
  if (owner.sealed) throw identityFailure("protocol");
  // Before this attempt's selection effects: snapshot + inspect at dispatch,
  // and Venice's one existing delivery check. Environment routes leave the
  // unused inspect credits held, never invent a new operation. The source has
  // ten distinct origins (including closed); each consumer has nine. This
  // extra origin uses positive SAME-common backing before selection effects.
  const count = providerId === "venice" ? 64 : 18;
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
    const cap = Object.freeze({});
    const state: RevalidationOwner = { http, request, env, auth, selection, upstream, attempt, url, headers, preparation, active: false,
      backing, persistentBytes, phaseBytes: 12 * units + revalidationControlBytes, preparing: true,
      retainedBytes: 0, snapshotRequestBytes, requestBytes: 0, environmentUnits: typeof secret === "string" ? secret.length : 0 };
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
  if (owner.env !== env || owner.auth !== auth || owner.selection !== selection || owner.upstream !== upstream
    || owner.url !== url || owner.headers !== headers || request !== undefined && owner.request !== request
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
  applyProviderCredential(owner.selection.provider, owner.upstream.grant, owner.env, headers, query, owner.preparation);
}
function setRevalidationPhase(owner: RevalidationOwner, bytes: number): void {
  admitOwnedHttpRevalidationBacking(owner.backing, owner.persistentBytes, bytes);
  owner.phaseBytes = bytes;
}
export function checkOwnedHttpVeniceCodec(cap: OwnedHttpRevalidation, selection: ProxySelection): void {
  const owner = revalidationOwner(cap);
  if (owner.selection !== selection || selection.provider.id !== "venice" || !owner.preparing
    || !matchesOwnedHttpRevalidationInput(owner.http, owner.request, owner.env, owner.auth, selection,
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
  if (offset < 0) throw identityFailure("protocol");
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
  const value = owner.selection.provider.id === "venice" ? owner.env.VENICE_API_KEY : owner.env.GMI_API_KEY;
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
  if (env !== owner.env || !owner.active || !owner.phaseBytes || owner.graph !== undefined
    || kind === "inspect" && !owner.upstream.grantKey) throw identityFailure("protocol");
  const sink = ownedHttpSinkOwner(owner.http), root = sinkOwner(sink);
  if (root.revalidationCredits < 9) throw identityFailure("protocol");
  setRevalidationPhase(owner, revalidationSourceBytes + owner.retainedBytes + revalidationControlBytes
    + (kind === "snapshot" ? owner.snapshotRequestBytes : 6));
  owner.requestBytes = kind === "snapshot" ? owner.snapshotRequestBytes : 6;
  // Stub, fetch, reader acquisition/fallback, read, FIRSTcancel, unlock, and
  // abort listener installation/removal. No fresh charge is needed in cleanup.
  root.revalidationCredits -= 9;
  try { return root.sinkCustody!.start(() => consumeRevalidationRpc(cap, signal, kind)); }
  catch (error) { owner.requestBytes = 0; root.revalidationCredits += 9; throw error; }
}
async function consumeRevalidationRpc(cap: OwnedHttpRevalidation, signal: AbortSignal, kind: "snapshot" | "inspect"): Promise<void> {
  const owner = revalidationOwner(cap), sink = ownedHttpSinkOwner(owner.http), root = sinkOwner(sink);
  const acquisition = sinkOrigin(sink, "acquire"), fetching = sinkOrigin(sink, "fetch");
  const readerAcquisition = sinkOrigin(sink, "acquire"), fallbackAcquisition = sinkOrigin(sink, "acquire");
  const reading = sinkOrigin(sink, "read"), cancelling = sinkOrigin(sink, "cancel"), unlocking = sinkOrigin(sink, "unlock");
  const listenerAdd = sinkOrigin(sink, "listener-add"), listenerRemove = sinkOrigin(sink, "listener-remove");
  let response: Response | undefined, reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null | undefined, original: Promise<Response> | undefined, received: Promise<Response> | undefined;
  let closed: Promise<void> | undefined, first: Promise<void> | undefined, input: ReturnType<typeof inputRetirement> | undefined;
  let listener: (() => void) | undefined, wire: IdentityWire | undefined, decoder: TextDecoder | undefined;
  let backing: Uint8Array<ArrayBuffer> | undefined, text = "", graph: unknown, eof = false, byob = false, streamErrored = false;
  let requestBody: string | undefined;
  let hasPrimary = false, primary: unknown, cleanupFailed = false;
  const budget = identitySourceBudget();
  try {
    if (signal.aborted) throw identityFailure("transport");
    const binding = kind === "snapshot" ? owner.env.ACCESS_CONTROL : owner.env.GRANT_CREDENTIALS;
    if (!binding) throw new HttpError(503, "provider_not_configured", "provider is not configured");
    const key = kind === "snapshot" ? "policy-bindings" : owner.upstream.grantKey!;
    let stub: DurableObjectStub | undefined;
    try { stub = binding.get(binding.idFromName(key)); }
    catch (reason) { throw failedSinkOrigin(root, acquisition, reason); }
    requestBody = kind === "snapshot" ? JSON.stringify({ credentialId: owner.auth.credentialId,
      principalId: owner.auth.principalId, policyId: owner.auth.policyId }) : "{}";
    try {
      original = stub.fetch(kind === "snapshot" ? "https://clawrouter.internal/authorization/snapshot" : "https://clawrouter.internal/inspect",
        { method: "POST", body: requestBody, signal });
    } catch (reason) { throw failedSinkOrigin(root, fetching, reason); }
    finally { stub = undefined; }
    // First observer, before any catch/finally can retain the raw rejection.
    try {
      received = original.then(value => { return value; },
        reason => { throw failedSinkOrigin(root, fetching, reason); });
    } catch (reason) { throw failedSinkOrigin(root, fetching, reason); }
    original = undefined;
    response = await received; received = undefined;
    try { body = response.body; }
    catch (reason) { failedSinkOrigin(root, readerAcquisition, reason); root.unknown = true; await new Promise<never>(() => {}); }
    if (!body) throw identityFailure("protocol");
    try { reader = body.getReader({ mode: "byob" }); byob = true; }
    catch (reason) {
      failedSinkOrigin(root, readerAcquisition, reason);
      try { reader = body.getReader(); }
      catch (error) { failedSinkOrigin(root, fallbackAcquisition, error); }
    }
    if (!reader) { root.unknown = true; await new Promise<never>(() => {}); }
    input = inputRetirement({
      cancel() {
        if (!first) {
          try {
            const propagated = root.sinkOrigins!.has(Math.floor(reading / 32)) && streamErrored && byob
              && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype
              && !Object.hasOwn(reader!, "closed") && reader!.cancel === originalByobCancel;
            const work = reader!.cancel();
            first = work.then(() => { }, reason => {
              if (propagated) return;
              cleanupFailed = true; failedSinkOrigin(root, cancelling, reason, false);
            });
          } catch (reason) { cleanupFailed = true; failedSinkOrigin(root, cancelling, reason, false); first = Promise.resolve(); }
        }
        return first;
      },
      releaseLock() {
        try { reader!.releaseLock(); }
        catch (reason) { cleanupFailed = true; failedSinkOrigin(root, unlocking, reason, false); }
      },
    });
    try { closed = reader!.closed.then(() => undefined, () => { streamErrored = true; }); }
    catch (reason) { throw failedSinkOrigin(root, reading, reason); }
    listener = () => { if (!eof && input) void input.retire("cancel"); };
    try { signal.addEventListener("abort", listener, { once: true }); }
    catch (reason) { throw failedSinkOrigin(root, listenerAdd, reason); }
    if (!byob || signal.aborted) throw identityFailure("transport");
    admitIdentityHeaders(response.headers);
    wire = new IdentityWire(); decoder = new TextDecoder(); backing = new Uint8Array(16384);
    for (let reads = 0; ; reads++) {
      if (reads >= 8192) throw identityFailure("limit");
      if (signal.aborted) throw identityFailure("transport");
      let part: ReadableStreamReadResult<Uint8Array<ArrayBuffer>> | undefined;
      try {
        part = await input.read(() => {
          let work: Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>;
          try { work = (reader as ReadableStreamBYOBReader).read(backing!); }
          catch (reason) { throw failedSinkOrigin(root, reading, reason); }
          return work.then(value => value, reason => { throw failedSinkOrigin(root, reading, reason); });
        });
        if (signal.aborted) throw identityFailure("transport");
        if (part.value) {
          if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384) throw identityFailure("limit");
          admitIdentityBytes(budget, part.value.byteLength, 2097152); wire.add(part.value);
          const chunk = decoder.decode(part.value, { stream: !part.done });
          if (chunk.length > 2097152 - text.length) throw identityFailure("limit");
          text += chunk; backing = new Uint8Array(part.value.buffer);
        }
        if (part.done) {
          if (!part.value) { const chunk = decoder.decode(); if (chunk.length > 2097152 - text.length) throw identityFailure("limit"); text += chunk; }
          eof = true; break;
        }
        if (!backing.byteLength) throw identityFailure("transport");
      } finally { part = undefined; }
    }
    try { graph = parseIdentity(text, budget, "complete", kind === "snapshot" ? "authorization-snapshot" : "grant", wire.span); }
    catch (error) { throw isIdentityFailure(error) ? error : identityFailure("protocol"); }
    finally { text = ""; wire.clear(); wire = undefined; decoder = undefined; backing = undefined; }
    await input.retire("eof");
    if (body.locked) { root.unknown = true; await new Promise<never>(() => {}); }
    await closed; closed = undefined; input = undefined; reader = undefined; body = undefined; first = undefined;
    if (cleanupFailed) throw identityFailure("cleanup");
    if (signal.aborted) throw identityFailure("transport");
    if (!response.ok) {
      if (kind === "snapshot") throw identityFailure("transport");
      const payload = graph as { error?: { code?: string; message?: string } };
      const retryAfter = response.headers.get("retry-after");
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "credential_owner_error";
      const message = typeof payload?.error?.message === "string" ? payload.error.message : "grant credential operation failed";
      // This genuine consumed producer error may outlive the source phase.
      // Its retained strings/header occurrence move under the request owner.
      fundRevalidationCopies(owner, 4096 + 8 * (code.length + message.length + (retryAfter?.length ?? 0))
        + 2 * owner.upstream.grantKey!.length);
      throw selectedCredentialFailure(new HttpError(response.status, code, message,
        retryAfter === null ? undefined : { "Retry-After": retryAfter }), owner.upstream.grantKey!);
    }
    owner.graph = graph; owner.graphKind = kind;
    if (kind === "snapshot") acceptOwnedAuthorizationSnapshot(cap, graph);
    else if (owner.selection.provider.id === "venice") acceptOwnedVeniceInspection(cap, graph);
    else acceptOwnedGmiInspection(cap, graph);
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    if (input) {
      await input.retire(eof ? "eof" : "cancel");
      if (body?.locked) { root.unknown = true; await new Promise<never>(() => {}); }
      await closed; closed = undefined;
    } else if (body?.locked) { root.unknown = true; await new Promise<never>(() => {}); }
    if (listener) {
      try { signal.removeEventListener("abort", listener); }
      catch (reason) {
        // A throwing removal does not prove the signal released this closure.
        // Keep its request/foreground funding even when the reader unlocked.
        root.unknown = true; cleanupFailed = true; failedSinkOrigin(root, listenerRemove, reason, false);
      }
    }
    listener = undefined; reader = undefined; input = undefined; first = undefined; body = undefined; response = undefined; original = undefined; received = undefined;
    wire?.clear(); wire = undefined; decoder = undefined; backing = undefined; text = ""; graph = undefined;
    owner.graph = undefined; owner.graphKind = undefined; requestBody = undefined; owner.requestBytes = 0;
    }
  if (cleanupFailed) throw identityFailure("cleanup");
  if (hasPrimary) throw ownedHttpFailureMetadata(primary) ? identityFailure("transport") : primary;
}

export function ownedHttpArchivePut(sink: OwnedHttpSinkOwner, bucket: Env["CONTENT_ARCHIVE"], key: string,
  value: string | ReadableStream<Uint8Array>, expiresAt: string): Promise<void> {
  const owner = sinkOwner(sink);
  if (bucket !== owner.env!.CONTENT_ARCHIVE) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 1); const record = sinkOrigin(sink, "put");
  return sinkOriginal(sink, record, () => bucket.put(key, value, {
    httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt },
  }), true);
}
export function ownedHttpArchivePipe(sink: OwnedHttpSinkOwner, source: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  reserveSinkOrigins(sink, 3); // ORIGINAL pipe, owned abort, original FIRSTcancel.
  const record = sinkOrigin(sink, "pipe");
  return sinkOriginal(sink, record, () => source.pipeTo(writable, { signal }));
}
export function ownedHttpArchiveCancel(sink: OwnedHttpSinkOwner, readable: ReadableStream<Uint8Array>): Promise<void> {
  const record = sinkOrigin(sink, "cancel");
  return sinkOriginal(sink, record, () => readable.cancel());
}
export function ownedHttpArchiveAbort(sink: OwnedHttpSinkOwner, controller: AbortController): void {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "abort");
  try { controller.abort(); } catch (reason) { throw failedSinkOrigin(owner, record, reason); }
}

export function beginOwnedHttpSinkRegistration(sink: OwnedHttpSinkOwner): OwnedHttpSinkRegistration {
  const owner = sinkOwner(sink); reserveSinkOrigins(sink, 1);
  const origin = sinkOrigin(sink, "registration");
  const cap = Object.freeze({}), scope = owner.sinkCustody!.fork();
  (sinkRegistrations ??= new WeakMap()).set(cap, { owner, origin, scope });
  return cap;
}
export function completeOwnedHttpSinkRegistration(cap: OwnedHttpSinkRegistration, context?: Pick<ExecutionContext, "waitUntil">, work?: Promise<void | boolean>): void {
  const receipt = sinkRegistrations?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  sinkRegistrations!.delete(cap);
  try {
    // Joining begins BEFORE calling registration. A throw after start cannot
    // remove this original; no accepted work depends on registration success.
    if (work) enrollOwnedRegistrationWork(receipt.scope, work);
    if (!context || !work) {
      receipt.origin = 32 * Math.floor(receipt.origin / 32) + sinkKinds.indexOf("registration-missing");
      throw failedSinkOrigin(receipt.owner, receipt.origin, 0);
    }
    try { context.waitUntil(work); }
    catch (reason) { throw failedSinkOrigin(receipt.owner, receipt.origin, reason); }
  } finally { receipt.scope.seal(); }
}
function ignoreOwnedRegistrationOutcome(): void {}
function enrollOwnedRegistrationWork(scope: ProxyCompletion, work: Promise<void | boolean>): void {
  scope.startPrivateLeaf(() => work.then(ignoreOwnedRegistrationOutcome, ignoreOwnedRegistrationOutcome));
}
export function abandonUnstartedOwnedHttpRegistration(cap: OwnedHttpSinkRegistration): void {
  const receipt = sinkRegistrations?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  sinkRegistrations!.delete(cap); receipt.scope.seal();
}

export function ownedHttpQueueSend(sink: OwnedHttpSinkOwner, queue: Env["USAGE_QUEUE"], message: QueueMessage): Promise<void> {
  const owner = sinkOwner(sink);
  if (queue !== owner.env!.USAGE_QUEUE) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 1); const record = sinkOrigin(sink, "queue");
  return sinkOriginal(sink, record, () => queue.send(message));
}

export function ownedHttpProviderFetch(sink: OwnedHttpSinkOwner, url: URL, init: RequestInit): Promise<Response> {
  reserveSinkOrigins(sink, 2); // ORIGINAL fetch and an unused/late body's FIRSTcancel.
  const record = sinkOrigin(sink, "fetch");
  return sinkOriginal(sink, record, () => fetch(url, init));
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
  return sinkOriginal(sink, record, () => response.body!.cancel());
}

export async function ownedHttpLedgerFetch(sink: OwnedHttpSinkOwner, namespace: Env["BUDGET_LEDGER"] | Env["USAGE_LEDGER"],
  objectName: string, path: "/reserve" | "/dispatch" | "/charge" | "/settle" | "/ingest", body: string, signal?: AbortSignal): Promise<Response> {
  const owner = sinkOwner(sink);
  if (namespace !== (path === "/ingest" ? owner.env!.USAGE_LEDGER : owner.env!.BUDGET_LEDGER)) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 3); // Acquisition, fetch, then body read OR unused-body cancel.
  const acquisition = sinkOrigin(sink, "acquire"), fetching = sinkOrigin(sink, "fetch");
  let stub: DurableObjectStub | undefined;
  try { stub = namespace.get(namespace.idFromName(objectName)); }
  catch (reason) { throw failedSinkOrigin(owner, acquisition, reason); }
  const result = sinkOriginal(sink, fetching, () => stub!.fetch(`https://clawrouter.internal${path}`, { method: "POST", body, signal }));
  stub = undefined;
  return result;
}

export async function ownedHttpPreflightFetch(sink: OwnedHttpSinkOwner, binding: NonNullable<Env["ACCESS_CONTROL"]>, body: string, signal?: AbortSignal): Promise<Response> {
  const owner = sinkOwner(sink);
  if (binding !== owner.env!.ACCESS_CONTROL) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 2);
  const acquisition = sinkOrigin(sink, "acquire"), fetching = sinkOrigin(sink, "fetch");
  let stub: DurableObjectStub | undefined;
  try { stub = binding.get(binding.idFromName(credentialPreflightNamespace)); }
  catch (reason) { throw failedSinkOrigin(owner, acquisition, reason); }
  const work = sinkOriginal(sink, fetching, () => stub!.fetch(`https://authority${credentialPreflightPath}`, {
    method: "POST", headers: { "content-type": "application/json", [credentialPreflightHeader]: credentialPreflightVersion }, body, signal, redirect: "manual",
  }));
  stub = undefined;
  return work;
}

export function ownedHttpGrantMaterializeFetch(sink: OwnedHttpSinkOwner, binding: NonNullable<Env["GRANT_CREDENTIALS"]>, key: string, body: string, signal?: AbortSignal): Promise<Response> {
  const owner = sinkOwner(sink);
  if (binding !== owner.env!.GRANT_CREDENTIALS) throw identityFailure("protocol");
  reserveSinkOrigins(sink, 2);
  const acquisition = sinkOrigin(sink, "acquire"), fetching = sinkOrigin(sink, "fetch");
  let stub: DurableObjectStub;
  try { stub = binding.get(binding.idFromName(key)); }
  catch (reason) { throw failedSinkOrigin(owner, acquisition, reason); }
  return sinkOriginal(sink, fetching, () => stub.fetch("https://clawrouter.internal/materialize", {
    method: "POST", body, signal, headers: { [identityHeader]: "v1" },
  }));
}

// Non-OK outcome is available immediately. Its original FIRSTcancel remains a
// separate join and may stay pending while the ordinary recovery send proceeds.
export function discardOwnedHttpSinkResponse(sink: OwnedHttpSinkOwner, response: Response): void {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "cancel");
  if (!response.body) { return; }
  if (response.body.locked) { owner.unknown = true; return; }
  const work = sinkOriginal(sink, record, () => response.body!.cancel());
  void work.then(() => undefined, () => undefined);
}

// The terminal owns fifteen fixed operation positions: five ledger fetches,
// five body reads/cancellations, and five queue sends. Recovery does not await
// an unused body's cancellation. Ordinary finalization keeps its existing path.
class OwnedTerminalOperation {
  original?: Promise<unknown>;
  private resolveObservation?: () => void;
  flags = 0;
  constructor(readonly owner: OwnedAccountingTerminal, readonly code: number, readonly origin: number, public subject?: unknown) {}
  observe(original: Promise<unknown>): void {
    this.original = original;
    // A modified actual then method can return before either original outcome.
    // Only our first observer can settle this prepaid physical receipt.
    const observed = new Promise<void>(done => { this.resolveObservation = done; });
    void observed.then(this.settleObservation.bind(this));
    try {
      void original.then(this.accept.bind(this), this.reject.bind(this));
    } catch (reason) { this.unknown(reason); }
    original = undefined as never;
  }
  accept(value: unknown): void {
    try { if (this.code < 10) this.subject = value; this.owner.accept(this.code, value); }
    catch (reason) { this.unknown(reason); }
    finally { value = undefined; this.original = undefined; this.resolveObservation?.(); this.resolveObservation = undefined; }
  }
  reject(reason: unknown): void {
    try {
      failedSinkOrigin(this.owner.root, this.origin, reason); reason = undefined;
      this.owner.reject(this.code);
    } catch (failure) { this.unknown(failure); }
    finally { reason = undefined; this.original = undefined; this.resolveObservation?.(); this.resolveObservation = undefined; }
  }
  private settleObservation(): void {
    // Both first observers return only void, including diagnosed consumer
    // failures. Keep this separate tail: their payload aliases already cleared.
    try { this.retire(); } catch (reason) { this.unknown(reason); }
  }
  syncFailure(reason: unknown): void {
    try { this.reject(reason); }
    catch (failure) { this.unknown(failure); }
    finally { reason = undefined; this.retire(); }
  }
  retire(): void {
    if (this.flags & 3) return;
    this.flags |= 1; this.subject = undefined; this.original = undefined;
    // reject() exposes no carrier. Its first observer and this separate tail
    // have now cleared every payload alias; UNKNOWN never reaches this point.
    // Preserve ordinal/flags in CONTROL, without releasing funding.
    compactRetiredSinkOrigin(this.owner.root, Math.floor(this.origin / 32));
    this.owner.retireOperation(this.code);
  }
  unknown(reason: unknown): void {
    if (this.flags & 2) return;
    this.flags |= 2;
    this.owner.root.unknown = true;
    try { failedSinkOrigin(this.owner.root, sinkOrigin(this.owner.sink, "retire"), reason); }
    catch { /* Observer bookkeeping itself failed; UNKNOWN preserves every slot. */ }
    finally { reason = undefined; }
    // Started work whose observer/consumer failed is still owned. No decrement.
  }
}
class OwnedAccountingTerminal {
  readonly operations: (OwnedTerminalOperation | undefined)[] = new Array(15);
  readonly result: Promise<boolean>;
  readonly retired: Promise<void>;
  resolve!: (ok: boolean) => void;
  resolveRetired!: () => void;
  pending: number;
  physical = 1; // Launch sentinel: synchronous outcomes cannot retire the owner.
  completed = 0;
  launched = 0;
  failures = 0;
  constructor(readonly cap: OwnedHttpRequest, readonly root: RequestOwner, readonly sink: OwnedHttpSinkOwner,
    public sinks: AccountingSinks, public reservation: BudgetReservation, public event: UsageEvent, readonly custody: ProxyCompletion) {
    this.pending = (reservation.charges ?? reservation.reservations).length + 1;
    this.result = new Promise<boolean>(done => { this.resolve = done; });
    this.retired = new Promise<void>(done => { this.resolveRetired = done; });
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
    for (let index = 0; index < count; index++) this.ledger(index);
    this.queue(4);
    this.physical--; this.finishRetirement();
  }
  ledger(index: number): void {
    const charged = !!this.reservation.charges, usage = index === 4;
    const item = usage ? undefined : charged ? this.reservation.charges![index] : this.reservation.reservations[index];
    const request = usage ? this.event : charged
      ? { ...this.reservation.charges![index].request, amountMicros: this.event.actual_cost_micros }
      : { reservationId: this.reservation.reservations[index].reservationId, actualCostMicros: this.event.actual_cost_micros };
    const body = JSON.stringify(request), path = usage ? "/ingest" : charged ? "/charge" : "/settle";
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
    const message: QueueMessage = index === 4 ? this.event : charged
      ? { kind: "budget_charge", ledger: { objectName: item!.objectName }, request: { ...this.reservation.charges![index].request, amountMicros: this.event.actual_cost_micros } }
      : { kind: "budget_settlement", ledger: { objectName: item!.objectName }, request: { reservationId: this.reservation.reservations[index].reservationId, actualCostMicros: this.event.actual_cost_micros } };
    const operation = this.operation(10 + index, "queue", message);
    let original: Promise<void>;
    try { original = this.sinks.queue.send(message); }
    catch (reason) { operation.syncFailure(reason); return; }
    operation.observe(original); original = undefined as never;
  }
  body(index: number, response: Response, cancel: boolean): void {
    const operation = this.operation(5 + index, cancel ? "cancel" : "body", response);
    if (cancel) operation.flags |= 4;
    let original: Promise<unknown>;
    try {
      if (cancel) {
        const body = response.body;
        if (!body) { operation.retire(); return; }
        if (body.locked) { operation.unknown(undefined); return; }
        original = body.cancel();
      } else original = response.json<unknown>();
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
      if (this.operations[code]!.flags & 4) return;
      const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const valid = index === 4 ? item?.eventId === this.event.id && (item.outcome === "stored" || item.outcome === "duplicate" || item.outcome === "expired_by_retention")
        : this.reservation.charges ? item?.charged === true && item.chargeId === this.reservation.charges[index].request.chargeId : item?.settled === true;
      if (valid || index === 4) this.complete(index, !!valid); else this.queue(index);
    } else this.complete(code - 10, true);
  }
  reject(code: number): void {
    if (code < 5) { if (code === 4) this.complete(4, false); else this.queue(code); }
    else if (code < 10) {
      if (this.operations[code]!.flags & 4) return; // Diagnostic cleanup, not a new recovery.
      if (code === 9) this.complete(4, false); else this.queue(code - 5);
    } else if (code === 14) this.ledger(4);
    else this.complete(code - 10, false);
  }
  complete(index: number, ok: boolean): void {
    if (this.completed & (1 << index)) throw identityFailure("protocol");
    this.completed |= 1 << index;
    if (!ok) this.failures |= index === 4 ? 2 : 1;
    if (--this.pending) return;
    if (this.failures) {
      this.custody.fail(); // BEFORE false can complete the accounting receipt.
      if (this.failures & 1) logCorrelationError("accounting finalization failed", this.event.request_id);
      if (this.failures & 2) logCorrelationError("accounting finalization failed", this.event.request_id);
    }
    this.resolve(!this.failures);
  }
  retireOperation(code: number): void {
    this.operations[code] = undefined;
    this.physical--; this.finishRetirement();
  }
  finishRetirement(): void {
    if (this.physical || this.pending || this.root.unknown) return;
    this.operations.length = 0; this.sinks = undefined as never; this.reservation = undefined as never; this.event = undefined as never;
    this.resolve = undefined as never; this.resolveRetired(); this.resolveRetired = undefined as never;
  }
}
export function prepareOwnedHttpAccounting(cap: OwnedHttpRequest): void {
  const root = requestOwner(cap);
  if (root.accountingCredits !== undefined) return;
  // Before the initial admission can commit a choice. Preparation and final
  // receivers overlap; at most one terminal can start for this HTTP invocation.
  growOwnedHttpRequest(cap, 2 * 4096 + 8192 + 1024);
  reserveSinkOrigins(root.sink!, 35);
  root.accountingCredits = 2;
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
export function startOwnedHttpAccountingTerminal(cap: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, sinks: AccountingSinks,
  reservation: BudgetReservation, event: UsageEvent, custody: ProxyCompletion): Promise<boolean> {
  const root = requestOwner(cap), sink = root.sink!;
  if (root.unknown || sinks.ownedHttp !== sink || !matchesOwnedHttpAccountingCommand(cap, accounting, sinks, custody, event, reservation)
    || sinks.budget !== root.env!.BUDGET_LEDGER || sinks.usage !== root.env!.USAGE_LEDGER || sinks.queue !== root.env!.USAGE_QUEUE
    || (reservation.charges ?? reservation.reservations).length > 4) throw identityFailure("protocol");
  // These exact positions are prospective metadata, not a new arena/limit. The
  // complete event/request capsule was admitted by the genuine accounting owner.
  const terminal = new OwnedAccountingTerminal(cap, root, sink, sinks, reservation, event, custody);
  custody.startPrivateLeaf(() => terminal.retired);
  terminal.start();
  return terminal.result;
}

// Closed scalar acknowledgment; no parsed response graph or graph-valued
// promise leaves this command. The actual native Response owns its body read.
export async function readOwnedHttpSinkAcknowledgment(sink: OwnedHttpSinkOwner, response: Response, expectedId?: string): Promise<{
  allowed?: boolean; dispatched?: boolean; charged?: boolean; settled?: boolean; chargeId?: string;
  eventId?: string; outcome?: "stored" | "duplicate" | "expired_by_retention";
}> {
  const record = sinkOrigin(sink, "body");
  let original: Promise<unknown> | undefined, value: unknown;
  try {
    original = sinkOriginal(sink, record, () => response.json<unknown>());
    value = await original; original = undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const item = value as Record<string, unknown>;
    return {
      ...(typeof item.allowed === "boolean" ? { allowed: item.allowed } : {}),
      ...(typeof item.dispatched === "boolean" ? { dispatched: item.dispatched } : {}),
      ...(typeof item.charged === "boolean" ? { charged: item.charged } : {}),
      ...(typeof item.settled === "boolean" ? { settled: item.settled } : {}),
      ...(expectedId !== undefined && item.chargeId === expectedId ? { chargeId: expectedId } : {}),
      ...(expectedId !== undefined && item.eventId === expectedId ? { eventId: expectedId } : {}),
      ...(item.outcome === "stored" || item.outcome === "duplicate" || item.outcome === "expired_by_retention" ? { outcome: item.outcome } : {}),
    };
  } finally { value = undefined; original = undefined; response = undefined as never; }
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

export function beginOwnedHttpRequest(request: Request, env: Env): OwnedHttpRequest {
  const funding = ExactBodyCharge.reserve(requestMetadataBytes);
  if (!funding) throw identityFailure("limit");
  try {
    if (!requests) {
      const registry = ExactBodyCharge.reserve(1024);
      if (!registry) throw identityFailure("limit");
      registryFunding = registry; requests = new WeakMap(); uploads = new WeakMap();
    }
    // Terminal registration is included in entry funding, before any input or
    // original work. A later capacity denial cannot need fresh cleanup credit.
    const terminalRegistration = sinkKinds.indexOf("registration");
    const sink = Object.freeze({});
    const owner: RequestOwner = { request, env, funding, completion: new ProxyCompletion(), uploads: [],
      sealed: false, unknown: false, sink, sinkCustody: new ProxyCompletion(), sinkOrigins: new Map(), nextSinkOrigin: 1, sinkCredits: 2, revalidationCredits: 0,
      terminalRegistration, budgetDenials: new WeakSet() };
    const cap = Object.freeze({});
    sinkOwners ??= new WeakMap(); sinkFailures ??= new WeakSet();
    sinkOwners.set(sink, owner); requests.set(cap, owner); requestCount++;
    return cap;
  } catch (error) { funding.release(); throw error; }
}

export function checkOwnedHttpRequest(cap: OwnedHttpRequest, request: Request, env: Env): void {
  const owner = requestOwner(cap);
  if (owner.sealed || owner.request !== request || owner.env !== env) throw identityFailure("protocol");
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
  growOwnedHttpRequest(cap, 1024); reserveSinkOrigins(ownedHttpSinkOwner(cap), 7);
  const owner = requestOwner(cap), sink = ownedHttpSinkOwner(cap);
  const acquire = sinkOrigin(sink, "acquire"), read = sinkOrigin(sink, "read");
  const cancel = sinkOrigin(sink, "cancel"), unlock = sinkOrigin(sink, "unlock");
  const closed = sinkOrigin(sink, "closed"), listenerAdd = sinkOrigin(sink, "abort"), listenerRemove = sinkOrigin(sink, "abort");
  const receipt = Object.freeze({});
  (intakes ??= new WeakMap()).set(receipt, { owner, acquire, read, cancel, unlock, closed, listenerAdd, listenerRemove });
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
const originalReaderClosed = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "closed")?.get;
const originalLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
class OwnedPublicReader {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private flags = 0;
  private reading?: Promise<void>;
  private originalRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  private cancelling?: Promise<void>;
  private unlocking?: Promise<void>;
  private closed?: Promise<void>;
  private pulling?: Promise<void>;
  private nativeFailure?: object;
  private resolve!: () => void;
  readonly retired = new Promise<void>(done => { this.resolve = done; });
  constructor(private cap: OwnedHttpRequest, private owner: RequestOwner, private scope: ProxyCompletion,
    private original: Response | undefined, private body: ReadableStream<Uint8Array> | undefined,
    private base: number, private publicBoundary: boolean) {}
  private failure(offset: number, kind: SinkOrigin, reason: unknown): SinkOriginRecord {
    const ordinal = this.base + offset, known = this.owner.sinkOrigins!.has(ordinal);
    const failure = failedSinkOrigin(this.owner, 32 * ordinal + sinkKinds.indexOf(kind), reason);
    if (!known) retainOwnedDiagnostic(this.owner, failure);
    return failure;
  }
  private propagated(reason: unknown): boolean {
    const forwarded = this.publicBoundary && matchesOwnedHttpPublicBody(this.cap, this.body ?? null);
    if (!this.publicBoundary || forwarded) for (const codec of this.owner.revalidations ?? []) {
      if (forwarded && matchesOwnedCodecOutputFailure(codec, this.body ?? null, reason)) return true;
      if (matchesOwnedVeniceOutputBody(codec, this.body ?? null) && matchesOwnedVeniceOutputFailure(codec, reason)) return true;
    }
    return false;
  }
  open(): void {
    if (!this.original || !this.body) throw identityFailure("protocol");
    try { this.reader = this.body!.getReader(); }
    catch (reason) { throw this.failure(0, "acquire", reason); }
    let resolve!: () => void;
    this.closed = new Promise<void>(done => { resolve = done; });
    let following = false;
    try {
      const reader = this.reader;
      if (Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
        && typeof originalLookupGetter === "function" && originalLookupGetter.call(reader, "closed") === originalReaderClosed) this.flags |= 8;
      let original: Promise<void> | undefined = reader.closed;
      following = true;
      const then = original.then; if (then !== ownedBoundaryThen) this.flags &= ~8;
      void Reflect.apply(then, original, [() => { resolve(); }, (reason: unknown) => {
        this.flags |= 16;
        if (!(this.flags & 8 && (this.nativeFailure || this.propagated(reason)))) {
          const failure = this.failure(4, "closed", reason);
          if (this.flags & 8) this.nativeFailure = failure;
        }
        reason = undefined; resolve();
      }]);
      original = undefined;
    } catch (reason) {
      const failure = this.failure(4, "closed", reason); reason = undefined;
      if (following) holdOwnedHttpRequest(this.cap); else resolve();
      throw failure;
    }
  }
  private read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.flags & 1 || this.reading || !this.reader) throw identityFailure("protocol");
    let resolve!: () => void;
    const joined = new Promise<void>(done => { resolve = done; });
    this.reading = joined;
    let accept!: (value: ReadableStreamReadResult<Uint8Array>) => void, reject!: (reason: unknown) => void;
    const observed = new Promise<ReadableStreamReadResult<Uint8Array>>((yes, no) => { accept = yes; reject = no; });
    try {
      const reader = this.reader, method = reader.read;
      let native = !!(this.flags & 8) && Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
        && !Object.hasOwn(reader, "closed") && method === originalReaderRead;
      this.originalRead = Reflect.apply(method, reader, []);
      const then = this.originalRead!.then; native &&= then === ownedBoundaryThen;
      void Reflect.apply(then, this.originalRead, [(value: ReadableStreamReadResult<Uint8Array>) => {
        if (this.reading !== joined) return;
        try { accept({ done: value.done, value: value.value } as ReadableStreamReadResult<Uint8Array>); }
        catch (reason) { reject(this.failure(1, "read", reason)); reason = undefined; }
        finally { value = undefined as never; this.originalRead = undefined; if (this.reading === joined) this.reading = undefined; resolve(); }
      }, (reason: unknown) => {
        if (this.reading !== joined) return;
        this.originalRead = undefined;
        this.flags |= 32;
        const failure = native && this.nativeFailure ? this.nativeFailure
          : native && this.propagated(reason) ? reason as object : this.failure(1, "read", reason); reason = undefined;
        if (native) this.nativeFailure = failure;
        reject(failure); if (this.reading === joined) this.reading = undefined; resolve();
      }]);
    } catch (reason) {
      const failure = this.failure(1, "read", reason); reason = undefined;
      if (this.reading !== joined) return observed.then(() => { throw failure; }, () => { throw failure; });
      if (this.originalRead) { holdOwnedHttpRequest(this.cap); reject(failure); return observed; }
      reject(failure); if (this.reading === joined) this.reading = undefined; resolve();
    }
    return observed;
  }
  private unlock(): void {
    if (this.flags & 2) return;
    this.flags |= 2;
    let resolve!: () => void;
    this.unlocking = new Promise<void>(done => { resolve = done; });
    if (!this.reader) { resolve(); return; }
    let following = false;
    try {
      let original: unknown;
      { const reader = this.reader, method = reader.releaseLock; original = Reflect.apply(method, reader, []); }
      if (original === undefined) { resolve(); return; }
      following = true;
      void Promise.resolve(original).then(() => { resolve(); }, reason => {
        this.failure(3, "unlock", reason); reason = undefined; this.scope.fail(); resolve();
      });
      original = undefined;
    } catch (reason) {
      this.failure(3, "unlock", reason); reason = undefined; this.scope.fail();
      if (following) holdOwnedHttpRequest(this.cap); else resolve();
    }
  }
  retire(cancel: boolean): Promise<void> {
    if (this.flags & 1) return this.retired;
    this.flags |= 1;
    const reading = this.reading, pulling = this.pulling;
    if (cancel) {
      let resolve!: () => void;
      this.cancelling = new Promise<void>(done => { resolve = done; });
      let following = false;
      try {
        let original: Promise<void> | undefined, native = false;
        if (this.reader) {
          const reader = this.reader, method = reader.cancel;
          native = !!(this.flags & 8) && Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
            && !Object.hasOwn(reader, "closed") && method === originalReaderCancel;
          original = Reflect.apply(method, reader, []);
        } else if (this.body && !this.body.locked) original = this.body.cancel();
        else if (!this.body) { resolve(); }
        else { holdOwnedHttpRequest(this.cap); }
        if (original) {
          following = true;
          const then = original.then; native &&= then === ownedBoundaryThen;
          void Reflect.apply(then, original, [() => { resolve(); }, (reason: unknown) => {
            if (!(native && this.nativeFailure && (this.flags & 16))) { this.failure(2, "cancel", reason); this.scope.fail(); }
            reason = undefined; resolve();
          }]);
          original = undefined;
        }
      } catch (reason) {
        this.failure(2, "cancel", reason); reason = undefined; this.scope.fail();
        if (following) holdOwnedHttpRequest(this.cap); else resolve();
      }
    }
    // This tail is outside each public pull; it never joins its own completion.
    const original = (async () => {
      await reading; await this.cancelling;
      this.unlock(); await this.unlocking; await this.closed; await pulling;
      try { if (this.body?.locked) { holdOwnedHttpRequest(this.cap); return; } }
      catch (reason) { this.failure(7, "retire", reason); holdOwnedHttpRequest(this.cap); return; }
      this.reader = undefined; this.body = undefined; this.original = undefined;
      this.reading = undefined; this.originalRead = undefined; this.cancelling = undefined; this.unlocking = undefined; this.closed = undefined; this.pulling = undefined;
      this.nativeFailure = undefined; this.resolve();
    })();
    void original.then(() => undefined, reason => { this.failure(7, "retire", reason); holdOwnedHttpRequest(this.cap); });
    this.scope.seal();
    return this.retired;
  }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.flags & 1) return Promise.resolve();
    let resolve!: () => void;
    const joined = new Promise<void>(done => { resolve = done; });
    this.pulling = joined;
    let original: Promise<void>;
    try { original = this.scope.startPrivateLeaf(() => this.next(controller)); }
    catch (reason) { const failure = this.failure(8, "registration", reason); reason = undefined; resolve(); void this.retire(true); throw failure; }
    return original.then(() => { if (this.pulling === joined) this.pulling = undefined; resolve(); }, reason => {
      this.failure(5, "pull", reason); reason = undefined;
      if (this.pulling === joined) this.pulling = undefined; resolve(); void this.retire(true);
    });
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let reading = true;
    try {
      let next: ReadableStreamReadResult<Uint8Array> | undefined = await this.read();
      reading = false;
      if (this.flags & 1) { next = undefined; return; }
      if (next.done) { next = undefined; controller.close(); void this.retire(false); }
      else { controller.enqueue(next.value); next = undefined; }
    } catch (reason) {
      const failure = reading ? reason : this.failure(5, "pull", reason); reason = undefined;
      if (!(this.flags & 1)) {
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
  let headerUnits = 0, headerPairs = 0;
  let body: ReadableStream<Uint8Array>;
  try {
    const actual = response.body;
    if (!actual) return response;
    body = actual;
    response.headers.forEach((value, key) => { headerUnits += value.length + key.length; headerPairs++; });
  } catch (reason) {
    const failure = failedSinkOrigin(owner, 32 * base + sinkKinds.indexOf("acquire"), reason);
    retainOwnedDiagnostic(owner, failure); throw failure;
  }
  if (headerPairs || headerUnits) growOwnedHttpRequest(cap, 32 * headerPairs + 4 * headerUnits);
  const scope = owner.completion.fork();
  let reader: OwnedPublicReader | undefined;
  try {
    reader = new OwnedPublicReader(cap, owner, scope, response, body, base, publicBoundary);
    scope.startPrivateLeaf(() => reader!.retired);
    reader.open();
    return new Response(new ReadableStream<Uint8Array>(reader, { highWaterMark: 0 }),
      { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (reason) {
    scope.fail();
    if (reader) void reader.retire(true); else scope.seal();
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
class OwnedStatusController {
  namespace?: Env["BUDGET_LEDGER"];
  bound = false;
  started = false;
  settled = false;
  private remaining = 0;
  private resolve!: () => void;
  readonly retired = new Promise<void>(done => { this.resolve = done; });
  readonly readers: (OwnedStatusReader | undefined)[] = [];
  constructor(readonly cap: OwnedHttpRequest, readonly root: RequestOwner, readonly plan: PreparedSoftBudget) {}
  start(): void {
    if (this.started || this.settled || !this.bound) throw identityFailure("protocol");
    this.started = true; this.remaining = this.plan.descriptors.length;
    for (let index = 0; index < this.plan.descriptors.length; index++) {
      if (this.plan.descriptors[index].leg.request.limitMicros === 0) { this.decide(index, true, null); this.readers[index] = undefined; this.complete(); continue; }
      this.readers[index]!.start();
    }
    if (!this.remaining) this.finish();
  }
  decide(index: number, succeeded: boolean, spent: number | null): void { acceptOwnedHttpSoftStatus(this.cap, index, succeeded, spent); }
  retire(index: number, reader: OwnedStatusReader): void {
    if (this.readers[index] !== reader) throw identityFailure("protocol");
    this.readers[index] = undefined; this.complete();
  }
  private complete(): void { if (!--this.remaining) this.finish(); }
  private finish(): void {
    if (this.settled) return;
    this.namespace = undefined; this.settled = true; this.resolve();
  }
  abandonUnstarted(): void {
    if (this.started) return;
    this.readers.length = 0; this.finish();
  }
}
class OwnedStatusReader {
  private response?: Response;
  private original?: Promise<unknown>;
  private body?: ReadableStream<Uint8Array>;
  private reader?: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  private flags = 0;
  private reading?: Promise<void>;
  private resolveRead?: () => void;
  private acceptRead?: (value: ReadableStreamReadResult<Uint8Array>) => void;
  private rejectRead?: (reason: unknown) => void;
  private resolveClosed?: () => void;
  private cancelling?: Promise<void>;
  private unlocking?: Promise<void>;
  private closed?: Promise<void>;
  private nativeFailure?: object;
  private acquisition?: SinkOriginOwner;
  private fetching?: SinkOriginOwner;
  private base?: number;
  constructor(private owner: OwnedStatusController, private index: number) {}
  start(): void {
    const original = this.run();
    void original.then(this.retired.bind(this), this.unsettled.bind(this));
  }
  private retired(): void {
    try {
      if (this.original || this.reader || this.body || this.response || this.reading || this.cancelling || this.unlocking || this.closed)
        throw identityFailure("protocol");
      const root = this.owner.root;
      if (this.acquisition !== undefined) compactRetiredSinkOrigin(root, Math.floor(this.acquisition / 32));
      if (this.fetching !== undefined) compactRetiredSinkOrigin(root, Math.floor(this.fetching / 32));
      if (this.base !== undefined) for (let index = 0; index < 9; index++) compactRetiredSinkOrigin(root, this.base + index);
      this.owner.retire(this.index, this); this.owner = undefined as never;
    } catch (reason) { this.unsettled(reason); }
  }
  private unsettled(reason: unknown): void {
    this.failure(10, "retire", reason); reason = undefined;
    holdOwnedHttpRequest(this.owner.cap);
  }
  private claimReader(): number {
    if (this.base !== undefined) return this.base;
    const root = this.owner.root;
    if (root.sinkCredits < 9) throw identityFailure("protocol");
    this.base = root.nextSinkOrigin; root.nextSinkOrigin += 9; root.sinkCredits -= 9;
    return this.base;
  }
  failure(offset: number, kind: SinkOrigin, reason: unknown): SinkOriginRecord {
    const origin = offset === 0 ? this.acquisition! : offset === 1 ? this.fetching!
      : 32 * (this.claimReader() + offset - 2) + sinkKinds.indexOf(kind);
    return failedSinkOrigin(this.owner.root, origin, reason);
  }
  private async acquire(): Promise<void> {
    const descriptor = this.owner.plan.descriptors[this.index], namespace = this.owner.namespace;
    this.acquisition = sinkOrigin(this.owner.root.sink!, "acquire");
    let stub: DurableObjectStub;
    try { if (!namespace) throw softStatusError(); stub = namespace.get(namespace.idFromName(descriptor.leg.objectName)); }
    catch (reason) { throw this.failure(0, "acquire", reason); }
    this.fetching = sinkOrigin(this.owner.root.sink!, "fetch");
    // Reuse these slots only before reader acquisition. The actual callbacks,
    // never an overridden .then return, settle this private void receipt.
    const following = new Promise<void>((resolve, reject) => { this.resolveRead = resolve; this.rejectRead = reject; });
    let observing = false;
    try {
      this.original = stub.fetch(descriptor.url);
      const then = this.original.then;
      observing = true;
      void Reflect.apply(then, this.original, [this.fetchResolved.bind(this), this.fetchRejected.bind(this)]);
    } catch (reason) {
      const failure = this.failure(1, "fetch", reason); reason = undefined;
      if (observing || this.original) { holdOwnedHttpRequest(this.owner.cap); await new Promise<never>(() => {}); }
      this.rejectRead!(failure); this.resolveRead = undefined; this.rejectRead = undefined;
    }
    stub = undefined as never;
    await following;
    this.claimReader();
    try { this.body = this.response!.body ?? undefined; }
    catch (reason) { this.failure(2, "acquire", reason); holdOwnedHttpRequest(this.owner.cap); await new Promise<never>(() => {}); }
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
    if (!this.resolveRead) return;
    this.response = response; response = undefined as never; this.original = undefined;
    this.resolveRead(); this.resolveRead = undefined; this.rejectRead = undefined;
  }
  private fetchRejected(reason: unknown): void {
    if (!this.resolveRead) return;
    const failure = this.failure(1, "fetch", reason); reason = undefined; this.original = undefined;
    this.rejectRead!(failure); this.resolveRead = undefined; this.rejectRead = undefined;
  }
  private observeClosed(): void {
    this.closed = new Promise<void>(done => { this.resolveClosed = done; });
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
      void Reflect.apply(then, original, [this.closedResolved.bind(this), this.closedRejected.bind(this)]);
      original = undefined;
    } catch (reason) {
      const failure = this.failure(8, "closed", reason); reason = undefined;
      if (observing) holdOwnedHttpRequest(this.owner.cap); else this.closedResolved();
      throw failure;
    }
  }
  private closedResolved(): void { if (!this.resolveClosed) return; this.resolveClosed(); this.resolveClosed = undefined; }
  private closedRejected(reason: unknown): void {
    if (!this.resolveClosed) return;
    this.flags |= 4;
    if (!(this.flags & 2 && this.nativeFailure)) {
      const failure = this.failure(8, "closed", reason);
      if (this.flags & 2) this.nativeFailure = failure;
    }
    reason = undefined; this.closedResolved();
  }
  private read(backing: Uint8Array<ArrayBuffer>): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.reading || !(this.flags & 1) || !this.reader) throw softStatusError();
    this.reading = new Promise<void>(done => { this.resolveRead = done; });
    const outcome = new Promise<ReadableStreamReadResult<Uint8Array>>((accept, reject) => { this.acceptRead = accept; this.rejectRead = reject; });
    this.flags &= ~32;
    try {
      const reader = this.reader as ReadableStreamBYOBReader, method = reader.read;
      if ((this.flags & 2) && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype && method === ownedStatusNativeRead) this.flags |= 32;
      this.original = Reflect.apply(method, reader, [backing]);
      const then = this.original!.then; if (then !== ownedBoundaryThen) this.flags &= ~32;
      // The actual observer's return value is not a settlement receipt. Our
      // outcome/physical joins are completed only by its first actual callback.
      void Reflect.apply(then, this.original, [this.readResolved.bind(this), this.readRejected.bind(this)]);
    } catch (reason) {
      const failure = this.failure(5, "read", reason); reason = undefined;
      if (this.original) { holdOwnedHttpRequest(this.owner.cap); this.rejectRead!(failure); }
      else this.readRejected(failure);
    }
    return outcome;
  }
  private settleRead(): void {
    this.original = undefined; this.acceptRead = undefined; this.rejectRead = undefined;
    this.resolveRead!(); this.resolveRead = undefined; this.reading = undefined;
  }
  private readResolved(value: ReadableStreamReadResult<Uint8Array>): void {
    if (!this.resolveRead) return;
    try {
      // Only the native read pair enters our private outcome; no foreign then
      // property or other result-record alias is assimilated by that Promise.
      const received = { done: value.done, value: value.value } as ReadableStreamReadResult<Uint8Array>;
      value = undefined as never; this.acceptRead!(received); this.settleRead();
    } catch (reason) { this.readRejected(reason); }
  }
  private readRejected(reason: unknown): void {
    if (!this.resolveRead) return;
    const failure = this.flags & 32 && this.nativeFailure ? this.nativeFailure : this.failure(5, "read", reason);
    if (this.flags & 32) this.nativeFailure = failure;
    reason = undefined; this.rejectRead!(failure); this.settleRead();
  }
  private cancel(): void {
    if (this.cancelling || this.flags & 8) return;
    let resolve!: () => void; this.cancelling = new Promise<void>(done => { resolve = done; });
    let observing = false;
    try {
      let original: Promise<void> | undefined, native = false;
      if (this.reader) {
        const reader = this.reader, method = reader.cancel;
        native = !!(this.flags & 2) && Object.getPrototypeOf(reader) === (this.flags & 1 ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
          && method === (this.flags & 1 ? ownedStatusNativeCancel : originalReaderCancel);
        original = Reflect.apply(method, reader, ["soft budget observation stopped"]);
      } else if (!this.body) { resolve(); return; }
      else if (this.body.locked) { holdOwnedHttpRequest(this.owner.cap); return; }
      else original = this.body.cancel();
      observing = true;
      const then = original!.then; native &&= then === ownedBoundaryThen;
      void Reflect.apply(then, original, [() => { resolve(); }, (reason: unknown) => {
        if (!(native && this.nativeFailure && this.flags & 4)) { this.failure(6, "cancel", reason); this.flags |= 16; }
        reason = undefined; resolve();
      }]);
      original = undefined;
    } catch (reason) {
      this.failure(6, "cancel", reason); reason = undefined; this.flags |= 16;
      if (observing) holdOwnedHttpRequest(this.owner.cap); else resolve();
    }
  }
  private unlock(): void {
    if (this.unlocking) return;
    let resolve!: () => void; this.unlocking = new Promise<void>(done => { resolve = done; });
    if (!this.reader) { resolve(); return; }
    let observing = false;
    try {
      let original: unknown;
      { const reader = this.reader, method = reader.releaseLock; original = Reflect.apply(method, reader, []); }
      if (original === undefined) { resolve(); return; }
      observing = true;
      void Promise.resolve(original).then(() => { resolve(); }, reason => {
        this.failure(7, "unlock", reason); reason = undefined; this.flags |= 16; resolve();
      });
      original = undefined;
    } catch (reason) {
      this.failure(7, "unlock", reason); reason = undefined; this.flags |= 16;
      if (observing) holdOwnedHttpRequest(this.owner.cap); else resolve();
    }
  }
  async run(): Promise<void> {
    let observed = false, spent: number | null = null;
    try {
      await this.acquire();
      let headers = 0, units = 0, ok = false;
      try { this.response!.headers.forEach((value, key) => {
        if (++headers > softStatusLimits.headers || key.length > softStatusLimits.headerBytes - units) throw softStatusError();
        units += key.length;
        if (value.length > softStatusLimits.headerBytes - units) throw softStatusError();
        units += value.length;
      }); ok = this.response!.ok; } catch (reason) { throw this.failure(4, "acquire", reason); }
      if (!ok) observed = true;
      else {
        if (!(this.flags & 1) || !this.reader) throw softStatusError();
        let backing = new Uint8Array(softStatusLimits.backing), wire = 0, reads = 0, text = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          if (reads++ >= softStatusLimits.reads) throw softStatusError();
          let part: ReadableStreamReadResult<Uint8Array> | undefined = await this.read(backing);
          let bytes = part.value;
          if (bytes) {
            if (!(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > softStatusLimits.backing || bytes.byteLength > softStatusLimits.wire - wire) throw softStatusError();
            wire += bytes.byteLength;
            const chunk = decoder.decode(bytes, { stream: !part.done });
            if (chunk.length > softStatusLimits.wire - text.length) throw softStatusError();
            text += chunk; backing = new Uint8Array(bytes.buffer);
          }
          const done = part.done; part = undefined;
          if (done) {
            if (!bytes) { const tail = decoder.decode(); if (tail.length > softStatusLimits.wire - text.length) throw softStatusError(); text += tail; }
            bytes = undefined; this.flags |= 8; break;
          }
          bytes = undefined;
          if (!backing.byteLength) throw softStatusError();
        }
        let value = parseSoftStatus(text); text = "";
        if (value && typeof value === "object" && "spentMicros" in value) {
          const candidate = (value as { spentMicros?: unknown }).spentMicros;
          if (typeof candidate === "number" && Number.isSafeInteger(candidate)) spent = candidate;
        }
        value = undefined; observed = true;
      }
    } catch { observed = false; }
    // No result reaches the cache/denial command until original cleanup ends.
    this.cancel(); await this.reading; await this.cancelling;
    this.unlock(); await this.unlocking;
    if (this.body?.locked) { holdOwnedHttpRequest(this.owner.cap); await new Promise<never>(() => {}); }
    // The added independent closed observation is diagnostic/custody only. It
    // cannot delay the ordinary decision after its read/cancel/unlock boundary.
    this.owner.decide(this.index, observed && !(this.flags & 16), spent);
    await this.closed;
    if (this.body?.locked) { holdOwnedHttpRequest(this.owner.cap); await new Promise<never>(() => {}); }
    this.reader = undefined; this.body = undefined; this.response = undefined; this.original = undefined;
    this.reading = undefined; this.resolveRead = undefined; this.acceptRead = undefined; this.rejectRead = undefined; this.resolveClosed = undefined; this.cancelling = undefined; this.unlocking = undefined; this.closed = undefined; this.nativeFailure = undefined;
  }
}
export function prepareOwnedHttpSoftStatus(cap: OwnedHttpRequest, env: Env, plan: PreparedSoftBudget): void {
  const root = requestOwner(cap);
  if (root.sealed || root.unknown || root.env !== env || root.softStatus || !matchesOwnedHttpSoftStatusPlan(cap, env, plan)
    || plan.descriptors.length > 4) throw identityFailure("protocol");
  // Four complete source/read/text/graph overlaps, plus fixed decision metadata.
  growOwnedHttpRequest(cap, 4096 + plan.descriptors.length * ownedStatusData);
  reserveSinkOrigins(ownedHttpSinkOwner(cap), 1 + 11 * plan.descriptors.length);
  const state = new OwnedStatusController(cap, root, plan); root.softStatus = state;
  for (let index = 0; index < plan.descriptors.length; index++) {
    state.readers.push(new OwnedStatusReader(state, index));
  }
  root.sinkCustody!.startPrivateLeaf(() => state.retired);
}
export function bindOwnedHttpSoftStatus(cap: OwnedHttpRequest, env: Env, plan: PreparedSoftBudget, operation: HttpOperation): void {
  const root = requestOwner(cap), state = root.softStatus;
  if (!state || state.plan !== plan || state.started || state.settled || root.env !== env
    || !matchesOwnedHttpSoftStatusPlan(cap, env, plan, operation)) throw identityFailure("protocol");
  const origin = sinkOrigin(root.sink!, "acquire");
  try { state.namespace = env.BUDGET_LEDGER; } catch (reason) { throw failedSinkOrigin(root, origin, reason); }
  state.bound = true;
}
export function startOwnedHttpSoftStatus(cap: OwnedHttpRequest): void {
  const state = requestOwner(cap).softStatus;
  if (!state) throw identityFailure("protocol");
  state.start();
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
  const scope = new ProxyCompletion();
  const upload = Object.freeze({});
  const owner: UploadOwner = { cap: upload, request, scope, sink, listenerRemoval, started: false, settled: false, dispatched: false, failures: [] };
  uploads!.set(upload, owner); request.uploads.push(owner);
  try {
    const controller = new AbortController(); owner.controller = controller;
    const signal = request.request!.signal;
    owner.listener = () => controller.abort();
    try { signal.addEventListener("abort", owner.listener, { once: true }); }
    catch (reason) { throw failedSinkOrigin(request, adding, reason); }
    if (signal.aborted) controller.abort();
    return upload;
  } catch (error) { owner.settled = true; scope.fail(); scope.seal(); throw error; }
}

export function checkOwnedHttpUpload(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (owner.started || owner.settled || owner.request.sealed) throw identityFailure("protocol");
}

export function finishOwnedHttpUploadPreparation(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (!owner.started) { if (owner.source) throw identityFailure("protocol"); owner.settled = true; owner.scope.seal(); }
}

export function dispatchOwnedHttpUpload(cap: OwnedHttpUpload): void {
  const owner = uploadOwner(cap);
  if (owner.dispatched || owner.abandonment) throw identityFailure("protocol");
  owner.dispatched = true;
}

// Named preparation handoff. The genuine upload capability was registered
// before either source factory. No replacement reader or second cancel exists.
export function pipeOwnedHttpUpload(cap: OwnedHttpUpload, source: ReadableStream<Uint8Array>, fixed: FixedLengthStream): ReadableStream<Uint8Array> {
  const owner = uploadOwner(cap);
  if (owner.started || owner.settled || !owner.controller) throw identityFailure("protocol");
  owner.source = source; owner.fixed = fixed; owner.started = true;
  try {
    const record = sinkOrigin(owner.sink, "pipe");
    const original = owner.scope.startPrivateLeaf(() => sinkOriginal(owner.sink, record,
      () => source.pipeTo(fixed.writable, { signal: owner.controller!.signal })));
    owner.original = original;
    owner.joined = original.then(() => { owner.settled = true; }, error => {
      owner.settled = true; owner.failures.push(error);
    });
    owner.scope.seal();
    return fixed.readable;
  } catch (error) {
    // This synchronous origin is delivered to the preparation caller. There
    // is no ORIGINAL pipe promise to report again during terminal retirement.
    owner.scope.fail();
    throw error;
  }
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
  try { if (owner.controller) ownedHttpArchiveAbort(owner.sink, owner.controller); } catch (error) { owner.failures.push(error); }
  void (async () => {
    if (owner.original) await owner.joined;
    else if (owner.source) {
      // A lock without our ORIGINAL pipe has no application settlement proof.
      // Preserve the open scope and debit rather than invent cancellation ACK.
      if (owner.source.locked) { owner.request.unknown = true; return; }
      try { await ownedHttpArchiveCancel(owner.sink, owner.source); } catch (error) { owner.failures.push(error); }
      owner.settled = true;
    } else owner.settled = true;
    owner.scope.seal();
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
      if (upload.joined) await upload.joined;
      await upload.scope.completion;
      if (!upload.settled) { owner.unknown = true; continue; }
      failures.push(...upload.failures);
      try { if (upload.listener) owner.request!.signal.removeEventListener("abort", upload.listener); }
      catch (reason) { owner.unknown = true; failures.push(failedSinkOrigin(owner, upload.listenerRemoval, reason)); }
      upload.source = undefined; upload.fixed = undefined; upload.original = undefined; upload.joined = undefined;
      upload.controller = undefined; upload.listener = undefined; upload.failures.length = 0;
      uploads!.delete(upload.cap);
    }
    // Logical accounting/recovery has finished; unused non-OK body retirement
    // can still be pending. It never delayed those recovery decisions above.
    if (owner.sinkCustody) { owner.sinkCustody.seal(); await owner.sinkCustody.completion; }
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
          state.env = undefined as never; state.request = undefined as never; state.attempt = undefined as never;
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
      owner.codecOrigins = undefined;
      owner.uploads.length = 0; owner.request = undefined; owner.env = undefined;
      if (owner.sink) sinkOwners!.delete(owner.sink);
      if (owner.sinkOrigins) for (const origin of owner.sinkOrigins.values()) if (typeof origin !== "number") sinkFailures!.delete(origin);
      owner.sinkOrigins = undefined; owner.sink = undefined; owner.sinkCustody = undefined; owner.terminalRegistration = undefined; owner.budgetDenials = undefined;
      requests!.delete(cap); owner.funding.release();
      if (!--requestCount) { requests = undefined; uploads = undefined; sinkOwners = undefined; sinkFailures = undefined; sinkRegistrations = undefined; intakes = undefined; revalidations = undefined; const funding = registryFunding; registryFunding = undefined; funding?.release(); }
    }
    if (failures.length) throw new AggregateError(failures, "owned HTTP request retirement");
  })();
  void owner.retirement.then(() => undefined, () => undefined);
  return owner.retirement;
}
