import { grantRoutingPolicy } from "./grant-eligibility.ts";
import type { AuthorizedIdentity } from "./types";
import { sha256Hex } from "./utils.ts";

export function grantStickyInput(auth: AuthorizedIdentity, sessionHash?: string, sessionId?: string | null): Promise<string | null> {
  const routing = grantRoutingPolicy(auth.policy.grantRouting);
  if (routing.stickiness === "none") return Promise.resolve(null);
  const identity = auth.principalId ?? auth.credentialId ?? auth.policyId;
  if (routing.stickiness === "identity") return sha256Hex(`identity:${identity}`);
  return sessionHash ? Promise.resolve(sessionHash) : sha256Hex(`session:${sessionId ?? identity}`);
}
