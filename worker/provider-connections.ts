import type { ProviderConnection } from "./types";
import { HttpError } from "./utils.ts";
import { PreparationAdmission } from "./provider-templates.ts";

export type ProviderConnectionMutation = Pick<ProviderConnection, "providerId"> & Partial<Pick<ProviderConnection, "enabled" | "label" | "monthlyBudgetMicros">>;

export function normalizeConnectionMutation(value: unknown, providerId: string, replace = false): ProviderConnectionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_provider_connection", "provider connection must be an object");
  const body = value as Record<string, unknown>;
  const enabled = body.enabled === undefined && replace ? true : body.enabled;
  const label = body.label;
  const limit = body.monthlyBudgetMicros;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "invalid_provider_connection", "enabled must be a boolean");
  if (label !== undefined && label !== null && typeof label !== "string") throw new HttpError(400, "invalid_provider_connection", "label must be a string or null");
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || (limit as number) < 0)) throw new HttpError(400, "invalid_provider_connection", "monthlyBudgetMicros must be a non-negative safe integer or null");
  // Independent connection-mutation entry, not a selected-helper owner reset.
  const admission = new PreparationAdmission();
  admission.primitive("providerId", providerId);
  if (replace || enabled !== undefined) admission.primitive("enabled", enabled);
  if (replace || label !== undefined) admission.primitive("label", label);
  if (limit !== undefined) admission.primitive("monthlyBudgetMicros", limit);
  const mutation: ProviderConnectionMutation = { providerId };
  if (enabled !== undefined) mutation.enabled = enabled;
  if (replace || label !== undefined) mutation.label = typeof label === "string" ? label.trim() || null : null;
  if (limit !== undefined) mutation.monthlyBudgetMicros = limit as number | null;
  return mutation;
}
