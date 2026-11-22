import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegionEditSchema } from '../scripts/fusion-region-schema.mjs';

test('single-file schema lists only supplied IDs and retains the edit contract', () => {
  const schema = createRegionEditSchema([{ path: 'worker/a.ts', ids: ['r0', 'r1'] }]);
  assert.deepEqual(schema, { type: 'object', additionalProperties: false, required: ['edits'], properties: {
    edits: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', additionalProperties: false,
      required: ['path', 'id', 'code'], properties: { path: { type: 'string', enum: ['worker/a.ts'] },
        id: { type: 'string', enum: ['r0', 'r1'] }, code: { type: 'string' } } } },
  } });
});
test('multi-file alternatives bind each ID to its file and permit shared local IDs', () => {
  const files = [{ path: 'worker/a.ts', ids: ['r0', 'a-only'] }, { path: 'worker/b.ts', ids: ['r0', 'b-only'] }];
  const schema = createRegionEditSchema(files), branches = schema.properties.edits.items.anyOf;
  assert.deepEqual(branches.map(b => [b.properties.path.enum, b.properties.id.enum]), [
    [['worker/a.ts'], ['r0', 'a-only']], [['worker/b.ts'], ['r0', 'b-only']],
  ]);
  branches[0].properties.id.enum.push('changed');
  assert.deepEqual(files[0].ids, ['r0', 'a-only']);
});
test('empty, duplicate and malformed target sets fail before schema use', () => {
  for (const files of [null, [], Array(1), [{}], [{ path: '', ids: ['r0'] }], [{ path: 'a', ids: [] }],
    [{ path: 'a', ids: ['r0', 'r0'] }], [{ path: 'a', ids: [3] }], [{ path: 'a', ids: [' '] }],
    [{ path: 'a', ids: ['r0'] }, { path: 'a', ids: ['r1'] }]]) {
    assert.throws(() => createRegionEditSchema(files), /invalid_region_targets/);
  }
});
test('schema limits include file enums and bound large string enums', () => {
  assert.equal(createRegionEditSchema([{ path: 'a', ids: Array.from({ length: 999 }, (_, i) => `r${i}`) }])
    .properties.edits.items.properties.id.enum.length, 999);
  assert.throws(() => createRegionEditSchema([{ path: 'a', ids: Array.from({ length: 1000 }, (_, i) => `r${i}`) }]), /region_schema_limit/);
  assert.throws(() => createRegionEditSchema([{ path: 'a', ids: Array.from({ length: 251 }, (_, i) => `${i}${'x'.repeat(60)}`) }]), /region_schema_limit/);
  assert.throws(() => createRegionEditSchema([{ path: 'x'.repeat(100001), ids: ['r0'] }]), /region_schema_limit/);
  assert.throws(() => createRegionEditSchema(Array.from({ length: 65 }, (_, i) => ({ path: `a${i}`, ids: ['r0'] }))), /invalid_region_targets/);
});
