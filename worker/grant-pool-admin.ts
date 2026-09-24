import { authorityCall, type GrantAttachmentResult } from "./authority.ts";
import { backfillGrantAttachment, reconcileGrantAttachment } from "./grant-credentials.ts";
import type { GrantPoolReadiness, GrantPoolRepairIssue } from "../shared/contracts.ts";
import { validGrantSegment } from "./grant-selection.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, readJson } from "./utils.ts";

const PREFIX = "/v1/admin/grant-pools";
const PAGE_SIZE = 32;

export function grantPoolReadiness(env: Env): Promise<GrantPoolReadiness> {
  return authorityCall(env, "/grant-pools/readiness", {});
}

// Called only after the existing admin/CSRF authorization boundary. Migration
// reads KV names, never credentials or caller-authored attachment metadata.
export async function grantPoolAdmin(request: Request, env: Env): Promise<Response> {
  const action = new URL(request.url).pathname.slice(PREFIX.length);
  if (action === "/readiness" && request.method === "GET") return privateJson(await grantPoolReadiness(env));
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "account recovery requires POST");
  const body = await readJson<Record<string, unknown>>(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_grant_pool_request", "account recovery requires an object");
  if (action === "/baseline") return privateJson(await authorityCall(env, "/grant-pools/readiness/baseline", { revision: body.revision, baseline: body.baseline, confirmed: body.confirmed }));
  if (action === "/scan" || action === "/activate") return privateJson(await authorityCall(env, `/grant-pools/readiness/${action === "/scan" ? "begin" : "activate"}`, { revision: body.revision }));
  if (action === "/advance") {
    const state = await grantPoolReadiness(env);
    if (state.scanRevision !== body.scanRevision || state.phase !== body.phase || state.cursor !== body.cursor || !["kv", "index"].includes(state.phase)) throw new HttpError(409, "grant_pool_readiness_changed", "scan changed; read the current page before continuing");
    const page = state.phase === "kv"
      ? await env.POLICY_KV.list({ prefix: "oauth/", limit: PAGE_SIZE, ...(state.cursor ? { cursor: state.cursor } : {}) }).then(page => ({ keys: page.keys.map(key => key.name), cursor: page.list_complete ? null : page.cursor }))
      : await authorityCall<{ keys: string[]; cursor: string | null }>(env, "/grant-pools/readiness/keys", { cursor: state.cursor });
    const issues: GrantPoolRepairIssue[] = [];
    const outcomes = [];
    for (const key of page.keys) {
      const result = await repairKey(env, key, true);
      outcomes.push(result);
      // A canceled proposal proves only that proposal was uncommitted. A KV
      // key with no owner is still an unresolved legacy account, never absence.
      const reason = result.reason ?? (!result.ownerPresent && state.phase === "kv" ? "owner_missing" : undefined);
      if (reason) issues.push({ key, reason });
    }
    const readiness = await authorityCall<GrantPoolReadiness>(env, "/grant-pools/readiness/advance", { scanRevision: state.scanRevision, phase: state.phase, cursor: state.cursor, nextCursor: page.cursor, count: page.keys.length, issues });
    return privateJson({ readiness, outcomes });
  }
  if (action === "/repair") {
    // An indexed active or detached owner can still owe its KV projection.
    // Pending memberships alone cannot enumerate these committed writes.
    const page = await authorityCall<{ keys: string[]; cursor: string | null }>(env, "/grant-pools/readiness/keys", { cursor: body.cursor ?? null });
    const outcomes = [];
    for (const key of page.keys) outcomes.push(await repairKey(env, key, false));
    return privateJson({ ...page, outcomes, readiness: await grantPoolReadiness(env) });
  }
  throw new HttpError(404, "route_not_found", "account recovery route not found");
}

async function repairKey(env: Env, key: string, backfill: boolean): Promise<{ key: string; outcome?: GrantAttachmentResult["outcome"]; ownerPresent?: boolean; reason?: GrantPoolRepairIssue["reason"] }> {
  const parts = key.split("/");
  const valid = parts[0] === "oauth" && (parts[1] === "tenants" ? parts.length === 4 : parts.length === 3) && parts.slice(1).every(validGrantSegment);
  if (!valid) return { key, reason: "identity_unresolved" };
  try {
    const result: GrantAttachmentResult & { ownerPresent?: boolean } = backfill ? await backfillGrantAttachment(env, key) : await reconcileGrantAttachment(env, key);
    const reason = result.outcome === "unresolved" || result.outcome === "unattached" ? "identity_unresolved" : undefined;
    return { key, outcome: result.outcome, ownerPresent: result.ownerPresent, reason };
  } catch (error) {
    // Fixed diagnostics cannot echo provider errors, credential data or caller
    // metadata. An unavailable owner is unknown and blocks activation.
    return { key, reason: error instanceof HttpError && error.status < 500 ? "repair_failed" : "owner_unavailable" };
  }
}
