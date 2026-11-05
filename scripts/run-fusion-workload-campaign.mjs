import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTasks } from './fusion-workloads.mjs';
import { runExperiment, validateExperiment } from './fusion-agent-benchmark.mjs';

export const workloadSets = [
  { name: 'original', manifest: 'workloads' },
  { name: 'transfer', manifest: 'validation-workloads' },
];

export async function runWorkloadCampaign({ repo, qualificationDir, out, config, env = process.env, execute = runExperiment }) {
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('exact_source_required');
  const sets = await Promise.all(workloadSets.map(async set => ({ ...set,
    taskManifest: resolve(repo, `benchmarks/fusion/${set.manifest}.json`),
    count: (await loadTasks(resolve(repo, `benchmarks/fusion/${set.manifest}.json`))).length,
  })));
  // Preflight the entire campaign before the first paid request, not each set alone.
  const budgetBound = validateExperiment(config, sets.reduce((sum, set) => sum + set.count, 0));
  await mkdir(out, { recursive: false, mode: 0o700 });
  const state = { sourceSha: env.GITHUB_SHA, config, budgetBound, complete: false,
    spentOrReservedMicros: config.priorCostMicros, sets: [] };
  const checkpoint = async () => {
    await writeFile(resolve(out, 'campaign.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(resolve(out, 'campaign.json.tmp'), resolve(out, 'campaign.json'));
  };
  await checkpoint();
  for (const set of sets) {
    const setOut = resolve(out, set.name), prior = state.spentOrReservedMicros;
    const setBound = prior + set.count * config.trials * config.strategies.length * config.trialBudgetMicros;
    let failure = false, provenance;
    try {
      await execute({ repo, qualificationPath: resolve(qualificationDir, `${set.manifest}-qualification.json`),
        out: setOut, taskManifest: set.taskManifest, config: { ...config, priorCostMicros: prior }, env });
    } catch { failure = true; }
    try {
      provenance = JSON.parse(await readFile(resolve(setOut, 'provenance.json'), 'utf8'));
      if (!Number.isSafeInteger(provenance.spentOrReservedMicros) || provenance.spentOrReservedMicros < prior || provenance.spentOrReservedMicros > setBound) throw new Error('invalid_ledger');
      state.spentOrReservedMicros = provenance.spentOrReservedMicros;
    } catch {
      // Missing or corrupt evidence cannot establish that no request was billed.
      state.spentOrReservedMicros = setBound;
      state.accountingUnknown = true;
      failure = true;
    }
    state.sets.push({ name: set.name, complete: !failure && provenance?.complete === true });
    await checkpoint();
    if (failure || provenance?.complete !== true) throw new Error('workload_campaign_incomplete');
  }
  state.complete = true; await checkpoint(); return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [qualificationDir, out, configPath] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await runWorkloadCampaign({ repo: process.cwd(), qualificationDir, out, config });
  }).catch(() => { console.error('Workload campaign incomplete; inspect its content-free checkpoint.'); process.exitCode = 1; });
}
