import { miniMaxSearchProjection } from "./minimax-search-credential.ts";
import { readMiniMaxSearchBinding } from "../shared/minimax-search-binding.ts";
import { miniMaxImageProjection } from "./minimax-image-credential.ts";
import { readMiniMaxImageBinding } from "../shared/minimax-image-binding.ts";
import { vertexAnthropicProjection } from "./vertex-anthropic-binding.ts";
import { miniMaxAnthropicProjection } from "./minimax-anthropic-binding.ts";
import { HttpError } from "./utils.ts";
import type { UpstreamGrant } from "./types";
import { readNativeMediaBinding } from "../shared/native-media-binding.ts";

// An allowlist, rather than object spread: neither legacy secrets nor future
// credential fields may enter the global authority's routing index.
export function routingProjection(grant: UpstreamGrant): UpstreamGrant {
  const fields = ["version", "enabled", "priority", "weight", "kind", "provider", "label", "credentialStore", "credentialGeneration", "credentialLineage", "credentialStatus", "credentialRefreshBlockedUntil", "hasCredential", "credentialFields", "hasAccessToken", "hasRefreshToken", "tokenType", "expiresAt", "scopes", "accountId", "subscription", "createdAt", "updatedAt", "revokedAt"] as const;
  return { ...Object.fromEntries(fields.filter(field => grant[field] !== undefined).map(field => [field, grant[field]])),
    minimaxSearchBinding: miniMaxSearchProjection(grant) ? readMiniMaxSearchBinding(grant.minimaxSearchBinding) : null,
    minimaxImageBinding: miniMaxImageProjection(grant) ? readMiniMaxImageBinding(grant.minimaxImageBinding) : null,
    vertexAnthropicBinding: vertexAnthropicProjection(grant),
    minimaxAnthropicBinding: miniMaxAnthropicProjection(grant),
    nativeMediaBinding: grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
      ? readNativeMediaBinding(grant.nativeMediaBinding) : null };
}

export function publishRoutingProjection(sql: SqlStorage, input: { key: string; generation: number; projection?: UpstreamGrant }): void {
  if (!input.projection) {
    // An overlapping old owner cannot leave a previously indexed generation
    // eligible after publishing new lifecycle state without its projection.
    sql.exec("INSERT INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, NULL, 1) ON CONFLICT (grant_key) DO UPDATE SET projection_json = NULL, legacy = 1", input.key);
    return;
  }
  const projection = routingProjection(input.projection);
  if (projection.credentialGeneration !== input.generation || projection.credentialStore !== "durable_object") throw new HttpError(400, "invalid_authority_request", "projection generation must match its credential owner");
  sql.exec("INSERT INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, 0) ON CONFLICT (grant_key) DO UPDATE SET projection_json = excluded.projection_json, legacy = 0", input.key, JSON.stringify(projection));
}

