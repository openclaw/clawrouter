export function stickyScore(hash: string, candidate: { key: string; weight: number }): number {
  let value = 2166136261;
  for (const character of `${hash}:${candidate.key}`) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  const unit = (value + 1) / 0x1_0000_0000;
  return -Math.log(unit) / candidate.weight;
}

export function weightedRandom<T extends { weight: number }>(candidates: T[]): T {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000 * total;
  let cursor = 0;
  for (const candidate of candidates) { cursor += candidate.weight; if (random < cursor) return candidate; }
  return candidates.at(-1)!;
}

export function boundedPercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

export function selectThresholdGrantKey(
  candidates: Array<{ key: string; remainingRatio: number | null }>,
  currentKey: string | null,
  switchAtUsedPercent = 90,
  hysteresisPercent = 10,
): string {
  if (!candidates.length) throw new Error("threshold selection requires at least one candidate");
  const healthiest = [...candidates].sort((a, b) => (b.remainingRatio ?? -1) - (a.remainingRatio ?? -1) || a.key.localeCompare(b.key))[0];
  const current = candidates.find((candidate) => candidate.key === currentKey);
  if (!current || current.remainingRatio === null) return current?.key ?? healthiest.key;
  const cutoffRemaining = 1 - boundedPercent(switchAtUsedPercent, 90) / 100;
  if (current.remainingRatio > cutoffRemaining + 1e-9) return current.key;
  const hysteresis = boundedPercent(hysteresisPercent, 10) / 100;
  return [...candidates]
    .filter((candidate) => candidate.key !== current.key && candidate.remainingRatio !== null && candidate.remainingRatio > cutoffRemaining + 1e-9 && candidate.remainingRatio + 1e-9 >= current.remainingRatio! + hysteresis)
    .sort((a, b) => b.remainingRatio! - a.remainingRatio! || a.key.localeCompare(b.key))[0]?.key ?? current.key;
}
