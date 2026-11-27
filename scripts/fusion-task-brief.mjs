import { createHash } from 'node:crypto';

export const TASK_BRIEF_REVISION = 'external-task-brief-v1';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const excludedHeading = /^(?:tests?|testing|verification|validation|status|checklist|benchmarks?|benchmarking|screenshots?)(?:\b|$)/i;

function startsChangelogBlock(line) {
  const text = line.trim();
  return !text || /^(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|#|>|`{3}|~{3})/.test(text)
    || /^(?:=+|-+)$/.test(text) || /^([*_\-])(?:[ \t]*\1){2,}$/.test(text);
}

// Local history has no PR body. Admit one inserted changelog paragraph and
// record its actual origin instead of presenting it as an external task brief.
export function localHistoryTaskBrief({ title, commit, before, after }) {
  if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 1024
    || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)
    || typeof before !== 'string' || typeof after !== 'string'
    || Buffer.byteLength(before) > 1048576 || Buffer.byteLength(after) > 1048576
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title + before + after)) {
    throw new Error('invalid_local_history_brief_input');
  }
  const oldLines = before.split('\n'), newLines = after.split('\n');
  let start = 0, end = 0;
  while (start < oldLines.length && oldLines[start] === newLines[start]) start++;
  while (end < oldLines.length - start
    && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  if (start + end !== oldLines.length) throw new Error('local_history_brief_not_additive');
  const added = newLines.slice(start, newLines.length - end).join('\n').trim();
  if (Buffer.byteLength(added) > 8192 || !/^- \S/.test(added)
    || added.slice(2).split('\n').some(startsChangelogBlock)) throw new Error('ambiguous_local_history_narrative');
  const narrative = added.slice(2).trim();
  const instruction = title.trim() + '\n\n' + narrative;
  return { instruction, provenance: { revision: 'local-history-task-brief-v1', commit,
    source: 'CHANGELOG.md', titleSha256: sha256(title), beforeSha256: sha256(before),
    afterSha256: sha256(after), narrativeSha256: sha256(narrative), instructionSha256: sha256(instruction) } };
}

// Freeze public author narrative separately from executable acceptance tests.
// This is Markdown section selection, not semantic proof that a task is complete.
export function externalTaskBrief({ title, body, url }, { maxBytes = 16384 } = {}) {
  if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 1024
    || typeof body !== 'string' || Buffer.byteLength(body) > 262144
    || typeof url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/.test(url)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) {
    throw new Error('invalid_task_brief_input');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title + body)) throw new Error('invalid_task_brief_text');
  const lines = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split('\n');
  const selected = [], omittedSections = [];
  let excludedLevel = null, fence = null, fencedBlocksOmitted = 0;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      fencedBlocksOmitted++;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length, name = heading[2];
      if (excludedLevel !== null && level <= excludedLevel) excludedLevel = null;
      if (excludedLevel === null && excludedHeading.test(name)) {
        excludedLevel = level;
        omittedSections.push(name);
      }
    }
    if (excludedLevel !== null || /^\s*(?:N\/A|None)\s*$/i.test(line)
      || /^\s*\[[^\]]+\]:\s*\S/.test(line)) continue;
    selected.push(line);
  }
  if (fence) throw new Error('unclosed_task_brief_fence');
  const narrative = selected.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Heading-only/template-only bodies cannot silently become title-only tasks.
  const prose = selected.filter(line => line.trim() && !/^\s*#/.test(line)).join('\n').trim();
  if (!prose) throw new Error('missing_task_brief_narrative');
  const instruction = title.trim() + '\n\n' + narrative;
  if (Buffer.byteLength(instruction) > maxBytes) throw new Error('task_brief_too_large');
  return { instruction, provenance: { revision: TASK_BRIEF_REVISION, url,
    titleSha256: sha256(title), bodySha256: sha256(body), instructionSha256: sha256(instruction),
    omittedSections, fencedBlocksOmitted } };
}
