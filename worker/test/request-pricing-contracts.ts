import type { ImageRequestPricing, OutcomeRequestPricing } from "../../packages/provider-plugin-contract/src/pricing.ts";
import type { ImageRequestPricing as WorkerImagePricing, OutcomeRequestPricing as WorkerOutcomePricing } from "../pricing.ts";

type Assert<T extends true> = T;

export type RequestPricingCompatibility = [
  Assert<ImageRequestPricing extends WorkerImagePricing ? true : false>,
  Assert<WorkerImagePricing extends ImageRequestPricing ? true : false>,
  Assert<OutcomeRequestPricing extends WorkerOutcomePricing ? true : false>,
  Assert<WorkerOutcomePricing extends OutcomeRequestPricing ? true : false>,
];
