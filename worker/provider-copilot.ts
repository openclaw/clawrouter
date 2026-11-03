type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
function requireCopilot(condition: unknown, field: string): asserts condition { if (!condition) throw new Error(`invalid_copilot_${field}`); }
function token(value: string) { requireCopilot(value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value), "credential"); return value; }

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

export function filterCopilotModels(value: unknown, allowed: (model: string) => boolean): JsonRecord & { data: JsonRecord[] } {
  const body = record(value);
  requireCopilot(body && Array.isArray(body.data), "models");
  const seen = new Set<string>();
  const data = body.data.filter(value => {
    const model = record(value);
    requireCopilot(model && typeof model.id === "string" && model.id.length && !seen.has(model.id), "model");
    seen.add(model.id);
    const policy = record(model.policy);
    return policy?.state !== "disabled" && copilotModelFormats(model).length > 0 && allowed(model.id);
  });
  return { ...body, data };
}

export function prepareCopilotRequest(value: unknown, identity: CopilotIdentity, selectedOwnerBinding: string, githubToken: string, model: JsonRecord, format: CopilotWireFormat): Request {
  requireCopilot(identity.ownerBinding === selectedOwnerBinding, "owner_binding");
  const base = qualifyApiBase(identity.apiBaseUrl, copilotGithubDomain(identity.githubDomain));
  requireCopilot(typeof model.id === "string" && model.id.length && record(model.policy)?.state !== "disabled" && copilotModelFormats(model).includes(format), "model_transport");
  const body = record(value);
  requireCopilot(body && (body.stream === undefined || typeof body.stream === "boolean"), "body");
  const headers = new Headers({ authorization: `Bearer ${token(githubToken)}`, "content-type": "application/json", accept: body.stream === true ? "text/event-stream" : "application/json" });
  if (format === "anthropic.messages") headers.set("anthropic-version", "2023-06-01");
  // Current CAPI accepts the original GitHub token; there is no /v2/token hop.
  return new Request(base + paths[format], { method: "POST", redirect: "manual", headers, body: JSON.stringify({ ...body, model: model.id }) });
}
