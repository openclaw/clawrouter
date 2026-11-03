import type { CompiledEndpoint } from "./types.ts";
import { HttpError } from "./utils.ts";

const mappedMethods: Readonly<Record<string, string>> = {
  "openai.chat_completions": "POST", "anthropic.messages": "POST",
  "openai.models": "GET", "anthropic.models": "GET", "synthetic.models": "GET",
};
const literalPath = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$(?![\s\S])/;
const canonicalPath = (value: unknown): value is string => typeof value === "string" && value.length <= 2048
  && literalPath.test(value) && !value.split("/").some(segment => segment === "." || segment === "..");

// Caller routes remain endpoint.path. Only an explicitly compiled, literal
// dispatch path may differ; existing grant transports cannot silently replace it.
export function configuredEndpointPath(endpoint: CompiledEndpoint, transportPath?: string, baseUrl?: string): string {
  const path = endpoint.upstreamPath;
  if (path === undefined) return transportPath ?? endpoint.path;
  const method = mappedMethods[endpoint.request_format];
  const invalid = () => { throw new HttpError(503, "provider_request_invalid", "endpoint upstream path is not qualified"); };
  if (!canonicalPath(path) || !canonicalPath(endpoint.path)
    || !method || endpoint.method !== method || endpoint.methods.some(value => value !== method)
    || endpoint.response_format !== endpoint.request_format || endpoint.path_params.length || Object.keys(endpoint.path_param_styles).length
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.requestPricing || endpoint.toolPricing
    || endpoint.request_format.endsWith(".models") && (endpoint.streaming || endpoint.modelPassthrough)
    || transportPath !== undefined && transportPath !== path) invalid();
  if (baseUrl !== undefined) {
    try {
      const base = new URL(baseUrl), target = new URL(baseUrl.replace(/\/$/, "") + path);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
        || target.origin !== base.origin || target.pathname !== base.pathname.replace(/\/$/, "") + path) invalid();
    } catch { invalid(); }
  }
  return path;
}
