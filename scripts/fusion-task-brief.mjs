import { createHash } from 'node:crypto';

export const TASK_BRIEF_REVISION = 'external-task-brief-v1';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const excludedHeading = /^(?:tests?|testing|verification|validation|status|checklist|benchmarks?|benchmarking|screenshots?)(?:\b|$)/i;

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
