// Quota declarations and semantic checks after provider manifest schema validation.
// Runtime polling, observations, and admission remain separate.

export function normalizeQuota(value) {
  const fallback = [
    { id: "requests", kind: "requests", limitHeaders: ["ratelimit-limit-requests", "x-ratelimit-limit-requests"], remainingHeaders: ["ratelimit-remaining-requests", "x-ratelimit-remaining-requests"], resetHeaders: ["ratelimit-reset-requests", "x-ratelimit-reset-requests"] },
    { id: "tokens", kind: "tokens", limitHeaders: ["ratelimit-limit-tokens", "x-ratelimit-limit-tokens"], remainingHeaders: ["ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens"], resetHeaders: ["ratelimit-reset-tokens", "x-ratelimit-reset-tokens"] },
    { id: "generic", kind: "generic", limitHeaders: ["ratelimit-limit", "x-ratelimit-limit"], remainingHeaders: ["ratelimit-remaining", "x-ratelimit-remaining"], resetHeaders: ["ratelimit-reset", "x-ratelimit-reset"] },
  ];
  return {
    responseHeaders: (value?.responseHeaders ?? fallback).map((window) => normalizeQuotaWindow(window, false)),
    probes: (value?.probes ?? []).map((probe) => ({
      grantKinds: probe.grantKinds ?? [],
      requiresRefreshToken: probe.requiresRefreshToken === true,
      url: probe.url,
      method: probe.method ?? "GET",
      headers: probe.headers ?? {},
      ...(probe.facts ? { facts: probe.facts } : {}),
      windows: (probe.windows ?? []).map((window) => normalizeQuotaWindow(window, true)),
    })),
  };
}

function normalizeQuotaWindow(window, probe) {
  const shared = { id: window.id, kind: window.kind, unit: window.unit ?? null, window: window.window ?? null, fixedLimit: window.fixedLimit ?? null, metricScale: window.metricScale ?? 1 };
  return probe ? {
    ...shared,
    ...(window.models ? { models: window.models } : {}),
    ...(window.collection ? { collection: window.collection } : {}),
    limitPointer: window.limitPointer ?? null,
    remainingPointer: window.remainingPointer ?? null,
    usedPointer: window.usedPointer ?? null,
    resetPointer: window.resetPointer ?? null,
  } : {
    ...shared,
    limitHeaders: window.limitHeaders ?? [],
    remainingHeaders: window.remainingHeaders ?? [],
    usedHeaders: window.usedHeaders ?? [],
    resetHeaders: window.resetHeaders ?? [],
  };
}

export function validateQuota(providerId, quota) {
  const validateBase = (window) => {
    if (window.fixedLimit != null && (!Number.isFinite(window.fixedLimit) || window.fixedLimit < 0)) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid fixed limit`);
    if (window.metricScale != null && (!Number.isFinite(window.metricScale) || window.metricScale <= 0 || window.metricScale > 1_000_000)) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid metric scale`);
  };
  const responseHeaders = quota?.responseHeaders ?? [];
  for (const window of responseHeaders) {
    validateBase(window);
    const fields = ["limitHeaders", "remainingHeaders", "usedHeaders", "resetHeaders"];
    const headers = fields.flatMap((field) => window[field] ?? []);
    if (!headers.length && window.fixedLimit == null) throw new Error(`provider ${providerId} quota window ${window.id} has no response source`);
    if (headers.some((header) => typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid header`);
  }
  const probes = quota?.probes ?? [];
  for (const probe of probes) {
    for (const [name, value] of Object.entries(probe.headers ?? {})) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string") throw new Error(`provider ${providerId} quota probe has an invalid header`);
    for (const window of probe.windows) {
      validateBase(window);
      const pointers = ["limitPointer", "remainingPointer", "usedPointer", "resetPointer"].flatMap((field) => window[field] == null ? [] : [window[field]]);
      if (!pointers.length && window.fixedLimit == null) throw new Error(`provider ${providerId} quota probe window ${window.id} has no data source`);
    }
  }
}
