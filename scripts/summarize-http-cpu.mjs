// Attribute sampled on-CPU stacks to the separately measured process CPU total.
// Usage: node scripts/summarize-http-cpu.mjs <scenario.cpuprofile> <results.json>
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
const [profilePath, resultsPath] = process.argv.slice(2);
if (!profilePath || !resultsPath) throw new Error('expected scenario.cpuprofile and results.json');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const result = JSON.parse(await readFile(resultsPath, 'utf8')).results.find(row => row.label === basename(profilePath, '.cpuprofile'));
if (!result) throw new Error('scenario missing from results');
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
const name = node => `${node.callFrame.functionName || '(anonymous)'} (${node.callFrame.url.split('/').slice(-2).join('/')}:${node.callFrame.lineNumber + 1})`;
const counts = new Map();
let active = 0;
for (const id of profile.samples ?? []) {
  const leaf = nodes.get(id);
  if (['(idle)', '(root)', '(program)'].includes(leaf.callFrame.functionName)) continue;
  active++;
  const seen = new Set();
  for (let next = id; next; next = parents.get(next)) {
    const key = name(nodes.get(next));
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(key) ?? { self: 0, total: 0 };
    count.total++;
    if (next === id) count.self++;
    counts.set(key, count);
  }
}
const ms = count => (count * result.cpuMs / active).toFixed(2);
console.log(`${result.label}: ${result.cpuMs.toFixed(2)} CPU ms/request; ${active} active samples. Inclusive rows overlap.`);
console.log('| Function | Self ms | Total ms | Total % |');
console.log('| --- | ---: | ---: | ---: |');
for (const [key, count] of [...counts].filter(([key]) => !key.includes('(root)')).sort((a, b) => b[1].self - a[1].self).slice(0, 30)) {
  console.log(`| ${key} | ${ms(count.self)} | ${ms(count.total)} | ${(100 * count.total / active).toFixed(1)} |`);
}
