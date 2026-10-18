import type { AccessControlUser, AccessUserRecord } from "./types";
import { HttpError, normalizeEmail } from "./utils.ts";

export function normalizeUser(value: AccessControlUser): AccessControlUser {
  const email = normalizeEmail(value.email);
  if (!email) throw new HttpError(400, "authority_error", "invalid access user email");
  return { email, record: {
    role: value.record.role ?? "user", tenantId: value.record.tenantId ?? "default", enabled: value.record.enabled ?? true,
    groups: [...new Set(value.record.groups ?? [])].map(item => item.trim().toLowerCase()).filter(Boolean).sort(),
    contentRetentionDisabled: value.record.contentRetentionDisabled ?? false, assignmentState: value.record.assignmentState,
    ...(value.record.budgetOverrides ? { budgetOverrides: value.record.budgetOverrides } : {}),
  } };
}

export function profileUpdate(raw: AccessControlUser, current?: AccessUserRecord): AccessControlUser {
  // Profile saves cannot restore a stale role or overwrite concurrent cap edits.
  return normalizeUser({ ...raw, record: { ...raw.record, role: current?.role ?? "user", budgetOverrides: current?.budgetOverrides } });
}
