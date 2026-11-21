import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { compileProviderSnapshot as compileManifests } from "./compile-providers.mjs";
import { runWithinDeadline } from "./smoke-readiness.mjs";
import { buildProviderSmokePlan, selectLiveProviderPlans, liveProviderList, summarizePlan } from "./provider-smoke-planning.mjs";
export { buildProviderSmokePlan, selectLiveProviderPlans, liveProviderList, summarizePlan };

export class SmokeKeyInspectionUnavailableError extends Error {}

export async function runLiveProviderSmokes({
  baseUrl,
  smokeKey,
  plan,
  liveProviders,
  onResult = async () => {},
}) {
  if (!baseUrl || !smokeKey || liveProviders.length === 0) {
    return [];
  }
  const selected = selectLiveProviderPlans(plan, liveProviders);
  const results = [];
  const failures = [];
  for (const provider of selected) {
    const result = await runProviderTarget(baseUrl, smokeKey, provider);
    results.push(result);
    if (result.providerAttempted) {
      try {
        await onResult(result);
      } catch (error) {
        failures.push(`${provider.id} health record failed: ${errorMessage(error)}`);
      }
    }
    if (result.status !== "verified") {
      failures.push(`${provider.id} smoke failed: ${result.error}`);
    } else {
      try {
        result.usageEventId = await waitForSmokeUsage({ baseUrl, smokeKey, result });
      } catch (error) {
        failures.push(`${provider.id} usage visibility failed: ${errorMessage(error)}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  return results;
}

export async function waitForSmokeUsage({
  baseUrl,
  smokeKey,
  result,
  // Queue delivery has stalled ~60 s in production; readiness (180 s), the POST
  // (10 s) and this wait stay inside the train's five-minute smoke command limit.
  timeoutMs = 100_000,
  fetchImpl = fetch,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  nowImpl = Date.now,
}) {
  const deadline = nowImpl() + timeoutMs;
  let lastFailure = "matching event is not visible";
  while (nowImpl() < deadline) {
    let terminalError;
    let readFailure = "usage request failed or exceeded its deadline";
    try {
      const events = await runWithinDeadline(async (signal) => {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/usage`, {
          headers: { authorization: `Bearer ${smokeKey}`, accept: "application/json" },
          redirect: "manual",
          signal,
        });
        if (!response.ok) {
          readFailure = `GET /v1/usage returned HTTP ${response.status}`;
          if (![408, 429].includes(response.status) && response.status < 500) terminalError = new Error(readFailure);
          // Record terminal protocol/auth failures before disposal: a stalled
          // cancellation must not turn them into a retryable transport failure.
          await response.body?.cancel();
          throw new Error(readFailure);
        }
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          terminalError = new Error("GET /v1/usage returned non-JSON content");
          await response.body?.cancel();
          throw terminalError;
        }
        let payload;
        try { payload = await response.json(); }
        catch (error) {
          if (error instanceof SyntaxError) terminalError = new Error("GET /v1/usage returned invalid JSON");
          throw error;
        }
        if (!Array.isArray(payload?.usage?.events) || payload.usage.events.some((event) => !event || typeof event !== "object" || Array.isArray(event))) {
          throw terminalError = new Error("GET /v1/usage returned an invalid usage.events envelope");
        }
        return payload.usage.events;
      }, Math.max(1, Math.min(10_000, deadline - nowImpl())), "usage request deadline elapsed");
      const event = events.find((entry) => entry.request_id === result.requestId);
      if (event) {
        if (typeof event.id !== "string" || !event.id.trim() || !Number.isFinite(event.occurred_at_ms) || event.provider !== result.provider || event.status !== "success" || event.status_code !== result.statusCode) {
          throw terminalError = new Error(`usage event for ${result.requestId} does not match the successful provider response`);
        }
        return event.id;
      }
      lastFailure = "matching event is not visible";
    } catch {
      if (terminalError) throw terminalError;
      lastFailure = readFailure;
    }
    const remainingMs = deadline - nowImpl();
    if (remainingMs > 0) await sleepImpl(Math.min(2_000, remainingMs));
  }
  throw new Error(`usage visibility unconfirmed for ${result.requestId} after ${timeoutMs}ms: ${lastFailure}; the latest 100 caller-visible events may have evicted it. Inspect usage and queue delivery; do not repeat the provider POST`);
}

export async function inspectSmokeKeyProviderAccess({
  baseUrl,
  smokeKey,
  liveProviders,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/key/inspect`, {
      headers: { authorization: `Bearer ${smokeKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SmokeKeyInspectionUnavailableError(
      `could not reach /v1/key/inspect: ${error.message}`,
    );
  }
  if (!response.ok) {
    let errorCode = "";
    try {
      const body = await response.json();
      errorCode = body?.error?.code ?? "";
    } catch {}
    if (response.status === 400 && errorCode === "invalid_key_syntax") {
      throw new Error(`/v1/key/inspect failed with 400: invalid_key_syntax`);
    }
    throw new SmokeKeyInspectionUnavailableError(
      `/v1/key/inspect failed with ${response.status}${errorCode ? `: ${errorCode}` : ""}`,
    );
  }
  let inspection;
  try {
    inspection = await response.json();
  } catch (error) {
    throw new SmokeKeyInspectionUnavailableError(
      `/v1/key/inspect returned invalid JSON: ${error.message}`,
    );
  }
  if (inspection?.verification === "policy_store_unavailable") {
    throw new SmokeKeyInspectionUnavailableError(
      "/v1/key/inspect reported policy_store_unavailable",
    );
  }
  if (inspection?.verified !== true) {
    throw new Error(
      `/v1/key/inspect rejected the smoke key: ${inspection?.verification ?? "unknown"}`,
    );
  }
  if (!Array.isArray(inspection.providers)) {
    throw new SmokeKeyInspectionUnavailableError(
      "/v1/key/inspect did not expose the smoke key provider scope",
    );
  }
  const denied = liveProviders.filter(
    (provider) => inspection.providers.length > 0 && !inspection.providers.includes(provider),
  );
  if (denied.length > 0) {
    throw new Error(`smoke key policy does not allow live providers: ${denied.join(",")}`);
  }
  return inspection;
}

export function compileProviderSnapshot() {
  const providerFiles = readdirSync("providers")
    .filter((file) => file.endsWith(".provider.yaml"))
    .sort()
    .map((file) => `providers/${file}`);
  return compileManifests(providerFiles.map(path => parse(readFileSync(path, "utf8"))));
}

export async function runProviderTarget(baseUrl, smokeKey, provider) {
  const target = provider.target;
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const requestId = `smoke_${randomUUID()}`;
  if (target.unresolved) return {
    provider: provider.id, requestId, status: "failed", checkedAt, latencyMs: 0,
    statusCode: null, error: target.unresolved, providerAttempted: false,
  };
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${target.route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${smokeKey}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(target.kind === "openai_chat" ? target.body : target.envelope),
    });
  } catch {
    return {
      provider: provider.id,
      requestId,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: null,
      error: "transport failure",
      providerAttempted: false,
    };
  }
  const providerAttempted =
    response.headers.get("x-clawrouter-upstream-provider") === provider.id;
  try {
    await response.arrayBuffer();
  } catch {
    return {
      provider: provider.id,
      requestId,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      error: "response body read failure",
      providerAttempted,
    };
  }
  return {
    provider: provider.id,
    requestId,
    status: response.ok && providerAttempted ? "verified" : "failed",
    checkedAt,
    latencyMs: Date.now() - startedAt,
    statusCode: response.status,
    error: response.ok && providerAttempted
      ? null
      : providerAttempted
        ? `HTTP ${response.status}`
        : `gateway HTTP ${response.status} before upstream response`,
    providerAttempted,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(values) {
  const out = { json: false, strict: false };
  for (const value of values) {
    if (value === "--json") {
      out.json = true;
    } else if (value === "--strict") {
      out.strict = true;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildProviderSmokePlan(compileProviderSnapshot());
  if (args.strict && plan.targetCount !== plan.providerCount) {
    throw new Error(`missing provider smoke targets: ${plan.providerCount - plan.targetCount}`);
  }
  console.log(args.json ? JSON.stringify(plan, null, 2) : summarizePlan(plan));
}
