import type { AccessPolicy } from "./types.ts";
import { HttpError } from "./utils.ts";

// Two explicitly named operations, never a policy-wide generation fee or a
// claimed vendor tariff. Discovery considers their combined reservation.
export function pixVerseInputFixedCost(policy: AccessPolicy): number {
  let total = 0;
  for (const capability of ["pixverse.image_upload", "video.generate"]) {
    const value = policy.requestCostsMicros?.[capability];
    if (!Object.hasOwn(policy.requestCostsMicros ?? {}, capability) || !Number.isSafeInteger(value) || value! < 0)
      throw new HttpError(400, "pricing_required", "input upload and generation each require their own explicit policy operation price");
    total += value!;
  }
  if (!Number.isSafeInteger(total)) throw new HttpError(400, "pricing_required", "combined input operation prices exceed the supported bound");
  return total;
}
export function assertInputOperationPolicy(policy: AccessPolicy): void { pixVerseInputFixedCost(policy); }
