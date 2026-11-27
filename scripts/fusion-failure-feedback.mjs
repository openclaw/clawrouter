// Repair context only. This text parser must never determine test acceptance.
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
