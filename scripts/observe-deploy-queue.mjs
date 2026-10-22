import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createApi } from './deploy-train-api.mjs';
import { deploymentState } from './deploy-train-policy.mjs';
import { startQueueObservation } from './deploy-queue-observation.mjs';

export async function observeQueue({ api, save, start = startQueueObservation, now = Date.now, wait = sleep, durationMs = 5 * 60_000 }) {
  const deployment = await api.latest();
  const train = deploymentState(deployment);
  if (!train) throw new Error('No train journal available to observe');
  const state = { blue: train.blue, green: train.green, trainRun: train.run, percentage: deployment.versions.find((v) => v.version_id === train.green)?.percentage ?? 0 };
  const stop = await start({ api, state, save });
  const deadline = now() + durationMs;
  try {
    if (state.queueObservationStatus?.startsWith('connected')) {
      while (now() < deadline) {
        await wait(Math.min(30_000, deadline - now()));
        const latest = await api.latest();
        const current = deploymentState(latest);
        if (!current || current.run !== train.run || current.green !== train.green) { state.observationStopped = 'deployment owner changed'; break; }
        state.percentage = latest.versions.find((v) => v.version_id === train.green)?.percentage ?? 0;
      }
    }
  } finally { await stop(); save(state); }
  return state;
}
export async function main(env = process.env) {
  const state = await observeQueue({ api: createApi({ env }), save: (value) => writeFileSync(env.QUEUE_RECEIPT_PATH, JSON.stringify(value, null, 2)) });
  const summary = `## Queue version observation\n\nRead-only production observation; no upload, deployment or provider request.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\nThese are observed samples, not a platform routing guarantee.\n`;
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(state));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
