import { hash, sandbox, readSource, writeFiles, check, probe } from './fusion-workloads.mjs';
import { replaceEdits, toolErrorCode } from './fusion-agent-benchmark.mjs';
import { requireCompleteResponse } from './fusion-native-provider.mjs';
import { models } from './fusion-benchmark-accounting.mjs';

const schema = { type: 'object', additionalProperties: false,
  required: ['action', 'path', 'line', 'search', 'replace', 'query'], properties: {
    action: { type: 'string', enum: ['inspect', 'edit', 'probe', 'finish'] },
    path: { type: 'string' }, line: { type: 'integer', minimum: 0 },
    search: { type: 'string' }, replace: { type: 'string' }, query: { type: 'string' },
  } };
const ignoredWords = new Set('with that this from when have every only into same does should must preserve existing request response model native current other field value'.split(' '));

// Selection uses the issue and current source only, never acceptance tests or
// the known repair. Raw source stays available through bounded inspect actions.
export function sourceWindows(files, instruction, selection = null, maxBytes = 12000) {
  const terms = [...new Set(instruction.toLowerCase().match(/[a-z][a-z0-9_.]{3,}/g) ?? [])]
    .filter(word => !ignoredWords.has(word));
  let remaining = maxBytes;
  return files.map(file => {
    const lines = file.content.split('\n');
    const scores = lines.map(line => terms.reduce((sum, term) => sum + Number(line.toLowerCase().includes(term)), 0));
    let center = scores.reduce((best, score, index) => score > scores[best] ? index : best, 0);
    if (selection?.path === file.path) {
      if (selection.query) {
        const match = lines.findIndex(line => line.includes(selection.query));
        if (match >= 0) center = match;
      } else if (selection.line > 0) center = Math.min(selection.line - 1, lines.length - 1);
    }
    const selected = selection?.path === file.path;
    const start = !selected && Buffer.byteLength(file.content) <= remaining ? 0 : Math.max(0, center - 35);
    let end = start, bytes = 0;
    while (end < lines.length && bytes + Buffer.byteLength(lines[end]) + 1 <= remaining && end - start < 160) {
      bytes += Buffer.byteLength(lines[end]) + 1; end++;
    }
    remaining -= bytes;
    return { path: file.path, totalLines: lines.length, startLine: start + 1,
      endLine: end, content: lines.slice(start, end).join('\n') };
  });
}

export function groundedEdits(task, files, views, action) {
  if (typeof action.search !== 'string' || !action.search || typeof action.replace !== 'string'
    || Buffer.byteLength(action.replace) > 8000
    || !views.some(view => view.path === action.path && view.content.includes(action.search))) throw new Error('unseen_edit');
  return replaceEdits(task, files, [{ path: action.path, search: action.search, replace: action.replace }]);
}

const instructions = `Repair the reported repository bug. Current source excerpts are supplied on every turn. Make the smallest correct change; preserve unrelated behavior.
Return one JSON action. edit: copy an EXACT short unique substring from the supplied source into search, and its corrected text into replace; path must be an editable file. Do not invent anchors or rewrite entire functions unnecessarily.
inspect: choose a listed path and either a line number or literal query to see another source window. probe: query contains a Node ES module that imports the source and asserts the reported behavior; it executes in an isolated repository. finish: submit the current repair.
Set unused strings to empty and unused line to 0. The source is already read for you. Do not emit notes, explanations or copies of the full file.
Visible tests pass even on the broken baseline: their success does not prove the issue fixed. Use an executable probe of the reported invariant where possible. Final acceptance tests are unavailable.`;

export async function runGroundedAgent(task, image, strategy, trialId, config, invoke, _engine,
  { makeSandbox = sandbox, read = readSource, write = writeFiles, test = check, runProbe = probe } = {}) {
  if (!['strong', 'handoff'].includes(strategy)) throw new Error('invalid_grounded_strategy');
  const box = await makeSandbox(image), started = performance.now();
  const deadline = AbortSignal.timeout(config.deadlineMs), remaining = () => Math.max(1, config.deadlineMs - Math.ceil(performance.now() - started));
  let selection = null, feedback = 'No edits yet. Inspect the source and repair the reported behavior.', handoffUsed = false;
  let outcome = 'turn_limit', publicPassed = false, invalidActions = 0, turns = 0;
  const actions = [];
  try {
    // Visible test imports are useful API examples, not hidden grading evidence.
    const examples = await read(box, task.visibleTests, remaining());
    const testExamples = sourceWindows(examples, task.instruction, null, 4000);
    for (; turns < config.maxTurns; turns++) {
      if (deadline.aborted) { outcome = 'deadline'; break; }
      if (strategy === 'handoff' && !handoffUsed && turns >= Math.max(1, Math.floor(config.maxTurns * 2 / 3))) {
        handoffUsed = true; actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
        feedback = `Independently verify the attempted repair. Previous tool result: ${feedback}`;
      }
      const files = await read(box, task.editPaths, remaining());
      const extra = selection && !task.editPaths.includes(selection.path)
        ? await read(box, [selection.path], remaining()) : [];
      const readable = [...files, ...extra];
      if (selection) readable.sort((a, b) => Number(b.path === selection.path) - Number(a.path === selection.path));
      const views = sourceWindows(readable, task.instruction, selection);
      const messages = [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({
        issue: task.instruction, editable: task.editPaths, visibleTests: task.visibleTests,
        currentSource: views, testExamples, recentActions: actions.slice(-4), lastToolResult: feedback.slice(-4000),
      }) }];
      const response = await invoke(trialId, handoffUsed ? models.critic : models.strong,
        { messages, max_tokens: config.outputTokens, response_format: { type: 'json_schema',
          json_schema: { name: 'grounded_repair', strict: true, schema } } }, deadline);
      requireCompleteResponse(response);
      let action;
      try { action = JSON.parse(response.choices[0].message.content); }
      catch { actions.push({ turn: turns + 1, action: 'invalid_json', status: 'rejected' }); invalidActions++; feedback = 'Invalid JSON. Return one action object.'; continue; }
      const event = { turn: turns + 1, action: ['inspect', 'edit', 'probe', 'finish'].includes(action?.action) ? action.action : 'invalid', status: 'ok' };
      actions.push(event);
      try {
        if (action.action === 'inspect') {
          if (![...task.editPaths, ...task.visibleTests].includes(action.path) || !Number.isSafeInteger(action.line)
            || action.line < 0 || typeof action.query !== 'string' || action.query.length > 200) throw new Error('invalid_read_paths');
          selection = { path: action.path, line: action.line, query: action.query };
          feedback = 'Requested source window is shown next. Copy exact source for an edit.';
        } else if (action.action === 'edit') {
          await write(box, groundedEdits(task, files, views, action), remaining());
          const result = await test(box, task.visibleTests, remaining()); publicPassed = result.passed;
          feedback = `Edit applied. Visible tests passed: ${publicPassed}. ${result.feedback.slice(-3500)}`;
          // Keep the edited location visible, including after a handoff.
          selection = { path: action.path, line: files.find(file => file.path === action.path).content.slice(0,
            files.find(file => file.path === action.path).content.indexOf(action.search)).split('\n').length, query: '' };
        } else if (action.action === 'probe') {
          const result = await runProbe(box, action.query, remaining());
          feedback = `Behavior probe passed: ${result.passed}. ${result.feedback.slice(-3500)}`;
          event.passed = result.passed;
        } else if (action.action === 'finish') {
          const result = await test(box, task.visibleTests, remaining()); publicPassed = result.passed;
          if (strategy === 'handoff' && !handoffUsed) {
            handoffUsed = true; actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
            feedback = 'The first worker submitted. Independently inspect current source and verify the bug is fixed.';
          } else { outcome = 'submitted'; turns++; break; }
        } else throw new Error('invalid_action');
      } catch (error) {
        if (deadline.aborted) { outcome = 'deadline'; break; }
        event.status = error.message === 'unseen_edit' ? 'unseen_edit' : toolErrorCode(error);
        // Infrastructure failures stop the campaign; model tool mistakes can recover.
        if (['command_failed', 'command_timeout', 'command_output_limit', 'execution_failed'].includes(event.status)) throw error;
        invalidActions++; feedback = `Action rejected: ${event.status}. Use the actual source excerpt; inspect another location if needed.`;
      }
    }
    const files = await read(box, task.editPaths, remaining());
    return { files, patchDigest: hash(JSON.stringify(files)), actions, turns, outcome, handoffUsed, invalidActions, publicPassed };
  } finally { await box.close(); }
}
