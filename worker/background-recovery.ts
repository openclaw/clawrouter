import { liveBackground, type BackgroundRecord } from "./background-store.ts";
import { backgroundCall } from "./http-background.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, readJson } from "./utils.ts";

// Called only behind the existing administrator/same-origin boundary. One
// locator names one scoped owner; there is no global enumeration or job index.
export async function backgroundRecovery(request: Request, env: Env): Promise<Response> {
  const input = await readJson<{ action?: string; locator?: string; scope?: string; after?: string }>(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_recovery_request", "recovery requires a JSON object");
  const allowed = input.action === "list" ? ["action", "scope", "after"] : ["action", "locator"];
  if (Object.keys(input).some(field => !allowed.includes(field))) throw new HttpError(400, "invalid_recovery_request", "recovery accepts only the fields declared for its selected action");
  const match = typeof input.locator === "string" ? input.locator.match(/^([0-9a-f]{64})\.(bg_[0-9a-f]{32})$/) : null;
  const digest = input.action === "list" ? input.scope : match?.[1];
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !["inspect", "list", "replay"].includes(input.action ?? "")) throw new HttpError(400, "invalid_recovery_request", "provide an inspect/replay locator, or list with one scope digest");
  const scope = `http-continuations:${digest}`;
  if (input.action === "list") {
    if (input.after !== undefined && !/^bg_[0-9a-f]{32}$/.test(input.after)) throw new HttpError(400, "invalid_recovery_cursor", "after must be a background job ID from this scope");
    const { records } = await backgroundCall<{ records: BackgroundRecord[] }>(env, scope, { action: "list", after: input.after });
    return privateJson({ scope: digest, records: records.map(summary), nextAfter: records.length === 16 ? records[15].id : null });
  }
  const id = match![2];
  let record = await backgroundCall<BackgroundRecord | null>(env, scope, { action: "get", id });
  if (!record) throw new HttpError(404, "background_unavailable", "recovery record is absent or retired; this does not confirm settlement");
  if (input.action === "replay") {
    if (!liveBackground(record) || !record.event || Date.now() >= record.replayUntil) throw new HttpError(409, "background_replay_unavailable", "only an unresolved frozen receipt before its original replay deadline can be replayed");
    record = await backgroundCall<BackgroundRecord>(env, scope, { action: "replay", id });
  }
  return privateJson({ scope: digest, record: summary(record) });
}

function summary(record: BackgroundRecord) {
  const { id, phase, admittedAt, observeUntil, autoRetryUntil, replayUntil, eventId, requestId, amount, basis, usage, settlements, lastError } = record;
  return { id, phase, admittedAt, observeUntil, autoRetryUntil, replayUntil, eventId, requestId, amount, basis,
    usageDisposition: usage, settlementDispositions: settlements, lastError,
    replayEligible: liveBackground(record) && !!record.event && Date.now() < replayUntil };
}
