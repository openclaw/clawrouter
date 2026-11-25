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

export const GRANT_SELECTION_STRATEGIES = ["priority", "round_robin", "least_used", "most_remaining", "threshold", "weighted_random"] as const;
export interface GrantChoiceCandidate { key: string; weight: number; remainingRatio: number | null }
// Loose request shape: the authority validates untrusted RPC input here.
export interface GrantChoiceInput { strategy: string; stickyHash?: string | null; switchAtUsedPercent?: number; hysteresisPercent?: number; candidates: Array<{ key: string; weight?: number; remainingRatio?: number | null }> }

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

// PRIVATE bridge only. Caller transfers an exclusive array of fresh scalar
// choice records; neither source grants nor snapshot records may be passed.
// Every original key is validated, even when a later collision replaces it.
export function consumeOwnedChoiceCandidates(candidates: GrantChoiceInput["candidates"], key: (value: unknown) => string): GrantChoiceCandidate[] {
  let length = 0;
  for (let read = 0; read < candidates.length; read++) {
    const candidate = candidates[read], normalized = key(candidate.key);
    const weight = typeof candidate.weight === "number" && Number.isFinite(candidate.weight) && candidate.weight > 0 && candidate.weight <= 1_000_000 ? candidate.weight : 1;
    const remainingRatio = typeof candidate.remainingRatio === "number" && Number.isFinite(candidate.remainingRatio) && candidate.remainingRatio >= 0 && candidate.remainingRatio <= 1 ? candidate.remainingRatio : null;
    let target = 0;
    while (target < length && candidates[target].key !== normalized) target++;
    if (target === length) { candidates[length++] = candidate; candidate.key = normalized; }
    // Map semantics: last value, first insertion position. Reuse that first
    // owned record rather than retaining the later collision's record.
    candidates[target].weight = weight; candidates[target].remainingRatio = remainingRatio;
  }
  candidates.length = length;
  // Stable in-place insertion sort: no pair array, Map or engine sort buffer.
  for (let i = 1; i < length; i++) {
    const value = candidates[i]; let at = i;
    while (at > 0 && candidates[at - 1].key.localeCompare(value.key) > 0) { candidates[at] = candidates[at - 1]; at--; }
    candidates[at] = value;
  }
  return candidates as GrantChoiceCandidate[]; // every surviving field assigned above
}

// Pick from normalized candidates without copying or sorting the input. Counts
// stay with the caller: either a local Map or an admitted history object lookup.
export function chooseGrantKey(input: GrantChoiceInput, candidates: GrantChoiceCandidate[],
  cursorKey: string | null, count: (key: string) => { count: number; lastMs: number } | undefined): { selectedKey: string; cursorKey?: string } {
  const strategy = (GRANT_SELECTION_STRATEGIES as readonly string[]).includes(input.strategy) ? input.strategy : "most_remaining";
  const stickyHash = typeof input.stickyHash === "string" && /^[0-9a-f]{64}$/.test(input.stickyHash) ? input.stickyHash : null;
  let selected = candidates[0];
  if (stickyHash) {
    for (let i = 1; i < candidates.length; i++) {
      const next = candidates[i];
      if ((stickyScore(stickyHash, next) - stickyScore(stickyHash, selected) || next.key.localeCompare(selected.key)) < 0) selected = next;
    }
  } else if (strategy === "round_robin") {
    for (const next of candidates) if (next.key > (cursorKey ?? "")) { selected = next; break; }
    return { selectedKey: selected.key, cursorKey: selected.key };
  } else if (strategy === "least_used") {
    for (let i = 1; i < candidates.length; i++) {
      const next = candidates[i], a = count(next.key), b = count(selected.key);
      if (((a?.count ?? 0) - (b?.count ?? 0) || (a?.lastMs ?? 0) - (b?.lastMs ?? 0) || next.key.localeCompare(selected.key)) < 0) selected = next;
    }
  } else if (strategy === "most_remaining" || strategy === "threshold") {
    for (let i = 1; i < candidates.length; i++) {
      const next = candidates[i];
      if (((selected.remainingRatio ?? -1) - (next.remainingRatio ?? -1) || next.key.localeCompare(selected.key)) < 0) selected = next;
    }
    if (strategy === "threshold") {
      const current = candidates.find(candidate => candidate.key === cursorKey);
      if (current) {
        selected = current;
        const cutoff = 1 - boundedPercent(input.switchAtUsedPercent, 90) / 100;
        if (current.remainingRatio !== null && current.remainingRatio <= cutoff + 1e-9) {
          const hysteresis = boundedPercent(input.hysteresisPercent, 10) / 100;
          let replacement: GrantChoiceCandidate | undefined, unmeasured: GrantChoiceCandidate | undefined;
          for (const next of candidates) {
            if (next.key === current.key) continue;
            if (next.remainingRatio === null) { if (!unmeasured || next.key.localeCompare(unmeasured.key) < 0) unmeasured = next; }
            else if (next.remainingRatio > cutoff + 1e-9 && next.remainingRatio + 1e-9 >= current.remainingRatio + hysteresis
              && (!replacement || (replacement.remainingRatio! - next.remainingRatio || next.key.localeCompare(replacement.key)) < 0)) replacement = next;
          }
          selected = replacement ?? unmeasured ?? current;
        }
      }
      return { selectedKey: selected.key, cursorKey: selected.key };
    }
  } else if (strategy === "weighted_random") selected = weightedRandom(candidates);
  return { selectedKey: selected.key };
}
