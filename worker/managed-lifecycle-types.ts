import type { CompiledEndpoint } from "./types.ts";

export type ManagedProtocol = "replicate.predictions" | "fal.queue" | "kie.jobs" | "vydra.jobs";
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
  // Native payload is transient; never put it in durable ownership or receipts.
  body: Record<string, unknown>;
  // Queue completion or cancellation ACK can need one more authenticated read.
  // The controller bounds this chain and never follows a response-supplied URL.
  followUp?: "retrieve" | "result";
}

export interface ManagedPublicPaths {
  retrieve: string;
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
  validateId(value: unknown): string;
  prepare(body: unknown, headers: Headers, pathParams: Record<string, string>, query: URLSearchParams): ManagedCreate;
  // Parse only the protocol's declared ID fields; reject extra control query.
  identify(action: ManagedControlAction, pathParams: Record<string, string>, query: URLSearchParams): string;
  // Validate the declared method/path against this protocol, then return only a
  // relative control path/query. No origin, credentials or arbitrary URL input.
  control(action: ManagedControlAction, endpoint: Pick<CompiledEndpoint, "method" | "path">,
    id: string, pathParams: Record<string, string>): { path: string; query: URLSearchParams };
  // Consume at most the protocol's bounded JSON envelope; reject redirects,
  // mismatched IDs and API errors that are not terminal job evidence.
  read(response: Response, context: ManagedReadContext): Promise<ManagedObservation>;
  // Replace/drop native control URLs. Media output URLs remain opaque data;
  // neither wrappers nor the controller fetch the output assets.
  rewrite(observation: ManagedObservation, paths: ManagedPublicPaths): Record<string, unknown>;
}
