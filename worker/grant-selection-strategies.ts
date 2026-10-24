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

export const GRANT_SELECTION_STRATEGIES = ["priority", "round_robin", "least_used", "most_remaining", "threshold", "weighted_random"] as const;
export interface GrantChoiceCandidate { key: string; weight: number; remainingRatio: number | null }
// Loose request shape: the authority validates untrusted RPC input here.
export interface GrantChoiceInput { strategy: string; stickyHash?: string | null; switchAtUsedPercent?: number; hysteresisPercent?: number; candidates: Array<{ key: string; weight?: number; remainingRatio?: number | null }> }
export interface GrantChoiceState { cursorKey: string | null; counts: ReadonlyMap<string, { count: number; lastMs: number }> }

// Shared by the authority (SQLite-backed state) and the Worker's isolate-local
// snapshot selection, so both paths apply identical strategy semantics.
export function normalizedChoiceCandidates(candidates: GrantChoiceInput["candidates"], key: (value: unknown) => string = value => String(value)): GrantChoiceCandidate[] {
  return [...new Map(candidates.map((candidate) => {
    const normalized = key(candidate.key);
    const weight = typeof candidate.weight === "number" && Number.isFinite(candidate.weight) && candidate.weight > 0 && candidate.weight <= 1_000_000 ? candidate.weight : 1;
    const remainingRatio = typeof candidate.remainingRatio === "number" && Number.isFinite(candidate.remainingRatio) && candidate.remainingRatio >= 0 && candidate.remainingRatio <= 1 ? candidate.remainingRatio : null;
    return [normalized, { key: normalized, weight, remainingRatio }];
  })).values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Pick a key from normalized candidates. `cursorKey` is set when the strategy advances a pool cursor. */
export function chooseGrantKey(input: GrantChoiceInput, candidates: GrantChoiceCandidate[], state: GrantChoiceState): { selectedKey: string; cursorKey?: string } {
  const strategy = (GRANT_SELECTION_STRATEGIES as readonly string[]).includes(input.strategy) ? input.strategy : "most_remaining";
  const stickyHash = typeof input.stickyHash === "string" && /^[0-9a-f]{64}$/.test(input.stickyHash) ? input.stickyHash : null;
  let selected = candidates[0];
  if (stickyHash) selected = [...candidates].sort((a, b) => stickyScore(stickyHash, a) - stickyScore(stickyHash, b) || a.key.localeCompare(b.key))[0];
  else if (strategy === "round_robin") {
    selected = candidates.find((candidate) => candidate.key > (state.cursorKey ?? "")) ?? candidates[0];
    return { selectedKey: selected.key, cursorKey: selected.key };
  } else if (strategy === "least_used") {
    const counts = state.counts;
    selected = [...candidates].sort((a, b) => (counts.get(a.key)?.count ?? 0) - (counts.get(b.key)?.count ?? 0) || (counts.get(a.key)?.lastMs ?? 0) - (counts.get(b.key)?.lastMs ?? 0) || a.key.localeCompare(b.key))[0];
  } else if (strategy === "most_remaining") selected = [...candidates].sort((a, b) => (b.remainingRatio ?? -1) - (a.remainingRatio ?? -1) || a.key.localeCompare(b.key))[0];
  else if (strategy === "threshold") {
    const selectedKey = selectThresholdGrantKey(candidates, state.cursorKey, boundedPercent(input.switchAtUsedPercent, 90), boundedPercent(input.hysteresisPercent, 10));
    selected = candidates.find((candidate) => candidate.key === selectedKey) ?? candidates[0];
    return { selectedKey: selected.key, cursorKey: selected.key };
  }
  else if (strategy === "weighted_random") selected = weightedRandom(candidates);
  return { selectedKey: selected.key };
}
