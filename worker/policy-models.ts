import { policyAllowsModel } from "../shared/policy-models.ts";
import type { AccessPolicy } from "./types";
import type { ProxySelection } from "./proxy-selection";
import { HttpError } from "./utils";

export { policyAllowsModel };

export function assertPolicyModel(policy: AccessPolicy, selection: ProxySelection): void {
  if (selection.model) {
    if (policy.models != null && !policy.models.includes(selection.model.id)) throw new HttpError(403, "model_not_allowed", "model is not allowed by this policy");
  } else if (policy.models != null && (selection.capability.startsWith("llm.") || selection.endpoint.request_format === "cloudflare_ai_gateway.universal")) {
    // Opaque gateway fallbacks cannot prove that every downstream model is allowed.
    throw new HttpError(403, "model_not_allowed", "this policy requires a registered allowed model");
  }
}
