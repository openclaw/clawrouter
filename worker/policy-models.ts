import { withLimitHint } from "./policy-limits.ts";
import { policyAllowsModel } from "../shared/policy-models.ts";
import type { AccessPolicy } from "./types";
import type { ProxySelection } from "./proxy-selection";
import { HttpError } from "./utils.ts";

export { policyAllowsModel };

export function assertPolicyModel(policy: AccessPolicy, selection: { model: Pick<NonNullable<ProxySelection["model"]>, "id"> | null; endpoint: ProxySelection["endpoint"]; capability: string }): void {
  if (selection.model) {
    if (policy.models != null && !policy.models.includes(selection.model.id)) throw new HttpError(403, "model_not_allowed", withLimitHint("model is not allowed by this policy", policy));
  } else if (policy.models != null && (selection.capability.startsWith("llm.") || selection.endpoint.request_format === "cloudflare_ai_gateway.universal")) {
    // Opaque gateway fallbacks cannot prove that every downstream model is allowed.
    throw new HttpError(403, "model_not_allowed", withLimitHint("this policy requires a registered allowed model", policy));
  }
}
