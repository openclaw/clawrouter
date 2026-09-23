import type { ProviderConnection } from "./types";
import { HttpError } from "./utils.ts";

export type ProviderConnectionMutation = Pick<ProviderConnection, "providerId"> & Partial<Pick<ProviderConnection, "enabled" | "label" | "monthlyBudgetMicros">>;

export function normalizeConnectionMutation(value: unknown, providerId: string, replace = false): ProviderConnectionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_provider_connection", "provider connection must be an object");
  const body = value as Record<string, unknown>;
  const mutation: ProviderConnectionMutation = { providerId };
  if (replace || body.enabled !== undefined) {
    const enabled = body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_provider_connection", "enabled must be a boolean");
    mutation.enabled = enabled;
  }
  if (replace || body.label !== undefined) {
    if (body.label !== undefined && body.label !== null && typeof body.label !== "string") throw new HttpError(400, "invalid_provider_connection", "label must be a string or null");
    mutation.label = typeof body.label === "string" ? body.label.trim() || null : null;
  }
  if (body.monthlyBudgetMicros !== undefined) {
    const limit = body.monthlyBudgetMicros;
    if (limit !== null && (!Number.isSafeInteger(limit) || (limit as number) < 0)) throw new HttpError(400, "invalid_provider_connection", "monthlyBudgetMicros must be a non-negative safe integer or null");
    mutation.monthlyBudgetMicros = limit as number | null;
  }
  return mutation;
}
