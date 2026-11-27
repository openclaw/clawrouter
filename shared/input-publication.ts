export interface InputPublicationPolicy {
  version: "clawrouter.input-publication.v1";
  allow: Array<{
    providerId: "openrouter";
    endpointId: "music_generate";
    modelId: "openrouter/google/lyria-3-pro-preview" | "openrouter/google/lyria-3-clip-preview";
    publish: boolean;
    forward: boolean;
    expiresAt: string;
  }>;
}

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

// This policy permission is independent of retention, credentials and input ownership.
export function normalizeInputPublicationPolicy(value: unknown, now = Date.now()): InputPublicationPolicy | null {
  if (value == null) return null;
  if (!Number.isFinite(now) || !keys(value, ["version", "allow"])
    || value.version !== "clawrouter.input-publication.v1" || !Array.isArray(value.allow) || value.allow.length > 2) invalid();
  const allow: InputPublicationPolicy["allow"] = [], seen = new Set<string>();
  for (const entry of value.allow) {
    if (!keys(entry, ["providerId", "endpointId", "modelId", "publish", "forward", "expiresAt"])
      || entry.providerId !== "openrouter" || entry.endpointId !== "music_generate"
      || (entry.modelId !== "openrouter/google/lyria-3-pro-preview" && entry.modelId !== "openrouter/google/lyria-3-clip-preview")
      || typeof entry.publish !== "boolean" || typeof entry.forward !== "boolean" || typeof entry.expiresAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.expiresAt)) invalid();
    const expires = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expires) || expires <= now
      || new Date(expires).toISOString().replace(".000Z", "Z") !== entry.expiresAt.replace(".000Z", "Z")
      || seen.has(entry.modelId)) invalid();
    seen.add(entry.modelId);
    allow.push({ providerId: entry.providerId, endpointId: entry.endpointId, modelId: entry.modelId,
      publish: entry.publish, forward: entry.forward, expiresAt: new Date(expires).toISOString() });
  }
  allow.sort((a, b) => a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
  return { version: "clawrouter.input-publication.v1", allow };
}

export function readInputPublicationPolicy(value: unknown, now = Date.now()): InputPublicationPolicy | null {
  try { return normalizeInputPublicationPolicy(value, now); } catch { return null; }
}

// Combined music flow needs both permissions; this does not authorize a receipt or dispatch.
export function allowsInputPublicationAndForwarding(
  value: unknown, providerId: string, endpointId: string, modelId: string, now = Date.now(),
): boolean {
  return readInputPublicationPolicy(value, now)?.allow.some(entry => entry.providerId === providerId
    && entry.endpointId === endpointId && entry.modelId === modelId && entry.publish && entry.forward) ?? false;
}

function invalid(): never {
  throw new Error("inputPublication requires an unexpired, closed versioned OpenRouter music permission list");
}
