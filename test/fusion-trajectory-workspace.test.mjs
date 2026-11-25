import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceModelView } from '../scripts/fusion-trajectory-workspace.mjs';
import { runAdaptiveModelTrajectory } from '../scripts/fusion-trajectory-models.mjs';

const edit = (path, applied = true) => ({ action: { type: 'tool', name: 'edit_source',
  arguments: { path, search: 'old', replace: 'new' } }, observation: { applied } });
const workspace = () => ({ revision: 1, files: [{ path: 'example.ts', content: 'new' }],
  context: [{ path: 'baseline/example.ts', content: 'old' }], publicCheck: null });

test('projection owns its data and preserves failed, unavailable and partial batch edits', () => {
  const request = { history: [edit('example.ts'), edit('example.ts', false), edit('missing.ts'),
    { action: { type: 'tool', name: 'edit_sources', arguments: { edits: [
      { path: 'example.ts', search: 'a', replace: 'b' }, { path: 'missing.ts', search: 'a', replace: 'b' },
    ] } }, observation: { applied: true } }] };
  const state = workspace(), before = structuredClone({ request, state });
  const view = workspaceModelView(request, state);
  assert.equal(view.history[0].action.arguments, undefined);
  assert.deepEqual(view.history[0].appliedPaths, ['example.ts']);
  assert.deepEqual(view.history.slice(1), request.history.slice(1));
  view.workspace.files[0].content = 'changed';
  view.workspace.context[0].content = 'changed';
  assert.deepEqual({ request, state }, before);
});

test('only identical named-check feedback is referenced', () => {
  const feedback = 'failed: ' + 'detail '.repeat(2000), state = workspace();
  state.publicCheck = { passed: false, feedback };
  const checked = (name, passed, text) => ({ action: { type: 'tool', name }, observation: { passed, feedback: text } });
  const request = { history: [checked('run_tests', false, feedback), checked('run_tests', true, feedback),
    checked('run_tests', false, 'older failure'), checked('other', false, feedback)] };
  const view = workspaceModelView(request, state);
  assert.equal(view.history[0].observation.feedbackRef, 'workspace.publicCheck.feedback');
  assert.equal(view.history[0].observation.feedback, undefined);
  assert.deepEqual(view.history.slice(1), request.history.slice(1));
  assert.equal(request.history[0].observation.feedback, feedback);
  assert.ok(JSON.stringify(view).length < JSON.stringify({ ...request, workspace: state }).length);
});

test('invalid workspace identity and state fail before projection', () => {
  for (const state of [{ ...workspace(), revision: -1 }, { ...workspace(), files: [{ path: 'x' }] },
    { ...workspace(), context: workspace().files }, { ...workspace(), publicCheck: { passed: 'true', feedback: '' } }]) {
    assert.throws(() => workspaceModelView({ history: [] }, state), /invalid_trajectory_workspace/);
  }
  assert.throws(() => workspaceModelView({}, workspace()), /invalid_trajectory_workspace/);
});

test('model adapter receives current source while final history retains executed arguments', async () => {
  let content = 'old', revision = 0, checked = 0, calls = 0;
  const parameters = { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' },
    replace: { type: 'string' } }, required: ['path', 'search', 'replace'], additionalProperties: false };
  const action = edit('example.ts').action;
  const result = await runAdaptiveModelTrajectory({ task: 'Update source.', runId: 'workspace-test',
    draftModel: 'small', reviewModel: 'large', selectModel: () => 'small', maxModelCalls: 2, maxToolCalls: 3,
    finalCheckTool: 'run_tests',
    nextAction: () => checked < revision ? { type: 'tool', name: 'run_tests', arguments: {} } : null,
    tools: [{ name: 'edit_source', effect: 'write', parameters, validate: args => args.path === 'example.ts',
      execute: async args => { assert.equal(content, args.search); content = args.replace; revision++; return { applied: true }; } },
    { name: 'run_tests', effect: 'read', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      validate: args => Object.keys(args).length === 0,
      execute: async () => { checked = revision; return { passed: content === 'new', feedback: 'checked' }; } }],
    invoke: async (_id, _model, body) => {
      const state = { ...workspace(), revision, files: [{ path: 'example.ts', content }],
        publicCheck: checked === revision && revision > 0 ? { passed: true, feedback: 'checked' } : null };
      const view = workspaceModelView(JSON.parse(body.messages[1].content), state);
      if (++calls === 2) {
        assert.equal(view.workspace.files[0].content, 'new');
        assert.equal(view.workspace.context[0].content, 'old');
        assert.equal(view.history[0].action.arguments, undefined);
      }
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        action: calls === 1 ? action : { type: 'final', content: 'Done.' },
      }) } }] };
    },
  });
  assert.deepEqual(result.history[0].action, action);
  assert.equal(result.history[0].observation.applied, true);
});
