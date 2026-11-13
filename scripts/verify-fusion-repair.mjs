import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, validateTask, validateEdits, checkOracleVisible, verify } from './fusion-workloads.mjs';
import { validateLocalQualification } from './fusion-local-repository.mjs';
import { writeRepairPatch } from './fusion-repair-patch.mjs';

async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid_repair_input');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('invalid_repair_input');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await file.close(); }
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameReceipt = (left, right) => right && ['taskId', 'taskDigest', 'image', 'oracleTests', 'oracleSkipped']
  .every(key => left[key] === right[key]);
const matches = (result, receipt) => result?.valid === true && result.passed === true
  && result.tests === receipt.oracleTests && result.skipped === receipt.oracleSkipped;

export function validateRepairInputs({ manifest, qualificationRaw, report, repairRaw }) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error('invalid_repair_input');
  const tasks = manifest.tasks.map(validateTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('invalid_repair_input');
  const receipts = validateLocalQualification(tasks, JSON.parse(qualificationRaw));
  if (typeof repairRaw !== 'string' || Buffer.byteLength(repairRaw) > 4 * 1024 * 1024) throw new Error('invalid_repair_input');
  const repair = JSON.parse(repairRaw);
  const task = tasks.find(task => task.id === repair?.taskId), receipt = receipts.find(row => row.taskId === task?.id);
  if (!task || !receipt || receipt.oracleSkipped >= receipt.oracleTests
    || report?.version !== 1 || report.kind !== 'native-policy-repository' || report.complete !== true || report.failure
    || report.policy !== 'edit-handoff' || report.includeControls !== false || report.controlsOnly !== false || report.exportRepairs !== true
    || !/^[a-f0-9]{40}$/.test(report.sourceSha ?? '') || report.datasetDigest !== hash(JSON.stringify(tasks))
    || report.qualificationDigest !== hash(qualificationRaw)
    || !Array.isArray(report.records) || !Array.isArray(report.receipts)) throw new Error('invalid_repair_input');
  const rows = report.records.filter(row => row.taskId === task.id), recorded = report.receipts.filter(row => row.taskId === task.id);
  const row = rows[0];
  if (rows.length !== 1 || recorded.length !== 1 || !sameReceipt(receipt, recorded[0])
    || row.strategy !== 'edit-handoff' || row.status !== 'complete' || row.score !== 1 || row.publicPassed !== true
    || row.repairExportFailed || !matches(row.verdict, receipt)
    || row.repairExport?.file !== `${task.id}.repair.json` || row.repairExport.bytes !== Buffer.byteLength(repairRaw)
    || !digest(row.repairExport.sha256) || row.repairExport.sha256 !== hash(repairRaw)) throw new Error('invalid_repair_input');
  if (repair.version !== 1 || repair.kind !== 'accepted-repository-repair' || repair.base !== task.base
    || repair.sourceSha !== report.sourceSha || repair.taskDigest !== receipt.taskDigest
    || repair.qualificationDigest !== report.qualificationDigest || !digest(repair.filesDigest)
    || !Array.isArray(repair.files) || !repair.files.length || repair.files.length > 32
    || repair.files.some(file => !file || Object.keys(file).sort().join(',') !== 'content,path')) throw new Error('invalid_repair_input');
  const files = validateEdits(task, repair.files);
  if (repair.filesDigest !== hash(JSON.stringify(files))) throw new Error('invalid_repair_input');
  return { task, receipt, files, repairDigest: hash(repairRaw), sourceSha: report.sourceSha };
}

export async function verifyRepair({ repo, qualificationPath, taskManifest, reportPath, repairPath,
  visible = checkOracleVisible, acceptance = verify, patchPath, patchWriter = writeRepairPatch }) {
  const [qualificationRaw, manifestRaw, reportRaw, repairRaw] = await Promise.all([
    readBounded(qualificationPath, 16 * 1024 * 1024), readBounded(taskManifest, 4 * 1024 * 1024),
    readBounded(reportPath, 16 * 1024 * 1024), readBounded(repairPath, 4 * 1024 * 1024),
  ]);
  const { task, receipt, files, repairDigest, sourceSha } = validateRepairInputs({
    manifest: JSON.parse(manifestRaw), qualificationRaw, report: JSON.parse(reportRaw), repairRaw,
  });
  const publicResult = await visible(task, receipt.image, files);
  const publicPassed = publicResult?.valid === true && publicResult.passed === true;
  const finalResult = publicPassed ? await acceptance(task, receipt.image, files, repo) : null;
  const result = { version: 1, kind: 'reverified-repository-repair', taskId: task.id, base: task.base,
    sourceSha, repairDigest, fileCount: files.length, passed: publicPassed && matches(finalResult, receipt),
    visible: { valid: publicResult?.valid === true, passed: publicPassed },
    acceptance: finalResult ? { valid: finalResult.valid === true, passed: matches(finalResult, receipt),
      tests: finalResult.tests, skipped: finalResult.skipped } : null,
    limitations: ['Checks supplied provenance for consistency, not authenticity or cost accounting.',
      'Acceptance applies to the pinned task base, not an arbitrary current checkout. No files are applied.'] };
  if (patchPath !== undefined && result.passed) {
    try { result.patchExport = await patchWriter({ repo, task, files, patchPath }); }
    catch { result.patchExportFailed = true; }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 4 && !(args.length === 6 && args[4] === '--patch' && args[5])) throw new Error('invalid_arguments');
    const [qualificationPath, taskManifest, reportPath, repairPath] = args;
    const result = await verifyRepair({ repo: process.cwd(), qualificationPath, taskManifest, reportPath, repairPath, patchPath: args[5] });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed || result.patchExportFailed) process.exitCode = 1;
  } catch {
    console.error('Repair verification failed; check the four input files, pinned history and local sandbox image.');
    process.exitCode = 1;
  }
}
