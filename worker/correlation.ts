export const REQUEST_ID_MAX_LENGTH = 128;
export const ATTRIBUTION_ID_MAX_LENGTH = 256;

const requestIdPattern = /^[A-Za-z0-9._~:/+@=-]+$/;
const attributionIdPattern = /^[A-Za-z0-9._~:/+@=-]+$/;
const traceparentMaxLength = 512;

const attributionHeaders = [
  {
    canonical: "x-clawrouter-session-id",
    sources: ["x-clawrouter-session-id", "x-claude-code-session-id", "session-id"],
  },
  {
    canonical: "x-clawrouter-agent-id",
    sources: ["x-clawrouter-agent-id", "x-claude-code-agent-id"],
  },
  {
    canonical: "x-clawrouter-parent-agent-id",
    sources: ["x-clawrouter-parent-agent-id", "x-claude-code-parent-agent-id"],
  },
  { canonical: "x-clawrouter-project-id", sources: ["x-clawrouter-project-id"] },
  { canonical: "x-clawrouter-client", sources: ["x-clawrouter-client"] },
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

export function correlateIngressRequest(input: Request): CorrelatedRequest {
  const headers = new Headers(input.headers);
  const suppliedRequestId = headers.get("x-request-id");
  const normalizedRequestId = suppliedRequestId == null
    ? null
    : normalizeRequestId(suppliedRequestId);
  const requestId = suppliedRequestId == null || normalizedRequestId == null
    ? generatedRequestId()
    : normalizedRequestId;
  headers.set("x-request-id", requestId);

  let error = suppliedRequestId != null && normalizedRequestId == null
    ? invalidHeader("X-Request-ID", REQUEST_ID_MAX_LENGTH, "invalid_request_id")
    : null;
  if (!error) {
    for (const specification of attributionHeaders) {
      const result = resolveAttributionHeader(headers, specification);
      if (result) {
        error = result;
        break;
      }
    }
  }

  return {
    request: new Request(input, { headers }),
    requestId,
    error,
  };
}

export function correlationMetadata(request: Request): CorrelationMetadata {
  const requestId = normalizeRequestId(request.headers.get("x-request-id") ?? "");
  if (!requestId) throw new Error("request correlation metadata is missing");
  const trace = parseTraceparent(request.headers.get("traceparent"));
  return {
    requestId,
    traceId: trace?.traceId ?? null,
    spanId: trace?.spanId ?? null,
    sessionId: canonicalAttribution(request.headers, "x-clawrouter-session-id"),
    agentId: canonicalAttribution(request.headers, "x-clawrouter-agent-id"),
    parentAgentId: canonicalAttribution(request.headers, "x-clawrouter-parent-agent-id"),
    projectId: canonicalAttribution(request.headers, "x-clawrouter-project-id"),
    client: canonicalAttribution(request.headers, "x-clawrouter-client"),
  };
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
): { code: string; message: string; status: 400 } | null {
  for (const source of specification.sources) {
    const raw = headers.get(source);
    if (raw == null) continue;
    const normalized = normalizeAttributionId(raw);
    if (!normalized) return invalidHeader(source, ATTRIBUTION_ID_MAX_LENGTH, "invalid_attribution_id");
    headers.set(specification.canonical, normalized);
    return null;
  }
  headers.delete(specification.canonical);
  return null;
}

function canonicalAttribution(headers: Headers, name: string): string | null {
  return normalizeAttributionId(headers.get(name) ?? "");
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
