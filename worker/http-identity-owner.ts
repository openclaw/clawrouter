import { ExactBodyCharge } from "./body-budget.ts";
import { identityFailure, isIdentityFailure, identityHeader, identitySourceBudget, identityPlan, admitIdentityBytes, admitIdentityHeaders, parseIdentity, IdentityWire } from "./identity-admission.ts";
import { ProxyCompletion } from "./proxy-completion.ts";
import { inputRetirement } from "./input-retirement.ts";
import type { Env, QueueMessage, AuthorizedIdentity } from "./types.ts";
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
import { admitOwnedHttpCodecBacking, retireOwnedHttpCodecBacking, admitOwnedHttpConsumerBacking, retireOwnedHttpConsumerBacking } from "./credential-preflight.ts";
import { retireOwnedHttpProxy, matchesOwnedHttpRevalidationInput, matchesOwnedHttpVeniceResponseInput, matchesOwnedHttpPublicBody, matchesOwnedHttpCodecConsumerInput, matchesOwnedHttpCodecNormalizationInput, matchesOwnedHttpCodecUsageInput, acceptOwnedCodecUsage } from "./proxy.ts";
import { retireOwnedVeniceChatCodec, matchesOwnedVeniceRetirement, consumeOwnedVeniceChatResponse, matchesOwnedVeniceOutputBody, matchesOwnedVeniceOutputFailure, matchesOwnedVeniceConsumerInput } from "./venice-chat-runtime.ts";
import { matchesOwnedCodecConsumerRetirement, retireOwnedCodecConsumers, type OwnedCodecConsumer } from "./proxy-response.ts";
import { credentialPreflightHeader, credentialPreflightVersion, credentialPreflightPath, credentialPreflightNamespace } from "./credential-preflight-protocol.ts";

// This entry is inactive until the named compiled HTTP adapter invokes it.
// Capabilities contain no request, identity, credential or preparation graph.
export interface OwnedHttpRequest { readonly kind?: never }
export interface OwnedHttpUpload { readonly kind?: never }
export interface OwnedHttpSinkOwner { readonly sink?: never }
export interface OwnedHttpSinkRegistration { readonly registration?: never }
export interface OwnedHttpIntakeDiagnostics { readonly intake?: never }
export interface OwnedHttpRevalidation { readonly revalidation?: never }
type SinkOrigin = "acquire" | "fetch" | "body" | "read" | "closed" | "cancel" | "unlock" | "queue" | "put" | "pipe" | "abort" | "pull" | "retire" | "registration" | "registration-missing" | "listener-add" | "listener-remove";
type SinkDisposition = "transport" | "missing" | "conflict" | "protocol";
export interface OwnedHttpFailureMetadata {
  readonly origin: SinkOrigin; readonly ordinal: number; readonly failed: boolean;
  readonly primary: boolean; readonly primaryIsUndefined: boolean; readonly disposition: SinkDisposition;
}
type SinkOriginOwner = { -readonly [K in keyof OwnedHttpFailureMetadata]: OwnedHttpFailureMetadata[K] };
interface OwnedHttpFailureOrigin { readonly origin?: never }
interface FailureOwner { cap: OwnedHttpFailureOrigin; failed: boolean; carrier?: object; record: SinkOriginOwner }

interface RequestOwner {
  request?: Request;
  env?: Env;
  funding: ExactBodyCharge;
  completion: ProxyCompletion;
  uploads: UploadOwner[];
  failures: FailureOwner[];
  sealed: boolean;
  unknown: boolean;
  retirement?: Promise<void>;
  sink?: OwnedHttpSinkOwner;
  sinkCustody?: ProxyCompletion;
  sinkOrigins?: Map<number, SinkOriginOwner>;
  nextSinkOrigin: number;
  sinkCredits: number;
  revalidationCredits: number;
  abortController?: AbortController;
  abortListener?: () => void;
  abortRemoval?: SinkOriginOwner;
  terminalRegistration?: SinkOriginOwner;
  budgetDenials?: WeakSet<object>;
  revalidations?: OwnedHttpRevalidation[];
  codecOrigins?: SinkOriginOwner[];
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
const requestMetadataBytes = 4096 + 4096 + 2 * sinkOriginBytes;
const uploadMetadataBytes = 4096;
const originalReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const originalReaderRead = ReadableStreamDefaultReader.prototype.read;
let requests: WeakMap<OwnedHttpRequest, RequestOwner> | undefined;
let uploads: WeakMap<OwnedHttpUpload, UploadOwner> | undefined;
let failureOrigins: WeakMap<OwnedHttpFailureOrigin, FailureOwner> | undefined;
let registryFunding: ExactBodyCharge | undefined;
let requestCount = 0;
let sinkOwners: WeakMap<OwnedHttpSinkOwner, RequestOwner> | undefined;
let sinkFailures: WeakSet<object> | undefined;
let sinkRegistrations: WeakMap<OwnedHttpSinkRegistration, { owner: RequestOwner; origin: SinkOriginOwner; scope: ProxyCompletion }> | undefined;
type IntakePhase = "acquire" | "read" | "closed" | "cancel" | "unlock" | "listenerAdd" | "listenerRemove" | "abort" | "pull" | "retire";
type IntakeOwner = Partial<Record<IntakePhase, OwnedHttpFailureOrigin>> & { owner: RequestOwner };
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
  catch (reason) { owner.unknown = true; throw failedSinkOrigin(owner.terminalRegistration, reason); }
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
  const owner = sinkOwner(sink);
  if (!owner.sinkCredits) throw identityFailure("protocol");
  owner.sinkCredits--;
  const record: SinkOriginOwner = { origin, ordinal: owner.nextSinkOrigin++,
    failed: false, primary: false, primaryIsUndefined: false, disposition: "transport" };
  owner.sinkOrigins!.set(record.ordinal, record);
  return record;
}
function failedSinkOrigin(record: SinkOriginOwner, reason: unknown, primary = true, disposition: SinkDisposition = "transport"): object {
  // ONLY typeof/presence: no getter, prototype, cause, stack, message or foreign
  // AggregateError inspection. Raw catch values never enter a retained field.
  if (!record.failed) {
    record.failed = true; record.primary = primary; record.primaryIsUndefined = reason === undefined; record.disposition = disposition;
    Object.freeze(record); sinkFailures!.add(record);
  }
  return record;
}
function completedSinkOrigin(owner: RequestOwner, record: SinkOriginOwner): void {
  if (record.failed) return;
  owner.sinkOrigins!.delete(record.ordinal);
  // No descriptor/wrapper or successful history object remains in the owner.
  // The originating reaction's local record clears when that reaction returns.
}

// Internal only: every exported entry below is a closed named native command.
// The first non-async reactions sanitize BEFORE any shared catch/allSettled.
function sinkOriginal<T>(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<T>, discard?: false): Promise<T>;
function sinkOriginal(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<unknown>, discard: true): Promise<void>;
function sinkOriginal(sink: OwnedHttpSinkOwner, record: SinkOriginOwner, start: () => Promise<unknown>, discard = false): Promise<unknown> {
  const owner = sinkOwner(sink);
  let outcome!: Promise<unknown>;
  owner.sinkCustody!.start(() => {
    let original: Promise<unknown> | undefined;
    try { original = start(); }
    catch (reason) {
      outcome = Promise.reject(failedSinkOrigin(record, reason));
      start = undefined as never;
      return outcome.then(() => undefined, () => undefined);
    }
    start = undefined as never;
    outcome = original.then(value => { completedSinkOrigin(owner, record); return discard ? undefined : value; }, reason => { throw failedSinkOrigin(record, reason); });
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
export function fundOwnedHttpVeniceCodec(cap: OwnedHttpRevalidation, codecBytes: number, usageBytes: number): void {
  const owner = revalidationOwner(cap);
  if (owner.selection.provider.id !== "venice") throw identityFailure("protocol");
  admitOwnedHttpCodecBacking(owner.backing, codecBytes, usageBytes); owner.codec = true;
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
  admitOwnedHttpConsumerBacking(owner.backing, 1048576 + 65536 + 96 * pairs + 6 * units);
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
  const ordinal = base + offset;
  let record = root.sinkOrigins!.get(ordinal);
  if (!record) {
    // The same root registry owns the fixed ordinal and every independent
    // origin. Successful operations create no cap, index or record history.
    record = { origin: phase === "listenerAdd" ? "listener-add" : phase === "listenerRemove" ? "listener-remove" : phase,
      ordinal, failed: false, primary: false, primaryIsUndefined: false, disposition: "transport" };
    root.sinkOrigins!.set(ordinal, record);
    const roots = root.codecOrigins ??= [];
    let index = roots.length;
    while (index && roots[index - 1].ordinal > ordinal) { roots[index] = roots[index - 1]; index--; }
    roots[index] = record;
  }
  return failedSinkOrigin(record, reason);
}
export function finishOwnedCodecDiagnostics(cap: OwnedHttpRevalidation, role: OwnedCodecRole): void {
  const owner = codecCustodyOwner(cap), roles = owner.codecRoles ?? 0;
  if (role !== 0 && role !== 1 && role !== 2 || !(roles & 1 << role) || roles & 1 << (role + 3)) throw identityFailure("protocol");
  // No ledger deletion or refund: other roles and UNKNOWN retain this owner.
  owner.codecRoles = roles | 1 << (role + 3);
}
export function ownOwnedCodecConsumerRetirement(http: OwnedHttpRequest, cap: OwnedCodecConsumer, work: Promise<void>): void {
  if (revalidationOwner(cap).http !== http || !matchesOwnedCodecConsumerRetirement(cap, work)) throw identityFailure("protocol");
  requestOwner(http).completion.start(() => work);
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
  owner.codecScope.start(() => work);
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
    try { stub = binding.get(binding.idFromName(key)); completedSinkOrigin(root, acquisition); }
    catch (reason) { throw failedSinkOrigin(acquisition, reason); }
    requestBody = kind === "snapshot" ? JSON.stringify({ credentialId: owner.auth.credentialId,
      principalId: owner.auth.principalId, policyId: owner.auth.policyId }) : "{}";
    try {
      original = stub.fetch(kind === "snapshot" ? "https://clawrouter.internal/authorization/snapshot" : "https://clawrouter.internal/inspect",
        { method: "POST", body: requestBody, signal });
    } catch (reason) { throw failedSinkOrigin(fetching, reason); }
    finally { stub = undefined; }
    // First observer, before any catch/finally can retain the raw rejection.
    try {
      received = original.then(value => { completedSinkOrigin(root, fetching); return value; },
        reason => { throw failedSinkOrigin(fetching, reason); });
    } catch (reason) { throw failedSinkOrigin(fetching, reason); }
    original = undefined;
    response = await received; received = undefined;
    try { body = response.body; }
    catch (reason) { failedSinkOrigin(readerAcquisition, reason); root.unknown = true; await new Promise<never>(() => {}); }
    if (!body) throw identityFailure("protocol");
    try { reader = body.getReader({ mode: "byob" }); byob = true; completedSinkOrigin(root, readerAcquisition); }
    catch (reason) {
      failedSinkOrigin(readerAcquisition, reason);
      try { reader = body.getReader(); completedSinkOrigin(root, fallbackAcquisition); }
      catch (error) { failedSinkOrigin(fallbackAcquisition, error); }
    }
    if (!reader) { root.unknown = true; await new Promise<never>(() => {}); }
    input = inputRetirement({
      cancel() {
        if (!first) {
          try {
            const propagated = reading.failed && streamErrored && byob
              && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype
              && !Object.hasOwn(reader!, "closed") && reader!.cancel === originalByobCancel;
            const work = reader!.cancel();
            first = work.then(() => { completedSinkOrigin(root, cancelling); }, reason => {
              if (propagated) return;
              cleanupFailed = true; failedSinkOrigin(cancelling, reason, false);
            });
          } catch (reason) { cleanupFailed = true; failedSinkOrigin(cancelling, reason, false); first = Promise.resolve(); }
        }
        return first;
      },
      releaseLock() {
        try { reader!.releaseLock(); completedSinkOrigin(root, unlocking); }
        catch (reason) { cleanupFailed = true; failedSinkOrigin(unlocking, reason, false); }
      },
    });
    try { closed = reader!.closed.then(() => undefined, () => { streamErrored = true; }); }
    catch (reason) { throw failedSinkOrigin(reading, reason); }
    listener = () => { if (!eof && input) void input.retire("cancel"); };
    try { signal.addEventListener("abort", listener, { once: true }); completedSinkOrigin(root, listenerAdd); }
    catch (reason) { throw failedSinkOrigin(listenerAdd, reason); }
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
          catch (reason) { throw failedSinkOrigin(reading, reason); }
          return work.then(value => value, reason => { throw failedSinkOrigin(reading, reason); });
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
    completedSinkOrigin(root, reading);
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
      try { signal.removeEventListener("abort", listener); completedSinkOrigin(root, listenerRemove); }
      catch (reason) {
        // A throwing removal does not prove the signal released this closure.
        // Keep its request/foreground funding even when the reader unlocked.
        root.unknown = true; cleanupFailed = true; failedSinkOrigin(listenerRemove, reason, false);
      }
    }
    listener = undefined; reader = undefined; input = undefined; first = undefined; body = undefined; response = undefined; original = undefined; received = undefined;
    wire?.clear(); wire = undefined; decoder = undefined; backing = undefined; text = ""; graph = undefined;
    owner.graph = undefined; owner.graphKind = undefined; requestBody = undefined; owner.requestBytes = 0;
    completedSinkOrigin(root, acquisition); completedSinkOrigin(root, fetching);
    completedSinkOrigin(root, readerAcquisition); completedSinkOrigin(root, fallbackAcquisition);
    completedSinkOrigin(root, reading); completedSinkOrigin(root, cancelling); completedSinkOrigin(root, unlocking);
    completedSinkOrigin(root, listenerAdd); completedSinkOrigin(root, listenerRemove);
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
  const record = sinkOrigin(sink, "abort");
  try { controller.abort(); completedSinkOrigin(sinkOwner(sink), record); } catch (reason) { throw failedSinkOrigin(record, reason); }
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
    if (work) receipt.scope.start(() => work.then(() => undefined, () => undefined));
    if (!context || !work) {
      receipt.origin.origin = "registration-missing";
      throw failedSinkOrigin(receipt.origin, 0);
    }
    try { context.waitUntil(work); completedSinkOrigin(receipt.owner, receipt.origin); }
    catch (reason) { throw failedSinkOrigin(receipt.origin, reason); }
  } finally { receipt.scope.seal(); }
}
export function abandonUnstartedOwnedHttpRegistration(cap: OwnedHttpSinkRegistration): void {
  const receipt = sinkRegistrations?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  sinkRegistrations!.delete(cap); completedSinkOrigin(receipt.owner, receipt.origin); receipt.scope.seal();
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
  try { owner.request!.signal.addEventListener("abort", owner.abortListener, { once: true }); completedSinkOrigin(owner, adding); }
  catch (reason) { throw failedSinkOrigin(adding, reason); }
  if (owner.request!.signal.aborted) owner.abortListener();
  return controller.signal;
}
export function cancelOwnedHttpResponse(sink: OwnedHttpSinkOwner, response: Response): Promise<void> {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "cancel");
  if (!response.body) { completedSinkOrigin(owner, record); return Promise.resolve(); }
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
  catch (reason) { throw failedSinkOrigin(acquisition, reason); }
  completedSinkOrigin(owner, acquisition);
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
  catch (reason) { throw failedSinkOrigin(acquisition, reason); }
  completedSinkOrigin(owner, acquisition);
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
  catch (reason) { throw failedSinkOrigin(acquisition, reason); }
  completedSinkOrigin(owner, acquisition);
  return sinkOriginal(sink, fetching, () => stub.fetch("https://clawrouter.internal/materialize", {
    method: "POST", body, signal, headers: { [identityHeader]: "v1" },
  }));
}

// Non-OK outcome is available immediately. Its original FIRSTcancel remains a
// separate join and may stay pending while the ordinary recovery send proceeds.
export function discardOwnedHttpSinkResponse(sink: OwnedHttpSinkOwner, response: Response): void {
  const owner = sinkOwner(sink), record = sinkOrigin(sink, "cancel");
  if (!response.body) { completedSinkOrigin(owner, record); return; }
  if (response.body.locked) { owner.unknown = true; return; }
  const work = sinkOriginal(sink, record, () => response.body!.cancel());
  void work.then(() => undefined, () => undefined);
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
      registryFunding = registry; requests = new WeakMap(); uploads = new WeakMap(); failureOrigins = new WeakMap();
    }
    // Terminal registration is included in entry funding, before any input or
    // original work. A later capacity denial cannot need fresh cleanup credit.
    const terminalRegistration: SinkOriginOwner = { origin: "registration", ordinal: 0,
      failed: false, primary: false, primaryIsUndefined: false, disposition: "transport" };
    const sink = Object.freeze({});
    const owner: RequestOwner = { request, env, funding, completion: new ProxyCompletion(), uploads: [], failures: [],
      sealed: false, unknown: false, sink, sinkCustody: new ProxyCompletion(), sinkOrigins: new Map([[0, terminalRegistration]]), nextSinkOrigin: 1, sinkCredits: 1, revalidationCredits: 0,
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
function beginOwnedHttpFailureOrigin(cap: OwnedHttpRequest, kind: SinkOrigin): OwnedHttpFailureOrigin {
  const owner = requestOwner(cap);
  growOwnedHttpRequest(cap, 256);
  const origin = Object.freeze({});
  const failure: FailureOwner = { cap: origin, failed: false, record: sinkOrigin(ownedHttpSinkOwner(cap), kind) };
  failureOrigins!.set(origin, failure); owner.failures.push(failure);
  return origin;
}
function rememberOwnedHttpFailure(cap: OwnedHttpFailureOrigin, reason: unknown): object {
  const origin = failureOrigins?.get(cap);
  if (!origin) throw identityFailure("protocol");
  if (!origin.failed) { origin.failed = true; origin.carrier = failedSinkOrigin(origin.record, reason); }
  return origin.carrier!;
}
export function beginOwnedHttpIntakeDiagnostics(cap: OwnedHttpRequest): OwnedHttpIntakeDiagnostics {
  growOwnedHttpRequest(cap, 1024); reserveSinkOrigins(ownedHttpSinkOwner(cap), 6);
  const acquire = beginOwnedHttpFailureOrigin(cap, "acquire"), read = beginOwnedHttpFailureOrigin(cap, "read");
  const cancel = beginOwnedHttpFailureOrigin(cap, "cancel"), unlock = beginOwnedHttpFailureOrigin(cap, "unlock");
  const listenerAdd = beginOwnedHttpFailureOrigin(cap, "abort"), listenerRemove = beginOwnedHttpFailureOrigin(cap, "abort");
  const receipt = Object.freeze({});
  (intakes ??= new WeakMap()).set(receipt, { owner: requestOwner(cap), acquire, read, cancel, unlock, listenerAdd, listenerRemove });
  return receipt;
}
export function ownedHttpIntakeFailure(cap: OwnedHttpIntakeDiagnostics, phase: IntakePhase, reason: unknown): object {
  const receipt = intakes?.get(cap);
  const origin = receipt?.[phase];
  if (!origin) throw identityFailure("protocol");
  return rememberOwnedHttpFailure(origin, reason);
}
export function finishOwnedHttpIntakeDiagnostics(cap: OwnedHttpIntakeDiagnostics): void {
  const receipt = intakes?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  retireIntakeOrigin(receipt, "acquire"); retireIntakeOrigin(receipt, "read");
  retireIntakeOrigin(receipt, "cancel"); retireIntakeOrigin(receipt, "unlock");
  retireIntakeOrigin(receipt, "closed");
  retireIntakeOrigin(receipt, "listenerAdd"); retireIntakeOrigin(receipt, "listenerRemove");
  retireIntakeOrigin(receipt, "abort"); retireIntakeOrigin(receipt, "pull"); retireIntakeOrigin(receipt, "retire");
  intakes!.delete(cap);
}
function retireIntakeOrigin(receipt: IntakeOwner, phase: IntakePhase): void {
  const cap = receipt[phase]; if (!cap) return;
  const origin = failureOrigins?.get(cap);
  // Failed occurrences stay in the root's ordered vector until its final
  // consumer. Successful origins need no history after their original joins.
  if (origin && !origin.failed) {
    const roots = receipt.owner.failures, index = roots.indexOf(origin);
    if (index < 0) throw identityFailure("protocol");
    for (let next = index + 1; next < roots.length; next++) roots[next - 1] = roots[next];
    roots.length--;
    completedSinkOrigin(receipt.owner, origin.record); failureOrigins!.delete(cap);
  }
  receipt[phase] = undefined;
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
function ownHttpResponse(cap: OwnedHttpRequest, response: Response, publicBoundary: boolean): Response {
  const owner = requestOwner(cap);
  if (owner.sealed) throw identityFailure("protocol");
  if (!response.body) return response;
  let headerUnits = 0, headerPairs = 0;
  response.headers.forEach((value, key) => { headerUnits += value.length + key.length; headerPairs++; });
  growOwnedHttpRequest(cap, 4096 + 32 * headerPairs + 4 * headerUnits); reserveSinkOrigins(ownedHttpSinkOwner(cap), 4);
  const acquisition = beginOwnedHttpFailureOrigin(cap, "acquire"), reading = beginOwnedHttpFailureOrigin(cap, "read");
  const cancellation = beginOwnedHttpFailureOrigin(cap, "cancel"), unlocking = beginOwnedHttpFailureOrigin(cap, "unlock");
  const canceled = Object.freeze({ kind: "owned-http-canceled" });
  let forwarded!: Response;
  owner.completion.start(source => {
    let original: Response | undefined = response;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try { reader = original.body!.getReader(); }
    catch (error) {
      const failure = rememberOwnedHttpFailure(acquisition, error); error = undefined;
      if (original.body!.locked) holdOwnedHttpRequest(cap);
      else source.start(() => {
        let work: Promise<void>;
        try { work = original!.body!.cancel(); }
        catch (reason) { work = Promise.reject(rememberOwnedHttpFailure(cancellation, reason)); }
        const observed = work.then(() => undefined, reason => { throw rememberOwnedHttpFailure(cancellation, reason); });
        work = undefined as never;
        return observed.then(() => { original = undefined; }, reason => { original = undefined; throw reason; });
      });
      throw failure;
    }
    let readRejected = false, streamErrored = false, readCarrier: object | undefined;
    // Native errored-stream cancellation propagates the stored read error; its
    // underlying cancel algorithm is not invoked. Classify by original state
    // observations, never by reason equality (including undefined).
    let closed: Promise<void> | undefined = reader.closed.then(() => undefined, () => { streamErrored = true; });
    const input = inputRetirement({
      cancel(reason?: unknown) {
        try {
          const propagatedRead = readRejected && streamErrored
            && Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
            && !Object.hasOwn(reader!, "closed") && reader!.cancel === originalReaderCancel;
          const work = reader!.cancel(reason);
          return work.then(() => undefined, error => {
            if (propagatedRead) throw readCarrier;
            throw rememberOwnedHttpFailure(cancellation, error);
          });
        } catch (error) { throw rememberOwnedHttpFailure(cancellation, error); }
      },
      releaseLock() {
        try { reader!.releaseLock(); }
        catch (error) { throw rememberOwnedHttpFailure(unlocking, error); }
        finally { if (original!.body!.locked) holdOwnedHttpRequest(cap); }
      },
    });
    let stopped = false;
    // Publish this join before any Response/stream factory can fail. It clears
    // original reader/body aliases only after the generic original-root join.
    const joined = input.retired.finally(async () => { await closed; closed = undefined; reader = undefined; original = undefined; });
    void joined.then(() => undefined, () => undefined);
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return source.start(async () => {
            try {
              const next = await input.read(() => {
                try {
                  const work = reader!.read();
                  return work.then(value => value, error => {
                    readRejected = true;
                    const originalRead = Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
                      && reader!.read === originalReaderRead && !Object.hasOwn(reader!, "closed");
                    const forwarded = publicBoundary && matchesOwnedHttpPublicBody(cap, original!.body);
                    const prior = forwarded && originalRead ? ownedHttpFailureMetadata(error) : undefined;
                    // Only this request's own closed inner boundary proves
                    // propagation. A foreign carrier or raw shared value is a
                    // distinct original and receives its own record.
                    let propagated = !!prior && owner.sinkOrigins?.get(prior.ordinal) === error;
                    if (originalRead && (!publicBoundary || forwarded)) {
                      for (const codec of owner.revalidations ?? []) {
                        if ((forwarded || matchesOwnedVeniceOutputBody(codec, original!.body)) && matchesOwnedVeniceOutputFailure(codec, error)) {
                          propagated = true; break;
                        }
                      }
                    }
                    readCarrier = propagated ? error as object : rememberOwnedHttpFailure(reading, error);
                    throw readCarrier;
                  });
                } catch (error) { throw rememberOwnedHttpFailure(reading, error); }
              });
              if (stopped) return;
              if (next.done) { stopped = true; controller.close(); void input.retire("eof"); }
              else controller.enqueue(next.value);
            } catch (error) {
              if (!stopped) { stopped = true; controller.error(error); }
              void input.retire("cancel", error);
            }
          });
        },
        cancel() { stopped = true; return input.retire("cancel", canceled); },
      }, { highWaterMark: 0 });
      forwarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { source.start(() => input.retire("cancel", error)); throw error; }
    return joined;
  });
  response = undefined as never;
  return forwarded;
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
    try { signal.addEventListener("abort", owner.listener, { once: true }); completedSinkOrigin(request, adding); }
    catch (reason) { throw failedSinkOrigin(adding, reason); }
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
    const original = owner.scope.start(() => sinkOriginal(owner.sink, record,
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
      try { if (upload.listener) owner.request!.signal.removeEventListener("abort", upload.listener); completedSinkOrigin(owner, upload.listenerRemoval); }
      catch (reason) { owner.unknown = true; failures.push(failedSinkOrigin(upload.listenerRemoval, reason)); }
      upload.source = undefined; upload.fixed = undefined; upload.original = undefined; upload.joined = undefined;
      upload.controller = undefined; upload.listener = undefined; upload.failures.length = 0;
      uploads!.delete(upload.cap);
    }
    // Logical accounting/recovery has finished; unused non-OK body retirement
    // can still be pending. It never delayed those recovery decisions above.
    if (owner.sinkCustody) { owner.sinkCustody.seal(); await owner.sinkCustody.completion; }
    for (const origin of owner.failures) {
      if (origin.failed) failures.push(origin.carrier);
    }
    for (const origin of owner.codecOrigins ?? []) if (origin.failed) failures.push(origin);
    if (!owner.unknown) {
      if (owner.abortListener) {
        try { owner.request!.signal.removeEventListener("abort", owner.abortListener); if (owner.abortRemoval) completedSinkOrigin(owner, owner.abortRemoval); }
        catch (reason) { owner.unknown = true; failures.push(failedSinkOrigin(owner.abortRemoval!, reason)); }
      }
      owner.abortListener = undefined; owner.abortController = undefined; owner.abortRemoval = undefined;
    }
    if (!owner.unknown) {
      // A failed last-consumer handoff is not proof that prepared callbacks
      // stopped borrowing identity/credential graphs. Preserve their owners.
      try {
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
    // Fixed-cohort transport starts only after HTTP consumers cleared. Unknown
    // delivery keeps its graphs/parents and cannot borrow this phase's windows.
    if (!owner.unknown) {
      try { await drainOwnedHttpIdentity(cap); } catch (error) { failures.push(error); }
      if (!owner.unknown) try { retireOwnedHttpIdentity(cap); } catch (error) { owner.unknown = true; failures.push(error); }
    }
    if (!owner.unknown) {
      // Only actual last-consumer clearance retires diagnostic capabilities.
      // A failed listener removal may leave a live callback even after the
      // current original body has joined; UNKNOWN keeps those caps funded.
      for (const origin of owner.failures) { origin.carrier = undefined; failureOrigins!.delete(origin.cap); }
      owner.failures.length = 0;
      if (owner.codecOrigins) owner.codecOrigins.length = 0;
      owner.codecOrigins = undefined;
      owner.uploads.length = 0; owner.request = undefined; owner.env = undefined;
      if (owner.sink) sinkOwners!.delete(owner.sink);
      if (owner.sinkOrigins) for (const origin of owner.sinkOrigins.values()) sinkFailures!.delete(origin);
      owner.sinkOrigins = undefined; owner.sink = undefined; owner.sinkCustody = undefined; owner.terminalRegistration = undefined; owner.budgetDenials = undefined;
      requests!.delete(cap); owner.funding.release();
      if (!--requestCount) { requests = undefined; uploads = undefined; failureOrigins = undefined; sinkOwners = undefined; sinkFailures = undefined; sinkRegistrations = undefined; intakes = undefined; revalidations = undefined; const funding = registryFunding; registryFunding = undefined; funding?.release(); }
    }
    if (failures.length) throw new AggregateError(failures, "owned HTTP request retirement");
  })();
  void owner.retirement.then(() => undefined, () => undefined);
  return owner.retirement;
}
