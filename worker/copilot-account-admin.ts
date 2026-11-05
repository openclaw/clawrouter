import { copilotDeviceAdmin, readCopilotDeviceJson, copilotDeviceReply } from "./copilot-device-admin.ts";
import { BodyLease } from "./body-budget.ts";
import { HttpError } from "./utils.ts";
import type { Env } from "./types.ts";

export const copilotAccountFlow = "copilot-account.v1";
export interface CopilotAccountInput {
  flow: typeof copilotAccountFlow; provider: "github-copilot";
  operation: "qualify" | "status" | "cancel";
  attemptId: string; expectedGeneration: number; expectedLineage: string;
}
export const accountConflict = () => new HttpError(409, "copilot_account_conflict", "Original Copilot account owner changed");
export function readCopilotAccountInput(value: unknown): CopilotAccountInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw accountConflict();
  const v = value as Record<string, unknown>;
  const fields = ["flow", "provider", "operation", "attemptId", "expectedGeneration", "expectedLineage"];
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))
    || v.flow !== copilotAccountFlow || v.provider !== "github-copilot" || !["qualify", "status", "cancel"].includes(v.operation as string)
    || typeof v.attemptId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(v.attemptId)
    || typeof v.expectedLineage !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(v.expectedLineage)
    || !Number.isSafeInteger(v.expectedGeneration) || (v.expectedGeneration as number) < 1) throw accountConflict();
  return v as unknown as CopilotAccountInput;
}
export function copilotAccountFailure(error: unknown): { value: unknown; status: number } {
  return { value: { error: { code: error instanceof HttpError ? error.code : "copilot_account_unavailable", message: "Copilot account qualification unavailable" } },
    status: error instanceof HttpError ? error.status : 503 };
}

// Only bounded original Access/CSRF headers cross the private owner RPC.
export function copilotAccountHeaders(source: Headers): Headers {
  const headers = new Headers({ "content-type": "application/json" }); let units = 0;
  for (const name of ["cf-access-jwt-assertion", "origin", "sec-fetch-site", "x-forwarded-host", "x-forwarded-proto"]) {
    const value = source.get(name);
    if (value === null) continue;
    if (value.length > 16 * 1024 || (units += value.length) > 32 * 1024) throw accountConflict();
    headers.set(name, value);
  }
  return headers;
}

export async function copilotAccountAuthorize(request: Request, env: Env, key: string): Promise<Response> {
  const lease = new BodyLease(); let response: Response | undefined;
  try {
    const url = new URL(request.url);
    if (url.searchParams.size !== 1 || url.searchParams.get("flow") !== copilotAccountFlow) throw accountConflict();
    const actor = await copilotDeviceAdmin(request, env);
    if (!lease.grow(1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
    const input = readCopilotAccountInput(await readCopilotDeviceJson(request));
    await copilotDeviceAdmin(request, env, actor);
    const headers = copilotAccountHeaders(request.headers);
    response = await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch("https://clawrouter.internal/copilot-account", {
      method: "POST", headers, body: JSON.stringify({ key, sourceUrl: request.url, input }), signal: request.signal,
    });
    const status = response.status;
    const value = await readCopilotDeviceJson({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal: request.signal });
    await copilotDeviceAdmin(request, env, actor);
    return copilotDeviceReply(value, status, lease, Promise.resolve(), work => { void work.catch(() => undefined); });
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    const retired = request.body?.locked || response?.body?.locked
      ? Promise.reject(new Error("copilot_account_input_not_retired")) : Promise.resolve();
    const failure = copilotAccountFailure(error);
    return copilotDeviceReply(failure.value, failure.status, lease, retired, work => { void work.catch(() => undefined); });
  }
}
