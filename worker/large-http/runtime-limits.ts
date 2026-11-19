// A build target, never a request header or environment toggle. Worker defaults
// retain the isolate-safe limits. Only the exclusive Node runtime defines true.
declare const __CLAWROUTER_LARGE_RUNTIME__: boolean;
const node = typeof __CLAWROUTER_LARGE_RUNTIME__ !== 'undefined' && __CLAWROUTER_LARGE_RUNTIME__ === true;
export const mediaJsonBytes = node ? 64 * 1024 * 1024 : 32_000_000;
export const bodyBudgetBytes = node ? 192 * 1024 * 1024 : 96 * 1024 * 1024;
