import { HttpError } from "./utils";

const CODING_PROVIDERS = new Set(["qwen-coding-global", "qwen-coding-cn"]);

// Shape only: regional entitlement and the named subscriber require separate qualification.
export function assertQwenCodingPlanCredential(providerId: string, credential: string): void {
  if (!CODING_PROVIDERS.has(providerId)) return;
  if (typeof credential !== "string" || !/^sk-sp-\S+$/.test(credential.trim())) {
    throw new HttpError(503, "provider_credentials_invalid", "Qwen Coding Plan requires a plan credential");
  }
}
