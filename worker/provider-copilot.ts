type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
function requireCopilot(condition: unknown, field: string): asserts condition { if (!condition) throw new Error(`invalid_copilot_${field}`); }
function token(value: string) { requireCopilot(typeof value === "string" && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value), "credential"); return value; }

export function copilotGithubDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  requireCopilot(domain === "github.com" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(domain), "github_domain");
  return domain;
}

export function copilotAccountRequest(domain: string, githubToken: string): Request {
  return new Request(`https://api.${copilotGithubDomain(domain)}/copilot_internal/user`, { method: "GET", redirect: "manual",
    headers: { accept: "application/json", authorization: `Bearer ${token(githubToken)}` } });
}

export interface CopilotIdentity { githubDomain: string; apiBaseUrl: string; ownerBinding: string }
export type CopilotRuntimeIdentity = Readonly<{
  ownerBinding: string;
  integrationId: string;
  editorVersion: string;
  editorPluginVersion: string;
  userAgent: string;
}>;
export type CopilotInferenceContext = Readonly<{ initiator: "user" | "agent"; hasImages: boolean }>;

// Source1 supplies these facts from the original credential owner and validated
// request. No client identity defaults, caller header bag or environment lookup.
export function buildCopilotRuntimeHeaders(identity: CopilotIdentity, selectedOwnerBinding: string, runtimeIdentity: CopilotRuntimeIdentity): Headers {
  const runtime = record(runtimeIdentity);
  requireCopilot(runtime && typeof selectedOwnerBinding === "string" && selectedOwnerBinding.length > 0 && selectedOwnerBinding.length <= 512 &&
    identity?.ownerBinding === selectedOwnerBinding && runtime.ownerBinding === selectedOwnerBinding, "owner_binding");
  const fields = ["ownerBinding", "integrationId", "editorVersion", "editorPluginVersion", "userAgent"];
  requireCopilot(Reflect.ownKeys(runtime).length === fields.length && Reflect.ownKeys(runtime).every(key => typeof key === "string" && fields.includes(key)), "runtime_identity");
  // Local input bounds, not a claim about vendor header limits. Reject controls,
  // non-ASCII and normalization that would change the supplied identity.
  const header = (value: unknown): string => {
    requireCopilot(typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && /^[\x20-\x7e]+$/.test(value), "runtime_identity");
    return value;
  };
  const integrationId = header(runtime.integrationId);
  requireCopilot(/^[A-Za-z0-9._-]+$/.test(integrationId), "runtime_identity");
  return new Headers({
    "accept-encoding": "identity",
    "editor-version": header(runtime.editorVersion),
    "editor-plugin-version": header(runtime.editorPluginVersion),
    "user-agent": header(runtime.userAgent),
    "openai-organization": "github-copilot",
    "copilot-integration-id": integrationId,
  });
}

function qualifyApiBase(value: string, domain: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_copilot_api_url"); }
  const host = url.hostname;
  const trusted = host === "copilot-proxy.githubusercontent.com" || host.endsWith(".githubcopilot.com") || (domain !== "github.com" && (host === domain || host.endsWith(`.${domain}`)));
  requireCopilot(url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && trusted, "api_origin");
  return url.href.replace(/\/+$/, "");
}

// The owner binding is supplied by the selected credential owner, not inferred
// from an unverified token or caller body. It must cover grant identity/version.
export function qualifyCopilotIdentity(value: unknown, domain: string, ownerBinding: string): CopilotIdentity {
  const githubDomain = copilotGithubDomain(domain), body = record(value);
  requireCopilot(body && ownerBinding.length > 0 && ownerBinding.length <= 512, "identity");
  const endpoints = body.endpoints === undefined ? null : record(body.endpoints);
  requireCopilot(body.endpoints === undefined || endpoints, "endpoints");
  const api = endpoints?.api;
  requireCopilot(api == null || typeof api === "string", "api_url");
  const fallback = githubDomain === "github.com" ? "https://api.individual.githubcopilot.com" : `https://copilot-api.${githubDomain}`;
  return { githubDomain, apiBaseUrl: qualifyApiBase(api == null || api === "" ? fallback : api as string, githubDomain), ownerBinding };
}

export type CopilotWireFormat = "openai.chat_completions" | "openai.responses" | "anthropic.messages";
const paths: Record<CopilotWireFormat, string> = { "openai.chat_completions": "/chat/completions", "openai.responses": "/responses", "anthropic.messages": "/messages" };
export function copilotModelFormats(value: unknown): CopilotWireFormat[] {
  const model = record(value);
  if (!model || !Array.isArray(model.supported_endpoints)) return [];
  const supported = model.supported_endpoints.filter((value): value is string => typeof value === "string").map(value => value.trim().replace(/^\/v1(?=\/)/, "").replace(/\/+$/, ""));
  return (Object.keys(paths) as CopilotWireFormat[]).filter(format => supported.includes(paths[format]));
}

// Frozen native picker visibility, not inference entitlement. Missing/unknown
// policy is preserved; only the credential owner can authorize execution.
export function isCopilotCatalogModelVisible(value: unknown): boolean {
  const model = record(value), state = record(model?.policy)?.state;
  const policy = typeof state === "string" ? state.trim().toLowerCase() : undefined;
  return model?.model_picker_enabled === true && policy !== "disabled" && policy !== "unconfigured";
}

export function filterCopilotModels(value: unknown, allowed: (model: string) => boolean): JsonRecord & { data: JsonRecord[] } {
  const body = record(value);
  requireCopilot(body && Array.isArray(body.data), "models");
  const seen = new Set<string>();
  const data = body.data.filter(value => {
    const model = record(value);
    requireCopilot(model && typeof model.id === "string" && model.id.length && !seen.has(model.id), "model");
    seen.add(model.id);
    return isCopilotCatalogModelVisible(model) && copilotModelFormats(model).length > 0 && allowed(model.id);
  });
  return { ...body, data };
}

export function copilotCatalogRequest(identity: CopilotIdentity, selectedOwnerBinding: string, githubToken: string, runtimeIdentity: CopilotRuntimeIdentity): Request {
  const headers = buildCopilotRuntimeHeaders(identity, selectedOwnerBinding, runtimeIdentity);
  const base = qualifyApiBase(identity.apiBaseUrl, copilotGithubDomain(identity.githubDomain));
  headers.set("authorization", `Bearer ${token(githubToken)}`);
  headers.set("accept", "application/json");
  return new Request(base + "/models", { method: "GET", redirect: "manual", headers });
}

export function prepareCopilotRequest(value: unknown, identity: CopilotIdentity, selectedOwnerBinding: string, githubToken: string, model: JsonRecord, format: CopilotWireFormat, runtimeIdentity: CopilotRuntimeIdentity, context: CopilotInferenceContext): Request {
  const headers = buildCopilotRuntimeHeaders(identity, selectedOwnerBinding, runtimeIdentity);
  const base = qualifyApiBase(identity.apiBaseUrl, copilotGithubDomain(identity.githubDomain));
  requireCopilot(typeof model.id === "string" && model.id.length && isCopilotCatalogModelVisible(model) && copilotModelFormats(model).includes(format), "model_transport");
  const facts = record(context);
  requireCopilot(facts && Reflect.ownKeys(facts).length === 2 && Reflect.ownKeys(facts).every(key => key === "initiator" || key === "hasImages") &&
    (facts.initiator === "user" || facts.initiator === "agent") && typeof facts.hasImages === "boolean", "request_identity");
  const body = record(value);
  requireCopilot(body && (body.stream === undefined || typeof body.stream === "boolean"), "body");
  headers.set("authorization", `Bearer ${token(githubToken)}`);
  headers.set("content-type", "application/json");
  headers.set("accept", body.stream === true ? "text/event-stream" : "application/json");
  headers.set("x-initiator", facts.initiator);
  if (facts.hasImages) headers.set("copilot-vision-request", "true");
  if (format === "anthropic.messages") headers.set("anthropic-version", "2023-06-01");
  // Current CAPI accepts the original GitHub token; there is no /v2/token hop.
  return new Request(base + paths[format], { method: "POST", redirect: "manual", headers, body: JSON.stringify({ ...body, model: model.id }) });
}
