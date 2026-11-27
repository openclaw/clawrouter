const OMISSION = "\n[... middle of message omitted ...]\n";

/** Keep task instructions and recent source within the same UTF-16 budget. */
export function boundedFusionText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  if (maxChars < OMISSION.length + 2) return suffix(content, maxChars);
  const available = maxChars - OMISSION.length;
  const headSize = Math.floor(available / 2);
  let head = content.slice(0, headSize);
  // Do not turn a valid supplementary character into an isolated surrogate.
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  return head + OMISSION + suffix(content, available - headSize);
}

function suffix(content: string, size: number): string {
  if (size <= 0) return "";
  const start = content.length - size;
  return content.slice(isLowSurrogate(content.charCodeAt(start)) ? start + 1 : start);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
