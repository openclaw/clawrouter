import { authorityCall, type PoolSubmissionTicketView, type SubmissionReceipt, type SubmissionTicketClaimResult } from "./authority.ts";
import { putGrantCredentials } from "./grant-credentials.ts";
import { syncGrantPoolIndex, validCredentialBundle, validGrantSegment } from "./grant-selection.ts";
import type { Env, UpstreamGrant } from "./types.ts";
import { caughtResponse, errorResponse, HttpError, parseBearer, privateJson, readJson, sha256Hex } from "./utils.ts";

const ALLOWED_FIELDS = new Set(["credential", "credentials", "accessToken", "refreshToken", "tokenType", "expiresAt", "scopes", "accountId", "subscription"]);

export async function poolSubmissionApi(request: Request, env: Env, path: string): Promise<Response> {
  const match = path.match(/^\/v1\/pool-submissions\/([^/]+)\/consume$/);
  if (!match) return errorResponse("route_not_found", "pool submission route not found", 404);
  if (request.method !== "POST") return errorResponse("method_not_allowed", "pool submission method is not allowed", 405);
  const ticketId = decodeURIComponent(match[1]);
  if (!validGrantSegment(ticketId) || !ticketId.startsWith("pst_")) return errorResponse("invalid_pool_submission_ticket", "submission ticket is invalid", 400);
  const ticketToken = parseBearer(request.headers);
  if (!ticketToken) return errorResponse("pool_submission_unauthorized", "a submission ticket bearer token is required", 401);

  let claimId: string | null = null;
  let submissionStored = false;
  try {
    const input = await readJson<unknown>(request);
    const submissionSha256 = await sha256Hex(canonicalJson(input));
    const claim = await authorityCall<SubmissionTicketClaimResult>(env, "/submission-tickets/claim", {
      id: ticketId,
      secretSha256: await sha256Hex(ticketToken),
      submissionSha256,
    });
    if (claim.outcome === "denied") return errorResponse("pool_submission_unauthorized", "submission ticket is invalid or already used", 401);
    if (claim.outcome === "expired") return errorResponse("pool_submission_ticket_expired", "submission ticket has expired", 410);
    if (claim.outcome === "already_consumed") return privateJson({ outcome: claim.outcome, receipt: claim.receipt });
    claimId = claim.claimId;
    const receipt = await storeSubmission(env, claim.ticket, input);
    submissionStored = true;
    const completed = await authorityCall<SubmissionTicketClaimResult>(env, "/submission-tickets/complete", { id: ticketId, claimId, receipt });
    if (completed.outcome !== "already_consumed") throw new HttpError(500, "pool_submission_commit_failed", "submission ticket could not be completed");
    return privateJson({ outcome: "accepted", receipt }, 201);
  } catch (error) {
    if (claimId && !submissionStored) await authorityCall(env, "/submission-tickets/release", { id: ticketId, claimId }).catch(() => undefined);
    return caughtResponse(error, request.headers.get("x-request-id") ?? crypto.randomUUID());
  }
}

async function storeSubmission(env: Env, ticket: PoolSubmissionTicketView, value: unknown): Promise<SubmissionReceipt> {
  const grant = normalizeSubmission(ticket, value);
  const key = ticket.scope === "policies" ? `oauth/${ticket.scopeId}/${ticket.tokenRef}` : `oauth/tenants/${ticket.scopeId}/${ticket.tokenRef}`;
  const existing = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
  await syncGrantPoolIndex(env, key, existing, grant);
  let stored: UpstreamGrant;
  try {
    stored = await putGrantCredentials(env, key, grant);
    await env.POLICY_KV.put(key, JSON.stringify(stored));
  } catch (error) {
    await syncGrantPoolIndex(env, key, grant, existing).catch(() => undefined);
    throw error;
  }
  return { grantKey: key, submittedAt: stored.updatedAt ?? new Date().toISOString() };
}

function normalizeSubmission(ticket: PoolSubmissionTicketView, value: unknown): UpstreamGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_pool_submission", "submission must be a JSON object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknown.length) throw new HttpError(400, "invalid_pool_submission", `submission field is not allowed: ${unknown.sort()[0]}`);
  const credential = optionalString(body.credential, "credential", 64 * 1024);
  const accessToken = optionalString(body.accessToken, "accessToken", 64 * 1024);
  const refreshToken = optionalString(body.refreshToken, "refreshToken", 64 * 1024);
  const credentials = body.credentials == null ? undefined : body.credentials as Record<string, string>;
  if (!validCredentialBundle(credentials) || credentials && Object.keys(credentials).length > 32) throw new HttpError(400, "invalid_pool_submission", "credentials must contain 1 to 32 non-empty string fields");
  if (ticket.kind === "api_key" && !credential && !Object.keys(credentials ?? {}).length) throw new HttpError(400, "invalid_pool_submission", "api_key submissions require credential or credentials");
  if (ticket.kind === "oauth" && !accessToken) throw new HttpError(400, "invalid_pool_submission", "oauth submissions require accessToken");
  if (ticket.kind === "subscription" && !accessToken && !credential) throw new HttpError(400, "invalid_pool_submission", "subscription submissions require accessToken or credential");
  const expiresAt = optionalTimestamp(body.expiresAt, "expiresAt");
  const scopes = stringList(body.scopes, "scopes", 128, 512);
  const tokenType = optionalString(body.tokenType, "tokenType", 64) ?? "Bearer";
  const accountId = optionalString(body.accountId, "accountId", 1024);
  const subscription = subscriptionMetadata(body.subscription);
  const now = new Date().toISOString();
  return {
    version: 1,
    enabled: true,
    priority: ticket.priority,
    weight: ticket.weight,
    kind: ticket.kind,
    provider: ticket.provider,
    label: ticket.label ?? (ticket.contributor ? `${ticket.provider} — ${ticket.contributor}` : `${ticket.provider} contribution`),
    credential,
    credentials,
    accessToken,
    refreshToken,
    tokenType,
    expiresAt,
    scopes,
    accountId,
    subscription,
    maintenance: { keepWarm: ticket.keepWarm },
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };
}

function optionalString(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maxBytes) throw new HttpError(400, "invalid_pool_submission", `${field} must be a non-empty bounded string`);
  return value;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "invalid_pool_submission", `${field} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item || item.length > maxLength)) throw new HttpError(400, "invalid_pool_submission", `${field} must be a bounded string array`);
  return [...new Set(value)];
}

function subscriptionMetadata(value: unknown): UpstreamGrant["subscription"] {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_pool_submission", "subscription must be an object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["plan", "subject"].includes(key))) throw new HttpError(400, "invalid_pool_submission", "subscription contains an unsupported field");
  return { plan: nullableString(body.plan, "subscription.plan"), subject: nullableString(body.subject, "subscription.subject") };
}

function nullableString(value: unknown, field: string): string | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value !== "string" || !value || value.length > 1024) throw new HttpError(400, "invalid_pool_submission", `${field} must be a bounded string or null`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
