/** Data-only HTTP JSON examples. Validation is not execution or provider qualification. */
export const PROVIDER_CONFORMANCE_SCHEMA = "clawrouter.provider-conformance.v1";
export const PROVIDER_CONFORMANCE_VALIDATION_SCHEMA = "clawrouter.provider-conformance-validation.v1";

export const PROVIDER_CONFORMANCE_EXECUTION_SCHEMA = "clawrouter.provider-conformance-execution.v1";

/** Narrow host execution result, not an entitlement or live-provider attestation. */
export interface ProviderConformanceExecution {
  schema: typeof PROVIDER_CONFORMANCE_EXECUTION_SCHEMA;
  scope: "native-rest-json-exchanges";
  packages: ProviderConformanceValidation["packages"];
}

/** Authored-reference validation only; never an adapter execution attestation. */
export interface ProviderConformanceValidation {
  schema: typeof PROVIDER_CONFORMANCE_VALIDATION_SCHEMA;
  scope: "declarations";
  packages: {
    id: string;
    version: string;
    digest: string;
    scenarios: { id: string; fixture: string; endpoint: string; capability: string; model?: string }[];
  }[];
}

export type ProviderFixtureJson = null | boolean | number | string | ProviderFixtureJson[] | { [key: string]: ProviderFixtureJson };

export interface ProviderFixtureRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
  headers?: Record<string, string>;
  body?: ProviderFixtureJson;
}

export interface ProviderFixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: ProviderFixtureJson;
}

export interface ProviderConformanceScenario {
  schema: typeof PROVIDER_CONFORMANCE_SCHEMA;
  kind: "json-exchange";
  id: string;
  providerId: string;
  endpoint: string;
  capability: string;
  model?: string;
  request: ProviderFixtureRequest;
  upstream: { request: ProviderFixtureRequest; response: ProviderFixtureResponse };
  response: ProviderFixtureResponse;
}

export class ProviderConformanceContractError extends Error {
  readonly pointer: string;
  constructor(pointer: string, message: string) {
    super(`provider conformance ${pointer || "/"}: ${message}`);
    this.name = "ProviderConformanceContractError";
    this.pointer = pointer;
  }
}

function fail(pointer: string, message: string): never {
  throw new ProviderConformanceContractError(pointer, message);
}

function pointerKey(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function record(value: unknown, pointer: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(pointer, "expected an object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (keys && !keys.includes(key)) fail(`${pointer}/${pointerKey(key)}`, "unknown field");
  }
  return result;
}

function text(value: unknown, pointer: string): string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) {
    fail(pointer, "expected a nonempty single-line string of at most 2048 characters");
  }
  return value;
}

function identifier(value: unknown, pointer: string): string {
  const result = text(value, pointer);
  if (result.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) fail(pointer, "expected a lowercase identifier of at most 64 characters");
  return result;
}

function headers(value: unknown, pointer: string): Record<string, string> {
  const input = record(value, pointer);
  if (Object.keys(input).length > 64) fail(pointer, "expected at most 64 headers");
  return Object.fromEntries(Object.entries(input).map(([name, value]) => {
    const location = `${pointer}/${pointerKey(name)}`;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) fail(location, "expected a lowercase HTTP header name");
    if (typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) fail(location, "expected a single-line header value of at most 8192 characters");
    return [name, value];
  }));
}

function json(value: unknown, pointer: string, budget: { nodes: number }, depth = 0): ProviderFixtureJson {
  if (++budget.nodes > 10000 || depth > 32) fail(pointer, "JSON body exceeds 10000 values or 32 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (entry, index) => json(entry, `${pointer}/${index}`, budget, depth + 1));
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, json(entry, `${pointer}/${pointerKey(key)}`, budget, depth + 1)]));
  }
  return fail(pointer, "expected a JSON value");
}

function message(value: unknown, pointer: string, request: true): ProviderFixtureRequest;
function message(value: unknown, pointer: string, request: false): ProviderFixtureResponse;
function message(value: unknown, pointer: string, request: boolean): ProviderFixtureRequest | ProviderFixtureResponse {
  const input = record(value, pointer, request ? ["method", "path", "headers", "body"] : ["status", "headers", "body"]);
  let result: ProviderFixtureRequest | ProviderFixtureResponse;
  if (request) {
    const method = text(input.method, `${pointer}/method`) as ProviderFixtureRequest["method"];
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) fail(`${pointer}/method`, "unsupported HTTP method");
    const path = text(input.path, `${pointer}/path`);
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#\s]/.test(path)) fail(`${pointer}/path`, "expected an origin-relative HTTP path without a fragment");
    result = { method, path };
  } else {
    if (!Number.isInteger(input.status) || (input.status as number) < 200 || (input.status as number) > 599) fail(`${pointer}/status`, "expected a final HTTP status from 200 to 599");
    result = { status: input.status as number };
  }
  if (input.headers !== undefined) result.headers = headers(input.headers, `${pointer}/headers`);
  if (Object.hasOwn(input, "body")) result.body = json(input.body, `${pointer}/body`, { nodes: 0 });
  return result;
}

/** Parse and detach one scenario. No I/O, secret resolution, manifest checks, or assertions run. */
export function parseProviderConformanceScenario(value: unknown): ProviderConformanceScenario {
  const input = record(value, "", ["schema", "kind", "id", "providerId", "endpoint", "capability", "model", "request", "upstream", "response"]);
  if (input.schema !== PROVIDER_CONFORMANCE_SCHEMA) fail("/schema", `expected ${PROVIDER_CONFORMANCE_SCHEMA}`);
  if (input.kind !== "json-exchange") fail("/kind", "expected json-exchange");
  const upstream = record(input.upstream, "/upstream", ["request", "response"]);
  const result: ProviderConformanceScenario = {
    schema: PROVIDER_CONFORMANCE_SCHEMA,
    kind: "json-exchange",
    id: identifier(input.id, "/id"),
    providerId: identifier(input.providerId, "/providerId"),
    endpoint: text(input.endpoint, "/endpoint"),
    capability: text(input.capability, "/capability"),
    request: message(input.request, "/request", true),
    upstream: { request: message(upstream.request, "/upstream/request", true), response: message(upstream.response, "/upstream/response", false) },
    response: message(input.response, "/response", false),
  };
  // Model IDs are opaque, including slash-qualified IDs; do not normalize them.
  if (input.model !== undefined) result.model = text(input.model, "/model");
  return result;
}
