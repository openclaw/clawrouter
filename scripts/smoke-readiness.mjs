const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const MAX_READINESS_TIMEOUT_MS = 600_000;

export function smokeReadinessTimeoutMs(env = process.env) {
  const raw = env.CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_READINESS_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      "CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS must be an integer from 1000 to 600000",
    );
  }
  const value = Number(raw);
  if (value < 1_000 || value > MAX_READINESS_TIMEOUT_MS) {
    throw new Error(
      "CLAWROUTER_SMOKE_READINESS_TIMEOUT_MS must be an integer from 1000 to 600000",
    );
  }
  return value;
}

export function waitForHealth(options) {
  return waitForReadiness(options, "deployed");
}

export function waitForSelfHostHealth(baseUrl) {
  return waitForReadiness({ baseUrl, timeoutMs: 30_000 }, "self-host");
}

async function waitForReadiness({
  baseUrl,
  expectedEnvironment,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  nowImpl = Date.now,
  probeImpl,
  log = console.log,
}, profile) {
  const selfHost = profile === "self-host";
  const origin = requiredBaseUrl(baseUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_READINESS_TIMEOUT_MS) {
    throw new Error("health readiness timeout must be an integer from 1000 to 600000 ms");
  }
  const startedAt = nowImpl();
  const deadline = startedAt + timeoutMs;
  let attempt = 0;
  let lastFailure = "no response";

  while (nowImpl() < deadline) {
    attempt += 1;
    const requestTimeoutMs = Math.max(
      1,
      Math.min(selfHost ? 2_000 : 10_000, deadline - nowImpl()),
    );
    try {
      const { response, health } = await runWithinDeadline(async (signal) => {
        const response = await fetchImpl(`${origin}/v1/health`, {
          redirect: selfHost ? "follow" : "manual",
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { response };
        }
        try {
          return { response, health: await response.json() };
        } catch (error) {
          if (signal.aborted || selfHost) throw error;
          return { response, health: null };
        }
      }, requestTimeoutMs, "health request deadline elapsed");
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else if (selfHost) {
        // The self-host CLI owns its immediate payload/version assertions and
        // follows local reverse-proxy redirects; deployed readiness retries them.
        return health;
      } else {
        if (health?.ok !== true) {
          lastFailure = "invalid health payload";
        } else if (
          expectedEnvironment &&
          health.environment !== expectedEnvironment
        ) {
          lastFailure = `environment ${JSON.stringify(health.environment ?? null)} did not match ${JSON.stringify(expectedEnvironment)}`;
        } else {
          try {
            if (probeImpl) {
              const remainingMs = deadline - nowImpl();
              if (remainingMs <= 0) {
                throw new Error("readiness probe deadline elapsed");
              }
              await runWithinDeadline(
                (signal) => probeImpl(health, { signal, remainingMs }),
                remainingMs,
                "readiness probe deadline elapsed",
              );
            }
            log(
              `health readiness passed after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
            );
            return health;
          } catch (error) {
            lastFailure = `readiness probe: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
    } catch (error) {
      lastFailure = `request error: ${error instanceof Error ? error.message : String(error)}`;
    }

    const remainingMs = deadline - nowImpl();
    if (remainingMs <= 0) break;
    const delayMs = Math.min(
      selfHost ? 500 : Math.min(10_000, 1_000 * 2 ** (attempt - 1)),
      remainingMs,
    );
    log(
      `health readiness pending: attempt=${attempt} reason=${lastFailure} retryInMs=${delayMs}`,
    );
    await sleepImpl(delayMs);
  }

  if (selfHost) throw new Error(`self-host health did not become ready: ${lastFailure}`);
  throw new Error(
    `health readiness timed out after ${timeoutMs}ms (${attempt} attempts): ${lastFailure}`,
  );
}

async function runWithinDeadline(run, timeoutMs, message) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    // AbortSignal.timeout() is unref'ed. This owned timer must keep standalone
    // smoke processes alive through fetch AND body reads, then settle visibly.
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function requiredBaseUrl(value) {
  const normalized = value?.trim().replace(/\/$/, "");
  if (!normalized) throw new Error("CLAWROUTER_BASE_URL is required for health readiness");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("CLAWROUTER_BASE_URL must be a valid absolute URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("CLAWROUTER_BASE_URL must use http or https");
  }
  return normalized;
}
