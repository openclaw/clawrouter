import { correlationMetadata } from "./correlation.ts";

// Neither workspace tenancy nor profile trust grants/abuse attribution may be
// selected by a caller using shared operator credentials. Both require a future
// operator-authorized policy/principal binding, not a passthrough allowlist.
export function identitySelectionDenied(request: Request, providerId: string): Response | null {
  if (providerId !== "anthropic") return null;
  const selector = ["anthropic-workspace-id", "anthropic-user-profile-id"].find(name => request.headers.has(name));
  if (!selector) return null;
  const kind = selector === "anthropic-workspace-id" ? "workspace" : "user-profile";
  const requestId = correlationMetadata(request).requestId;
  // Already native-shaped: outer native-error boundaries must preserve it.
  return Response.json({
    type: "error",
    error: {
      type: "permission_error",
      message: `${selector} requires an explicitly authorized ${kind} binding; ClawRouter does not yet support ${kind} selection`,
    },
    request_id: requestId,
  }, { status: 403, headers: { "request-id": requestId } });
}
