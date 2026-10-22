import { correlationMetadata } from "./correlation.ts";

// There is no authorized workspace binding on a policy, connection or grant.
// Silently dropping this selector would execute in an unintended workspace;
// forwarding it would let callers select tenancy on pooled credentials.
export function workspaceSelectionDenied(request: Request, providerId: string): Response | null {
  if (providerId !== "anthropic" || !request.headers.has("anthropic-workspace-id")) return null;
  const requestId = correlationMetadata(request).requestId;
  // Already native-shaped: outer native-error boundaries must preserve it.
  return Response.json({
    type: "error",
    error: {
      type: "permission_error",
      message: "anthropic-workspace-id requires an explicitly authorized workspace binding; ClawRouter does not yet support workspace selection",
    },
    request_id: requestId,
  }, { status: 403, headers: { "request-id": requestId } });
}
