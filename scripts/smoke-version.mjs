import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { isAccessRedirect } from "./smoke-access-gate.mjs";
import { runWithinDeadline } from "./smoke-readiness.mjs";

const isVersionId = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const wait = (delayMs, signal) => sleep(delayMs, undefined, { signal });

// Overrides can silently fall back. Every response from the Worker must prove
// the selected version, not just the release number shared by many commits.
export function createVersionFetch({
  baseUrl, versionId, workerName, fetchImpl = fetch,
  retryTimeoutMs = 30_000, sleepImpl = wait, nowImpl = Date.now, log = console.log,
}) {
  const origin = new URL(baseUrl).origin;
  if (!isVersionId(versionId)) throw new Error("invalid smoke Worker version id");
  if (!/^[a-zA-Z0-9_-]+$/.test(workerName)) throw new Error("invalid smoke Worker name");
  if (!Number.isFinite(retryTimeoutMs) || retryTimeoutMs < 0) throw new Error("invalid smoke version retry timeout");
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) return fetchImpl(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Cloudflare-Workers-Version-Overrides", `${workerName}="${versionId}"`);
    // Never follow redirects with the override (or a smoke credential). The
    // caller's normal redirect/Access assertions still validate each response.
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const canRetry = ["GET", "HEAD"].includes(method) && retryTimeoutMs > 0;
    const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = nowImpl() + retryTimeoutMs;
    const expired = new Error("Worker version retry deadline elapsed");
    let lastMismatch;
    const run = async (signal) => {
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        const response = await fetchImpl(input, { ...init, headers, redirect: "manual", ...(signal ? { signal } : {}) });
        try {
          assertVersionResponse(response, url, versionId);
          return response;
        } catch (error) {
          const retry = canRetry && isVersionMismatch(error, versionId);
          if (retry) lastMismatch = error;
          await response.body?.cancel().catch(() => {});
          if (!retry) throw error;
          const remainingMs = deadline - nowImpl();
          if (remainingMs <= 0) throw error;
          const delayMs = Math.min(1_000 * 2 ** Math.min(attempt - 1, 3), 5_000, remainingMs);
          log(`Worker version override pending: path=${url.pathname} expected=${versionId} actual=${error.actual} attempt=${attempt} retryInMs=${delayMs}`);
          await sleepImpl(delayMs, signal);
          if (nowImpl() >= deadline) throw error;
        }
      }
    };
    if (!canRetry) return run(callerSignal);
    try {
      return await runWithinDeadline((signal) => run(callerSignal ? AbortSignal.any([callerSignal, signal]) : signal), retryTimeoutMs, expired);
    } catch (error) {
      if (error === expired && lastMismatch) throw lastMismatch;
      throw error;
    }
  };
}

function isVersionMismatch(error, versionId) {
  return error instanceof assert.AssertionError && error.expected === versionId && isVersionId(error.actual) && error.actual !== versionId;
}

function assertVersionResponse(response, url, versionId) {
  const actual = response.headers.get("x-clawrouter-version-id");
  const protectedPath = /^\/(?:dashboard(?:\/|$)|v1\/(?:session(?:\/|$)|playground(?:\/|$)|admin(?:\/|$)|oauth\/callback$))/.test(url.pathname);
  const accessChallenge = protectedPath && !actual && (
    (response.status >= 300 && response.status < 400 && isAccessRedirect(response.headers.get("location") ?? "", url)) ||
    ([401, 403].includes(response.status) && response.headers.get("content-type")?.includes("text/html"))
  );
  if (!accessChallenge) assert.equal(actual, versionId, `Worker version override not honored for ${url.pathname}`);
}

// Observe raw attempts: hiding a fallback behind a retry would falsely extend
// the streak and expose the next non-retryable provider POST to propagation.
export async function waitForVersionStability({
  baseUrl, versionId, workerName, fetchImpl = fetch, timeoutMs = 30_000,
  consecutiveReads = 5, intervalMs = 1_000, sleepImpl = wait, nowImpl = Date.now, log = console.log,
}) {
  if (![timeoutMs, consecutiveReads, intervalMs].every((value) => Number.isInteger(value) && value > 0)) throw new Error("invalid smoke version stability limits");
  const selected = createVersionFetch({ baseUrl, versionId, workerName, fetchImpl, retryTimeoutMs: 0 });
  const url = `${baseUrl.replace(/\/$/, "")}/v1/health`;
  const deadline = nowImpl() + timeoutMs;
  const failure = new Error(`Worker version override did not stabilize within ${timeoutMs}ms (${consecutiveReads} consecutive honored reads required)`);
  await runWithinDeadline(async (signal) => {
    let consecutive = 0;
    for (let attempt = 1; nowImpl() < deadline; attempt++) {
      try {
        const response = await selected(url, { signal });
        await response.body?.cancel();
        assert.equal(response.ok, true, "version stability health request failed");
        consecutive++;
        if (nowImpl() >= deadline) throw failure;
        if (consecutive >= consecutiveReads) {
          log(`Worker version override stable: expected=${versionId} consecutive=${consecutive} attempts=${attempt}`);
          return;
        }
      } catch (error) {
        if (!isVersionMismatch(error, versionId)) throw error;
        consecutive = 0;
        log(`Worker version stability pending: path=/v1/health expected=${versionId} actual=${error.actual} attempt=${attempt} retryInMs=${Math.min(intervalMs, Math.max(0, deadline - nowImpl()))}`);
      }
      await sleepImpl(Math.min(intervalMs, Math.max(0, deadline - nowImpl())), signal);
    }
    throw failure;
  }, timeoutMs, failure);
}
