import { writeFile } from 'node:fs/promises';
import { loadTasks, qualify } from './fusion-workloads.mjs';

const [nodeImage, output, taskManifest] = process.argv.slice(2);
if (!output) throw new Error('usage: qualify-fusion-workloads.mjs node@sha256:<digest> <receipt.json> [task-manifest.json]');
const tasks = await loadTasks(taskManifest), receipts = [];
for (const task of tasks) {
  const receipt = await qualify(task, { repo: process.cwd(), nodeImage }); receipts.push(receipt);
  await writeFile(output, JSON.stringify({ version: 1, nodeImage, receipts }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ task: task.id, qualified: receipt.qualified, visible: receipt.visible.passed, brokenFailures: receipt.broken.failures, oracle: receipt.oracle.passed }));
  if (!receipt.qualified) { process.exitCode = 1; break; }
}
