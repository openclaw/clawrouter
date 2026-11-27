// Project caller-owned current source without changing canonical tool history.
export function workspaceModelView(request, workspace) {
  if (!Array.isArray(request?.history) || !workspace || !Number.isSafeInteger(workspace.revision)
    || workspace.revision < 0 || !Array.isArray(workspace.files) || !Array.isArray(workspace.context)
    || ![...workspace.files, ...workspace.context].every(file => typeof file?.path === 'string'
      && file.path.length > 0 && typeof file.content === 'string')
    || new Set([...workspace.files, ...workspace.context].map(file => file.path)).size
      !== workspace.files.length + workspace.context.length
    || workspace.publicCheck !== null && (typeof workspace.publicCheck?.passed !== 'boolean'
      || typeof workspace.publicCheck?.feedback !== 'string')) {
    throw new Error('invalid_trajectory_workspace');
  }
  const view = structuredClone({ ...request, workspace });
  const supplied = new Set(view.workspace.files.map(file => file.path));
  let omitted = 0, feedbackReferences = 0;
  for (const step of view.history) {
    if (!step || typeof step !== 'object') continue;
    const action = step.action, check = view.workspace.publicCheck;
    if (action?.type === 'tool' && action.name === 'run_tests' && check
      && step.observation?.feedback === check.feedback && step.observation?.passed === check.passed) {
      delete step.observation.feedback;
      step.observation.feedbackRef = 'workspace.publicCheck.feedback';
      feedbackReferences++;
    }
    if (step.observation?.applied !== true || action?.type !== 'tool') continue;
    const paths = action.name === 'edit_source' && typeof action.arguments?.path === 'string'
      ? [action.arguments.path]
      : action.name === 'edit_sources' && Array.isArray(action.arguments?.edits)
        && action.arguments.edits.every(edit => typeof edit?.path === 'string')
        ? action.arguments.edits.map(edit => edit.path) : [];
    if (!paths.length || !paths.every(path => supplied.has(path))) continue;
    step.action = { type: action.type, name: action.name };
    step.appliedPaths = paths;
    step.argumentsOmitted = true;
    omitted++;
  }
  if (omitted || feedbackReferences) view.historyProjection = {
    appliedEditsOmitted: omitted, publicCheckFeedbackReferenced: feedbackReferences,
    explanation: 'Successful edit arguments for supplied workspace files are omitted from this view. Their results are in the current workspace. Failed and unavailable edits remain intact. A feedbackRef resolves to identical text in workspace.publicCheck.feedback.',
  };
  return view;
}
