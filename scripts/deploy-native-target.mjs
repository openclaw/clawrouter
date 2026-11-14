// Qualification is a separate, explicit caller; production never reads a target override.
const issued = new WeakSet();
export const productionNativeTarget = Object.freeze({ worker: 'clawrouter-edge', origin: 'https://clawrouter.openclaw.ai', isolated: false });
export function isolatedNativeTarget({ worker, origin, account }) {
  if (!/^clawrouter-native-qualification-[a-f0-9]{12}$/.test(worker ?? '') || !/^[a-f0-9]{32}$/.test(account ?? ''))
    throw new Error('Invalid isolated native qualification identity');
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || !new RegExp('^' + worker + '[.][a-z0-9-]+[.]workers[.]dev$').test(url.hostname))
    throw new Error('Qualification origin must be the isolated Worker workers.dev origin');
  const target = Object.freeze({ worker, origin, account, isolated: true });
  issued.add(target);
  return target;
}
export function nativeTarget(target, env = {}) {
  if (target !== undefined && target !== productionNativeTarget && !issued.has(target)) throw new Error('Unverified native target');
  const selected = target ?? productionNativeTarget;
  if (env.CLAWROUTER_WORKER_NAME && env.CLAWROUTER_WORKER_NAME !== selected.worker) throw new Error('Production train Worker mismatch or conflicting qualification Worker');
  if (env.CLAWROUTER_BASE_URL && env.CLAWROUTER_BASE_URL !== selected.origin) throw new Error('Native control origin mismatch');
  if (selected.isolated && env.CLOUDFLARE_ACCOUNT_ID !== selected.account) throw new Error('Qualification account mismatch');
  return selected;
}
