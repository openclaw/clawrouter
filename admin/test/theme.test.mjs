import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('../src/theme.ts', import.meta.url), 'utf8'));
const cases = [
  { name: 'stored light', stored: 'light', system: true, expected: 'light' },
  { name: 'stored dark', stored: 'dark', system: false, expected: 'dark' },
  { name: 'system light', stored: null, system: false, expected: 'light' },
  { name: 'system dark', stored: null, system: true, expected: 'dark' },
  { name: 'invalid preference', stored: 'other', system: true, expected: 'dark' },
  { name: 'unavailable storage read', readError: true, system: true, expected: 'dark' },
  { name: 'unavailable storage write', stored: 'light', writeError: true, expected: 'light' },
];
for (const [index, scenario] of cases.entries()) test('theme initialization preserves ' + scenario.name, async () => {
  const previous = ['window', 'document'].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const events = [], dataset = {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem(key) { events.push(['read', key]); if (scenario.readError) throw new Error('unavailable'); return scenario.stored; },
      setItem(key, value) { events.push(['write', key, value]); if (scenario.writeError) throw new Error('unavailable'); },
    },
    matchMedia(query) { events.push(['system', query]); return { matches: scenario.system }; },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { dataset }, querySelector() { return { setAttribute: (...args) => events.push(['meta', ...args]) }; },
  } });
  try {
    await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + index).toString('base64'));
    assert.equal(dataset.theme, scenario.expected);
    assert.deepEqual(events, [
      ['read', 'clawrouter-theme'],
      ...(!['light', 'dark'].includes(scenario.stored) || scenario.readError ? [['system', '(prefers-color-scheme: dark)']] : []),
      ['meta', 'content', scenario.expected === 'dark' ? '#0c0e11' : '#f2f0ea'],
      ['write', 'clawrouter-theme', scenario.expected],
    ]);
  } finally {
    ['window', 'document'].forEach((key, i) => previous[i] ? Object.defineProperty(globalThis, key, previous[i]) : delete globalThis[key]);
  }
});
