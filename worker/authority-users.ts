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

// PRIVATE bridge only. The original parsed groups stay borrowed/read-only.
// Raw SameValueZero dedup precedes trim/lower exactly as the ordinary Set does;
// distinct raw strings that normalize equally remain duplicate output strings.
function* privateRawGroups(value: unknown): Generator<unknown> {
  if (value == null) return;
  if (typeof value === "string") {
    let offset = 0;
    for (const character of value) {
      let before = 0, duplicate = false;
      for (const previous of value) { if (before >= offset) break; if (previous === character) { duplicate = true; break; } before += previous.length; }
      if (!duplicate) yield character; offset += character.length;
    }
    return;
  }
  if (!Array.isArray(value)) throw new TypeError("groups is not iterable");
  for (let index = 0; index < value.length; index++) {
    const item = value[index]; let duplicate = false;
    for (let before = 0; before < index; before++) if (value[before] === item || value[before] !== value[before] && item !== item) { duplicate = true; break; }
    if (!duplicate) yield item;
  }
}
export function normalizePrivateUser(value: AccessControlUser,
  admit: (emit: (plan: ReturnType<typeof import("./identity-admission.ts").identityPlan>) => void) => void): AccessControlUser {
  const email = normalizeEmail(value.email);
  if (!email) throw new HttpError(400, "authority_error", "invalid access user email");
  const fields = value.record;
  // Plan the complete generated RECORD before constructing its output groups.
  // Calling trim on a malformed unique item retains the ordinary TypeError.
  admit(plan => plan.object(0, field => {
    field("role", fields.role ?? "user"); field("tenantId", fields.tenantId ?? "default"); field("enabled", fields.enabled ?? true);
    field("groups", undefined, () => plan.array(1, entry => { for (const item of privateRawGroups(fields.groups)) { const normalized = (item as string).trim().toLowerCase(); if (normalized) entry(normalized); } }));
    field("contentRetentionDisabled", fields.contentRetentionDisabled ?? false); field("assignmentState", fields.assignmentState);
    if (fields.budgetOverrides) field("budgetOverrides", fields.budgetOverrides);
  }));
  const groups: string[] = [];
  for (const item of privateRawGroups(fields.groups)) { const normalized = (item as string).trim().toLowerCase(); if (normalized) groups.push(normalized); }
  groups.sort(); // existing string ordering; only the owned output array is sorted
  return { email, record: { role: fields.role ?? "user", tenantId: fields.tenantId ?? "default", enabled: fields.enabled ?? true,
    groups, contentRetentionDisabled: fields.contentRetentionDisabled ?? false, assignmentState: fields.assignmentState,
    ...(fields.budgetOverrides ? { budgetOverrides: fields.budgetOverrides } : {}) } };
}
