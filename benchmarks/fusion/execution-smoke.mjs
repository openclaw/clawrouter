// Fresh development families, separate from the selector corpus. Hidden inputs
// grade candidates but are never supplied to the generator or selection policy.
const definitions = [
  ['rotate-right', 'Rotate an array right by integer k without modifying it. Negative k rotates left. Empty arrays stay empty.',
    (xs, k) => { if (!xs.length) return []; const n = ((k % xs.length) + xs.length) % xs.length; return n ? [...xs.slice(-n), ...xs.slice(0, -n)] : [...xs]; },
    [[[1, 2, 3], 1], [[1, 2], 0], [[], 2], [[1], 4]],
    [[[1, 2, 3], -1], [[1, 2, 3], 7], [[1, 2], -5], [['a', 'b', 'c', 'd'], 2]],
    '(xs,k) => { if(!xs.length)return []; const n=k%xs.length; return n>0?[...xs.slice(-n),...xs.slice(0,-n)]:[...xs]; }'],
  ['csv-row', 'Serialize an array of strings as one CSV row, with no line terminator. Quote fields containing comma, double quote, CR or LF; double every internal double quote. Preserve all other characters.',
    xs => xs.map(s => /[,"\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s).join(','),
    [[['a', 'b']], [['a,b', 'c']], [['']], [[]]],
    [[['a"b', 'c']], [['a\nb', '']], [['a\rb', 'x,y']], [['"', ',']]],
    'xs => xs.map(s=>s.includes(",")?"\\\""+s+"\\\"":s).join(",")'],
  ['run-length', 'Run-length encode a string as [character,count] pairs for consecutive equal Unicode code points. Empty input returns []. Do not combine separated runs.',
    s => { const out = []; for (const c of s) { const last = out.at(-1); if (last?.[0] === c) last[1]++; else out.push([c, 1]); } return out; },
    [['aaabb'], ['aba'], [''], ['x']],
    [['😀😀a😀'], ['éée'], ['\n\n '], ['𝄞𝄞']],
    's => { const out=[]; for(let i=0;i<s.length;i++){const c=s[i],last=out.at(-1);if(last?.[0]===c)last[1]++;else out.push([c,1]);}return out; }'],
  ['merge-intervals', 'Return the union of numeric closed intervals as intervals sorted by start. Merge overlapping or touching endpoints. Input intervals have start <= end. Do not mutate input.',
    xs => { const out = []; for (const [a, b] of xs.map(x => [...x]).sort((x, y) => x[0] - y[0])) { const last = out.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); } return out; },
    [[[[1, 3], [2, 5]]], [[]], [[[2, 3], [5, 6]]], [[[1, 4]]]],
    [[[[4, 6], [1, 4]]], [[[1, 10], [2, 3], [9, 12]]], [[[-3, -1], [-2, 0]]], [[[1, 1], [1, 2]]]],
    'xs => {const out=[];for(const [a,b] of xs.map(x=>[...x]).sort((x,y)=>x[0]-y[0])){const last=out.at(-1);if(last&&a<last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;}'],
  ['transpose', 'Transpose a rectangular matrix. Inputs may have zero rows or zero columns. Return [] when either dimension is zero. Do not mutate input.',
    xs => xs.length ? (xs[0] ?? []).map((_, col) => xs.map(row => row[col])) : [],
    [[[[1, 2], [3, 4]]], [[[1]]], [[[1, 2, 3]]], [[[1], [2]]]],
    [[[]], [[[]]], [[[], []]], [[[null, false], [0, '']]]],
    'xs => xs[0].map((_,col)=>xs.map(row=>row[col]))'],
  ['query-component', 'Percent-encode a string as a strict RFC 3986 query component using UTF-8. Leave only ASCII letters, digits, hyphen, period, underscore and tilde unescaped. Use uppercase hexadecimal escapes, including for space (not +).',
    s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    [['hello world'], ['a&b=c'], ['AZaz09-._~'], ['']],
    [["!'()*"], ['é😀'], ['a+b/c?'], ['\n%']],
    's => encodeURIComponent(s)'],
  ['word-counts', 'Count exact strings in an array. Return [string,count] pairs sorted by JavaScript string comparison (UTF-16 code unit order). Treat all strings, including object prototype property names, as ordinary values.',
    xs => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); },
    [[['b', 'a', 'b']], [[]], [['x']], [['A', 'a']]],
    [[['__proto__', '__proto__', 'x']], [['constructor', 'toString']], [['', '', 'a']], [['😀', 'é', 'a']]],
    'xs => {const m={};for(const x of xs)m[x]=(m[x]||0)+1;return Object.entries(m).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);}'],
  ['chunk-array', 'Split an array into consecutive chunks of positive integer size n. Include a shorter final chunk. Empty input returns []. Do not mutate input.',
    (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; },
    [[[1, 2, 3, 4], 2], [[], 2], [[1], 1], [[1, 2, 3], 1]],
    [[[1, 2, 3, 4, 5], 2], [[1, 2], 5], [[null, false, '', 0], 3], [[1], 8]],
    '(xs,n) => {const out=[];for(let i=0;i+n<=xs.length;i+=n)out.push(xs.slice(i,i+n));return out;}'],
];

export function executionTasks() {
  return definitions.map(([id, instruction, reference, visible, hidden, mutant]) => ({ id, instruction, reference, mutant,
    visible: visible.map(args => ({ args, expected: reference(...structuredClone(args)) })),
    hidden: hidden.map(args => ({ args, expected: reference(...structuredClone(args)) })),
  }));
}

export function executionPrompt(task) {
  return 'Implement a JavaScript ES module exporting one default synchronous function. Arguments and return values must be JSON-compatible. Do not modify input arguments. Use no external packages. Return JSON with exactly one string field "code" containing the complete module, without markdown.\n'
    + `Contract: ${task.instruction}\nExamples: ${JSON.stringify(task.visible.slice(0, 2))}`;
}

export function executionCorpusDigestInput(tasks) {
  return tasks.map(({ id, instruction, visible, hidden }) => ({ id, instruction, visible, hidden }));
}
