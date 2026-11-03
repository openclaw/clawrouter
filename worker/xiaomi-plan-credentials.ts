import { HttpError } from "./utils";

const PLAN_PROVIDERS = new Set(["xiaomi-token-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams"]);

// Shape validation only: the selected account still owns region and entitlement.
export function assertXiaomiTokenPlanCredential(providerId: string, credential: string): void {
  if (!PLAN_PROVIDERS.has(providerId)) return;
  if (typeof credential !== "string" || !/^(?:tp|ttp)-\S+$/i.test(credential.trim())) {
    throw new HttpError(503, "provider_credentials_invalid", "Xiaomi Token Plan requires a plan credential");
  }
}
