import { ExactBodyCharge } from "./body-budget.ts";
import { identityFailure, identityHeader } from "./identity-admission.ts";
import { ProxyCompletion } from "./proxy-completion.ts";
import { inputRetirement } from "./input-retirement.ts";
import type { Env, QueueMessage } from "./types.ts";
import { drainOwnedHttpIdentity, retireOwnedHttpConsumers, retireOwnedHttpIdentity } from "./credential-preflight.ts";
import { retireOwnedHttpProxy } from "./proxy.ts";
import { credentialPreflightHeader, credentialPreflightVersion, credentialPreflightPath, credentialPreflightNamespace } from "./credential-preflight-protocol.ts";

// This entry is inactive until the named compiled HTTP adapter invokes it.
// Capabilities contain no request, identity, credential or preparation graph.
export interface OwnedHttpRequest { readonly kind?: never }
export interface OwnedHttpUpload { readonly kind?: never }
export interface OwnedHttpSinkOwner { readonly sink?: never }
export interface OwnedHttpSinkRegistration { readonly registration?: never }
export interface OwnedHttpIntakeDiagnostics { readonly intake?: never }
type SinkOrigin = "acquire" | "fetch" | "body" | "read" | "cancel" | "unlock" | "queue" | "put" | "pipe" | "abort" | "registration" | "registration-missing" | "listener-add" | "listener-remove";
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
  abortController?: AbortController;
  abortListener?: () => void;
  abortRemoval?: SinkOriginOwner;
  terminalRegistration?: SinkOriginOwner;
  budgetDenials?: WeakSet<object>;
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
let requests: WeakMap<OwnedHttpRequest, RequestOwner> | undefined;
let uploads: WeakMap<OwnedHttpUpload, UploadOwner> | undefined;
let failureOrigins: WeakMap<OwnedHttpFailureOrigin, FailureOwner> | undefined;
let registryFunding: ExactBodyCharge | undefined;
let requestCount = 0;
let sinkOwners: WeakMap<OwnedHttpSinkOwner, RequestOwner> | undefined;
let sinkFailures: WeakSet<object> | undefined;
let sinkRegistrations: WeakMap<OwnedHttpSinkRegistration, { owner: RequestOwner; origin: SinkOriginOwner; scope: ProxyCompletion }> | undefined;
let intakes: WeakMap<OwnedHttpIntakeDiagnostics, { acquire: OwnedHttpFailureOrigin; read: OwnedHttpFailureOrigin; cancel: OwnedHttpFailureOrigin; unlock: OwnedHttpFailureOrigin; listenerAdd: OwnedHttpFailureOrigin; listenerRemove: OwnedHttpFailureOrigin }> | undefined;

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
      sealed: false, unknown: false, sink, sinkCustody: new ProxyCompletion(), sinkOrigins: new Map([[0, terminalRegistration]]), nextSinkOrigin: 1, sinkCredits: 1,
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
  (intakes ??= new WeakMap()).set(receipt, { acquire, read, cancel, unlock, listenerAdd, listenerRemove });
  return receipt;
}
export function ownedHttpIntakeFailure(cap: OwnedHttpIntakeDiagnostics, phase: "acquire" | "read" | "cancel" | "unlock" | "listenerAdd" | "listenerRemove", reason: unknown): object {
  const receipt = intakes?.get(cap);
  if (!receipt) throw identityFailure("protocol");
  return rememberOwnedHttpFailure(receipt[phase], reason);
}
export function finishOwnedHttpIntakeDiagnostics(cap: OwnedHttpIntakeDiagnostics): void {
  if (!intakes?.delete(cap)) throw identityFailure("protocol");
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
                    const prior = publicBoundary ? ownedHttpFailureMetadata(error) : undefined;
                    // Only this request's own closed inner boundary proves
                    // propagation. A foreign carrier or raw shared value is a
                    // distinct original and receives its own record.
                    const propagated = prior && owner.sinkOrigins?.get(prior.ordinal) === error;
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
      origin.carrier = undefined; failureOrigins!.delete(origin.cap);
    }
    owner.failures.length = 0;
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
      try { retireOwnedHttpProxy(cap); } catch (error) { owner.unknown = true; failures.push(error); }
      if (!owner.unknown) try { retireOwnedHttpConsumers(cap); } catch (error) { owner.unknown = true; failures.push(error); }
    }
    // Fixed-cohort transport starts only after HTTP consumers cleared. Unknown
    // delivery keeps its graphs/parents and cannot borrow this phase's windows.
    if (!owner.unknown) {
      try { await drainOwnedHttpIdentity(cap); } catch (error) { failures.push(error); }
      if (!owner.unknown) try { retireOwnedHttpIdentity(cap); } catch (error) { owner.unknown = true; failures.push(error); }
    }
    if (!owner.unknown) {
      owner.uploads.length = 0; owner.request = undefined; owner.env = undefined;
      if (owner.sink) sinkOwners!.delete(owner.sink);
      if (owner.sinkOrigins) for (const origin of owner.sinkOrigins.values()) sinkFailures!.delete(origin);
      owner.sinkOrigins = undefined; owner.sink = undefined; owner.sinkCustody = undefined; owner.terminalRegistration = undefined; owner.budgetDenials = undefined;
      requests!.delete(cap); owner.funding.release();
      if (!--requestCount) { requests = undefined; uploads = undefined; failureOrigins = undefined; sinkOwners = undefined; sinkFailures = undefined; sinkRegistrations = undefined; intakes = undefined; const funding = registryFunding; registryFunding = undefined; funding?.release(); }
    }
    if (failures.length) throw new AggregateError(failures, "owned HTTP request retirement");
  })();
  void owner.retirement.then(() => undefined, () => undefined);
  return owner.retirement;
}
