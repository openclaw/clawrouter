import { isDeepStrictEqual } from 'node:util';

const profile = 'retained-diagnostics-v1';
const sourceSettings = { logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false } };

// This is a read-only reconciliation of the separately applied logging profile,
// not permission for the version train to change Worker settings.
export function observabilityReconciliation(previous, candidate) {
  if (isDeepStrictEqual(previous, candidate)) return undefined;
  if (!isDeepStrictEqual(candidate, sourceSettings)) throw new Error('Non-versioned Worker settings changed; use a separately authorized configuration deployment, not the version train');
  return profile;
}

export async function verifyObservability(api, state, now = Date.now()) {
  if (state.observabilityReconciliation === undefined) return;
  if (state.observabilityReconciliation !== profile) throw new Error('Unknown observability reconciliation profile');
  const { observability } = await api.cloudflare(`${api.workerPath}/script-settings`);
  // Cloudflare returns defaulted fields. Accept omitted defaults, but preserve
  // unknown fields in the comparison so other settings cannot slip through.
  const expected = {
    enabled: true, head_sampling_rate: 1, redact_query_string: false,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true },
    traces: { enabled: false, head_sampling_rate: 1, persist: true },
  };
  const actual = observability && {
    head_sampling_rate: 1, redact_query_string: false, ...observability,
    logs: { head_sampling_rate: 1, persist: true, ...observability.logs },
    traces: { enabled: false, head_sampling_rate: 1, persist: true, ...observability.traces },
  };
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Live observability does not match the separately applied retained-diagnostics profile; refusing deployment');
  state.observabilityVerifiedAt = new Date(now).toISOString();
}
