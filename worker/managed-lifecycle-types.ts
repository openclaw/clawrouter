import type { CompiledEndpoint } from "./types.ts";

export type ManagedProtocol = "replicate.predictions" | "fal.queue" | "kie.jobs" | "vydra.jobs" | "dashscope.video" | "pixverse.video" | "runway.tasks" | "together.video" | "google.omni_video" | "openrouter.video";
export type ManagedObservationLoss = "expired_or_unknown" | "deleted" | "canceled_or_deleted";
export type ManagedTerminal = "succeeded" | "failed" | "canceled" | "aborted";
export type ManagedControlAction = "retrieve" | "result" | "cancel";
export type ManagedAction = "create" | ManagedControlAction;

export interface ManagedCreate {
  body: Record<string, unknown>;
  // Adapter-owned non-secret headers only. The controller supplies credentials.
  headers: Headers;
  requestedVersion: string;
  pathParams: Record<string, string>;
}

export interface ManagedReadContext {
  action: ManagedAction;
  // Undefined only for create. Other reads must verify this bound identity;
  // an ID-less acknowledgement/result inherits it from the original request.
  expectedId?: string;
  requestedVersion: string;
  pathParams: Record<string, string>;
}

export interface ManagedObservation {
  id: string;
  nativeStatus: string | null;
  terminal: ManagedTerminal | null;
  // Visibility ended without execution outcome or refund evidence.
  observationUnavailable?: ManagedObservationLoss;
  // Runtime-qualified output descriptors only; never copy caller/native fields.
  files?: readonly ManagedFileDescriptor[];
  // Native payload is transient; never put it in durable ownership or receipts.
  body: Record<string, unknown>;
  // Queue completion or cancellation ACK can need one more authenticated read.
  // The controller bounds this chain and never follows a response-supplied URL.
  followUp?: "retrieve" | "result";
}

export interface ManagedPublicPaths {
  retrieve?: string;
  result?: string;
  cancel?: string;
}

// Concrete wrappers own protocol validation and byte-bounded parsing, not I/O,
// credentials, admission, retries, policy, durable state or tariff decisions.
export interface ManagedLifecycleAdapter {
  protocol: ManagedProtocol;
  requestFormats: readonly string[];
  supportsResult: boolean;
  supportsCancel: boolean;
  // Source registry attaches its qualified file wrapper; absence keeps files closed.
  files?: ManagedFileAdapter;
  // Non-secret per-job flags retained beside URL parameters, never caller authority.
  retainedParams?: readonly string[];
  // Restrict declared controls using only the original validated job flags.
  allowedControls?(pathParams: Record<string, string>): readonly ManagedControlAction[];
  validateId(value: unknown): string;
  // A valid, non-secret ID for checking declared route templates, never egress.
  identityProbe?: string;
  // Synchronous credential/origin qualification on the fully prepared request.
  // No refresh, mutation, I/O, logging, or alternate account selection.
  assertDispatch?(request: Request): void;
  prepare(body: unknown, headers: Headers, pathParams: Record<string, string>, query: URLSearchParams): ManagedCreate;
  // Opt-in admission after original credential selection. The initial slice
  // permits body-only creates with no adapter headers or route-param changes.
  prepareAdmitted?(body: unknown, headers: Headers, pathParams: Record<string, string>, query: URLSearchParams,
    admission: import("./upstream-retention-admission.ts").ManagedCreateAdmission): ManagedCreate;
  // Parse only the protocol's declared ID fields; reject extra control query.
  identify(action: ManagedControlAction, pathParams: Record<string, string>, query: URLSearchParams): string;
  // Validate the declared method/path against this protocol, then return only a
  // relative control path/query. No origin, credentials or arbitrary URL input.
  control(action: ManagedControlAction, endpoint: Pick<CompiledEndpoint, "method" | "path">,
    id: string, pathParams: Record<string, string>): ManagedControl;
  // Consume at most the protocol's bounded JSON envelope; reject redirects,
  // mismatched IDs and API errors that are not terminal job evidence.
  read(response: Response, context: ManagedReadContext): Promise<ManagedObservation>;
  // Replace/drop native control URLs. Media output URLs remain opaque data;
  // neither wrappers nor the controller fetch the output assets.
  rewrite(observation: ManagedObservation, paths: ManagedPublicPaths): Record<string, unknown>;
}

export interface ManagedControl {
  path: string;
  query: URLSearchParams;
  // Source-owned non-secret headers, regenerated for each actual control.
  headers?: Headers;
  // Fresh UUID diagnostics do not change the original route identity.
  transientHeaders?: readonly string[];
}


export interface ManagedFileDescriptor { id: string; mimeType: string }
export type ManagedFileAction = "metadata" | "download";
export interface ManagedFileState {
  id: string;
  status: "processing" | "active" | "failed";
  body: Record<string, unknown>;
}
export type ManagedFileLinks = { mode?: "metadata"; metadata: string; download: string }
  | { mode: "download_only"; metadata?: never; download: string };
export interface ManagedFilePaths { id: string; metadata?: string; download: string }
// Source-owned wrappers expose this through managedFileAdapter(protocol).
// These methods parse/prepare only; the scoped runtime owns all authority/I/O.
interface ManagedFileAdapterBase {
  protocol: ManagedProtocol;
  describe(observation: ManagedObservation, selectedBaseUrl: string): readonly ManagedFileDescriptor[];
  identify(action: ManagedFileAction, pathParams: Record<string, string>, query: URLSearchParams): string;
  control(action: ManagedFileAction, endpoint: Pick<CompiledEndpoint, "method" | "path" | "query">,
    file: ManagedFileDescriptor, selectedBaseUrl: string, state?: ManagedFileState): ManagedControl;
  readFile(response: Response, file: ManagedFileDescriptor, maxBytes: number): Promise<Uint8Array>;
  rewrite(body: Record<string, unknown>, paths: readonly ManagedFilePaths[]): Record<string, unknown>;
}
export type ManagedFileAdapter = ManagedFileAdapterBase & (
  { mode?: "metadata"; readState(response: Response, file: ManagedFileDescriptor): Promise<ManagedFileState> }
  // Availability comes from the original succeeded job and bound descriptor.
  // This mode neither manufactures metadata nor follows a response-supplied URL.
  | { mode: "download_only"; readState?: never }
);
