import { DASHBOARD_FETCH_TIMEOUT_MS, fetchTimeoutSignal, PLAYGROUND_FETCH_TIMEOUT_MS } from "../../shared/fetch-timeout";
import type { PlaygroundHttpResponse } from "./ui-types";

export async function localLogin(baseUrl: string, token: string): Promise<string | null> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/session/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: fetchTimeoutSignal(undefined, DASHBOARD_FETCH_TIMEOUT_MS),
  });
  if (response.ok) return null;
  if (response.status === 401) return "invalid admin token";
  if (response.status === 429) return "too many sign-in attempts; wait a minute and retry";
  return `sign-in failed with status ${response.status}`;
}

export async function request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, credentials: "same-origin", headers, signal: fetchTimeoutSignal(init.signal, DASHBOARD_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error((await response.text()) || `${path} failed with ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`${path} returned a non-JSON response from ${baseUrl}`);
  return response.json() as Promise<T>;
}

export async function playgroundRequest(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = PLAYGROUND_FETCH_TIMEOUT_MS,
): Promise<PlaygroundHttpResponse> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
    signal: fetchTimeoutSignal(init.signal, timeoutMs),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const retention = response.headers.get("x-clawrouter-content-retention") ?? "unknown";
  const body = await response.arrayBuffer();
  const text = isTextualResponse(contentType) ? new TextDecoder().decode(body) : "";
  let raw = "";
  if (response.status === 204 || body.byteLength === 0) raw = `HTTP ${response.status} ${response.statusText || "No Content"}`.trim();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      raw = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      raw = text;
    }
  } else if (text) {
    raw = text;
  } else if (!raw) {
    raw = `HTTP ${response.status} ${response.statusText || "OK"}\n${contentType || "binary"} response (${body.byteLength} bytes)`;
  }
  return { ok: response.ok, raw, status: response.status, statusText: response.statusText, contentType, retention };
}

export function isTextualResponse(contentType: string) {
  return /(^text\/|json|xml|html|csv|yaml|graphql|javascript)/i.test(contentType);
}
