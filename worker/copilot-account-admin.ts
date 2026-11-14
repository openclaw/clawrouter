import { copilotDeviceAdmin, readCopilotDeviceBytes, readCopilotDeviceJson, copilotDeviceReply } from "./copilot-device-admin.ts";
import { copilotControlHeaders, assertCopilotControlHeaders, qualifiedCopilotControlHeaders, copilotControlReply } from "./copilot-inference-control.ts";
import { inputRetirement } from "./input-retirement.ts";
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
  const headers = qualifiedCopilotControlHeaders(source);
  headers.delete("content-length"); headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return headers;
}

export async function copilotAccountAuthorize(request: Request, env: Env, key: string): Promise<Response> {
  const lease = new BodyLease(); let response: Response | undefined;
  try {
    const url = new URL(request.url);
    if (url.searchParams.size !== 1 || url.searchParams.get("flow") !== copilotAccountFlow) throw accountConflict();
    assertCopilotControlHeaders(request.headers);
    const actor = await copilotDeviceAdmin(request, env);
    if (!lease.grow(1024 * 1024)) return await borrowedCopilotAccountControl(request, env, key, actor);
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

// The frontend and credential owner may be different isolates. Reserve the
// owner's exclusive control share over private HTTP before reading input; no
// module-global pool, public allocation or credential crosses this boundary.
async function borrowedCopilotAccountControl(request: Request, env: Env, key: string, actor: string): Promise<Response> {
  if (key.length > 512 || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(key) || request.url.length > 2048) throw accountConflict();
  const id = crypto.randomUUID().replaceAll("-", "");
  const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key));
  let response: Response | undefined, attempted = false, retirement: Promise<void> | undefined;
  const send = (phase: "reserve" | "execute" | "retire", body?: Uint8Array<ArrayBuffer>) => {
    const headers = qualifiedCopilotControlHeaders(request.headers, {
      [copilotControlHeaders.phase]: phase, [copilotControlHeaders.id]: id,
      [copilotControlHeaders.key]: key, [copilotControlHeaders.source]: request.url,
    });
    headers.delete("content-length");
    if (phase !== "execute") headers.delete("content-encoding");
    return stub.fetch("https://clawrouter.internal/copilot-account", {
      method: "POST", headers, body, ...(phase === "retire" ? {} : { signal: request.signal }),
    });
  };
  const dispose = async (value: Pick<Response, "body" | "bodyUsed">) => {
    if (value.body?.locked) throw new Error("copilot_control_input_not_retired");
    if (value.body && !value.bodyUsed) await inputRetirement(value.body.getReader()).retire("cancel");
  };
  const finish = () => retirement ??= (async () => {
    // Physical readers settle before this acknowledgment. It never waits for
    // the inference allocation whose retirement, in turn, joins this slot.
    await dispose(request); if (response) await dispose(response);
    if (!attempted) return;
    const retired = await send("retire"); await dispose(retired);
    if (retired.status !== 204 && retired.status !== 409) throw accountConflict();
  })();
  try {
    attempted = true; response = await send("reserve");
    const status = response.status;
    if (status !== 204) {
      // A refused reservation has only the existing bounded failure envelope.
      const value = await readCopilotDeviceJson({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal: request.signal });
      return copilotControlReply(value, status, finish);
    }
    await dispose(response); response = undefined;
    await copilotDeviceAdmin(request, env, actor);
    // Forward original bounded bytes: only the owner creates the input graph.
    let bytes: Uint8Array<ArrayBuffer> | undefined = await readCopilotDeviceBytes(request);
    await copilotDeviceAdmin(request, env, actor);
    try { response = await send("execute", bytes); } finally { bytes = undefined; }
    const replyStatus = response.status;
    const value = await readCopilotDeviceJson({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal: request.signal });
    await copilotDeviceAdmin(request, env, actor);
    return copilotControlReply(value, replyStatus, finish);
  } catch (error) {
    const failure = copilotAccountFailure(error);
    return copilotControlReply(failure.value, failure.status, finish);
  }
}
