// Repair context only. This text parser must never determine test acceptance.
export function compactRepairFeedback({ previousEdits = null, publicFeedback }) {
  if (previousEdits !== null && !Array.isArray(previousEdits)
    || publicFeedback === null || !['string', 'object'].includes(typeof publicFeedback)) {
    throw new TypeError('invalid repair feedback');
  }
  const feedbackJson = JSON.stringify(publicFeedback);
  if (feedbackJson === undefined) throw new TypeError('invalid repair feedback');
  const payload = {
    instruction: 'Repair the previous edits against the public diagnostics. Return edits against the original numbered source, not the previous attempt.',
    previousEdits,
    publicFeedback: JSON.parse(feedbackJson),
  };
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text) <= 12000) return text;
  delete payload.previousEdits;
  text = JSON.stringify(payload);
  if (Buffer.byteLength(text) <= 12000) return text;
  // JSON.stringify escapes lone surrogates, but slicing can split a valid pair.
  const feedbackExcerpt = feedbackJson.slice(0, 2000).replace(/[\uD800-\uDBFF]$/u, '');
  return JSON.stringify({ instruction: payload.instruction, feedbackExcerpt, diagnosticsTruncated: true });
}

export function firstTestFailureFeedback(feedback) {
  if (typeof feedback !== 'string') throw new TypeError('feedback must be a string');
  const lines = feedback.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([ \t]*)not ok [1-9][0-9]* - .+/.exec(lines[i]);
    if (!match || /\s+#\s*(?:TODO|SKIP)\b/i.test(lines[i])) continue;
    const indent = match[1] + '  ';
    if (lines[i + 1] !== indent + '---') continue;
    let end = i + 2;
    while (end < lines.length && lines[end] !== indent + '...') {
      if (lines[end] && !lines[end].startsWith(indent)) break;
      end++;
    }
    if (lines[end] !== indent + '...') continue;
    const fields = lines.slice(i + 2, end);
    if (fields.some(line => line.startsWith(indent + 'exitCode:') || line.startsWith(indent + 'signal:'))) continue;
    const types = fields.filter(line => line.startsWith(indent + 'failureType: '));
    if (types.length !== 1 || !/failureType: '(?:testCodeFailure|uncaughtException|unhandledRejection|testTimeoutFailure)'$/.test(types[0])) continue;
    return lines.slice(i, end + 1).join('\n');
  }
  return null;
}
