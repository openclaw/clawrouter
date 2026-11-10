import { ExactBodyCharge } from "./body-budget.ts";
import { identityFailure } from "./identity-admission.ts";
import { ProxyCompletion } from "./proxy-completion.ts";
import type { Env } from "./types.ts";
import { drainOwnedHttpIdentity, retireOwnedHttpIdentity } from "./credential-preflight.ts";
import { retireOwnedHttpProxy } from "./proxy.ts";

// This entry is inactive until the named compiled HTTP adapter invokes it.
// Capabilities contain no request, identity, credential or preparation graph.
export interface OwnedHttpRequest { readonly kind?: never }
export interface OwnedHttpUpload { readonly kind?: never }

interface RequestOwner {
  request?: Request;
  env?: Env;
  funding: ExactBodyCharge;
  completion: ProxyCompletion;
  uploads: UploadOwner[];
  sealed: boolean;
  unknown: boolean;
  retirement?: Promise<void>;
}
interface UploadOwner {
  cap: OwnedHttpUpload;
  request: RequestOwner;
  scope: ProxyCompletion;
  controller?: AbortController;
  listener?: () => void;
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
const requestMetadataBytes = 4096;
const uploadMetadataBytes = 4096;
let requests: WeakMap<OwnedHttpRequest, RequestOwner> | undefined;
let uploads: WeakMap<OwnedHttpUpload, UploadOwner> | undefined;
let registryFunding: ExactBodyCharge | undefined;
let requestCount = 0;

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
    const owner: RequestOwner = { request, env, funding, completion: new ProxyCompletion(), uploads: [], sealed: false, unknown: false };
    const cap = Object.freeze({});
    requests.set(cap, owner); requestCount++;
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
  const scope = request.completion.fork();
  const upload = Object.freeze({});
  const owner: UploadOwner = { cap: upload, request, scope, started: false, settled: false, dispatched: false, failures: [] };
  uploads!.set(upload, owner); request.uploads.push(owner);
  try {
    const controller = new AbortController(); owner.controller = controller;
    const signal = request.request!.signal;
    owner.listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", owner.listener, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
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
    const original = owner.scope.start(() => source.pipeTo(fixed.writable, { signal: owner.controller!.signal }));
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
  try { owner.controller?.abort(); } catch (error) { owner.failures.push(error); }
  void (async () => {
    if (owner.original) await owner.joined;
    else if (owner.source) {
      // A lock without our ORIGINAL pipe has no application settlement proof.
      // Preserve the open scope and debit rather than invent cancellation ACK.
      if (owner.source.locked) { owner.request.unknown = true; return; }
      try { await owner.source.cancel(); } catch (error) { owner.failures.push(error); }
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
      if (upload.joined) await upload.joined;
      if (!upload.settled) { owner.unknown = true; continue; }
      failures.push(...upload.failures);
      try { if (upload.listener) owner.request!.signal.removeEventListener("abort", upload.listener); }
      catch (error) { owner.unknown = true; failures.push(error); }
      upload.source = undefined; upload.fixed = undefined; upload.original = undefined; upload.joined = undefined;
      upload.controller = undefined; upload.listener = undefined; upload.failures.length = 0;
      uploads!.delete(upload.cap);
    }
    try { await drainOwnedHttpIdentity(cap); } catch (error) { failures.push(error); }
    if (!owner.unknown) {
      try { retireOwnedHttpProxy(cap); } catch (error) { failures.push(error); }
      try { retireOwnedHttpIdentity(cap); } catch (error) { failures.push(error); }
      owner.uploads.length = 0; owner.request = undefined; owner.env = undefined;
      requests!.delete(cap); owner.funding.release();
      if (!--requestCount) { requests = undefined; uploads = undefined; const funding = registryFunding; registryFunding = undefined; funding?.release(); }
    }
    if (failures.length) throw new AggregateError(failures, "owned HTTP request retirement");
  })();
  void owner.retirement.then(() => undefined, () => undefined);
  return owner.retirement;
}
