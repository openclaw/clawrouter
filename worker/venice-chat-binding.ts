import { HttpError } from "./utils.ts";

export type VeniceChatBinding = Readonly<{ selectedUpstreamModel: string }>;

// veniceai/api-docs swagger.yaml, Git blob 37c318af208e3c2e9e46330e7cdde7ab4abfd4c0:
// Chat fallbacks:1545–1557; returned model:8182–8184. Beta fallback behavior,
// omission defaults and SSE identity guarantees are outside this strict profile.
export function prepareVeniceChatBinding(body: Readonly<Record<string, unknown>>, selectedUpstreamModel: string): VeniceChatBinding {
  if (!record(body) || !identity(selectedUpstreamModel) || !Object.hasOwn(body, "model") || body.model !== selectedUpstreamModel)
    throw new HttpError(400, "invalid_venice_chat_request", "Venice Chat requires the literal selected model");
  if ("fallbacks" in body)
    throw new HttpError(400, "unsupported_venice_fallbacks", "Venice fallback requests are not qualified");
  return Object.freeze({ selectedUpstreamModel });
}

// The caller owns framing and must validate every successful JSON/SSE payload
// before releasing its bytes, alongside fresh original-grant and policy checks.
export function validateVeniceReturnedModel(binding: VeniceChatBinding, payload: unknown): string {
  if (!record(binding) || !identity(binding.selectedUpstreamModel) || !record(payload)
    || !Object.hasOwn(payload, "model") || typeof payload.model !== "string" || payload.model !== binding.selectedUpstreamModel)
    throw new HttpError(502, "invalid_venice_returned_model", "Venice response did not confirm the requested model");
  return payload.model;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
