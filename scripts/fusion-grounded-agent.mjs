import { posix } from 'node:path';
import { hash, sandbox, readSource, readTaskContext, writeFiles, check, probe, validateEdits } from './fusion-workloads.mjs';
import { toolErrorCode } from './fusion-agent-benchmark.mjs';
import { requireCompleteResponse } from './fusion-native-provider.mjs';
import { models } from './fusion-benchmark-accounting.mjs';

const schema = { type: 'object', additionalProperties: false,
  required: ['action', 'path', 'line', 'endLine', 'replace', 'query', 'memory'], properties: {
    memory: { type: 'string', minLength: 1, maxLength: 2000 },
    action: { type: 'string', enum: ['inspect', 'edit', 'probe', 'finish'] },
    path: { type: 'string' }, line: { type: 'integer', minimum: 0 }, endLine: { type: 'integer', minimum: 0 },
    replace: { type: 'string' }, query: { type: 'string' },
  } };
const ignoredWords = new Set('with that this from when have every only into same does should must preserve existing request response model native current other field value'.split(' '));

// Selection uses the issue and current source only, never acceptance tests or
// the known repair. Raw source stays available through bounded inspect actions.
export function sourceWindows(files, instruction, selection = null, maxBytes = 12000) {
  const terms = [...new Set(instruction.toLowerCase().match(/[a-z][a-z0-9_.]{3,}/g) ?? [])]
    .filter(word => !ignoredWords.has(word));
  let remaining = maxBytes;
  return files.map((file, fileIndex) => {
    const allowance = Math.floor(remaining / (files.length - fileIndex));
    const lines = file.content.split('\n');
    const scores = lines.map(line => terms.reduce((sum, term) => sum + Number(line.toLowerCase().includes(term)), 0));
    let center = scores.reduce((best, score, index) => score > scores[best] ? index : best, 0);
    let queryMatched;
    if (selection?.path === file.path) {
      if (selection.query) {
        const match = lines.findIndex(line => line.includes(selection.query));
        queryMatched = match >= 0;
        if (!queryMatched) return { path: file.path, totalLines: lines.length,
          startLine: 0, endLine: 0, content: '', queryMatched: false };
        center = match;
      } else if (selection.line > 0) center = Math.min(selection.line - 1, lines.length - 1);
    }
    const selected = selection?.path === file.path;
    const start = !selected && Buffer.byteLength(file.content) <= allowance ? 0 : Math.max(0, center - 35);
    let end = start, bytes = 0;
    while (end < lines.length && bytes + Buffer.byteLength(lines[end]) + 1 <= allowance && end - start < 160) {
      bytes += Buffer.byteLength(lines[end]) + 1; end++;
    }
    remaining -= bytes;
    return { path: file.path, totalLines: lines.length, startLine: start + 1,
      endLine: end, content: lines.slice(start, end).join('\n'),
      ...(queryMatched === undefined ? {} : { queryMatched }) };
  });
}

// Only declared relative source imports expand read access; tests and paths
// outside the source roots remain unavailable to the repair worker.
export function sourceDependencies(files, task) {
  const paths = new Set();
  for (const file of files) for (const match of file.content.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    const path = posix.normalize(posix.join(posix.dirname(file.path), match[1]));
    if (!/^(worker|shared)\/[A-Za-z0-9_./-]+\.(ts|mjs|js)$/.test(path)
      || path.split('/').some(part => part === '..' || part === 'test' || part === 'tests')
      || /\.test\./.test(path) || task.hiddenTests?.includes(path)) continue;
    paths.add(path);
    if (paths.size >= 32) return [...paths];
  }
  return [...paths];
}

export function groundedEdits(task, files, views, action) {
  if (!Number.isSafeInteger(action.line) || !Number.isSafeInteger(action.endLine) || action.line < 1
    || action.endLine < action.line || typeof action.replace !== 'string' || Buffer.byteLength(action.replace) > 8000
    || !views.some(view => view.path === action.path && action.line >= view.startLine && action.endLine <= view.endLine)) throw new Error('unseen_edit');
  const file = files.find(file => file.path === action.path);
  if (!file || !task.editPaths.includes(action.path)) throw new Error('unseen_edit');
  const lines = file.content.split('\n');
  const view = views.find(view => view.path === action.path && action.line >= view.startLine && action.endLine <= view.endLine);
  const search = lines.slice(action.line - 1, action.endLine).join('\n');
  const observed = view.content.split('\n').slice(action.line - view.startLine, action.endLine - view.startLine + 1).join('\n');
  if (observed !== search) throw new Error('unseen_edit');
  if (search === action.replace) throw new Error('unchanged_edit');
  const content = [...lines.slice(0, action.line - 1), action.replace, ...lines.slice(action.endLine)].join('\n');
  return validateEdits(task, files.map(row => row.path === action.path ? { path: row.path, content } : row));
}

const instructions = `Repair the reported repository bug. Current source excerpts are supplied on every turn. Make the smallest correct change; preserve unrelated behavior.
Return one JSON action. edit: choose the inclusive line and endLine from the numbered source, and put ONLY their corrected replacement text into replace; path must be an editable file. Replace as few lines as possible. Do not include line-number prefixes in replacement text or rewrite entire functions unnecessarily.
inspect: choose a listed readable path and either a line number or literal query to see another source window. queryMatched false means the literal query was absent: try a shorter literal or a line number. Declared source dependencies are read-only; edits still require an editable path. probe: query contains a Node ES module that imports the source and asserts the reported behavior; it executes in an isolated repository. finish: submit the current repair.
memory: every action must preserve a nonempty, concise working summary of facts learned, files inspected, and the next step (at most 2000 characters). Use workingMemory to continue rather than rediscovering earlier work. Working notes can be wrong; verify against source. Never copy full source into memory. Set other unused strings to empty and unused line/endLine to 0; memory must not be empty. The source is already read for you. Do not emit notes, explanations or copies of the full file.
Visible tests pass even on the broken baseline: their success does not prove the issue fixed. Use an executable probe of the reported invariant where possible. Final acceptance tests are unavailable.`;

export async function runGroundedAgent(task, image, strategy, trialId, config, invoke, _engine,
  { makeSandbox = sandbox, read = readSource, write = writeFiles, test = check, runProbe = probe } = {}) {
  if (!['strong', 'handoff', 'review'].includes(strategy)) throw new Error('invalid_grounded_strategy');
  if (strategy === 'review' && config.requireReproducer !== true) throw new Error('review_requires_reproducer');
  const box = await makeSandbox(image), started = performance.now();
  const deadline = AbortSignal.timeout(config.deadlineMs), remaining = () => Math.max(1, config.deadlineMs - Math.ceil(performance.now() - started));
  let workingMemory = '';
  let selection = null, feedback = 'No edits yet. Inspect the source and repair the reported behavior.', handoffUsed = false;
  let outcome = 'turn_limit', publicPassed = false, invalidActions = 0, turns = 0;
  const actions = [];
  const checked = config.requireReproducer === true;
  let reviewing = false, reviewed = false;
  let reproducer = null, probePassed = false;
  const dependencies = new Set();
  const probeModules = task.editPaths.map((path, index) => ({ binding: `source${index}`, path: `./${path}` }));
  // Global bindings avoid duplicate lexical declarations if a worker still
  // supplies its own imports despite the body-only instruction.
  const probePrelude = ['globalThis.assert = (await import("node:assert/strict")).default;',
    ...probeModules.map(({ binding, path }) => `globalThis.${binding} = await import(${JSON.stringify(path)});`)].join('\n');
  const isolatedProbe = async (files, source) => {
    const isolated = await makeSandbox(image);
    try {
      if (files) await write(isolated, files, remaining());
      return await runProbe(isolated, probePrelude + '\n' + source, remaining());
    } finally { await isolated.close(); }
  };
  try {
    const sourceContext = await readTaskContext(box, task, remaining(), read);
    // Visible test imports are useful API examples, not hidden grading evidence.
    const examples = await read(box, task.visibleTests, remaining());
    const testExamples = sourceWindows(examples, task.instruction, null, 4000);
    for (; turns < config.maxTurns; turns++) {
      if (deadline.aborted) { outcome = 'deadline'; break; }
      if (strategy === 'review' && !handoffUsed && turns >= 3) {
        handoffUsed = true; reviewing = reproducer !== null;
        actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
        feedback = `The first worker exhausted its three-action budget. Independently assess the issue and current candidate. Previous result: ${feedback}`;
      }
      const reproductionLimit = strategy === 'review' && handoffUsed ? 6 : 3;
      if (checked && !reproducer && turns >= reproductionLimit) { outcome = 'no_reproducer'; break; }
      if (!checked && strategy === 'handoff' && !handoffUsed && turns >= Math.max(1, Math.floor(config.maxTurns * 2 / 3))) {
        handoffUsed = true; actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
        feedback = `Independently verify the attempted repair. Previous tool result: ${feedback}`;
      }
      const files = await read(box, task.editPaths, remaining());
      const extra = selection && !task.editPaths.includes(selection.path)
        ? await read(box, [selection.path], remaining()) : [];
      const readable = [...files, ...extra];
      for (const path of sourceDependencies(readable, task)) if (dependencies.size < 32) dependencies.add(path);
      const readablePaths = [...new Set([...task.editPaths, ...task.visibleTests, ...dependencies])];
      if (selection) readable.sort((a, b) => Number(b.path === selection.path) - Number(a.path === selection.path));
      const views = sourceWindows(readable, task.instruction, selection);
      const phaseInstructions = !checked ? '' : reviewing
        ? '\nIndependent review phase: the first worker attempted this candidate. Check the tool results; do not assume its tests pass. Its frozen test and visible tests can be incomplete or wrong. Review the ENTIRE issue independently, including every stated boundary and behavior that must be preserved. Use inspect or edit to correct omissions. Use finish only when the candidate satisfies the full issue. Do not treat a passing self-authored test as proof of correctness.' : reproducer
        ? '\nRepair phase: the frozen reproduction below fails with an assertion on the original source. Use inspect or edit. Each edit reruns it in a fresh sandbox. Submission is automatic only when the reproduction and visible tests both pass. Do not change the reproduction.'
        : '\nReproduction phase: use inspect or probe only. The sandbox already imports assert from node:assert/strict and each editable module as source0, source1, etc. Write only executable JavaScript in query, using assert and those module namespaces; no imports, TypeScript types or shell commands are needed. Assert the CORRECT behavior described in the issue, so the original source fails with ERR_ASSERTION. Syntax/import errors and a probe that already passes do not qualify. Each worker has at most three reproduction actions; do not edit or finish.';
      const boundedSchema = { ...schema, properties: { ...schema.properties, path: { type: 'string', enum: ['', ...readablePaths] } } };
      const actionSchema = !checked ? boundedSchema : { ...boundedSchema, properties: { ...boundedSchema.properties,
        action: { type: 'string', enum: reviewing ? ['inspect', 'edit', 'finish'] : reproducer ? ['inspect', 'edit'] : ['inspect', 'probe'] } } };
      const messages = [{ role: 'system', content: instructions + phaseInstructions }, { role: 'user', content: JSON.stringify({
        issue: task.instruction, editable: task.editPaths, readable: readablePaths, visibleTests: task.visibleTests, workingMemory,
        ...(sourceContext.length ? { sourceContext } : {}),
        currentSource: views.map(({ content, ...view }) => ({ ...view,
          numberedSource: content.split('\n').map((line, index) => `${view.startLine + index}|${line}`).join('\n') })),
        testExamples, ...(checked ? { phase: reviewing ? 'review' : reproducer ? 'repair' : 'reproduce', probeModules,
          probePrelude, reproduction: reproducer } : {}),
        recentActions: actions.slice(-4), lastToolResult: feedback.slice(-4000),
      }) }];
      const response = await invoke(trialId, handoffUsed ? models.critic : models.strong,
        { messages, max_tokens: config.outputTokens, response_format: { type: 'json_schema',
          json_schema: { name: 'grounded_repair', strict: true, schema: actionSchema } } }, deadline);
      requireCompleteResponse(response);
      let action;
      try { action = JSON.parse(response.choices[0].message.content); }
      catch { actions.push({ turn: turns + 1, action: 'invalid_json', status: 'rejected' }); invalidActions++; feedback = 'Invalid JSON. Return one action object.'; continue; }
      if (action?.memory !== undefined && (typeof action.memory !== 'string' || !action.memory.trim() || action.memory.length > 2000 || Buffer.byteLength(action.memory) > 4096)) {
        actions.push({ turn: turns + 1, action: 'invalid_memory', status: 'rejected' });
        invalidActions++; feedback = 'Working memory must be nonempty, at most 2000 characters and 4096 bytes; summarize known facts and the next step.'; continue;
      }
      if (typeof action?.memory === 'string') workingMemory = action.memory;
      const event = { turn: turns + 1, action: ['inspect', 'edit', 'probe', 'finish'].includes(action?.action) ? action.action : 'invalid', status: 'ok' };
      actions.push(event);
      try {
        if (checked && !(reviewing ? ['inspect', 'edit', 'finish'] : reproducer ? ['inspect', 'edit'] : ['inspect', 'probe']).includes(action.action)) throw new Error('invalid_action');
        if (action.action === 'inspect') {
          if (!readablePaths.includes(action.path) || !Number.isSafeInteger(action.line)
            || action.line < 0 || typeof action.query !== 'string' || action.query.length > 200) throw new Error('invalid_read_paths');
          try { await read(box, [action.path], remaining()); }
          catch (error) {
            if (error.message === 'command_failed' && /ENOENT/.test(error.stderr ?? '')) throw new Error('invalid_read_paths');
            throw error;
          }
          selection = { path: action.path, line: action.line, query: action.query };
          feedback = 'Requested source window is shown next. Copy exact source for an edit.';
        } else if (action.action === 'edit') {
          await write(box, groundedEdits(task, files, views, action), remaining());
          const result = await test(box, task.visibleTests, remaining()); publicPassed = result.passed;
          feedback = `Edit applied. Visible tests passed: ${publicPassed}. ${result.feedback.slice(-3500)}`;
          // Keep the edited location visible, including after a handoff.
          selection = { path: action.path, line: action.line, query: '' };
          if (checked) {
            const result = await isolatedProbe(await read(box, task.editPaths, remaining()), reproducer);
            probePassed = result.passed;
            feedback += ` Frozen reproduction passed: ${probePassed}. ${result.feedback.slice(-2000)}`;
            event.passed = probePassed;
            if (probePassed && publicPassed) {
              if (strategy === 'review' && !reviewing) {
                reviewing = true; handoffUsed = true;
                actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
                feedback += ' Candidate checks pass. Independent review of the full issue is required before submission.';
              } else { reviewed = reviewing; outcome = 'verified'; turns++; break; }
            }
          }
        } else if (action.action === 'probe') {
          const result = checked ? await isolatedProbe(null, action.query) : await runProbe(box, action.query, remaining());
          feedback = `Behavior probe passed: ${result.passed}. ${result.feedback.slice(-3500)}`;
          event.passed = result.passed;
          if (checked) {
            if (result.assertionFailed === true) {
              reproducer = action.query;
              if (strategy === 'review' && handoffUsed) reviewing = true;
              event.status = 'qualified';
              feedback = `Reproduction qualified: it fails with an assertion on original source. Repair the reported behavior. ${result.feedback.slice(-3000)}`;
              if (strategy === 'handoff') {
                handoffUsed = true;
                actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
              }
            } else feedback = `Reproduction not qualified: it must fail with ERR_ASSERTION on the original source. ${feedback}`;
          }
        } else if (action.action === 'finish') {
          const result = await test(box, task.visibleTests, remaining()); publicPassed = result.passed;
          if (reviewing) {
            const checkedProbe = await isolatedProbe(await read(box, task.editPaths, remaining()), reproducer);
            probePassed = checkedProbe.passed;
            if (publicPassed && probePassed) { reviewed = true; outcome = 'verified'; turns++; break; }
            feedback = 'Review submission rejected: visible tests and the frozen reproduction must both pass.';
          } else if (strategy === 'handoff' && !handoffUsed) {
            handoffUsed = true; actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
            feedback = 'The first worker submitted. Independently inspect current source and verify the bug is fixed.';
          } else { outcome = 'submitted'; turns++; break; }
        } else throw new Error('invalid_action');
      } catch (error) {
        if (deadline.aborted) { outcome = 'deadline'; break; }
        event.status = ['unseen_edit', 'unchanged_edit'].includes(error.message) ? error.message : toolErrorCode(error);
        // Infrastructure failures stop the campaign; model tool mistakes can recover.
        if (['command_failed', 'command_timeout', 'command_output_limit', 'execution_failed'].includes(event.status)) throw error;
        invalidActions++; feedback = `Action rejected: ${event.status}. Use the actual source excerpt; inspect another location if needed.`;
      }
    }
    // Grading/cleanup is outside the action deadline. Keep final collection
    // bounded without turning an ordinary expired trial into a campaign abort.
    const files = await read(box, task.editPaths, 10000);
    return { files, patchDigest: hash(JSON.stringify(files)), actions, turns, outcome, handoffUsed, invalidActions, publicPassed,
      ...(checked ? { reproducerQualified: reproducer !== null, probePassed, ...(strategy === 'review' ? { reviewed } : {}) } : {}) };
  } finally { await box.close(); }
}
