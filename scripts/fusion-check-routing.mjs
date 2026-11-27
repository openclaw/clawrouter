// Caller-owned executable checks guide routing; they never certify completion.
export function createCheckDrivenSelector({ draftModel, repairModel, checkTool, repairSteps = 4 } = {}) {
  if (![draftModel, repairModel].every(value => typeof value === 'string' && value.trim())
    || typeof checkTool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(checkTool)
    || !Number.isSafeInteger(repairSteps) || repairSteps < 1 || repairSteps > 8) {
    throw new Error('invalid_check_routing');
  }
  return request => {
    if (!Array.isArray(request?.history)) throw new Error('invalid_check_history');
    let failures = 0, lastFailure = -1;
    for (const [index, step] of request.history.entries()) {
      if (step?.action?.type !== 'tool' || step.action.name !== checkTool) continue;
      if (step.observation?.passed === true) { failures = 0; lastFailure = -1; }
      else if (step.observation?.passed === false) { failures++; lastFailure = index; }
    }
    const horizon = Math.min(8, repairSteps + 2 * (failures - 1));
    return failures > 0 && request.history.length - lastFailure - 1 < horizon ? repairModel : draftModel;
  };
}
