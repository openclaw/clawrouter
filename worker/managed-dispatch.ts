import { managedLifecycleAdapter } from "./managed-lifecycle-adapters.ts";
import type { ManagedControl, ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import type { CompiledProvider } from "./types.ts";
import { HttpError } from "./utils.ts";

export function managedProbeId(adapter: ManagedLifecycleAdapter): string {
  return adapter.validateId(adapter.identityProbe ?? (adapter.protocol === "replicate.predictions" ? "owner-pin" : "11111111-1111-4111-8111-111111111111"));
}

export function assertManagedDispatch(protocol: string | undefined, request: Request): void {
  if (!protocol) return;
  const adapter = managedLifecycleAdapter(protocol);
  if (!adapter || protocol === "dashscope.video" && !adapter.assertDispatch) unavailable();
  try {
    // A Promise cannot be an admission verdict; the hook is deliberately pure.
    const result: unknown = adapter.assertDispatch?.(new Request(request));
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => undefined);
      unavailable();
    }
  } catch { unavailable(); }
}

export function managedHeaderIdentity(provider: CompiledProvider, control: Pick<ManagedControl, "headers" | "transientHeaders">): Array<[string, string]> {
  const headers = [...(control.headers ?? new Headers())], transient = control.transientHeaders ?? [];
  if (headers.length > 16 || transient.length > 4 || new Set(transient).size !== transient.length) unavailable();
  const credentials = provider.auth.schemes.flatMap(scheme => "header" in scheme && typeof scheme.header === "string" ? [scheme.header.toLowerCase()] : []);
  for (const name of transient) if (typeof name !== "string" || name !== name.toLowerCase() || !control.headers?.has(name)) unavailable();
  return headers.map(([name, value]): [string, string] => {
    if (credentials.includes(name) || /authorization|api[-_]?key|token|secret|cookie|^host$|^connection$|^content-length$|^transfer-encoding$|^idempotency-key$|^openai-organization$|^openai-project$|^anthropic-workspace-id$|^anthropic-user-profile-id$/i.test(name)
      || !/^[\x20-\x7e]{1,1024}$/.test(value)) unavailable();
    if (transient.includes(name)) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) unavailable();
      return [name, "<per-attempt-uuid>"];
    }
    return [name, value];
  });
}

export function applyManagedHeaders(provider: CompiledProvider, target: Headers, control: Pick<ManagedControl, "headers" | "transientHeaders">): void {
  managedHeaderIdentity(provider, control);
  control.headers?.forEach((value, name) => {
    if (target.has(name) && target.get(name) !== value && !["accept", "content-type", "cancel-after"].includes(name)) unavailable();
    target.set(name, value);
  });
}

function unavailable(): never { throw new HttpError(503, "managed_dispatch_unavailable", "the managed request credential, origin or protocol headers are unqualified"); }
