export const REQUEST_ID_MAX_LENGTH = 128;
export const ATTRIBUTION_ID_MAX_LENGTH = 256;

const requestIdPattern = /^[A-Za-z0-9._~:/+@=-]+$/;
const attributionIdPattern = /^[A-Za-z0-9._~:/+@=-]+$/;
const traceparentMaxLength = 512;

const attributionHeaders = [
  {
    field: "sessionId",
    sources: ["x-clawrouter-session-id", "x-claude-code-session-id", "session-id"],
  },
  {
    field: "agentId",
    sources: ["x-clawrouter-agent-id", "x-claude-code-agent-id"],
  },
  {
    field: "parentAgentId",
    sources: ["x-clawrouter-parent-agent-id", "x-claude-code-parent-agent-id"],
  },
  { field: "projectId", sources: ["x-clawrouter-project-id"] },
  { field: "client", sources: ["x-clawrouter-client"] },
] as const;

export interface CorrelationMetadata {
  requestId: string;
  traceId: string | null;
  spanId: string | null;
  sessionId: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  projectId: string | null;
  client: string | null;
}

export interface CorrelatedRequest {
  request: Request;
  requestId: string;
  error: { code: string; message: string; status: 400 } | null;
}

// Preserve the ingress Request/body stream. Reconstructing it solely to add headers can
// retain an unconsumed body tee across a long-lived Worker process.
const ingressMetadata = new WeakMap<Request, CorrelationMetadata>();

export function correlateIngressRequest(input: Request): CorrelatedRequest {
  const suppliedRequestId = input.headers.get("x-request-id");
  const normalizedRequestId = suppliedRequestId == null
    ? null
    : normalizeRequestId(suppliedRequestId);
  const requestId = suppliedRequestId == null || normalizedRequestId == null
    ? generatedRequestId()
    : normalizedRequestId;
  let error = suppliedRequestId != null && normalizedRequestId == null
    ? invalidHeader("X-Request-ID", REQUEST_ID_MAX_LENGTH, "invalid_request_id")
    : null;
  const resolved = metadataFromHeaders(input.headers, requestId);
  if (!error) error = resolved.error;
  ingressMetadata.set(input, resolved.metadata);

  return {
    request: input,
    requestId,
    error,
  };
}

export function correlationMetadata(request: Request): CorrelationMetadata {
  const stored = ingressMetadata.get(request);
  if (stored) return stored;
  const requestId = normalizeRequestId(request.headers.get("x-request-id") ?? "");
  if (!requestId) throw new Error("request correlation metadata is missing");
  const resolved = metadataFromHeaders(request.headers, requestId);
  if (resolved.error) throw new Error("request attribution metadata is invalid");
  return resolved.metadata;
}

export function correlationRequestId(request: Request): string | null {
  return ingressMetadata.get(request)?.requestId ?? normalizeRequestId(request.headers.get("x-request-id") ?? "");
}

export function normalizeRequestId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= REQUEST_ID_MAX_LENGTH && requestIdPattern.test(normalized)
    ? normalized
    : null;
}

export function normalizeAttributionId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= ATTRIBUTION_ID_MAX_LENGTH && attributionIdPattern.test(normalized)
    ? normalized
    : null;
}

export function parseTraceparent(value: string | null): { traceId: string; spanId: string } | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length < 55 || normalized.length > traceparentMaxLength) return null;
  if (normalized[2] !== "-" || normalized[35] !== "-" || normalized[52] !== "-") return null;
  const version = normalized.slice(0, 2);
  const traceId = normalized.slice(3, 35);
  const spanId = normalized.slice(36, 52);
  const flags = normalized.slice(53, 55);
  if (!/^[0-9a-f]{2}$/.test(version) || version === "ff") return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(spanId) || /^0{16}$/.test(spanId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  if (version === "00" && normalized.length !== 55) return null;
  if (version !== "00" && normalized.length > 55 && normalized[55] !== "-") return null;
  return { traceId, spanId };
}

export function withRequestId(response: Response, requestId: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("x-request-id", requestId);
  return copy;
}

export function logCorrelationError(scope: string, requestId: string | null | undefined): void {
  console.error(scope, { request_id: normalizeRequestId(requestId ?? "") ?? "unavailable" });
}

function resolveAttributionHeader(
  headers: Headers,
  specification: (typeof attributionHeaders)[number],
): { value: string | null; error: { code: string; message: string; status: 400 } | null } {
  for (const source of specification.sources) {
    const raw = headers.get(source);
    if (raw == null) continue;
    const normalized = normalizeAttributionId(raw);
    if (!normalized) return { value: null, error: invalidHeader(source, ATTRIBUTION_ID_MAX_LENGTH, "invalid_attribution_id") };
    return { value: normalized, error: null };
  }
  return { value: null, error: null };
}

function metadataFromHeaders(
  headers: Headers,
  requestId: string,
): { metadata: CorrelationMetadata; error: { code: string; message: string; status: 400 } | null } {
  const trace = parseTraceparent(headers.get("traceparent"));
  const metadata: CorrelationMetadata = {
    requestId,
    traceId: trace?.traceId ?? null,
    spanId: trace?.spanId ?? null,
    sessionId: null,
    agentId: null,
    parentAgentId: null,
    projectId: null,
    client: null,
  };
  for (const specification of attributionHeaders) {
    const resolved = resolveAttributionHeader(headers, specification);
    if (resolved.error) return { metadata, error: resolved.error };
    metadata[specification.field] = resolved.value;
  }
  return { metadata, error: null };
}

function invalidHeader(name: string, maxLength: number, code: string) {
  return {
    code,
    message: `${name} must be a ${maxLength}-character-or-shorter ASCII identifier without whitespace or control characters`,
    status: 400 as const,
  };
}

function generatedRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
