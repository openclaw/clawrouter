// Hand-authored, compact decisions. None of this source is model-generated.
// Gold choices stay outside prompts; this corpus is a mechanism smoke test.
const families = [
  ['finite-positive', 'Accept only finite positive JavaScript numbers. Reject zero, strings and infinity.',
    'v => typeof v === "number" && Number.isFinite(v) && v > 0',
    ['v => typeof v === "number" && v > 0', 'v => Boolean(Number(v))', 'v => Number.isFinite(v) && v >= 0']],
  ['nullish-default', 'Return the fallback only for null or undefined. Preserve zero, false and the empty string.',
    '(v, fallback) => v ?? fallback',
    ['(v, fallback) => v || fallback', '(v, fallback) => v === undefined ? fallback : v', '(v, fallback) => v ? v : fallback']],
  ['exact-leaf', 'For a nonempty slash-separated string, match the last segment exactly. A bare matching name is valid.',
    '(s, expected) => s.split("/").at(-1) === expected',
    ['(s, expected) => s.endsWith(expected)', '(s, expected) => s.includes(expected)', '(s, expected) => s.endsWith("/" + expected)']],
  ['https-only', 'Accept valid absolute HTTPS URLs only. Invalid URL text must return false without throwing.',
    's => { try { return new URL(s).protocol === "https:"; } catch { return false; } }',
    ['s => s.startsWith("https")', 's => new URL(s).protocol === "https:"', 's => { try { return new URL(s).protocol.startsWith("http"); } catch { return false; } }']],
  ['decimal-string', 'Accept only nonempty strings of ASCII decimal digits. Leading zeros are valid; signs, decimals and whitespace are not.',
    's => typeof s === "string" && /^[0-9]+$/.test(s)',
    ['s => Number.isFinite(Number(s))', 's => Number.isFinite(parseInt(s, 10))', 's => /^[0-9.]+$/.test(s)']],
  ['integer-range', 'Accept integer values from 1 through max inclusive; reject fractions and values outside that range.',
    '(v, max) => Number.isInteger(v) && v >= 1 && v <= max',
    ['(v, max) => v >= 1 && v <= max', '(v, max) => Number.isInteger(v) && v >= 1 && v < max', '(v, max) => Math.round(v) >= 1 && Math.round(v) <= max']],
  ['utf8-limit', 'Accept strings whose UTF-8 byte length is at most max. Multibyte characters count as multiple bytes.',
    '(s, max) => Buffer.byteLength(s, "utf8") <= max',
    ['(s, max) => s.length <= max', '(s, max) => Array.from(s).length <= max', '(s, max) => JSON.stringify(s).length <= max']],
  ['cleanup-once', 'Call a synchronous work function and return its value or propagate its error. Always call cleanup exactly once.',
    '(work, cleanup) => { try { return work(); } finally { cleanup(); } }',
    ['(work, cleanup) => { const v = work(); cleanup(); return v; }', '(work, cleanup) => { try { const v = work(); cleanup(); return v; } finally { cleanup(); } }', '(work, cleanup) => { try { return work(); } catch (e) { cleanup(); throw e; } }']],
  ['round-cost-up', 'For nonnegative token count n and price r, return the smallest integer greater than or equal to n times r.',
    '(n, r) => Math.ceil(n * r)',
    ['(n, r) => Math.round(n * r)', '(n, r) => Math.floor(n * r)', '(n, r) => Math.trunc(n * r)']],
  ['sort-copy', 'Return numbers sorted ascending without modifying the input array.',
    'xs => [...xs].sort((a, b) => a - b)',
    ['xs => xs.sort((a, b) => a - b)', 'xs => [...xs].sort()', 'xs => [...xs].sort((a, b) => b - a)']],
  ['stable-unique', 'Return each string once, preserving the order of its first occurrence. Do not modify the input.',
    'xs => [...new Set(xs)]',
    ['xs => [...new Set(xs)].sort()', 'xs => xs.filter((v, i) => xs.lastIndexOf(v) === i)', 'xs => xs.filter((v, i) => xs.indexOf(v) !== i)']],
  ['literal-path', 'For valid absolute URLs, return pathname without percent-decoding, lowercasing or trimming trailing slashes.',
    's => new URL(s).pathname',
    ['s => decodeURIComponent(new URL(s).pathname)', 's => new URL(s).pathname.replace(new RegExp("/+$"), "")', 's => new URL(s).pathname.toLowerCase()']],
];

export function selectorCases() {
  return families.flatMap(([family, contract, correct, wrong]) => {
    const choices = Array.from({ length: 3 }, (_, rotation) => {
      const candidates = [wrong[0], wrong[1]];
      candidates.splice(rotation, 0, correct);
      return { id: `${family}-${rotation + 1}`, family, contract, candidates, correctChoice: rotation + 1 };
    });
    return [...choices, { id: `${family}-none`, family, contract, candidates: wrong, correctChoice: 0 }];
  });
}

export function selectorPrompt(task) {
  return `Select the one function that satisfies the entire contract. If none does, choose 0. Do not assume that any candidate is correct. Return only JSON with choice (0 to 3) and confidence (0 to 100).\nContract: ${task.contract}\n`
    + task.candidates.map((candidate, index) => `Candidate ${index + 1}: ${candidate}`).join('\n');
}
