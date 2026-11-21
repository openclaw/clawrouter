import { configuredEndpointPath } from "./endpoint-path.ts";
import { providerConfigurationList } from "./provider-connections.ts";
import { applyTemplateHeaders, resolveTemplate, templateCandidates, PreparationAdmission, preparationValue, preparationHeader, preparationBytes } from "./provider-templates.ts";
import type { CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { HttpError } from "./utils.ts";

interface UpstreamPathContext { baseUrl: string; transportPaths: Record<string, string> }

export function upstreamPath(provider: CompiledProvider, endpoint: CompiledEndpoint, pathParams: Record<string, string>, env: Env, auth: UpstreamPathContext, owner?: PreparationAdmission): string {
  owner?.paths(pathParams, endpoint.path_param_styles);
  const transportPath = auth.transportPaths[endpoint.id as keyof typeof auth.transportPaths];
  let path = configuredEndpointPath(endpoint, transportPath, auth.baseUrl);
  for (const name of endpoint.path_params) {
    const raw = pathParams[name];
    if (!raw) throw new HttpError(400, "missing_path_param", `path parameter ${name} is required`);
    const style = endpoint.path_param_styles[name as keyof typeof endpoint.path_param_styles] ?? "segment";
    const placeholder = `\${${name}}`;
    if (owner) {
      const encoded = owner.path(raw, style === "relative_path", style === "opaque_segment" || style === "relative_path");
      owner.text(path, 16384);
      if (path.includes(placeholder)) {
        if (path.length - placeholder.length + encoded > 16384 || preparationBytes(path) - preparationBytes(placeholder) + encoded > 16384) owner.fail();
        owner.substitute(1);
      }
    }
    path = path.replace(placeholder, encodePathParam(raw, style));
  }
  return resolveTemplate(provider, path, env, owner);
}

export function copyRequestHeaders(incoming: Headers, provider: CompiledProvider, endpoint: CompiledEndpoint, target: Headers, env: Env, owner?: PreparationAdmission): void {
  for (const name of [...provider.adapter.passthroughHeaders, ...endpoint.request_headers]) {
    const lower = name.toLowerCase();
    // Caller-selected tenancy, profile trust grants and replay keys have no
    // authorized owner binding. A manifest allowlist cannot grant authority.
    if (["x-clawrouter-background-recovery", "anthropic-workspace-id", "anthropic-user-profile-id", "idempotency-key"].includes(lower)) continue;
    const value = incoming.get(name);
    if (value) preparationHeader(target, name, value, owner);
  }
  preparationHeader(target, "content-type", incoming.get("content-type") ?? "application/json", owner);
  applyTemplateHeaders(provider, endpoint.headers, env, target, owner);
}

export function transformRequestBody(provider: CompiledProvider, path: string, model: string, body: Record<string, unknown>, env: Env, owner?: PreparationAdmission): Record<string, unknown> {
  // Renames only replace top-level fields; nested prompt/tool data is read-only.
  const transformed = { ...body };
  for (const rename of provider.adapter.requestTransforms.renameFields) {
    if (rename.paths.length && !rename.paths.includes(path)) continue;
    const allowed = rename.upstreams.length === 0 || rename.upstreams.includes(model) || (!!rename.upstreamConfig && configuredList(provider, rename.upstreamConfig, env, owner).includes(model));
    if (allowed && rename.from in transformed && !(rename.to in transformed)) {
      transformed[rename.to] = transformed[rename.from];
      delete transformed[rename.from];
    }
  }
  return transformed;
}

function configuredList(provider: CompiledProvider, name: string, env: Env, owner?: PreparationAdmission): string[] {
  let selected: string | null = null;
  const key = templateCandidates(provider, name, owner).find(candidate => (selected = preparationValue(env, candidate, owner, true)));
  return key ? providerConfigurationList(selected!, owner, key, undefined, !!owner) : [];
}

function encodePathParam(value: string, style: string): string {
  if (style === "opaque_segment") {
    if (/^[.]{1,2}$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "invalid_path_param", "opaque path parameter is unsafe");
    return awsEncode(value);
  }
  if (style === "relative_path") {
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    return segments.map(encodeURIComponent).join("/");
  }
  if (value.includes("/") || value === "." || value === "..") throw new HttpError(400, "invalid_path_param", "path parameter must be one segment");
  return encodeURIComponent(value);
}

export function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
