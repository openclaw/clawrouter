export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DASHBOARD_FETCH_TIMEOUT_MS = 60_000;
export const PLAYGROUND_FETCH_TIMEOUT_MS = 600_000;

export function fetchTimeoutSignal(existing?: AbortSignal | null, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return existing ? AbortSignal.any([existing, timeout]) : timeout;
}
