import type { ProviderConnection } from "./types";
import { HttpError } from "./utils.ts";
import { PreparationAdmission } from "./provider-templates.ts";

export function providerConfigurationList(value: string, owner?: PreparationAdmission, name = "configuration", relevant?: readonly string[], sourceAdmitted = false): string[] {
  if (!owner) return value.split(",").map(item => item.trim()).filter(Boolean);
  if (!sourceAdmitted) owner.csv(value);
  const selected: string[] = []; let start = 0;
  for (let end = 0; end <= value.length; end++) if (end === value.length || value.charCodeAt(end) === 44) {
    let lo = start, hi = end; start = end + 1;
    while (lo < hi && /\s/u.test(value[lo])) lo++;
    while (hi > lo && /\s/u.test(value[hi - 1])) hi--;
    if (lo === hi) continue;
    // Unknown optional names never become retained token strings.
    if (relevant) {
      const key = relevant.find(key => key.length === hi - lo && value.startsWith(key, lo));
      if (key === undefined) continue;
      owner.text(key, 256);
    }
    selected.push(owner.csvToken(name, value, lo, hi));
  }
  return selected;
}

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
