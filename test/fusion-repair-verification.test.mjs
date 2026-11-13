import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../scripts/fusion-workloads.mjs';
import { validateRepairInputs, verifyRepair } from '../scripts/verify-fusion-repair.mjs';

function fixture() {
  const task = { id: 'repair-example', split: 'development', base: 'a'.repeat(40), oracle: 'b'.repeat(40),
    editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'],
    hiddenTests: ['worker/test/hidden.test.mjs'], instruction: 'Repair the example.' };
  const manifest = { version: 1, tasks: [task] }, taskDigest = hash(JSON.stringify(task));
  const qualification = { nodeImage: 'node@sha256:' + 'c'.repeat(64), receipts: [{ taskId: task.id,
    taskDigest, image: 'sha256:' + 'd'.repeat(64), qualified: true, visible: { passed: true },
    oracleVisible: { valid: true, passed: true }, broken: { valid: true, passed: false },
    oracle: { valid: true, passed: true, tests: 2, skipped: 0 } }] };
  const qualificationRaw = JSON.stringify(qualification), qualificationDigest = hash(qualificationRaw);
  const files = [{ path: 'worker/example.ts', content: 'private source sentinel' }];
  const repair = { version: 1, kind: 'accepted-repository-repair', taskId: task.id, base: task.base,
    sourceSha: 'e'.repeat(40), taskDigest, qualificationDigest, filesDigest: hash(JSON.stringify(files)), files };
  const report = { version: 1, kind: 'native-policy-repository', complete: true, sourceSha: repair.sourceSha,
    policy: 'edit-handoff', includeControls: false, controlsOnly: false, exportRepairs: true,
    datasetDigest: hash(JSON.stringify(manifest.tasks)), qualificationDigest,
    receipts: [{ taskId: task.id, taskDigest, image: qualification.receipts[0].image, oracleTests: 2, oracleSkipped: 0 }],
    records: [{ taskId: task.id, strategy: 'edit-handoff', status: 'complete', score: 1, publicPassed: true,
      verdict: { valid: true, passed: true, tests: 2, skipped: 0 } }] };
  const data = { manifest, qualificationRaw, report, repair, repairRaw: '' };
  reseal(data);
  return data;
}

function reseal(data) {
  data.repairRaw = JSON.stringify(data.repair) + '\n';
  data.report.records[0].repairExport = { file: 'repair-example.repair.json',
    bytes: Buffer.byteLength(data.repairRaw), sha256: hash(data.repairRaw) };
}

test('repair inputs bind source, task, qualification, receipt and exact file bytes', () => {
  const data = fixture(), result = validateRepairInputs(data);
  assert.deepEqual(result.task, data.manifest.tasks[0]);
  assert.deepEqual(result.files, data.repair.files);
  assert.equal(result.repairDigest, hash(data.repairRaw));
  assert.equal(result.sourceSha, data.report.sourceSha);
});

const invalidInputs = {
  'unfinished run': d => { d.report.complete = false; },
  'failed run': d => { d.report.failure = 'unknown_cost'; },
  'paired run': d => { d.report.kind = 'native-pair-repository'; },
  'different policy': d => { d.report.policy = 'architect'; },
  'controls enabled': d => { d.report.includeControls = true; },
  'export disabled': d => { d.report.exportRepairs = false; },
  'failed repair': d => { d.report.records[0].score = 0; },
  'failed visible checks': d => { d.report.records[0].publicPassed = false; },
  'invalid acceptance': d => { d.report.records[0].verdict.valid = false; },
  'missing acceptance tests': d => { d.report.records[0].verdict.tests = 1; },
  'extra skipped tests': d => { d.report.records[0].verdict.skipped = 1; },
  'failed export': d => { d.report.records[0].repairExportFailed = true; },
  'duplicate record': d => { d.report.records.push(structuredClone(d.report.records[0])); },
  'duplicate receipt': d => { d.report.receipts.push(structuredClone(d.report.receipts[0])); },
  'changed task': d => { d.manifest.tasks[0].instruction = 'A different task'; },
  'changed qualification bytes': d => { d.qualificationRaw += ' '; },
  'changed image': d => { d.report.receipts[0].image = 'sha256:' + 'f'.repeat(64); },
  'changed bundle bytes': d => { d.repairRaw += ' '; },
  'wrong byte count': d => { d.report.records[0].repairExport.bytes++; },
  'different base': d => { d.repair.base = 'f'.repeat(40); reseal(d); },
  'different executor': d => { d.repair.sourceSha = 'f'.repeat(40); reseal(d); },
  'different bundle task': d => { d.repair.taskId = 'other-task'; reseal(d); },
  'changed file digest': d => { d.repair.filesDigest = 'f'.repeat(64); reseal(d); },
  'hidden test edit': d => { d.repair.files[0].path = 'worker/test/hidden.test.mjs'; reseal(d); },
  'path traversal': d => { d.repair.files[0].path = '../escape.ts'; reseal(d); },
  'extra file fields': d => { d.repair.files[0].extra = 'ignore me'; reseal(d); },
  'empty files': d => { d.repair.files = []; reseal(d); },
  'oversized file': d => { d.repair.files[0].content = 'x'.repeat(256 * 1024 + 1); reseal(d); },
};
for (const [name, mutate] of Object.entries(invalidInputs)) test(`repair verification rejects ${name}`, () => {
  const data = fixture(); mutate(data);
  assert.throws(() => validateRepairInputs(data));
});

async function withInputs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-repair-verify-')), data = fixture();
  const paths = { repo: root, qualificationPath: join(root, 'qualification.json'), taskManifest: join(root, 'tasks.json'),
    reportPath: join(root, 'pair.json'), repairPath: join(root, 'repair.json') };
  try {
    await Promise.all([
      writeFile(paths.qualificationPath, data.qualificationRaw), writeFile(paths.taskManifest, JSON.stringify(data.manifest)),
      writeFile(paths.reportPath, JSON.stringify(data.report)), writeFile(paths.repairPath, data.repairRaw),
    ]);
    await fn(paths, data);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('saved source is checked visibly before independent acceptance, with content-free output', () => withInputs(async (paths, data) => {
  const calls = [];
  const result = await verifyRepair({ ...paths,
    visible: async (task, image, files) => {
      calls.push('visible');
      assert.equal(task.id, 'repair-example'); assert.equal(image, data.report.receipts[0].image);
      assert.deepEqual(files, data.repair.files);
      return { valid: true, passed: true, feedback: 'private visible output' };
    },
    acceptance: async (_task, _image, files, repo) => {
      calls.push('acceptance'); assert.equal(repo, paths.repo); assert.deepEqual(files, data.repair.files);
      return { valid: true, passed: true, tests: 2, skipped: 0, feedback: 'private acceptance output' };
    },
  });
  assert.deepEqual(calls, ['visible', 'acceptance']);
  assert.equal(result.passed, true);
  assert.equal(result.fileCount, 1);
  assert(!JSON.stringify(result).includes('private'));
}));

test('failed visible replay stops before acceptance', () => withInputs(async paths => {
  const result = await verifyRepair({ ...paths, visible: async () => ({ valid: true, passed: false }),
    acceptance: async () => assert.fail('acceptance must not run') });
  assert.equal(result.passed, false); assert.equal(result.acceptance, null);
}));

for (const verdict of [{ valid: true, passed: false, tests: 2, skipped: 0 },
  { valid: false, passed: true, tests: 2, skipped: 0 }, { valid: true, passed: true, tests: 1, skipped: 0 },
  { valid: true, passed: true, tests: 2, skipped: 1 }]) {
  test('replay requires valid acceptance with every qualified test and skip count', () => withInputs(async paths => {
    const result = await verifyRepair({ ...paths, visible: async () => ({ valid: true, passed: true }),
      acceptance: async () => verdict });
    assert.equal(result.passed, false);
  }));
}

test('bad input cannot start either sandbox phase', () => withInputs(async paths => {
  await writeFile(paths.repairPath, 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(verifyRepair({ ...paths, visible: async () => assert.fail('must not run'),
    acceptance: async () => assert.fail('must not run') }), /invalid_repair_input/);
  await rm(paths.repairPath); await mkdir(paths.repairPath);
  await assert.rejects(verifyRepair({ ...paths, visible: async () => assert.fail('must not run') }), /invalid_repair_input/);
}));
