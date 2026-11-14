import type { FusionConfig } from "./contracts.ts";

/** Legacy profiles retain the original parallel-adviser behavior. */
export function fusionStrategy(config: Pick<FusionConfig, "strategy">): "single" | "ensemble" {
  return config.strategy ?? "ensemble";
}

export function fusionAdviserModels(config: Pick<FusionConfig, "strategy" | "adviserModels">): string[] {
  return fusionStrategy(config) === "single" ? [] : config.adviserModels;
}
