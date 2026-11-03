import { BodyLease } from "./body-budget.ts";
import { nativeQuerySearch, type NativeQueryBinding } from "./native-query.ts";
import { jsonBodyStream } from "./json-body.ts";
import type { RequestCostReceipt } from "./pricing.ts";
import type { RequestTariff } from "./request-tariff.ts";
import type { UsageInspection } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

export type ValidatedNativeUsage = UsageInspection & { requestCostReceipt?: RequestCostReceipt };
export interface NativeResponse {
  origin: string;
  path: string;
  query?: NativeQueryBinding;
  tariff?: RequestTariff;
  acquire(): BodyLease;
  read(response: Response, signal: AbortSignal): Promise<{ response: Response; usage: ValidatedNativeUsage }>;
}

export function nativeResponseLease(bytes: number): BodyLease {
  const lease = new BodyLease();
  if (!lease.grow(bytes)) throw new HttpError(503, "server_overloaded", "native response capacity is busy; retry shortly");
  return lease;
}

export function nativeJsonResponse(body: unknown, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name);
  return new Response(jsonBodyStream(body), { status: 200, headers });
}

export function assertNativeResponseDestination(native: NativeResponse | undefined, url: URL): void {
  if (native && (url.origin !== native.origin || url.pathname !== native.path || url.search !== nativeQuerySearch(native.query) || url.hash || url.username || url.password))
    throw new HttpError(400, "invalid_native_response_destination", "native operation requires its qualified origin and selected path");
}
