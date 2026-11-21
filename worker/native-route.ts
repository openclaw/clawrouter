import { modelSupportsEndpoint } from "../shared/route-catalog.ts";
import type { PreparationAdmission } from "./provider-templates.ts";
import type { CompiledEndpoint, CompiledProvider } from "./types.ts";
import { decodePathSegment, HttpError } from "./utils.ts";

export function nativeMatch(endpoint: CompiledEndpoint, path: string): boolean {
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}
export function nativeParams(endpoint: CompiledEndpoint, path: string, preparation?: PreparationAdmission): Record<string, string> {
  if (preparation) {
    preparation.text(path, 8192); let names = 0;
    for (const _ of endpoint.path.matchAll(/\$\{([^}]+)\}/g)) if (++names > 32) preparation.fail();
  }
  const names = [...endpoint.path.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]+\\\}/g, "([^/]+)");
  const match = path.match(new RegExp(`^${pattern}$`));
  if (preparation) {
    let bytes = 0;
    for (let i = 0; i < names.length; i++) {
      preparation.text(names[i], 256); const raw = match?.[i + 1] ?? "";
      for (let offset = 0; offset < raw.length;) {
        if (raw[offset] === "%" && /^[0-9a-f]{2}$/i.test(raw.slice(offset + 1, offset + 3))) { bytes++; offset += 3; }
        else { const code = raw.codePointAt(offset)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; offset += code > 65535 ? 2 : 1; }
        if (bytes > 4096) preparation.fail();
      }
    }
  }
  return Object.fromEntries(names.map((name, index) => [name, decodePathSegment(match?.[index + 1] ?? "")]));
}

// Several native protocols can share one model-qualified path. A registered
// model's declared capability chooses the operation, never YAML order or a
// guessed body shape. Stateful controls retain their original-owner resolver.
export function nativeModelEndpoint(provider: CompiledProvider, matching: CompiledEndpoint[], path: string, method: string, body?: unknown): CompiledEndpoint | undefined {
  const candidates = matching.filter(endpoint => endpoint.native_proxy && endpoint.methods.includes(method));
  if (candidates.length < 2 || candidates.some(endpoint => endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.inputProfile)) return;
  const pathModel = candidates.every(endpoint => endpoint.path_params.some(name => name === "model" || name === "deployment"));
  // Same-wire Chat operations may declare distinct capabilities for an exact
  // registered body model. This is an identity selector, never content inference.
  const bodyModel = !pathModel && method === "POST" && candidates.every(endpoint => !endpoint.path_params.length
    && endpoint.request_format === "openai.chat_completions" && endpoint.response_format === "openai.chat_completions")
    && body !== null && typeof body === "object" && !Array.isArray(body) && "model" in body && typeof body.model === "string" ? body.model : null;
  if (!pathModel && !bodyModel) return;
  let recognized = false;
  const pathIdentities = new Set<string>();
  const qualified = candidates.filter(endpoint => {
    const params = nativeParams(endpoint, path), value = bodyModel ?? params.model ?? params.deployment;
    if (pathModel) {
      pathIdentities.add(params.model ?? params.deployment ?? "");
      if (params.model !== undefined && params.deployment !== undefined) pathIdentities.add(params.deployment);
    }
    const model = provider.models.find(model => model.upstream === value);
    // A router alias is not an upstream model assertion on an overlapping native
    // path. Manifest routes continue to resolve their explicit router selector.
    if (!model && provider.models.some(model => model.id === value))
      throw new HttpError(400, "native_model_alias_unsupported", "overlapping native routes require the selected upstream model identity");
    // A known but ineligible card is not an unknown passthrough model. Keep the
    // literal native-prefix identity rule aligned with providerModel, without
    // invoking its passthrough synthesis or resolving template identities.
    recognized ||= !!model || provider.models.some(row => !row.id.includes("${") && !row.upstream.includes("${")
      && provider.routing.modelPrefixes.some(prefix => row.id === prefix + value));
    return model && modelSupportsEndpoint(provider, model, endpoint);
  });
  if (qualified.length > 1) throw new HttpError(409, "native_route_ambiguous", "native model matches multiple declared operations");
  if (qualified.length || recognized || !pathModel || pathIdentities.size !== 1 || pathIdentities.has("")) return qualified[0];
  const passthrough = candidates.filter(endpoint => endpoint.modelPassthrough);
  if (passthrough.length > 1) throw new HttpError(409, "native_route_ambiguous", "native model matches multiple passthrough operations");
  return passthrough[0];
}
