import assert from 'node:assert/strict';

// Fixture-only source observers. Forward every original operation unchanged;
// retain scalar counts, never parser input, keys, values, containers or tokens.
// These observers are NOT production factories or a complete CONTROL inventory.
export function createOwnedJsonObservation() {
  const rows = [];
  let current, preparations = 0;
  const peak = row => {
    row.peakParents = Math.max(row.peakParents, row.parents);
    row.peakTokens = Math.max(row.peakTokens, row.tokens);
    row.peakStored = Math.max(row.peakStored, 2 + row.parents + row.tokens + Number(row.pending) + Number(row.member));
  };
  return {
    rows,
    accounting(delta) {
      preparations += delta;
      if (preparations < 0) throw new Error('preparation accounting retired twice');
    },
    begin() {
      if (preparations !== 0) throw new Error('unused preparation accounting survived into codec');
      const row = { parents: 0, tokens: 0, pending: false, member: false, peakParents: 0, peakTokens: 0, peakStored: 2,
        parentPushes: 0, parentPops: 0, tokenPushes: 0, tokenPops: 0, attachments: 0, objectAttachments: 0, cleared: false };
      rows.push(row); return row;
    },
    enter(row) { if (row) { if (current) throw new Error('nested fixture parser observation'); current = row; } },
    leave(row) { if (row) { if (current !== row) throw new Error('fixture parser observation mismatch'); current = undefined; } },
    consumer(row, parents, pending) {
      if (!row) return;
      if (parents > row.parents) row.parentPushes += parents - row.parents;
      else row.parentPops += row.parents - parents;
      row.parents = parents; row.pending = pending; peak(row);
    },
    attaching(row, member) { if (row) { row.member = member; peak(row); } },
    attached(row, kind, exists, emptyPending, emptyMember) {
      if (!row) return;
      if (!(exists && emptyPending && emptyMember)) throw new Error('key cleared before actual attachment or retained afterward');
      row.attachments++; if (kind === 2) row.objectAttachments++;
      row.pending = false; row.member = false;
    },
    tokenizer(depth) {
      if (!current) return;
      if (depth > current.tokens) current.tokenPushes += depth - current.tokens;
      else current.tokenPops += current.tokens - depth;
      current.tokens = depth; peak(current);
    },
    discard(row, emptyParents, emptyKey, emptyScalar, emptyRoot, detachedTokenizer) {
      if (!row || row.cleared) return;
      if (!(emptyParents && emptyKey && emptyScalar && emptyRoot && detachedTokenizer)) throw new Error('private parser retained an application alias');
      row.abandonedParents = row.parents; row.abandonedTokens = row.tokens;
      row.parents = 0; row.tokens = 0; row.pending = false; row.member = false; row.cleared = true;
    },
  };
}

const probe = 'globalThis.__ownedJsonObservation';
function replace(source, anchor, replacement, count = 1) {
  assert.equal(source.split(anchor).length - 1, count, 'fixed original parser observer anchor: ' + anchor);
  return source.replaceAll(anchor, replacement);
}

export function observeOwnedJsonSource(path, source) {
  if (/[\\/]worker[\\/]json-body\.ts$/.test(path)) {
    source = replace(source, 'let pendingKey: string | undefined;',
      'let pendingKey: string | undefined; const __parserProbe = privateParents ? ' + probe + '.begin() : undefined;');
    source = replace(source, 'parent = parents.at(-1); member = pendingKey;',
      'parent = parents.at(-1); member = pendingKey; ' + probe + '.attaching(__parserProbe, member !== undefined);');
    source = replace(source, 'if (parents) { pendingKey = undefined; member = undefined; }',
      'if (parents) { const __attached = !parent ? root === value : Array.isArray(parent) ? parent.at(-1) === value : Object.hasOwn(parent, member!) && parent[member!] === value; '
      + 'pendingKey = undefined; member = undefined; ' + probe + '.attached(__parserProbe, !parent ? 0 : Array.isArray(parent) ? 1 : 2, __attached, pendingKey === undefined, member === undefined); }');
    source = replace(source, 'if (parents) parents.push(value);',
      'if (parents) { parents.push(value); ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined); }');
    source = replace(source, '(parents ?? stack!).pop();',
      '(parents ?? stack!).pop(); if (parents) ' + probe + '.consumer(__parserProbe, parents.length, pendingKey !== undefined);');
    source = replace(source, 'if (parents) pendingKey = scalar;',
      'if (parents) { pendingKey = scalar; ' + probe + '.consumer(__parserProbe, parents.length, true); }');
    source = replace(source, '(parents ?? stack!).length = 0;',
      '(parents ?? stack!).length = 0; if (__parserProbe) ' + probe + '.discard(__parserProbe, parents?.length === 0, pendingKey === undefined, scalar === "", root === undefined, consume === undefined);');
    source = replace(source, 'for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096)); } finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); }');
    source = replace(source, 'try { consume.end(); return root; }\n    finally { discard(); }',
      'if (__parserProbe) ' + probe + '.enter(__parserProbe); try { consume.end(); return root; }\n    finally { if (__parserProbe) ' + probe + '.leave(__parserProbe); discard(); }');
  } else if (/[\\/]worker[\\/]proxy-accounting\.ts$/.test(path)) {
    source = replace(source, 'options = undefined as never; owner = undefined as never;',
      'options = undefined as never; owner = undefined as never; ' + probe + '.accounting(1);');
    source = replace(source, 'finally { command = undefined; }',
      'finally { const __held = command !== undefined; command = undefined; if (__held) ' + probe + '.accounting(-1); }', 2);
  } else if (/[\\/]stream-json[\\/](?:src[\\/])?core[\\/]parser\.js$/.test(path)) {
    // Exact pinned 3.8 tokenizer: two container-entry and three exit sites.
    // Observe the ORIGINAL stack *before* the consumer sees the returned batch.
    source = replace(source, 'stack.push(parent);', 'stack.push(parent); ' + probe + '?.tokenizer(stack.length);', 2);
    source = replace(source, 'parent = stack.pop();', 'parent = stack.pop(); ' + probe + '?.tokenizer(stack.length);', 3);
  }
  return source;
}

export async function startOwnedJsonObservedFixture(directory, router, upstream, options) {
  const [{ createRequire }, { readFile }, { dirname }, { startBundledWorkerdFixture }] = await Promise.all([
    import('node:module'), import('node:fs/promises'), import('node:path'), import('./workerd.mjs'),
  ]);
  const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  const bundled = await build({ stdin: {
    contents: 'globalThis.__ownedJsonObservation = (' + createOwnedJsonObservation.toString() + ')();\n' + router,
    resolveDir: process.cwd(), sourcefile: 'owned-json-fixture.ts', loader: 'ts',
  }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  plugins: [{ name: 'observe-original-json-stacks', setup(build) {
    build.onLoad({ filter: /(?:[\\/]worker[\\/](?:json-body|proxy-accounting)\.ts|[\\/]stream-json[\\/](?:src[\\/])?core[\\/]parser\.js)$/ }, async ({ path }) => ({
      contents: observeOwnedJsonSource(path, await readFile(path, 'utf8')),
      loader: path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(path),
    }));
  } }] });
  return startBundledWorkerdFixture(directory, bundled.outputFiles[0].text, upstream, options);
}
