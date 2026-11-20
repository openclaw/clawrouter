// Operator-supplied upstream permission. Router prompt logging is independent.
export interface UpstreamRetentionPolicy {
  version: "clawrouter.upstream-retention.v1";
  allow: Array<{ providerId: string; protocol: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function normalizeUpstreamRetentionPolicy(value: unknown): UpstreamRetentionPolicy | null {
  if (value == null) return null;
  if (!object(value) || Object.keys(value).some(key => !["version", "allow"].includes(key))
    || value.version !== "clawrouter.upstream-retention.v1" || !Array.isArray(value.allow) || value.allow.length > 64) invalid();
  const allow: UpstreamRetentionPolicy["allow"] = [], seen = new Set<string>();
  for (const entry of value.allow) {
    if (!object(entry) || Object.keys(entry).length !== 2 || typeof entry.providerId !== "string"
      || entry.providerId.trim() !== entry.providerId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.providerId) || typeof entry.protocol !== "string"
      || entry.protocol.trim() !== entry.protocol || !/^[a-z][a-z0-9_.-]{0,63}$/.test(entry.protocol)) invalid();
    const key = `${entry.providerId}/${entry.protocol}`;
    if (seen.has(key)) invalid(); seen.add(key);
    allow.push({ providerId: entry.providerId, protocol: entry.protocol });
  }
  return { version: "clawrouter.upstream-retention.v1", allow };
}
export function readUpstreamRetentionPolicy(value: unknown): UpstreamRetentionPolicy | null {
  try { return normalizeUpstreamRetentionPolicy(value); } catch { return null; }
}
function invalid(): never { throw new Error("upstreamRetention requires a versioned, bounded provider/protocol permission list"); }
